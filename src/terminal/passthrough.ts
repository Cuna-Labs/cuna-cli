import type {
  RuntimeTerminalResponse,
  RuntimeTerminalSnapshot,
} from "../runtime/boundary.js";
import { runtimeFailure } from "../runtime/errors.js";
import type {
  ForegroundTabIntent,
  ForegroundTerminalHost,
  ForegroundTerminalRuntime,
  ForegroundTerminalState,
} from "./foreground.js";
import { MAX_FOREGROUND_PENDING_INPUT_BYTES, admitForegroundSessionIds } from "./foreground.js";
import type { HostTerminalLease } from "./mode.js";

const ESCAPE_PREFIX = 0x1d;
const DETACH = 0x64;
const RESIZE_COALESCE_MS = 50;
const BRACKETED_PASTE_START = Uint8Array.of(0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e);
const BRACKETED_PASTE_END = Uint8Array.of(0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e);
const BRACKETED_PASTE_DISABLE = Uint8Array.of(0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x30, 0x34, 0x6c);

export interface PassthroughTerminalCoordinatorOptions {
  readonly host: ForegroundTerminalHost;
  readonly resizeCoalesceMs?: number;
}

/**
 * A byte-preserving, single-session fallback. It deliberately renders no Cuna
 * appbar, progress, status, or decoration because it has no isolated viewport
 * in which trusted chrome could be kept separate from remote PTY bytes.
 */
export class PassthroughTerminalCoordinator {
  readonly #options: Readonly<Required<Pick<PassthroughTerminalCoordinatorOptions, "resizeCoalesceMs">> & PassthroughTerminalCoordinatorOptions>;
  #runtime: ForegroundTerminalRuntime | undefined;
  #intent: ForegroundTabIntent | undefined;
  #snapshot: RuntimeTerminalSnapshot | undefined;
  #lease: HostTerminalLease | undefined;
  #state: ForegroundTerminalState = "idle";
  #removeInput: (() => void) | undefined;
  #removeResize: (() => void) | undefined;
  #removeAbort: (() => void) | undefined;
  #resizeTimer: NodeJS.Timeout | undefined;
  #inputTail: Promise<void> = Promise.resolve();
  #outputTail: Promise<void> = Promise.resolve();
  #pendingInputBytes = 0;
  #prefixPending = false;
  #pasteActive = false;
  #pasteStartMatch = 0;
  #pasteEndMatch = 0;
  #remotePasteDisableMatch = 0;
  #detachChordTrusted = true;
  #failure: unknown;
  #stopPromise: Promise<void> | undefined;
  readonly #stopStarted: Promise<void>;
  readonly #resolveStopStarted: () => void;

  constructor(options: PassthroughTerminalCoordinatorOptions) {
    const resizeCoalesceMs = options.resizeCoalesceMs ?? RESIZE_COALESCE_MS;
    if (!Number.isSafeInteger(resizeCoalesceMs) || resizeCoalesceMs < 1 || resizeCoalesceMs > 1_000) {
      throw new RangeError("Passthrough resize coalescing must be between 1 and 1000 milliseconds.");
    }
    this.#options = Object.freeze({ ...options, resizeCoalesceMs });
    let resolveStopStarted = (): void => undefined;
    this.#stopStarted = new Promise<void>((resolve) => { resolveStopStarted = resolve; });
    this.#resolveStopStarted = resolveStopStarted;
  }

  get state(): ForegroundTerminalState {
    return this.#state;
  }

  get failure(): unknown {
    return this.#failure;
  }

  bindRuntime(runtime: ForegroundTerminalRuntime): void {
    if (this.#runtime !== undefined || this.#state !== "idle") {
      throw runtimeFailure("session_conflict", "The passthrough runtime is already bound or started.");
    }
    this.#runtime = runtime;
  }

  runtimeCallbacks(): {
    readonly onTerminalReady: (snapshot: RuntimeTerminalSnapshot) => Promise<void>;
    readonly onTerminalOutput: (event: {
      readonly tabId: string;
      readonly agentSessionId: string;
      readonly binding: RuntimeTerminalResponse["binding"];
      readonly sequence: bigint;
      readonly bytes: Uint8Array;
      readonly signal: AbortSignal;
    }) => Promise<void>;
    readonly onTerminalState: (snapshot: RuntimeTerminalSnapshot) => void;
  } {
    return Object.freeze({
      onTerminalReady: async (snapshot) => this.#terminalReady(snapshot),
      onTerminalOutput: async (event) => await this.#queueOutput(event),
      onTerminalState: (snapshot) => this.#terminalState(snapshot),
    });
  }

  async start(intents: readonly ForegroundTabIntent[], signal?: AbortSignal): Promise<void> {
    if (this.#state !== "idle") throw runtimeFailure("session_conflict", "The passthrough terminal already started.");
    if (intents.length !== 1) {
      throw runtimeFailure("capability_unsupported", "Plain passthrough mode binds exactly one AgentSession.");
    }
    admitForegroundSessionIds(intents.map((intent) => intent.agentSessionId));
    const intent = intents[0];
    if (intent === undefined) throw runtimeFailure("session_unknown", "No passthrough AgentSession was selected.");
    admitPassthroughDimensions(this.#options.host.dimensions());
    const runtime = this.#requireRuntime();
    this.#intent = intent;
    this.#state = "starting";
    try {
      if (signal?.aborted) throw runtimeFailure("terminal_disconnected", "Passthrough terminal startup was cancelled.");
      if (signal !== undefined) {
        const onAbort = (): void => {
          this.#failure ??= runtimeFailure("terminal_disconnected", "Passthrough terminal execution was cancelled.");
          void this.stop().catch(() => { this.#state = "failed"; });
        };
        signal.addEventListener("abort", onAbort, { once: true });
        this.#removeAbort = () => signal.removeEventListener("abort", onAbort);
      }
      this.#lease = await this.#options.host.acquire("plain");
      if (signal?.aborted || this.#state !== "starting") {
        await this.#lease.restore();
        this.#lease = undefined;
        throw runtimeFailure("terminal_disconnected", "Passthrough terminal startup was cancelled.");
      }
      this.#removeInput = this.#options.host.onInput((bytes) => this.#queueInput(bytes));
      this.#removeResize = this.#options.host.onResize(() => this.#queueResize());
      const dimensions = admitPassthroughDimensions(this.#options.host.dimensions());
      const snapshot = await runtime.attach({
        tabId: intent.tabId,
        agentSessionId: intent.agentSessionId,
        columns: dimensions.columns,
        rows: dimensions.rows,
        ...(intent.attachmentAdmission === undefined
          ? {}
          : { expectedAdmission: intent.attachmentAdmission }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!sameIntent(intent, snapshot)) {
        throw runtimeFailure("grant_scope_mismatch", "Passthrough readiness targets a different AgentSession.");
      }
      this.#snapshot = snapshot;
      this.#state = "active";
    } catch (error) {
      this.#state = "failed";
      try {
        await this.stop();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Passthrough startup and cleanup both failed.");
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return await this.#stopPromise;
    this.#resolveStopStarted();
    this.#stopPromise = this.#stopNow();
    try {
      return await this.#stopPromise;
    } finally {
      // A failed restore retains the lease and may be retried explicitly after
      // the host terminal becomes writable again.
      if (this.#state === "failed") this.#stopPromise = undefined;
    }
  }

  async waitForStop(): Promise<void> {
    await this.#stopStarted;
    const attempt = this.#stopPromise;
    if (attempt === undefined) throw runtimeFailure("terminal_disconnected", "Passthrough cleanup did not start.");
    await attempt;
    if (this.#state !== "stopped") throw runtimeFailure("terminal_disconnected", "Passthrough cleanup did not complete.");
  }

  async #stopNow(): Promise<void> {
    if (this.#state === "stopped") return;
    this.#state = "stopping";
    this.#removeAbort?.();
    this.#removeAbort = undefined;
    if (this.#resizeTimer !== undefined) clearTimeout(this.#resizeTimer);
    this.#resizeTimer = undefined;
    this.#removeInput?.();
    this.#removeResize?.();
    this.#removeInput = undefined;
    this.#removeResize = undefined;
    const failures: unknown[] = [];
    const snapshot = this.#snapshot;
    if (snapshot !== undefined && snapshot.state !== "closed" && snapshot.state !== "detached") {
      try { await this.#requireRuntime().detach(snapshot.tabId); } catch (error) { failures.push(error); }
    }
    try { await this.#outputTail; } catch (error) { failures.push(error); }
    try { await this.#inputTail; } catch (error) { failures.push(error); }
    if (this.#lease !== undefined) {
      try {
        await this.#lease.restore();
        this.#lease = undefined;
      } catch (error) {
        failures.push(error);
      }
    }
    this.#snapshot = undefined;
    this.#intent = undefined;
    this.#pendingInputBytes = 0;
    this.#state = failures.length === 0 ? "stopped" : "failed";
    if (failures.length > 0) throw new AggregateError(failures, "Passthrough terminal cleanup was incomplete.");
  }

  #terminalReady(snapshot: RuntimeTerminalSnapshot): void {
    const intent = this.#intent;
    if (intent === undefined || !sameIntent(intent, snapshot)) {
      throw runtimeFailure("grant_scope_mismatch", "Passthrough readiness targets an unbound AgentSession.");
    }
    if (this.#state !== "starting" && this.#state !== "active") {
      throw runtimeFailure("terminal_disconnected", "Passthrough readiness arrived after terminal ownership ended.");
    }
    this.#snapshot = snapshot;
  }

  async #queueOutput(event: {
    readonly tabId: string;
    readonly agentSessionId: string;
    readonly binding: RuntimeTerminalResponse["binding"];
    readonly sequence: bigint;
    readonly bytes: Uint8Array;
    readonly signal: AbortSignal;
  }): Promise<void> {
    const operation = this.#outputTail.then(async () => {
      const snapshot = this.#snapshot;
      if (snapshot === undefined || !sameEvent(snapshot, event)) {
        throw runtimeFailure("grant_scope_mismatch", "Passthrough output targets an unbound terminal generation.");
      }
      if (event.signal.aborted) throw runtimeFailure("terminal_disconnected", "Passthrough output was cancelled.");
      this.#observeRemoteModeOutput(event.bytes);
      // This is intentionally the original binary payload. No status, Unicode
      // decoding, VTE interpretation, or trusted chrome is inserted here.
      await this.#options.host.write(event.bytes);
    });
    this.#outputTail = operation.then(() => undefined, () => undefined);
    await operation;
  }

  #terminalState(snapshot: RuntimeTerminalSnapshot): void {
    const intent = this.#intent;
    if (intent === undefined || !sameIntent(intent, snapshot)) return;
    this.#snapshot = snapshot;
    if (snapshot.state === "failed" || snapshot.state === "interrupted") {
      this.#failure ??= runtimeFailure("terminal_disconnected", "The passthrough terminal connection ended.");
    }
    if (
      this.#state === "active" &&
      (snapshot.state === "failed" || snapshot.state === "interrupted" || snapshot.state === "closed" || snapshot.state === "detached")
    ) {
      void this.stop().catch(() => { this.#state = "failed"; });
    }
  }

  #queueInput(bytes: Uint8Array): void {
    if (bytes.byteLength < 1) return;
    if (bytes.byteLength > MAX_FOREGROUND_PENDING_INPUT_BYTES || this.#pendingInputBytes + bytes.byteLength > MAX_FOREGROUND_PENDING_INPUT_BYTES) {
      this.#failure ??= runtimeFailure("terminal_protocol_error", "Passthrough input exceeded its bounded queue.");
      void this.stop().catch(() => { this.#state = "failed"; });
      return;
    }
    const payload = bytes.slice();
    const receiptTarget = this.#snapshot === undefined
      ? undefined
      : Object.freeze({
          tabId: this.#snapshot.tabId,
          binding: Object.freeze({
            userId: this.#snapshot.userId,
            machineId: this.#snapshot.machineId,
            agentSessionId: this.#snapshot.agentSessionId,
            processEpoch: this.#snapshot.processEpoch,
            fencingGeneration: this.#snapshot.fencingGeneration,
          }),
        });
    this.#pendingInputBytes += payload.byteLength;
    const operation = this.#inputTail.then(async () => {
      try { await this.#routeInput(payload, receiptTarget); } finally { this.#pendingInputBytes -= payload.byteLength; }
    });
    this.#inputTail = operation.catch((error) => {
      this.#failure ??= error;
      void this.stop().catch(() => { this.#state = "failed"; });
    });
  }

  async #routeInput(
    bytes: Uint8Array,
    target: { readonly tabId: string; readonly binding: RuntimeTerminalResponse["binding"] } | undefined,
  ): Promise<void> {
    const snapshot = this.#snapshot;
    if (snapshot === undefined || snapshot.state !== "active" || target === undefined) {
      throw runtimeFailure("terminal_disconnected", "Passthrough input is withheld until the exact PTY is ready.");
    }
    const remote: number[] = [];
    const flush = async (): Promise<void> => {
      if (remote.length === 0) return;
      await this.#requireRuntime().sendInput(Uint8Array.from(remote.splice(0)), target.tabId, target.binding);
    };
    for (const byte of bytes) {
      if (this.#pasteActive) {
        remote.push(byte);
        const matched = advanceSequence(BRACKETED_PASTE_END, byte, this.#pasteEndMatch);
        if (matched === BRACKETED_PASTE_END.length) {
          this.#pasteActive = false;
          this.#pasteEndMatch = 0;
        } else {
          this.#pasteEndMatch = matched;
        }
        continue;
      }
      this.#pasteStartMatch = advanceSequence(BRACKETED_PASTE_START, byte, this.#pasteStartMatch);
      if (this.#pasteStartMatch === BRACKETED_PASTE_START.length) {
        this.#pasteActive = true;
        this.#pasteStartMatch = 0;
        remote.push(byte);
        continue;
      }
      if (!this.#prefixPending) {
        if (byte === ESCAPE_PREFIX) {
          await flush();
          this.#prefixPending = true;
        } else {
          remote.push(byte);
        }
        continue;
      }
      this.#prefixPending = false;
      if (byte === ESCAPE_PREFIX) {
        remote.push(ESCAPE_PREFIX);
      } else if (byte === DETACH && this.#detachChordTrusted) {
        await flush();
        await this.#requireRuntime().detach(snapshot.tabId);
        if (this.#snapshot === snapshot) this.#snapshot = Object.freeze({ ...snapshot, state: "detached" });
        void this.stop().catch(() => { this.#state = "failed"; });
        return;
      } else {
        remote.push(ESCAPE_PREFIX, byte);
      }
    }
    await flush();
  }

  #observeRemoteModeOutput(bytes: Uint8Array): void {
    if (!this.#detachChordTrusted) return;
    for (const byte of bytes) {
      this.#remotePasteDisableMatch = advanceSequence(
        BRACKETED_PASTE_DISABLE,
        byte,
        this.#remotePasteDisableMatch,
      );
      if (this.#remotePasteDisableMatch === BRACKETED_PASTE_DISABLE.length) {
        this.#detachChordTrusted = false;
        this.#remotePasteDisableMatch = 0;
        return;
      }
    }
  }

  #queueResize(): void {
    if (this.#state !== "active") return;
    if (this.#resizeTimer !== undefined) clearTimeout(this.#resizeTimer);
    this.#resizeTimer = setTimeout(() => {
      this.#resizeTimer = undefined;
      void this.#applyResize().catch((error) => {
        this.#failure ??= error;
        void this.stop().catch(() => { this.#state = "failed"; });
      });
    }, this.#options.resizeCoalesceMs);
    this.#resizeTimer.unref();
  }

  async #applyResize(): Promise<void> {
    const snapshot = this.#snapshot;
    if (snapshot === undefined || snapshot.state !== "active" || snapshot.resizeCapability !== "live") return;
    const dimensions = admitPassthroughDimensions(this.#options.host.dimensions());
    await this.#requireRuntime().resize(dimensions.columns, dimensions.rows, snapshot.tabId);
  }

  #requireRuntime(): ForegroundTerminalRuntime {
    if (this.#runtime === undefined) throw runtimeFailure("control_plane_unavailable", "No passthrough runtime is bound.");
    return this.#runtime;
  }
}

export function admitPassthroughDimensions(input: {
  readonly columns: number;
  readonly rows: number;
}): { readonly columns: number; readonly rows: number } {
  if (!Number.isSafeInteger(input.columns) || !Number.isSafeInteger(input.rows) || input.columns < 1 || input.rows < 1 || input.columns > 1_000 || input.rows > 1_000) {
    throw new RangeError("The passthrough host terminal dimensions are outside protocol bounds.");
  }
  return Object.freeze({ columns: input.columns, rows: input.rows });
}

function sameIntent(intent: ForegroundTabIntent, snapshot: RuntimeTerminalSnapshot): boolean {
  return intent.tabId === snapshot.tabId && intent.agentSessionId === snapshot.agentSessionId;
}

function sameEvent(snapshot: RuntimeTerminalSnapshot, event: {
  readonly tabId: string;
  readonly agentSessionId: string;
  readonly binding: RuntimeTerminalResponse["binding"];
}): boolean {
  return snapshot.tabId === event.tabId &&
    snapshot.agentSessionId === event.agentSessionId &&
    snapshot.userId === event.binding.userId &&
    snapshot.machineId === event.binding.machineId &&
    snapshot.agentSessionId === event.binding.agentSessionId &&
    snapshot.processEpoch === event.binding.processEpoch &&
    snapshot.fencingGeneration === event.binding.fencingGeneration;
}

function advanceSequence(sequence: Uint8Array, byte: number, matched: number): number {
  if (byte === sequence[matched]) return matched + 1;
  return byte === sequence[0] ? 1 : 0;
}
