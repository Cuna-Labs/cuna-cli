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
  readonly machineId: string;
  readonly agentSessionId: string;
  readonly processEpoch: string;
  readonly state: RuntimeTerminalState;
  readonly fencingGeneration: number;
  readonly inputSequence: bigint;
  readonly outputSequence: bigint;
  readonly outputContinuity: "complete" | "unknown" | "incomplete";
  readonly reason?: string;
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
  readonly onTerminalOutput?: (event: {
    readonly tabId: string;
    readonly agentSessionId: string;
    readonly sequence: bigint;
    readonly bytes: Uint8Array;
  }) => void;
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
  wireSequence: bigint;
  inputSequence: bigint;
  outputSequence: bigint;
  outputContinuity: RuntimeTerminalSnapshot["outputContinuity"];
  resumeHandle: string;
  reason?: string;
  pump?: Promise<void>;
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
    try {
      const grant = await this.#createGrant(admitted.observation, admitted.capability, undefined);
      connection = await this.#options.terminalConnector.connect({
        url: grant.connectUrl,
        token: grant.connectToken,
        protocol: TERMINAL_PROTOCOL,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const entry: TerminalEntry = {
        tabId: input.tabId,
        viewId: viewId(input.tabId, grant.attachmentGeneration),
        observation: admitted.observation,
        state: "attaching",
        connection,
        decoder: new TerminalFrameDecoder(),
        fencingGeneration: grant.attachmentGeneration,
        wireSequence: 0n,
        inputSequence: 0n,
        outputSequence: 0n,
        outputContinuity: "unknown",
        resumeHandle: grant.resumeHandle,
      };
      const iterator = connection.receive()[Symbol.asyncIterator]();
      const bufferedFrames = await this.#awaitReady(entry, grant, iterator, input.signal);
      this.#views.open({
        viewId: entry.viewId,
        binding: {
          userId: admitted.observation.userId,
          machineId: admitted.observation.machineId,
          agentSessionId: admitted.observation.agentSessionId,
          processEpoch: admitted.observation.processEpoch,
          fencingGeneration: grant.attachmentGeneration,
        },
        state: "active",
        columns: input.columns,
        rows: input.rows,
      });
      entry.state = "active";
      entry.outputContinuity = "complete";
      this.#terminals.set(input.tabId, entry);
      this.#activeTabId ??= input.tabId;
      for (const frame of bufferedFrames) this.#handleAttachedFrame(entry, frame);
      this.#publish(entry);
      entry.pump = this.#pump(entry, iterator);
      return snapshot(entry);
    } catch (error) {
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
    return snapshot(entry);
  }

  async sendInput(bytes: Uint8Array, tabId = this.#activeTabId): Promise<void> {
    this.#assertReady();
    const entry = this.#requireActiveTerminal(tabId);
    this.#views.routeInput(entry.viewId, entry.fencingGeneration);
    entry.wireSequence += 1n;
    entry.inputSequence = entry.wireSequence;
    await entry.connection.send(encodeTerminalFrame({
      type: "input",
      critical: true,
      sequence: entry.inputSequence,
      payload: bytes.slice(),
    }));
  }

  async resize(columns: number, rows: number, tabId = this.#activeTabId): Promise<void> {
    const entry = this.#requireActiveTerminal(tabId);
    this.#views.resize(entry.viewId, columns, rows);
    entry.wireSequence += 1n;
    await entry.connection.send(encodeTerminalControl("resize", entry.wireSequence, { columns, rows }));
  }

  async signal(signal: "interrupt" | "suspend" | "terminate", tabId = this.#activeTabId): Promise<void> {
    const entry = this.#requireActiveTerminal(tabId);
    this.#views.routeInput(entry.viewId, entry.fencingGeneration);
    entry.wireSequence += 1n;
    await entry.connection.send(encodeTerminalControl("signal", entry.wireSequence, { signal }));
  }

  async reconnect(input: { readonly tabId: string; readonly signal?: AbortSignal }): Promise<RuntimeTerminalSnapshot> {
    this.#assertReady();
    const entry = this.#requireTerminal(input.tabId);
    if (entry.state !== "interrupted") {
      throw runtimeFailure("session_conflict", "Only an interrupted terminal can reconnect.");
    }
    entry.state = "reconnecting";
    delete entry.reason;
    this.#publish(entry);
    const admitted = await this.#admitRemoteTerminal(entry.observation.agentSessionId);
    if (admitted.observation.processEpoch !== entry.observation.processEpoch) {
      entry.state = "failed";
      entry.reason = "process_generation_changed";
      this.#publish(entry);
      throw runtimeFailure("session_discontinuous", "The remote process generation changed; this terminal cannot be resumed.");
    }
    await entry.connection.close({ code: 1001, reason: "runa_reconnect" }).catch(() => undefined);
    const grant = await this.#createGrant(admitted.observation, admitted.capability, entry.resumeHandle);
    const connection = await this.#options.terminalConnector.connect({
      url: grant.connectUrl,
      token: grant.connectToken,
      protocol: TERMINAL_PROTOCOL,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    try {
      const iterator = connection.receive()[Symbol.asyncIterator]();
      const previousViewId = entry.viewId;
      entry.connection = connection;
      entry.observation = admitted.observation;
      entry.decoder = new TerminalFrameDecoder();
      entry.fencingGeneration = grant.attachmentGeneration;
      entry.viewId = viewId(entry.tabId, grant.attachmentGeneration);
      entry.resumeHandle = grant.resumeHandle;
      const bufferedFrames = await this.#awaitReady(entry, grant, iterator, input.signal);
      entry.wireSequence += 1n;
      await connection.send(encodeTerminalControl("resume", entry.wireSequence, {
        resumeHandle: entry.resumeHandle,
        afterOutputSequence: entry.outputSequence.toString(),
      }));
      try { this.#views.detach(previousViewId); } catch { /* the prior view may already be detached */ }
      const previous = this.#views.require(previousViewId);
      this.#views.open({
        viewId: entry.viewId,
        binding: {
          userId: admitted.observation.userId,
          machineId: admitted.observation.machineId,
          agentSessionId: admitted.observation.agentSessionId,
          processEpoch: admitted.observation.processEpoch,
          fencingGeneration: grant.attachmentGeneration,
        },
        state: "active",
        columns: previous.columns,
        rows: previous.rows,
      });
      entry.state = "active";
      entry.outputContinuity = "unknown";
      for (const frame of bufferedFrames) this.#handleAttachedFrame(entry, frame);
      this.#publish(entry);
      entry.pump = this.#pump(entry, iterator);
      return snapshot(entry);
    } catch (error) {
      await connection.close({ code: 1008, reason: "runa_resume_rejected" }).catch(() => undefined);
      entry.state = "interrupted";
      entry.reason = safeReason(error);
      this.#publish(entry);
      throw error;
    }
  }

  async detach(tabId: string): Promise<void> {
    const entry = this.#requireTerminal(tabId);
    if (entry.state === "closed" || entry.state === "detached") return;
    try { this.#views.detach(entry.viewId); } catch { /* attach may have failed before view creation */ }
    entry.state = "detached";
    entry.reason = "explicit_detach";
    this.#publish(entry);
    await entry.connection.close({ code: 1000, reason: "runa_detach" });
    if (this.#activeTabId === tabId) this.#activeTabId = this.#nextActiveTab(tabId);
  }

  listTerminals(): readonly RuntimeTerminalSnapshot[] {
    return Object.freeze([...this.#terminals.values()].map(snapshot));
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
    });
    try {
      const { supervisor } = this.#syncRegistry.connect(input.configuration);
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
      observation,
      allowedRunaOrigins: this.#options.allowedRunaOrigins,
      now: this.#clock(),
    });
  }

  async #awaitReady(
    entry: TerminalEntry,
    grant: TerminalConnectionGrant,
    iterator: AsyncIterator<Uint8Array>,
    signal: AbortSignal | undefined,
  ): Promise<readonly TerminalFrame[]> {
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
        assertReadyPayloadMatches(payload, entry.observation, grant);
        return Object.freeze(frames.slice(index + 1));
      }
    }
    throw runtimeFailure("terminal_timeout", "The terminal did not prove PTY readiness before the deadline.", { retryable: true });
  }

  async #pump(entry: TerminalEntry, iterator: AsyncIterator<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        const result = await iterator.next();
        if (result.done) break;
        for (const frame of entry.decoder.push(result.value)) this.#handleAttachedFrame(entry, frame);
        if (entry.state === "closed" || entry.state === "detached") return;
      }
      if (entry.state === "active" || entry.state === "reconnecting") {
        entry.state = "interrupted";
        entry.reason = "transport_closed_without_terminal_exit";
        this.#publish(entry);
      }
    } catch (error) {
      if (entry.state === "detached" || entry.state === "closed") return;
      entry.state = error instanceof RuntimeBoundaryError && error.code === "terminal_protocol_error" ? "failed" : "interrupted";
      entry.reason = safeReason(error);
      this.#publish(entry);
      await entry.connection.close({ code: 1002, reason: "runa_terminal_protocol_failure" }).catch(() => undefined);
    }
  }

  #handleAttachedFrame(entry: TerminalEntry, frame: TerminalFrame): void {
    assertTerminalFrameLegal("attached", "server_to_client", frame.type);
    if (frame.type === "output") {
      if (frame.sequence <= entry.outputSequence) {
        throw runtimeFailure("terminal_protocol_error", "Terminal output sequence regressed or duplicated.");
      }
      entry.outputSequence = frame.sequence;
      this.#options.onTerminalOutput?.({
        tabId: entry.tabId,
        agentSessionId: entry.observation.agentSessionId,
        sequence: frame.sequence,
        bytes: frame.payload.slice(),
      });
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
      entry.state = "closed";
      entry.reason = "remote_process_exit";
      this.#publish(entry);
      return;
    }
    if (frame.type === "error") throw this.#remoteTerminalError(frame);
    if (frame.type === "heartbeat") decodeTerminalControl(frame);
  }

  #remoteTerminalError(frame: TerminalFrame): RuntimeBoundaryError {
    const payload = decodeTerminalControl(frame);
    return runtimeFailure("terminal_protocol_error", "The Runa terminal gateway rejected the connection.", {
      retryable: payload.retryable === true,
      safeDetails: { reason: typeof payload.code === "string" ? payload.code : "terminal_error" },
    });
  }

  #publish(entry: TerminalEntry): void {
    this.#options.onTerminalState?.(snapshot(entry));
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
    return entry;
  }

  #nextActiveTab(excluding: string): string | undefined {
    return [...this.#terminals.values()].find((entry) => entry.tabId !== excluding && entry.state === "active")?.tabId;
  }

  #assertOpen(): void {
    if (this.#closed) throw runtimeFailure("runtime_closed", "The local runtime has already stopped.");
  }

  #assertReady(): void {
    this.#assertOpen();
    if (this.#daemon.snapshot().state !== "ready") {
      throw runtimeFailure("remote_state_unproven", "The local runtime is not in a verified ready state.");
    }
  }
}

function snapshot(entry: TerminalEntry): RuntimeTerminalSnapshot {
  return Object.freeze({
    tabId: entry.tabId,
    viewId: entry.viewId,
    machineId: entry.observation.machineId,
    agentSessionId: entry.observation.agentSessionId,
    processEpoch: entry.observation.processEpoch,
    state: entry.state,
    fencingGeneration: entry.fencingGeneration,
    inputSequence: entry.inputSequence,
    outputSequence: entry.outputSequence,
    outputContinuity: entry.outputContinuity,
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
