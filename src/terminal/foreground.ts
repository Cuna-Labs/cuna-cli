import { createHash } from "node:crypto";

import {
  startCallbackRelay,
  type AcceptedProviderCallback,
  type CallbackRelayAnswer,
  type CallbackRelayHandle,
} from "../local-actions/callback-relay.js";
import { copyLocalText } from "../local-actions/clipboard.js";
import { AGENT_SESSION_AUTH_MAX_FUTURE_SKEW_MS, AGENT_SESSION_AUTH_MAX_TTL_MS } from "../api/contracts.js";
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
  type LocalActionSafeReason,
  type LocalActionSessionIdentity,
  type LocalActionSnapshot,
} from "../local-actions/index.js";
import type { TerminalAttachStage, TerminalAttachmentAdmission } from "../runtime/terminal-transport.js";
import { RuntimeBoundaryError, runtimeFailure, terminalHistoryGap } from "../runtime/errors.js";
import type { HostTerminalLease } from "./mode.js";
import { assertCanonicalUuid } from "../core/validation.js";
import { CunaError } from "../core/errors.js";
import { buildAppbarModel, type AppbarModel, type StatusEvidence } from "./appbar.js";
import { PredictiveEcho, type PredictiveEchoMode } from "./predictive-echo.js";
import {
  CONTINUED_MARKER,
  renderWorkbenchFrame,
  workbenchAppbarTargetAt,
  workbenchUpdate,
  withPredictionOverlay,
  type WorkbenchFrame,
  type WorkbenchLinkSpan,
  type WorkbenchSelectionRow,
  type WorkbenchTab,
} from "./workbench.js";
import type { SessionRoster, SessionRosterEntry } from "./session-roster.js";
import { ViewportRegistry, type ViewportSnapshot } from "./viewport.js";
import { orderBufferPoints, XtermViewportAdapter, type BufferLink, type BufferPoint } from "./xterm-vte.js";
import { encodeRemoteMouse, HOST_MOUSE_REPORTING_ON, HostMouseDecoder, wheelDirection, type HostMouseEvent } from "./host-mouse.js";

/** Lines one wheel notch moves the local view, the common terminal default. */
const WHEEL_SCROLL_LINES = 3;
/** A second press on the same cell within this window is a double-click. */
const DOUBLE_CLICK_MS = 500;
/** OSC 52 carries the selection to the host clipboard too; bounded like a paste. */
const MAX_OSC52_TEXT_BYTES = 65_536;
const MOUSE_SHIFT = 4;
const MOUSE_META = 8;
const MOUSE_CONTROL = 16;
const MOUSE_MOTION = 32;

const ESCAPE_PREFIX = 0x1d;
export const HISTORICAL_INPUT_NOTICE = "Prior input uncertain · not resent";
const INTERRUPT = 0x03;
const FLOW_RESUME = 0x11;
const FLOW_PAUSE = 0x13;
const REMOTE_INTERRUPT = 0x63;
const REMOTE_FLOW_RESUME = 0x71;
const REMOTE_FLOW_PAUSE = 0x73;
const REMOTE_REDRAW = Uint8Array.of(0x0c);
const TAB_FIRST = 0x31;
const TAB_LAST = 0x34;
// With a Machine roster, Ctrl+] 1-9 names roster entries rather than attached tabs.
const ROSTER_LAST = 0x39;
export const SWITCH_INPUT_NOTICE = "Keys typed while switching are not sent";
const NEXT_TAB = 0x6e;
const DETACH = 0x64;
const HELP = 0x3f;
const RETRY = 0x72;
const TAKE_WRITER = 0x77; // Ctrl+] w: take the terminal's one writing seat
const RETAINED_SIGN_IN = 0x61; // Ctrl+] a: inspect the last retained sign-in link
const RESIZE_COALESCE_MS = 50;
// A lone Escape must reach a terminal TUI promptly. Only ESC and ESC[ use
// this window; once a mouse or paste prefix is distinct, it stays buffered.
// The two ambiguous prefixes can still leak if split across a longer gap.
const HOST_INPUT_PREFIX_IDLE_MS = 25;
// Delay only keys after the first key in a burst. A batch remains one RTP1
// input frame, so the gateway still checks its durable writer fence per frame.
const INPUT_BATCH_WINDOW_MS = 24;
const INPUT_BURST_GAP_MS = INPUT_BATCH_WINDOW_MS;
const INPUT_BATCH_MAX_BYTES = 32;
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
const BATCH_WITHHELD_NOTICE = "Terminal authority changed · recent input was not sent.";
const BROWSER_BATCH_WITHHELD_NOTICE = "A browser request arrived · recent input was not sent.";
// Sent keys went unacknowledged past the runtime's input deadline (R12). Said
// the moment the runtime gives up on the connection, and it already carries the
// "not resent" half, so it is never prefixed with HISTORICAL_INPUT_NOTICE.
const INPUT_STALLED_NOTICE = "Connection stalled · reconnecting — input not resent";
const FLOW_CONTROL_NOTICE = "Terminal output kept active · Ctrl+] s sends Ctrl+S remotely.";
const RECONNECT_FAILED_NOTICE = "Reconnect failed · Ctrl+] r retries · Ctrl+C disconnects.";
// Automatic recovery back-off: 100 ms doubling, capped at 5 s per wait, ten
// attempts, about 26 s in total. Three attempts (~0.7 s) gave up while the
// gateway was still resetting a terminal view after a host resize, leaving
// the person on "Reconnect failed" although a fresh attach a minute later
// succeeded (2026-09-15, session 7d73bf08). The bound stays explicit; a
// non-retryable refusal still stops the loop on its first occurrence.
const DEFAULT_RECONNECT_ATTEMPTS = 10;
// After the quick attempts, one attempt every 30 s for 20 min. The quick ones
// alone gave up while the CLI's own API calls were timing out: on 2026-10-03
// (biotech lab, drop c0dc53b) the bar said "Reconnect failed" from about
// 16:08Z until 18:29Z, and a fresh `cuna opencode` reattached at 18:31Z. Still
// bounded, still stopped by a non-retryable refusal; Ctrl+] r tries at once.
const DEFAULT_RECONNECT_SLOW_DELAY_MS = 30_000;
const DEFAULT_RECONNECT_SLOW_ATTEMPTS = 40;
const BRACKETED_PASTE_START = Uint8Array.of(0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e);
const BRACKETED_PASTE_END = Uint8Array.of(0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e);
const CLAUDE_LOCAL_ACTION_KINDS = Object.freeze(["browser.open"] as const);
const CODEX_LOCAL_ACTION_KINDS = Object.freeze(["browser.open", "auth.device.present", "auth.callback.relay"] as const);
/** How long the Machine has to answer a relayed sign-in callback. */
const RELAY_ANSWER_TIMEOUT_MS = 15_000;
const RELAY_STREAM_CREDIT_BYTES = 16_384;
const NO_LOCAL_ACTION_KINDS = Object.freeze([] as const);
export const MAX_FOREGROUND_PENDING_INPUT_BYTES = 1_048_576;

export type ForegroundTerminalState = "idle" | "starting" | "active" | "stopping" | "stopped" | "failed";

export type { TerminalAttachStage } from "../runtime/terminal-transport.js";

/**
 * What the loader says while an attach waits. Each line names the step being
 * waited on (qa6 re-witness 2026-09-23, j5: ten minutes on "Checking terminal
 * authority" after that check had long passed).
 */
const ATTACH_STAGE_LABELS: Readonly<Record<TerminalAttachStage | "first_screen", string>> = Object.freeze({
  admission: "Checking terminal authority",
  // A fresh session whose PTY the Machine has not attested yet (PRD R5).
  confirm_wait: "Waiting for the Machine to confirm the terminal",
  grant: "Requesting a terminal connection",
  connect: "Connecting to the Machine's terminal",
  ready_wait: "Waiting for the terminal to answer",
  first_screen: "Waiting for the first screen",
});

/** A stage shown longer than this also shows how long it has waited. */
const ATTACH_STAGE_ELAPSED_AFTER_MS = 3_000;

export interface ForegroundTerminalRuntime {
  readonly activeTabId: string | undefined;
  attach(input: {
    readonly tabId: string;
    readonly agentSessionId: string;
    readonly columns: number;
    readonly rows: number;
    readonly expectedAdmission?: TerminalAttachmentAdmission;
    readonly signal?: AbortSignal;
    /** Reports which remote step the attach is waiting on, so the loader can say it. */
    readonly onStage?: (stage: TerminalAttachStage) => void;
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
  readonly binding: RuntimeTerminalResponse["binding"] & { readonly writerEpoch: number };
}

/** One AgentSession the person detached from; it keeps running remotely. */
export interface DetachedForegroundSession {
  readonly agentSessionId: string;
  readonly label: string;
}

/** One AgentSession whose process ended while it was on screen. */
export interface EndedForegroundSession {
  readonly agentSessionId: string;
  readonly label: string;
  readonly agent: WorkbenchTab["agent"];
  /** "status 0" or "signal 9", when the terminal said. */
  readonly status?: string;
}

/** The server's record that an AgentSession's process has ended. */
export interface ForegroundSessionEndRecord {
  /** When the server observed the end (ISO 8601), when it recorded one. */
  readonly observedAt?: string;
}

interface TabEnd {
  readonly status?: string;
  readonly observedAt?: string;
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

interface PendingPrintableInput {
  readonly target: ForegroundInputTarget;
  readonly bytes: number[];
  readonly receipt: number;
  readonly browserActionGeneration: number;
  readonly browserAction: LocalBrowserActionRequest | undefined;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface ForegroundTerminalCoordinatorOptions {
  readonly host: ForegroundTerminalHost;
  readonly browser?: BrowserOpener;
  readonly copyText?: (text: string) => Promise<void>;
  readonly appbar?: () => AppbarModel;
  readonly color?: boolean;
  readonly clock?: () => number;
  /** Monotonic time used only to classify nearby keyboard input. */
  readonly inputClock?: () => number;
  readonly resizeCoalesceMs?: number;
  readonly reconnectAttempts?: number;
  readonly reconnectBaseDelayMs?: number;
  /** Wait between the slow attempts that follow the quick ones. */
  readonly reconnectSlowDelayMs?: number;
  /** Slow attempts after the quick ones; 0 turns them off. */
  readonly reconnectSlowAttempts?: number;
  readonly disconnectFrameMs?: number;
  /** Stable only for this foreground process; never a reusable device credential. */
  readonly deviceId?: string;
  /** Predictive local echo of typed characters; `off` unless the caller chooses. */
  readonly predictiveEcho?: PredictiveEchoMode;
  /**
   * The Machine's sessions, for a run attached to exactly one AgentSession.
   * Its tabs replace the attached tab on the bar, and choosing one (click or
   * Ctrl+] <n>) ends this run with a `switchRequest` for the runner.
   */
  readonly sessionRoster?: SessionRoster;
  /** Ask the host for SGR press/release mouse reports, so the bar is clickable. */
  readonly mouseReporting?: boolean;
  /** Replaces the attaching loader's first line (a switch names its target). */
  readonly attachingTitle?: string;
  /** One line shown once the terminal is on screen, until the next key. */
  readonly initialNotice?: string;
  /**
   * Reads the server's record of how an AgentSession's process ended, when
   * its screen shows the terminal's pane-dead line. Undefined while the record
   * does not say it ended: the screen alone never ends a tab.
   */
  readonly readSessionEnd?: (agentSessionId: string, signal: AbortSignal) => Promise<ForegroundSessionEndRecord | undefined>;
  /** Waits before each read of that record; the supervisor records an exit a moment after it. */
  readonly sessionEndReadDelaysMs?: readonly number[];
  /** How long a relayed sign-in callback waits for the Machine's answer. */
  readonly relayAnswerTimeoutMs?: number;
  /**
   * One line from outside the terminal that needs the person's action (a
   * workspace sync that stopped), shown on the notice row while it lasts.
   */
  readonly attention?: ForegroundAttentionSource;
}

/**
 * A line owned outside the terminal. `subscribe` is called on every change;
 * the bar repaints on that call, not on the next terminal output frame.
 */
export interface ForegroundAttentionSource {
  readonly current: () => string | undefined;
  readonly subscribe: (listener: (line: string | undefined) => void) => () => void;
}

/**
 * A provider's request to receive its sign-in callback on this computer:
 * Codex redirects the browser to http://localhost:1455/… while its callback
 * server listens on the Machine's loopback. The supervisor originates it.
 */
interface CallbackRelayConsent {
  readonly tabId: string;
  readonly request: LocalActionRequest;
  readonly localPath: string;
  readonly exactLocalPort: number;
}

interface RelayStreamWait {
  readonly tabId: string;
  readonly length: number;
  readonly resolve: (answer: CallbackRelayAnswer) => void;
}

/** The session the person chose on the bar; the runner attaches it next. */
export interface ForegroundSwitchRequest {
  readonly agentSessionId: string;
  readonly agent: SessionRosterEntry["agent"];
  readonly label: string;
}

interface ForegroundSelection {
  readonly tabId: string;
  anchor: BufferPoint;
  focus: BufferPoint;
  dragging: boolean;
  /** Made by a double click: it holds a whole word or URL and is copied on release. */
  readonly word: boolean;
}

interface ForegroundTab {
  readonly intent: ForegroundTabIntent;
  snapshot: RuntimeTerminalSnapshot;
  viewport: XtermViewportAdapter;
  providerAuthentication: StatusEvidence<string> | undefined;
}

export class ForegroundTerminalCoordinator {
  readonly #options: ForegroundTerminalCoordinatorOptions;
  readonly #registry = new ViewportRegistry();
  readonly #tabs = new Map<string, ForegroundTab>();
  readonly #clock: () => number;
  readonly #inputClock: () => number;
  #runtime: ForegroundTerminalRuntime | undefined;
  #lease: HostTerminalLease | undefined;
  #state: ForegroundTerminalState = "idle";
  #activeTabId: string | undefined;
  #removeInput: (() => void) | undefined;
  #removeResize: (() => void) | undefined;
  #resizeTimer: NodeJS.Timeout | undefined;
  #resizeInputBarrier: Promise<void> | undefined;
  #renderTail: Promise<void> = Promise.resolve();
  /** The last complete frame the host accepted; undefined whenever the host screen is not known to show it. */
  #lastHostFrame: Uint8Array | undefined;
  #lastWorkbenchFrame: WorkbenchFrame | undefined;
  #inputTail: Promise<void> = Promise.resolve();
  #inputBatch: PendingPrintableInput | undefined;
  #lastPrintableAt: number | undefined;
  #lastPrintableTarget: ForegroundInputTarget | undefined;
  readonly #copyDetectors = new Map<string, ProviderBrowserActionDetector[]>();
  readonly #copyLinks = new Map<string, LocalBrowserActionRequest>();
  #prefixPending = false;
  #prefixTarget: ForegroundInputTarget | undefined;
  #prefixBrowserActionGeneration: number | undefined;
  #prefixBrowserAction: LocalBrowserActionRequest | undefined;
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
  /** Tabs waiting for a slow attempt: the wait, and what ends it early (Ctrl+] r). */
  readonly #slowReconnectWaits = new Map<string, { readonly delayMs: number; readonly wake: () => void }>();
  readonly #outputTails = new Map<string, Promise<void>>();
  readonly #localDetachTabIds = new Set<string>();
  readonly #detachedSessions: DetachedForegroundSession[] = [];
  readonly #endedSessions: EndedForegroundSession[] = [];
  /** Tabs whose process the server says ended; their last screen stays, labelled ended. */
  readonly #endedTabs = new Map<string, TabEnd>();
  readonly #endReads = new Set<string>();
  /** Sign-in relay requests by id, from arrival until their outcome. */
  readonly #relayRequests = new Map<string, CallbackRelayConsent>();
  /** The relay request at the head of the local-action queue, awaiting Enter or Esc. */
  #pendingRelay: CallbackRelayConsent | undefined;
  readonly #relayHandles = new Map<string, CallbackRelayHandle>();
  readonly #relayStreams = new Map<string, RelayStreamWait>();
  readonly #browserDetectors = new Map<string, ProviderBrowserActionDetector>();
  readonly #retainedBrowserDetectors = new Map<string, ProviderBrowserActionDetector>();
  readonly #retainedBrowserCandidates = new Map<string, LocalBrowserActionRequest>();
  #retainedPendingRequestId: string | undefined;
  readonly #oauthPasteGuards = new Map<string, ProviderOAuthPasteGuard>();
  readonly #oauthPrefixTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #handledBrowserUrls = new Set<string>();
  readonly #browserRequests = new Map<string, LocalBrowserActionRequest>();
  readonly #remoteLocalActionTabs = new Map<string, string>();
  readonly #pendingRemoteLocalActionResults = new Map<string, PendingRemoteLocalActionResult>();
  readonly #remoteLocalActionResultSends = new Map<string, Promise<void>>();
  readonly #remoteLocalActionResultTasks = new Set<Promise<void>>();
  readonly #localActionBroker: LocalActionBroker;
  #removeAbort: (() => void) | undefined;
  #pendingInputBytes = 0;
  readonly #hostMouse = new HostMouseDecoder();
  /**
   * Cuna's own selection on one tab, in VTE buffer cells, made with a plain
   * drag while the remote program has not asked for the mouse. It is local:
   * nothing about it is ever sent to the remote.
   */
  #selection: ForegroundSelection | undefined;
  #lastPress: { readonly at: number; readonly tabId: string; readonly point: BufferPoint } | undefined;
  #hostMousePendingTimer: ReturnType<typeof setTimeout> | undefined;
  #mouseReportingPending = false;
  #helpVisible = false;
  #pendingBrowserAction: LocalBrowserActionRequest | undefined;
  #pendingBrowserActionTabId: string | undefined;
  readonly #browserActionGenerations = new Map<string, number>();
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
  #attachingStage: TerminalAttachStage | "first_screen" = "admission";
  #attachingStageSince = 0;
  /**
   * Set by the first terminal frame painted to the host. From then on no
   * loader frame may paint: both go through `#renderTail`, so this flag, not
   * the timer, is what keeps loader chrome from ever following PTY output.
   */
  #firstFrameRendered = false;
  readonly #predictiveEcho: PredictiveEcho;
  /** Received chunks with a non-printable byte that the input tail has not routed yet. */
  #unroutedBarrierChunks = 0;
  #removeRoster: (() => void) | undefined;
  #removeAttention: (() => void) | undefined;
  /** Host input chunks are numbered on receipt, so a switch can cut input at one. */
  #inputReceipt = 0;
  /** Set when a switch is chosen: input received after this receipt is never sent. */
  #switchCutoff: number | undefined;
  #switchRequest: ForegroundSwitchRequest | undefined;
  #switchNotice: string | undefined;
  /**
   * The one line the attach arrived with (another process holds this client,
   * or a switch had to come back). It shares row 2 with the seat instead of
   * replacing it: shown alone, it hid observer-or-writer for 65 s after a
   * roster switch (installed 0.1.4, 2026-09-28) until the person typed.
   */
  #arrivalNotice: string | undefined;

  constructor(options: ForegroundTerminalCoordinatorOptions) {
    const resizeCoalesceMs = options.resizeCoalesceMs ?? RESIZE_COALESCE_MS;
    if (!Number.isSafeInteger(resizeCoalesceMs) || resizeCoalesceMs < 1 || resizeCoalesceMs > 1_000) {
      throw new RangeError("Foreground resize coalescing must be between 1 and 1000 milliseconds.");
    }
    const reconnectAttempts = options.reconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS;
    const reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 100;
    const reconnectSlowDelayMs = options.reconnectSlowDelayMs ?? DEFAULT_RECONNECT_SLOW_DELAY_MS;
    const reconnectSlowAttempts = options.reconnectSlowAttempts ?? DEFAULT_RECONNECT_SLOW_ATTEMPTS;
    const disconnectFrameMs = options.disconnectFrameMs ?? DISCONNECT_FRAME_MS;
    if (!Number.isSafeInteger(reconnectAttempts) || reconnectAttempts < 1 || reconnectAttempts > 10) {
      throw new RangeError("Foreground reconnect attempts must be between 1 and 10.");
    }
    if (!Number.isSafeInteger(reconnectBaseDelayMs) || reconnectBaseDelayMs < 1 || reconnectBaseDelayMs > 5_000) {
      throw new RangeError("Foreground reconnect delay must be between 1 and 5000 milliseconds.");
    }
    if (!Number.isSafeInteger(reconnectSlowDelayMs) || reconnectSlowDelayMs < 1 || reconnectSlowDelayMs > 300_000) {
      throw new RangeError("Foreground slow reconnect delay must be between 1 and 300000 milliseconds.");
    }
    if (!Number.isSafeInteger(reconnectSlowAttempts) || reconnectSlowAttempts < 0 || reconnectSlowAttempts > 120) {
      throw new RangeError("Foreground slow reconnect attempts must be between 0 and 120.");
    }
    if (!Number.isSafeInteger(disconnectFrameMs) || disconnectFrameMs < 1 || disconnectFrameMs > MAX_DISCONNECT_FRAME_MS) {
      throw new RangeError("Foreground disconnect frame duration must be between 1 and 250 milliseconds.");
    }
    this.#options = Object.freeze({
      ...options, resizeCoalesceMs, reconnectAttempts, reconnectBaseDelayMs, reconnectSlowDelayMs, reconnectSlowAttempts,
      disconnectFrameMs,
    });
    this.#clock = options.clock ?? Date.now;
    this.#predictiveEcho = new PredictiveEcho({
      mode: options.predictiveEcho ?? "off",
      clock: this.#clock,
      // A guess that timed out is repainted away by an ordinary frame.
      onExpire: () => this.#queueStateRender(),
    });
    this.#inputClock = options.inputClock ?? (() => performance.now());
    this.#localActionBroker = new LocalActionBroker({
      clock: this.#clock,
      isIdentityLive: (identity) => this.#isLocalActionIdentityLive(identity),
      onChange: (snapshot) => {
        if (["succeeded", "failed", "denied", "expired", "cancelled"].includes(snapshot.state)) {
          this.#browserRequests.delete(snapshot.request.id);
          this.#endRelay(snapshot.request.id);
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
    this.#arrivalNotice = options.initialNotice;
  }

  get state(): ForegroundTerminalState {
    return this.#state;
  }

  /**
   * The session chosen on the bar, once the current one was detached for it.
   * Undefined when the run ended any other way, including a switch cancelled
   * by Ctrl+C or a detach the runtime refused.
   */
  get switchRequest(): ForegroundSwitchRequest | undefined {
    return this.#terminalFailure === undefined ? this.#switchRequest : undefined;
  }

  get failure(): unknown {
    return this.#terminalFailure ?? this.#recoverableReconnectFailures.values().next().value;
  }

  /**
   * AgentSessions the person detached from on purpose (Ctrl+] d, or an observer's Ctrl+C),
   * each confirmed by the runtime. A detach never terminates the remote
   * process, so the runner tells the person how to come back once the host
   * terminal is theirs again. Tabs detached by cleanup are not listed.
   */
  get detachedSessions(): readonly DetachedForegroundSession[] {
    return Object.freeze([...this.#detachedSessions]);
  }

  /** AgentSessions whose process ended while on screen; none of them keeps running. */
  get endedSessions(): readonly EndedForegroundSession[] {
    return Object.freeze([...this.#endedSessions]);
  }

  bindRuntime(runtime: ForegroundTerminalRuntime): void {
    if (this.#runtime !== undefined) throw runtimeFailure("session_conflict", "The foreground runtime is already bound.");
    if (this.#state !== "idle") throw runtimeFailure("session_conflict", "The foreground runtime must be bound before startup.");
    this.#runtime = runtime;
  }

  runtimeCallbacks(): {
    readonly onTerminalViewStarted: (event: { readonly snapshot: RuntimeTerminalSnapshot; readonly columns: number; readonly rows: number; readonly signal: AbortSignal }) => Promise<void>;
    readonly onTerminalReady: (snapshot: RuntimeTerminalSnapshot) => Promise<void>;
    readonly onTerminalGeometry: (event: { readonly snapshot: RuntimeTerminalSnapshot; readonly signal: AbortSignal }) => Promise<void>;
    readonly onTerminalOutput: (event: {
      readonly provenance: "live" | "replay_or_unknown";
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
      onTerminalViewStarted: async (event) => await this.#terminalViewStarted(event),
      onTerminalGeometry: async (event) => await this.#terminalGeometry(event.snapshot, event.signal),
      onTerminalOutput: async (event) => await this.#queueTerminalOutput(event),
      onTerminalState: (snapshot) => this.#terminalState(snapshot),
      localActionKinds: (agentSessionId) => this.#localActionKindsForSession(agentSessionId),
      onLocalActionFrame: async (event) => await this.#localActionFrame(event),
    });
  }

  /** Apply only fresh display evidence for the still-attached process. */
  async applyProviderAuthentication(input: {
    readonly tabId: string;
    readonly agentSessionId: string;
    readonly processEpoch: string;
    readonly evidence: StatusEvidence<string>;
  }): Promise<boolean> {
    const tab = this.#tabs.get(input.tabId);
    const now = this.#clock();
    const evidence = input.evidence;
    if (
      this.#state !== "active" ||
      tab === undefined ||
      tab.snapshot.state !== "active" ||
      tab.snapshot.agentSessionId !== input.agentSessionId ||
      tab.snapshot.processEpoch !== input.processEpoch ||
      evidence.source.length === 0 ||
      evidence.correlationId.length === 0 ||
      !Number.isFinite(evidence.observedAt) ||
      !Number.isFinite(evidence.expiresAt) ||
      evidence.observedAt > now + AGENT_SESSION_AUTH_MAX_FUTURE_SKEW_MS ||
      evidence.expiresAt <= now ||
      evidence.expiresAt < evidence.observedAt ||
      evidence.expiresAt - evidence.observedAt > AGENT_SESSION_AUTH_MAX_TTL_MS ||
      !["authenticated", "configured", "login_required", "unavailable"].includes(evidence.value)
    ) return false;
    tab.providerAuthentication = evidence;
    if (this.#activeTabId === input.tabId) await this.#render();
    return true;
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
      // Only the attached view reports the mouse. The Machines explorer and the
      // provider screens take the same rich host and read keys only; the
      // lease's restore turns reporting off again (RESET_REMOTE_MODES). The
      // switch rides on this lease's first frame rather than a write of its own.
      this.#mouseReportingPending = this.#options.mouseReporting !== false;
      this.#removeInput = this.#options.host.onInput((bytes) => this.#queueInput(bytes));
      this.#removeResize = this.#options.host.onResize(() => this.#queueResize());
      if (this.#options.sessionRoster !== undefined && intents.length === 1) {
        this.#removeRoster = this.#options.sessionRoster.subscribe(() => {
          if (this.#state === "active") this.#queueStateRender();
        });
      }
      // Before this, a sync that stopped while the agent was attached reached
      // the person only at detach (BL-7, 2026-10-03: 21 silent minutes). A
      // change before `active` is read by the first active render.
      this.#removeAttention = this.#options.attention?.subscribe(() => {
        if (this.#state === "active") this.#queueStateRender();
      });
      const dimensions = admitForegroundDimensions(this.#options.host.dimensions());
      this.#attachingStageSince = this.#clock();
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
          onStage: (stage) => this.#setAttachingStage(stage, intents.length),
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
    if (this.#hostMousePendingTimer !== undefined) clearTimeout(this.#hostMousePendingTimer);
    this.#hostMousePendingTimer = undefined;
    for (const timer of this.#oauthPrefixTimers.values()) clearTimeout(timer);
    this.#oauthPrefixTimers.clear();
    this.#predictiveEcho.dispose();
    this.#resizeTimer = undefined;
    this.#resizeInputBarrier = undefined;
    this.#removeInput?.();
    this.#removeResize?.();
    this.#removeRoster?.();
    this.#removeAttention?.();
    this.#removeInput = undefined;
    this.#removeResize = undefined;
    this.#removeRoster = undefined;
    this.#removeAttention = undefined;
    this.#discardInputBatch();
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
    this.#copyDetectors.clear();
    this.#copyLinks.clear();
    this.#retainedBrowserDetectors.clear();
    this.#retainedBrowserCandidates.clear();
    this.#retainedPendingRequestId = undefined;
    this.#oauthPasteGuards.clear();
    this.#browserRequests.clear();
    this.#remoteLocalActionTabs.clear();
    this.#pendingRemoteLocalActionResults.clear();
    this.#remoteLocalActionResultSends.clear();
    this.#remoteLocalActionResultTasks.clear();
    this.#pendingBrowserAction = undefined;
    this.#pendingBrowserActionTabId = undefined;
    this.#browserNotice = undefined;
    this.#arrivalNotice = undefined;
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
    // `onTerminalReady` is the boundary at which remote bytes may be rendered,
    // but nothing is on screen until the first terminal frame paints. Until
    // then the loader keeps moving and says it is waiting for that frame; the
    // first painted frame retires it (`#firstFrameRendered`), so loader chrome
    // still never follows PTY output.
    if (this.#state === "starting") this.#setAttachingStage("first_screen", this.#pendingIntents.length);
    const runtime = this.#requireRuntime();
    const intent = this.#findIntent(snapshot.tabId, snapshot.agentSessionId);
    const previous = this.#tabs.get(snapshot.tabId);
    if (previous !== undefined && !sameSnapshotBinding(snapshot, previous.snapshot)) {
      if (this.#hostMousePendingTimer !== undefined) clearTimeout(this.#hostMousePendingTimer);
      this.#hostMousePendingTimer = undefined;
      this.#hostMouse.flushPending();
    }
    await this.#outputTails.get(snapshot.tabId);
    await this.#renderTail;
    if (
      this.#lifetimeAbort.signal.aborted ||
      (this.#state !== "starting" && this.#state !== "active")
    ) {
      throw runtimeFailure("terminal_disconnected", "Terminal readiness arrived after foreground ownership ended.");
    }
    if (previous !== undefined) this.#forgetSeatNoticeOnSeatChange(previous.snapshot, snapshot);
    // A new attachment may start a fresh view; the old cells are gone.
    if (this.#selection?.tabId === snapshot.tabId) this.#selection = undefined;
    const dimensions = admitForegroundDimensions(this.#options.host.dimensions());
    this.#copyLinks.delete(snapshot.tabId);
    this.#copyDetectors.set(snapshot.tabId, (["codex", "claude-code"] as const).map(provider => new ProviderBrowserActionDetector({ copyOnly: true, provider, agentSessionId: snapshot.agentSessionId, processEpoch: snapshot.processEpoch, fencingGeneration: snapshot.fencingGeneration, clock: this.#clock })));
    this.#retainedBrowserDetectors.delete(snapshot.tabId);
    this.#retainedBrowserCandidates.delete(snapshot.tabId);
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
      this.#retainedBrowserDetectors.set(snapshot.tabId, new ProviderBrowserActionDetector({
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
      this.#setOAuthPasteGuard(snapshot.tabId);
    }
    const binding = {
      userId: snapshot.userId,
      machineId: snapshot.machineId,
      agentSessionId: snapshot.agentSessionId,
      processEpoch: snapshot.processEpoch,
      fencingGeneration: snapshot.fencingGeneration,
    };
    // A resumed stream contains only output after the retained cursor. Keep
    // those earlier cells, while retiring the old query-response authority.
    const viewport = previous?.viewport ?? new XtermViewportAdapter({
      tabId: snapshot.tabId,
      binding,
      columns: dimensions.columns,
      rows: remoteRows(dimensions.rows),
      registry: this.#registry,
      onTerminalResponse: async (response) => await runtime.sendTerminalResponse(response),
      clock: this.#clock,
    });
    if (previous !== undefined) {
      const oldBinding = viewport.snapshot().binding;
      if (snapshot.terminalView === undefined && !sameSnapshotBinding(snapshot, oldBinding)) await viewport.rebind(binding);
      if (this.#lifetimeAbort.signal.aborted || this.#tabs.get(snapshot.tabId) !== previous ||
        (this.#state !== "starting" && this.#state !== "active")) {
        throw runtimeFailure("terminal_disconnected", "Terminal rebinding completed after foreground ownership ended.");
      }
    }
    this.#tabs.set(snapshot.tabId, {
      intent, snapshot, viewport,
      providerAuthentication: previous === undefined
        ? intent.providerAuthentication
        : previous.snapshot.userId === snapshot.userId &&
          previous.snapshot.machineId === snapshot.machineId &&
          previous.snapshot.agentSessionId === snapshot.agentSessionId &&
          previous.snapshot.processEpoch === snapshot.processEpoch
          ? previous.providerAuthentication
          : undefined,
    });
    // A reconnect for the same binding may have dropped the outcome after the
    // local side effect completed. The server ACK is the only condition that
    // clears the cache, so resubmit it once this exact attachment is ready.
    this.#resendPendingRemoteLocalActionResults(snapshot.tabId, this.#localActionIdentity(intent, snapshot));
  }

  async #terminalViewStarted(event: { readonly snapshot: RuntimeTerminalSnapshot; readonly columns: number; readonly rows: number; readonly signal: AbortSignal }): Promise<void> {
    const { snapshot, signal } = event;
    const tab = this.#tabs.get(snapshot.tabId);
    if (signal.aborted || tab === undefined || tab.snapshot.fencingGeneration !== snapshot.fencingGeneration) throw runtimeFailure("terminal_disconnected", "Terminal view reset targets a retired attachment.");
    const abort = () => { if (this.#tabs.get(snapshot.tabId) === tab) tab.viewport.dispose(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const current = tab.viewport.snapshot();
      if (current.binding.fencingGeneration === snapshot.fencingGeneration) {
        if (current.outputSequence !== 0n || current.replayCursor !== 0n) throw runtimeFailure("terminal_protocol_error", "Initial terminal view is not empty.");
        await raceAbort(tab.viewport.resize(event.columns, event.rows), signal);
      } else {
        await raceAbort(tab.viewport.resetForCurrentView({
          userId: snapshot.userId, machineId: snapshot.machineId,
          agentSessionId: snapshot.agentSessionId, processEpoch: snapshot.processEpoch,
          fencingGeneration: snapshot.fencingGeneration,
        }, event.columns, event.rows), signal);
      }
      if (signal.aborted || this.#tabs.get(snapshot.tabId) !== tab) throw runtimeFailure("terminal_disconnected", "Terminal view reset completed after retirement.");
    } catch (error) { abort(); throw error; }
    finally { signal.removeEventListener("abort", abort); }
  }

  async #terminalGeometry(snapshot: RuntimeTerminalSnapshot, signal: AbortSignal): Promise<void> {
    const tab = this.#tabs.get(snapshot.tabId);
    if (tab === undefined || !sameSnapshotBinding(tab.snapshot, snapshot) ||
      snapshot.geometry === null || snapshot.geometry.writerEpoch !== snapshot.writerEpoch ||
      snapshot.writerEpoch !== tab.snapshot.writerEpoch) {
      throw runtimeFailure("grant_scope_mismatch", "Terminal geometry targets an unbound foreground viewport.");
    }
    if (signal.aborted) throw signal.reason;
    // Only observers adopt remote dimensions. The writer owns local fit and
    // sends its own fenced RESIZE; an older size notice cannot undo that fit.
    if (snapshot.accessMode === "observer") {
      try {
        await raceAbort(tab.viewport.resize(snapshot.geometry.columns, snapshot.geometry.rows), signal);
      } catch (error) {
        tab.viewport.dispose();
        throw error;
      }
    }
    if (signal.aborted || this.#tabs.get(snapshot.tabId) !== tab) return;
    tab.snapshot = snapshot;
    await this.#render();
  }

  async #queueTerminalOutput(event: {
    readonly provenance: "live" | "replay_or_unknown";
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
    readonly provenance: "live" | "replay_or_unknown";
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
    // Retained output remains visible but cannot acquire fresh local-action
    // authority. Do not feed it into the streaming detector: a historical
    // prefix must never combine with a live suffix into a new request.
    for (const detector of this.#copyDetectors.get(event.tabId) ?? []) {
      const candidate = detector.push(event.bytes).at(-1);
      if (candidate !== undefined) this.#copyLinks.set(event.tabId, candidate);
    }
    const detected = event.provenance === "live"
      ? this.#browserDetectors.get(event.tabId)?.push(event.bytes) ?? [] : [];
    if (event.provenance !== "live") {
      const retained = this.#retainedBrowserDetectors.get(event.tabId)?.push(event.bytes) ?? [];
      const latest = retained.at(-1);
      if (latest !== undefined) this.#retainedBrowserCandidates.set(event.tabId, latest);
    }
    for (const request of detected) this.#enqueueBrowserAction(event.tabId, tab, request);
    this.#promoteBrowserAction();
    await raceAbort(tab.viewport.write(event.bytes, event.sequence, event.sequence), event.signal);
    const current = this.#tabs.get(event.tabId);
    if (event.signal.aborted || current !== tab || !sameSnapshotBinding(tab.snapshot, event.binding)) return;
    if (event.tabId === this.#activeTabId) {
      const view = tab.viewport.snapshot();
      this.#predictiveEcho.reconcile(view, predictionKey(tab, view));
    }
    if (event.provenance === "live") this.#noticePaneDeath(tab);
    // Parsing preserves every ordered byte; painting may skip intermediate
    // screens. A slow host must not hold up ingestion of newer remote output.
    this.#queueStateRender();
  }

  /**
   * tmux keeps a dead pane on screen and writes one line of its own under it
   * (remain-on-exit): "Pane is dead (status 0, Tue Sep 29 17:41:10 2026)". A
   * program can print the same words, so the line only starts a bounded read
   * of the server's record, and the tab ends only when that record says so.
   * The supervisor records the exit a moment after tmux draws the line.
   */
  #noticePaneDeath(tab: ForegroundTab): void {
    const tabId = tab.intent.tabId;
    const read = this.#options.readSessionEnd;
    if (read === undefined || this.#endReads.has(tabId) || this.#endedTabs.has(tabId)) return;
    const death = paneDeathRow(tab.viewport.snapshot().cells);
    if (death === undefined) return;
    this.#endReads.add(tabId);
    void (async () => {
      for (const delay of this.#options.sessionEndReadDelaysMs ?? SESSION_END_READ_DELAYS_MS) {
        await abortableDelay(delay, this.#lifetimeAbort.signal);
        if (this.#tabs.get(tabId) !== tab || this.#state !== "active") return;
        const end = await read(tab.intent.agentSessionId, this.#lifetimeAbort.signal).catch(() => undefined);
        if (end === undefined) continue;
        if (this.#tabs.get(tabId) !== tab) return;
        this.#endedTabs.set(tabId, Object.freeze({
          status: death.status,
          ...(end.observedAt === undefined ? {} : { observedAt: end.observedAt }),
        }));
        if (this.#pendingBrowserActionTabId === tabId) {
          this.#pendingBrowserAction = undefined;
          this.#pendingBrowserActionTabId = undefined;
        }
        await this.#render();
        return;
      }
    })().catch(() => undefined).finally(() => this.#endReads.delete(tabId));
  }

  /** What an ended tab's bar says, and what its keys are answered with. */
  #endedNotice(tab: ForegroundTab, end: TabEnd): string {
    const provider = sessionProviderName(tab.intent.agent);
    const at = end.observedAt === undefined || Number.isNaN(Date.parse(end.observedAt))
      ? "" : ` at ${new Date(end.observedAt).toISOString().slice(11, 16)} UTC`;
    const journey = journeyCommand(tab.intent.agent);
    return `${provider} exited${end.status === undefined ? "" : ` (${end.status})`}${at} · this session has ended · ` +
      (journey === undefined ? "start a new one with `cuna` (from its folder)" : `start a new one: \`${journey} --new-session\` (from its folder)`);
  }

  #terminalState(snapshot: RuntimeTerminalSnapshot): void {
    const tab = this.#tabs.get(snapshot.tabId);
    const batch = this.#inputBatch;
    if (batch?.target.tabId === snapshot.tabId &&
      (snapshot.state !== "active" || snapshot.accessMode !== "writer" ||
        !sameSnapshotBinding(snapshot, batch.target.binding) ||
        snapshot.writerEpoch !== batch.target.binding.writerEpoch)) {
      this.#discardInputBatch();
      this.#browserNotice = BATCH_WITHHELD_NOTICE;
    }
    if (tab !== undefined) {
      this.#forgetSeatNoticeOnSeatChange(tab.snapshot, snapshot);
      // The PTY keeps whatever geometry the previous writer set, and an
      // observer never resizes it. Taking the seat is therefore the first
      // moment this client may state its own size -- without this, the remote
      // keeps painting at the old writer's height and the bottom of a larger
      // local terminal stays empty until some later host resize happens to
      // occur. Reconcile once, on the observer -> writer edge only.
      const becameWriter = tab.snapshot.accessMode === "observer" &&
        snapshot.accessMode === "writer" && snapshot.state === "active";
      if (tab.snapshot.agentSessionId !== snapshot.agentSessionId || tab.snapshot.processEpoch !== snapshot.processEpoch) {
        tab.providerAuthentication = undefined;
      }
      tab.snapshot = snapshot;
      if (becameWriter) this.#reconcileSeatGeometry(snapshot);
      if (
        snapshot.state === "active" &&
        (this.#browserNotice === INPUT_WITHHELD_NOTICE || this.#browserNotice === INPUT_STALLED_NOTICE ||
          isReconnectFailedNotice(this.#browserNotice))
      ) {
        this.#browserNotice = undefined;
      }
      if (snapshot.state === "interrupted" && snapshot.reason === "input_ack_timeout") {
        this.#browserNotice = INPUT_STALLED_NOTICE;
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
          this.#recordFailure(snapshot.reason === "terminal_history_gap" ? terminalHistoryGap(snapshot.agentSessionId) : snapshot.reason === "terminal_input_recovery_required"
            ? runtimeFailure("terminal_protocol_error", "Terminal input requires recovery. Earlier input will not be resent automatically.", {
              retryable: false, safeDetails: { reason: snapshot.reason },
            })
            : snapshot.reason === "terminal_protocol_error"
              ? runtimeFailure("terminal_protocol_error", snapshot.remoteReason === undefined
                ? "Cuna could not safely process the terminal stream. Inspect this session before reconnecting."
                : `The remote terminal ended the stream: ${snapshot.remoteReason}. Inspect this session before reconnecting.`, {
                retryable: false,
                ...(snapshot.remoteReason === undefined ? {} : { safeDetails: { reason: snapshot.remoteReason } }),
              })
              : runtimeFailure("terminal_disconnected", "A foreground AgentSession terminal failed."));
        }
        if (snapshot.state === "closed" && snapshot.reason === "remote_process_exit") {
          // The supervisor's EXIT frame: the process ended and the wire is
          // closed. The runner says so once the host is restored.
          this.#endedSessions.push(Object.freeze({
            agentSessionId: tab.intent.agentSessionId,
            label: tab.intent.label,
            agent: tab.intent.agent,
            ...(typeof snapshot.exitCode === "number" ? { status: `status ${snapshot.exitCode}` } : {}),
          }));
        }
        this.#endedTabs.delete(snapshot.tabId);
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
    if (snapshot.state === "interrupted" && !this.#reconnectTasks.has(snapshot.tabId) &&
        !this.#recoverableReconnectFailures.has(snapshot.tabId)) {
      this.#startRecovery(snapshot.tabId);
    }
    this.#queueStateRender();
  }

  async #recoverTab(tabId: string): Promise<void> {
    const attempts = this.#options.reconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS;
    const baseDelayMs = this.#options.reconnectBaseDelayMs ?? 100;
    let lastFailure: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (this.#state !== "active" || this.#lifetimeAbort.signal.aborted) return;
      await abortableDelay(Math.min(baseDelayMs * (2 ** attempt), 5_000), this.#lifetimeAbort.signal);
      if (this.#state !== "active" || this.#lifetimeAbort.signal.aborted) return;
      const outcome = await this.#attemptReconnect(tabId);
      if (outcome === "reattached" || outcome === "stopped") return;
      lastFailure = outcome.failure;
      if (lastFailure instanceof RuntimeBoundaryError && !lastFailure.retryable) break;
    }
    // The quick attempts are spent. Say why, and while slow attempts remain,
    // when the next one comes; then wait for it.
    let slowRemaining = isRetryableReconnectFailure(lastFailure)
      ? this.#options.reconnectSlowAttempts ?? DEFAULT_RECONNECT_SLOW_ATTEMPTS
      : 0;
    const slowDelayMs = this.#options.reconnectSlowDelayMs ?? DEFAULT_RECONNECT_SLOW_DELAY_MS;
    for (;;) {
      if (this.#state !== "active") return;
      this.#recoverableReconnectFailures.set(tabId, lastFailure ?? runtimeFailure(
        "terminal_disconnected",
        "Automatic terminal reconnection was exhausted.",
        { retryable: true },
      ));
      this.#browserNotice = reconnectFailedNotice(
        this.#recoverableReconnectFailures.get(tabId),
        slowRemaining > 0 ? slowDelayMs : undefined,
      );
      await this.#render();
      if (slowRemaining === 0) return;
      slowRemaining -= 1;
      await this.#slowReconnectWait(tabId, slowDelayMs);
      if (this.#state !== "active" || this.#lifetimeAbort.signal.aborted) return;
      // Left on purpose meanwhile (a confirmed detach forgets the failure).
      if (!this.#recoverableReconnectFailures.has(tabId) || this.#tabs.get(tabId)?.snapshot.state !== "interrupted") return;
      const outcome = await this.#attemptReconnect(tabId);
      if (outcome === "reattached" || outcome === "stopped") return;
      lastFailure = outcome.failure;
      if (!isRetryableReconnectFailure(lastFailure)) slowRemaining = 0;
    }
  }

  async #attemptReconnect(tabId: string): Promise<"reattached" | "stopped" | { readonly failure: unknown }> {
    try {
      const snapshot = await this.#requireRuntime().reconnect({ tabId, signal: this.#lifetimeAbort.signal });
      await this.#reconcileGeometry(snapshot, false);
      this.#recoverableReconnectFailures.delete(tabId);
      if (this.#browserNotice === INPUT_WITHHELD_NOTICE || this.#browserNotice === INPUT_STALLED_NOTICE ||
        isReconnectFailedNotice(this.#browserNotice)) {
        this.#browserNotice = undefined;
      }
      return "reattached";
    } catch (error) {
      if (this.#lifetimeAbort.signal.aborted || this.#state !== "active") return "stopped";
      return { failure: error };
    }
  }

  async #slowReconnectWait(tabId: string, delayMs: number): Promise<void> {
    const wake = new AbortController();
    const lifetime = this.#lifetimeAbort.signal;
    const forward = (): void => wake.abort();
    lifetime.addEventListener("abort", forward, { once: true });
    this.#slowReconnectWaits.set(tabId, { delayMs, wake: () => wake.abort() });
    try {
      await abortableDelay(delayMs, wake.signal);
    } finally {
      lifetime.removeEventListener("abort", forward);
      this.#slowReconnectWaits.delete(tabId);
    }
  }

  async #writeHost(bytes: Uint8Array): Promise<void> {
    if (!this.#mouseReportingPending) return await this.#options.host.write(bytes);
    const enable = new TextEncoder().encode(HOST_MOUSE_REPORTING_ON);
    const combined = new Uint8Array(enable.byteLength + bytes.byteLength);
    combined.set(enable);
    combined.set(bytes, enable.byteLength);
    await this.#options.host.write(combined);
    this.#mouseReportingPending = false;
  }

  #queueInput(bytes: Uint8Array): void {
    if (bytes.byteLength < 1) return;
    if (this.#options.mouseReporting === false) {
      this.#queueInputBytes(bytes);
      return;
    }
    // Mouse reports are Cuna's own input (host-mouse.ts): they are handled
    // here, in order with the keys around them, and never reach the key path.
    if (this.#hostMousePendingTimer !== undefined) clearTimeout(this.#hostMousePendingTimer);
    this.#hostMousePendingTimer = undefined;
    for (const segment of this.#hostMouse.push(bytes)) {
      if (segment.kind === "mouse") this.#handleHostMouse(segment.event);
      else this.#queueInputBytes(segment.bytes);
    }
    if (this.#hostMouse.needsIdleRelease) {
      const pendingTarget = this.#captureInputTarget();
      this.#hostMousePendingTimer = setTimeout(() => {
        this.#hostMousePendingTimer = undefined;
        const pending = this.#hostMouse.flushPending();
        const current = pendingTarget === undefined ? undefined : this.#tabs.get(pendingTarget.tabId)?.snapshot;
        if (pendingTarget !== undefined && (this.#activeTabId !== pendingTarget.tabId ||
          current === undefined || !sameSnapshotBinding(current, pendingTarget.binding))) return;
        this.#queueInputBytes(pending);
      }, HOST_INPUT_PREFIX_IDLE_MS);
      this.#hostMousePendingTimer.unref();
    }
  }

  /**
   * The wheel behaves as in a normal terminal, decided by the remote's own
   * modes (lead decision 2026-09-23):
   * - it asked for mouse reports: they are forwarded, in its coordinates and
   *   encoding;
   * - it is on its alternate screen without them (less, vim, man): three
   *   cursor keys per notch, as Windows Terminal's alternate-scroll mode sends;
   * - it is on its main screen (the agent's prompt, a shell): Cuna scrolls its
   *   own copy and sends nothing, so a notch never moves prompt history.
   * Only the writer sends; clicks go only to a remote that asked for them.
   */
  #handleHostMouse(event: HostMouseEvent): void {
    if (this.#state !== "active" || this.#closingTabId !== undefined || this.#switchCutoff !== undefined) return;
    const frame = this.#lastWorkbenchFrame;
    if (frame !== undefined && this.#lastHostFrame !== undefined && event.row <= frame.appbarRows) {
      if (!event.release && event.button === 0) {
        const hit = workbenchAppbarTargetAt(frame, event.column, event.row);
        const receipt = ++this.#inputReceipt;
        if (hit?.startsWith("session:")) {
          const entry = this.#rosterEntries().find((candidate) => `session:${candidate.agentSessionId}` === hit);
          if (entry !== undefined && this.#acceptSwitch(entry, receipt)) {
            this.#enqueueInputOperation(async () => await this.#detachTab(this.#activeTabId));
          }
        } else if (hit?.startsWith("tab:")) {
          const tabId = hit.slice("tab:".length);
          this.#enqueueInputOperation(async () => this.#select(tabId));
        }
      }
      return;
    }
    const tab = this.#activeTabId === undefined ? undefined : this.#tabs.get(this.#activeTabId);
    if (tab === undefined) return;
    const reporting = tab.viewport.mouseReporting();
    const target = this.#captureInputTarget();
    if (reporting.tracking !== "none" && tab.snapshot.accessMode !== "observer" && target !== undefined) {
      const hostRows = admitForegroundDimensions(this.#options.host.dimensions()).rows;
      const row = event.row - (hostRows - remoteRows(hostRows));
      if (row < 1 || row > remoteRows(hostRows)) return;
      const bytes = encodeRemoteMouse(event, reporting, { column: event.column, row });
      if (bytes === undefined) return;
      tab.viewport.resetScroll();
      this.#sendRemote(bytes, target);
      return;
    }
    const direction = wheelDirection(event);
    if (direction === 0) {
      this.#selectWithMouse(tab, event);
      return;
    }
    const screen = tab.viewport.screenModes();
    if (screen.alternateScreen) {
      if (tab.snapshot.accessMode === "observer" || target === undefined) return;
      const key = `\u001b${screen.applicationCursorKeys ? "O" : "["}${direction < 0 ? "A" : "B"}`;
      this.#sendRemote(new TextEncoder().encode(key.repeat(WHEEL_SCROLL_LINES)), target);
      return;
    }
    const before = tab.viewport.scrollOffset;
    if (tab.viewport.scrollBy(-direction * WHEEL_SCROLL_LINES) !== before) void this.#render().catch(() => undefined);
  }

  /**
   * A plain left drag selects, as in any terminal; release copies. A double
   * click selects the word or URL under it, and Ctrl+click opens a link. The
   * host sends these only because Cuna reports the mouse for its clickable
   * bar; Shift+drag still reaches the host's own selection. Reached only when
   * the remote program did not ask for the mouse, or this tab observes.
   */
  #selectWithMouse(tab: ForegroundTab, event: HostMouseEvent): void {
    const tabId = tab.intent.tabId;
    const button = event.button & ~(MOUSE_SHIFT | MOUSE_META | MOUSE_CONTROL | MOUSE_MOTION);
    if (button !== 0 || (event.button & MOUSE_SHIFT) !== 0) return;
    const selection = this.#selection?.tabId === tabId ? this.#selection : undefined;
    if (event.release) {
      if (selection === undefined || !selection.dragging) return;
      selection.dragging = false;
      if (!selection.word && selection.anchor.line === selection.focus.line && selection.anchor.column === selection.focus.column) {
        this.#selection = undefined;
        void this.#render().catch(() => undefined);
        return;
      }
      void this.#copySelection(tab, selection);
      return;
    }
    const point = this.#pointAt(tab, event);
    if (point === undefined) return;
    if ((event.button & MOUSE_MOTION) !== 0) {
      if (selection === undefined || !selection.dragging) return;
      selection.focus = point;
      void this.#render().catch(() => undefined);
      return;
    }
    if ((event.button & MOUSE_CONTROL) !== 0) {
      void this.#openLinkAt(tab, point);
      return;
    }
    const now = this.#inputClock();
    const previous = this.#lastPress;
    this.#lastPress = Object.freeze({ at: now, tabId, point });
    const word = previous !== undefined && previous.tabId === tabId && now - previous.at <= DOUBLE_CLICK_MS &&
      previous.point.line === point.line && previous.point.column === point.column
      ? tab.viewport.wordAt(point) : undefined;
    this.#selection = word === undefined
      ? { tabId, anchor: point, focus: point, dragging: true, word: false }
      : { tabId, anchor: word.start, focus: word.end, dragging: true, word: true };
    void this.#render().catch(() => undefined);
  }

  /** The VTE buffer cell drawn under a host cell of the viewport, if any. */
  #pointAt(tab: ForegroundTab, event: HostMouseEvent): BufferPoint | undefined {
    const frame = this.#lastWorkbenchFrame;
    if (frame === undefined) return undefined;
    const row = event.row - frame.appbarRows - 1;
    if (row < 0 || row >= frame.viewportRows) return undefined;
    const dimensions = admitForegroundDimensions(this.#options.host.dimensions());
    const width = Math.min(tab.viewport.columns, dimensions.columns);
    return Object.freeze({
      line: tab.viewport.viewTop(this.#viewProjection(tab, dimensions)) + row,
      column: Math.min(Math.max(0, event.column - 1), width - 1),
    });
  }

  /**
   * The host-sized window an active tab is painted through: an observer's
   * writer-sized screen or a view scrolled into history. Undefined paints the
   * live screen, which is already this host's size.
   */
  #viewProjection(tab: ForegroundTab, dimensions: { readonly columns: number; readonly rows: number }):
    { readonly columns: number; readonly rows: number } | undefined {
    return tab.snapshot.accessMode === "observer" || tab.viewport.scrollOffset > 0
      ? { columns: dimensions.columns, rows: remoteRows(dimensions.rows) }
      : undefined;
  }

  /** The selected cells, as ranges over the rows of the painted viewport. */
  #selectionRows(tab: ForegroundTab, dimensions: { readonly columns: number; readonly rows: number }): readonly WorkbenchSelectionRow[] | undefined {
    const selection = this.#selection;
    if (selection === undefined || selection.tabId !== tab.intent.tabId) return undefined;
    const [start, end] = orderBufferPoints(selection.anchor, selection.focus);
    const top = tab.viewport.viewTop(this.#viewProjection(tab, dimensions));
    const rows: WorkbenchSelectionRow[] = [];
    for (let row = 0; row < remoteRows(dimensions.rows); row += 1) {
      const line = top + row;
      if (line < start.line || line > end.line) continue;
      rows.push(Object.freeze({
        row,
        start: line === start.line ? start.column : 0,
        end: line === end.line ? end.column + 1 : tab.viewport.columns,
      }));
    }
    return Object.freeze(rows);
  }

  /**
   * Copies the selection the way Ctrl+] y copies a link, through this
   * computer's clipboard, and also offers it to the host terminal as OSC 52
   * so a Cuna run over SSH still reaches the person's own clipboard.
   */
  async #copySelection(tab: ForegroundTab, selection: ForegroundSelection): Promise<void> {
    const text = tab.viewport.textBetween(selection.anchor, selection.focus);
    if (text.length === 0) {
      this.#selection = undefined;
      await this.#render();
      return;
    }
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength <= MAX_OSC52_TEXT_BYTES) {
      const osc52 = new TextEncoder().encode(`\u001b]52;c;${Buffer.from(bytes).toString("base64")}\u0007`);
      const write = this.#renderTail.then(async () => await this.#writeHost(osc52));
      this.#renderTail = write.then(() => undefined, () => undefined);
      await write.catch(() => undefined);
    }
    try {
      await (this.#options.copyText ?? copyLocalText)(text);
      const characters = [...text].length;
      this.#browserNotice = `Copied ${characters} character${characters === 1 ? "" : "s"}`;
    } catch {
      this.#browserNotice = "Could not copy the selection. Shift+drag selects in the host terminal.";
    }
    await this.#render();
  }

  /**
   * Ctrl+C over a Cuna selection the viewport shows copies it and clears the
   * highlight, as a terminal's own selection does: nothing reaches the agent
   * and nothing detaches. Ctrl+Shift+C arrives as the same byte. A selection
   * scrolled out of view does not take the key the person cannot see it take.
   */
  #copyShownSelection(): boolean {
    const selection = this.#selection;
    const tab = selection === undefined || selection.tabId !== this.#activeTabId ? undefined : this.#tabs.get(selection.tabId);
    if (selection === undefined || tab === undefined) return false;
    const rows = this.#selectionRows(tab, admitForegroundDimensions(this.#options.host.dimensions()));
    if (rows === undefined || rows.length === 0) return false;
    this.#selection = undefined;
    void this.#copySelection(tab, selection).catch(() => undefined);
    return true;
  }

  /**
   * Ctrl+C reaches the agent only through this client's writer seat. An
   * observer, or a tab whose PTY input cannot reach it now, detaches instead.
   */
  #interruptDetaches(target: ForegroundInputTarget | undefined): boolean {
    return target === undefined || this.#tabs.get(target.tabId)?.snapshot.accessMode !== "writer";
  }

  /**
   * Ctrl+click on a link opens it in this computer's browser, resolved as
   * Ctrl+] y resolves it: the provider's OSC 8 target first, then the rows the
   * screen joins into one link, never one row of a longer link. A click on a
   * continuation row that the screen cannot join names the link it is part of.
   */
  async #openLinkAt(tab: ForegroundTab, point: BufferPoint): Promise<void> {
    const link = tab.viewport.linkAt(point);
    let target = link === undefined ? undefined : this.#exactLink(tab, link.url, false);
    if (target === undefined) {
      const word = tab.viewport.wordAt(point);
      const fragment = word === undefined ? "" : tab.viewport.textBetween(word.start, word.end);
      target = this.#linkContaining(tab, fragment);
    }
    let url: URL | undefined;
    try { url = target === undefined ? undefined : new URL(target); } catch { url = undefined; }
    if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:")) return;
    try {
      const browser = this.#options.browser;
      if (browser === undefined) throw new Error("browser unavailable");
      await browser.open(target as string);
      this.#browserNotice = `Opened ${url.origin} in your browser`;
    } catch {
      this.#browserNotice = "Could not open the link. Drag to select and copy it instead.";
    }
    await this.#render();
  }

  /**
   * The exact target for a link read from the screen or from the byte stream.
   * A provider OSC 8 target that is this link or continues it comes first.
   * A link a byte stream read is then extended by the rows the screen still
   * holds after it, because a program that wraps its own lines puts a row
   * break inside the URL. The link itself is the fallback.
   */
  #exactLink(tab: ForegroundTab, url: string, fromStream: boolean): string {
    const targets = (this.#copyDetectors.get(tab.intent.tabId) ?? []).flatMap((detector) => detector.hyperlinkTargets);
    const target = [...targets].reverse().find((candidate) => candidate === url || candidate.startsWith(url));
    if (target !== undefined) return target;
    return fromStream ? tab.viewport.extendLink(url) ?? url : url;
  }

  /** A known exact link that a piece of screen text is part of (16 characters or more). */
  #linkContaining(tab: ForegroundTab, fragment: string): string | undefined {
    if (fragment.length < 16 || /\s/u.test(fragment)) return undefined;
    const known = [
      ...(this.#copyDetectors.get(tab.intent.tabId) ?? []).flatMap((detector) => detector.hyperlinkTargets),
      ...[this.#copyLinks.get(tab.intent.tabId)?.url].filter((url): url is string => url !== undefined),
    ];
    return [...known].reverse().find((candidate) => candidate.includes(fragment));
  }

  /**
   * Link cells of the painted viewport, each with its exact target, so the
   * host terminal's own Ctrl+click (Windows Terminal opens a hovered link
   * before it reports the click) opens the whole link, not one row of it. A
   * target is the text drawn, joined across rows, or a provider's OSC 8
   * target that begins with it: never a destination the screen does not show.
   */
  #linkSpans(tab: ForegroundTab, dimensions: { readonly columns: number; readonly rows: number }): readonly WorkbenchLinkSpan[] {
    const projection = this.#viewProjection(tab, dimensions);
    const top = tab.viewport.viewTop(projection);
    const rows = remoteRows(dimensions.rows);
    const width = Math.min(tab.viewport.columns, dimensions.columns);
    const spans: WorkbenchLinkSpan[] = [];
    for (const link of tab.viewport.linksInView(projection)) {
      const uri = this.#exactLink(tab, link.url, false);
      if (!paintableLink(uri)) continue;
      spans.push(...linkRows(link, top, rows, width, tab.viewport.columns).map((span) => Object.freeze({ ...span, uri })));
    }
    return Object.freeze(spans);
  }

  #sendRemote(bytes: Uint8Array, target: ForegroundInputTarget): void {
    this.#flushInputBatch();
    if (this.#predictiveEcho.barrier()) void this.#render().catch(() => undefined);
    const operation = this.#inputTail.then(async () => {
      await this.#requireRuntime().sendInput(bytes, target.tabId, target.binding);
    });
    this.#inputTail = operation.catch((error) => this.#inputFailure(error, target));
  }

  #enqueueInputOperation(operation: () => Promise<void>): void {
    const next = this.#inputTail.then(operation);
    this.#inputTail = next.catch((error) => this.#inputFailure(error));
  }

  #queueInputBytes(bytes: Uint8Array): void {
    if (bytes.byteLength < 1) return;
    const receipt = ++this.#inputReceipt;
    if (this.#switchCutoff !== undefined) {
      if (bytes.includes(INTERRUPT)) this.#switchRequest = undefined;
      return;
    }
    if (bytes.byteLength === 1 && bytes[0] === INTERRUPT && this.#copyShownSelection()) return;
    if (this.#selection !== undefined) {
      // As in any terminal, typing ends the selection; its copy stays copied.
      this.#selection = undefined;
      void this.#render().catch(() => undefined);
    }
    const scrolled = this.#activeTabId === undefined ? undefined : this.#tabs.get(this.#activeTabId);
    if (scrolled !== undefined && scrolled.viewport.scrollOffset > 0) {
      // A key is typed at the live screen, so the view returns to it first.
      scrolled.viewport.resetScroll();
      void this.#render().catch(() => undefined);
    }
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
    const receiptBrowserAction = this.#browserActionFor(receiptTarget);
    const receiptBrowserActionGeneration = this.#browserActionGenerationFor(receiptTarget);
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
      this.#browserNotice = this.#unavailableInputNotice();
      void this.#render().catch(() => undefined);
      return;
    }
    // The optional predictor samples each key's echo latency; keep its input
    // frames separate so enabling prediction cannot change that measurement.
    const printable = this.#state === "active" && receiptTarget !== undefined &&
      this.#tabs.get(receiptTarget.tabId)?.snapshot.accessMode === "writer" &&
      payload.byteLength === 1 && payload[0]! >= 0x20 && payload[0]! <= 0x7e &&
      this.#predictiveEcho.mode === "off" &&
      !this.#pasteActive && this.#pasteStartMatch === 0 && this.#pasteEndMatch === 0 &&
      !this.#prefixPending && receiptBrowserAction === undefined &&
      !this.#oauthPasteGuards.has(receiptTarget.tabId);
    if (printable) {
      const now = this.#inputClock();
      const batch = this.#inputBatch;
      if (batch !== undefined && sameInputTarget(batch.target, receiptTarget) &&
        batch.browserActionGeneration === receiptBrowserActionGeneration) {
        batch.bytes.push(payload[0]!);
        this.#pendingInputBytes += 1;
        this.#lastPrintableAt = now;
        if (batch.bytes.length >= INPUT_BATCH_MAX_BYTES) this.#flushInputBatch();
        if (this.#predictAtReceipt(payload, receiptTarget, false)) void this.#render().catch(() => undefined);
        return;
      }
      this.#flushInputBatch();
      const closeToPrior = this.#lastPrintableAt !== undefined &&
        now - this.#lastPrintableAt <= INPUT_BURST_GAP_MS &&
        this.#lastPrintableTarget !== undefined &&
        sameInputTarget(this.#lastPrintableTarget, receiptTarget);
      this.#lastPrintableAt = now;
      this.#lastPrintableTarget = receiptTarget;
      if (closeToPrior) {
        const timer = setTimeout(() => this.#flushInputBatch(), INPUT_BATCH_WINDOW_MS);
        timer.unref?.();
        this.#inputBatch = {
          target: receiptTarget, bytes: [payload[0]!], receipt,
          browserActionGeneration: receiptBrowserActionGeneration,
          browserAction: receiptBrowserAction, timer,
        };
        this.#pendingInputBytes += 1;
        if (this.#predictAtReceipt(payload, receiptTarget, false)) void this.#render().catch(() => undefined);
        return;
      }
    } else {
      // Enter, Ctrl+C, prefixes, paste, resize and local-action input cannot
      // wait behind a timer or share a frame with printable bytes.
      this.#flushInputBatch();
      this.#lastPrintableAt = undefined;
      this.#lastPrintableTarget = undefined;
    }
    // Decided at receipt, on the seat the person saw when pressing the key.
    const interruptDetaches = this.#interruptDetaches(receiptTarget);
    if (
      payload.byteLength === 1 &&
      payload[0] === INTERRUPT &&
      interruptDetaches &&
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
    const barrierChunk = !payload.every(isPrintableAscii);
    if (barrierChunk) this.#unroutedBarrierChunks += 1;
    // Receipt time, not input-tail time: the guess is painted before the key
    // is even queued for the network.
    if (this.#predictAtReceipt(payload, receiptTarget, barrierChunk)) void this.#render().catch(() => undefined);
    this.#enqueueInput(payload, receiptTarget, receipt, barrierChunk, false,
      receiptBrowserActionGeneration, receiptBrowserAction, interruptDetaches);
  }

  #enqueueInput(
    payload: Uint8Array,
    receiptTarget: ForegroundInputTarget | undefined,
    receipt: number,
    barrierChunk = false,
    counted = false,
    browserActionGeneration = this.#browserActionGenerationFor(receiptTarget),
    browserAction = this.#browserActionFor(receiptTarget),
    interruptDetaches = this.#interruptDetaches(receiptTarget),
  ): void {
    if (!counted) this.#pendingInputBytes += payload.byteLength;
    const operation = this.#inputTail.then(async () => {
      try {
        await this.#routeInput(payload, receiptTarget, false, receipt,
          browserActionGeneration, browserAction, interruptDetaches);
      } finally {
        this.#pendingInputBytes -= payload.byteLength;
        if (barrierChunk) this.#unroutedBarrierChunks -= 1;
      }
    });
    this.#inputTail = operation.catch((error) => this.#inputFailure(error, receiptTarget));
  }

  #inputFailure(error: unknown, receiptTarget?: ForegroundInputTarget): void {
    if (error instanceof RuntimeBoundaryError && error.code === "grant_scope_mismatch" && receiptTarget !== undefined) {
      const snapshot = this.#tabs.get(receiptTarget.tabId)?.snapshot;
      if (snapshot === undefined || snapshot.state !== "active" || snapshot.accessMode !== "writer" ||
        snapshot.writerEpoch !== receiptTarget.binding.writerEpoch ||
        !sameSnapshotBinding(snapshot, receiptTarget.binding)) {
        if (this.#activeTabId === receiptTarget.tabId) {
          this.#browserNotice = BATCH_WITHHELD_NOTICE;
          void this.#render().catch(() => undefined);
        }
        return;
      }
    }
    if (error instanceof RuntimeBoundaryError && error.code === "terminal_observer") {
      // Typing into an observed terminal is refused, not fatal: the seat is
      // someone else's. Say so on the notice line and keep observing.
      const snapshot = this.#activeTabId === undefined ? undefined : this.#tabs.get(this.#activeTabId)?.snapshot;
      this.#seatNotice = snapshot === undefined ? "Read-only · input was not sent."
        : writerCapabilityRefusal(snapshot) ?? "Input not sent · press Ctrl+] then w to take control";
      this.#helpVisible = false;
      void this.#render().catch(() => undefined);
      return;
    }
    if (error instanceof RuntimeBoundaryError && (error.code === "terminal_disconnected" || error.code === "session_unknown")) {
      if (this.#pendingBrowserActionTabId === this.#activeTabId) {
        this.#pendingBrowserAction = undefined;
        this.#pendingBrowserActionTabId = undefined;
      }
      this.#browserNotice = this.#unavailableInputNotice();
      void this.#render().catch(() => undefined);
      return;
    }
    this.#recordFailure(error);
    void this.stop().catch(() => { this.#state = "failed"; });
  }

  #flushInputBatch(): void {
    const batch = this.#inputBatch;
    if (batch === undefined) return;
    this.#inputBatch = undefined;
    clearTimeout(batch.timer);
    this.#enqueueInput(Uint8Array.from(batch.bytes), batch.target, batch.receipt, false, true,
      batch.browserActionGeneration, batch.browserAction);
  }

  #discardInputBatch(): void {
    const batch = this.#inputBatch;
    if (batch === undefined) return;
    this.#inputBatch = undefined;
    clearTimeout(batch.timer);
    this.#pendingInputBytes -= batch.bytes.length;
    this.#lastPrintableAt = undefined;
    this.#lastPrintableTarget = undefined;
    if (this.#predictiveEcho.barrier()) void this.#render().catch(() => undefined);
  }

  async #routeInput(
    bytes: Uint8Array,
    receiptTarget: ForegroundInputTarget | undefined,
    releasedPrefix = false,
    receipt = 0,
    browserActionGeneration = this.#browserActionGenerationFor(receiptTarget),
    browserAction = this.#browserActionFor(receiptTarget),
    interruptDetaches = this.#interruptDetaches(receiptTarget),
  ): Promise<void> {
    // Received after a switch was chosen (a chord processed ahead of it in
    // this queue): never sent, to either session.
    if (this.#switchCutoff !== undefined && receipt > this.#switchCutoff) return;
    const runtime = this.#requireRuntime();
    // Permission keys are decisions only for the request already visible when
    // the user typed them. A queued key cannot approve a request that arrived
    // while an earlier send was blocked. Preserve explicit local detach/chords.
    if (!releasedPrefix &&
      (browserActionGeneration !== this.#browserActionGenerationFor(receiptTarget) ||
        browserAction !== this.#browserActionFor(receiptTarget)) &&
      !bytes.includes(INTERRUPT) && !bytes.includes(ESCAPE_PREFIX) && !this.#prefixPending) {
      this.#browserNotice = BROWSER_BATCH_WITHHELD_NOTICE;
      await this.#render();
      return;
    }
    if (bytes.includes(INTERRUPT)) {
      const currentAction = this.#browserActionFor(receiptTarget);
      const active = currentAction === undefined
        ? undefined
        : this.#localActionBroker.get(currentAction.id);
      if (active !== undefined) this.#localActionBroker.cancelBinding(active.request.identity, "user_interrupt");
      if (currentAction !== undefined) {
        this.#pendingBrowserAction = undefined;
        this.#pendingBrowserActionTabId = undefined;
      }
      this.#browserNotice = undefined;
    } else if (!releasedPrefix && !this.#prefixPending && !bytes.includes(ESCAPE_PREFIX) &&
      (await this.#routeRelayConsent(bytes, receiptTarget) || await this.#routeBrowserActionInput(bytes, receiptTarget))) {
      return;
    }
    const guarded = releasedPrefix ? { bytes, blocked: false } : this.#guardProviderOAuthPaste(bytes, receiptTarget);
    if (guarded.blocked) {
      this.#browserNotice = "That is the sign-in link, not the code. Approve access in the browser, then paste only the code shown on the final page.";
      await this.#render();
      return;
    }
    if (guarded.bytes.byteLength === 0) return;
    bytes = guarded.bytes;
    if (this.#browserNotice !== undefined) this.#browserNotice = undefined;
    this.#arrivalNotice = undefined;
    if (!releasedPrefix && bytes.byteLength === 1 && bytes[0] === INTERRUPT && !this.#prefixPending) {
      // A lone Ctrl+C is a key press, never part of a paste: it ends a paste
      // that never received its end marker, so Ctrl+] is a chord again.
      this.#pasteActive = false;
      this.#pasteStartMatch = 0;
      this.#pasteEndMatch = 0;
    }
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
        } else if (byte === INTERRUPT && interruptDetaches) {
          await flush();
          await this.#detachTab(target?.tabId);
          return;
        } else if (byte === ESCAPE_PREFIX) {
          await flush();
          this.#prefixPending = true;
          this.#prefixTarget = target;
          this.#prefixBrowserActionGeneration = browserActionGeneration;
          this.#prefixBrowserAction = browserAction;
        } else {
          remote.push(byte);
        }
        continue;
      }
      this.#prefixPending = false;
      const chordTarget = this.#prefixTarget;
      this.#prefixTarget = undefined;
      const staleChord = this.#prefixBrowserActionGeneration !== this.#browserActionGenerationFor(chordTarget) ||
        this.#prefixBrowserAction !== this.#browserActionFor(chordTarget);
      this.#prefixBrowserActionGeneration = undefined;
      this.#prefixBrowserAction = undefined;
      if (staleChord && byte !== DETACH && byte !== HELP && byte !== NEXT_TAB &&
        (byte < TAB_FIRST || byte > TAB_LAST)) {
        this.#browserNotice = BROWSER_BATCH_WITHHELD_NOTICE;
        await this.#render();
        continue;
      }
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
      } else if (this.#rosterActive() && ((byte >= TAB_FIRST && byte <= ROSTER_LAST) || byte === NEXT_TAB)) {
        await flush();
        const entries = this.#rosterEntries();
        const entry = byte === NEXT_TAB ? this.#nextRosterEntry(entries) : entries[byte - TAB_FIRST];
        if (entry === undefined) {
          this.#browserNotice = byte === NEXT_TAB ? "No other session to switch to" : `No session ${byte - TAB_FIRST + 1}`;
          this.#helpVisible = false;
          await this.#render();
          continue;
        }
        if (!this.#acceptSwitch(entry, receipt)) continue;
        // The rest of this chunk came after the choice: it is not sent.
        await this.#detachTab(this.#activeTabId);
        return;
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
        // The writer's one way out acknowledges itself as Ctrl+C does.
        const closing = chordTarget?.tabId ?? this.#activeTabId;
        if (closing !== undefined) {
          this.#closingTabId = closing;
          this.#disconnectNotice = DISCONNECTING_FRAMES[0];
        }
        await this.#detachTab(closing);
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
      } else if (byte === 0x79) {
        await flush();
        await this.#copySignInLink(chordTarget);
      } else if (byte === RETAINED_SIGN_IN) {
        await flush();
        await this.#requestRetainedSignIn();
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
      this.#browserNotice = request.id === this.#retainedPendingRequestId
        ? "Local permission expired · Ctrl+] a to inspect again · request a new link if the provider rejects it"
        : "Browser authentication request expired. Retry from the provider.";
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

  /**
   * A sign-in request read from the byte stream may be one row of a URL the
   * provider wrapped itself. Open the whole link the screen holds, only when
   * it continues the approved request and passes the same provider check.
   * Requests the remote bridge sent carry their exact URL already.
   */
  #exactRequestUrl(request: LocalBrowserActionRequest): string {
    if (request.type !== "browser.open" || this.#remoteLocalActionTabs.has(request.id)) return request.url;
    const tab = [...this.#tabs.values()].find((candidate) => candidate.snapshot.agentSessionId === request.agentSessionId &&
      candidate.snapshot.fencingGeneration === request.fencingGeneration);
    if (tab === undefined) return request.url;
    const exact = this.#exactLink(tab, request.url, true);
    return exact.startsWith(request.url) && admitProviderAuthUrl(request.provider, exact) !== undefined ? exact : request.url;
  }

  async #openBrowser(request: LocalBrowserActionRequest): Promise<void> {
    try {
      const browser = this.#options.browser;
      if (browser === undefined) throw new Error("browser unavailable");
      await browser.open(this.#exactRequestUrl(request));
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
        this.#browserNotice = request.id === this.#retainedPendingRequestId
          ? "Retained link opened · validity unknown · if rejected, request a new sign-in link in the provider terminal"
          : "Browser opened locally. Complete authentication there, then return here.";
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

  async #copySignInLink(target: ForegroundInputTarget | undefined): Promise<void> {
    const tab = target === undefined ? undefined : this.#tabs.get(target.tabId);
    const link = target === undefined ? undefined : this.#copyLinks.get(target.tabId);
    if (target === undefined || target.tabId !== this.#activeTabId || tab === undefined || link === undefined ||
        link.agentSessionId !== tab.snapshot.agentSessionId || link.processEpoch !== tab.snapshot.processEpoch ||
        link.fencingGeneration !== tab.snapshot.fencingGeneration) {
      this.#browserNotice = "No sign-in link available. Request a new link in the agent.";
    } else {
      try {
        await (this.#options.copyText ?? copyLocalText)(this.#exactLink(tab, link.url, true));
        this.#browserNotice = "Full link copied. Paste it into your browser.";
      } catch {
        this.#browserNotice = "Could not copy the link. Try again.";
      }
    }
    await this.#render();
  }

  async #requestRetainedSignIn(): Promise<void> {
    const tabId = this.#activeTabId;
    const tab = tabId === undefined ? undefined : this.#tabs.get(tabId);
    const candidate = tabId === undefined ? undefined : this.#retainedBrowserCandidates.get(tabId);
    if (tabId === undefined || tab === undefined || this.#pendingBrowserAction !== undefined) return;
    if (candidate === undefined || candidate.fencingGeneration !== tab.snapshot.fencingGeneration ||
      candidate.agentSessionId !== tab.snapshot.agentSessionId || candidate.processEpoch !== tab.snapshot.processEpoch) {
      this.#browserNotice = "No retained sign-in link. Request a new link in the provider terminal.";
      await this.#render();
      return;
    }
    // Renew only the local permission request, never the provider challenge.
    // Re-admit the URL against the provider allowlist and current binding.
    const detector = new ProviderBrowserActionDetector({
      provider: candidate.provider, agentSessionId: candidate.agentSessionId,
      processEpoch: candidate.processEpoch, fencingGeneration: candidate.fencingGeneration, clock: this.#clock,
    });
    // The retained URL is complete; the line end says so to a detector that
    // holds back a URL which might still be arriving.
    const request = detector.push(new TextEncoder().encode(`${candidate.url}\n`))[0];
    if (request !== undefined) {
      this.#handledBrowserUrls.delete(this.#browserRequestKey(request));
      this.#enqueueBrowserAction(tabId, tab, request);
      this.#retainedPendingRequestId = request.id;
      this.#promoteBrowserAction();
    }
    await this.#render();
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
      this.#setOAuthPasteGuard(tabId, new ProviderOAuthPasteGuard(request));
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
    if (event.frame.type === "local_stream_close") {
      this.#relayStreamClosed(event.tabId, event.payload);
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
    } else if (request.kind === "auth.callback.relay" && request.provider === "codex") {
      await this.#admitCallbackRelay(event.tabId, request);
      return;
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
      this.#setOAuthPasteGuard(event.tabId, new ProviderOAuthPasteGuard(browserRequest));
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

  /** Admits the supervisor's sign-in relay request and asks the person first. */
  async #admitCallbackRelay(tabId: string, request: LocalActionRequest): Promise<void> {
    const localPath = request.arguments.localPath;
    const exactLocalPort = request.arguments.exactLocalPort;
    if (typeof localPath !== "string" || typeof exactLocalPort !== "number" || exactLocalPort < 1_024) {
      throw runtimeFailure("terminal_protocol_error", "The sign-in relay request is malformed.");
    }
    this.#remoteLocalActionTabs.set(request.id, tabId);
    const consent: CallbackRelayConsent = Object.freeze({ tabId, request, localPath, exactLocalPort });
    this.#relayRequests.set(request.id, consent);
    let admitted: LocalActionSnapshot;
    try {
      admitted = this.#localActionBroker.submit(request);
    } catch (error) {
      this.#remoteLocalActionTabs.delete(request.id);
      this.#relayRequests.delete(request.id);
      throw error;
    }
    if (["succeeded", "failed", "denied", "expired", "cancelled"].includes(admitted.state)) {
      this.#relayRequests.delete(request.id);
      this.#queueRemoteLocalActionResult(admitted);
      return;
    }
    this.#promoteBrowserAction();
    await this.#render();
  }

  /** Enter allows the relay at the head of the queue, Esc denies it; any other key is the program's. */
  async #routeRelayConsent(bytes: Uint8Array, target: ForegroundInputTarget | undefined): Promise<boolean> {
    const consent = this.#pendingRelay;
    if (consent === undefined || target === undefined || target.tabId !== consent.tabId || target.tabId !== this.#activeTabId) return false;
    if (bytes.byteLength !== 1 || (bytes[0] !== 0x0d && bytes[0] !== 0x1b)) return false;
    const allow = bytes[0] === 0x0d;
    this.#pendingRelay = undefined;
    let decided: LocalActionSnapshot | undefined;
    try {
      decided = this.#localActionBroker.decide(consent.request.id, allow);
    } catch {
      decided = undefined;
    }
    if (!allow || decided?.state !== "executing") {
      this.#browserNotice = allow
        ? "The sign-in request expired · start the sign-in again in Codex"
        : `Codex's sign-in callback will not be received on this computer · Sign in with Device Code works without it`;
      this.#promoteBrowserAction();
      await this.#render();
      return true;
    }
    this.#browserNotice = `Waiting for Codex's sign-in on 127.0.0.1:${consent.exactLocalPort} · open the sign-in link in your browser`;
    await this.#render();
    void this.#runCallbackRelay(consent).catch(() => undefined);
    return true;
  }

  /**
   * Listens on 127.0.0.1:<port> for exactly one callback until the request's
   * deadline, hands it to the Machine, and settles the request with what the
   * Machine answered. The code and state are never shown or logged.
   */
  async #runCallbackRelay(consent: CallbackRelayConsent): Promise<void> {
    const { request } = consent;
    const port = consent.exactLocalPort;
    const deadline = request.arguments.deadlineMs;
    let handle: CallbackRelayHandle;
    try {
      handle = await startCallbackRelay({
        provider: "codex",
        localHost: "127.0.0.1",
        exactLocalPort: port,
        localPath: consent.localPath,
        expectedStateDigest: request.arguments.expectedStateDigest as `sha256:${string}`,
        expectedNonceDigest: request.arguments.expectedNonceDigest as `sha256:${string}`,
        requestNonce: request.nonce,
        deadlineMs: Math.min(typeof deadline === "number" ? deadline : request.expiresAt, request.expiresAt),
        maxAttempts: 8,
        maxConnections: 16,
        relay: async (callback, signal) => await this.#sendCallbackToMachine(consent, callback, signal),
        signal: this.#lifetimeAbort.signal,
        now: this.#clock,
      });
    } catch (error) {
      this.#browserNotice = (error as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE"
        ? `Port ${port} is in use on this computer · close what uses it, or choose Sign in with Device Code in Codex`
        : `Cuna could not listen on 127.0.0.1:${port} for Codex's sign-in`;
      this.#settleRelay(consent, "failed", "adapter_failed");
      await this.#render().catch(() => undefined);
      return;
    }
    this.#relayHandles.set(request.id, handle);
    try {
      const receipt = await handle.completion;
      this.#browserNotice = receipt.answer === "delivered"
        ? "Sent to Codex on your Machine · finish the sign-in in the terminal"
        : receipt.answer === "refused"
          ? "Codex on your Machine refused this sign-in · start the sign-in again in Codex"
          : "Your Machine did not answer this sign-in in time · start the sign-in again in Codex";
      this.#settleRelay(consent, receipt.answer === "delivered" ? "succeeded" : "failed",
        receipt.answer === "delivered" ? undefined : receipt.answer === "refused" ? "adapter_failed" : "execution_timeout");
    } catch {
      if (this.#localActionBroker.get(request.id)?.result === undefined) {
        this.#browserNotice = "Codex's sign-in did not arrive in time · start the sign-in again in Codex";
        this.#settleRelay(consent, "failed", "request_expired");
      }
    } finally {
      this.#relayHandles.delete(request.id);
      await this.#render().catch(() => undefined);
    }
  }

  /**
   * One local_to_remote stream carries exactly `GET <path>?<query>`; the
   * supervisor makes that request on the Machine's loopback and answers by
   * closing the stream: completed, failed or expired.
   */
  async #sendCallbackToMachine(
    consent: CallbackRelayConsent,
    callback: AcceptedProviderCallback,
    signal: AbortSignal,
  ): Promise<CallbackRelayAnswer> {
    const query = `state=${encodeURIComponent(callback.state)}&` + (callback.code === undefined
      ? `error=${encodeURIComponent(callback.error ?? "")}`
      : `code=${encodeURIComponent(callback.code)}`);
    const line = Buffer.from(`GET ${consent.localPath}?${query}`, "utf8");
    const streamId = `relay:${consent.request.id}`;
    const answered = new Promise<CallbackRelayAnswer>((resolve) => {
      this.#relayStreams.set(streamId, Object.freeze({ tabId: consent.tabId, length: line.byteLength, resolve }));
    });
    const runtime = this.#requireRuntime();
    try {
      await runtime.sendLocalActionControl("local_stream_open", {
        streamId, requestId: consent.request.id, direction: "local_to_remote", initialCreditBytes: RELAY_STREAM_CREDIT_BYTES,
      }, consent.tabId);
      await runtime.sendLocalActionControl("local_stream_data", {
        streamId, offset: 0, bytesBase64url: line.toString("base64url"), decodedLength: line.byteLength,
        chunkSha256: createHash("sha256").update(line).digest("hex"),
      }, consent.tabId);
    } catch {
      this.#relayStreams.delete(streamId);
      return "no_answer";
    }
    const timedOut = abortableDelay(this.#options.relayAnswerTimeoutMs ?? RELAY_ANSWER_TIMEOUT_MS, signal)
      .then(() => undefined, () => undefined);
    const answer = await Promise.race([answered, timedOut]);
    if (answer !== undefined) return answer;
    // No answer: the stream is closed from this side so the request can settle.
    this.#relayStreams.delete(streamId);
    await runtime.sendLocalActionControl("local_stream_close", {
      streamId, finalOffset: line.byteLength, reason: "expired",
    }, consent.tabId).catch(() => undefined);
    return "no_answer";
  }

  /** The supervisor's answer to a relayed callback: how it closed the stream. */
  #relayStreamClosed(tabId: string, payload: Readonly<Record<string, unknown>>): void {
    const streamId = String(payload.streamId);
    const wait = this.#relayStreams.get(streamId);
    if (wait === undefined || wait.tabId !== tabId) return;
    this.#relayStreams.delete(streamId);
    wait.resolve(payload.finalOffset !== wait.length ? "no_answer"
      : payload.reason === "completed" ? "delivered"
        : payload.reason === "failed" ? "refused" : "no_answer");
  }

  #settleRelay(consent: CallbackRelayConsent, status: "succeeded" | "failed", safeReason?: LocalActionSafeReason): void {
    try {
      this.#localActionBroker.complete(consent.request.id, consent.request.identity, status,
        status === "succeeded" ? { awaitingProvider: true } : undefined, safeReason);
    } catch {
      // A request the broker already ended (expired, cancelled) keeps that result.
    }
  }

  /** A relay request that ended for any reason stops listening at once. */
  #endRelay(requestId: string): void {
    if (!this.#relayRequests.delete(requestId)) return;
    if (this.#pendingRelay?.request.id === requestId) this.#pendingRelay = undefined;
    const handle = this.#relayHandles.get(requestId);
    this.#relayHandles.delete(requestId);
    void handle?.close("ended").catch(() => undefined);
  }

  #promoteBrowserAction(): void {
    const current = this.#localActionBroker.current();
    // The queue answers one request at a time; a sign-in relay at its head
    // gets the bar's question instead of a browser action.
    this.#pendingRelay = current?.state === "pending_user" ? this.#relayRequests.get(current.request.id) : undefined;
    if (current?.state !== "pending_user" || this.#pendingRelay !== undefined) {
      if (this.#pendingBrowserActionTabId !== undefined) {
        this.#advanceBrowserActionGeneration(this.#pendingBrowserActionTabId);
      }
      this.#pendingBrowserAction = undefined;
      this.#pendingBrowserActionTabId = undefined;
      return;
    }
    const request = this.#browserRequests.get(current.request.id);
    if (request === undefined) return;
    const tabId = [...this.#tabs.entries()].find(([, tab]) =>
      tab.snapshot.agentSessionId === request.agentSessionId &&
      tab.snapshot.processEpoch === request.processEpoch &&
      tab.snapshot.fencingGeneration === request.fencingGeneration)?.[0];
    if (this.#pendingBrowserAction !== request || this.#pendingBrowserActionTabId !== tabId) {
      if (this.#pendingBrowserActionTabId !== undefined) {
        this.#advanceBrowserActionGeneration(this.#pendingBrowserActionTabId);
      }
      if (tabId !== undefined && tabId !== this.#pendingBrowserActionTabId) {
        this.#advanceBrowserActionGeneration(tabId);
      }
    }
    const withheld = this.#inputBatch?.target.tabId === tabId;
    if (withheld) this.#discardInputBatch();
    this.#pendingBrowserAction = request;
    this.#pendingBrowserActionTabId = tabId;
    this.#browserNotice = withheld ? BROWSER_BATCH_WITHHELD_NOTICE : undefined;
  }

  #browserActionFor(target: ForegroundInputTarget | undefined): LocalBrowserActionRequest | undefined {
    return target?.tabId === this.#pendingBrowserActionTabId ? this.#pendingBrowserAction : undefined;
  }

  #browserActionGenerationFor(target: ForegroundInputTarget | undefined): number {
    return target === undefined ? 0 : this.#browserActionGenerations.get(target.tabId) ?? 0;
  }

  #advanceBrowserActionGeneration(tabId: string): void {
    this.#browserActionGenerations.set(tabId, (this.#browserActionGenerations.get(tabId) ?? 0) + 1);
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

  #setOAuthPasteGuard(tabId: string, guard?: ProviderOAuthPasteGuard): void {
    if (this.#activeTabId === tabId && this.#hostMouse.hasPending) {
      if (this.#hostMousePendingTimer !== undefined) clearTimeout(this.#hostMousePendingTimer);
      this.#hostMousePendingTimer = undefined;
      this.#hostMouse.flushPending();
    }
    const timer = this.#oauthPrefixTimers.get(tabId);
    if (timer !== undefined) clearTimeout(timer);
    this.#oauthPrefixTimers.delete(tabId);
    this.#oauthPasteGuards.get(tabId)?.reset();
    if (guard === undefined) this.#oauthPasteGuards.delete(tabId);
    else this.#oauthPasteGuards.set(tabId, guard);
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
    const previousTimer = this.#oauthPrefixTimers.get(target.tabId);
    if (!guard.hasPendingPrefix && previousTimer !== undefined) {
      clearTimeout(previousTimer);
      this.#oauthPrefixTimers.delete(target.tabId);
    } else if (this.#state === "active" && guard.hasPendingPrefix && previousTimer === undefined) {
      const browserAction = this.#browserActionFor(target);
      const browserActionGeneration = this.#browserActionGenerationFor(target);
      const receipt = this.#inputReceipt;
      const timer = setTimeout(() => {
        this.#oauthPrefixTimers.delete(target.tabId);
        const operation = this.#inputTail.then(async () => {
          const tab = this.#tabs.get(target.tabId);
          if (this.#state !== "active" || this.#switchCutoff !== undefined || tab === undefined || tab.snapshot.state !== "active" || this.#activeTabId !== target.tabId ||
            this.#oauthPasteGuards.get(target.tabId) !== guard || !sameSnapshotBinding(tab.snapshot, target.binding) ||
            tab.snapshot.writerEpoch !== target.binding.writerEpoch) return;
          if (browserActionGeneration !== this.#browserActionGenerationFor(target) ||
            browserAction !== this.#browserActionFor(target)) {
            guard.releasePendingPrefix();
            this.#browserNotice = BROWSER_BATCH_WITHHELD_NOTICE;
            await this.#render();
            return;
          }
          const prefix = guard.releasePendingPrefix();
          if (prefix.byteLength > 0) await this.#routeInput(prefix, target, true,
            receipt, browserActionGeneration, browserAction);
        });
        this.#inputTail = operation.catch((error) => {
          if (error instanceof RuntimeBoundaryError &&
            ["session_unknown", "terminal_disconnected", "terminal_observer"].includes(error.code)) return;
          this.#recordFailure(error);
          void this.stop().catch(() => { this.#state = "failed"; });
        });
      }, 35);
      timer.unref?.();
      this.#oauthPrefixTimers.set(target.tabId, timer);
    }
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

  /** The roster names the bar only for a one-session run whose session it lists. */
  #rosterActive(): boolean {
    const activeSessionId = this.#activeSessionId();
    return this.#options.sessionRoster !== undefined && this.#tabs.size === 1 && activeSessionId !== undefined &&
      this.#rosterEntries().some((entry) => entry.agentSessionId === activeSessionId);
  }

  #rosterEntries(): readonly SessionRosterEntry[] {
    return this.#options.sessionRoster?.entries() ?? [];
  }

  #activeSessionId(): string | undefined {
    return this.#activeTabId === undefined ? undefined : this.#tabs.get(this.#activeTabId)?.intent.agentSessionId;
  }

  #nextRosterEntry(entries: readonly SessionRosterEntry[]): SessionRosterEntry | undefined {
    const current = entries.findIndex((entry) => entry.agentSessionId === this.#activeSessionId());
    for (let step = 1; step < entries.length; step += 1) {
      const entry = entries[(current + step) % entries.length];
      if (entry !== undefined && !entry.ended) return entry;
    }
    return undefined;
  }

  /**
   * Decide a switch at the moment it is chosen. A refusal only says why, and
   * nothing is detached. An accepted switch fixes the input cutoff here, so the
   * caller's detach is the next and last thing this run does with the session.
   */
  #acceptSwitch(entry: SessionRosterEntry, receipt: number): boolean {
    const name = `${rosterAgentName(entry.agent)} ${entry.label}`.trim();
    const refusal = entry.agentSessionId === this.#activeSessionId()
      ? `Already on ${name}`
      : entry.ended ? `${name} ended · it cannot be attached` : undefined;
    if (refusal !== undefined) {
      this.#browserNotice = refusal;
      this.#helpVisible = false;
      void this.#render().catch(() => undefined);
      return false;
    }
    if (this.#state !== "active" || this.#switchCutoff !== undefined || this.#tabs.size !== 1 ||
        this.#closingTabId !== undefined) return false;
    this.#flushInputBatch();
    this.#switchCutoff = receipt;
    this.#switchRequest = Object.freeze({ agentSessionId: entry.agentSessionId, agent: entry.agent, label: entry.label });
    this.#predictiveEcho.barrier();
    // Nothing of the departing session's input state may follow the person.
    this.#prefixPending = false;
    this.#prefixTarget = undefined;
    this.#helpVisible = false;
    this.#switchNotice = `Switching to ${name}… · ${SWITCH_INPUT_NOTICE}`;
    void this.#render().catch(() => undefined);
    return true;
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
    this.#selection = undefined;
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
    // above must never be announced as a session that keeps running, and
    // neither may one whose process the server says ended.
    const ended = this.#endedTabs.get(tabId);
    this.#endedTabs.delete(tabId);
    if (departing !== undefined && ended !== undefined) {
      this.#endedSessions.push(Object.freeze({
        agentSessionId: departing.intent.agentSessionId,
        label: departing.intent.label,
        agent: departing.intent.agent,
        ...(ended.status === undefined ? {} : { status: ended.status }),
      }));
    } else if (departing !== undefined) {
      this.#detachedSessions.push(Object.freeze({
        agentSessionId: departing.intent.agentSessionId,
        label: departing.intent.label,
      }));
    }
    // A reconnect that failed earlier on this tab was the tab's state, not the
    // run's outcome, and the person has now left the tab on purpose. Kept, it
    // outlived the confirmed detach and `failure` handed it to the runner as the
    // run's failure. On 2026-09-28 a `Ctrl+] d` after 8.5 min attached printed
    // "This AgentSession's terminal cannot be recovered" for AgentSession
    // f3cd5d5c, which reattached a minute later; a stored reconnect refusal is
    // the path from a confirmed detach to that message.
    this.#recoverableReconnectFailures.delete(tabId);
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
    this.#copyDetectors.delete(tabId);
    this.#copyLinks.delete(tabId);
    this.#retainedBrowserDetectors.delete(tabId);
    this.#retainedBrowserCandidates.delete(tabId);
    if (this.#pendingBrowserActionTabId === tabId) {
      this.#pendingBrowserAction = undefined;
      this.#pendingBrowserActionTabId = undefined;
      this.#browserNotice = undefined;
    }
    this.#setOAuthPasteGuard(tabId);

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

  #unavailableInputNotice(): string {
    const tab = this.#activeTabId === undefined ? undefined : this.#tabs.get(this.#activeTabId);
    const end = this.#activeTabId === undefined ? undefined : this.#endedTabs.get(this.#activeTabId);
    if (tab !== undefined && end !== undefined) return this.#endedNotice(tab, end);
    const failure = this.#activeTabId === undefined ? undefined : this.#recoverableReconnectFailures.get(this.#activeTabId);
    return failure === undefined
      ? INPUT_WITHHELD_NOTICE
      : reconnectFailedNotice(failure, this.#slowReconnectWaits.get(this.#activeTabId ?? "")?.delayMs);
  }

  #captureInputTarget(): ForegroundInputTarget | undefined {
    const tabId = this.#activeTabId;
    if (tabId === undefined) return undefined;
    const tab = this.#tabs.get(tabId);
    // An ended tab has no process to send to: its keys get the ended notice,
    // and Ctrl+C leaves it.
    if (tab === undefined || tab.snapshot.state !== "active" || tab.snapshot.terminalView?.ready === false ||
      this.#endedTabs.has(tabId)) return undefined;
    return Object.freeze({
      tabId,
      binding: Object.freeze({
        userId: tab.snapshot.userId,
        machineId: tab.snapshot.machineId,
        agentSessionId: tab.snapshot.agentSessionId,
        processEpoch: tab.snapshot.processEpoch,
        fencingGeneration: tab.snapshot.fencingGeneration,
        writerEpoch: tab.snapshot.writerEpoch,
      }),
    });
  }

  /**
   * Guess the echo of a printable chunk typed into the active writer's input
   * line. Anything the local router or the remote may treat specially -- a
   * chord, a paste, a pending browser action, an OAuth code prompt, an
   * observer seat, uncertain earlier input -- withdraws guesses instead.
   * Returns whether the painted frame may have changed.
   */
  #predictAtReceipt(payload: Uint8Array, target: ForegroundInputTarget | undefined, barrierChunk: boolean): boolean {
    const echo = this.#predictiveEcho;
    if (echo.mode === "off") return false;
    if (barrierChunk) return echo.barrier();
    const tab = target === undefined ? undefined : this.#tabs.get(target.tabId);
    if (
      tab === undefined ||
      tab.intent.tabId !== this.#activeTabId ||
      this.#unroutedBarrierChunks > 0 ||
      this.#prefixPending ||
      this.#pasteActive ||
      this.#closingTabId !== undefined ||
      this.#pendingBrowserAction !== undefined ||
      this.#oauthPasteGuards.has(tab.intent.tabId) ||
      tab.snapshot.state !== "active" ||
      tab.snapshot.accessMode !== "writer" ||
      tab.snapshot.historicalInputUncertainty === true ||
      tab.snapshot.terminalView?.ready === false
    ) return echo.barrier();
    const view = tab.viewport.snapshot();
    return echo.predict(payload, view, predictionKey(tab, view));
  }

  #queueResize(): void {
    if (this.#state !== "active") return;
    this.#flushInputBatch();
    this.#resizeInputBarrier = this.#inputTail;
    // Output also requests reconciliation while geometry differs. Preserve the
    // first deadline so continuous output cannot postpone every paint; the
    // callback reads the latest host dimensions when it runs.
    if (this.#resizeTimer !== undefined) return;
    this.#resizeTimer = setTimeout(() => {
      this.#resizeTimer = undefined;
      const priorInput = this.#resizeInputBarrier;
      this.#resizeInputBarrier = undefined;
      void Promise.resolve(priorInput).then(() => this.#applyResize()).catch((error) => {
        this.#recordFailure(error);
        void this.stop().catch(() => { this.#state = "failed"; });
      });
    }, this.#options.resizeCoalesceMs);
    this.#resizeTimer.unref();
  }

  async #applyResize(): Promise<void> {
    // The host reflows or clears its alternate screen on resize; the last
    // frame no longer describes what it shows. A reflow also moves the cells
    // a selection names.
    this.#lastHostFrame = undefined;
    this.#selection = undefined;
    const dimensions = admitForegroundDimensions(this.#options.host.dimensions());
    const rows = remoteRows(dimensions.rows);
    for (const [tabId, tab] of this.#tabs) {
      if (tab.snapshot.accessMode !== "observer") await tab.viewport.resize(dimensions.columns, rows);
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

  /**
   * Push this host's geometry to the PTY after the writer seat moves here.
   * `#terminalState` is synchronous, so the reconciliation runs as its own
   * guarded task; a refusal is reported like any other terminal failure and
   * never silently leaves the viewport claiming a size the PTY does not have.
   */
  #reconcileSeatGeometry(snapshot: RuntimeTerminalSnapshot): void {
    void this.#reconcileGeometry(snapshot, false).then(
      () => this.#queueStateRender(),
      (error) => {
        if (this.#state !== "active") return;
        if (error instanceof RuntimeBoundaryError && (error.code === "terminal_observer" || error.code === "terminal_disconnected")) return;
        this.#recordFailure(error);
      },
    );
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
    // Canonical views supply a complete fresh rendering stream. Legacy repaint
    // input must not enter their provider, especially before view readiness.
    if (repaintAfterReplay && snapshot.terminalView === undefined) {
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
    if (repaintAfterReplay && snapshot.terminalView === undefined) {
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
        (this.#tabs.get(activeTabId)?.snapshot.accessMode !== "observer" &&
          (activeViewport.columns !== dimensions.columns || activeViewport.rows !== remoteRows(dimensions.rows)))
      ) {
        // A host resize becomes observable before the coalesced local VTE and
        // remote PTY resize completes. Rendering the old, wider viewport into
        // the new frame would either clip trusted state or reject a valid row
        // as oversized. Keep the last complete frame visible; #applyResize
        // renders again after every viewport reaches the admitted dimensions.
        this.#queueResize();
        return;
      }
      // An observer's VTE holds the writer's geometry; whatever it has beyond
      // this window's width is cut from every row that reaches that far.
      const hiddenColumns = this.#tabs.get(activeTabId)?.snapshot.accessMode === "observer"
        ? Math.max(0, activeViewport.columns - dimensions.columns) : 0;
      const tabs = [...this.#tabs.values()].map((tab): WorkbenchTab => {
        const ended = this.#endedTabs.has(tab.intent.tabId);
        // Hidden tabs contribute labels only; projecting their cells would
        // recapture a full terminal on every visible output frame. A view the
        // person scrolled back is projected from local history.
        const viewport = tab.intent.tabId === activeTabId && this.#viewProjection(tab, dimensions) !== undefined
          ? tab.viewport.snapshotForHost(dimensions.columns, remoteRows(dimensions.rows))
          : tab.viewport.snapshot();
        return Object.freeze({
          id: tab.intent.tabId,
          label: ended ? `${tab.intent.label} · ended` : tab.intent.label,
          agent: tab.intent.agent,
          // The bar says the process ended; tmux's own line for it is not shown.
          viewport: ended ? withoutPaneDeathRow(viewport) : viewport,
        });
      });
      const shownTab = this.#tabs.get(activeTabId);
      const selection = shownTab === undefined ? undefined : this.#selectionRows(shownTab, dimensions);
      const links = shownTab === undefined ? undefined : this.#linkSpans(shownTab, dimensions);
      // Drags go to the remote only for a writer whose program asked for the
      // mouse; then the host's Shift+drag is the one way to select.
      const remoteMouse = shownTab !== undefined && shownTab.snapshot.accessMode !== "observer" &&
        shownTab.viewport.mouseReporting().tracking !== "none";
      const attention = this.#attentionLine();
      const trueFrame = renderWorkbenchFrame({
        columns: dimensions.columns,
        rows: dimensions.rows,
        activeTabId,
        tabs,
        ...(this.#copyLinks.has(activeTabId) ? { action: "Copy link · Ctrl+] y" } : {}),
        ...(this.#rosterActive()
          ? { sessions: this.#rosterEntries(), activeSessionId: this.#activeSessionId() as string }
          : {}),
        ...(this.#options.mouseReporting === true ? { mouseReporting: true } : {}),
        ...(remoteMouse ? { remoteMouse: true } : {}),
        ...(selection === undefined || selection.length === 0 ? {} : { selection }),
        ...(links === undefined || links.length === 0 ? {} : { links }),
        appbar: this.#options.appbar?.() ?? runtimeAppbar(
          this.#clock(),
          this.#tabs.get(activeTabId)?.snapshot,
          this.#tabs.get(activeTabId)?.intent,
          this.#tabs.get(activeTabId)?.providerAuthentication,
        ),
        color: this.#options.color ?? true,
        ...(this.#disconnectNotice !== undefined
          ? { notice: this.#disconnectNotice }
          : this.#switchNotice !== undefined
            ? { notice: this.#switchNotice }
          : this.#endedTabs.has(activeTabId) && this.#tabs.has(activeTabId)
            ? { notice: this.#endedNotice(this.#tabs.get(activeTabId)!, this.#endedTabs.get(activeTabId)!) }
          : this.#pendingRelay !== undefined && this.#pendingRelay.tabId === activeTabId
            ? { notice: `Codex asks to receive its sign-in on 127.0.0.1:${this.#pendingRelay.exactLocalPort} · Enter allow · Esc deny` }
          : this.#tabs.get(activeTabId)?.snapshot.state === "active" && this.#tabs.get(activeTabId)?.snapshot.terminalView?.ready === false
            ? { notice: "Restoring terminal\u2026" }
          : this.#browserNotice !== undefined
            ? { notice: this.#tabs.get(activeTabId)?.snapshot.historicalInputUncertainty === true &&
                (this.#browserNotice === INPUT_WITHHELD_NOTICE || isReconnectFailedNotice(this.#browserNotice))
              ? `${HISTORICAL_INPUT_NOTICE} · ${this.#browserNotice}` : this.#browserNotice }
          : this.#arrivalNotice !== undefined
            ? { notice: this.#withSeat(this.#tabs.get(activeTabId)?.snapshot, this.#arrivalNotice, hiddenColumns) }
            : this.#pendingBrowserAction !== undefined && this.#pendingBrowserActionTabId === activeTabId
              ? {
                notice: this.#pendingBrowserAction.type === "auth.device.present"
                  ? `${providerName(this.#pendingBrowserAction.provider)} requests device sign-in · code ${this.#pendingBrowserAction.userCode} · Enter/o open · d/Esc deny`
                  : this.#pendingBrowserAction.id === this.#retainedPendingRequestId
                    ? "Retained sign-in link; validity unknown · Enter/o open · d/Esc deny"
                    : `${providerName(this.#pendingBrowserAction.provider)} requests browser authentication · Enter/o open · d/Esc deny`,
              }
              : (this.#tabs.get(activeTabId)?.viewport.scrollOffset ?? 0) > 0
                ? { notice: scrolledBackNotice(this.#tabs.get(activeTabId)?.viewport.scrollOffset ?? 0) }
              : this.#helpVisible
                ? { notice: "Keys: " + (this.#tabs.get(activeTabId)?.snapshot.accessMode === "writer" ? "Ctrl+C to agent | " : "Ctrl+C detach | ") +
                    (remoteMouse ? "Shift+drag select | " : "Drag select, Ctrl+C copy | Ctrl+click open link | ") + (process.platform === "win32" ? "Ctrl+Shift+V paste | " : "") + "Wheel scroll | Ctrl+S keep active | Ctrl+] c/s/q remote | " + (this.#rosterActive() ? "1-9 or click switch session" : "1-4 tab") + " | n next | r retry" +
                    (this.#tabs.get(activeTabId)?.snapshot.accessMode === "observer" &&
                     writerCapabilityRefusal(this.#tabs.get(activeTabId)!.snapshot) === undefined
                      ? writerCapabilityNeedsRefresh(this.#tabs.get(activeTabId)!.snapshot) ? " | w recheck control" : " | w take control"
                      : "") + " | a retained sign-in link | d detach" }
                : attention !== undefined
                  ? { notice: attention }
                : this.#seatNoticeFor(this.#tabs.get(activeTabId)?.snapshot, hiddenColumns) !== undefined
                  ? { notice: this.#seatNoticeFor(this.#tabs.get(activeTabId)?.snapshot, hiddenColumns) as string }
                  : this.#retainedBrowserCandidates.has(activeTabId)
                    ? { notice: "Sign-in link in history · Ctrl+] a to inspect · if rejected, request a new link in the provider" }
                    : {}),
      });
      // Predicted glyphs are painted over the true frame only; the viewport
      // model that mirrors the remote never contains them.
      const activeTab = this.#tabs.get(activeTabId);
      const prediction = activeTab !== undefined && activeTab.snapshot.state === "active" &&
        activeTab.snapshot.accessMode === "writer"
        ? this.#predictiveEcho.overlay(activeViewport, predictionKey(activeTab, activeViewport))
        : undefined;
      const frame = prediction === undefined ? trueFrame : withPredictionOverlay(trueFrame, prediction);
      // Every accepted keystroke and every output frame renders a complete
      // absolute-addressed frame. Most of them repaint exactly what the host
      // already shows (measured 2026-09-15: three of four frames per typed
      // key changed no row). A byte-identical frame is not written again;
      // anything else that touches the host clears this memory first.
      if (this.#lastHostFrame !== undefined && sameBytes(this.#lastHostFrame, frame.bytes)) return;
      const update = workbenchUpdate(this.#lastHostFrame === undefined ? undefined : this.#lastWorkbenchFrame, frame);
      this.#lastHostFrame = undefined;
      this.#firstFrameRendered = true;
      this.#stopAttachingAnimation();
      await this.#writeHost(update);
      this.#lastHostFrame = frame.bytes;
      this.#lastWorkbenchFrame = frame;
    });
    this.#renderTail = operation.then(() => undefined, () => undefined);
    await operation;
  }

  /** The outside attention line, if any; a failing source shows nothing rather than failing the frame. */
  #attentionLine(): string | undefined {
    try {
      const line = this.#options.attention?.current();
      return line === undefined || line.length === 0 ? undefined : line;
    } catch {
      return undefined;
    }
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
    const top = padTrustedLine(this.#options.attachingTitle === undefined
      ? ` CUNA  ATTACHING ${count} EXACT AGENTSESSION${count === 1 ? "" : "S"}`
      : ` CUNA  ${this.#options.attachingTitle}`, dimensions.columns);
    const waitedMs = this.#clock() - this.#attachingStageSince;
    const waited = waitedMs >= ATTACH_STAGE_ELAPSED_AFTER_MS ? ` · ${Math.floor(waitedMs / 1_000)}s` : "";
    const indicator = `${ATTACHING_FRAMES[this.#attachingFrame % ATTACHING_FRAMES.length]} ${ATTACH_STAGE_LABELS[this.#attachingStage]}${waited}  ${ATTACHING_PROGRESS[this.#attachingFrame % ATTACHING_PROGRESS.length]}`;
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
    this.#lastHostFrame = undefined;
    await this.#writeHost(new TextEncoder().encode(text));
  }

  #setAttachingStage(stage: TerminalAttachStage | "first_screen", count: number): void {
    if (this.#state !== "starting" || this.#startupDetached || this.#firstFrameRendered) return;
    if (this.#attachingStage !== stage) {
      this.#attachingStage = stage;
      this.#attachingStageSince = this.#clock();
    }
    // The running animation repaints within one frame; no extra write here.
    this.#startAttachingAnimation(count);
  }

  #startAttachingAnimation(count: number): void {
    if (this.#state !== "starting" || this.#startupDetached || this.#firstFrameRendered) return;
    if (this.#attachingAnimationTimer !== undefined) return;
    this.#attachingAnimationTimer = setInterval(() => {
      if (this.#state !== "starting" || this.#startupDetached || this.#firstFrameRendered) {
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
      if (this.#state !== "starting" || this.#startupDetached || this.#firstFrameRendered) return;
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
    this.#lastHostFrame = undefined;
    await this.#writeHost(new TextEncoder().encode(text));
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
    // Waiting for a slow attempt: make it now.
    const slowWait = this.#slowReconnectWaits.get(tabId);
    if (slowWait !== undefined) {
      slowWait.wake();
      return;
    }
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
    // New action feedback replaces help; the user can reopen help afterward.
    this.#helpVisible = false;
    if (tab.snapshot.accessMode === "writer") {
      this.#seatNotice = "You already hold this terminal's writer seat.";
      void this.#render().catch(() => undefined);
      return;
    }
    const refusal = writerCapabilityRefusal(tab.snapshot);
    if (refusal !== undefined) {
      this.#seatNotice = refusal;
      void this.#render().catch(() => undefined);
      return;
    }
    this.#seatNotice = writerCapabilityNeedsRefresh(tab.snapshot) ? "Checking control…" : "Taking control…";
    void this.#render().catch(() => undefined);
    void runtime.takeWriter({ tabId, signal: this.#lifetimeAbort.signal }).then(
      () => { this.#seatNotice = undefined; },
      (error: unknown) => {
        this.#seatNotice = writerTransferFailureNotice(error);
        this.#helpVisible = false;
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
    if (before.accessMode !== after.accessMode || before.reason !== after.reason ||
        before.writerTransferCapability?.supported !== after.writerTransferCapability?.supported ||
        before.writerTransferCapability?.reasonCode !== after.writerTransferCapability?.reasonCode) this.#seatNotice = undefined;
  }

  /** The seat first, so a narrow row truncates the other line, never the seat. */
  #withSeat(snapshot: RuntimeTerminalSnapshot | undefined, line: string, hiddenColumns = 0): string {
    const seat = this.#seatNoticeFor(snapshot, hiddenColumns) ??
      (snapshot?.state === "active" && snapshot.accessMode === "writer" ? "You have control" : undefined);
    return seat === undefined ? line : `${seat} · ${line}`;
  }

  /**
   * `hiddenColumns` is how much wider the writer's screen is than this
   * window. An observer never resizes the writer's PTY, so those columns are
   * cut; say so beside the seat rather than letting the rows look complete.
   */
  #seatNoticeFor(snapshot: RuntimeTerminalSnapshot | undefined, hiddenColumns = 0): string | undefined {
    const historical = snapshot?.historicalInputUncertainty === true ? HISTORICAL_INPUT_NOTICE : undefined;
    const withHistory = (notice: string | undefined) => historical === undefined ? notice :
      notice === undefined ? historical : `${historical} · ${notice}`;
    if (this.#seatNotice !== undefined) return withHistory(this.#seatNotice);
    if (snapshot === undefined || snapshot.state !== "active" || snapshot.accessMode !== "observer") return historical;
    const refusal = writerCapabilityRefusal(snapshot);
    if (refusal !== undefined) return withHistory(refusal);
    const cut = hiddenColumns > 0 ? ` · ${widerViewNotice(hiddenColumns)}` : "";
    if (writerCapabilityNeedsRefresh(snapshot)) return withHistory(`Observing (read-only)${cut} · Press Ctrl+] then w to recheck control`);
    return withHistory(snapshot.reason === "writer_transferred"
      ? `Control moved to another client${cut} · Press Ctrl+] then w to take it back`
      : snapshot.geometry == null
        ? "Observing (read-only) · geometry unknown · Ctrl+] then w: control"
        : `Observing (read-only)${cut} · Press Ctrl+] then w to take control`);
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

/**
 * Automatic recovery gave up. Name the typed reason it gave up on: the person
 * is looking at a frozen frame and "Reconnect failed" alone tells them nothing
 * about whether retrying can help. Only this client's own closed error codes
 * are rendered -- never remote text.
 */
function reconnectFailedNotice(failure: unknown, retryInMs?: number): string {
  const subject = reconnectFailureSubject(failure);
  if (subject === undefined && retryInMs === undefined) return RECONNECT_FAILED_NOTICE;
  const retry = retryInMs === undefined ? "" : ` · retrying in ${Math.max(1, Math.ceil(retryInMs / 1_000))} s`;
  return `Reconnect failed${subject === undefined ? "" : `: ${subject}`}${retry} · Ctrl+] r retries · Ctrl+C disconnects.`;
}

function reconnectFailureSubject(failure: unknown): string | undefined {
  // A reconnect whose cleanup also failed reports both; the first is why.
  if (failure instanceof AggregateError) return reconnectFailureSubject(failure.errors[0]);
  if (failure instanceof RuntimeBoundaryError) {
    // The capability name is this client's own closed enum, not remote text,
    // and it is the one word that says WHICH contract the replacement grant
    // failed to prove. Without it "capability unknown" cannot be acted on.
    const capability = failure.safeDetails?.capability;
    return typeof capability === "string" && /^[a-z_]{1,32}$/u.test(capability)
      ? `${failure.code.replaceAll("_", " ")} (${capability.replaceAll("_", " ")})`
      : failure.code.replaceAll("_", " ");
  }
  // The API calls a reconnect makes (admission, grant) fail as CunaErrors: on
  // 2026-10-03 the bar said a bare "Reconnect failed" while they were timing
  // out. Their codes are a closed dotted vocabulary; anything else stays unnamed.
  if (failure instanceof CunaError && /^cuna(?:\.[a-z][a-z_]{0,47}){1,3}$/u.test(failure.code)) {
    return failure.code.slice("cuna.".length).replaceAll(".", " ").replaceAll("_", " ");
  }
  return undefined;
}

/** Whether waiting can help: only a failure that says it cannot is final. */
function isRetryableReconnectFailure(failure: unknown): boolean {
  if (failure instanceof AggregateError) return isRetryableReconnectFailure(failure.errors[0]);
  if (failure instanceof RuntimeBoundaryError || failure instanceof CunaError) return failure.retryable;
  return true;
}

function isReconnectFailedNotice(value: string | undefined): boolean {
  return value !== undefined && value.startsWith("Reconnect failed");
}

function rosterAgentName(agent: SessionRosterEntry["agent"]): string {
  switch (agent) {
    case "claude-code": return "Claude";
    case "codex": return "Codex";
    case "opencode": return "OpenCode";
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function scrolledBackNotice(lines: number): string {
  return `Scrolled back ${lines} line${lines === 1 ? "" : "s"} · scroll down or type to return`;
}

/** Only a bounded http(s) URL of printable characters may enter a host hyperlink. */
function paintableLink(uri: string): boolean {
  if (uri.length > 2_048 || /[\p{Cc}\s]/u.test(uri)) return false;
  try {
    const url = new URL(uri);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** The viewport rows a link covers, as cell ranges [start, end) within the painted width. */
function linkRows(link: BufferLink, top: number, rows: number, width: number, columns: number):
  readonly { readonly row: number; readonly start: number; readonly end: number }[] {
  const spans: { row: number; start: number; end: number }[] = [];
  for (let line = Math.max(link.start.line, top); line <= link.end.line && line < top + rows; line += 1) {
    const start = line === link.start.line ? link.start.column : 0;
    const end = Math.min(width, line === link.end.line ? link.end.column + 1 : columns);
    if (end > start) spans.push({ row: line - top, start, end });
  }
  return spans;
}

function widerViewNotice(columns: number): string {
  return `view is ${columns} column${columns === 1 ? "" : "s"} wider than this window (${CONTINUED_MARKER})`;
}

/** Guesses belong to one exact writer attachment at one geometry. */
function predictionKey(tab: ForegroundTab, view: { readonly columns: number; readonly rows: number }): string {
  return `${tab.intent.tabId}:${tab.snapshot.fencingGeneration}:${tab.snapshot.writerEpoch}:${view.columns}x${view.rows}`;
}

function isPrintableAscii(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x7e;
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
  providerAuthentication?: StatusEvidence<string>,
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
    providerAuthentication: providerAuthentication === undefined
      ? []
      : [providerAuthentication],
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

function sameInputTarget(left: ForegroundInputTarget, right: ForegroundInputTarget): boolean {
  return left.tabId === right.tabId &&
    left.binding.userId === right.binding.userId &&
    left.binding.machineId === right.binding.machineId &&
    left.binding.agentSessionId === right.binding.agentSessionId &&
    left.binding.processEpoch === right.binding.processEpoch &&
    left.binding.fencingGeneration === right.binding.fencingGeneration &&
    left.binding.writerEpoch === right.binding.writerEpoch;
}

function padTrustedLine(value: string, columns: number): string {
  return value.slice(0, columns).padEnd(columns, " ");
}

function providerName(provider: LocalBrowserActionRequest["provider"]): string {
  if (provider === "claude-code") return "Claude Code";
  return "Codex";
}

const SESSION_END_READ_DELAYS_MS = Object.freeze([0, 1_500, 3_000, 6_000]);
/**
 * tmux's default remain-on-exit-format:
 * "Pane is dead (status 0, Tue Sep 29 17:41:10 2026)", or "(signal 9, …)".
 */
const PANE_DEAD = /^Pane is dead \((status \d{1,3}|signal \d{1,2})(?:, [A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})?\)$/u;

/** tmux's pane-dead line, when it is the screen's last written row. */
function paneDeathRow(cells: readonly string[]): { readonly row: number; readonly status: string } | undefined {
  for (let row = cells.length - 1; row >= 0; row -= 1) {
    const text = (cells[row] ?? "").trim();
    if (text.length === 0) continue;
    const match = PANE_DEAD.exec(text);
    return match === null ? undefined : Object.freeze({ row, status: match[1] as string });
  }
  return undefined;
}

/** The same screen with tmux's pane-dead line blank. */
function withoutPaneDeathRow(view: ViewportSnapshot): ViewportSnapshot {
  const death = paneDeathRow(view.cells);
  if (death === undefined) return view;
  const blank = <T>(rows: readonly T[], value: T): readonly T[] =>
    Object.freeze(rows.map((row, index) => index === death.row ? value : row));
  return Object.freeze({
    ...view,
    cells: blank(view.cells, ""),
    displayWidths: blank(view.displayWidths, 0),
    ...(view.renderRows === undefined ? {} : { renderRows: blank(view.renderRows, Object.freeze([])) }),
    ...(view.continuedRows === undefined ? {} : { continuedRows: blank(view.continuedRows, false) }),
  });
}

function sessionProviderName(agent: WorkbenchTab["agent"]): string {
  return agent === "claude-code" ? "Claude Code" : agent === "codex" ? "Codex" : agent === "opencode" ? "OpenCode" :
    agent === "openclaw" ? "OpenClaw" : "The shell";
}

/** The journey that starts a new session of this provider, when there is one. */
function journeyCommand(agent: WorkbenchTab["agent"]): string | undefined {
  return agent === "claude-code" ? "cuna claude" : agent === "codex" ? "cuna codex" : agent === "opencode" ? "cuna opencode" : undefined;
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
    // Awaited by reconnect recovery: the delay must be able to elapse even when
    // no other handle keeps the event loop alive (Linux exits early otherwise).
    const timer = setTimeout(done, milliseconds);
    const onAbort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}


function writerCapabilityNeedsRefresh(snapshot: RuntimeTerminalSnapshot): boolean {
  const capability = snapshot.writerTransferCapability;
  return capability !== undefined && Number.isFinite(capability.expiresAt) && capability.expiresAt <= Date.now() &&
    (capability.supported || capability.reasonCode === "capability_snapshot_expired");
}

function writerCapabilityRefusal(snapshot: RuntimeTerminalSnapshot): string | undefined {
  const capability = snapshot.writerTransferCapability;
  // This enables only the refresh action. Runtime.takeWriter discovers and
  // admits fresh, scoped evidence before it can dispatch a transfer request.
  if (writerCapabilityNeedsRefresh(snapshot)) return undefined;
  if (capability?.supported === true && capability.expiresAt > Date.now()) return undefined;
  return `Control unavailable: ${capability?.reasonCode ?? (capability?.supported ? "capability_snapshot_expired" : "capability_unknown")}`;
}

function writerTransferFailureNotice(error: unknown): string {
  if (error instanceof RuntimeBoundaryError && error.code.startsWith("capability_")) {
    return `Control unavailable: ${String(error.safeDetails?.reason_code ?? error.code)}`;
  }
  const reason = typeof error === "object" && error !== null
    ? (error as { readonly details?: { readonly reason?: unknown } }).details?.reason : undefined;
  if (reason === "terminal_writer_cancelled") return "Control transfer cancelled. Read the terminal state before trying again.";
  if (reason === "terminal_writer_transfer_in_progress") return "Control transfer is pending. Keep observing; retry checks the same request.";
  if (reason === "terminal_writer_operation_mismatch") return "Control request does not match its operation. Read the terminal state before trying again.";
  if (reason === "terminal_writer_outcome_unknown") return "Control outcome is unconfirmed. Keep observing; retry checks the same request.";
  return `Could not take control: ${error instanceof Error ? error.message : String(error)}`;
}
