import type {
  RuntimeTerminalResponse,
  RuntimeTerminalSnapshot,
} from "../runtime/boundary.js";
import type { TerminalAttachmentAdmission } from "../runtime/terminal-transport.js";
import { RuntimeBoundaryError, runtimeFailure } from "../runtime/errors.js";
import type { HostTerminalLease } from "./mode.js";
import { assertCanonicalUuid } from "../core/validation.js";
import { buildAppbarModel, type AppbarModel, type StatusEvidence } from "./appbar.js";
import { renderWorkbenchFrame, type WorkbenchTab } from "./workbench.js";
import { ViewportRegistry } from "./viewport.js";
import { XtermViewportAdapter } from "./xterm-vte.js";

const ESCAPE_PREFIX = 0x1d;
const TAB_FIRST = 0x31;
const TAB_LAST = 0x34;
const NEXT_TAB = 0x6e;
const DETACH = 0x64;
const HELP = 0x3f;
const RETRY = 0x72;
const RESIZE_COALESCE_MS = 50;
const BRACKETED_PASTE_START = Uint8Array.of(0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e);
const BRACKETED_PASTE_END = Uint8Array.of(0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e);
export const MAX_FOREGROUND_PENDING_INPUT_BYTES = 1_048_576;

export type ForegroundTerminalState = "idle" | "starting" | "active" | "stopping" | "stopped" | "failed";

export interface ForegroundTerminalRuntime {
  readonly activeTabId: string | undefined;
  attach(input: {
    readonly tabId: string;
    readonly agentSessionId: string;
    readonly columns: number;
    readonly rows: number;
    readonly expectedAdmission?: TerminalAttachmentAdmission;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeTerminalSnapshot>;
  detach(tabId: string): Promise<void>;
  reconnect(input: { readonly tabId: string; readonly signal?: AbortSignal }): Promise<RuntimeTerminalSnapshot>;
  sendInput(bytes: Uint8Array, tabId?: string, expectedBinding?: RuntimeTerminalResponse["binding"]): Promise<void>;
  resize(columns: number, rows: number, tabId?: string): Promise<void>;
  switchActive(tabId: string): RuntimeTerminalSnapshot;
  sendTerminalResponse(response: RuntimeTerminalResponse): Promise<void>;
}

export interface ForegroundTerminalHost {
  dimensions(): { readonly columns: number; readonly rows: number };
  acquire(mode?: "rich" | "plain"): Promise<HostTerminalLease>;
  write(bytes: Uint8Array): Promise<void>;
  onInput(listener: (bytes: Uint8Array) => void): () => void;
  onResize(listener: () => void): () => void;
}

export interface ForegroundTabIntent {
  readonly tabId: string;
  readonly agentSessionId: string;
  readonly label: string;
  readonly agent: WorkbenchTab["agent"];
  /** Supervisor-owned lifecycle evidence. Terminal output must never populate this field. */
  readonly agentSessionLifecycle?: StatusEvidence<string>;
  /** Provider-auth evidence for this exact AgentSession process generation. */
  readonly providerAuthentication?: StatusEvidence<string>;
  /** Exact preflight authority retained through grant admission. */
  readonly attachmentAdmission?: TerminalAttachmentAdmission;
}

interface ForegroundInputTarget {
  readonly tabId: string;
  readonly binding: RuntimeTerminalResponse["binding"];
}

export interface ForegroundTerminalCoordinatorOptions {
  readonly host: ForegroundTerminalHost;
  readonly appbar?: () => AppbarModel;
  readonly color?: boolean;
  readonly clock?: () => number;
  readonly resizeCoalesceMs?: number;
  readonly reconnectAttempts?: number;
  readonly reconnectBaseDelayMs?: number;
}

interface ForegroundTab {
  readonly intent: ForegroundTabIntent;
  snapshot: RuntimeTerminalSnapshot;
  viewport: XtermViewportAdapter;
}

export class ForegroundTerminalCoordinator {
  readonly #options: ForegroundTerminalCoordinatorOptions;
  readonly #registry = new ViewportRegistry();
  readonly #tabs = new Map<string, ForegroundTab>();
  readonly #clock: () => number;
  #runtime: ForegroundTerminalRuntime | undefined;
  #lease: HostTerminalLease | undefined;
  #state: ForegroundTerminalState = "idle";
  #activeTabId: string | undefined;
  #removeInput: (() => void) | undefined;
  #removeResize: (() => void) | undefined;
  #resizeTimer: NodeJS.Timeout | undefined;
  #renderTail: Promise<void> = Promise.resolve();
  #inputTail: Promise<void> = Promise.resolve();
  #prefixPending = false;
  #prefixTarget: ForegroundInputTarget | undefined;
  #pasteActive = false;
  #pasteStartMatch = 0;
  #pasteEndMatch = 0;
  #stopPromise: Promise<void> | undefined;
  readonly #stopStarted: Promise<void>;
  readonly #resolveStopStarted: () => void;
  readonly #lifetimeAbort = new AbortController();
  readonly #reconnectTasks = new Map<string, Promise<void>>();
  readonly #recoverableReconnectFailures = new Map<string, unknown>();
  readonly #outputTails = new Map<string, Promise<void>>();
  #removeAbort: (() => void) | undefined;
  #pendingInputBytes = 0;
  #helpVisible = false;
  #terminalFailure: unknown;
  #stateRenderRunning = false;
  #stateRenderDirty = false;

  constructor(options: ForegroundTerminalCoordinatorOptions) {
    const resizeCoalesceMs = options.resizeCoalesceMs ?? RESIZE_COALESCE_MS;
    if (!Number.isSafeInteger(resizeCoalesceMs) || resizeCoalesceMs < 1 || resizeCoalesceMs > 1_000) {
      throw new RangeError("Foreground resize coalescing must be between 1 and 1000 milliseconds.");
    }
    const reconnectAttempts = options.reconnectAttempts ?? 3;
    const reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 100;
    if (!Number.isSafeInteger(reconnectAttempts) || reconnectAttempts < 1 || reconnectAttempts > 10) {
      throw new RangeError("Foreground reconnect attempts must be between 1 and 10.");
    }
    if (!Number.isSafeInteger(reconnectBaseDelayMs) || reconnectBaseDelayMs < 1 || reconnectBaseDelayMs > 5_000) {
      throw new RangeError("Foreground reconnect delay must be between 1 and 5000 milliseconds.");
    }
    this.#options = Object.freeze({ ...options, resizeCoalesceMs, reconnectAttempts, reconnectBaseDelayMs });
    this.#clock = options.clock ?? Date.now;
    let resolveStopStarted = (): void => undefined;
    this.#stopStarted = new Promise<void>((resolve) => {
      resolveStopStarted = resolve;
    });
    this.#resolveStopStarted = resolveStopStarted;
  }

  get state(): ForegroundTerminalState {
    return this.#state;
  }

  get failure(): unknown {
    return this.#terminalFailure ?? this.#recoverableReconnectFailures.values().next().value;
  }

  bindRuntime(runtime: ForegroundTerminalRuntime): void {
    if (this.#runtime !== undefined) throw runtimeFailure("session_conflict", "The foreground runtime is already bound.");
    if (this.#state !== "idle") throw runtimeFailure("session_conflict", "The foreground runtime must be bound before startup.");
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
      onTerminalReady: async (snapshot) => await this.#terminalReady(snapshot),
      onTerminalOutput: async (event) => await this.#queueTerminalOutput(event),
      onTerminalState: (snapshot) => this.#terminalState(snapshot),
    });
  }

  async start(intents: readonly ForegroundTabIntent[], signal?: AbortSignal): Promise<void> {
    if (this.#state !== "idle") throw runtimeFailure("session_conflict", "The foreground terminal already started.");
    const runtime = this.#requireRuntime();
    validateIntents(intents);
    this.#pendingIntents = Object.freeze(intents.map((intent) => Object.freeze({ ...intent })));
    this.#state = "starting";
    try {
      if (signal?.aborted) throw runtimeFailure("terminal_disconnected", "Foreground terminal startup was cancelled.");
      if (signal !== undefined) {
        const onAbort = (): void => {
          this.#recordFailure(runtimeFailure("terminal_disconnected", "Foreground terminal execution was cancelled."));
          void this.stop().catch(() => { this.#state = "failed"; });
        };
        signal.addEventListener("abort", onAbort, { once: true });
        this.#removeAbort = () => signal.removeEventListener("abort", onAbort);
      }
      admitForegroundDimensions(this.#options.host.dimensions());
      const lease = await this.#options.host.acquire();
      if (signal?.aborted || this.#state !== "starting") {
        await lease.restore();
        throw runtimeFailure("terminal_disconnected", "Foreground terminal startup was cancelled.");
      }
      this.#lease = lease;
      this.#removeInput = this.#options.host.onInput((bytes) => this.#queueInput(bytes));
      this.#removeResize = this.#options.host.onResize(() => this.#queueResize());
      const dimensions = admitForegroundDimensions(this.#options.host.dimensions());
      await this.#renderAttaching(intents.length, dimensions);
      for (const intent of intents) {
        if (signal?.aborted) throw runtimeFailure("terminal_disconnected", "Foreground terminal startup was cancelled.");
        const snapshot = await runtime.attach({
          tabId: intent.tabId,
          agentSessionId: intent.agentSessionId,
          columns: dimensions.columns,
          rows: remoteRows(dimensions.rows),
          ...(intent.attachmentAdmission === undefined
            ? {}
            : { expectedAdmission: intent.attachmentAdmission }),
          ...(signal === undefined ? {} : { signal }),
        });
        const tab = this.#tabs.get(intent.tabId);
        if (tab === undefined) {
          throw runtimeFailure("terminal_protocol_error", "The terminal became active before its fenced viewport was installed.");
        }
        tab.snapshot = snapshot;
        this.#activeTabId ??= intent.tabId;
        await this.#render();
      }
      this.#state = "active";
      await this.#render();
    } catch (error) {
      this.#state = "failed";
      try {
        await this.stop();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Foreground terminal startup and cleanup both failed.");
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
      if (this.#state === "failed") this.#stopPromise = undefined;
    }
  }

  async waitForStop(): Promise<void> {
    await this.#stopStarted;
    const attempt = this.#stopPromise;
    if (attempt === undefined) {
      throw runtimeFailure("terminal_disconnected", "Foreground terminal cleanup did not start.");
    }
    await attempt;
    if (this.#state !== "stopped") {
      throw runtimeFailure("terminal_disconnected", "Foreground terminal cleanup did not complete.");
    }
  }

  async #stopNow(): Promise<void> {
    if (this.#state === "stopped") return;
    this.#state = "stopping";
    this.#lifetimeAbort.abort();
    this.#removeAbort?.();
    this.#removeAbort = undefined;
    if (this.#resizeTimer !== undefined) clearTimeout(this.#resizeTimer);
    this.#resizeTimer = undefined;
    this.#removeInput?.();
    this.#removeResize?.();
    this.#removeInput = undefined;
    this.#removeResize = undefined;
    const failures: unknown[] = [];
    const runtime = this.#runtime;
    if (runtime !== undefined) {
      for (const tabId of this.#tabs.keys()) {
        try { await runtime.detach(tabId); } catch (error) { failures.push(error); }
      }
    }
    try { await Promise.all(this.#outputTails.values()); } catch (error) { failures.push(error); }
    this.#outputTails.clear();
    try { await this.#inputTail; } catch (error) { failures.push(error); }
    for (const tab of this.#tabs.values()) tab.viewport.dispose();
    this.#tabs.clear();
    this.#pendingIntents = Object.freeze([]);
    this.#pendingInputBytes = 0;
    this.#reconnectTasks.clear();
    try { await this.#renderTail; } catch (error) { failures.push(error); }
    if (this.#lease !== undefined) {
      try {
        await this.#lease.restore();
        this.#lease = undefined;
      } catch (error) {
        failures.push(error);
      }
    }
    this.#state = failures.length === 0 ? "stopped" : "failed";
    if (failures.length > 0) throw new AggregateError(failures, "Foreground terminal cleanup was incomplete.");
  }

  async #terminalReady(snapshot: RuntimeTerminalSnapshot): Promise<void> {
    const runtime = this.#requireRuntime();
    const intent = this.#findIntent(snapshot.tabId, snapshot.agentSessionId);
    const previous = this.#tabs.get(snapshot.tabId);
    await this.#outputTails.get(snapshot.tabId);
    await this.#renderTail;
    if (
      this.#lifetimeAbort.signal.aborted ||
      (this.#state !== "starting" && this.#state !== "active")
    ) {
      throw runtimeFailure("terminal_disconnected", "Terminal readiness arrived after foreground ownership ended.");
    }
    previous?.viewport.dispose();
    const dimensions = admitForegroundDimensions(this.#options.host.dimensions());
    const viewport = new XtermViewportAdapter({
      tabId: snapshot.tabId,
      binding: {
        userId: snapshot.userId,
        machineId: snapshot.machineId,
        agentSessionId: snapshot.agentSessionId,
        processEpoch: snapshot.processEpoch,
        fencingGeneration: snapshot.fencingGeneration,
      },
      columns: dimensions.columns,
      rows: remoteRows(dimensions.rows),
      registry: this.#registry,
      onTerminalResponse: async (response) => await runtime.sendTerminalResponse(response),
      clock: this.#clock,
    });
    this.#tabs.set(snapshot.tabId, { intent, snapshot, viewport });
  }

  async #queueTerminalOutput(event: {
    readonly tabId: string;
    readonly agentSessionId: string;
    readonly binding: RuntimeTerminalResponse["binding"];
    readonly sequence: bigint;
    readonly bytes: Uint8Array;
    readonly signal: AbortSignal;
  }): Promise<void> {
    const previous = this.#outputTails.get(event.tabId) ?? Promise.resolve();
    const operation = previous.then(async () => await this.#terminalOutput(event));
    const tail = operation.then(() => undefined, () => undefined);
    this.#outputTails.set(event.tabId, tail);
    try {
      await operation;
    } finally {
      if (this.#outputTails.get(event.tabId) === tail) this.#outputTails.delete(event.tabId);
    }
  }

  async #terminalOutput(event: {
    readonly tabId: string;
    readonly agentSessionId: string;
    readonly binding: RuntimeTerminalResponse["binding"];
    readonly sequence: bigint;
    readonly bytes: Uint8Array;
    readonly signal: AbortSignal;
  }): Promise<void> {
    const tab = this.#tabs.get(event.tabId);
    if (tab === undefined || tab.intent.agentSessionId !== event.agentSessionId || !sameSnapshotBinding(tab.snapshot, event.binding)) {
      throw runtimeFailure("grant_scope_mismatch", "Terminal output targets an unbound foreground viewport.");
    }
    await raceAbort(tab.viewport.write(event.bytes, event.sequence, event.sequence), event.signal);
    const current = this.#tabs.get(event.tabId);
    if (event.signal.aborted || current !== tab || !sameSnapshotBinding(tab.snapshot, event.binding)) return;
    await this.#render();
  }

  #terminalState(snapshot: RuntimeTerminalSnapshot): void {
    const tab = this.#tabs.get(snapshot.tabId);
    if (tab !== undefined) {
      tab.snapshot = snapshot;
      if (snapshot.state === "failed" || snapshot.state === "closed" || snapshot.state === "detached") {
        if (snapshot.state === "failed") {
          this.#recordFailure(runtimeFailure("terminal_disconnected", "A foreground AgentSession terminal failed."));
        }
        tab.viewport.dispose();
        this.#tabs.delete(snapshot.tabId);
        if (this.#activeTabId === snapshot.tabId) {
          const replacement = [...this.#tabs.keys()][0];
          this.#activeTabId = replacement;
          if (replacement !== undefined) {
            this.#requireRuntime().switchActive(replacement);
            this.#registry.select(replacement);
          }
        }
      }
    }
    if (this.#state !== "active") return;
    if (this.#tabs.size === 0) {
      void this.stop().catch(() => { this.#state = "failed"; });
      return;
    }
    if (snapshot.state === "interrupted" && !this.#reconnectTasks.has(snapshot.tabId)) {
      this.#startRecovery(snapshot.tabId);
    }
    this.#queueStateRender();
  }

  async #recoverTab(tabId: string): Promise<void> {
    const attempts = this.#options.reconnectAttempts ?? 3;
    const baseDelayMs = this.#options.reconnectBaseDelayMs ?? 100;
    let lastFailure: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (this.#state !== "active" || this.#lifetimeAbort.signal.aborted) return;
      await abortableDelay(Math.min(baseDelayMs * (2 ** attempt), 5_000), this.#lifetimeAbort.signal);
      if (this.#state !== "active" || this.#lifetimeAbort.signal.aborted) return;
      try {
        await this.#requireRuntime().reconnect({ tabId, signal: this.#lifetimeAbort.signal });
        this.#recoverableReconnectFailures.delete(tabId);
        return;
      } catch (error) {
        lastFailure = error;
        if (this.#lifetimeAbort.signal.aborted || this.#state !== "active") return;
        if (error instanceof RuntimeBoundaryError && !error.retryable) break;
      }
    }
    if (this.#state === "active") {
      this.#recoverableReconnectFailures.set(tabId, lastFailure ?? runtimeFailure(
        "terminal_disconnected",
        "Automatic terminal reconnection was exhausted.",
        { retryable: true },
      ));
      await this.#render();
    }
  }

  #queueInput(bytes: Uint8Array): void {
    if (bytes.byteLength < 1) return;
    if (bytes.byteLength > MAX_FOREGROUND_PENDING_INPUT_BYTES || this.#pendingInputBytes + bytes.byteLength > MAX_FOREGROUND_PENDING_INPUT_BYTES) {
      this.#recordFailure(runtimeFailure("terminal_protocol_error", "Foreground terminal input exceeded its bounded queue."));
      void this.stop().catch(() => { this.#state = "failed"; });
      return;
    }
    const payload = bytes.slice();
    const receiptTarget = this.#captureInputTarget();
    this.#pendingInputBytes += payload.byteLength;
    const operation = this.#inputTail.then(async () => {
      try { await this.#routeInput(payload, receiptTarget); } finally { this.#pendingInputBytes -= payload.byteLength; }
    });
    this.#inputTail = operation.catch((error) => {
      if (error instanceof RuntimeBoundaryError && (error.code === "terminal_disconnected" || error.code === "session_unknown")) return;
      this.#recordFailure(error);
      void this.stop().catch(() => { this.#state = "failed"; });
    });
  }

  async #routeInput(bytes: Uint8Array, receiptTarget: ForegroundInputTarget | undefined): Promise<void> {
    const runtime = this.#requireRuntime();
    let target = this.#prefixPending ? this.#prefixTarget : receiptTarget;
    let remote: number[] = [];
    const flush = async (): Promise<void> => {
      if (remote.length === 0) return;
      if (target === undefined) throw runtimeFailure("session_unknown", "No foreground terminal tab is active.");
      const payload = Uint8Array.from(remote);
      remote = [];
      await runtime.sendInput(payload, target.tabId, target.binding);
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
          this.#prefixTarget = target;
        } else {
          remote.push(byte);
        }
        continue;
      }
      this.#prefixPending = false;
      const chordTarget = this.#prefixTarget;
      this.#prefixTarget = undefined;
      if (byte === ESCAPE_PREFIX) {
        target = chordTarget ?? target;
        remote.push(ESCAPE_PREFIX);
      } else if (byte >= TAB_FIRST && byte <= TAB_LAST) {
        await flush();
        this.#selectByIndex(byte - TAB_FIRST);
        target = this.#captureInputTarget();
      } else if (byte === NEXT_TAB) {
        await flush();
        this.#selectNext();
        target = this.#captureInputTarget();
      } else if (byte === DETACH) {
        await flush();
        await this.#detachTab(chordTarget?.tabId);
        return;
      } else if (byte === HELP) {
        await flush();
        this.#helpVisible = !this.#helpVisible;
        await this.#render();
      } else if (byte === RETRY) {
        await flush();
        this.#retryActiveTab();
      } else {
        this.#helpVisible = false;
        target = chordTarget ?? target;
        remote.push(ESCAPE_PREFIX, byte);
      }
    }
    await flush();
  }

  #selectByIndex(index: number): void {
    const tabId = [...this.#tabs.keys()][index];
    if (tabId === undefined) return;
    this.#select(tabId);
  }

  #selectNext(): void {
    const ids = [...this.#tabs.keys()];
    if (ids.length === 0) return;
    const current = this.#activeTabId === undefined ? -1 : ids.indexOf(this.#activeTabId);
    this.#select(ids[(current + 1) % ids.length] ?? ids[0] ?? "");
  }

  #select(tabId: string): void {
    if (!this.#tabs.has(tabId)) return;
    this.#requireRuntime().switchActive(tabId);
    this.#registry.select(tabId);
    this.#activeTabId = tabId;
    void this.#render().catch((error) => {
      this.#recordFailure(error);
      void this.stop().catch(() => { this.#state = "failed"; });
    });
  }

  async #detachTab(tabId = this.#activeTabId): Promise<void> {
    if (tabId === undefined) return;
    await this.#requireRuntime().detach(tabId);

    // The runtime boundary publishes a detached snapshot before resolving. Keep
    // this fallback so the coordinator contract remains safe with any runtime
    // implementation that resolves detach without publishing a state event.
    const remaining = this.#tabs.get(tabId);
    if (remaining !== undefined) {
      remaining.viewport.dispose();
      this.#tabs.delete(tabId);
    }
    if (this.#activeTabId === tabId) this.#activeTabId = undefined;

    if (this.#tabs.size === 0) {
      // Do not await stop from inside the serialized input operation: cleanup
      // intentionally waits for that operation to drain before host restore.
      void this.stop().catch(() => { this.#state = "failed"; });
      return;
    }
    if (this.#activeTabId === undefined) {
      const replacement = this.#tabs.keys().next().value as string | undefined;
      if (replacement !== undefined) {
        this.#requireRuntime().switchActive(replacement);
        this.#registry.select(replacement);
        this.#activeTabId = replacement;
      }
    }
    await this.#render();
  }

  #captureInputTarget(): ForegroundInputTarget | undefined {
    const tabId = this.#activeTabId;
    if (tabId === undefined) return undefined;
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) return undefined;
    return Object.freeze({
      tabId,
      binding: Object.freeze({
        userId: tab.snapshot.userId,
        machineId: tab.snapshot.machineId,
        agentSessionId: tab.snapshot.agentSessionId,
        processEpoch: tab.snapshot.processEpoch,
        fencingGeneration: tab.snapshot.fencingGeneration,
      }),
    });
  }

  #queueResize(): void {
    if (this.#state !== "active") return;
    if (this.#resizeTimer !== undefined) clearTimeout(this.#resizeTimer);
    this.#resizeTimer = setTimeout(() => {
      this.#resizeTimer = undefined;
      void this.#applyResize().catch((error) => {
        this.#recordFailure(error);
        void this.stop().catch(() => { this.#state = "failed"; });
      });
    }, this.#options.resizeCoalesceMs);
    this.#resizeTimer.unref();
  }

  async #applyResize(): Promise<void> {
    const dimensions = admitForegroundDimensions(this.#options.host.dimensions());
    const rows = remoteRows(dimensions.rows);
    for (const [tabId, tab] of this.#tabs) {
      await tab.viewport.resize(dimensions.columns, rows);
      if (tab.snapshot.resizeCapability === "live" && tab.snapshot.state === "active") {
        await this.#requireRuntime().resize(dimensions.columns, rows, tabId);
      }
    }
    await this.#render();
  }

  async #render(): Promise<void> {
    const operation = this.#renderTail.then(async () => {
      const activeTabId = this.#activeTabId;
      if (activeTabId === undefined || this.#tabs.size === 0) return;
      const dimensions = admitForegroundDimensions(this.#options.host.dimensions());
      const tabs = [...this.#tabs.values()].map((tab): WorkbenchTab => Object.freeze({
        id: tab.intent.tabId,
        label: tab.intent.label,
        agent: tab.intent.agent,
        viewport: tab.viewport.snapshot(),
      }));
      const frame = renderWorkbenchFrame({
        columns: dimensions.columns,
        rows: dimensions.rows,
        activeTabId,
        tabs,
        appbar: this.#options.appbar?.() ?? runtimeAppbar(
          this.#clock(),
          this.#tabs.get(activeTabId)?.snapshot,
          this.#tabs.get(activeTabId)?.intent,
        ),
        color: this.#options.color ?? true,
        ...(this.#helpVisible ? { notice: "Keys: Ctrl+] ? help | 1-4 tab | n next | r retry | d detach | Ctrl+] literal" } : {}),
      });
      await this.#options.host.write(frame.bytes);
    });
    this.#renderTail = operation.then(() => undefined, () => undefined);
    await operation;
  }

  #findIntent(tabId: string, agentSessionId: string): ForegroundTabIntent {
    const existing = this.#tabs.get(tabId)?.intent;
    if (existing !== undefined) return existing;
    const intent = this.#pendingIntents.find((candidate) => candidate.tabId === tabId);
    if (intent === undefined || intent.agentSessionId !== agentSessionId) {
      throw runtimeFailure("grant_scope_mismatch", "Terminal readiness targets an unknown foreground intent.");
    }
    return intent;
  }

  #pendingIntents: readonly ForegroundTabIntent[] = Object.freeze([]);

  #requireRuntime(): ForegroundTerminalRuntime {
    if (this.#runtime === undefined) throw runtimeFailure("control_plane_unavailable", "No foreground terminal runtime is bound.");
    return this.#runtime;
  }

  async #renderAttaching(
    count: number,
    dimensions: { readonly columns: number; readonly rows: number },
  ): Promise<void> {
    const color = this.#options.color ?? true;
    const top = padTrustedLine(` RUNA  ATTACHING ${count} EXACT AGENTSESSION${count === 1 ? "" : "S"}`, dimensions.columns);
    const detail = padTrustedLine(" Authorizing the requested cloud terminals. No action is required.", dimensions.columns);
    const text = [
      "\u001b[?25l\u001b[H\u001b[2J",
      color ? "\u001b[48;2;235;86;37m\u001b[38;2;255;255;255m" : "",
      top,
      color ? "\u001b[0m" : "",
      dimensions.rows > 1 ? "\r\n" : "",
      dimensions.rows > 1 && color ? "\u001b[48;2;121;48;25m\u001b[38;2;224;210;203m" : "",
      dimensions.rows > 1 ? detail : "",
      color ? "\u001b[0m" : "",
    ].join("");
    await this.#options.host.write(new TextEncoder().encode(text));
  }

  #recordFailure(error: unknown): void {
    this.#terminalFailure ??= error;
  }

  #queueStateRender(): void {
    this.#stateRenderDirty = true;
    if (this.#stateRenderRunning) return;
    this.#stateRenderRunning = true;
    void (async () => {
      try {
        while (this.#stateRenderDirty && this.#state === "active") {
          this.#stateRenderDirty = false;
          await this.#render();
        }
      } catch (error) {
        this.#recordFailure(error);
        if (this.#state === "active") await this.stop();
      } finally {
        this.#stateRenderRunning = false;
        if (this.#stateRenderDirty && this.#state === "active") this.#queueStateRender();
      }
    })().catch((error) => {
      this.#recordFailure(error);
      this.#state = "failed";
    });
  }

  #startRecovery(tabId: string): void {
    if (this.#reconnectTasks.has(tabId)) return;
    const recovery = this.#recoverTab(tabId).catch(async (error) => {
      this.#recordFailure(error);
      if (this.#state === "active") await this.stop();
    });
    this.#reconnectTasks.set(tabId, recovery);
    void recovery.finally(() => this.#reconnectTasks.delete(tabId)).catch(() => { this.#state = "failed"; });
  }

  #retryActiveTab(): void {
    const tabId = this.#activeTabId;
    if (tabId === undefined || this.#tabs.get(tabId)?.snapshot.state !== "interrupted") return;
    this.#startRecovery(tabId);
  }
}

function validateIntents(intents: readonly ForegroundTabIntent[]): void {
  admitForegroundSessionIds(intents.map((intent) => intent.agentSessionId));
  if (new Set(intents.map((intent) => intent.tabId)).size !== intents.length) throw new RangeError("Foreground tab IDs must be unique.");
  for (const intent of intents) {
    if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(intent.tabId)) {
      throw new RangeError("Foreground tab IDs must use the local identifier grammar.");
    }
    if (intent.label.length < 1 || intent.label.length > 64) throw new RangeError("Foreground tab labels must contain 1 through 64 characters.");
  }
}

export function admitForegroundSessionIds(sessionIds: readonly string[]): readonly string[] {
  if (sessionIds.length < 1 || sessionIds.length > 4) {
    throw new RangeError("Foreground mode supports one through four active AgentSessions.");
  }
  if (new Set(sessionIds).size !== sessionIds.length) {
    throw new RangeError("Each foreground tab must bind a distinct AgentSession.");
  }
  for (const sessionId of sessionIds) {
    assertCanonicalUuid(sessionId, "AgentSession ID");
  }
  return Object.freeze([...sessionIds]);
}

export function admitForegroundDimensions(input: { readonly columns: number; readonly rows: number }): { readonly columns: number; readonly rows: number } {
  if (!Number.isSafeInteger(input.columns) || !Number.isSafeInteger(input.rows) || input.columns < 20 || input.rows < 3 || input.columns > 1_000 || input.rows > 1_000) {
    throw new RangeError("The foreground host terminal dimensions are outside supported bounds.");
  }
  return Object.freeze({ columns: input.columns, rows: input.rows });
}

function remoteRows(hostRows: number): number {
  return Math.max(1, hostRows - (hostRows >= 5 ? 2 : 1));
}

function unknownAppbar(now: number): AppbarModel {
  return buildAppbarModel({
    now,
    machineLifecycle: [],
    agentSessionLifecycle: [],
    attachment: [],
    providerAuthentication: [],
    workspaceSync: [],
  });
}

function runtimeAppbar(
  now: number,
  snapshot: RuntimeTerminalSnapshot | undefined,
  intent: ForegroundTabIntent | undefined,
): AppbarModel {
  if (snapshot === undefined) return unknownAppbar(now);
  const evidence = {
    source: "foreground_terminal_runtime",
    observedAt: snapshot.heartbeatObservedAt,
    expiresAt: snapshot.heartbeatExpiresAt,
    correlationId: snapshot.viewId,
  };
  return buildAppbarModel({
    now,
    machineLifecycle: [],
    // A terminal heartbeat proves attachment health, not the supervisor-owned
    // AgentSession lifecycle. Only independently supplied supervisor evidence
    // may populate the session projection.
    agentSessionLifecycle: intent?.agentSessionLifecycle === undefined
      ? []
      : [intent.agentSessionLifecycle],
    attachment: [{ ...evidence, value: snapshot.state === "active" ? "attached" : snapshot.state }],
    providerAuthentication: intent?.providerAuthentication === undefined
      ? []
      : [intent.providerAuthentication],
    workspaceSync: [],
  });
}

function advanceSequence(sequence: Uint8Array, byte: number, matched: number): number {
  if (byte === sequence[matched]) return matched + 1;
  return byte === sequence[0] ? 1 : 0;
}

function sameSnapshotBinding(snapshot: RuntimeTerminalSnapshot, binding: RuntimeTerminalResponse["binding"]): boolean {
  return snapshot.userId === binding.userId &&
    snapshot.machineId === binding.machineId &&
    snapshot.agentSessionId === binding.agentSessionId &&
    snapshot.processEpoch === binding.processEpoch &&
    snapshot.fencingGeneration === binding.fencingGeneration;
}

function padTrustedLine(value: string, columns: number): string {
  return value.slice(0, columns).padEnd(columns, " ");
}

async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Terminal output was cancelled.");
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Terminal output was cancelled."));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    timer.unref();
    const onAbort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
