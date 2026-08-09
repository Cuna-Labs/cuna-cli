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
  TerminalFrameDecoder,
  assertTerminalFrameLegal,
  decodeTerminalControl,
  encodeTerminalControl,
  encodeTerminalFrame,
  type TerminalFrame,
} from "../terminal/codec.js";
import { HostTerminalLease, type HostTerminalAdapter } from "../terminal/mode.js";

import { admitCapability } from "./capability-gate.js";
import { RuntimeBoundaryError, runtimeFailure } from "./errors.js";
import {
  assertReadyPayloadMatches,
  assertRemoteAgentSessionEvidence,
  validateTerminalGrant,
  type RemoteAgentSessionEvidence,
  type TerminalConnectionGrant,
  type TerminalConnectionCapability,
  type TerminalConnector,
  type TerminalControlPlane,
  type TerminalWireConnection,
} from "./terminal-transport.js";

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

export interface RuntimeTerminalSnapshot {
  readonly tabId: string;
  readonly viewId: string;
  readonly userId: string;
  readonly machineId: string;
  readonly agentSessionId: string;
  readonly processEpoch: string;
  readonly state: RuntimeTerminalState;
  readonly fencingGeneration: number;
  readonly inputSequence: bigint;
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
  readonly controlPlane: TerminalControlPlane;
  readonly terminalConnector: TerminalConnector;
  readonly allowedRunaOrigins: readonly string[];
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
    readonly sequence: bigint;
    readonly bytes: Uint8Array;
  }) => void | Promise<void>;
  readonly onTerminalState?: (snapshot: RuntimeTerminalSnapshot) => void;
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
  outputSequence: bigint;
  outputContinuity: RuntimeTerminalSnapshot["outputContinuity"];
  lastHeartbeatAt: number;
  resumeHandle: string;
  reason?: string;
  pump?: Promise<void>;
  sendTail: Promise<void>;
  connectionRevision: number;
  heartbeatSequence: bigint;
  heartbeatTimer?: NodeJS.Timeout;
}

export class RunaRuntimeBoundary {
  readonly #options: RuntimeBoundaryOptions;
  readonly #clock: () => number;
  readonly #idempotencyKey: () => string;
  readonly #daemon: DaemonLifecycle;
  readonly #views = new LocalClientViewRegistry();
  readonly #syncRegistry = new SyncSupervisorRegistry();
  readonly #terminals = new Map<string, TerminalEntry>();
  readonly #syncHandles = new Map<string, RuntimeSyncHandle>();
  #activeTabId: string | undefined;
  #hostTerminalLease: HostTerminalLease | undefined;
  #startupEvidenceExpiresAt = 0;
  #closed = false;

  constructor(options: RuntimeBoundaryOptions) {
    assertIdentifier(options.terminalCapabilityId, "terminal capability ID");
    assertIdentifier(options.clientInstanceId, "client instance ID");
    if (options.allowedRunaOrigins.length === 0) {
      throw runtimeFailure("grant_invalid", "At least one exact Runa HTTPS origin is required.");
    }
    this.#options = Object.freeze({ ...options, allowedRunaOrigins: Object.freeze([...options.allowedRunaOrigins]) });
    this.#clock = options.clock ?? Date.now;
    this.#idempotencyKey = options.idempotencyKey ?? randomUUID;
    this.#daemon = new DaemonLifecycle(this.#clock());
  }

  get daemon(): DaemonLifecycleSnapshot {
    return this.#daemon.snapshot();
  }

  get activeTabId(): string | undefined {
    return this.#activeTabId;
  }

  start(evidence: RuntimeStartupEvidence): DaemonLifecycleSnapshot {
    this.#assertOpen();
    if (this.#daemon.snapshot().state !== "absent" && this.#daemon.snapshot().state !== "stopped") {
      throw runtimeFailure("session_conflict", "The local runtime is already started.");
    }
    this.#daemon.transition("starting", "runtime_start_requested", this.#clock());
    if (
      evidence.endpointOwnership !== "verified" ||
      evidence.durableState !== "verified" ||
      evidence.source.length === 0 ||
      !Number.isFinite(evidence.observedAt) ||
      !Number.isFinite(evidence.expiresAt) ||
      evidence.expiresAt < evidence.observedAt ||
      evidence.expiresAt <= this.#clock()
    ) {
      this.#daemon.transition("recovery_required", "local_runtime_evidence_unproven", this.#clock());
      throw runtimeFailure("remote_state_unproven", "The local runtime endpoint or durable state is not verified.");
    }
    this.#startupEvidenceExpiresAt = evidence.expiresAt;
    return this.#daemon.transition("ready", "local_runtime_verified", this.#clock());
  }

  async acquireHostTerminal(adapter: HostTerminalAdapter): Promise<void> {
    this.#assertReady();
    if (this.#hostTerminalLease !== undefined) {
      throw runtimeFailure("session_conflict", "The host terminal is already owned by this runtime.");
    }
    this.#hostTerminalLease = await HostTerminalLease.acquire(adapter);
  }

  async attach(input: {
    readonly tabId: string;
    readonly agentSessionId: string;
    readonly columns: number;
    readonly rows: number;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeTerminalSnapshot> {
    this.#assertReady();
    assertIdentifier(input.tabId, "tab ID");
    assertIdentifier(input.agentSessionId, "AgentSession ID");
    assertDimensions(input.columns, input.rows);
    if (this.#terminals.has(input.tabId)) throw runtimeFailure("session_conflict", "The terminal tab already exists.");
    if ([...this.#terminals.values()].some((entry) => entry.observation.agentSessionId === input.agentSessionId && entry.state !== "closed")) {
      throw runtimeFailure("session_conflict", "The AgentSession is already attached by this runtime.");
    }

    const admitted = await this.#admitRemoteTerminal(input.agentSessionId);
    let connection: TerminalWireConnection | undefined;
    let entry: TerminalEntry | undefined;
    try {
      const grant = await this.#createGrant(admitted.observation, admitted.capability, undefined);
      connection = await this.#options.terminalConnector.connect({
        url: grant.connectUrl,
        token: grant.connectToken,
        protocol: TERMINAL_PROTOCOL,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (connection.connectionId !== grant.terminalSessionId) {
        throw runtimeFailure("grant_scope_mismatch", "The terminal transport accepted a different Runa terminal session.");
      }
      entry = {
        tabId: input.tabId,
        viewId: `pending:${grant.terminalSessionId}`,
        observation: admitted.observation,
        state: "attaching",
        connection,
        decoder: new TerminalFrameDecoder(),
        fencingGeneration: 0,
        capabilities: grant.capabilities,
        resizeCapability: "initial_resize_only",
        wireSequence: 0n,
        inputSequence: 0n,
        outputSequence: 0n,
        outputContinuity: "unknown",
        lastHeartbeatAt: this.#clock(),
        resumeHandle: grant.resumeHandle,
        sendTail: Promise.resolve(),
        connectionRevision: 1,
        heartbeatSequence: 0n,
      };
      const iterator = connection.receive()[Symbol.asyncIterator]();
      const ready = await this.#awaitReady(entry, iterator, input.signal);
      entry.fencingGeneration = ready.payload.fencingGeneration;
      entry.resizeCapability = ready.payload.resizeCapability;
      entry.viewId = viewId(input.tabId, ready.payload.fencingGeneration);
      this.#views.open({
        viewId: entry.viewId,
        binding: {
          userId: admitted.observation.userId,
          machineId: admitted.observation.machineId,
          agentSessionId: admitted.observation.agentSessionId,
          processEpoch: admitted.observation.processEpoch,
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
      await this.#options.onTerminalReady?.(snapshot(entry, this.#heartbeatTimeoutMs()));
      for (const frame of ready.bufferedFrames) await this.#handleAttachedFrame(entry, frame);
      this.#scheduleHeartbeatWatchdog(entry, connection, entry.connectionRevision);
      this.#publish(entry);
      entry.pump = this.#pump(entry, connection, entry.connectionRevision, iterator);
      return snapshot(entry, this.#heartbeatTimeoutMs());
    } catch (error) {
      if (entry !== undefined) {
        entry.state = "failed";
        entry.outputContinuity = "unknown";
        entry.reason = "terminal_attach_composition_failed";
        try { this.#views.detach(entry.viewId); } catch { /* the fenced view may not have opened */ }
        this.#publish(entry);
        if (this.#activeTabId === entry.tabId) this.#activeTabId = undefined;
      }
      if (connection !== undefined) await connection.close({ code: 1008, reason: "runa_attach_rejected" }).catch(() => undefined);
      throw error;
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

  async sendInput(bytes: Uint8Array, tabId = this.#activeTabId): Promise<void> {
    this.#assertReady();
    const entry = this.#requireActiveTerminal(tabId);
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
    await this.#enqueueTerminalSend(entry, async () => {
      this.#views.routeInput(entry.viewId, entry.fencingGeneration);
      entry.wireSequence += 1n;
      entry.inputSequence = entry.wireSequence;
      await entry.connection.send(encodeTerminalFrame({
        type: "input",
        critical: true,
        sequence: entry.inputSequence,
        payload,
      }));
    });
  }

  async resize(columns: number, rows: number, tabId = this.#activeTabId): Promise<void> {
    const entry = this.#requireActiveTerminal(tabId);
    this.#requireGrantCapability(entry, "live_resize");
    if (entry.resizeCapability !== "live") {
      throw runtimeFailure("capability_unsupported", "This terminal supports only its initial dimensions.");
    }
    await this.#enqueueTerminalSend(entry, async () => {
      this.#views.resize(entry.viewId, columns, rows);
      entry.wireSequence += 1n;
      await entry.connection.send(encodeTerminalControl("resize", entry.wireSequence, { columns, rows }));
    });
  }

  async signal(signal: "interrupt" | "suspend" | "terminate", tabId = this.#activeTabId): Promise<void> {
    const entry = this.#requireActiveTerminal(tabId);
    this.#requireGrantCapability(entry, "signals");
    await this.#enqueueTerminalSend(entry, async () => {
      this.#views.routeInput(entry.viewId, entry.fencingGeneration);
      entry.wireSequence += 1n;
      await entry.connection.send(encodeTerminalControl("signal", entry.wireSequence, { signal }));
    });
  }

  async #enqueueTerminalSend(entry: TerminalEntry, operation: () => Promise<void>): Promise<void> {
    const queued = entry.sendTail.then(operation);
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
    const reconnectRevision = entry.connectionRevision + 1;
    entry.connectionRevision = reconnectRevision;
    entry.outputContinuity = "unknown";
    delete entry.reason;
    this.#publish(entry);
    let connection: TerminalWireConnection | undefined;
    try {
      const admitted = await this.#admitRemoteTerminal(entry.observation.agentSessionId);
      if (admitted.observation.processEpoch !== entry.observation.processEpoch) {
        entry.state = "failed";
        entry.outputContinuity = "incomplete";
        entry.reason = "process_generation_changed";
        this.#publish(entry);
        throw runtimeFailure("session_discontinuous", "The remote process generation changed; this terminal cannot be resumed.");
      }
      await entry.connection.close({ code: 1001, reason: "runa_reconnect" }).catch(() => undefined);
      const grant = await this.#createGrant(admitted.observation, admitted.capability, entry.resumeHandle);
      connection = await this.#options.terminalConnector.connect({
        url: grant.connectUrl,
        token: grant.connectToken,
        protocol: TERMINAL_PROTOCOL,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (connection.connectionId !== grant.terminalSessionId) {
        throw runtimeFailure("grant_scope_mismatch", "The terminal transport accepted a different Runa terminal session.");
      }
      const iterator = connection.receive()[Symbol.asyncIterator]();
      const previousViewId = entry.viewId;
      const nextDecoder = new TerminalFrameDecoder();
      const candidate: TerminalEntry = {
        ...entry,
        observation: admitted.observation,
        connection,
        decoder: nextDecoder,
        capabilities: grant.capabilities,
        resumeHandle: grant.resumeHandle,
        lastHeartbeatAt: this.#clock(),
        heartbeatSequence: 0n,
      };
      const ready = await this.#awaitReady(candidate, iterator, input.signal);
      if (entry.connectionRevision !== reconnectRevision || entry.state !== "reconnecting" || this.#closed) {
        throw runtimeFailure("terminal_disconnected", "Terminal reconnection was superseded by detach or shutdown.");
      }
      if (ready.payload.fencingGeneration <= entry.fencingGeneration) {
        throw runtimeFailure("grant_invalid", "The reconnect readiness frame did not advance the attachment fence.");
      }
      const nextViewId = viewId(entry.tabId, ready.payload.fencingGeneration);
      const resumeSequence = entry.wireSequence + 1n;
      await connection.send(encodeTerminalControl("resume", resumeSequence, {
        resumeHandle: grant.resumeHandle,
        afterOutputSequence: entry.outputSequence.toString(),
      }));
      if (entry.connectionRevision !== reconnectRevision || entry.state !== "reconnecting" || this.#closed) {
        throw runtimeFailure("terminal_disconnected", "Terminal reconnection was superseded by detach or shutdown.");
      }
      const previous = this.#views.require(previousViewId);
      try { this.#views.detach(previousViewId); } catch { /* the prior view may already be detached */ }
      this.#views.open({
        viewId: nextViewId,
        binding: {
          userId: admitted.observation.userId,
          machineId: admitted.observation.machineId,
          agentSessionId: admitted.observation.agentSessionId,
          processEpoch: admitted.observation.processEpoch,
          fencingGeneration: ready.payload.fencingGeneration,
        },
        state: "active",
        columns: previous.columns,
        rows: previous.rows,
      });
      entry.connection = connection;
      this.#clearHeartbeatWatchdog(entry);
      entry.observation = admitted.observation;
      entry.decoder = nextDecoder;
      entry.fencingGeneration = ready.payload.fencingGeneration;
      entry.capabilities = grant.capabilities;
      entry.resizeCapability = ready.payload.resizeCapability;
      entry.viewId = nextViewId;
      entry.resumeHandle = grant.resumeHandle;
      entry.wireSequence = resumeSequence;
      entry.heartbeatSequence = 0n;
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
      if (connection !== undefined) {
        await connection.close({ code: 1008, reason: "runa_resume_rejected" }).catch(() => undefined);
      }
      if (
        entry.connectionRevision === reconnectRevision &&
        entry.state !== "failed"
      ) {
        entry.state = "interrupted";
        entry.outputContinuity = "unknown";
        entry.reason = safeReason(error);
        this.#publish(entry);
      }
      throw error;
    }
  }

  async detach(tabId: string): Promise<void> {
    const entry = this.#requireTerminal(tabId);
    if (entry.state === "closed" || entry.state === "detached") return;
    entry.connectionRevision += 1;
    this.#clearHeartbeatWatchdog(entry);
    try { this.#views.detach(entry.viewId); } catch { /* attach may have failed before view creation */ }
    entry.state = "detached";
    entry.reason = "explicit_detach";
    this.#publish(entry);
    await entry.connection.close({ code: 1000, reason: "runa_detach" });
    if (this.#activeTabId === tabId) this.#activeTabId = this.#nextActiveTab(tabId);
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
    this.#assertReady();
    if (this.#syncHandles.has(input.configuration.bindingId)) {
      throw runtimeFailure("session_conflict", "This runtime already owns the workspace sync binding.");
    }
    const journal = await DurableSyncJournal.open({
      directory: input.journalDirectory,
      bindingId: input.configuration.bindingId,
      bindingGeneration: input.configuration.bindingGeneration,
      ownerId: input.ownerId,
      ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }),
      now: this.#clock(),
      clock: this.#clock,
    });
    try {
      const { supervisor } = this.#syncRegistry.connect(input.configuration, this.#clock);
      supervisor.beginReconciliation("runtime_start_requires_authoritative_manifest");
      let closed = false;
      const handle: RuntimeSyncHandle = Object.freeze({
        bindingId: input.configuration.bindingId,
        fence: journal.fence,
        supervisor,
        close: async (): Promise<void> => {
          if (closed) return;
          closed = true;
          this.#syncRegistry.release(input.configuration.bindingId, supervisor);
          this.#syncHandles.delete(input.configuration.bindingId);
          await journal.close();
        },
      });
      this.#syncHandles.set(input.configuration.bindingId, handle);
      return handle;
    } catch (error) {
      await journal.close().catch(() => undefined);
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const state = this.#daemon.snapshot().state;
    if (state === "ready" || state === "degraded" || state === "reconciling") {
      this.#daemon.transition("quiescing", "runtime_shutdown", this.#clock());
    }
    const failures: unknown[] = [];
    for (const entry of this.#terminals.values()) {
      entry.connectionRevision += 1;
      this.#clearHeartbeatWatchdog(entry);
      try { await entry.connection.close({ code: 1000, reason: "runa_shutdown" }); } catch (error) { failures.push(error); }
      entry.state = "closed";
      entry.reason = "runtime_shutdown";
      this.#publish(entry);
    }
    for (const handle of this.#syncHandles.values()) {
      try { await handle.close(); } catch (error) { failures.push(error); }
    }
    if (this.#hostTerminalLease !== undefined) {
      try { await this.#hostTerminalLease.restore(); } catch (error) { failures.push(error); }
      this.#hostTerminalLease = undefined;
    }
    const after = this.#daemon.snapshot().state;
    if (after === "quiescing" || after === "recovery_required" || after === "starting") {
      this.#daemon.transition("stopped", failures.length === 0 ? "runtime_stopped" : "runtime_stopped_with_cleanup_failure", this.#clock());
    }
    if (failures.length > 0) throw new AggregateError(failures, "The Runa runtime stopped with cleanup failures.");
  }

  async #admitRemoteTerminal(agentSessionId: string): Promise<{
    readonly capability: ReturnType<typeof admitCapability>;
    readonly observation: RemoteAgentSessionEvidence;
  }> {
    const snapshot = await this.#options.controlPlane.discoverCapabilities("agent_session", agentSessionId);
    const capability = admitCapability(snapshot, {
      id: this.#options.terminalCapabilityId,
      scope: "agent_session",
      subjectId: agentSessionId,
      surface: "cli",
      interaction: "native",
    }, this.#clock());
    const observation = assertRemoteAgentSessionEvidence({
      evidence: await this.#options.controlPlane.observeAgentSession(agentSessionId),
      expectedAgentSessionId: agentSessionId,
      now: this.#clock(),
    });
    return Object.freeze({ capability, observation });
  }

  async #createGrant(
    observation: RemoteAgentSessionEvidence,
    capability: ReturnType<typeof admitCapability>,
    resumeHandle: string | undefined,
  ): Promise<TerminalConnectionGrant> {
    const grant = await this.#options.controlPlane.createTerminalConnection({
      agentSessionId: observation.agentSessionId,
      protocol: TERMINAL_PROTOCOL,
      clientInstanceId: this.#options.clientInstanceId,
      idempotencyKey: this.#idempotencyKey(),
      capabilityEvidence: capability,
      ...(resumeHandle === undefined ? {} : { resumeHandle }),
    });
    return validateTerminalGrant({
      grant,
      allowedRunaOrigins: this.#options.allowedRunaOrigins,
      requiredCapabilities: resumeHandle === undefined
        ? ["acknowledgement", "heartbeat"]
        : ["acknowledgement", "heartbeat", "resume"],
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
      const result = await nextWithTimeout(iterator, remaining);
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
      throw runtimeFailure("capability_unknown", `Runa cannot prove terminal capability ${name}.`);
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
        for (const frame of entry.decoder.push(result.value)) await this.#handleAttachedFrame(entry, frame);
        if (entry.state === "closed" || entry.state === "detached") return;
      }
      if (entry.state === "active" || entry.state === "reconnecting") {
        this.#clearHeartbeatWatchdog(entry);
        entry.state = "interrupted";
        entry.outputContinuity = "unknown";
        entry.reason = "transport_closed_without_terminal_exit";
        this.#publish(entry);
      }
    } catch (error) {
      if (entry.connection !== connection || entry.connectionRevision !== connectionRevision) return;
      if (entry.state === "detached" || entry.state === "closed") return;
      this.#clearHeartbeatWatchdog(entry);
      entry.state = error instanceof RuntimeBoundaryError && error.code === "terminal_protocol_error" ? "failed" : "interrupted";
      entry.outputContinuity = "unknown";
      entry.reason = safeReason(error);
      this.#publish(entry);
      await connection.close({ code: 1002, reason: "runa_terminal_protocol_failure" }).catch(() => undefined);
    }
  }

  async #handleAttachedFrame(entry: TerminalEntry, frame: TerminalFrame): Promise<void> {
    assertTerminalFrameLegal("attached", "server_to_client", frame.type);
    if (frame.type === "output") {
      if (frame.sequence <= entry.outputSequence) {
        throw runtimeFailure("terminal_protocol_error", "Terminal output sequence regressed or duplicated.");
      }
      entry.outputSequence = frame.sequence;
      if (this.#options.onTerminalOutput !== undefined) {
        const timeoutMs = this.#options.outputDeliveryTimeoutMs ?? 5_000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
          throw runtimeFailure("terminal_protocol_error", "The terminal output delivery deadline is invalid.");
        }
        await withOutputDeadline(Promise.resolve(this.#options.onTerminalOutput({
          tabId: entry.tabId,
          agentSessionId: entry.observation.agentSessionId,
          sequence: frame.sequence,
          bytes: frame.payload.slice(),
        })), timeoutMs);
      }
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
      if (acknowledged < 1n || acknowledged > entry.inputSequence || payload.meaning !== "durably_accepted_not_executed") {
        throw runtimeFailure("terminal_protocol_error", "Terminal input acknowledgement is invalid.");
      }
      return;
    }
    if (frame.type === "exit") {
      decodeTerminalControl(frame);
      this.#clearHeartbeatWatchdog(entry);
      entry.state = "closed";
      entry.reason = "remote_process_exit";
      this.#publish(entry);
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
    return runtimeFailure("terminal_protocol_error", "The Runa terminal gateway rejected the connection.", {
      retryable: payload.retryable === true,
      safeDetails: { reason: typeof payload.code === "string" ? payload.code : "terminal_error" },
    });
  }

  #publish(entry: TerminalEntry): void {
    this.#options.onTerminalState?.(snapshot(entry, this.#heartbeatTimeoutMs()));
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
    const remaining = Math.max(1, entry.lastHeartbeatAt + this.#heartbeatTimeoutMs() - this.#clock() + 1);
    entry.heartbeatTimer = setTimeout(() => {
      if (
        entry.connection !== connection ||
        entry.connectionRevision !== connectionRevision ||
        entry.state !== "active"
      ) return;
      if (this.#clock() - entry.lastHeartbeatAt <= this.#heartbeatTimeoutMs()) {
        this.#scheduleHeartbeatWatchdog(entry, connection, connectionRevision);
        return;
      }
      this.#expireHeartbeat(entry, connection, connectionRevision);
    }, remaining);
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
    entry.state = "interrupted";
    entry.outputContinuity = "unknown";
    entry.reason = "heartbeat_expired";
    this.#publish(entry);
    void connection.close({ code: 1001, reason: "runa_heartbeat_expired" }).catch(() => undefined);
  }

  #nextActiveTab(excluding: string): string | undefined {
    return [...this.#terminals.values()].find((entry) => entry.tabId !== excluding && entry.state === "active")?.tabId;
  }

  #assertOpen(): void {
    if (this.#closed) throw runtimeFailure("runtime_closed", "The local runtime has already stopped.");
  }

  #assertReady(): void {
    this.#assertOpen();
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

async function withOutputDeadline(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
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
    agentSessionId: entry.observation.agentSessionId,
    processEpoch: entry.observation.processEpoch,
    state: entry.state,
    fencingGeneration: entry.fencingGeneration,
    inputSequence: entry.inputSequence,
    outputSequence: entry.outputSequence,
    outputContinuity: entry.outputContinuity,
    resizeCapability: entry.resizeCapability,
    heartbeatObservedAt: entry.lastHeartbeatAt,
    heartbeatExpiresAt: entry.lastHeartbeatAt + heartbeatTimeoutMs,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
  });
}

async function nextWithTimeout(iterator: AsyncIterator<Uint8Array>, timeoutMs: number): Promise<IteratorResult<Uint8Array>> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(runtimeFailure("terminal_timeout", "The terminal readiness handshake timed out.", { retryable: true })), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function safeReason(error: unknown): string {
  if (error instanceof RuntimeBoundaryError) return error.code;
  return "transport_failure";
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
