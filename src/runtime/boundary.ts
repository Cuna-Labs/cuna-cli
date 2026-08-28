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
  decodeTerminalFrame,
  encodeTerminalControl,
  encodeTerminalFrame,
  isLocalActionFrameType,
  negotiateTerminalLocalActions,
  type TerminalFrame,
  type TerminalLocalActionKind,
  type TerminalLocalActionProtocolAcceptance,
} from "../terminal/codec.js";

import { admitCapability } from "./capability-gate.js";
import { RuntimeBoundaryError, runtimeFailure } from "./errors.js";
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
  readonly outputSequence: bigint;
  readonly outputContinuity: "complete" | "unknown" | "incomplete";
  readonly resizeCapability: "live" | "initial_resize_only";
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
  readonly onTerminalOutput?: (event: {
    readonly tabId: string;
    readonly agentSessionId: string;
    readonly binding: RuntimeTerminalResponse["binding"];
    readonly sequence: bigint;
    readonly bytes: Uint8Array;
    readonly signal: AbortSignal;
  }) => void | Promise<void>;
  readonly onTerminalState?: (snapshot: RuntimeTerminalSnapshot) => void;
  readonly localActionKinds?: readonly TerminalLocalActionKind[];
  readonly onLocalActionFrame?: (event: {
    readonly tabId: string;
    readonly frame: TerminalFrame;
    readonly payload: Readonly<Record<string, unknown>>;
  }) => void | Promise<void>;
}

interface TerminalEntry {
  readonly tabId: string;
  viewId: string;
  observation: RemoteAgentSessionEvidence;
  state: RuntimeTerminalState;
  connection: TerminalWireConnection;
  decoder: TerminalFrameDecoder;
  fencingGeneration: number;
  capabilities: readonly TerminalConnectionCapability[];
  resizeCapability: "live" | "initial_resize_only";
  wireSequence: bigint;
  inputSequence: bigint;
  acknowledgedInputSequence: bigint;
  inputContinuity: RuntimeTerminalSnapshot["inputContinuity"];
  pendingInputSequences: Set<bigint>;
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
  heartbeatSendPending: boolean;
  heartbeatTimer?: NodeJS.Timeout;
  outputAbort: AbortController;
  reconnectIdempotencyKey?: string;
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
        outputSequence: 0n,
        outputContinuity: "unknown",
        lastHeartbeatAt: this.#clock(),
        resumeHandle: grant.resumeHandle,
        localActionsNegotiated: false,
        localActionAcceptance: undefined,
        sendTail: Promise.resolve(),
        connectionRevision: 1,
        heartbeatSequence: 0n,
        heartbeatSendPending: false,
        outputAbort: new AbortController(),
      };
      const iterator = connection.receive()[Symbol.asyncIterator]();
      const ready = await this.#awaitReady(entry, iterator, attachAbort.signal);
      this.#assertOpen();
      entry.lastHeartbeatAt = this.#clock();
      entry.heartbeatSequence = 0n;
      entry.fencingGeneration = ready.payload.fencingGeneration;
      entry.resizeCapability = ready.payload.resizeCapability;
      entry.localActionAcceptance = this.#localActionAcceptance(ready.payload.localActionProtocol);
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
      entry.outputContinuity = "complete";
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
      entry.wireSequence += 1n;
      await connection.send(encodeTerminalControl("resize", entry.wireSequence, {
        columns: input.columns,
        rows: input.rows,
      }));
      // The supervisor starts and drains the provider PTY before a terminal
      // client necessarily attaches. READY proves the live binding but does
      // not include retained output, so request replay only after the ordered
      // resize has reached the same fenced attachment generation.
      entry.wireSequence += 1n;
      await connection.send(encodeTerminalControl("resume", entry.wireSequence, {
        resumeHandle: entry.resumeHandle,
        afterOutputSequence: entry.outputSequence.toString(),
        ...(entry.localActionAcceptance === undefined ? {} : { localActionProtocol: entry.localActionAcceptance }),
      }));
      entry.localActionsNegotiated = entry.localActionAcceptance !== undefined;
      await this.#options.onTerminalReady?.(snapshot(entry, this.#heartbeatTimeoutMs()));
      this.#assertOpen();
      for (const frame of ready.bufferedFrames) await this.#handleAttachedFrame(entry, frame);
      this.#assertOpen();
      this.#scheduleHeartbeatWatchdog(entry, connection, entry.connectionRevision);
      this.#publish(entry);
      entry.pump = this.#pump(entry, connection, entry.connectionRevision, iterator);
      return snapshot(entry, this.#heartbeatTimeoutMs());
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
    return snapshot(entry, this.#heartbeatTimeoutMs());
  }

  refreshTerminalLiveness(tabId = this.#activeTabId): RuntimeTerminalSnapshot {
    this.#assertReady();
    const entry = this.#requireTerminal(tabId ?? "");
    this.#assertHeartbeatFresh(entry);
    return snapshot(entry, this.#heartbeatTimeoutMs());
  }

  async sendInput(
    bytes: Uint8Array,
    tabId = this.#activeTabId,
    expectedBinding?: RuntimeTerminalResponse["binding"],
  ): Promise<void> {
    this.#assertReady();
    const entry = this.#requireActiveTerminal(tabId);
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
    await this.#sendTerminalBytes(entry, response.bytes);
  }

  async #sendTerminalBytes(entry: TerminalEntry, bytes: Uint8Array): Promise<void> {
    const payload = bytes.slice();
    await this.#enqueueTerminalSend(entry, async (authority) => {
      if (entry.pendingInputSequences.size >= 4_096) {
        entry.connectionRevision += 1;
        entry.outputAbort.abort(runtimeFailure("terminal_disconnected", "Terminal input acknowledgement window was exhausted."));
        entry.state = "interrupted";
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
    entry.reconnectIdempotencyKey ??= this.#idempotencyKey();
    let connection: TerminalWireConnection | undefined;
    let completionFailure: unknown | undefined;
    try {
      throwIfAborted(reconnectAbort.signal, "Terminal reconnection was cancelled.");
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
      };
      const ready = await this.#awaitReady(candidate, iterator, reconnectAbort.signal);
      candidate.lastHeartbeatAt = this.#clock();
      candidate.localActionAcceptance = this.#localActionAcceptance(ready.payload.localActionProtocol);
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
      const resizeSequence = entry.wireSequence + 1n;
      await connection.send(encodeTerminalControl("resize", resizeSequence, {
        columns: previous.columns,
        rows: previous.rows,
      }));
      const resumeSequence = resizeSequence + 1n;
      await connection.send(encodeTerminalControl("resume", resumeSequence, {
        resumeHandle: grant.resumeHandle,
        afterOutputSequence: entry.outputSequence.toString(),
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
      this.#clearHeartbeatWatchdog(entry);
      entry.observation = revalidated.observation;
      entry.decoder = nextDecoder;
      entry.fencingGeneration = ready.payload.fencingGeneration;
      entry.capabilities = grant.capabilities;
      entry.resizeCapability = ready.payload.resizeCapability;
      entry.viewId = nextViewId;
      entry.resumeHandle = grant.resumeHandle;
      entry.localActionAcceptance = candidate.localActionAcceptance;
      entry.localActionsNegotiated = candidate.localActionAcceptance !== undefined;
      entry.wireSequence = resumeSequence;
      entry.heartbeatSequence = 0n;
      entry.heartbeatSendPending = false;
      entry.outputAbort = candidate.outputAbort;
      entry.lastHeartbeatAt = candidate.lastHeartbeatAt;
      entry.state = "active";
      entry.outputContinuity = "unknown";
      await this.#options.onTerminalReady?.(snapshot(entry, this.#heartbeatTimeoutMs()));
      for (const frame of ready.bufferedFrames) await this.#handleAttachedFrame(entry, frame);
      this.#scheduleHeartbeatWatchdog(entry, connection, reconnectRevision);
      this.#publish(entry);
      entry.pump = this.#pump(entry, connection, reconnectRevision, iterator);
      return snapshot(entry, this.#heartbeatTimeoutMs());
    } catch (error) {
      let reportedError: unknown = error;
      if (connection !== undefined) {
        try { await connection.close({ code: 1008, reason: "cuna_resume_rejected" }); } catch (cleanupError) {
          completionFailure = cleanupError;
          reportedError = new AggregateError([error, cleanupError], "Terminal reconnection failed and its replacement transport cleanup was incomplete.");
        }
      }
      if (
        entry.connectionRevision === reconnectRevision &&
        entry.state !== "failed"
      ) {
        entry.state = "interrupted";
        entry.outputContinuity = "unknown";
        entry.reason = safeReason(reportedError);
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
    return Object.freeze([...this.#terminals.values()].map((entry) => snapshot(entry, this.#heartbeatTimeoutMs())));
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
        const failure = await withOutputDeadline(pending, this.#options.readyTimeoutMs ?? 10_000);
        if (failure !== undefined) failures.push(failure);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const handle of this.#syncHandles.values()) {
      try { await handle.close(); } catch (error) { failures.push(error); }
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
    return Object.freeze({ capability, observation });
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
  ): Promise<TerminalConnectionGrant> {
    const grant = await this.#options.controlPlane.createTerminalConnection({
      agentSessionId: observation.agentSessionId,
      protocol: TERMINAL_PROTOCOL,
      clientInstanceId: this.#options.clientInstanceId,
      idempotencyKey,
      capabilityEvidence: capability,
      ...(resumeHandle === undefined ? {} : { resumeHandle }),
      ...(signal === undefined ? {} : { signal }),
    });
    return validateTerminalGrant({
      grant,
      allowedCunaOrigins: this.#options.allowedCunaOrigins,
      requiredCapabilities: ["acknowledgement", "heartbeat", "resume", "live_resize"],
      now: this.#clock(),
    });
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
        if (frame.type === "error") throw this.#remoteTerminalError(frame);
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
        (error instanceof RuntimeBoundaryError && error.code === "terminal_protocol_error")
      ) ? "failed" : "interrupted";
      entry.outputContinuity = "unknown";
      entry.reason = safeReason(error);
      this.#publish(entry);
      await connection.close({ code: 1002, reason: "cuna_terminal_protocol_failure" }).catch(() => undefined);
    }
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
    if (frame.type === "output") {
      if (frame.sequence <= entry.outputSequence) {
        throw runtimeFailure("terminal_protocol_error", "Terminal output sequence regressed or duplicated.");
      }
      if (this.#options.onTerminalOutput !== undefined) {
        const timeoutMs = this.#options.outputDeliveryTimeoutMs ?? 5_000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
          throw runtimeFailure("terminal_protocol_error", "The terminal output delivery deadline is invalid.");
        }
        await withOutputDeadline(Promise.resolve(this.#options.onTerminalOutput({
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
    if (frame.type === "acknowledgement") {
      const payload = decodeTerminalControl(frame);
      const acknowledged = BigInt(String(payload.clientSequence));
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
      entry.inputContinuity = entry.pendingInputSequences.size === 0 ? "complete" : "uncertain";
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
    if (frame.type === "error") throw this.#remoteTerminalError(frame);
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
      entry.lastHeartbeatAt = this.#clock();
      this.#scheduleHeartbeatWatchdog(entry, entry.connection, entry.connectionRevision);
    }
  }

  #remoteTerminalError(frame: TerminalFrame): RuntimeBoundaryError {
    const payload = decodeTerminalControl(frame);
    return runtimeFailure("terminal_protocol_error", "The Cuna terminal gateway rejected the connection.", {
      retryable: payload.retryable === true,
      safeDetails: { reason: typeof payload.code === "string" ? payload.code : "terminal_error" },
    });
  }

  #publish(entry: TerminalEntry): void {
    this.#options.onTerminalState?.(snapshot(entry, this.#heartbeatTimeoutMs()));
  }

  #localActionAcceptance(offer: unknown): TerminalLocalActionProtocolAcceptance | undefined {
    if (this.#options.onLocalActionFrame === undefined) return undefined;
    const configured = this.#options.localActionKinds ?? [];
    const valid = configured.filter((kind): kind is TerminalLocalActionKind =>
      (TERMINAL_LOCAL_ACTION_KINDS as readonly string[]).includes(kind));
    return negotiateTerminalLocalActions(offer, new Set(valid));
  }

  #requireTerminal(tabId: string): TerminalEntry {
    const entry = this.#terminals.get(tabId);
    if (entry === undefined) throw runtimeFailure("session_unknown", "The local terminal tab does not exist.");
    return entry;
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

async function withOutputDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(runtimeFailure("terminal_protocol_error", "The terminal output consumer exceeded its bounded deadline.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function snapshot(entry: TerminalEntry, heartbeatTimeoutMs = 45_000): RuntimeTerminalSnapshot {
  return Object.freeze({
    tabId: entry.tabId,
    viewId: entry.viewId,
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
    outputSequence: entry.outputSequence,
    outputContinuity: entry.outputContinuity,
    resizeCapability: entry.resizeCapability,
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

function safeReason(error: unknown): string {
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
