import { randomUUID } from "node:crypto";

import { DaemonLifecycle, type DaemonLifecycleSnapshot } from "../daemon/lifecycle.js";
import { LocalClientViewRegistry } from "../daemon/views.js";
import { DurableSyncJournal } from "../sync/journal.js";
import {
  LocalSyncSupervisor,
  SyncSupervisorRegistry,
  type SupervisorConfiguration,
} from "../sync/supervisor.js";
import {
  TERMINAL_PROTOCOL,
  TERMINAL_LOCAL_ACTION_KINDS,
  TerminalFrameDecoder,
  TerminalProtocolError,
  assertTerminalFrameLegal,
  decodeTerminalControl,
  type TerminalWriterEpochPayload,
  type TerminalGeometryPayload,
  decodeTerminalFrame,
  encodeTerminalControl,
  encodeTerminalFrame,
  isLocalActionFrameType,
  negotiateTerminalLocalActions,
  type TerminalFrame,
  type TerminalLocalActionKind,
  type TerminalLocalActionProtocolAcceptance,
} from "../terminal/codec.js";

import { admitCapability, writerTransferCapability, type WriterTransferCapability } from "./capability-gate.js";
import type { CapabilitySnapshot } from "../api/contracts.js";
import { RuntimeBoundaryError, runtimeFailure, terminalHistoryGap } from "./errors.js";
import {
  assertReadyPayloadMatches,
  assertRemoteAgentSessionEvidence,
  validateTerminalGrant,
  type RemoteAgentSessionEvidence,
  type TerminalConnectionGrant,
  type TerminalConnectionCapability,
  type TerminalAttachmentAdmission,
  type TerminalConnector,
  type TerminalControlPlane,
  type TerminalWireConnection,
} from "./terminal-transport.js";

const MAX_RUNTIME_EVIDENCE_TTL_MS = 5 * 60_000;

export type RuntimeTerminalState =
  | "attaching"
  | "active"
  | "interrupted"
  | "reconnecting"
  | "detached"
  | "closed"
  | "failed";

export interface RuntimeStartupEvidence {
  readonly endpointOwnership: "verified" | "unverified";
  readonly durableState: "verified" | "recovery_required" | "unknown";
  readonly source: string;
  readonly observedAt: number;
  readonly expiresAt: number;
}

export type RuntimeBoundaryMode = "daemon" | "foreground";

export type ForegroundRuntimeLifecycleState =
  | "absent"
  | "ready"
  | "quiescing"
  | "stopped"
  | "cleanup_failed";

export interface ForegroundRuntimeLifecycleSnapshot {
  readonly state: ForegroundRuntimeLifecycleState;
  readonly reason: string;
  readonly updatedAt: number;
}

export interface RuntimeTerminalSnapshot {
  readonly terminalView?: { readonly viewId: string | null; readonly ready: boolean };
  readonly writerTransferCapability?: WriterTransferCapability;
  readonly tabId: string;
  readonly viewId: string;
  readonly userId: string;
  readonly machineId: string;
  readonly workspaceBindingId: string | null;
  readonly workspaceBindingGeneration: number | null;
  readonly agentSessionId: string;
  readonly processEpoch: string;
  readonly state: RuntimeTerminalState;
  readonly fencingGeneration: number;
  readonly inputSequence: bigint;
  readonly acknowledgedInputSequence: bigint;
  readonly inputContinuity: "none" | "complete" | "uncertain";
  readonly historicalInputUncertainty: boolean;
  readonly outputSequence: bigint;
  readonly outputContinuity: "complete" | "unknown" | "incomplete";
  readonly resizeCapability: "live" | "initial_resize_only";
  readonly accessMode: "writer" | "observer";
  readonly writerEpoch: number;
  readonly writerClientInstanceId: string | null;
  readonly geometry: TerminalGeometryPayload | null;
  readonly heartbeatObservedAt: number;
  readonly heartbeatExpiresAt: number;
  readonly reason?: string;
}

export interface RuntimeTerminalResponse {
  readonly tabId: string;
  readonly binding: {
    readonly userId: string;
    readonly machineId: string;
    readonly agentSessionId: string;
    readonly processEpoch: string;
    readonly fencingGeneration: number;
  };
  readonly bytes: Uint8Array;
}

export interface RuntimeSyncHandle {
  readonly bindingId: string;
  readonly fence: number;
  readonly supervisor: LocalSyncSupervisor;
  close(): Promise<void>;
}

export interface RuntimeBoundaryOptions {
  readonly canonicalTerminalViews?: boolean;
  readonly onTerminalViewStarted?: (event: { readonly snapshot: RuntimeTerminalSnapshot; readonly columns: number; readonly rows: number; readonly signal: AbortSignal }) => void | Promise<void>;
  readonly mode?: RuntimeBoundaryMode;
  readonly controlPlane: TerminalControlPlane;
  readonly terminalConnector: TerminalConnector;
  readonly allowedCunaOrigins: readonly string[];
  readonly terminalCapabilityId: string;
  readonly clientInstanceId: string;
  readonly clock?: () => number;
  readonly idempotencyKey?: () => string;
  readonly readyTimeoutMs?: number;
  readonly outputDeliveryTimeoutMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly onTerminalReady?: (snapshot: RuntimeTerminalSnapshot) => void | Promise<void>;
  readonly onTerminalGeometry?: (event: { readonly snapshot: RuntimeTerminalSnapshot; readonly signal: AbortSignal }) => void | Promise<void>;
  readonly onTerminalOutput?: (event: {
    readonly provenance: "live" | "replay_or_unknown";
    readonly tabId: string;
    readonly agentSessionId: string;
    readonly binding: RuntimeTerminalResponse["binding"];
    readonly sequence: bigint;
    readonly bytes: Uint8Array;
    readonly signal: AbortSignal;
  }) => void | Promise<void>;
  readonly onTerminalState?: (snapshot: RuntimeTerminalSnapshot) => void;
  /**
   * The negotiated action surface is attachment-scoped.  A single foreground
   * may host several providers, so advertising a process-wide superset would
   * let a provider see kinds it can never use.
   */
  readonly localActionKinds?: readonly TerminalLocalActionKind[] | ((agentSessionId: string) => readonly TerminalLocalActionKind[]);
  readonly onLocalActionFrame?: (event: {
    readonly tabId: string;
    readonly frame: TerminalFrame;
    readonly payload: Readonly<Record<string, unknown>>;
  }) => void | Promise<void>;
}

interface TerminalEntry {
  capabilitySnapshot: CapabilitySnapshot;
  capabilityReadRevision: number;
  capabilityRefresh?: Promise<void>;
  nextCapabilityRefreshAt?: number;
  readonly tabId: string;
  viewId: string;
  terminalView?: { viewId: string | null; ready: boolean };
  terminalViewDeadline?: ReturnType<typeof setTimeout>;
  observation: RemoteAgentSessionEvidence;
  state: RuntimeTerminalState;
  connection: TerminalWireConnection;
  decoder: TerminalFrameDecoder;
  fencingGeneration: number;
  capabilities: readonly TerminalConnectionCapability[];
  resizeCapability: "live" | "initial_resize_only";
  accessMode: "writer" | "observer";
  writerEpoch: number;
  writerClientInstanceId: string | null;
  wireWriterNotice: TerminalWriterEpochPayload | undefined;
  geometry: TerminalGeometryPayload | null;
  /** True once this attachment has held the writing seat by any path. */
  heldSeat: boolean;
  wireSequence: bigint;
  inputSequence: bigint;
  acknowledgedInputSequence: bigint;
  inputContinuity: RuntimeTerminalSnapshot["inputContinuity"];
  pendingInputSequences: Set<bigint>;
  /** Accepted receipts from a later writer/attachment cannot resolve this history. */
  historicalInputUncertainty: boolean;
  retiredInputSequence: bigint;
  outputSequence: bigint;
  outputContinuity: RuntimeTerminalSnapshot["outputContinuity"];
  lastHeartbeatAt: number;
  resumeHandle: string;
  localActionsNegotiated: boolean;
  localActionAcceptance: TerminalLocalActionProtocolAcceptance | undefined;
  reason?: string;
  pump?: Promise<void>;
  sendTail: Promise<void>;
  connectionRevision: number;
  heartbeatSequence: bigint;
  replayBoundarySequence?: bigint;
  replayBoundaryObserved?: boolean;
  heartbeatSendPending: boolean;
  heartbeatTimer?: NodeJS.Timeout;
  outputAbort: AbortController;
  reconnectIdempotencyKey?: string;
  writerTransfer?: {
    readonly operationId: string;
    readonly expectedWriterEpoch: number;
    inFlight?: Promise<RuntimeTerminalSnapshot>;
  };
}

export class CunaRuntimeBoundary {
  readonly #options: RuntimeBoundaryOptions;
  readonly #clock: () => number;
  readonly #idempotencyKey: () => string;
  readonly #daemon: DaemonLifecycle;
  readonly #mode: RuntimeBoundaryMode;
  readonly #views = new LocalClientViewRegistry();
  readonly #syncRegistry = new SyncSupervisorRegistry();
  readonly #terminals = new Map<string, TerminalEntry>();
  readonly #pendingConnectionRequests = new Map<string, Parameters<TerminalControlPlane["createTerminalConnection"]>[0]>();
  readonly #pendingTerminalTabs = new Set<string>();
  readonly #pendingAgentSessions = new Set<string>();
  readonly #pendingAttaches = new Map<string, {
    readonly abort: AbortController;
    readonly completion: Promise<unknown | undefined>;
    readonly settle: (failure?: unknown) => void;
    readonly removeInputAbort: () => void;
  }>();
  readonly #pendingReconnects = new Map<string, {
    readonly abort: AbortController;
    readonly completion: Promise<unknown | undefined>;
    readonly settle: (failure?: unknown) => void;
    readonly removeInputAbort: () => void;
  }>();
  readonly #pendingSyncOpens = new Map<string, Promise<unknown | undefined>>();
  readonly #syncHandles = new Map<string, RuntimeSyncHandle>();
  #activeTabId: string | undefined;
  #startupEvidenceExpiresAt = 0;
  #foreground: ForegroundRuntimeLifecycleSnapshot;
  #closed = false;
  #shutdownComplete = false;
  #shutdownFlight: Promise<void> | undefined;

  constructor(options: RuntimeBoundaryOptions) {
    assertIdentifier(options.terminalCapabilityId, "terminal capability ID");
    assertIdentifier(options.clientInstanceId, "client instance ID");
    if (options.allowedCunaOrigins.length === 0) {
      throw runtimeFailure("grant_invalid", "At least one exact Cuna HTTPS origin is required.");
    }
    this.#options = Object.freeze({ ...options, allowedCunaOrigins: Object.freeze([...options.allowedCunaOrigins]) });
    this.#clock = options.clock ?? Date.now;
    this.#idempotencyKey = options.idempotencyKey ?? randomUUID;
    const mode = options.mode ?? "daemon";
    if (mode !== "daemon" && mode !== "foreground") {
      throw new RangeError("Runtime boundary mode must be daemon or foreground.");
    }
    this.#mode = mode;
    this.#daemon = new DaemonLifecycle(this.#clock());
    this.#foreground = Object.freeze({ state: "absent", reason: "not_started", updatedAt: this.#clock() });
  }

  get daemon(): DaemonLifecycleSnapshot {
    return this.#daemon.snapshot();
  }

  get activeTabId(): string | undefined {
    return this.#activeTabId;
  }

  get mode(): RuntimeBoundaryMode {
    return this.#mode;
  }

  get foreground(): ForegroundRuntimeLifecycleSnapshot {
    return this.#foreground;
  }

  start(evidence: RuntimeStartupEvidence): DaemonLifecycleSnapshot {
    this.#assertOpen();
    if (this.#mode !== "daemon") {
      throw runtimeFailure("session_conflict", "Foreground runtime mode cannot claim daemon readiness.");
    }
    if (this.#daemon.snapshot().state !== "absent" && this.#daemon.snapshot().state !== "stopped") {
      throw runtimeFailure("session_conflict", "The local runtime is already started.");
    }
    const now = this.#clock();
    this.#daemon.transition("starting", "runtime_start_requested", now);
    if (
      evidence.endpointOwnership !== "verified" ||
      evidence.durableState !== "verified" ||
      evidence.source.length === 0 ||
      !Number.isFinite(evidence.observedAt) ||
      !Number.isFinite(evidence.expiresAt) ||
      evidence.observedAt > now ||
      evidence.expiresAt < evidence.observedAt ||
      evidence.expiresAt - evidence.observedAt > MAX_RUNTIME_EVIDENCE_TTL_MS ||
      evidence.expiresAt <= now
    ) {
      this.#daemon.transition("recovery_required", "local_runtime_evidence_unproven", this.#clock());
      throw runtimeFailure("remote_state_unproven", "The local runtime endpoint or durable state is not verified.");
    }
    this.#startupEvidenceExpiresAt = evidence.expiresAt;
    return this.#daemon.transition("ready", "local_runtime_verified", this.#clock());
  }

  startForeground(): ForegroundRuntimeLifecycleSnapshot {
    this.#assertOpen();
    if (this.#mode !== "foreground") {
      throw runtimeFailure("session_conflict", "Daemon runtime mode cannot claim foreground readiness.");
    }
    if (this.#foreground.state !== "absent") {
      throw runtimeFailure("session_conflict", "The foreground runtime is already started.");
    }
    this.#foreground = Object.freeze({
      state: "ready",
      reason: "foreground_process_owns_runtime",
      updatedAt: this.#clock(),
    });
    return this.#foreground;
  }

  async attach(input: {
    readonly tabId: string;
    readonly agentSessionId: string;
    readonly columns: number;
    readonly rows: number;
    readonly expectedAdmission?: TerminalAttachmentAdmission;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeTerminalSnapshot> {
    this.#assertReady();
    assertIdentifier(input.tabId, "tab ID");
    assertIdentifier(input.agentSessionId, "AgentSession ID");
    assertDimensions(input.columns, input.rows);
    if (this.#terminals.has(input.tabId) || this.#pendingTerminalTabs.has(input.tabId)) {
      throw runtimeFailure("session_conflict", "The terminal tab already exists.");
    }
    if (
      this.#pendingAgentSessions.has(input.agentSessionId) ||
      [...this.#terminals.values()].some((entry) => entry.observation.agentSessionId === input.agentSessionId && entry.state !== "closed")
    ) {
      throw runtimeFailure("session_conflict", "The AgentSession is already attached by this runtime.");
    }

    this.#pendingTerminalTabs.add(input.tabId);
    this.#pendingAgentSessions.add(input.agentSessionId);
    const attachAbort = new AbortController();
    let removeInputAbort = (): void => undefined;
    if (input.signal !== undefined) {
      const forwardAbort = (): void => attachAbort.abort(input.signal?.reason);
      if (input.signal.aborted) forwardAbort();
      else {
        input.signal.addEventListener("abort", forwardAbort, { once: true });
        removeInputAbort = () => input.signal?.removeEventListener("abort", forwardAbort);
      }
    }
    let settleAttach = (_failure?: unknown): void => undefined;
    const attachCompletion = new Promise<unknown | undefined>((resolve) => { settleAttach = resolve; });
    this.#pendingAttaches.set(input.tabId, {
      abort: attachAbort,
      completion: attachCompletion,
      settle: settleAttach,
      removeInputAbort,
    });
    let connection: TerminalWireConnection | undefined;
    let entry: TerminalEntry | undefined;
    let completionFailure: unknown | undefined;
    try {
      throwIfAborted(attachAbort.signal, "Terminal attachment was cancelled.");
      await this.#cancelConnectionRequests(input.agentSessionId);
      const admitted = await this.#admitRemoteTerminal(input.agentSessionId, attachAbort.signal);
      if (input.expectedAdmission !== undefined) {
        this.#assertAttachmentAdmissionContinuity(input.expectedAdmission, admitted, "preflight");
      }
      this.#assertOpen();
      throwIfAborted(attachAbort.signal, "Terminal attachment was cancelled.");
      const grant = await this.#createGrant(admitted.observation, admitted.capability, undefined, undefined, attachAbort.signal);
      this.#assertOpen();
      throwIfAborted(attachAbort.signal, "Terminal attachment was cancelled.");
      const revalidated = await this.#admitRemoteTerminal(input.agentSessionId, attachAbort.signal);
      this.#assertAttachmentAdmissionContinuity(admitted, revalidated, "post_grant");
      if (input.expectedAdmission !== undefined) {
        this.#assertAttachmentAdmissionContinuity(input.expectedAdmission, revalidated, "preflight");
      }
      this.#assertOpen();
      throwIfAborted(attachAbort.signal, "Terminal attachment was cancelled.");
      connection = await this.#options.terminalConnector.connect({
        ...(this.#options.canonicalTerminalViews === true ? { terminalViewProtocol: "cuna.terminal-view.v1" as const } : {}),
        url: grant.connectUrl,
        token: grant.connectToken,
        protocol: TERMINAL_PROTOCOL,
        signal: attachAbort.signal,
      });
      this.#assertOpen();
      throwIfAborted(attachAbort.signal, "Terminal attachment was cancelled.");
      if (connection.connectionId !== grant.terminalSessionId) {
        throw runtimeFailure("grant_scope_mismatch", "The terminal transport accepted a different Cuna terminal session.");
      }
      entry = {
        capabilitySnapshot: revalidated.capabilitySnapshot,
        capabilityReadRevision: 0,
        tabId: input.tabId,
        viewId: `pending:${grant.terminalSessionId}`,
        observation: revalidated.observation,
        state: "attaching",
        connection,
        decoder: new TerminalFrameDecoder(),
        fencingGeneration: 0,
        capabilities: grant.capabilities,
        resizeCapability: "initial_resize_only",
        wireSequence: 0n,
        inputSequence: 0n,
        acknowledgedInputSequence: 0n,
        inputContinuity: "none",
        pendingInputSequences: new Set(),
        historicalInputUncertainty: false,
        retiredInputSequence: 0n,
        outputSequence: 0n,
        outputContinuity: "unknown",
        lastHeartbeatAt: this.#clock(),
        resumeHandle: grant.resumeHandle,
        localActionsNegotiated: false,
        localActionAcceptance: undefined,
        accessMode: "observer",
        writerEpoch: 0,
        writerClientInstanceId: null,
        wireWriterNotice: undefined,
        geometry: null,
        heldSeat: false,
        sendTail: Promise.resolve(),
        connectionRevision: 1,
        heartbeatSequence: 0n,
        heartbeatSendPending: false,
        outputAbort: new AbortController(),
      };
      const iterator = connection.receive()[Symbol.asyncIterator]();
      const ready = await this.#awaitReady(entry, iterator, attachAbort.signal);
      if (ready.payload.terminalViewProtocol !== undefined) {
        if (this.#options.canonicalTerminalViews !== true) throw runtimeFailure("terminal_protocol_error", "Unrequested terminal view protocol.");
        entry.terminalView = { viewId: null, ready: false };
      }
      this.#assertOpen();
      entry.lastHeartbeatAt = this.#clock();
      entry.heartbeatSequence = 0n;
      entry.fencingGeneration = ready.payload.fencingGeneration;
      entry.resizeCapability = ready.payload.resizeCapability;
      entry.accessMode = ready.payload.accessMode;
      entry.writerEpoch = ready.payload.writerEpoch;
      entry.writerClientInstanceId = ready.payload.accessMode === "writer" ? this.#options.clientInstanceId : null;
      entry.wireWriterNotice = ready.payload.accessMode === "writer" ? Object.freeze({
        writerEpoch: ready.payload.writerEpoch, writerClientInstanceId: this.#options.clientInstanceId, accessMode: "writer",
      }) : undefined;
      if (entry.writerTransfer !== undefined && ready.payload.writerEpoch > entry.writerTransfer.expectedWriterEpoch) {
        delete entry.writerTransfer;
      }
      entry.heldSeat = ready.payload.accessMode === "writer";
      entry.localActionAcceptance = this.#localActionAcceptance(
        ready.payload.localActionProtocol,
        entry.observation.agentSessionId,
      );
      entry.viewId = viewId(input.tabId, ready.payload.fencingGeneration);
      this.#views.open({
        viewId: entry.viewId,
        binding: {
          userId: revalidated.observation.userId,
          machineId: revalidated.observation.machineId,
          agentSessionId: revalidated.observation.agentSessionId,
          processEpoch: revalidated.observation.processEpoch,
          fencingGeneration: ready.payload.fencingGeneration,
        },
        state: "active",
        columns: input.columns,
        rows: input.rows,
      });
      entry.state = "active";
      entry.outputContinuity = entry.terminalView === undefined ? "complete" : "unknown";
      this.#terminals.set(input.tabId, entry);
      this.#activeTabId ??= input.tabId;
      // READY proves that the PTY exists; it does not prove that its default
      // geometry matches this host. Establish the admitted dimensions before
      // requesting retained output: provider TUIs may have rendered that
      // output for the old geometry, and replay-before-resize makes a wide
      // local terminal deterministically display the stale wrapping.
      this.#requireGrantCapability(entry, "live_resize");
      if (entry.resizeCapability !== "live") {
        throw runtimeFailure("capability_unsupported", "This terminal cannot establish its initial dimensions.");
      }
      // Only the writing seat sets the PTY's geometry. An observer renders
      // whatever size the writer chose; a RESIZE from it would close the
      // attachment at the gateway (observer_control_rejected).
      if (entry.accessMode === "writer") {
        entry.wireSequence += 1n;
        await connection.send(encodeTerminalControl("resize", entry.wireSequence, {
          columns: input.columns,
          rows: input.rows,
        }));
      }
      // The supervisor starts and drains the provider PTY before a terminal
      // client necessarily attaches. READY proves the live binding but does
      // not include retained output, so request replay only after the ordered
      // resize has reached the same fenced attachment generation.
      entry.wireSequence += 1n;
      entry.replayBoundarySequence = entry.wireSequence;
      entry.replayBoundaryObserved = false;
      await connection.send(encodeTerminalControl("resume", entry.wireSequence, {
        resumeHandle: entry.resumeHandle,
        afterOutputSequence: entry.outputSequence.toString(),
        ...(entry.terminalView === undefined ? {} : { terminalViewProtocol: { name: "cuna.terminal-view.v1", operation: "new" } }),
        ...(entry.localActionAcceptance === undefined ? {} : { localActionProtocol: entry.localActionAcceptance }),
      }));
      entry.localActionsNegotiated = entry.localActionAcceptance !== undefined;
      await this.#options.onTerminalReady?.(snapshot(entry, this.#heartbeatTimeoutMs(), this.#clock()));
      this.#armTerminalViewDeadline(entry);
      this.#assertOpen();
      for (const frame of ready.bufferedFrames) await this.#handleAttachedFrame(entry, frame);
      this.#assertOpen();
      this.#scheduleHeartbeatWatchdog(entry, connection, entry.connectionRevision);
      this.#publish(entry);
      entry.pump = this.#pump(entry, connection, entry.connectionRevision, iterator);
      this.#forgetConnectionRequests(input.agentSessionId);
      return snapshot(entry, this.#heartbeatTimeoutMs(), this.#clock());
    } catch (error) {
      let reportedError: unknown = error;
      if (entry !== undefined && !this.#closed && entry.state !== "closed" && entry.state !== "detached") {
        entry.state = "failed";
        entry.outputContinuity = "unknown";
        entry.reason = "terminal_attach_composition_failed";
        try { this.#views.detach(entry.viewId); } catch { /* the fenced view may not have opened */ }
        this.#publish(entry);
        if (this.#activeTabId === entry.tabId) this.#activeTabId = this.#nextActiveTab(entry.tabId);
        this.#terminals.delete(input.tabId);
      }
      if (connection !== undefined) {
        try { await connection.close({ code: 1008, reason: "cuna_attach_rejected" }); } catch (cleanupError) {
          completionFailure = cleanupError;
          reportedError = new AggregateError([error, cleanupError], "Terminal attachment failed and its transport cleanup was incomplete.");
        }
      }
      try { await this.#cancelConnectionRequests(input.agentSessionId); } catch (cleanupError) {
        completionFailure = cleanupError;
        reportedError = new AggregateError([reportedError, cleanupError], "Terminal attachment failed and issuance cancellation is unconfirmed.");
      }
      throw reportedError;
    } finally {
      const pending = this.#pendingAttaches.get(input.tabId);
      pending?.removeInputAbort();
      pending?.settle(completionFailure);
      this.#pendingAttaches.delete(input.tabId);
      this.#pendingTerminalTabs.delete(input.tabId);
      this.#pendingAgentSessions.delete(input.agentSessionId);
    }
  }

  switchActive(tabId: string): RuntimeTerminalSnapshot {
    this.#assertReady();
    const entry = this.#requireTerminal(tabId);
    if (entry.state === "closed" || entry.state === "detached" || entry.state === "failed") {
      throw runtimeFailure("terminal_disconnected", "The selected terminal tab is not attachable.");
    }
    this.#activeTabId = tabId;
    return snapshot(entry, this.#heartbeatTimeoutMs(), this.#clock());
  }

  refreshTerminalLiveness(tabId = this.#activeTabId): RuntimeTerminalSnapshot {
    this.#assertReady();
    const entry = this.#requireTerminal(tabId ?? "");
    this.#assertHeartbeatFresh(entry);
    return snapshot(entry, this.#heartbeatTimeoutMs(), this.#clock());
  }

  async sendInput(
    bytes: Uint8Array,
    tabId = this.#activeTabId,
    expectedBinding?: RuntimeTerminalResponse["binding"],
  ): Promise<void> {
    this.#assertReady();
    const entry = this.#requireActiveTerminal(tabId);
    if (entry.accessMode !== "writer") {
      // An observer's keystrokes never reach the wire: the gateway would
      // close the attachment on the first one. Refuse here, by name, and
      // leave the attachment observing.
      throw runtimeFailure(
        "terminal_observer",
        "This attachment observes the terminal; input is disabled.",
      );
    }
    if (expectedBinding !== undefined && !sameEntryBinding(entry, expectedBinding)) {
      throw runtimeFailure("grant_scope_mismatch", "Terminal input targets a replaced attachment generation.");
    }
    await this.#sendTerminalBytes(entry, bytes);
  }

  async sendTerminalResponse(response: RuntimeTerminalResponse): Promise<void> {
    this.#assertReady();
    const entry = this.#requireActiveTerminal(response.tabId);
    if (
      response.binding.userId !== entry.observation.userId ||
      response.binding.machineId !== entry.observation.machineId ||
      response.binding.agentSessionId !== entry.observation.agentSessionId ||
      response.binding.processEpoch !== entry.observation.processEpoch ||
      response.binding.fencingGeneration !== entry.fencingGeneration
    ) {
      throw runtimeFailure("grant_scope_mismatch", "The terminal response targets another attachment authority.");
    }
    // The writer's headless xterm is the one that answers the PTY's queries
    // (DA1, DSR, ...). An observer mirrors the same bytes and would answer
    // them too, onto a PTY it does not hold; the gateway closes an observer's
    // attachment for that. The answer is the terminal's, not the user's, so
    // there is nothing to report: drop it.
    if (entry.accessMode !== "writer") return;
    await this.#sendTerminalBytes(entry, response.bytes);
  }

  async #sendTerminalBytes(entry: TerminalEntry, bytes: Uint8Array): Promise<void> {
    if (entry.terminalView !== undefined && !entry.terminalView.ready) throw runtimeFailure("terminal_protocol_error", "The current terminal view is not ready for input.");
    const payload = bytes.slice();
    await this.#enqueueTerminalSend(entry, async (authority) => {
      if (entry.terminalView !== undefined && !entry.terminalView.ready) throw runtimeFailure("terminal_protocol_error", "The current terminal view is not ready for input.");
      if (entry.pendingInputSequences.size >= 4_096) {
        entry.connectionRevision += 1;
        entry.outputAbort.abort(runtimeFailure("terminal_disconnected", "Terminal input acknowledgement window was exhausted."));
        entry.state = "interrupted";
        retireInputAcceptance(entry);
        entry.inputContinuity = "uncertain";
        entry.outputContinuity = "unknown";
        entry.reason = "input_ack_window_exhausted";
        this.#publish(entry);
        void authority.connection.close({ code: 1001, reason: "cuna_input_ack_window_exhausted" }).catch(() => undefined);
        throw runtimeFailure("terminal_disconnected", "Terminal input acknowledgements exceeded the bounded uncertainty window.");
      }
      this.#views.routeInput(authority.viewId, authority.fencingGeneration);
      const inputSequence = entry.wireSequence + 1n;
      const frame = encodeTerminalFrame({
        type: "input",
        critical: true,
        sequence: inputSequence,
        payload,
      });
      entry.wireSequence = inputSequence;
      entry.inputSequence = inputSequence;
      entry.pendingInputSequences.add(entry.inputSequence);
      entry.inputContinuity = "uncertain";
      await authority.connection.send(frame);
      this.#publish(entry);
    });
  }

  async resize(columns: number, rows: number, tabId = this.#activeTabId): Promise<void> {
    const entry = this.#requireActiveTerminal(tabId);
    this.#requireWriterSeat(entry);
    this.#requireGrantCapability(entry, "live_resize");
    if (entry.resizeCapability !== "live") {
      throw runtimeFailure("capability_unsupported", "This terminal supports only its initial dimensions.");
    }
    await this.#enqueueTerminalSend(entry, async (authority) => {
      this.#views.resize(authority.viewId, columns, rows);
      entry.wireSequence += 1n;
      await authority.connection.send(encodeTerminalControl("resize", entry.wireSequence, { columns, rows }));
    });
  }

  async signal(signal: "interrupt" | "suspend" | "terminate", tabId = this.#activeTabId): Promise<void> {
    const entry = this.#requireActiveTerminal(tabId);
    this.#requireWriterSeat(entry);
    this.#requireGrantCapability(entry, "signals");
    await this.#enqueueTerminalSend(entry, async (authority) => {
      this.#views.routeInput(authority.viewId, authority.fencingGeneration);
      entry.wireSequence += 1n;
      await authority.connection.send(encodeTerminalControl("signal", entry.wireSequence, { signal }));
    });
  }

  async sendLocalActionControl(
    type: "local_action_result" | "local_stream_open" | "local_stream_data" | "local_stream_close" | "local_stream_window_update",
    payload: Readonly<Record<string, unknown>>,
    tabId = this.#activeTabId,
  ): Promise<void> {
    const entry = this.#requireActiveTerminal(tabId);
    if (!entry.localActionsNegotiated) {
      throw runtimeFailure("capability_unsupported", "This attachment did not negotiate local actions.");
    }
    assertTerminalFrameLegal("attached", "client_to_server", type, true);
    await this.#enqueueTerminalSend(entry, async (authority) => {
      const sequence = entry.wireSequence + 1n;
      const wire = encodeTerminalControl(type, sequence, payload);
      const decoded = decodeTerminalFrame(wire);
      if (decoded === undefined) throw runtimeFailure("terminal_protocol_error", "The local action frame could not be decoded.");
      const validated = decodeTerminalControl(decoded);
      if (type === "local_action_result") {
        if (validated.message !== "outcome") {
          throw runtimeFailure("terminal_protocol_error", "The CLI may send only local action outcomes.");
        }
        const result = validated.result as Readonly<Record<string, unknown>>;
        const identity = result.identity as Readonly<Record<string, unknown>>;
        if (
          identity.userId !== entry.observation.userId ||
          identity.machineId !== entry.observation.machineId ||
          identity.workspaceBindingId !== entry.observation.workspaceBindingId ||
          identity.workspaceBindingGeneration !== entry.observation.workspaceBindingGeneration ||
          identity.agentSessionId !== entry.observation.agentSessionId ||
          identity.processEpoch !== entry.observation.processEpoch ||
          identity.fencingGeneration !== entry.fencingGeneration ||
          !entry.localActionAcceptance?.acceptedKinds.includes(result.kind as TerminalLocalActionKind)
        ) throw runtimeFailure("grant_scope_mismatch", "The local action outcome targets another attachment authority.");
      }
      if (
        entry.connection !== authority.connection ||
        entry.connectionRevision !== authority.connectionRevision ||
        entry.fencingGeneration !== authority.fencingGeneration
      ) throw runtimeFailure("terminal_disconnected", "The local action attachment authority changed before send.");
      entry.wireSequence = sequence;
      await authority.connection.send(wire);
    });
  }

  async #enqueueTerminalSend(
    entry: TerminalEntry,
    operation: (authority: {
      readonly connection: TerminalWireConnection;
      readonly connectionRevision: number;
      readonly viewId: string;
      readonly fencingGeneration: number;
    }) => Promise<void>,
  ): Promise<void> {
    const authority = Object.freeze({
      connection: entry.connection,
      connectionRevision: entry.connectionRevision,
      viewId: entry.viewId,
      fencingGeneration: entry.fencingGeneration,
    });
    const queued = entry.sendTail.then(async () => {
      if (
        entry.state !== "active" ||
        entry.connection !== authority.connection ||
        entry.connectionRevision !== authority.connectionRevision ||
        entry.viewId !== authority.viewId ||
        entry.fencingGeneration !== authority.fencingGeneration
      ) {
        throw runtimeFailure("terminal_disconnected", "Queued terminal input was fenced by a newer attachment.", { retryable: true });
      }
      await operation(authority);
    });
    entry.sendTail = queued.then(() => undefined, () => undefined);
    await queued;
  }

  /**
   * Ask for the terminal's writing seat. The durable transfer is confirmed by
   * the API; the seat this attachment holds changes only when the server's
   * writer_epoch notice arrives, because the gateway fences input on that
   * notice and a locally-assumed promotion would be closed on its first byte.
   */
  async takeWriter(input: { readonly tabId: string; readonly signal?: AbortSignal }): Promise<RuntimeTerminalSnapshot> {
    this.#assertReady();
    const entry = this.#requireActiveTerminal(input.tabId);
    if (entry.accessMode === "writer") return snapshot(entry, this.#heartbeatTimeoutMs(), this.#clock());
    const operation = entry.writerTransfer ?? { operationId: randomUUID(), expectedWriterEpoch: entry.writerEpoch };
    entry.writerTransfer = operation;
    if (operation.inFlight !== undefined) return operation.inFlight;
    operation.inFlight = Promise.resolve().then(async () => {
      try {
        const revision = entry.connectionRevision;
        const capabilityReadRevision = ++entry.capabilityReadRevision;
        const evidence = await this.#options.controlPlane.discoverCapabilities("agent_session", entry.observation.agentSessionId, input.signal);
        this.#assertReady();
        if (entry.state !== "active" || entry.connectionRevision !== revision) throw runtimeFailure("terminal_disconnected", "The terminal changed while writer capability was checked.");
        if (entry.writerTransfer !== operation) {
          if (entry.accessMode === "writer") return snapshot(entry, this.#heartbeatTimeoutMs(), this.#clock());
          throw runtimeFailure("session_conflict", "A writer notice superseded this control request. Read the current terminal state.");
        }
        if (entry.capabilityReadRevision !== capabilityReadRevision) throw runtimeFailure("capability_unknown", "A newer capability observation superseded this read.");
        entry.capabilitySnapshot = evidence;
        this.#publish(entry);
        const capabilityEvidence = admitCapability(evidence, { id: "terminal_writers.transfer", scope: "agent_session", subjectId: entry.observation.agentSessionId, interaction: "native" }, this.#clock());
        if (input.signal !== undefined) throwIfAborted(input.signal, "Writer transfer was cancelled before dispatch.");
        const state = await this.#options.controlPlane.transferTerminalWriter({
          capabilityEvidence,
          agentSessionId: entry.observation.agentSessionId,
          clientInstanceId: this.#options.clientInstanceId,
          expectedWriterEpoch: operation.expectedWriterEpoch,
          operationId: operation.operationId,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        if (state.agentSessionId !== entry.observation.agentSessionId ||
            state.processEpoch !== entry.observation.processEpoch ||
            state.writerClientInstanceId !== this.#options.clientInstanceId ||
            state.operationId !== operation.operationId || state.operationState !== "committed" ||
            state.writerEpoch !== operation.expectedWriterEpoch + 1) {
          throw runtimeFailure("grant_scope_mismatch", "The writer transfer answered for another terminal, operation, or epoch.");
        }
        // A later server notice may already have superseded this HTTP reply.
        if (entry.writerTransfer === operation && state.writerEpoch >= entry.writerEpoch) {
          if (state.writerEpoch !== entry.writerEpoch) {
            retireInputAcceptance(entry);
            entry.geometry = null;
          }
          entry.writerEpoch = state.writerEpoch;
          entry.writerClientInstanceId = state.writerClientInstanceId;
          if (state.transferPending) entry.reason = "writer_transfer_pending";
          this.#publish(entry);
        }
        return snapshot(entry, this.#heartbeatTimeoutMs(), this.#clock());
      } catch (error) {
        const reason = typeof error === "object" && error !== null
          ? (error as { readonly details?: { readonly reason?: unknown } }).details?.reason : undefined;
        // A missing response or an in-progress operation retains its identity.
        // A definitive refusal ends this request, without granting input rights.
        if (entry.writerTransfer === operation && typeof reason === "string" &&
            ["terminal_writer_cancelled", "terminal_writer_stale", "terminal_writer_unheld",
              "terminal_writer_already_held", "terminal_writer_operation_mismatch", "invalid_terminal_writer_request"].includes(reason)) {
          delete entry.writerTransfer;
        }
        throw error;
      }
    }).finally(() => { delete operation.inFlight; });
    return operation.inFlight;
  }

  async reconnect(input: { readonly tabId: string; readonly signal?: AbortSignal }): Promise<RuntimeTerminalSnapshot> {
    this.#assertReady();
    const entry = this.#requireTerminal(input.tabId);
    if (entry.state !== "interrupted") {
      throw runtimeFailure("session_conflict", "Only an interrupted terminal can reconnect.");
    }
    entry.state = "reconnecting";
    entry.outputAbort.abort(runtimeFailure("terminal_disconnected", "The previous terminal attachment was interrupted."));
    const reconnectRevision = entry.connectionRevision + 1;
    entry.connectionRevision = reconnectRevision;
    retireInputAcceptance(entry);
    entry.outputContinuity = "unknown";
    delete entry.reason;
    this.#publish(entry);
    const reconnectAbort = new AbortController();
    let removeInputAbort = (): void => undefined;
    if (input.signal !== undefined) {
      const forwardAbort = (): void => reconnectAbort.abort(input.signal?.reason);
      if (input.signal.aborted) forwardAbort();
      else {
        input.signal.addEventListener("abort", forwardAbort, { once: true });
        removeInputAbort = () => input.signal?.removeEventListener("abort", forwardAbort);
      }
    }
    let settleReconnect = (_failure?: unknown): void => undefined;
    const reconnectCompletion = new Promise<unknown | undefined>((resolve) => { settleReconnect = resolve; });
    this.#pendingReconnects.set(input.tabId, {
      abort: reconnectAbort,
      completion: reconnectCompletion,
      settle: settleReconnect,
      removeInputAbort,
    });
    let connection: TerminalWireConnection | undefined;
    let completionFailure: unknown | undefined;
    try {
      throwIfAborted(reconnectAbort.signal, "Terminal reconnection was cancelled.");
      await this.#cancelConnectionRequests(entry.observation.agentSessionId);
      entry.reconnectIdempotencyKey ??= this.#idempotencyKey();
      const admitted = await this.#admitRemoteTerminal(entry.observation.agentSessionId, reconnectAbort.signal);
      throwIfAborted(reconnectAbort.signal, "Terminal reconnection was cancelled.");
      if (entry.connectionRevision !== reconnectRevision || entry.state !== "reconnecting" || this.#closed) {
        throw runtimeFailure("terminal_disconnected", "Terminal reconnection was superseded during admission.");
      }
      if (
        admitted.observation.userId !== entry.observation.userId ||
        admitted.observation.machineId !== entry.observation.machineId ||
        admitted.observation.workspaceBindingId !== entry.observation.workspaceBindingId ||
        admitted.observation.workspaceBindingGeneration !== entry.observation.workspaceBindingGeneration ||
        admitted.observation.agentSessionId !== entry.observation.agentSessionId ||
        admitted.observation.processEpoch !== entry.observation.processEpoch
      ) {
        entry.state = "failed";
        entry.outputContinuity = "incomplete";
        entry.reason = "session_authority_changed";
        this.#publish(entry);
        throw runtimeFailure("session_discontinuous", "The remote AgentSession authority changed; this terminal cannot be resumed.");
      }
      await entry.connection.close({ code: 1001, reason: "cuna_reconnect" });
      throwIfAborted(reconnectAbort.signal, "Terminal reconnection was cancelled.");
      const grant = await this.#createGrant(
        admitted.observation,
        admitted.capability,
        undefined,
        entry.reconnectIdempotencyKey,
        reconnectAbort.signal,
        // Reclaim the seat the durable row names for this client, at the epoch
        // it last saw: a confirmed transfer (takeWriter) names this client
        // before the promotion notice arrives, and a reconnect in that window
        // must ask as the writer, not as the observer it still renders as. If
        // the seat moved meanwhile the server says so and the reconnect lands
        // as an observer, which is the truth of it.
        entry.accessMode === "writer" || entry.writerClientInstanceId === this.#options.clientInstanceId
          ? { accessMode: "writer", expectedWriterEpoch: entry.writerEpoch }
          : { accessMode: "observer" },
      );
      // A ConnectionGrant is one-use. Once the control plane has returned a
      // replacement grant, retrying that mutation key after the WebSocket has
      // consumed it can only return idempotency_consumed. A reconnect gets a
      // fresh grant-scoped resume handle; retained output remains scoped to the
      // same AgentSession and is selected by afterOutputSequence below.
      delete entry.reconnectIdempotencyKey;
      throwIfAborted(reconnectAbort.signal, "Terminal reconnection was cancelled.");
      const revalidated = await this.#admitRemoteTerminal(entry.observation.agentSessionId, reconnectAbort.signal);
      this.#assertAttachmentAdmissionContinuity(admitted, revalidated, "post_grant");
      try {
        this.#assertObservationContinuity(entry.observation, revalidated.observation, "reconnect");
      } catch (error) {
        entry.state = "failed";
        entry.outputContinuity = "incomplete";
        entry.reason = "session_authority_changed";
        this.#publish(entry);
        throw error;
      }
      throwIfAborted(reconnectAbort.signal, "Terminal reconnection was cancelled.");
      if (entry.connectionRevision !== reconnectRevision || entry.state !== "reconnecting" || this.#closed) {
        throw runtimeFailure("terminal_disconnected", "Terminal reconnection was superseded before transport creation.");
      }
      connection = await this.#options.terminalConnector.connect({
        url: grant.connectUrl,
        token: grant.connectToken,
        protocol: TERMINAL_PROTOCOL,
        ...(this.#options.canonicalTerminalViews === true ? { terminalViewProtocol: "cuna.terminal-view.v1" as const } : {}),
        signal: reconnectAbort.signal,
      });
      throwIfAborted(reconnectAbort.signal, "Terminal reconnection was cancelled.");
      if (connection.connectionId !== grant.terminalSessionId) {
        throw runtimeFailure("grant_scope_mismatch", "The terminal transport accepted a different Cuna terminal session.");
      }
      const iterator = connection.receive()[Symbol.asyncIterator]();
      const previousViewId = entry.viewId;
      const nextDecoder = new TerminalFrameDecoder();
      const candidate: TerminalEntry = {
        ...entry,
        capabilitySnapshot: revalidated.capabilitySnapshot,
        observation: revalidated.observation,
        connection,
        decoder: nextDecoder,
        capabilities: grant.capabilities,
        resumeHandle: grant.resumeHandle,
        lastHeartbeatAt: this.#clock(),
        heartbeatSequence: 0n,
        heartbeatSendPending: false,
        outputAbort: new AbortController(),
        localActionsNegotiated: false,
        localActionAcceptance: undefined,
        accessMode: "observer",
        writerEpoch: 0,
        writerClientInstanceId: null,
        wireWriterNotice: undefined,
        geometry: null,
        heldSeat: false,
      };
      const ready = await this.#awaitReady(candidate, iterator, reconnectAbort.signal);
      if (entry.terminalView !== undefined && ready.payload.terminalViewProtocol === undefined) throw runtimeFailure("terminal_protocol_error", "A canonical view cannot resume as a raw stream.");
      if (ready.payload.terminalViewProtocol !== undefined && this.#options.canonicalTerminalViews !== true) throw runtimeFailure("terminal_protocol_error", "Unrequested terminal view protocol.");
      candidate.lastHeartbeatAt = this.#clock();
      candidate.localActionAcceptance = this.#localActionAcceptance(
        ready.payload.localActionProtocol,
        candidate.observation.agentSessionId,
      );
      if (entry.connectionRevision !== reconnectRevision || entry.state !== "reconnecting" || this.#closed) {
        throw runtimeFailure("terminal_disconnected", "Terminal reconnection was superseded by detach or shutdown.");
      }
      if (ready.payload.fencingGeneration <= entry.fencingGeneration) {
        throw runtimeFailure("grant_invalid", "The reconnect readiness frame did not advance the attachment fence.");
      }
      const nextViewId = viewId(entry.tabId, ready.payload.fencingGeneration);
      this.#requireGrantCapability(candidate, "live_resize");
      if (candidate.resizeCapability !== "live") {
        throw runtimeFailure("capability_unsupported", "The reconnected terminal cannot restore its dimensions.");
      }
      const previous = this.#views.require(previousViewId);
      // As on attach: an observer never resizes the PTY. The seat that
      // decides is the one this READY names, not the one held before the
      // interruption: a writer may land back as an observer (the gateway
      // would close the attachment on the RESIZE) and an observer may land
      // as the writer (the PTY geometry must then be restored).
      const landsAsWriter = ready.payload.accessMode === "writer";
      const resizeSequence = landsAsWriter ? entry.wireSequence + 1n : entry.wireSequence;
      if (landsAsWriter) {
        await connection.send(encodeTerminalControl("resize", resizeSequence, {
          columns: previous.columns,
          rows: previous.rows,
        }));
      }
      const resumeSequence = resizeSequence + 1n;
      await connection.send(encodeTerminalControl("resume", resumeSequence, {
        resumeHandle: grant.resumeHandle,
        afterOutputSequence: ready.payload.terminalViewProtocol === undefined ? entry.outputSequence.toString() : "0",
        ...(ready.payload.terminalViewProtocol === undefined ? {} : { terminalViewProtocol: { name: "cuna.terminal-view.v1", operation: "new" } }),
        ...(candidate.localActionAcceptance === undefined ? {} : { localActionProtocol: candidate.localActionAcceptance }),
      }));
      if (entry.connectionRevision !== reconnectRevision || entry.state !== "reconnecting" || this.#closed) {
        throw runtimeFailure("terminal_disconnected", "Terminal reconnection was superseded by detach or shutdown.");
      }
      try { this.#views.detach(previousViewId); } catch { /* the prior view may already be detached */ }
      this.#views.open({
        viewId: nextViewId,
        binding: {
          userId: revalidated.observation.userId,
          machineId: revalidated.observation.machineId,
          agentSessionId: revalidated.observation.agentSessionId,
          processEpoch: revalidated.observation.processEpoch,
          fencingGeneration: ready.payload.fencingGeneration,
        },
        state: "active",
        columns: previous.columns,
        rows: previous.rows,
      });
      entry.connection = connection;
      if (ready.payload.terminalViewProtocol !== undefined) {
        entry.terminalView = { viewId: null, ready: false };
        entry.outputSequence = 0n;
      }
      this.#clearHeartbeatWatchdog(entry);
      entry.observation = revalidated.observation;
      entry.capabilitySnapshot = revalidated.capabilitySnapshot;
      entry.decoder = nextDecoder;
      entry.fencingGeneration = ready.payload.fencingGeneration;
      entry.capabilities = grant.capabilities;
      entry.resizeCapability = ready.payload.resizeCapability;
      // A writer that reconnects and lands as an observer was demoted by a
      // transfer while it was away: the notice frame that would have said so
      // was queued to the attachment that closed. Say it from the durable
      // fact instead, so the former writer is never left observing in
      // silence.
      entry.accessMode = ready.payload.accessMode;
      entry.writerEpoch = ready.payload.writerEpoch;
      entry.writerClientInstanceId = ready.payload.accessMode === "writer" ? this.#options.clientInstanceId : null;
      entry.wireWriterNotice = ready.payload.accessMode === "writer" ? Object.freeze({
        writerEpoch: ready.payload.writerEpoch, writerClientInstanceId: this.#options.clientInstanceId, accessMode: "writer",
      }) : undefined;
      entry.geometry = null;
      if (entry.writerTransfer !== undefined && ready.payload.writerEpoch > entry.writerTransfer.expectedWriterEpoch) {
        delete entry.writerTransfer;
      }
      if (ready.payload.accessMode === "writer") entry.heldSeat = true;
      else if (entry.heldSeat) entry.reason = "writer_transferred";
      else delete entry.reason;
      entry.viewId = nextViewId;
      entry.resumeHandle = grant.resumeHandle;
      entry.localActionAcceptance = candidate.localActionAcceptance;
      entry.localActionsNegotiated = candidate.localActionAcceptance !== undefined;
      entry.wireSequence = resumeSequence;
      entry.replayBoundarySequence = resumeSequence;
      entry.replayBoundaryObserved = false;
      entry.heartbeatSequence = 0n;
      entry.heartbeatSendPending = false;
      entry.outputAbort = candidate.outputAbort;
      entry.lastHeartbeatAt = candidate.lastHeartbeatAt;
      entry.state = "active";
      entry.outputContinuity = "unknown";
      await this.#options.onTerminalReady?.(snapshot(entry, this.#heartbeatTimeoutMs(), this.#clock()));
      this.#armTerminalViewDeadline(entry);
      for (const frame of ready.bufferedFrames) await this.#handleAttachedFrame(entry, frame);
      this.#scheduleHeartbeatWatchdog(entry, connection, reconnectRevision);
      this.#publish(entry);
      entry.pump = this.#pump(entry, connection, reconnectRevision, iterator);
      this.#forgetConnectionRequests(entry.observation.agentSessionId);
      return snapshot(entry, this.#heartbeatTimeoutMs(), this.#clock());
    } catch (error) {
      let reportedError: unknown = error;
      if (connection !== undefined) {
        try { await connection.close({ code: 1008, reason: "cuna_resume_rejected" }); } catch (cleanupError) {
          completionFailure = cleanupError;
          reportedError = new AggregateError([error, cleanupError], "Terminal reconnection failed and its replacement transport cleanup was incomplete.");
        }
      }
      try { await this.#cancelConnectionRequests(entry.observation.agentSessionId); } catch (cleanupError) {
        completionFailure = cleanupError;
        reportedError = new AggregateError([reportedError, cleanupError], "Terminal reconnect failed and issuance cancellation is unconfirmed.");
      }
      if (
        entry.connectionRevision === reconnectRevision &&
        entry.state !== "failed"
      ) {
        entry.state = isPermanentInputRecoveryFailure(error) || isHistoryGap(error) ? "failed" : "interrupted";
        entry.outputContinuity = "unknown";
        entry.reason = safeReason(isPermanentInputRecoveryFailure(error) || isHistoryGap(error) ? error : reportedError);
        this.#publish(entry);
      }
      throw reportedError;
    } finally {
      const pending = this.#pendingReconnects.get(input.tabId);
      pending?.removeInputAbort();
      pending?.settle(completionFailure);
      this.#pendingReconnects.delete(input.tabId);
    }
  }

  async detach(tabId: string): Promise<void> {
    const entry = this.#requireTerminal(tabId);
    if (entry.state === "closed") {
      this.#terminals.delete(tabId);
      if (this.#activeTabId === tabId) this.#activeTabId = this.#nextActiveTab(tabId);
      return;
    }
    const pendingReconnect = this.#pendingReconnects.get(tabId);
    pendingReconnect?.abort.abort(runtimeFailure("terminal_disconnected", "The terminal reconnection was detached."));
    entry.connectionRevision += 1;
    entry.outputAbort.abort(runtimeFailure("terminal_disconnected", "The terminal attachment was detached."));
    this.#clearHeartbeatWatchdog(entry);
    try { this.#views.detach(entry.viewId); } catch { /* attach may have failed before view creation */ }
    entry.state = "detached";
    entry.reason = "explicit_detach";
    this.#publish(entry);
    const sendDrain = entry.sendTail;
    const pumpDrain = entry.pump;
    await entry.connection.close({ code: 1000, reason: "cuna_detach" });
    await sendDrain;
    if (pumpDrain !== undefined) await withOutputDeadline(pumpDrain, this.#options.outputDeliveryTimeoutMs ?? 5_000);
    if (pendingReconnect !== undefined) {
      await withOutputDeadline(pendingReconnect.completion, this.#options.readyTimeoutMs ?? 10_000);
    }
    if (this.#activeTabId === tabId) this.#activeTabId = this.#nextActiveTab(tabId);
    this.#terminals.delete(tabId);
  }

  listTerminals(): readonly RuntimeTerminalSnapshot[] {
    return Object.freeze([...this.#terminals.values()].map((entry) => snapshot(entry, this.#heartbeatTimeoutMs(), this.#clock())));
  }

  async openSync(input: {
    readonly configuration: SupervisorConfiguration;
    readonly journalDirectory: string;
    readonly ownerId: string;
    readonly leaseMs?: number;
  }): Promise<RuntimeSyncHandle> {
    if (this.#mode !== "daemon") {
      throw runtimeFailure("capability_unsupported", "Foreground runtime mode cannot own workspace synchronization.");
    }
    this.#assertReady();
    if (this.#syncHandles.has(input.configuration.bindingId) || this.#pendingSyncOpens.has(input.configuration.bindingId)) {
      throw runtimeFailure("session_conflict", "This runtime already owns the workspace sync binding.");
    }
    let settleOpen = (_failure?: unknown): void => undefined;
    const openCompletion = new Promise<unknown | undefined>((resolve) => { settleOpen = resolve; });
    this.#pendingSyncOpens.set(input.configuration.bindingId, openCompletion);
    let journal: DurableSyncJournal | undefined;
    let completionFailure: unknown | undefined;
    try {
      journal = await DurableSyncJournal.open({
        directory: input.journalDirectory,
        bindingId: input.configuration.bindingId,
        bindingGeneration: input.configuration.bindingGeneration,
        ownerId: input.ownerId,
        ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }),
        clock: this.#clock,
      });
      this.#assertOpen();
      if (this.#syncHandles.has(input.configuration.bindingId)) {
        throw runtimeFailure("session_conflict", "This runtime already owns the workspace sync binding.");
      }
      const openedJournal = journal;
      const { supervisor } = this.#syncRegistry.connect(input.configuration, this.#clock);
      supervisor.beginReconciliation("runtime_start_requires_authoritative_manifest");
      let closed = false;
      let closing: Promise<void> | undefined;
      const handle: RuntimeSyncHandle = Object.freeze({
        bindingId: input.configuration.bindingId,
        fence: openedJournal.fence,
        supervisor,
        close: async (): Promise<void> => {
          if (closed) return;
          closing ??= (async () => {
            await openedJournal.close();
            this.#syncRegistry.release(input.configuration.bindingId, supervisor);
            this.#syncHandles.delete(input.configuration.bindingId);
            closed = true;
          })();
          try {
            await closing;
          } finally {
            if (!closed) closing = undefined;
          }
        },
      });
      this.#syncHandles.set(input.configuration.bindingId, handle);
      return handle;
    } catch (error) {
      if (journal !== undefined) {
        try {
          await journal.close();
        } catch (cleanupError) {
          completionFailure = new AggregateError([error, cleanupError], "The sync journal failed to close after an open failure.");
          throw completionFailure;
        }
      }
      throw error;
    } finally {
      settleOpen(completionFailure);
      this.#pendingSyncOpens.delete(input.configuration.bindingId);
    }
  }

  async shutdown(): Promise<void> {
    if (this.#shutdownComplete) return;
    if (this.#shutdownFlight !== undefined) return await this.#shutdownFlight;
    this.#closed = true;
    const attempt = this.#performShutdown();
    this.#shutdownFlight = attempt;
    try {
      await attempt;
      this.#shutdownComplete = true;
    } finally {
      if (this.#shutdownFlight === attempt) this.#shutdownFlight = undefined;
    }
  }

  async #performShutdown(): Promise<void> {
    if (this.#mode === "foreground" && this.#foreground.state === "ready") {
      this.#foreground = Object.freeze({
        state: "quiescing",
        reason: "foreground_runtime_shutdown",
        updatedAt: this.#clock(),
      });
    }
    const state = this.#daemon.snapshot().state;
    if (state === "ready" || state === "degraded" || state === "reconciling") {
      this.#daemon.transition("quiescing", "runtime_shutdown", this.#clock());
    }
    const failures: unknown[] = [];
    const pendingAttaches = [...this.#pendingAttaches.values()];
    const pendingReconnects = [...this.#pendingReconnects.values()];
    const pendingSyncOpens = [...this.#pendingSyncOpens.values()];
    for (const pending of pendingAttaches) {
      pending.abort.abort(runtimeFailure("terminal_disconnected", "The terminal runtime was shut down."));
    }
    for (const pending of pendingReconnects) {
      pending.abort.abort(runtimeFailure("terminal_disconnected", "The terminal runtime was shut down."));
    }
    for (const [tabId, entry] of this.#terminals) {
      entry.connectionRevision += 1;
      entry.outputAbort.abort(runtimeFailure("terminal_disconnected", "The terminal runtime was shut down."));
      this.#clearHeartbeatWatchdog(entry);
      const sendDrain = entry.sendTail;
      const pumpDrain = entry.pump;
      try {
        await entry.connection.close({ code: 1000, reason: "cuna_shutdown" });
        await sendDrain;
        if (pumpDrain !== undefined) await withOutputDeadline(pumpDrain, this.#options.outputDeliveryTimeoutMs ?? 5_000);
      } catch (error) {
        failures.push(error);
        entry.state = "failed";
        entry.reason = "runtime_shutdown_cleanup_failed";
        this.#publish(entry);
        continue;
      }
      entry.state = "closed";
      entry.reason = "runtime_shutdown";
      try { this.#views.detach(entry.viewId); } catch { /* the view may already be detached */ }
      this.#publish(entry);
      this.#terminals.delete(tabId);
    }
    this.#activeTabId = this.#terminals.size === 0 ? undefined : this.#nextActiveTab("");
    for (const pending of pendingAttaches) {
      try {
        const failure = await withOutputDeadline(pending.completion, this.#options.readyTimeoutMs ?? 10_000);
        if (failure !== undefined) failures.push(failure);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const pending of pendingReconnects) {
      try {
        const failure = await withOutputDeadline(pending.completion, this.#options.readyTimeoutMs ?? 10_000);
        if (failure !== undefined) failures.push(failure);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const pending of pendingSyncOpens) {
      try {
        const failure = await withOutputDeadline(pending, this.#options.readyTimeoutMs ?? 10_000, () => runtimeFailure(
          "runtime_cleanup_timeout",
          "Workspace synchronization is still closing. Retry shutdown to finish cleanup.",
          { retryable: true },
        ));
        if (failure !== undefined) failures.push(failure);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const handle of this.#syncHandles.values()) {
      try { await handle.close(); } catch (error) { failures.push(error); }
    }
    for (const subject of new Set([...this.#pendingConnectionRequests.values()].map(request => request.agentSessionId))) {
      try { await this.#cancelConnectionRequests(subject); } catch (error) { failures.push(error); }
    }
    if (this.#mode === "foreground") {
      this.#foreground = Object.freeze({
        state: failures.length === 0 ? "stopped" : "cleanup_failed",
        reason: failures.length === 0 ? "foreground_runtime_stopped" : "foreground_runtime_cleanup_failed",
        updatedAt: this.#clock(),
      });
    } else {
      const after = this.#daemon.snapshot().state;
      if (failures.length === 0) {
        if (after === "quiescing" || after === "recovery_required" || after === "starting") {
          this.#daemon.transition("stopped", "runtime_stopped", this.#clock());
        }
      } else if (after === "quiescing" || after === "starting") {
        this.#daemon.transition("recovery_required", "runtime_shutdown_cleanup_failed", this.#clock());
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "The Cuna runtime stopped with cleanup failures.");
  }

  async #admitRemoteTerminal(agentSessionId: string, signal?: AbortSignal): Promise<{
    readonly capabilitySnapshot: CapabilitySnapshot;
    readonly capability: ReturnType<typeof admitCapability>;
    readonly observation: RemoteAgentSessionEvidence;
  }> {
    const snapshot = await this.#options.controlPlane.discoverCapabilities("agent_session", agentSessionId, signal);
    const capability = admitCapability(snapshot, {
      id: this.#options.terminalCapabilityId,
      scope: "agent_session",
      subjectId: agentSessionId,
      surface: "cli",
      interaction: "native",
    }, this.#clock());
    const observation = assertRemoteAgentSessionEvidence({
      evidence: await this.#options.controlPlane.observeAgentSession(agentSessionId, signal),
      expectedAgentSessionId: agentSessionId,
      now: this.#clock(),
    });
    return Object.freeze({ capability, observation, capabilitySnapshot: snapshot });
  }

  #assertAttachmentAdmissionContinuity(
    expected: TerminalAttachmentAdmission,
    actual: TerminalAttachmentAdmission,
    phase: "preflight" | "post_grant",
  ): void {
    this.#assertObservationContinuity(expected.observation, actual.observation, phase);
    const now = this.#clock();
    if (
      expected.capability.capabilityId !== actual.capability.capabilityId ||
      expected.capability.scope !== actual.capability.scope ||
      expected.capability.subjectId !== actual.capability.subjectId
    ) {
      throw runtimeFailure(
        "capability_scope_mismatch",
        `Terminal capability scope changed during ${phase === "preflight" ? "preflight" : "post-grant"} admission.`,
      );
    }
    if (expected.capability.expiresAt <= now || actual.capability.expiresAt <= now) {
      throw runtimeFailure(
        "capability_snapshot_expired",
        `Terminal capability authority expired during ${phase === "preflight" ? "preflight" : "post-grant"} admission.`,
      );
    }
    if (expected.capability.snapshotEtag !== actual.capability.snapshotEtag) {
      throw runtimeFailure(
        "capability_unknown",
        `Terminal capability authority changed during ${phase === "preflight" ? "preflight" : "post-grant"} admission.`,
      );
    }
  }

  #assertObservationContinuity(
    expected: RemoteAgentSessionEvidence,
    actual: RemoteAgentSessionEvidence,
    phase: "preflight" | "post_grant" | "reconnect",
  ): void {
    if (
      expected.authority !== actual.authority ||
      expected.userId !== actual.userId ||
      expected.machineId !== actual.machineId ||
      expected.workspaceBindingId !== actual.workspaceBindingId ||
      expected.workspaceBindingGeneration !== actual.workspaceBindingGeneration ||
      expected.agentSessionId !== actual.agentSessionId ||
      expected.processEpoch !== actual.processEpoch
    ) {
      throw runtimeFailure(
        "session_discontinuous",
        `The AgentSession machine or process generation changed during ${phase === "post_grant" ? "post-grant" : phase} admission.`,
      );
    }
  }

  async #createGrant(
    observation: RemoteAgentSessionEvidence,
    capability: ReturnType<typeof admitCapability>,
    resumeHandle: string | undefined,
    idempotencyKey = this.#idempotencyKey(),
    signal?: AbortSignal,
    seat: { readonly accessMode: "writer" | "observer"; readonly expectedWriterEpoch?: number } = { accessMode: "writer" },
  ): Promise<TerminalConnectionGrant> {
    const request = (accessMode: "writer" | "observer", key: string): Promise<TerminalConnectionGrant> => {
      const ownedRequest = {
        agentSessionId: observation.agentSessionId,
        protocol: TERMINAL_PROTOCOL,
        clientInstanceId: this.#options.clientInstanceId,
        idempotencyKey: key,
        capabilityEvidence: capability,
        accessMode,
        ...(resumeHandle === undefined ? {} : { resumeHandle }),
        ...(accessMode === "writer" && seat.expectedWriterEpoch !== undefined
          ? { expectedWriterEpoch: seat.expectedWriterEpoch }
          : {}),
        ...(signal === undefined ? {} : { signal }),
      };
      this.#pendingConnectionRequests.set(key, ownedRequest);
      return this.#options.controlPlane.createTerminalConnection(ownedRequest);
    };
    let grant: TerminalConnectionGrant;
    try {
      grant = await request(seat.accessMode, idempotencyKey);
    } catch (error) {
      // The writing seat belongs to another client of this principal, or it
      // moved while this one was away. Attach as an observer instead of
      // failing: the terminal is still visible, and Ctrl+] w asks for the
      // seat later through the transfer the server arbitrates.
      if (seat.accessMode !== "writer" || !writerSeatUnavailable(error)) throw error;
      this.#pendingConnectionRequests.delete(idempotencyKey);
      grant = await request("observer", this.#idempotencyKey());
    }
    return validateTerminalGrant({
      grant,
      allowedCunaOrigins: this.#options.allowedCunaOrigins,
      requiredCapabilities: ["acknowledgement", "heartbeat", "resume", "live_resize"],
      now: this.#clock(),
    });
  }

  #forgetConnectionRequests(agentSessionId: string): void {
    for (const [key, request] of this.#pendingConnectionRequests) {
      if (request.agentSessionId === agentSessionId) this.#pendingConnectionRequests.delete(key);
    }
  }

  async #cancelConnectionRequests(agentSessionId: string): Promise<void> {
    for (const [key, request] of this.#pendingConnectionRequests) {
      if (request.agentSessionId !== agentSessionId) continue;
      const signal = AbortSignal.timeout(this.#options.readyTimeoutMs ?? 10_000);
      try {
        await withOutputDeadline(this.#options.controlPlane.cancelTerminalConnection({ ...request, signal }), this.#options.readyTimeoutMs ?? 10_000, () => runtimeFailure(
          "runtime_cleanup_timeout", "Terminal issuance cancellation is unconfirmed. Retry cleanup with the original request.", { retryable: true },
        ));
      } catch (error) {
        const reason = (error as { readonly details?: { readonly reason?: string } })?.details?.reason;
        // This endpoint fences unredeemed issuance only. A redeemed connection
        // is closed through the owned socket; cancellation cannot detach it.
        if (reason !== "terminal_connection_already_redeemed") throw error;
      }
      this.#pendingConnectionRequests.delete(key);
      for (const entry of this.#terminals.values()) {
        if (entry.observation.agentSessionId === agentSessionId && entry.reconnectIdempotencyKey === key) delete entry.reconnectIdempotencyKey;
      }
    }
  }

  async #awaitReady(
    entry: TerminalEntry,
    iterator: AsyncIterator<Uint8Array>,
    signal: AbortSignal | undefined,
  ): Promise<{
    readonly payload: Readonly<Record<string, unknown>> & import("../terminal/codec.js").TerminalReadyPayload;
    readonly bufferedFrames: readonly TerminalFrame[];
  }> {
    const deadlineMs = this.#options.readyTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) {
      throw runtimeFailure("terminal_timeout", "The terminal readiness deadline is invalid.");
    }
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw runtimeFailure("terminal_disconnected", "Terminal attachment was cancelled.");
      const remaining = deadline - Date.now();
      const result = await nextWithTimeout(iterator, remaining, signal);
      if (result.done) throw runtimeFailure("terminal_not_ready", "The terminal closed before PTY readiness was proven.");
      const frames = entry.decoder.push(result.value);
      for (let index = 0; index < frames.length; index += 1) {
        const frame = frames[index];
        if (frame === undefined) continue;
        assertTerminalFrameLegal("negotiating", "server_to_client", frame.type);
        if (frame.type === "error") throw this.#remoteTerminalError(frame, entry.observation.agentSessionId);
        if (frame.type !== "ready") continue;
        const payload = decodeTerminalControl(frame);
        assertReadyPayloadMatches(payload, entry.observation);
        return Object.freeze({
          payload,
          bufferedFrames: Object.freeze(frames.slice(index + 1)),
        });
      }
    }
    throw runtimeFailure("terminal_timeout", "The terminal did not prove PTY readiness before the deadline.", { retryable: true });
  }

  #requireGrantCapability(entry: TerminalEntry, name: TerminalConnectionCapability["name"]): void {
    const matches = entry.capabilities.filter((capability) => capability.name === name);
    if (matches.length !== 1 || matches[0]?.availability === "unknown") {
      throw runtimeFailure("capability_unknown", `Cuna cannot prove terminal capability ${name}.`);
    }
    if (matches[0]?.availability !== "supported") {
      throw runtimeFailure("capability_unsupported", `Terminal capability ${name} is unsupported.`);
    }
  }

  async #pump(
    entry: TerminalEntry,
    connection: TerminalWireConnection,
    connectionRevision: number,
    iterator: AsyncIterator<Uint8Array>,
  ): Promise<void> {
    try {
      for (;;) {
        const result = await iterator.next();
        if (entry.connection !== connection || entry.connectionRevision !== connectionRevision) return;
        if (result.done) break;
        for (const frame of entry.decoder.push(result.value)) {
          if (
            entry.connection !== connection ||
            entry.connectionRevision !== connectionRevision ||
            entry.state === "closed" ||
            entry.state === "detached" ||
            entry.state === "failed"
          ) return;
          await this.#handleAttachedFrame(entry, frame);
        }
        if (entry.state === "closed" || entry.state === "detached") return;
      }
      if (entry.state === "active" || entry.state === "reconnecting") {
        this.#clearHeartbeatWatchdog(entry);
        entry.outputAbort.abort(runtimeFailure("terminal_disconnected", "The terminal transport closed."));
        entry.state = "interrupted";
        retireInputAcceptance(entry);
        entry.outputContinuity = "unknown";
        entry.reason = "transport_closed_without_terminal_exit";
        this.#publish(entry);
      }
    } catch (error) {
      if (entry.connection !== connection || entry.connectionRevision !== connectionRevision) return;
      if (entry.state === "detached" || entry.state === "closed") return;
      this.#clearHeartbeatWatchdog(entry);
      entry.outputAbort.abort(error);
      entry.state = (
        error instanceof TerminalProtocolError ||
        (error instanceof RuntimeBoundaryError && error.code === "terminal_protocol_error") || isHistoryGap(error)
      ) ? "failed" : "interrupted";
      retireInputAcceptance(entry);
      entry.outputContinuity = "unknown";
      entry.reason = safeReason(error);
      this.#publish(entry);
      await connection.close({ code: 1002, reason: "cuna_terminal_protocol_failure" }).catch(() => undefined);
    }
  }

  #armTerminalViewDeadline(entry: TerminalEntry): void {
    if (entry.terminalViewDeadline !== undefined) clearTimeout(entry.terminalViewDeadline);
    if (entry.terminalView === undefined) return;
    const revision = entry.connectionRevision;
    entry.terminalViewDeadline = setTimeout(() => {
      if (this.#closed || entry.connectionRevision !== revision || entry.state !== "active" || entry.terminalView?.ready === true) return;
      const failure = runtimeFailure("terminal_protocol_error", "The current terminal view did not become ready before its deadline.");
      entry.outputAbort.abort(failure);
      entry.state = "failed";
      entry.outputContinuity = "incomplete";
      retireInputAcceptance(entry);
      this.#publish(entry);
      void entry.connection.close({ code: 1002, reason: "cuna_terminal_view_timeout" }).catch(() => undefined);
    }, this.#options.readyTimeoutMs ?? 5_000);
    entry.terminalViewDeadline.unref();
  }

  async #handleAttachedFrame(entry: TerminalEntry, frame: TerminalFrame): Promise<void> {
    assertTerminalFrameLegal("attached", "server_to_client", frame.type, entry.localActionsNegotiated);
    if (isLocalActionFrameType(frame.type)) {
      const payload = decodeTerminalControl(frame);
      if (frame.type === "local_action_request") {
        const request = payload.request as Readonly<Record<string, unknown>>;
        const identity = request.identity as Readonly<Record<string, unknown>>;
        if (
          identity.userId !== entry.observation.userId ||
          identity.machineId !== entry.observation.machineId ||
          identity.workspaceBindingId !== entry.observation.workspaceBindingId ||
          identity.workspaceBindingGeneration !== entry.observation.workspaceBindingGeneration ||
          identity.agentSessionId !== entry.observation.agentSessionId ||
          identity.processEpoch !== entry.observation.processEpoch ||
          identity.fencingGeneration !== entry.fencingGeneration ||
          !entry.localActionAcceptance?.acceptedKinds.includes(request.kind as TerminalLocalActionKind)
        ) {
          throw runtimeFailure("grant_scope_mismatch", "The local action request targets another attachment authority.");
        }
      }
      if (this.#options.onLocalActionFrame === undefined) {
        throw runtimeFailure("terminal_protocol_error", "A local action frame arrived without a local broker consumer.");
      }
      await this.#options.onLocalActionFrame({ tabId: entry.tabId, frame, payload });
      return;
    }
    if (frame.type === "control_state") {
      const geometry = decodeTerminalControl(frame) as unknown as TerminalGeometryPayload;
      // HTTP may reveal a newer committed epoch before an older queued wire
      // notice arrives. Ignore its geometry without losing the attachment.
      if (geometry.writerEpoch < entry.writerEpoch) return;
      if (geometry.writerEpoch !== entry.writerEpoch) {
        throw runtimeFailure("terminal_protocol_error", "Terminal geometry targets a different writer epoch.");
      }
      entry.geometry = geometry;
      if (this.#options.onTerminalGeometry !== undefined) {
        const timeoutMs = this.#options.outputDeliveryTimeoutMs ?? 5_000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
          throw runtimeFailure("terminal_protocol_error", "The terminal geometry delivery deadline is invalid.");
        }
        try {
          await withOutputDeadline(Promise.resolve(this.#options.onTerminalGeometry({
            snapshot: snapshot(entry, this.#heartbeatTimeoutMs(), this.#clock()), signal: entry.outputAbort.signal,
          })), timeoutMs, () => runtimeFailure("terminal_protocol_error", "Terminal geometry application exceeded its bounded deadline."));
        } catch (error) {
          // Initial same-chunk delivery runs before the pump exists. Revoke
          // its consumer here as well, so a timed-out resize cannot later
          // mutate a viewport after failed attachment cleanup has returned.
          entry.geometry = null;
          entry.outputAbort.abort(error);
          throw error;
        }
      }
      this.#publish(entry);
      return;
    }
    if (frame.type === "view_started") {
      const payload = decodeTerminalControl(frame);
      if (entry.terminalView === undefined || entry.terminalView.viewId !== null) throw runtimeFailure("terminal_protocol_error", "Unexpected or duplicate terminal view start.");
      entry.terminalView.viewId = String(payload.viewId);
      if (this.#options.onTerminalViewStarted === undefined) throw runtimeFailure("terminal_protocol_error", "The terminal view has no reset consumer.");
      const authority = entry.outputAbort;
      const revision = entry.connectionRevision;
      try {
        const timeoutMs = this.#options.outputDeliveryTimeoutMs ?? 5_000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw runtimeFailure("terminal_protocol_error", "The terminal view reset deadline is invalid.");
        await withOutputDeadline(Promise.resolve(this.#options.onTerminalViewStarted({
          snapshot: snapshot(entry, this.#heartbeatTimeoutMs(), this.#clock()),
          columns: Number(payload.columns), rows: Number(payload.rows), signal: authority.signal,
        })), timeoutMs);
        if (authority.signal.aborted || entry.connectionRevision !== revision || entry.state !== "active") throw runtimeFailure("terminal_disconnected", "Terminal view reset completed after its attachment retired.");
      } catch (error) { authority.abort(error); throw error; }
      return;
    }
    if (frame.type === "view_ready") {
      const payload = decodeTerminalControl(frame);
      if (entry.terminalView === undefined || entry.terminalView.viewId === null || entry.terminalView.ready ||
        payload.viewId !== entry.terminalView.viewId || entry.outputSequence < 1n ||
        payload.afterOutputSequence !== entry.outputSequence.toString()) throw runtimeFailure("terminal_protocol_error", "Terminal view readiness does not match consumed output.");
      entry.terminalView.ready = true;
      if (entry.terminalViewDeadline !== undefined) clearTimeout(entry.terminalViewDeadline);
      this.#publish(entry);
      return;
    }
    if (frame.type === "output") {
      if (entry.terminalView !== undefined && (entry.terminalView.viewId === null || frame.sequence !== entry.outputSequence + 1n)) throw runtimeFailure("terminal_protocol_error", "Canonical terminal output is not contiguous within a started view.");
      if (frame.sequence <= entry.outputSequence) {
        throw runtimeFailure("terminal_protocol_error", "Terminal output sequence regressed or duplicated.");
      }
      if (this.#options.onTerminalOutput !== undefined) {
        const timeoutMs = this.#options.outputDeliveryTimeoutMs ?? 5_000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
          throw runtimeFailure("terminal_protocol_error", "The terminal output delivery deadline is invalid.");
        }
        await withOutputDeadline(Promise.resolve(this.#options.onTerminalOutput({
          provenance: (entry.terminalView === undefined ? entry.replayBoundaryObserved === true : entry.terminalView.ready) ? "live" : "replay_or_unknown",
          tabId: entry.tabId,
          agentSessionId: entry.observation.agentSessionId,
          binding: Object.freeze({
            userId: entry.observation.userId,
            machineId: entry.observation.machineId,
            agentSessionId: entry.observation.agentSessionId,
            processEpoch: entry.observation.processEpoch,
            fencingGeneration: entry.fencingGeneration,
          }),
          sequence: frame.sequence,
          bytes: frame.payload.slice(),
          signal: entry.outputAbort.signal,
        })), timeoutMs);
      }
      entry.outputSequence = frame.sequence;
      return;
    }
    if (frame.type === "ready") {
      const payload = decodeTerminalControl(frame);
      if (
        payload.protocol !== TERMINAL_PROTOCOL ||
        payload.agentSessionId !== entry.observation.agentSessionId ||
        payload.processEpoch !== entry.observation.processEpoch ||
        payload.fencingGeneration !== entry.fencingGeneration
      ) {
        throw runtimeFailure("grant_scope_mismatch", "Terminal readiness evidence targets another AgentSession generation.");
      }
      return;
    }
    if (frame.type === "writer_epoch") {
      // The writer seat moved. The server names the new epoch, its holder and
      // this attachment's own mode; the local view follows and says so.
      const payload = decodeTerminalControl(frame) as unknown as TerminalWriterEpochPayload;
      if (payload.accessMode === "writer" && payload.writerClientInstanceId !== this.#options.clientInstanceId) {
        throw runtimeFailure("terminal_protocol_error", "The writer notice names another client.");
      }
      // Compare wire facts with wire facts. An HTTP response can advance the
      // request fence, but cannot grant input or contradict a later wire role.
      if (entry.wireWriterNotice?.writerEpoch === payload.writerEpoch && (
        entry.wireWriterNotice.accessMode !== payload.accessMode || entry.wireWriterNotice.writerClientInstanceId !== payload.writerClientInstanceId
      )) {
        throw runtimeFailure("terminal_protocol_error", "The writer notice contradicts the same wire epoch.");
      }
      if (payload.writerEpoch < entry.writerEpoch) {
        return;
      }
      entry.wireWriterNotice = payload;
      if (payload.writerEpoch !== entry.writerEpoch) {
        retireInputAcceptance(entry);
        entry.geometry = null;
      }
      const wasWriter = entry.accessMode === "writer";
      entry.accessMode = payload.accessMode;
      entry.writerEpoch = payload.writerEpoch;
      entry.writerClientInstanceId = payload.writerClientInstanceId;
      if (entry.writerTransfer !== undefined && payload.writerEpoch > entry.writerTransfer.expectedWriterEpoch) {
        delete entry.writerTransfer;
      }
      if (payload.accessMode === "writer") entry.heldSeat = true;
      if (wasWriter && payload.accessMode !== "writer") entry.reason = "writer_transferred";
      else if (!wasWriter && payload.accessMode === "writer") delete entry.reason;
      this.#publish(entry);
      return;
    }
    if (frame.type === "acknowledgement") {
      const payload = decodeTerminalControl(frame);
      const acknowledged = BigInt(String(payload.clientSequence));
      if (acknowledged <= 0n || payload.meaning !== "durably_accepted_not_executed") {
        throw runtimeFailure("terminal_protocol_error", "Terminal input acknowledgement is invalid.");
      }
      // Sequences remain monotone across this runtime's reconnects. Late
      // receipts for retired scopes never certify or disrupt the current one.
      if (acknowledged <= entry.retiredInputSequence) return;
      if (
        acknowledged <= entry.acknowledgedInputSequence ||
        !entry.pendingInputSequences.has(acknowledged) ||
        payload.meaning !== "durably_accepted_not_executed"
      ) {
        throw runtimeFailure("terminal_protocol_error", "Terminal input acknowledgement is invalid.");
      }
      for (const sequence of entry.pendingInputSequences) {
        if (sequence <= acknowledged) entry.pendingInputSequences.delete(sequence);
      }
      entry.acknowledgedInputSequence = acknowledged;
      entry.inputContinuity = entry.pendingInputSequences.size === 0 && !entry.historicalInputUncertainty ? "complete" : "uncertain";
      this.#publish(entry);
      return;
    }
    if (frame.type === "exit") {
      decodeTerminalControl(frame);
      this.#clearHeartbeatWatchdog(entry);
      entry.outputAbort.abort(runtimeFailure("terminal_disconnected", "The remote terminal process exited."));
      entry.state = "closed";
      entry.reason = "remote_process_exit";
      try { this.#views.detach(entry.viewId); } catch { /* the view may already be detached */ }
      this.#publish(entry);
      await entry.connection.close({ code: 1000, reason: "cuna_remote_process_exit" });
      if (this.#activeTabId === entry.tabId) this.#activeTabId = this.#nextActiveTab(entry.tabId);
      this.#terminals.delete(entry.tabId);
      return;
    }
    if (frame.type === "error") throw this.#remoteTerminalError(frame, entry.observation.agentSessionId);
    if (frame.type === "heartbeat") {
      decodeTerminalControl(frame);
      if (frame.sequence <= entry.heartbeatSequence) {
        throw runtimeFailure("terminal_protocol_error", "Terminal heartbeat sequence regressed or duplicated.");
      }
      if (this.#clock() - entry.lastHeartbeatAt > this.#heartbeatTimeoutMs()) {
        this.#expireHeartbeat(entry, entry.connection, entry.connectionRevision);
        throw runtimeFailure("terminal_disconnected", "A late terminal heartbeat cannot revive an expired attachment.", { retryable: true });
      }
      entry.heartbeatSequence = frame.sequence;
      // The producer emits this exact sequence only after RESUME replay. A
      // heartbeat request cannot reuse it because client sequences increase.
      if (frame.sequence === entry.replayBoundarySequence) entry.replayBoundaryObserved = true;
      entry.lastHeartbeatAt = this.#clock();
      this.#scheduleHeartbeatWatchdog(entry, entry.connection, entry.connectionRevision);
      this.#publish(entry);
    }
  }

  #remoteTerminalError(frame: TerminalFrame, agentSessionId: string): RuntimeBoundaryError {
    const payload = decodeTerminalControl(frame);
    if (payload.code === "continuity_incomplete" && payload.safeReason === "retained_output_gap") {
      return terminalHistoryGap(agentSessionId);
    }
    return runtimeFailure("terminal_protocol_error", payload.code === "terminal_input_recovery_required"
      ? "Terminal input requires recovery. Reconnecting cannot confirm earlier input delivery."
      : payload.code === "opencode_server_exited"
        ? "OpenCode's server stopped. Inspect this session before starting another session."
      : "The Cuna terminal gateway rejected the connection.", {
      retryable: payload.code !== "opencode_server_exited" && payload.retryable === true,
      safeDetails: { reason: typeof payload.code === "string" ? payload.code : "terminal_error" },
    });
  }

  #publish(entry: TerminalEntry): void {
    const now = this.#clock();
    if (!this.#closed && entry.state === "active" && entry.capabilityRefresh === undefined &&
        now >= (entry.nextCapabilityRefreshAt ?? 0) && now >= Date.parse(entry.capabilitySnapshot.expiresAt) - 5_000) {
      const revision = entry.connectionRevision;
      const capabilityReadRevision = ++entry.capabilityReadRevision;
      entry.nextCapabilityRefreshAt = now + 5_000;
      entry.capabilityRefresh = this.#options.controlPlane.discoverCapabilities("agent_session", entry.observation.agentSessionId, AbortSignal.timeout(5_000)).then(evidence => {
        if (!this.#closed && entry.state === "active" && entry.connectionRevision === revision && entry.capabilityReadRevision === capabilityReadRevision) {
          entry.capabilitySnapshot = evidence;
          this.#publish(entry);
        }
      }).catch(() => { /* Existing lease expires closed; later heartbeat may refresh it. */ }).finally(() => { delete entry.capabilityRefresh; });
    }
    this.#options.onTerminalState?.(snapshot(entry, this.#heartbeatTimeoutMs(), this.#clock()));
  }

  #localActionAcceptance(
    offer: unknown,
    agentSessionId: string,
  ): TerminalLocalActionProtocolAcceptance | undefined {
    if (this.#options.onLocalActionFrame === undefined) return undefined;
    const configured = typeof this.#options.localActionKinds === "function"
      ? this.#options.localActionKinds(agentSessionId)
      : this.#options.localActionKinds ?? [];
    const valid = configured.filter((kind): kind is TerminalLocalActionKind =>
      (TERMINAL_LOCAL_ACTION_KINDS as readonly string[]).includes(kind));
    return negotiateTerminalLocalActions(offer, new Set(valid));
  }

  #requireTerminal(tabId: string): TerminalEntry {
    const entry = this.#terminals.get(tabId);
    if (entry === undefined) throw runtimeFailure("session_unknown", "The local terminal tab does not exist.");
    return entry;
  }

  /**
   * Only the writing seat may reach the PTY: input, resize and signals. The
   * gateway closes an observer's attachment on the first such frame
   * (`observer_control_rejected`), so the refusal must happen here, by name,
   * before anything is sent. An observer tab keeps observing.
   */
  #requireWriterSeat(entry: TerminalEntry): void {
    if (entry.accessMode !== "writer" || entry.writerClientInstanceId !== this.#options.clientInstanceId) {
      throw runtimeFailure(
        "terminal_observer",
        "This attachment observes the terminal; input is disabled.",
      );
    }
  }

  #requireActiveTerminal(tabId: string | undefined): TerminalEntry {
    if (tabId === undefined) throw runtimeFailure("session_unknown", "No terminal tab is active.");
    const entry = this.#requireTerminal(tabId);
    if (entry.state !== "active") throw runtimeFailure("terminal_disconnected", "The terminal tab is not connected.");
    this.#assertHeartbeatFresh(entry);
    return entry;
  }

  #heartbeatTimeoutMs(): number {
    const timeoutMs = this.#options.heartbeatTimeoutMs ?? 45_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw runtimeFailure("terminal_protocol_error", "The terminal heartbeat deadline is invalid.");
    }
    return timeoutMs;
  }

  #assertHeartbeatFresh(entry: TerminalEntry): void {
    if (this.#clock() - entry.lastHeartbeatAt <= this.#heartbeatTimeoutMs()) return;
    this.#expireHeartbeat(entry, entry.connection, entry.connectionRevision);
    throw runtimeFailure("terminal_disconnected", "The terminal heartbeat expired; input is fenced until a fresh attachment is proven.", { retryable: true });
  }

  #scheduleHeartbeatWatchdog(
    entry: TerminalEntry,
    connection: TerminalWireConnection,
    connectionRevision: number,
  ): void {
    this.#clearHeartbeatWatchdog(entry);
    const interval = Math.max(250, Math.min(10_000, Math.floor(this.#heartbeatTimeoutMs() / 3)));
    entry.heartbeatTimer = setInterval(() => {
      if (
        entry.connection !== connection ||
        entry.connectionRevision !== connectionRevision ||
        entry.state !== "active"
      ) {
        this.#clearHeartbeatWatchdog(entry);
        return;
      }
      if (this.#clock() - entry.lastHeartbeatAt > this.#heartbeatTimeoutMs()) {
        this.#expireHeartbeat(entry, connection, connectionRevision);
        return;
      }
      if (entry.heartbeatSendPending) return;
      entry.heartbeatSendPending = true;
      void this.#enqueueTerminalSend(entry, async (authority) => {
        entry.wireSequence += 1n;
        await authority.connection.send(encodeTerminalControl("heartbeat", entry.wireSequence, {}));
      }).catch((error: unknown) => {
        if (
          entry.connection !== connection ||
          entry.connectionRevision !== connectionRevision ||
          entry.state !== "active"
        ) return;
        this.#clearHeartbeatWatchdog(entry);
        entry.outputAbort.abort(error);
        entry.state = "interrupted";
        retireInputAcceptance(entry);
        entry.outputContinuity = "unknown";
        entry.reason = "heartbeat_send_failed";
        this.#publish(entry);
        void connection.close({ code: 1001, reason: "cuna_heartbeat_send_failed" }).catch(() => undefined);
      }).finally(() => {
        entry.heartbeatSendPending = false;
      });
    }, interval);
    entry.heartbeatTimer.unref();
  }

  #clearHeartbeatWatchdog(entry: TerminalEntry): void {
    if (entry.heartbeatTimer !== undefined) clearTimeout(entry.heartbeatTimer);
    delete entry.heartbeatTimer;
  }

  #expireHeartbeat(
    entry: TerminalEntry,
    connection: TerminalWireConnection,
    connectionRevision: number,
  ): void {
    if (
      entry.connection !== connection ||
      entry.connectionRevision !== connectionRevision ||
      entry.state !== "active"
    ) return;
    this.#clearHeartbeatWatchdog(entry);
    entry.outputAbort.abort(runtimeFailure("terminal_disconnected", "The terminal heartbeat expired."));
    entry.state = "interrupted";
    retireInputAcceptance(entry);
    entry.outputContinuity = "unknown";
    entry.reason = "heartbeat_expired";
    this.#publish(entry);
    void connection.close({ code: 1001, reason: "cuna_heartbeat_expired" }).catch(() => undefined);
  }

  #nextActiveTab(excluding: string): string | undefined {
    return [...this.#terminals.values()].find((entry) => entry.tabId !== excluding && entry.state === "active")?.tabId;
  }

  #assertOpen(): void {
    if (this.#closed) throw runtimeFailure("runtime_closed", "The local runtime has already stopped.");
  }

  #assertReady(): void {
    this.#assertOpen();
    if (this.#mode === "foreground") {
      if (this.#foreground.state !== "ready") {
        throw runtimeFailure("remote_state_unproven", "The foreground runtime is not ready in this process.");
      }
      return;
    }
    if (
      this.#daemon.snapshot().state === "ready" &&
      this.#startupEvidenceExpiresAt <= this.#clock()
    ) {
      this.#daemon.transition("degraded", "startup_evidence_expired", this.#clock());
      this.#daemon.transition("recovery_required", "runtime_evidence_refresh_required", this.#clock());
    }
    if (this.#daemon.snapshot().state !== "ready") {
      throw runtimeFailure("remote_state_unproven", "The local runtime is not in a verified ready state.");
    }
  }
}

async function withOutputDeadline<T>(operation: Promise<T>, timeoutMs: number,
  timeoutFailure: () => RuntimeBoundaryError = () => runtimeFailure("terminal_protocol_error", "The terminal output consumer exceeded its bounded deadline."),
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(timeoutFailure()),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * The server's own name for "the writing seat is not yours to take right now":
 * held by another client (`terminal_writer_held`) or moved past the epoch this
 * client expected (`terminal_writer_stale`). The reason travels in the safe
 * error details the API transport keeps for every refusal.
 */
function writerSeatUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const reason = (error as { readonly details?: { readonly reason?: unknown } }).details?.reason;
  return reason === "terminal_writer_held" || reason === "terminal_writer_stale";
}

function snapshot(entry: TerminalEntry, heartbeatTimeoutMs = 45_000, now = Date.now()): RuntimeTerminalSnapshot {
  return Object.freeze({
    tabId: entry.tabId,
    viewId: entry.viewId,
    ...(entry.terminalView === undefined ? {} : { terminalView: Object.freeze({ ...entry.terminalView }) }),
    userId: entry.observation.userId,
    machineId: entry.observation.machineId,
    workspaceBindingId: entry.observation.workspaceBindingId,
    workspaceBindingGeneration: entry.observation.workspaceBindingGeneration,
    agentSessionId: entry.observation.agentSessionId,
    processEpoch: entry.observation.processEpoch,
    state: entry.state,
    fencingGeneration: entry.fencingGeneration,
    inputSequence: entry.inputSequence,
    acknowledgedInputSequence: entry.acknowledgedInputSequence,
    inputContinuity: entry.inputContinuity,
    historicalInputUncertainty: entry.historicalInputUncertainty,
    outputSequence: entry.outputSequence,
    outputContinuity: entry.outputContinuity,
    resizeCapability: entry.resizeCapability,
    accessMode: entry.accessMode,
    writerEpoch: entry.writerEpoch,
    writerClientInstanceId: entry.writerClientInstanceId,
    geometry: entry.geometry,
    writerTransferCapability: writerTransferCapability(entry.capabilitySnapshot, entry.observation.agentSessionId, now),
    heartbeatObservedAt: entry.lastHeartbeatAt,
    heartbeatExpiresAt: entry.lastHeartbeatAt + heartbeatTimeoutMs,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
  });
}

function sameEntryBinding(entry: TerminalEntry, binding: RuntimeTerminalResponse["binding"]): boolean {
  return entry.observation.userId === binding.userId &&
    entry.observation.machineId === binding.machineId &&
    entry.observation.agentSessionId === binding.agentSessionId &&
    entry.observation.processEpoch === binding.processEpoch &&
    entry.fencingGeneration === binding.fencingGeneration;
}

async function nextWithTimeout(
  iterator: AsyncIterator<Uint8Array>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<IteratorResult<Uint8Array>> {
  let timeout: NodeJS.Timeout | undefined;
  let removeAbort = (): void => undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(runtimeFailure("terminal_timeout", "The terminal readiness handshake timed out.", { retryable: true })), Math.max(1, timeoutMs));
      }),
      new Promise<never>((_resolve, reject) => {
        if (signal === undefined) return;
        const abort = (): void => reject(runtimeFailure("terminal_disconnected", "Terminal attachment was cancelled.", { cause: signal.reason }));
        if (signal.aborted) abort();
        else {
          signal.addEventListener("abort", abort, { once: true });
          removeAbort = () => signal.removeEventListener("abort", abort);
        }
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    removeAbort();
  }
}

function retireInputAcceptance(entry: TerminalEntry): void {
  entry.historicalInputUncertainty ||= entry.pendingInputSequences.size > 0;
  if (entry.inputSequence > entry.retiredInputSequence) entry.retiredInputSequence = entry.inputSequence;
  entry.pendingInputSequences.clear();
  if (entry.historicalInputUncertainty) entry.inputContinuity = "uncertain";
}

function isPermanentInputRecoveryFailure(error: unknown): error is RuntimeBoundaryError {
  return error instanceof RuntimeBoundaryError && error.code === "terminal_protocol_error" &&
    !error.retryable && error.safeDetails?.reason === "terminal_input_recovery_required";
}

function isHistoryGap(error: unknown): error is RuntimeBoundaryError {
  return error instanceof RuntimeBoundaryError && error.code === "terminal_history_gap";
}

function safeReason(error: unknown): string {
  if (isPermanentInputRecoveryFailure(error)) return "terminal_input_recovery_required";
  if (error instanceof TerminalProtocolError) return "terminal_protocol_error";
  if (error instanceof RuntimeBoundaryError) return error.code;
  return "transport_failure";
}

function throwIfAborted(signal: AbortSignal, message: string): void {
  if (signal.aborted) {
    throw runtimeFailure("terminal_disconnected", message, { retryable: false, cause: signal.reason });
  }
}

function viewId(tabId: string, generation: number): string {
  return `${tabId}:attachment:${generation}`;
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(value)) {
    throw runtimeFailure("session_conflict", `The ${label} is invalid.`);
  }
}

function assertDimensions(columns: number, rows: number): void {
  if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) || columns < 1 || rows < 1 || columns > 1000 || rows > 1000) {
    throw runtimeFailure("terminal_protocol_error", "The terminal dimensions are outside protocol bounds.");
  }
}
