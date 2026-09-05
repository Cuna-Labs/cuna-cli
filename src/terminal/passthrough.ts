import type {
  RuntimeTerminalResponse,
  RuntimeTerminalSnapshot,
} from "../runtime/boundary.js";
import { runtimeFailure } from "../runtime/errors.js";
import type {
  DetachedForegroundSession,
  ForegroundTabIntent,
  ForegroundTerminalHost,
  ForegroundTerminalRuntime,
  ForegroundTerminalState,
} from "./foreground.js";
import { HISTORICAL_INPUT_NOTICE, MAX_FOREGROUND_PENDING_INPUT_BYTES, admitForegroundSessionIds } from "./foreground.js";
import type { HostTerminalLease } from "./mode.js";
import { ViewportRegistry } from "./viewport.js";
import { XtermViewportAdapter } from "./xterm-vte.js";
import { renderBareViewport } from "./workbench.js";

const ESCAPE_PREFIX = 0x1d;
const INTERRUPT = 0x03;
const FLOW_RESUME = 0x11;
const FLOW_PAUSE = 0x13;
const REMOTE_INTERRUPT = 0x63;
const REMOTE_FLOW_RESUME = 0x71;
const REMOTE_FLOW_PAUSE = 0x73;
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
 * A single-session fallback. Ordinary writers retain byte-preserving output;
 * observers and writers with historical input uncertainty use an isolated cell
 * projection with bounded local notices. This mode has no Cuna appbar.
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
  #localDetachTabId: string | undefined;
  readonly #detachedSessions: DetachedForegroundSession[] = [];
  #failure: unknown;
  #stopPromise: Promise<void> | undefined;
  readonly #stopStarted: Promise<void>;
  readonly #resolveStopStarted: () => void;
  readonly #initialReady: Promise<void>;
  readonly #resolveInitialReady: () => void;
  readonly #lifetimeAbort = new AbortController();
  #startupDetached = false;
  #viewport: XtermViewportAdapter | undefined;

  constructor(options: PassthroughTerminalCoordinatorOptions) {
    const resizeCoalesceMs = options.resizeCoalesceMs ?? RESIZE_COALESCE_MS;
    if (!Number.isSafeInteger(resizeCoalesceMs) || resizeCoalesceMs < 1 || resizeCoalesceMs > 1_000) {
      throw new RangeError("Passthrough resize coalescing must be between 1 and 1000 milliseconds.");
    }
    this.#options = Object.freeze({ ...options, resizeCoalesceMs });
    let resolveStopStarted = (): void => undefined;
    this.#stopStarted = new Promise<void>((resolve) => { resolveStopStarted = resolve; });
    this.#resolveStopStarted = resolveStopStarted;
    let resolveInitialReady = (): void => undefined;
    this.#initialReady = new Promise<void>((resolve) => { resolveInitialReady = resolve; });
    this.#resolveInitialReady = resolveInitialReady;
  }

  get state(): ForegroundTerminalState {
    return this.#state;
  }

  get failure(): unknown {
    return this.#failure;
  }

  /** The AgentSession the person detached from with Ctrl+] d, once the runtime confirmed it. */
  get detachedSessions(): readonly DetachedForegroundSession[] {
    return Object.freeze([...this.#detachedSessions]);
  }

  bindRuntime(runtime: ForegroundTerminalRuntime): void {
    if (this.#runtime !== undefined || this.#state !== "idle") {
      throw runtimeFailure("session_conflict", "The passthrough runtime is already bound or started.");
    }
    this.#runtime = runtime;
  }

  runtimeCallbacks(): {
    readonly onTerminalReady: (snapshot: RuntimeTerminalSnapshot) => Promise<void>;
    readonly onTerminalGeometry: (event: { readonly snapshot: RuntimeTerminalSnapshot; readonly signal: AbortSignal }) => Promise<void>;
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
      onTerminalGeometry: async (event) => await this.#terminalGeometry(event.snapshot, event.signal),
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
      const attachSignal = signal === undefined
        ? this.#lifetimeAbort.signal
        : AbortSignal.any([signal, this.#lifetimeAbort.signal]);
      const snapshot = await runtime.attach({
        tabId: intent.tabId,
        agentSessionId: intent.agentSessionId,
        columns: dimensions.columns,
        rows: dimensions.rows,
        ...(intent.attachmentAdmission === undefined
          ? {}
          : { expectedAdmission: intent.attachmentAdmission }),
        signal: attachSignal,
      });
      if (this.#startupDetached || this.#state !== "starting") {
        await runtime.detach(snapshot.tabId);
        return;
      }
      if (!sameIntent(intent, snapshot)) {
        throw runtimeFailure("grant_scope_mismatch", "Passthrough readiness targets a different AgentSession.");
      }
      this.#snapshot = snapshot;
      await this.#repaintAfterReplay(snapshot, dimensions);
      this.#state = "active";
    } catch (error) {
      const startupDetached = this.#startupDetached;
      if (!startupDetached) this.#state = "failed";
      try {
        await this.stop();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Passthrough startup and cleanup both failed.");
      }
      if (startupDetached) return;
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
    this.#lifetimeAbort.abort(new Error("Passthrough terminal detached locally."));
    this.#removeAbort?.();
    this.#removeAbort = undefined;
    if (this.#resizeTimer !== undefined) clearTimeout(this.#resizeTimer);
    this.#resizeTimer = undefined;
    this.#removeInput?.();
    this.#removeResize?.();
    this.#removeInput = undefined;
    this.#removeResize = undefined;
    // Release any input that arrived before readiness so cleanup cannot wait
    // on a promise that only cleanup itself would otherwise resolve.
    this.#resolveInitialReady();
    const failures: unknown[] = [];
    const snapshot = this.#snapshot;
    if (snapshot !== undefined && snapshot.state !== "closed" && snapshot.state !== "detached") {
      try { await this.#requireRuntime().detach(snapshot.tabId); } catch (error) { failures.push(error); }
    }
    try { await this.#outputTail; } catch (error) { failures.push(error); }
    try { await this.#inputTail; } catch (error) { failures.push(error); }
    this.#viewport?.dispose();
    this.#viewport = undefined;
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

  async #terminalReady(snapshot: RuntimeTerminalSnapshot): Promise<void> {
    await this.#outputTail;
    const intent = this.#intent;
    if (intent === undefined || !sameIntent(intent, snapshot)) {
      throw runtimeFailure("grant_scope_mismatch", "Passthrough readiness targets an unbound AgentSession.");
    }
    if (this.#state !== "starting" && this.#state !== "active") {
      throw runtimeFailure("terminal_disconnected", "Passthrough readiness arrived after terminal ownership ended.");
    }
    const previous = this.#viewport?.snapshot();
    if (previous !== undefined) {
      const binding = { userId: snapshot.userId, machineId: snapshot.machineId,
        agentSessionId: snapshot.agentSessionId, processEpoch: snapshot.processEpoch,
        fencingGeneration: snapshot.fencingGeneration };
      if (previous.binding.fencingGeneration === binding.fencingGeneration && sameEvent(snapshot, {
        tabId: previous.tabId, agentSessionId: previous.binding.agentSessionId, binding: previous.binding,
      })) {
        // A repeated READY for the exact attachment cannot erase consumed cells.
      } else {
        await this.#viewport?.rebind(binding);
      }
      this.#snapshot = snapshot;
      this.#resolveInitialReady();
      return;
    }
    this.#snapshot = snapshot;
    const dimensions = admitPassthroughDimensions(this.#options.host.dimensions());
    this.#viewport = new XtermViewportAdapter({
      tabId: snapshot.tabId,
      binding: {
        userId: snapshot.userId, machineId: snapshot.machineId,
        agentSessionId: snapshot.agentSessionId, processEpoch: snapshot.processEpoch,
        fencingGeneration: snapshot.fencingGeneration,
      },
      columns: dimensions.columns, rows: dimensions.rows,
      registry: new ViewportRegistry(), scrollback: 0,
      // The raw writer's physical terminal answers queries. The shadow model
      // must never duplicate those responses or emit observer input. A writer
      // with historical uncertainty uses projection to keep its notice visible.
      onTerminalResponse: async (response) => {
        if (this.#snapshot?.accessMode === "writer" && this.#snapshot.historicalInputUncertainty) {
          await this.#requireRuntime().sendTerminalResponse(response);
        }
      },
    });
    this.#resolveInitialReady();
  }

  async #terminalGeometry(snapshot: RuntimeTerminalSnapshot, signal: AbortSignal): Promise<void> {
    const operation = this.#outputTail.then(async () => {
      const current = this.#snapshot;
      if (current === undefined || !sameEvent(current, {
        tabId: snapshot.tabId, agentSessionId: snapshot.agentSessionId,
        binding: snapshot,
      }) || current.writerEpoch !== snapshot.writerEpoch || snapshot.geometry === null) {
        throw runtimeFailure("grant_scope_mismatch", "Plain geometry targets a different attachment or writer epoch.");
      }
      if (signal.aborted) throw runtimeFailure("terminal_disconnected", "Plain geometry was cancelled.");
      const viewport = this.#viewport;
      if (viewport === undefined) throw runtimeFailure("terminal_disconnected", "Plain geometry has no bound viewport.");
      const onAbort = (): void => viewport.dispose();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await viewport.resize(snapshot.geometry.columns, snapshot.geometry.rows);
        if (signal.aborted) throw runtimeFailure("terminal_disconnected", "Plain geometry was cancelled.");
        this.#snapshot = snapshot;
        if (this.#usesProjection()) await this.#renderObserver();
      } finally { signal.removeEventListener("abort", onAbort); }
    });
    this.#outputTail = operation.then(() => undefined, () => undefined);
    await operation;
  }

  async #renderObserver(): Promise<void> {
    const snapshot = this.#snapshot;
    if (snapshot === undefined || !this.#usesProjection()) return;
    const dimensions = admitPassthroughDimensions(this.#options.host.dimensions());
    const viewport = this.#viewport;
    if (viewport === undefined) throw runtimeFailure("terminal_disconnected", "The observer viewport is unavailable.");
    const projection = viewport.snapshotForHost(dimensions.columns, dimensions.rows);
    const notice = [
      ...(snapshot.historicalInputUncertainty ? [HISTORICAL_INPUT_NOTICE] : []),
      ...(viewport.snapshot().columns > dimensions.columns || viewport.snapshot().rows > dimensions.rows || snapshot.historicalInputUncertainty ? ["Local view cropped."] : []),
    ].join(" · ") || undefined;
    if (snapshot.geometry == null) {
      // Do not display host-sized parsed cells as authoritative writer geometry.
      const { renderRows: _renderRows, ...plain } = projection;
      const label = "Terminal geometry unknown".slice(0, dimensions.columns);
      await this.#options.host.write(renderBareViewport({ ...plain,
        cells: [label], displayWidths: [label.length], modes: { ...plain.modes, cursorVisible: false },
      }, notice));
    } else {
      await this.#options.host.write(renderBareViewport(projection, notice));
    }
  }

  #usesProjection(): boolean {
    return this.#snapshot?.accessMode === "observer" || this.#snapshot?.historicalInputUncertainty === true;
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
      const viewport = this.#viewport;
      if (viewport === undefined) throw runtimeFailure("terminal_disconnected", "Plain output has no bound viewport.");
      await viewport.write(event.bytes, event.sequence, event.sequence);
      if (event.signal.aborted) throw runtimeFailure("terminal_disconnected", "Plain output was cancelled.");
      if (this.#usesProjection()) {
        await this.#renderObserver();
        return;
      }
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
    if (
      this.#localDetachTabId === snapshot.tabId &&
      (snapshot.state === "failed" || snapshot.state === "interrupted")
    ) {
      // Closing the local attachment can synchronously surface the transport's
      // interrupted state before detach() publishes/resolves its detached
      // state. That teardown edge is expected and must not become a CLI error.
      return;
    }
    const previous = this.#snapshot;
    this.#snapshot = snapshot;
    if (snapshot.state === "active" && this.#usesProjection() &&
      (previous?.accessMode !== snapshot.accessMode || previous.historicalInputUncertainty !== snapshot.historicalInputUncertainty)) {
      const operation = this.#outputTail.then(async () => await this.#renderObserver());
      this.#outputTail = operation.catch((error) => {
        this.#failure ??= error;
        void this.stop().catch(() => { this.#state = "failed"; });
      });
    }
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
    if (this.#state === "starting" && bytes.includes(INTERRUPT)) {
      this.#startupDetached = true;
      void this.stop().catch(() => { this.#state = "failed"; });
      return;
    }
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
    if (
      payload.byteLength === 1 &&
      payload[0] === INTERRUPT &&
      !this.#pasteActive &&
      !this.#prefixPending &&
      receiptTarget !== undefined
    ) {
      // The user's detach decision is authoritative from input receipt, not
      // only once its serialized input operation reaches runtime.detach(). A
      // concurrent WebSocket close in that window is expected teardown.
      this.#localDetachTabId = receiptTarget.tabId;
    }
    this.#pendingInputBytes += payload.byteLength;
    const operation = this.#inputTail.then(async () => {
      let admittedTarget = receiptTarget;
      if (admittedTarget === undefined && this.#state === "starting") {
        // Raw mode is acquired before the remote terminal can prove readiness.
        // Input arriving in that window belongs to this one exact intent; wait
        // for its first fenced binding instead of treating a normal early key
        // press as a terminal failure. Once ready, later input still captures
        // its generation at receipt time and cannot cross a reconnect fence.
        await this.#initialReady;
        const ready = this.#snapshot;
        if (ready !== undefined && ready.state === "active") {
          admittedTarget = Object.freeze({
            tabId: ready.tabId,
            binding: Object.freeze({
              userId: ready.userId,
              machineId: ready.machineId,
              agentSessionId: ready.agentSessionId,
              processEpoch: ready.processEpoch,
              fencingGeneration: ready.fencingGeneration,
            }),
          });
        }
      }
      try { await this.#routeInput(payload, admittedTarget); } finally { this.#pendingInputBytes -= payload.byteLength; }
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
      if (this.#snapshot?.accessMode !== "writer") { remote.length = 0; return; }
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
        if (byte === FLOW_PAUSE) {
          remote.push(FLOW_RESUME);
        } else if (byte === INTERRUPT) {
          await flush();
          await this.#detachLocal(snapshot);
          return;
        } else if (byte === ESCAPE_PREFIX) {
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
      } else if (byte === REMOTE_INTERRUPT) {
        remote.push(INTERRUPT);
      } else if (byte === REMOTE_FLOW_PAUSE) {
        remote.push(FLOW_PAUSE);
      } else if (byte === REMOTE_FLOW_RESUME) {
        remote.push(FLOW_RESUME);
      } else if (byte === DETACH && this.#detachChordTrusted) {
        await flush();
        await this.#detachLocal(snapshot);
        return;
      } else {
        remote.push(ESCAPE_PREFIX, byte);
      }
    }
    await flush();
  }

  async #detachLocal(snapshot: RuntimeTerminalSnapshot): Promise<void> {
    this.#localDetachTabId = snapshot.tabId;
    try {
      await this.#requireRuntime().detach(snapshot.tabId);
    } catch (error) {
      this.#localDetachTabId = undefined;
      throw error;
    }
    if (this.#snapshot === snapshot) {
      this.#snapshot = Object.freeze({ ...snapshot, state: "detached" });
    }
    this.#localDetachTabId = undefined;
    const intent = this.#intent;
    if (intent !== undefined && intent.tabId === snapshot.tabId) {
      this.#detachedSessions.push(Object.freeze({ agentSessionId: intent.agentSessionId, label: intent.label }));
    }
    void this.stop().catch(() => { this.#state = "failed"; });
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
    const authority = this.#snapshot;
    if (authority === undefined) return;
    if (this.#resizeTimer !== undefined) clearTimeout(this.#resizeTimer);
    this.#resizeTimer = setTimeout(() => {
      this.#resizeTimer = undefined;
      void this.#applyResize(authority).catch((error) => {
        this.#failure ??= error;
        void this.stop().catch(() => { this.#state = "failed"; });
      });
    }, this.#options.resizeCoalesceMs);
    this.#resizeTimer.unref();
  }

  async #applyResize(authority: RuntimeTerminalSnapshot): Promise<void> {
    const snapshot = this.#snapshot;
    if (snapshot === undefined || snapshot.state !== "active") return;
    if (snapshot.accessMode === "observer" || authority.accessMode !== "writer" ||
      snapshot.writerEpoch !== authority.writerEpoch || !sameEvent(snapshot, {
        tabId: authority.tabId, agentSessionId: authority.agentSessionId, binding: authority,
      })) {
      const operation = this.#outputTail.then(async () => await this.#renderObserver());
      this.#outputTail = operation.then(() => undefined, () => undefined);
      await operation;
      return;
    }
    if (snapshot.resizeCapability !== "live") return;
    const dimensions = admitPassthroughDimensions(this.#options.host.dimensions());
    await this.#requireRuntime().resize(dimensions.columns, dimensions.rows, snapshot.tabId);
  }

  async #repaintAfterReplay(
    snapshot: RuntimeTerminalSnapshot,
    dimensions: { readonly columns: number; readonly rows: number },
  ): Promise<void> {
    if (snapshot.accessMode === "observer") { await this.#renderObserver(); return; }
    if (snapshot.state !== "active" || snapshot.accessMode !== "writer" || snapshot.resizeCapability !== "live") return;
    // A fullscreen TUI may have painted its base frame before this client
    // attached, leaving replay with cursor-relative deltas only. Force one
    // real size transition and restore the admitted host size so the remote
    // application receives SIGWINCH and emits a complete current frame.
    const bounceColumns = dimensions.columns === 1 ? 2 : dimensions.columns - 1;
    await this.#requireRuntime().resize(bounceColumns, dimensions.rows, snapshot.tabId);
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
