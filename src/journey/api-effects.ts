import {withProviderLaunchIntent,type RecordedLaunchContext} from "./provider-launch-intent.js";
import { isAgentSessionGone } from "../runtime/terminal-client-identity.js";
import type {ProviderPreset} from "../api/provider-v2.js";
import {createPublishedProviderSessionV2,requireMatchingPreset} from "./remote-workspace.js";
import type { AgentSession, AgentSessionTerminalSeat, Machine } from "../api/contracts.js";
import { sessionFailure } from "./session-failure.js";
import { decideCapability, requireCapability, type CunaApiClient } from "../api/client.js";
import { EXIT_CODES, CunaError, type ExitCode } from "../core/errors.js";
import {
  isOpenCodeRuntimeUnverifiedCapabilityRejection,
  isOpenCodeSupervisorUpgradeReason,
  isOpenCodeSupervisorUpgradeCapabilityRejection,
  openCodeRuntimeUnverified,
  openCodeSupervisorUpgradeRequired,
} from "../machines/opencode-supervisor.js";
import { machineProviderAvailability } from "../machines/provider-availability.js";
import type { MachineSelectionState } from "./selection.js";
import type {
  AgentJourneyEffects,
  JourneyResourceLedger,
  JourneyWorkspaceReceipt,
} from "./orchestrator.js";
import {
  AGENT_SESSION_READY_DEADLINE_MS,
  MACHINE_READY_DEADLINE_MS,
  readinessBackoffMs,
  reissueIdempotentRead,
  startJourneyDeadline,
  type JourneyDeadline,
  type JourneyDeadlineElapsed,
  type JourneyWaitReporter,
} from "./wait-policy.js";

const MACHINE_POLL_LIMIT = 60;

/**
 * The noun phrases the readiness loops put on screen, as one vocabulary.
 *
 * Each one is a state this loop ALREADY distinguishes internally and never
 * said out loud: measured 2026-09-22, `Starting Claude Code · still working`
 * held for 61 259 ms across every one of these transitions
 * (`prds/cuna-cli-latency-before-20260922.md` § 3). They complete the sentence
 * "Still waiting for ___", so each is a noun phrase and none names a route.
 */
const WAITING_FOR = Object.freeze({
  sessionRead: "Cuna to answer the AgentSession read",
  terminalAuthorityRead: "Cuna to answer the terminal-authority read",
  machineRead: "Cuna to answer the machine read",
  processStart: "the session process to start",
  supervisorRegistry: "the machine's terminal supervisor to register",
  sessionAcceptsTerminal: "the session to accept a terminal",
  runtimeObservation: "a fresh runtime observation",
  machineRunning: "the machine to reach running",
});

/**
 * The capability refusal reasons this loop waits through, mapped to what a
 * person is actually waiting for. Three different causes produced one
 * indistinguishable sentence before; they must render differently or the
 * screen cannot discriminate them.
 */
const TERMINAL_AUTHORITY_WAIT: Readonly<Record<string, string>> = Object.freeze({
  supervisor_registry_unavailable: WAITING_FOR.supervisorRegistry,
  agent_session_not_ready: WAITING_FOR.sessionAcceptsTerminal,
  runtime_lease_expired: WAITING_FOR.runtimeObservation,
});

export interface ApiAgentJourneyEffectsInput {
  readonly client: CunaApiClient;
  readonly confirmNewProviderLaunch?: (signal:AbortSignal, context:RecordedLaunchContext)=>Promise<boolean>;
  readonly providerLaunchState?: {readonly stateDirectory:string;readonly ownerId:string;readonly workspaceId:string};
  /** `machineName` names the Machine in the one-line notice when nothing is asked. */
  readonly selectProviderPreset?: (signal:AbortSignal, context?:{readonly machineName?:string})=>Promise<ProviderPreset>;
  /** The only provider executable this journey may select a machine for. */
  readonly requestedAgent: "claude-code" | "codex" | "opencode";
  /**
   * This process's terminal client instance id, when the caller has one. A
   * writer seat held by it is reported `detached` so the reconnect path can
   * reissue with the resume handle. Absent, every held seat is a stranger's.
   */
  readonly clientInstanceId?: string;
  readonly inspectWorkspace: AgentJourneyEffects["inspectWorkspace"];
  readonly synchronizeWorkspace: AgentJourneyEffects["synchronizeWorkspace"];
  readonly attach: AgentJourneyEffects["attach"];
  readonly authorizeMachineCreate: (input: {
    readonly requestedAgent: "claude-code" | "codex" | "openclaw" | "opencode";
    readonly signal: AbortSignal;
  }) => Promise<boolean>;
  readonly reconcileCancellation?: (input: {
    readonly ledger: JourneyResourceLedger;
    readonly signal: AbortSignal;
  }) => Promise<void>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /**
   * Where a wait goes on screen. It is an input rather than a member of
   * `AgentJourneyEffects` because the waiting happens INSIDE an effect, and
   * `cli/run.ts` wraps the finished effects object by spreading it — a member
   * added by that wrapper is not the one these closures would call.
   */
  readonly onWait?: JourneyWaitReporter;
}

function fail(code: string, message: string, exitCode: ExitCode = EXIT_CODES.remote, details?: Record<string, string>): CunaError {
  return new CunaError({ code, message, exitCode, ...(details === undefined ? {} : { details }) });
}

function recency(machine: Machine, now: number): "recent" | "not_recent" | "unknown" {
  const timestamp = machine.updatedAt ?? machine.createdAt;
  if (timestamp === undefined) return "unknown";
  const observed = Date.parse(timestamp);
  if (!Number.isFinite(observed) || observed > now + 5_000) return "unknown";
  return now - observed <= 30 * 24 * 60 * 60 * 1_000 ? "recent" : "not_recent";
}

function machineState(value: string): MachineSelectionState {
  const states = new Set<string>(["creating", "running", "paused", "suspended", "stopped", "deleted", "error"]);
  return states.has(value) ? value as MachineSelectionState : "unknown";
}

function relativeCwd(cwd: string): string {
  return cwd.replace(/^\/workspace\/?/u, "") || ".";
}

type SeatAttachment =
  | { readonly attachment: "detached" | "unknown" }
  | { readonly attachment: "attached"; readonly attachmentHolder: string };

/**
 * Map the durable writer seat onto the selection's attachment fact.
 *
 *   available ∧ writer = null          → detached   (nobody types; reuse)
 *   available ∧ writer = this client   → detached   (our own seat; the
 *                                         reconnect path reissues with the
 *                                         resume handle)
 *   available ∧ writer = other client  → attached   (name the holder)
 *   owner_unrecoverable | none         → unknown    (no attestable PTY)
 *
 * Without our own client instance id every held seat is another client's:
 * claiming a seat as ours on no evidence would race a terminal that has a
 * writer.
 */
export function attachmentFromSeat(
  seat: AgentSessionTerminalSeat,
  ownClientInstanceId: string | undefined,
): SeatAttachment {
  if (seat.state !== "available") return { attachment: "unknown" };
  if (seat.writerClientInstanceId === null) return { attachment: "detached" };
  // The row names the last writer forever; only its connection says whether
  // that client is there now. A writer that has detached leaves the terminal
  // reusable, which is the whole point of a durable session.
  if (!seat.writerAttached) return { attachment: "detached" };
  if (ownClientInstanceId !== undefined && seat.writerClientInstanceId === ownClientInstanceId) {
    return { attachment: "detached" };
  }
  return { attachment: "attached", attachmentHolder: seat.writerClientInstanceId };
}

/**
 * An edge that does not serve the seat route answers 404. Both spellings the
 * transport gives a 404 map to "the fact is not published here": a plain
 * 404 is `operation_not_served`, a Problem-shaped `resource_not_found` is
 * `not_found`. Every other error is a real failure and propagates.
 */
function isSeatUnserved(error: unknown): boolean {
  return error instanceof CunaError &&
    (error.code === "cuna.remote.operation_not_served" || error.code === "cuna.remote.not_found");
}

/**
 * The execution Workspace a v2 session runs in, read from its cwd.
 *
 * A session created through the execution-Workspace path
 * (`createPublishedProviderSessionV2`) is published WITHOUT
 * `workspace_binding_id`: the wire names its Workspace only through `cwd`,
 * which the create call itself pinned to `/workspace/workspaces/<id>` and the
 * server echoed. Until 2026-09-21 `sessionObservation` mapped that absence to
 * the identity `"unknown"`, so no v2 session could ever equal the identity the
 * journey was looking for, and every `cuna claude <path>` on an already-running
 * session went to "Creating Claude Code session". Measured in production on
 * Machine bd94a624: session 8d99301b running, detached, fresh, same cwd, and
 * the second run offered the profile picker for a NEW session.
 */
const EXECUTION_WORKSPACE_CWD = /^\/workspace\/workspaces\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/.*)?$/u;

export function executionWorkspaceIdFromCwd(cwd: string): string | undefined {
  return EXECUTION_WORKSPACE_CWD.exec(cwd)?.[1];
}

function sessionObservation(session: AgentSession, seat: SeatAttachment) {
  const executionWorkspaceId = session.workspaceBindingId === undefined
    ? executionWorkspaceIdFromCwd(session.cwd)
    : undefined;
  return Object.freeze({
    id: session.id,
    machineId: session.machineId,
    name: session.name,
    agent: session.agent,
    workspaceIdentity: session.workspaceBindingId ?? executionWorkspaceId ?? "unknown",
    // A binding session carries the generation it was created against; an
    // execution-Workspace session is published without one, so the journey
    // compares generations only for binding sessions (see `workspaceKind`).
    workspaceKind: session.workspaceBindingId !== undefined
      ? "binding" as const
      : executionWorkspaceId !== undefined ? "execution" as const : "unknown" as const,
    workspaceGeneration: session.workspaceGeneration ?? 0,
    cwd: relativeCwd(session.cwd),
    authMode: session.authMode,
    processState: session.processState,
    ...seat,
    freshness: "fresh" as const,
    createdAt: session.createdAt,
  });
}

async function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

export function createApiAgentJourneyEffects(input: ApiAgentJourneyEffectsInput): AgentJourneyEffects {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  /**
   * Run one idempotent read under a phase deadline, re-issuing it if the CLI's
   * own per-request budget elapses. Written once here so no readiness loop can
   * spell the policy differently: the 2026-09-22 abort happened because ONE
   * read's budget was, in effect, the whole journey's deadline.
   */
  const readWithin = <T>(context: {
    readonly waitingFor: string;
    readonly deadline: JourneyDeadline;
    readonly signal: AbortSignal;
    readonly deadlineFailure: (elapsed: JourneyDeadlineElapsed) => Error;
    readonly read: () => Promise<T>;
  }): Promise<T> => reissueIdempotentRead({
    waitingFor: context.waitingFor,
    read: context.read,
    deadline: context.deadline,
    signal: context.signal,
    sleep,
    deadlineFailure: context.deadlineFailure,
    ...(input.onWait === undefined ? {} : { onWait: input.onWait }),
  });
  const reportWait = (deadline: JourneyDeadline, waitingFor: string): void => {
    input.onWait?.(Object.freeze({
      waitingFor,
      elapsedMs: deadline.elapsedMs(),
      deadlineMs: deadline.deadlineMs,
    }));
  };
  // Names this journey has read, for the one line a person sees before a
  // session starts. Display only: every decision is made by id.
  const machineNames = new Map<string, string>();
  const effects: AgentJourneyEffects = {
    inspectWorkspace: input.inspectWorkspace,
    async observeMachines({ signal }) {
      const page = await input.client.listMachines(signal);
      for (const machine of page.items) machineNames.set(machine.id, machine.name);
      if (page.nextCursor !== undefined) {
        throw fail("cuna.journey.machine_page_incomplete", "Machine selection requires a complete bounded collection.", EXIT_CODES.policy);
      }
      return Promise.all(page.items.map(async (machine) => {
        let support: "supported" | "unsupported" | "unknown" = "unknown";
        let supportReason: string | undefined;
        const provider = machineProviderAvailability(machine);
        if (!provider.actionable || provider.agent !== input.requestedAgent) {
          return Object.freeze({
            id: machine.id,
            name: machine.name,
            agent: provider.agent ?? "unknown" as const,
            requestedAgentSupport: "unsupported" as const,
            state: machineState(machine.state),
            ownership: "owned" as const,
            freshness: "fresh" as const,
            recency: recency(machine, now()),
            resources: Object.freeze({
              ...(machine.vcpus === undefined ? {} : { vcpus: machine.vcpus }),
              ...(machine.memoryMiB === undefined ? {} : { memoryMiB: machine.memoryMiB }),
            }),
            costStatus: "unknown" as const,
          });
        }
        try {
          const snapshot = await input.client.discoverCapabilities("machine", machine.id, signal);
          if (snapshot.subjectScope !== "machine" || snapshot.subjectId !== machine.id) {
            return Object.freeze({
              id: machine.id,
              name: machine.name,
              agent: "unknown" as const,
              requestedAgentSupport: "unknown" as const,
              state: machineState(machine.state),
              ownership: "owned" as const,
              freshness: "fresh" as const,
              recency: recency(machine, now()),
              resources: Object.freeze({}),
              costStatus: "unknown" as const,
            });
          }
          const decision = decideCapability(snapshot, "agent_sessions.create", now());
          support = decision.status === "supported"
            ? "supported"
            : decision.status === "unsupported"
              ? "unsupported"
              : "unknown";
          supportReason = decision.status === "supported" ? undefined : decision.reason;
        } catch {
          support = "unknown";
        }
        const requestedAgentBlocker = input.requestedAgent === "opencode" &&
          support === "unsupported" &&
          isOpenCodeSupervisorUpgradeReason(supportReason)
          ? "opencode-supervisor-update-required" as const
          : undefined;
        return Object.freeze({
          id: machine.id,
          name: machine.name,
          agent: provider.agent ?? "unknown" as const,
          requestedAgentSupport: support,
          ...(requestedAgentBlocker === undefined ? {} : { requestedAgentBlocker }),
          state: machineState(machine.state),
          ownership: "owned" as const,
          freshness: "fresh" as const,
          recency: recency(machine, now()),
          resources: Object.freeze({
            ...(machine.vcpus === undefined ? {} : { vcpus: machine.vcpus }),
            ...(machine.memoryMiB === undefined ? {} : { memoryMiB: machine.memoryMiB }),
          }),
          costStatus: "unknown" as const,
        });
      }));
    },
    async createMachine({ requestedAgent, idempotencyKey, requestId, onDispatch, signal }) {
      await requireCapability({ client: input.client, scope: "account", capabilityId: "machines.create", now, signal });
      if (!await input.authorizeMachineCreate({ requestedAgent, signal })) {
        throw fail(
          "cuna.journey.machine_create_not_authorized",
          "Machine creation was not authorized.",
          EXIT_CODES.policy,
        );
      }
      // Everything above this line fails before anything is sent: the
      // capability check and the person's own confirmation.
      onDispatch();
      const machine = await input.client.createMachine({
        name: `cuna-${requestedAgent}-${requestId.slice(0, 8)}`,
        agent: requestedAgent,
        background: true,
      }, idempotencyKey, requestId, signal);
      machineNames.set(machine.id, machine.name);
      return Object.freeze({ id: machine.id, state: machineState(machine.state) });
    },
    async reconcileMachineCreate({ requestId, signal }) {
      for (let attempt = 0; attempt < MACHINE_POLL_LIMIT; attempt += 1) {
        let request = await input.client.getMachineCreateRequest(requestId, signal);
        if (request.state === "unknown" || request.action === "reconcile") {
          request = await input.client.reconcileMachineCreateRequest(requestId, signal);
        }
        if (request.state === "settled" || request.state === "provider_succeeded") {
          const machine = await input.client.getMachine(request.machineId, signal);
          machineNames.set(machine.id, machine.name);
          return Object.freeze({ id: machine.id, state: machineState(machine.state) });
        }
        if (request.state === "terminal_failed" || request.action === "none") {
          throw fail("cuna.journey.machine_create_failed", "Machine creation reached an authoritative failure.");
        }
        await sleep(readinessBackoffMs(attempt), signal);
      }
      return "unreconcilable";
    },
    async ensureMachineReady({ machineId, observedState, signal }) {
      let state = observedState;
      if (state === "paused" || state === "suspended") {
        state = machineState((await input.client.transitionMachine(machineId, "resume", signal)).state);
      } else if (state === "stopped") {
        state = machineState((await input.client.transitionMachine(machineId, "start", signal)).state);
      } else if (state === "deleted" || state === "error" || state === "unknown") {
        throw fail("cuna.journey.machine_not_reusable", "The selected machine is not safely reusable.", EXIT_CODES.policy);
      }
      const deadline = startJourneyDeadline(MACHINE_READY_DEADLINE_MS, now);
      const deadlineFailure = (elapsed: JourneyDeadlineElapsed): CunaError => new CunaError({
        code: "cuna.journey.machine_ready_timeout",
        message: `Cuna stopped waiting for ${elapsed.waitingFor} after ${Math.round(elapsed.elapsedMs / 1_000)} s. Machine readiness remains unproven.`,
        exitCode: EXIT_CODES.network,
        retryable: true,
        hint: `Read the machine before starting another: cuna machines list`,
        details: {
          machine_id: machineId,
          waiting_for: elapsed.waitingFor,
          deadline_ms: elapsed.deadlineMs,
          elapsed_ms: elapsed.elapsedMs,
          read_reissues: elapsed.readReissues,
        },
        ...(elapsed.cause === undefined ? {} : { cause: elapsed.cause }),
      });
      for (let attempt = 0; !deadline.elapsed(); attempt += 1) {
        if (state === "running") return Object.freeze({ id: machineId, state });
        const observed = await readWithin({
          waitingFor: WAITING_FOR.machineRead,
          deadline,
          signal,
          deadlineFailure,
          read: () => input.client.getMachine(machineId, signal),
        });
        state = machineState(observed.state);
        if (state === "deleted" || state === "error" || state === "unknown") {
          throw fail("cuna.journey.machine_not_ready", "The machine did not reach running state.");
        }
        if (state === "running") return Object.freeze({ id: machineId, state });
        reportWait(deadline, WAITING_FOR.machineRunning);
        await sleep(readinessBackoffMs(attempt), signal);
      }
      throw deadlineFailure(Object.freeze({
        waitingFor: WAITING_FOR.machineRunning,
        elapsedMs: deadline.elapsedMs(),
        deadlineMs: deadline.deadlineMs,
        readReissues: 0,
        cause: undefined,
      }));
    },
    synchronizeWorkspace: input.synchronizeWorkspace,
    async observeAgentSessions({ machineId, signal }) {
      const page = await input.client.listAgentSessions(machineId, { limit: 100 }, signal);
      if (page.nextCursor !== undefined) {
        throw fail("cuna.journey.agent_session_page_incomplete", "AgentSession selection requires a complete bounded collection.", EXIT_CODES.policy);
      }
      return Object.freeze(await Promise.all(page.items.map(async (session) => {
        // Only a session that could be reused is asked for its seat. A
        // terminal or starting one is refused on its process state before the
        // seat would matter, and reading it would only spend a request.
        if (session.processState !== "ready" && session.processState !== "running") {
          return sessionObservation(session, { attachment: "unknown" });
        }
        let seat: AgentSessionTerminalSeat;
        try {
          await requireCapability({ client: input.client, scope: "agent_session", resourceId: session.id, capabilityId: "terminal_seats.read", allowedInteractions: ["read_only"], now, signal });
          seat = await input.client.getAgentSessionTerminalSeat(session.id, signal);
        } catch (error) {
          if (isSeatUnserved(error)) return sessionObservation(session, { attachment: "unknown" });
          throw error;
        }
        return sessionObservation(session, attachmentFromSeat(seat, input.clientInstanceId));
      })));
    },
    async createAgentSession({ machineId, agent, authMode, credentialBindingId, workspace, signal }) {
      try {
        await requireCapability({
          client: input.client,
          scope: "machine",
          resourceId: machineId,
          capabilityId: "agent_sessions.create",
          now,
          signal,
        });
      } catch (error) {
        if (agent === "opencode" && isOpenCodeSupervisorUpgradeCapabilityRejection(error)) {
          throw openCodeSupervisorUpgradeRequired({
            ...(error.details === undefined ? {} : { details: error.details }),
            machineId,
            cause: error,
          });
        }
        if (agent === "opencode" && isOpenCodeRuntimeUnverifiedCapabilityRejection(error)) {
          throw openCodeRuntimeUnverified({
            ...(error.details === undefined ? {} : { details: error.details }),
            machineId,
            cause: error,
          });
        }
        throw error;
      }
      if(agent==='opencode'||agent==='codex'||agent==='claude-code'){
        if(authMode!=='interactive_login'||credentialBindingId!==undefined||!workspace.executionWorkspaceId||workspace.generation<1||!input.selectProviderPreset)throw fail('cuna.provider.v2_unavailable','The agent requires a selected V2 profile and a published execution Workspace.');
        const machineName=machineNames.get(machineId);
        const preset=await input.selectProviderPreset(signal,machineName===undefined?undefined:{machineName});
        requireMatchingPreset(agent,preset);
        if(!input.providerLaunchState)throw fail('cuna.provider.v2_unavailable','Durable provider launch state is unavailable.');
        const executionWorkspaceId=workspace.executionWorkspaceId;
        const session=await withProviderLaunchIntent({...input.providerLaunchState,machineId,executionWorkspaceId,confirmNew:async(context)=>await input.confirmNewProviderLaunch?.(signal,context)??false,isSessionEnded:async(id)=>isAgentSessionGone(await input.client.getAgentSession(id,signal)),intent:{executionWorkspaceId,generation:workspace.generation,cwd:workspace.remoteCwd,profileId:preset.profile_id,profileRevision:preset.profile_revision,agent,authMode},create:operationId=>createPublishedProviderSessionV2({client:input.client,machineId,agent,preset,operationId,executionWorkspaceId,generation:workspace.generation,cwd:workspace.remoteCwd,signal})});
        return Object.freeze({id:session.id,machineId:session.machineId});
      }
      throw fail('cuna.provider.v2_unavailable','This agent has no supported canonical V2 launch profile.');
    },
    async ensureAgentSessionReady({ agentSessionId, signal }) {
      const deadline = startJourneyDeadline(AGENT_SESSION_READY_DEADLINE_MS, now);
      const deadlineFailure = (elapsed: JourneyDeadlineElapsed): CunaError => new CunaError({
        code: "cuna.journey.agent_session_ready_timeout",
        message: `Cuna stopped waiting for ${elapsed.waitingFor} after ${Math.round(elapsed.elapsedMs / 1_000)} s. The remote request may still be pending.`,
        exitCode: EXIT_CODES.network,
        retryable: true,
        hint: `Inspect the existing request before starting another session: cuna agent-sessions get ${agentSessionId}`,
        details: {
          agent_session_id: agentSessionId,
          // The three numbers the screen was already showing, so a transcript
          // and an error record cannot disagree about what was waited for.
          waiting_for: elapsed.waitingFor,
          deadline_ms: elapsed.deadlineMs,
          elapsed_ms: elapsed.elapsedMs,
          read_reissues: elapsed.readReissues,
        },
        ...(elapsed.cause === undefined ? {} : { cause: elapsed.cause }),
      });
      // What the CLI is waiting for RIGHT NOW. It moves with the loop's own
      // observations, so the deadline failure names the last real blocker
      // instead of the phase.
      let waitingFor: string = WAITING_FOR.processStart;
      for (let attempt = 0; !deadline.elapsed(); attempt += 1) {
        if (signal?.aborted) throw signal.reason;
        const session = await readWithin({
          waitingFor: WAITING_FOR.sessionRead,
          deadline,
          signal,
          deadlineFailure,
          read: () => input.client.getAgentSession(agentSessionId, signal),
        });
        if (session.requestState === "failed") {
          if (session.workspaceFailureCode !== undefined) {
            const messages: Record<string, string> = {
              "workspace.remote_edits": "Remote edits prevent synchronization. Preserve and reconcile those edits before retrying.",
              "workspace.in_use": "This workspace is still in use or waiting for a previous session to finish. Inspect its sessions before retrying.",
              "workspace.replacement_requires_fence": "This Workspace cannot replace its files while writer exclusion is unverified. Its existing files were preserved.",
              "workspace.materialization_manifest_limit": "This Workspace exceeds the runtime file manifest limit. Reduce the synchronized file set before retrying.",
            };
            throw fail("cuna.journey.workspace_materialization_failed", messages[session.workspaceFailureCode] ?? "The runtime could not prepare this Workspace. Its failure code identifies the refused operation.", EXIT_CODES.remote, { reason: session.workspaceFailureCode });
          }
          throw sessionFailure(session, "The AgentSession request failed before attach.");
        }
        if (signal?.aborted) throw signal.reason;
        if (session.id !== agentSessionId) {
          throw fail("cuna.journey.session_identity_mismatch", "The readiness observation describes a different AgentSession.");
        }
        if (session.processState === "ready" || session.processState === "running") {
          // A durable process acknowledgement can precede the registry's exact
          // PTY attachment. Wait for that authority without dispatching again.
          waitingFor = WAITING_FOR.sessionAcceptsTerminal;
          try {
            await readWithin({
              waitingFor: WAITING_FOR.terminalAuthorityRead,
              deadline,
              signal,
              deadlineFailure,
              read: () => requireCapability({ client: input.client, scope: "agent_session", resourceId: agentSessionId,
                capabilityId: "terminal_connections.create", allowedInteractions: ["native"], now, signal }),
            });
            if (signal?.aborted) throw signal.reason;
            return Object.freeze({ id: session.id, machineId: session.machineId });
          } catch (error) {
            if (signal?.aborted) throw signal.reason;
            if (!(error instanceof CunaError
              && ["cuna.capability.unknown", "cuna.capability.temporarily_unavailable"].includes(error.code)
              && error.details?.capability_id === "terminal_connections.create"
              && ["supervisor_registry_unavailable", "agent_session_not_ready", "runtime_lease_expired"].includes(String(error.details?.reason)))) throw error;
            // Three causes shared one sentence on screen for 61 s. The refusal
            // reason is the only thing that separates them, and it is already
            // here.
            waitingFor = TERMINAL_AUTHORITY_WAIT[String(error.details?.reason)] ?? WAITING_FOR.sessionAcceptsTerminal;
          }
        } else {
          waitingFor = WAITING_FOR.processStart;
        }
        if (["exited", "failed", "terminated"].includes(session.processState)) {
          throw sessionFailure(session, "The AgentSession reached a terminal state before attach.");
        }
        reportWait(deadline, waitingFor);
        await sleep(readinessBackoffMs(attempt), signal);
      }
      throw deadlineFailure(Object.freeze({
        waitingFor,
        elapsedMs: deadline.elapsedMs(),
        deadlineMs: deadline.deadlineMs,
        readReissues: 0,
        cause: undefined,
      }));
    },
    attach: input.attach,
    async reconcileCancellation({ ledger, signal }) {
      if (input.reconcileCancellation !== undefined) {
        await input.reconcileCancellation({ ledger, signal });
        return;
      }
      if (ledger.createdAgentSessionId !== undefined) {
        await input.client.getAgentSession(ledger.createdAgentSessionId, signal).catch(() => undefined);
      }
      // An absent request identity proves no create was dispatched, so there is
      // nothing to reconcile. It used to be present unconditionally, which made
      // every cancelled journey that merely SELECTED a machine query a request
      // identity the producer had never been told about.
      if (ledger.createdMachineId === undefined && ledger.machineCreateRequestId !== undefined) {
        const requestId = ledger.machineCreateRequestId;
        try {
          let request = await input.client.getMachineCreateRequest(requestId, signal);
          if (request.state === "unknown" || request.action === "reconcile") {
            request = await input.client.reconcileMachineCreateRequest(requestId, signal);
          }
          if (request.state === "settled" || request.state === "provider_succeeded") {
            await input.client.getMachine(request.machineId, signal);
          }
        } catch {
          // A missing request proves no cleanup target; a transport failure
          // remains unproven and is reported by the cancellation result.
        }
      }
      if (ledger.createdMachineId !== undefined) {
        await input.client.getMachine(ledger.createdMachineId, signal).catch(() => undefined);
      }
    },
  };
  return Object.freeze(effects);
}

export type { JourneyWorkspaceReceipt };
