import type {
  RuntimeTerminalResponse,
  RuntimeTerminalSnapshot,
} from "../runtime/boundary.js";
import type { TerminalFrame, TerminalLocalActionKind } from "./codec.js";
import type { BrowserOpener } from "../auth/browser.js";
import {
  admitProviderAuthUrl,
  ProviderBrowserActionDetector,
  ProviderOAuthPasteGuard,
  type LocalBrowserActionRequest,
} from "../local-actions/browser-action.js";
import {
  LOCAL_ACTION_PROTOCOL_VERSION,
  LocalActionBroker,
  digestLocalActionArguments,
  sameLocalActionIdentity,
  type LocalActionRequest,
  type LocalActionSessionIdentity,
  type LocalActionSnapshot,
} from "../local-actions/index.js";
import type { TerminalAttachmentAdmission } from "../runtime/terminal-transport.js";
import { RuntimeBoundaryError, runtimeFailure } from "../runtime/errors.js";
import type { HostTerminalLease } from "./mode.js";
import { assertCanonicalUuid } from "../core/validation.js";
import { buildAppbarModel, type AppbarModel, type StatusEvidence } from "./appbar.js";
import { renderWorkbenchFrame, type WorkbenchTab } from "./workbench.js";
import { ViewportRegistry } from "./viewport.js";
import { XtermViewportAdapter } from "./xterm-vte.js";

const ESCAPE_PREFIX = 0x1d;
const INTERRUPT = 0x03;
const FLOW_RESUME = 0x11;
const FLOW_PAUSE = 0x13;
const REMOTE_INTERRUPT = 0x63;
const REMOTE_FLOW_RESUME = 0x71;
const REMOTE_FLOW_PAUSE = 0x73;
const REMOTE_REDRAW = Uint8Array.of(0x0c);
const TAB_FIRST = 0x31;
const TAB_LAST = 0x34;
const NEXT_TAB = 0x6e;
const DETACH = 0x64;
const HELP = 0x3f;
const RETRY = 0x72;
const TAKE_WRITER = 0x77; // Ctrl+] w: take the terminal's one writing seat
const RESIZE_COALESCE_MS = 50;
const DISCONNECT_FRAME_MS = 30;
const DISCONNECTING_FRAMES = Object.freeze([
  "✦ Disconnecting...",
  "✧ Disconnecting...",
  "✦ Disconnecting...",
]);
const STARTUP_CLOSE_FRAMES = Object.freeze(["✦ Closing Cuna...", "✧ Closing Cuna...", "✓ Closed."]);
const ATTACHING_FRAMES = Object.freeze(["◐", "◓", "◑", "◒"]);
const ATTACHING_PROGRESS = Object.freeze(["━╺━━━━", "━━╺━━━", "━━━╺━━", "━━━━╺━", "━━━━━╺", "━━━━╸━", "━━━╸━━", "━━╸━━━"]);
const ATTACHING_FRAME_MS = 90;
// Three progress frames plus one confirmation frame: 120ms by default and
// never more than one second under an injected/test cadence.
const MAX_DISCONNECT_FRAME_MS = 250;
const INPUT_WITHHELD_NOTICE = "Reconnecting · input was not sent. Retry after terminal attached.";
const FLOW_CONTROL_NOTICE = "Terminal output kept active · Ctrl+] s sends Ctrl+S remotely.";
const RECONNECT_FAILED_NOTICE = "Reconnect failed · Ctrl+] r retries · Ctrl+C disconnects.";
const BRACKETED_PASTE_START = Uint8Array.of(0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e);
const BRACKETED_PASTE_END = Uint8Array.of(0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e);
const CLAUDE_LOCAL_ACTION_KINDS = Object.freeze(["browser.open"] as const);
const CODEX_LOCAL_ACTION_KINDS = Object.freeze(["browser.open", "auth.device.present"] as const);
const NO_LOCAL_ACTION_KINDS = Object.freeze([] as const);
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
  takeWriter(input: { readonly tabId: string; readonly signal?: AbortSignal }): Promise<RuntimeTerminalSnapshot>;
  sendInput(bytes: Uint8Array, tabId?: string, expectedBinding?: RuntimeTerminalResponse["binding"]): Promise<void>;
  resize(columns: number, rows: number, tabId?: string): Promise<void>;
  switchActive(tabId: string): RuntimeTerminalSnapshot;
  sendTerminalResponse(response: RuntimeTerminalResponse): Promise<void>;
  sendLocalActionControl(
    type: "local_action_result" | "local_stream_open" | "local_stream_data" | "local_stream_close" | "local_stream_window_update",
    payload: Readonly<Record<string, unknown>>,
    tabId?: string,
  ): Promise<void>;
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
  readonly workspaceBindingId?: string;
  readonly workspaceGeneration?: number;
  /** Only interactive provider login sessions may request a local browser. */
  readonly localBrowserActions?: boolean;
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

/** One AgentSession the person detached from; it keeps running remotely. */
export interface DetachedForegroundSession {
  readonly agentSessionId: string;
  readonly label: string;
}

/**
 * A completed local effect is retained until the remote MCP bridge confirms
 * the exact request digest.  Keeping the immutable broker snapshot—not just a
 * request id—means a reconnect can retransmit only a result fenced to the
 * same AgentSession process generation.
 */
interface PendingRemoteLocalActionResult {
  readonly tabId: string;
  readonly snapshot: LocalActionSnapshot;
}

export interface ForegroundTerminalCoordinatorOptions {
  readonly host: ForegroundTerminalHost;
  readonly browser?: BrowserOpener;
  readonly appbar?: () => AppbarModel;
  readonly color?: boolean;
  readonly clock?: () => number;
  readonly resizeCoalesceMs?: number;
  readonly reconnectAttempts?: number;
  readonly reconnectBaseDelayMs?: number;
  readonly disconnectFrameMs?: number;
  /** Stable only for this foreground process; never a reusable device credential. */
  readonly deviceId?: string;
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
  #seatNotice: string | undefined;
  readonly #stopStarted: Promise<void>;
  readonly #resolveStopStarted: () => void;
  readonly #lifetimeAbort = new AbortController();
  readonly #reconnectTasks = new Map<string, Promise<void>>();
  readonly #recoverableReconnectFailures = new Map<string, unknown>();
  readonly #outputTails = new Map<string, Promise<void>>();
  readonly #localDetachTabIds = new Set<string>();
  readonly #detachedSessions: DetachedForegroundSession[] = [];
  readonly #browserDetectors = new Map<string, ProviderBrowserActionDetector>();
  readonly #oauthPasteGuards = new Map<string, ProviderOAuthPasteGuard>();
  readonly #handledBrowserUrls = new Set<string>();
  readonly #browserRequests = new Map<string, LocalBrowserActionRequest>();
  readonly #remoteLocalActionTabs = new Map<string, string>();
  readonly #pendingRemoteLocalActionResults = new Map<string, PendingRemoteLocalActionResult>();
  readonly #remoteLocalActionResultSends = new Map<string, Promise<void>>();
  readonly #remoteLocalActionResultTasks = new Set<Promise<void>>();
  readonly #localActionBroker: LocalActionBroker;
  #removeAbort: (() => void) | undefined;
  #pendingInputBytes = 0;
  #helpVisible = false;
  #pendingBrowserAction: LocalBrowserActionRequest | undefined;
  #pendingBrowserActionTabId: string | undefined;
  #browserNotice: string | undefined;
  #browserOpening = false;
  #terminalFailure: unknown;
  #stateRenderRunning = false;
  #stateRenderDirty = false;
  #startupDetached = false;
  #closingTabId: string | undefined;
  #disconnectNotice: string | undefined;
  #attachingAnimationTimer: NodeJS.Timeout | undefined;
  #attachingFrame = 0;

  constructor(options: ForegroundTerminalCoordinatorOptions) {
    const resizeCoalesceMs = options.resizeCoalesceMs ?? RESIZE_COALESCE_MS;
    if (!Number.isSafeInteger(resizeCoalesceMs) || resizeCoalesceMs < 1 || resizeCoalesceMs > 1_000) {
      throw new RangeError("Foreground resize coalescing must be between 1 and 1000 milliseconds.");
    }
    const reconnectAttempts = options.reconnectAttempts ?? 3;
    const reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 100;
    const disconnectFrameMs = options.disconnectFrameMs ?? DISCONNECT_FRAME_MS;
    if (!Number.isSafeInteger(reconnectAttempts) || reconnectAttempts < 1 || reconnectAttempts > 10) {
      throw new RangeError("Foreground reconnect attempts must be between 1 and 10.");
    }
    if (!Number.isSafeInteger(reconnectBaseDelayMs) || reconnectBaseDelayMs < 1 || reconnectBaseDelayMs > 5_000) {
      throw new RangeError("Foreground reconnect delay must be between 1 and 5000 milliseconds.");
    }
    if (!Number.isSafeInteger(disconnectFrameMs) || disconnectFrameMs < 1 || disconnectFrameMs > MAX_DISCONNECT_FRAME_MS) {
      throw new RangeError("Foreground disconnect frame duration must be between 1 and 250 milliseconds.");
    }
    this.#options = Object.freeze({ ...options, resizeCoalesceMs, reconnectAttempts, reconnectBaseDelayMs, disconnectFrameMs });
    this.#clock = options.clock ?? Date.now;
    this.#localActionBroker = new LocalActionBroker({
      clock: this.#clock,
      isIdentityLive: (identity) => this.#isLocalActionIdentityLive(identity),
      onChange: (snapshot) => {
        if (["succeeded", "failed", "denied", "expired", "cancelled"].includes(snapshot.state)) {
          this.#browserRequests.delete(snapshot.request.id);
          this.#queueRemoteLocalActionResult(snapshot);
        }
        void this.#render().catch(() => undefined);
      },
    });
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

  /**
   * AgentSessions the person detached from on purpose (Ctrl+] d or Ctrl+C),
   * each confirmed by the runtime. A detach never terminates the remote
   * process, so the runner tells the person how to come back once the host
   * terminal is theirs again. Tabs detached by cleanup are not listed.
   */
  get detachedSessions(): readonly DetachedForegroundSession[] {
    return Object.freeze([...this.#detachedSessions]);
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
    readonly localActionKinds: (agentSessionId: string) => readonly TerminalLocalActionKind[];
    readonly onLocalActionFrame: (event: {
      readonly tabId: string;
      readonly frame: TerminalFrame;
      readonly payload: Readonly<Record<string, unknown>>;
    }) => Promise<void>;
  } {
    return Object.freeze({
      onTerminalReady: async (snapshot) => await this.#terminalReady(snapshot),
      onTerminalOutput: async (event) => await this.#queueTerminalOutput(event),
      onTerminalState: (snapshot) => this.#terminalState(snapshot),
      localActionKinds: (agentSessionId) => this.#localActionKindsForSession(agentSessionId),
      onLocalActionFrame: async (event) => await this.#localActionFrame(event),
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
      this.#startAttachingAnimation(intents.length);
      const attachSignal = signal === undefined
        ? this.#lifetimeAbort.signal
        : AbortSignal.any([signal, this.#lifetimeAbort.signal]);
      for (const intent of intents) {
        if (attachSignal.aborted) throw runtimeFailure("terminal_disconnected", "Foreground terminal startup was cancelled.");
        this.#startAttachingAnimation(intents.length);
        const attachDimensions = admitForegroundDimensions(this.#options.host.dimensions());
        const snapshot = await runtime.attach({
          tabId: intent.tabId,
          agentSessionId: intent.agentSessionId,
          columns: attachDimensions.columns,
          rows: remoteRows(attachDimensions.rows),
          ...(intent.attachmentAdmission === undefined
            ? {}
            : { expectedAdmission: intent.attachmentAdmission }),
          signal: attachSignal,
        });
        if (this.#startupDetached || this.#state !== "starting") {
          await runtime.detach(snapshot.tabId);
          return;
        }
        const tab = this.#tabs.get(intent.tabId);
        if (tab === undefined) {
          throw runtimeFailure("terminal_protocol_error", "The terminal became active before its fenced viewport was installed.");
        }
        tab.snapshot = snapshot;
        this.#activeTabId ??= intent.tabId;
        await this.#reconcileGeometry(snapshot, true);
        await this.#render();
      }
      this.#stopAttachingAnimation();
      this.#state = "active";
      await this.#render();
    } catch (error) {
      const startupDetached = this.#startupDetached;
      if (!startupDetached) this.#state = "failed";
      try {
        await this.stop();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Foreground terminal startup and cleanup both failed.");
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
    this.#stopAttachingAnimation();
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
    for (const tab of this.#tabs.values()) {
      this.#localActionBroker.cancelBinding(this.#localActionIdentity(tab.intent, tab.snapshot), "foreground_stopped");
    }
    try { await Promise.all(this.#remoteLocalActionResultTasks); } catch (error) { failures.push(error); }
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
    this.#browserDetectors.clear();
    this.#oauthPasteGuards.clear();
    this.#browserRequests.clear();
    this.#remoteLocalActionTabs.clear();
    this.#pendingRemoteLocalActionResults.clear();
    this.#remoteLocalActionResultSends.clear();
    this.#remoteLocalActionResultTasks.clear();
    this.#pendingBrowserAction = undefined;
    this.#pendingBrowserActionTabId = undefined;
    this.#browserNotice = undefined;
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
    // `onTerminalReady` is the precise boundary at which remote bytes may be
    // rendered. Stop the local timer first, then drain its last queued paint;
    // this guarantees the loading chrome never races or interleaves with PTY
    // output.
    this.#stopAttachingAnimation();
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
    if (previous !== undefined) this.#forgetSeatNoticeOnSeatChange(previous.snapshot, snapshot);
    const dimensions = admitForegroundDimensions(this.#options.host.dimensions());
    if (
      intent.localBrowserActions === true &&
      // OpenCode owns `/connect` inside its remote TUI. PTY text is display
      // only, never authority to open a local browser; only the currently
      // supported Claude/Codex flows may request that foreground action.
      (intent.agent === "claude-code" || intent.agent === "codex")
    ) {
      this.#browserDetectors.set(snapshot.tabId, new ProviderBrowserActionDetector({
        provider: intent.agent,
        agentSessionId: snapshot.agentSessionId,
        processEpoch: snapshot.processEpoch,
        fencingGeneration: snapshot.fencingGeneration,
        clock: this.#clock,
      }));
    } else {
      this.#browserDetectors.delete(snapshot.tabId);
    }
    this.#localActionBroker.cancelStaleForIdentity(this.#localActionIdentity(intent, snapshot));
    // A replacement process or fencing generation is a hard authority
    // boundary. Results from the previous binding must never be replayed into
    // the new terminal, even if their old socket later becomes writable.
    this.#fenceRemoteLocalActionResults(snapshot.tabId, this.#localActionIdentity(intent, snapshot));
    if (
      this.#pendingBrowserActionTabId === snapshot.tabId &&
      this.#pendingBrowserAction?.fencingGeneration !== snapshot.fencingGeneration
    ) {
      this.#pendingBrowserAction = undefined;
      this.#pendingBrowserActionTabId = undefined;
      this.#browserNotice = "Browser request expired after the terminal changed.";
    }
    const guardedRequest = this.#pendingBrowserActionTabId === snapshot.tabId
      ? this.#pendingBrowserAction
      : undefined;
    if (guardedRequest?.fencingGeneration !== snapshot.fencingGeneration) {
      this.#oauthPasteGuards.delete(snapshot.tabId);
    }
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
    // A reconnect for the same binding may have dropped the outcome after the
    // local side effect completed. The server ACK is the only condition that
    // clears the cache, so resubmit it once this exact attachment is ready.
    this.#resendPendingRemoteLocalActionResults(snapshot.tabId, this.#localActionIdentity(intent, snapshot));
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
    const detected = this.#browserDetectors.get(event.tabId)?.push(event.bytes) ?? [];
    for (const request of detected) this.#enqueueBrowserAction(event.tabId, tab, request);
    this.#promoteBrowserAction();
    await raceAbort(tab.viewport.write(event.bytes, event.sequence, event.sequence), event.signal);
    const current = this.#tabs.get(event.tabId);
    if (event.signal.aborted || current !== tab || !sameSnapshotBinding(tab.snapshot, event.binding)) return;
    await this.#render();
  }

  #terminalState(snapshot: RuntimeTerminalSnapshot): void {
    const tab = this.#tabs.get(snapshot.tabId);
    if (tab !== undefined) {
      this.#forgetSeatNoticeOnSeatChange(tab.snapshot, snapshot);
      tab.snapshot = snapshot;
      if (
        snapshot.state === "active" &&
        (this.#browserNotice === INPUT_WITHHELD_NOTICE || this.#browserNotice === RECONNECT_FAILED_NOTICE)
      ) {
        this.#browserNotice = undefined;
      }
      if (
        this.#localDetachTabIds.has(snapshot.tabId) &&
        (snapshot.state === "failed" || snapshot.state === "interrupted" || snapshot.state === "closed" || snapshot.state === "detached")
      ) {
        // A local detach may close the wire before the runtime publishes its
        // final state. #detachTab owns its success/failure decision and closing
        // frame, so callbacks cannot restore the host ahead of that sequence.
        return;
      }
      if (snapshot.state === "failed" || snapshot.state === "closed" || snapshot.state === "detached") {
        if (snapshot.state === "failed") {
          this.#recordFailure(runtimeFailure("terminal_disconnected", "A foreground AgentSession terminal failed."));
        }
        this.#localActionBroker.cancelBinding(this.#localActionIdentity(tab.intent, tab.snapshot), "terminal_detached");
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
        const snapshot = await this.#requireRuntime().reconnect({ tabId, signal: this.#lifetimeAbort.signal });
        await this.#reconcileGeometry(snapshot, false);
        this.#recoverableReconnectFailures.delete(tabId);
        if (this.#browserNotice === INPUT_WITHHELD_NOTICE || this.#browserNotice === RECONNECT_FAILED_NOTICE) {
          this.#browserNotice = undefined;
        }
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
      this.#browserNotice = RECONNECT_FAILED_NOTICE;
      await this.#render();
    }
  }

  #queueInput(bytes: Uint8Array): void {
    if (bytes.byteLength < 1) return;
    if (this.#state === "starting" && bytes.includes(INTERRUPT)) {
      if (this.#startupDetached) return;
      this.#startupDetached = true;
      this.#stopAttachingAnimation();
      // There is no foreground viewport until the first attach completes, so
      // the normal workbench close renderer has nothing to paint here. Queue a
      // short, host-owned close acknowledgement before restoration instead.
      // This keeps Ctrl-C single-press and visible even while authority is
      // still being checked.
      this.#queueStartupCloseFeedback();
      void this.stop().catch(() => { this.#state = "failed"; });
      return;
    }
    if (this.#closingTabId !== undefined) return;
    if (bytes.byteLength > MAX_FOREGROUND_PENDING_INPUT_BYTES || this.#pendingInputBytes + bytes.byteLength > MAX_FOREGROUND_PENDING_INPUT_BYTES) {
      this.#recordFailure(runtimeFailure("terminal_protocol_error", "Foreground terminal input exceeded its bounded queue."));
      void this.stop().catch(() => { this.#state = "failed"; });
      return;
    }
    const payload = bytes.slice();
    const receiptTarget = this.#captureInputTarget();
    if (
      this.#state === "active" &&
      receiptTarget === undefined &&
      !(payload.byteLength === 1 && payload[0] === INTERRUPT) &&
      !this.#prefixPending &&
      payload[0] !== ESCAPE_PREFIX
    ) {
      if (this.#pendingBrowserActionTabId === this.#activeTabId) {
        this.#pendingBrowserAction = undefined;
        this.#pendingBrowserActionTabId = undefined;
      }
      this.#browserNotice = INPUT_WITHHELD_NOTICE;
      void this.#render().catch(() => undefined);
      return;
    }
    if (
      payload.byteLength === 1 &&
      payload[0] === INTERRUPT &&
      !this.#prefixPending &&
      receiptTarget !== undefined
    ) {
      // Record local detach at receipt time. Input is serialized, so the
      // transport may publish interrupted before #detachTab runs.
      this.#localDetachTabIds.add(receiptTarget.tabId);
      this.#pasteActive = false;
      this.#pasteStartMatch = 0;
      this.#pasteEndMatch = 0;
      this.#closingTabId = receiptTarget.tabId;
      this.#disconnectNotice = DISCONNECTING_FRAMES[0];
      // Feedback is receipt-time, not input-tail-time. A prior admitted remote
      // write may still be draining, but Ctrl-C must visibly acknowledge that
      // the local close intent was accepted.
      void this.#render().catch(() => undefined);
    }
    this.#pendingInputBytes += payload.byteLength;
    const operation = this.#inputTail.then(async () => {
      try { await this.#routeInput(payload, receiptTarget); } finally { this.#pendingInputBytes -= payload.byteLength; }
    });
    this.#inputTail = operation.catch((error) => {
      if (error instanceof RuntimeBoundaryError && error.code === "terminal_observer") {
        // Typing into an observed terminal is refused, not fatal: the seat is
        // someone else's. Say so on the notice line and keep observing.
        this.#seatNotice = error.message;
        void this.#render().catch(() => undefined);
        return;
      }
      if (error instanceof RuntimeBoundaryError && (error.code === "terminal_disconnected" || error.code === "session_unknown")) {
        if (this.#pendingBrowserActionTabId === this.#activeTabId) {
          this.#pendingBrowserAction = undefined;
          this.#pendingBrowserActionTabId = undefined;
        }
        this.#browserNotice = INPUT_WITHHELD_NOTICE;
        void this.#render().catch(() => undefined);
        return;
      }
      this.#recordFailure(error);
      void this.stop().catch(() => { this.#state = "failed"; });
    });
  }

  async #routeInput(bytes: Uint8Array, receiptTarget: ForegroundInputTarget | undefined): Promise<void> {
    const runtime = this.#requireRuntime();
    if (bytes.includes(INTERRUPT)) {
      const active = this.#pendingBrowserAction === undefined
        ? undefined
        : this.#localActionBroker.get(this.#pendingBrowserAction.id);
      if (active !== undefined) this.#localActionBroker.cancelBinding(active.request.identity, "user_interrupt");
      this.#pendingBrowserAction = undefined;
      this.#pendingBrowserActionTabId = undefined;
      this.#browserNotice = undefined;
    } else if (await this.#routeBrowserActionInput(bytes, receiptTarget)) {
      return;
    }
    const guarded = this.#guardProviderOAuthPaste(bytes, receiptTarget);
    if (guarded.blocked) {
      this.#browserNotice = "That is the sign-in link, not the code. Approve access in the browser, then paste only the code shown on the final page.";
      await this.#render();
      return;
    }
    if (guarded.bytes.byteLength === 0) return;
    bytes = guarded.bytes;
    if (this.#browserNotice !== undefined) this.#browserNotice = undefined;
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
        if (byte === FLOW_PAUSE) {
          await flush();
          if (target === undefined) throw runtimeFailure("session_unknown", "No foreground terminal tab is active.");
          await runtime.sendInput(Uint8Array.of(FLOW_RESUME), target.tabId, target.binding);
          this.#browserNotice = FLOW_CONTROL_NOTICE;
          await this.#render();
        } else if (byte === INTERRUPT) {
          await flush();
          await this.#detachTab(target?.tabId);
          return;
        } else if (byte === ESCAPE_PREFIX) {
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
      } else if (byte === REMOTE_INTERRUPT) {
        target = chordTarget ?? target;
        remote.push(INTERRUPT);
      } else if (byte === REMOTE_FLOW_PAUSE) {
        target = chordTarget ?? target;
        remote.push(FLOW_PAUSE);
      } else if (byte === REMOTE_FLOW_RESUME) {
        target = chordTarget ?? target;
        remote.push(FLOW_RESUME);
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
      } else if (byte === TAKE_WRITER) {
        await flush();
        this.#takeWriterActiveTab();
      } else {
        this.#helpVisible = false;
        target = chordTarget ?? target;
        remote.push(ESCAPE_PREFIX, byte);
      }
    }
    await flush();
  }

  async #routeBrowserActionInput(bytes: Uint8Array, target: ForegroundInputTarget | undefined): Promise<boolean> {
    const request = this.#pendingBrowserAction;
    if (
      request === undefined ||
      target === undefined ||
      target.tabId !== this.#activeTabId ||
      target.tabId !== this.#pendingBrowserActionTabId
    ) return false;
    if (
      request.agentSessionId !== target.binding.agentSessionId ||
      request.processEpoch !== target.binding.processEpoch ||
      request.fencingGeneration !== target.binding.fencingGeneration
    ) {
      const tracked = this.#localActionBroker.get(request.id);
      if (tracked !== undefined) this.#localActionBroker.cancelBinding(tracked.request.identity);
      this.#pendingBrowserAction = undefined;
      this.#pendingBrowserActionTabId = undefined;
      this.#browserNotice = "Browser request expired after the terminal changed.";
      await this.#render();
      return true;
    }
    if (this.#clock() >= request.expiresAt) {
      this.#localActionBroker.expire();
      this.#pendingBrowserAction = undefined;
      this.#pendingBrowserActionTabId = undefined;
      this.#handledBrowserUrls.add(this.#browserRequestKey(request));
      this.#browserNotice = "Browser authentication request expired. Retry from the provider.";
      await this.#render();
      return true;
    }
    // Permission decisions are deliberately single-key only. A bracketed
    // paste, an opaque provider code beginning with "d", or any multi-byte
    // input is PTY data and must never be reinterpreted as a local decision.
    if (bytes.byteLength !== 1) return false;
    const decision = bytes[0];
    if (decision === 0x1b || decision === 0x64 || decision === 0x44) {
      this.#localActionBroker.decide(request.id, false);
      this.#pendingBrowserAction = undefined;
      this.#pendingBrowserActionTabId = undefined;
      this.#handledBrowserUrls.add(this.#browserRequestKey(request));
      this.#browserNotice = request.type === "auth.device.present"
        ? "Device sign-in denied. The provider page remains in the cloud terminal."
        : "Browser authentication denied. The provider URL remains in the terminal.";
      await this.#render();
      this.#promoteBrowserAction();
      return true;
    }
    if (decision !== 0x0d && decision !== 0x6f && decision !== 0x4f) {
      return false;
    }
    if (this.#browserOpening) return true;
    this.#browserOpening = true;
    // Remote MCP requests retain their exact mcp:<kind> scope. Passing the
    // local detector scope here would widen it and makes the broker reject a
    // valid, fenced request before the browser can open.
    this.#localActionBroker.decide(request.id, true);
    this.#browserNotice = `Opening ${new URL(request.url).hostname} in your local browser...`;
    await this.#render();
    void this.#openBrowser(request).catch(() => undefined);
    return true;
  }

  async #openBrowser(request: LocalBrowserActionRequest): Promise<void> {
    try {
      const browser = this.#options.browser;
      if (browser === undefined) throw new Error("browser unavailable");
      await browser.open(request.url);
      const tracked = this.#localActionBroker.get(request.id);
      if (tracked?.state !== "executing") return;
      this.#pendingBrowserAction = undefined;
      this.#pendingBrowserActionTabId = undefined;
      this.#handledBrowserUrls.add(this.#browserRequestKey(request));
      if (request.type === "auth.device.present") {
        // This confirms only local presentation. The remote provider owns its
        // device-code polling and Cuna must not claim that it is signed in.
        this.#localActionBroker.complete(
          request.id,
          tracked.request.identity,
          "succeeded",
          Object.freeze({ awaitingProvider: true }),
        );
        this.#browserNotice = `${providerName(request.provider)} sign-in opened · complete it there · waiting for confirmation…`;
      } else {
        this.#localActionBroker.awaitingRemoteCompletion(request.id);
        for (const [tabId, tab] of this.#tabs) {
          if (tab.snapshot.agentSessionId === request.agentSessionId &&
            tab.snapshot.processEpoch === request.processEpoch &&
            tab.snapshot.fencingGeneration === request.fencingGeneration) {
            this.#oauthPasteGuards.get(tabId)?.beginCodeCapture();
          }
        }
        this.#browserNotice = "Browser opened locally. Complete authentication there, then return here.";
      }
    } catch {
      const tracked = this.#localActionBroker.get(request.id);
      if (tracked !== undefined) {
        this.#localActionBroker.complete(request.id, tracked.request.identity, "failed", undefined, "browser_open_failed");
      }
      this.#pendingBrowserAction = undefined;
      this.#pendingBrowserActionTabId = undefined;
      this.#handledBrowserUrls.add(this.#browserRequestKey(request));
      this.#browserNotice = "Could not open the local browser. Use the provider URL shown below.";
    } finally {
      this.#browserOpening = false;
    }
    await this.#render();
    this.#promoteBrowserAction();
  }

  #enqueueBrowserAction(tabId: string, tab: ForegroundTab, request: LocalBrowserActionRequest): void {
    if (request.fencingGeneration !== tab.snapshot.fencingGeneration || this.#handledBrowserUrls.has(this.#browserRequestKey(request))) return;
    const action: LocalActionRequest = request.type === "browser.open"
      ? Object.freeze({
        version: LOCAL_ACTION_PROTOCOL_VERSION,
        id: request.id,
        identity: this.#localActionIdentity(tab.intent, tab.snapshot),
        provider: request.provider,
        kind: "browser.open",
        arguments: Object.freeze({ url: request.url }),
        argumentsDigest: digestLocalActionArguments({ url: request.url }),
        requestedScope: "provider-auth",
        createdAt: request.detectedAt,
        expiresAt: request.expiresAt,
        nonce: request.nonce,
      })
      : Object.freeze({
        version: LOCAL_ACTION_PROTOCOL_VERSION,
        id: request.id,
        identity: this.#localActionIdentity(tab.intent, tab.snapshot),
        provider: "codex",
        kind: "auth.device.present",
        arguments: Object.freeze({ verificationUri: request.url, userCode: request.userCode }),
        argumentsDigest: digestLocalActionArguments({ verificationUri: request.url, userCode: request.userCode }),
        requestedScope: "provider-auth",
        createdAt: request.detectedAt,
        expiresAt: request.expiresAt,
        nonce: request.nonce,
      });
    try {
      this.#localActionBroker.submit(action);
    } catch {
      return;
    }
    this.#browserRequests.set(request.id, request);
    if (request.type === "browser.open") {
      this.#oauthPasteGuards.set(tabId, new ProviderOAuthPasteGuard(request));
    }
  }

  async #localActionFrame(event: {
    readonly tabId: string;
    readonly frame: TerminalFrame;
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    if (event.frame.type === "local_action_result") {
      this.#acknowledgeRemoteLocalActionResult(event.tabId, event.payload);
      return;
    }
    if (event.frame.type !== "local_action_request") return;
    const raw = event.payload.request;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw runtimeFailure("terminal_protocol_error", "The local action request payload is malformed.");
    }
    const request = raw as LocalActionRequest;
    const tab = this.#tabs.get(event.tabId);
    if (tab === undefined) throw runtimeFailure("terminal_disconnected", "The local action targets an unavailable tab.");
    let browserRequest: LocalBrowserActionRequest;
    if (request.kind === "browser.open") {
      const url = request.arguments.url;
      if (
        (request.provider !== "claude-code" && request.provider !== "codex") ||
        typeof url !== "string"
      ) {
        throw runtimeFailure("capability_unsupported", "This browser action was not negotiated by the foreground.");
      }
      const admitted = admitProviderAuthUrl(request.provider, url);
      if (admitted === undefined) {
        throw runtimeFailure("terminal_protocol_error", "The browser action URL is outside Cuna's provider descriptor.");
      }
      browserRequest = Object.freeze({
        id: request.id,
        type: "browser.open",
        provider: request.provider,
        agentSessionId: request.identity.agentSessionId,
        processEpoch: request.identity.processEpoch,
        fencingGeneration: request.identity.fencingGeneration,
        url: admitted.href,
        origin: admitted.origin,
        nonce: request.nonce,
        detectedAt: request.createdAt,
        expiresAt: request.expiresAt,
        state: "pending_permission",
      });
    } else if (request.kind === "auth.device.present" && request.provider === "codex") {
      const verificationUri = request.arguments.verificationUri;
      const userCode = request.arguments.userCode;
      if (typeof verificationUri !== "string" || typeof userCode !== "string") {
        throw runtimeFailure("terminal_protocol_error", "The Codex device request is malformed.");
      }
      const admitted = admitProviderAuthUrl("codex", verificationUri);
      if (admitted === undefined) {
        throw runtimeFailure("terminal_protocol_error", "The Codex device URI is outside Cuna's provider descriptor.");
      }
      browserRequest = Object.freeze({
        id: request.id,
        type: "auth.device.present",
        provider: "codex",
        agentSessionId: request.identity.agentSessionId,
        processEpoch: request.identity.processEpoch,
        fencingGeneration: request.identity.fencingGeneration,
        url: admitted.href,
        origin: admitted.origin,
        userCode,
        nonce: request.nonce,
        detectedAt: request.createdAt,
        expiresAt: request.expiresAt,
        state: "pending_permission",
      });
    } else {
      throw runtimeFailure("capability_unsupported", "This local action kind was not negotiated by the foreground.");
    }
    this.#remoteLocalActionTabs.set(request.id, event.tabId);
    this.#browserRequests.set(request.id, browserRequest);
    let admitted: LocalActionSnapshot;
    try {
      admitted = this.#localActionBroker.submit(request);
    } catch (error) {
      this.#remoteLocalActionTabs.delete(request.id);
      this.#browserRequests.delete(request.id);
      throw error;
    }
    if (["succeeded", "failed", "denied", "expired", "cancelled"].includes(admitted.state)) {
      // The bridge may replay a completed request after a transport break.
      // Reuse its immutable result and wait for the exact ACK rather than
      // executing the local side effect a second time.
      this.#queueRemoteLocalActionResult(admitted);
      return;
    }
    if (browserRequest.type === "browser.open") {
      this.#oauthPasteGuards.set(event.tabId, new ProviderOAuthPasteGuard(browserRequest));
    }
    this.#promoteBrowserAction();
    await this.#render();
  }

  #acknowledgeRemoteLocalActionResult(tabId: string, payload: Readonly<Record<string, unknown>>): void {
    if (
      payload.message !== "ack" ||
      typeof payload.requestId !== "string" ||
      typeof payload.argumentDigest !== "string"
    ) {
      throw runtimeFailure("terminal_protocol_error", "The local action acknowledgement is malformed.");
    }
    const pending = this.#pendingRemoteLocalActionResults.get(payload.requestId);
    // ACKs are idempotent. An old result, a result from another foreground
    // process, or a request with a different canonical argument digest cannot
    // discharge this foreground's cached outcome.
    if (
      pending === undefined ||
      pending.tabId !== tabId ||
      pending.snapshot.request.argumentsDigest !== payload.argumentDigest
    ) return;
    const tab = this.#tabs.get(tabId);
    if (
      tab === undefined ||
      !sameLocalActionIdentity(
        pending.snapshot.request.identity,
        this.#localActionIdentity(tab.intent, tab.snapshot),
      )
    ) return;
    this.#pendingRemoteLocalActionResults.delete(payload.requestId);
    if (this.#remoteLocalActionTabs.get(payload.requestId) === tabId) {
      this.#remoteLocalActionTabs.delete(payload.requestId);
    }
  }

  async #sendRemoteLocalActionResult(snapshot: LocalActionSnapshot): Promise<void> {
    const tabId = this.#remoteLocalActionTabs.get(snapshot.request.id);
    if (tabId === undefined || snapshot.result === undefined) return;
    const existing = this.#pendingRemoteLocalActionResults.get(snapshot.request.id);
    if (existing === undefined) {
      this.#pendingRemoteLocalActionResults.set(snapshot.request.id, Object.freeze({ tabId, snapshot }));
    } else if (
      existing.tabId !== tabId ||
      existing.snapshot.request.argumentsDigest !== snapshot.request.argumentsDigest ||
      !sameLocalActionIdentity(existing.snapshot.request.identity, snapshot.request.identity)
    ) {
      // Request ids are single-use within the broker. A different binding or
      // digest is a replay collision and must never replace the result already
      // waiting for its matching acknowledgement.
      return;
    }
    await this.#sendPendingRemoteLocalActionResult(snapshot.request.id);
  }

  async #sendPendingRemoteLocalActionResult(requestId: string): Promise<void> {
    const pending = this.#pendingRemoteLocalActionResults.get(requestId);
    if (pending === undefined || pending.snapshot.result === undefined) return;
    const tab = this.#tabs.get(pending.tabId);
    if (
      tab === undefined ||
      !sameLocalActionIdentity(
        pending.snapshot.request.identity,
        this.#localActionIdentity(tab.intent, tab.snapshot),
      )
    ) return;
    const runtime = this.#runtime;
    if (runtime === undefined) return;
    await runtime.sendLocalActionControl("local_action_result", Object.freeze({
      message: "outcome",
      requestId,
      argumentDigest: pending.snapshot.request.argumentsDigest,
      result: pending.snapshot.result,
    }), pending.tabId);
  }

  #queueRemoteLocalActionResult(snapshot: LocalActionSnapshot): void {
    const requestId = snapshot.request.id;
    if (this.#remoteLocalActionResultSends.has(requestId)) return;
    const task = this.#sendRemoteLocalActionResult(snapshot);
    this.#remoteLocalActionResultSends.set(requestId, task);
    this.#remoteLocalActionResultTasks.add(task);
    void task.catch((error: unknown) => {
      if (this.#state !== "stopping" && this.#state !== "stopped") this.#recordFailure(error);
    }).finally(() => {
      this.#remoteLocalActionResultTasks.delete(task);
      if (this.#remoteLocalActionResultSends.get(requestId) === task) {
        this.#remoteLocalActionResultSends.delete(requestId);
      }
    });
  }

  #resendPendingRemoteLocalActionResults(tabId: string, identity: LocalActionSessionIdentity): void {
    for (const pending of this.#pendingRemoteLocalActionResults.values()) {
      if (pending.tabId !== tabId || !sameLocalActionIdentity(pending.snapshot.request.identity, identity)) continue;
      this.#queueRemoteLocalActionResult(pending.snapshot);
    }
  }

  #fenceRemoteLocalActionResults(tabId: string, identity: LocalActionSessionIdentity): void {
    for (const [requestId, pending] of this.#pendingRemoteLocalActionResults) {
      if (pending.tabId === tabId && !sameLocalActionIdentity(pending.snapshot.request.identity, identity)) {
        this.#pendingRemoteLocalActionResults.delete(requestId);
        if (this.#remoteLocalActionTabs.get(requestId) === tabId) this.#remoteLocalActionTabs.delete(requestId);
      }
    }
  }

  #promoteBrowserAction(): void {
    const current = this.#localActionBroker.current();
    if (current?.state !== "pending_user") {
      this.#pendingBrowserAction = undefined;
      this.#pendingBrowserActionTabId = undefined;
      return;
    }
    const request = this.#browserRequests.get(current.request.id);
    if (request === undefined) return;
    this.#pendingBrowserAction = request;
    this.#pendingBrowserActionTabId = [...this.#tabs.entries()].find(([, tab]) =>
      tab.snapshot.agentSessionId === request.agentSessionId &&
      tab.snapshot.processEpoch === request.processEpoch &&
      tab.snapshot.fencingGeneration === request.fencingGeneration)?.[0];
    this.#browserNotice = undefined;
  }

  #localActionIdentity(_intent: ForegroundTabIntent, snapshot: RuntimeTerminalSnapshot): LocalActionSessionIdentity {
    return Object.freeze({
      userId: snapshot.userId,
      deviceId: this.#options.deviceId ?? "cli-foreground",
      machineId: snapshot.machineId,
      workspaceBindingId: snapshot.workspaceBindingId ?? null,
      workspaceBindingGeneration: snapshot.workspaceBindingGeneration ?? null,
      agentSessionId: snapshot.agentSessionId,
      processEpoch: snapshot.processEpoch,
      fencingGeneration: snapshot.fencingGeneration,
    });
  }

  #isLocalActionIdentityLive(identity: LocalActionSessionIdentity): boolean {
    for (const tab of this.#tabs.values()) {
      if (sameLocalActionIdentity(identity, this.#localActionIdentity(tab.intent, tab.snapshot))) return true;
    }
    return false;
  }

  #browserRequestKey(request: LocalBrowserActionRequest): string {
    return `${request.agentSessionId}:${request.processEpoch}:${request.fencingGeneration}:${request.type}:${request.url}`;
  }

  #guardProviderOAuthPaste(
    bytes: Uint8Array,
    target: ForegroundInputTarget | undefined,
  ): { readonly bytes: Uint8Array; readonly blocked: boolean } {
    if (target === undefined || target.tabId !== this.#activeTabId) {
      return { bytes, blocked: false };
    }
    const guard = this.#oauthPasteGuards.get(target.tabId);
    if (guard === undefined) return { bytes, blocked: false };
    const result = guard.push(bytes);
    if (result.forward.length === 1) return { bytes: result.forward[0]!, blocked: result.blocked };
    if (result.forward.length === 0) return { bytes: new Uint8Array(), blocked: result.blocked };
    const length = result.forward.reduce((total, chunk) => total + chunk.byteLength, 0);
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of result.forward) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes: joined, blocked: result.blocked };
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
    this.#localDetachTabIds.add(tabId);
    const animate = this.#closingTabId === tabId;
    const departing = this.#tabs.get(tabId);
    if (departing !== undefined) {
      this.#localActionBroker.cancelBinding(this.#localActionIdentity(departing.intent, departing.snapshot), "terminal_detached");
      await Promise.allSettled(this.#remoteLocalActionResultTasks);
    }
    const detachOutcome = this.#requireRuntime().detach(tabId).then(
      () => Object.freeze({ ok: true as const }),
      (error: unknown) => Object.freeze({ ok: false as const, error }),
    );
    if (animate) await this.#animateDisconnecting();
    const outcome = await detachOutcome;
    if (!outcome.ok) {
      this.#disconnectNotice = undefined;
      this.#closingTabId = undefined;
      this.#localDetachTabIds.delete(tabId);
      this.#recordFailure(outcome.error);
      const remaining = this.#tabs.get(tabId);
      if (remaining?.snapshot.state === "failed" || remaining?.snapshot.state === "interrupted") {
        this.#terminalState(remaining.snapshot);
      }
      // Cleanup is deliberately asynchronous because it drains this input
      // operation before restoring the host. The recorded detach error remains
      // observable to the foreground runner after cleanup.
      void this.stop().catch(() => { this.#state = "failed"; });
      throw outcome.error;
    }
    // Recorded only once the runtime confirmed the detach: a failed detach
    // above must never be announced as a session that keeps running.
    if (departing !== undefined) {
      this.#detachedSessions.push(Object.freeze({
        agentSessionId: departing.intent.agentSessionId,
        label: departing.intent.label,
      }));
    }
    try {
      if (animate && this.#tabs.size === 1) {
        this.#disconnectNotice = "✓ Disconnected.";
        await this.#renderDisconnectNotice();
        await abortableDelay(this.#options.disconnectFrameMs ?? DISCONNECT_FRAME_MS, this.#lifetimeAbort.signal);
      }
    } finally {
      this.#disconnectNotice = undefined;
      this.#closingTabId = undefined;
    }
    this.#localDetachTabIds.delete(tabId);
    this.#browserDetectors.delete(tabId);
    if (this.#pendingBrowserActionTabId === tabId) {
      this.#pendingBrowserAction = undefined;
      this.#pendingBrowserActionTabId = undefined;
      this.#browserNotice = undefined;
    }
    this.#oauthPasteGuards.delete(tabId);

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

  async #animateDisconnecting(): Promise<void> {
    for (const notice of DISCONNECTING_FRAMES) {
      this.#disconnectNotice = notice;
      await this.#renderDisconnectNotice();
      await abortableDelay(this.#options.disconnectFrameMs ?? DISCONNECT_FRAME_MS, this.#lifetimeAbort.signal);
    }
  }

  async #renderDisconnectNotice(): Promise<void> {
    // Closing feedback is best-effort decoration. A host paint failure must not
    // turn a confirmed remote detach into a failed detach or mask its result.
    try { await this.#render(); } catch { /* restore still owns terminal cleanup */ }
  }

  #captureInputTarget(): ForegroundInputTarget | undefined {
    const tabId = this.#activeTabId;
    if (tabId === undefined) return undefined;
    const tab = this.#tabs.get(tabId);
    if (tab === undefined || tab.snapshot.state !== "active") return undefined;
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
      // An observer renders at the writer's dimensions; it never resizes the
      // PTY. The gateway would close its attachment on the first RESIZE.
      if (
        tab.snapshot.resizeCapability === "live" &&
        tab.snapshot.state === "active" &&
        tab.snapshot.accessMode !== "observer"
      ) {
        await this.#requireRuntime().resize(dimensions.columns, rows, tabId);
      }
    }
    await this.#render();
  }

  async #reconcileGeometry(
    snapshot: RuntimeTerminalSnapshot,
    repaintAfterReplay: boolean,
  ): Promise<void> {
    const tab = this.#tabs.get(snapshot.tabId);
    if (
      tab === undefined ||
      snapshot.state !== "active" ||
      snapshot.resizeCapability !== "live" ||
      // An observer neither resizes the PTY nor asks it to repaint: both are
      // writer actions the gateway closes an observer's attachment for.
      snapshot.accessMode === "observer" ||
      tab.snapshot.accessMode === "observer" ||
      tab.snapshot.state !== "active" ||
      tab.snapshot.resizeCapability !== "live" ||
      !sameSnapshotBinding(tab.snapshot, snapshot)
    ) return;

    // Host geometry can change while attach or reconnect is awaiting remote
    // readiness. Re-read it only after the fenced viewport exists, then bring
    // the local VTE and the exact live remote binding to the same dimensions.
    const dimensions = admitForegroundDimensions(this.#options.host.dimensions());
    const rows = remoteRows(dimensions.rows);
    await tab.viewport.resize(dimensions.columns, rows);
    const current = this.#tabs.get(snapshot.tabId);
    if (
      current !== tab ||
      current.snapshot.state !== "active" ||
      current.snapshot.resizeCapability !== "live" ||
      !sameSnapshotBinding(current.snapshot, snapshot)
    ) return;

    const runtime = this.#requireRuntime();
    if (repaintAfterReplay) {
      // A fullscreen provider may have painted before initial attach, so
      // replay can contain only later cursor-relative deltas. Trigger SIGWINCH
      // with a bounded row bounce, then restore the exact isolated viewport.
      // Keeping columns stable avoids introducing a temporary wrap topology.
      const bounceRows = rows === 1 ? 2 : rows - 1;
      await runtime.resize(dimensions.columns, bounceRows, snapshot.tabId);
      const afterBounce = this.#tabs.get(snapshot.tabId);
      if (
        afterBounce !== tab ||
        afterBounce.snapshot.state !== "active" ||
        !sameSnapshotBinding(afterBounce.snapshot, snapshot)
      ) return;
    }
    await runtime.resize(dimensions.columns, rows, snapshot.tabId);
    if (repaintAfterReplay) {
      const afterResize = this.#tabs.get(snapshot.tabId);
      if (
        afterResize !== tab ||
        afterResize.snapshot.state !== "active" ||
        !sameSnapshotBinding(afterResize.snapshot, snapshot)
      ) return;
      // Claude Code and Codex do not always repaint an already-running TUI from
      // SIGWINCH alone. Ctrl+L is their standard terminal redraw request; send
      // it once after initial replay, never on routine resize or reconnect.
      await runtime.sendInput(REMOTE_REDRAW, snapshot.tabId, Object.freeze({
        userId: snapshot.userId,
        machineId: snapshot.machineId,
        agentSessionId: snapshot.agentSessionId,
        processEpoch: snapshot.processEpoch,
        fencingGeneration: snapshot.fencingGeneration,
      }));
    }
  }

  async #render(): Promise<void> {
    const operation = this.#renderTail.then(async () => {
      const activeTabId = this.#activeTabId;
      if (activeTabId === undefined || this.#tabs.size === 0) return;
      const dimensions = admitForegroundDimensions(this.#options.host.dimensions());
      const activeViewport = this.#tabs.get(activeTabId)?.viewport.snapshot();
      if (
        activeViewport === undefined ||
        activeViewport.columns !== dimensions.columns ||
        activeViewport.rows !== remoteRows(dimensions.rows)
      ) {
        // A host resize becomes observable before the coalesced local VTE and
        // remote PTY resize completes. Rendering the old, wider viewport into
        // the new frame would either clip trusted state or reject a valid row
        // as oversized. Keep the last complete frame visible; #applyResize
        // renders again after every viewport reaches the admitted dimensions.
        this.#queueResize();
        return;
      }
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
        ...(this.#disconnectNotice !== undefined
          ? { notice: this.#disconnectNotice }
          : this.#browserNotice !== undefined
            ? { notice: this.#browserNotice }
            : this.#pendingBrowserAction !== undefined && this.#pendingBrowserActionTabId === activeTabId
              ? {
                notice: this.#pendingBrowserAction.type === "auth.device.present"
                  ? `${providerName(this.#pendingBrowserAction.provider)} requests device sign-in · code ${this.#pendingBrowserAction.userCode} · Enter/o open · d/Esc deny`
                  : `${providerName(this.#pendingBrowserAction.provider)} requests browser authentication · Enter/o open · d/Esc deny`,
              }
              : this.#helpVisible
                ? { notice: "Keys: Ctrl+C detach | Ctrl+S keep active | Ctrl+] c/s/q remote | 1-4 tab | n next | r retry | w take control | d detach" }
                : this.#seatNoticeFor(this.#tabs.get(activeTabId)?.snapshot) !== undefined
                  ? { notice: this.#seatNoticeFor(this.#tabs.get(activeTabId)?.snapshot) as string }
                  : {}),
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

  /**
   * RTP negotiation happens before `onTerminalReady`, so fall back to the
   * immutable startup intents.  An unknown attachment gets no local actions.
   */
  #localActionKindsForSession(agentSessionId: string): readonly TerminalLocalActionKind[] {
    const existing = [...this.#tabs.values()].find((tab) => tab.intent.agentSessionId === agentSessionId)?.intent;
    const intent = existing ?? this.#pendingIntents.find((candidate) => candidate.agentSessionId === agentSessionId);
    if (intent?.agent === "claude-code") return CLAUDE_LOCAL_ACTION_KINDS;
    if (intent?.agent === "codex") return CODEX_LOCAL_ACTION_KINDS;
    // OpenCode owns `/connect` and `/models` in its remote TUI.  It must not
    // advertise a local-action protocol that could be mistaken for a browser
    // or device-auth handoff.
    return NO_LOCAL_ACTION_KINDS;
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
    const top = padTrustedLine(` CUNA  ATTACHING ${count} EXACT AGENTSESSION${count === 1 ? "" : "S"}`, dimensions.columns);
    const indicator = `${ATTACHING_FRAMES[this.#attachingFrame % ATTACHING_FRAMES.length]} Checking terminal authority  ${ATTACHING_PROGRESS[this.#attachingFrame % ATTACHING_PROGRESS.length]}`;
    const detail = padTrustedLine(` ${indicator}  ·  Ctrl-C cancels`, dimensions.columns);
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

  #startAttachingAnimation(count: number): void {
    if (this.#state !== "starting" || this.#startupDetached) return;
    if (this.#attachingAnimationTimer !== undefined) return;
    this.#attachingAnimationTimer = setInterval(() => {
      if (this.#state !== "starting" || this.#startupDetached) {
        this.#stopAttachingAnimation();
        return;
      }
      this.#attachingFrame = (this.#attachingFrame + 1) % ATTACHING_PROGRESS.length;
      this.#queueAttachingRender(count);
    }, ATTACHING_FRAME_MS);
    this.#attachingAnimationTimer.unref();
  }

  #stopAttachingAnimation(): void {
    if (this.#attachingAnimationTimer === undefined) return;
    clearInterval(this.#attachingAnimationTimer);
    this.#attachingAnimationTimer = undefined;
  }

  #queueAttachingRender(count: number): void {
    const operation = this.#renderTail.then(async () => {
      if (this.#state !== "starting" || this.#startupDetached) return;
      await this.#renderAttaching(count, admitForegroundDimensions(this.#options.host.dimensions()));
    });
    this.#renderTail = operation.then(() => undefined, () => undefined);
    void operation.catch((error) => {
      this.#recordFailure(error);
      if (this.#state === "starting") void this.stop().catch(() => { this.#state = "failed"; });
    });
  }

  #queueStartupCloseFeedback(): void {
    const operation = this.#renderTail.then(async () => {
      const dimensions = admitForegroundDimensions(this.#options.host.dimensions());
      for (let index = 0; index < STARTUP_CLOSE_FRAMES.length; index += 1) {
        const notice = STARTUP_CLOSE_FRAMES[index];
        if (notice === undefined) continue;
        try {
          await this.#renderStartupClose(notice, dimensions);
        } catch {
          // Decorative shutdown feedback must never prevent the host lease
          // from being restored after a local interrupt.
          return;
        }
        if (index + 1 < STARTUP_CLOSE_FRAMES.length) {
          await new Promise<void>((resolve) => setTimeout(resolve, this.#options.disconnectFrameMs ?? DISCONNECT_FRAME_MS));
        }
      }
    });
    this.#renderTail = operation.then(() => undefined, () => undefined);
  }

  async #renderStartupClose(
    notice: string,
    dimensions: { readonly columns: number; readonly rows: number },
  ): Promise<void> {
    const color = this.#options.color ?? true;
    const top = padTrustedLine(" CUNA  CLOSING", dimensions.columns);
    const detail = padTrustedLine(` ${notice}`, dimensions.columns);
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

  /**
   * Ctrl+] w: ask for the terminal's one writing seat. The seat itself moves
   * only when the server's writer_epoch notice arrives; until then the tab
   * keeps observing, and the notice line says which of the two is true.
   */
  #takeWriterActiveTab(): void {
    const tabId = this.#activeTabId;
    const runtime = this.#runtime;
    if (tabId === undefined || runtime === undefined) return;
    const tab = this.#tabs.get(tabId);
    if (tab === undefined || tab.snapshot.state !== "active") return;
    if (tab.snapshot.accessMode === "writer") {
      this.#seatNotice = "You already hold this terminal's writer seat.";
      void this.#render().catch(() => undefined);
      return;
    }
    this.#seatNotice = "Taking control…";
    void this.#render().catch(() => undefined);
    void runtime.takeWriter({ tabId, signal: this.#lifetimeAbort.signal }).then(
      () => { this.#seatNotice = undefined; },
      (error: unknown) => {
        this.#seatNotice = `Could not take control: ${error instanceof Error ? error.message : String(error)}`;
      },
    ).finally(() => { void this.#render().catch(() => undefined); });
  }

  /**
   * A seat notice describes one moment: a refused keystroke, a pending or
   * refused take-control. It must not outlive the seat it described. Forget
   * it when the published seat (mode or reason) changes; keep it across a
   * publish that changes nothing about the seat, such as a heartbeat, so a
   * "Could not take control" line is still readable.
   */
  #forgetSeatNoticeOnSeatChange(before: RuntimeTerminalSnapshot, after: RuntimeTerminalSnapshot): void {
    if (this.#seatNotice === undefined) return;
    if (before.accessMode !== after.accessMode || before.reason !== after.reason) this.#seatNotice = undefined;
  }

  #seatNoticeFor(snapshot: RuntimeTerminalSnapshot | undefined): string | undefined {
    if (this.#seatNotice !== undefined) return this.#seatNotice;
    if (snapshot === undefined || snapshot.state !== "active" || snapshot.accessMode !== "observer") return undefined;
    return snapshot.reason === "writer_transferred"
      ? "Control moved to another client · Ctrl+] w to take it back"
      : "Observing (read-only) · Ctrl+] w to take control";
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

function providerName(provider: LocalBrowserActionRequest["provider"]): string {
  if (provider === "claude-code") return "Claude Code";
  return "Codex";
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
