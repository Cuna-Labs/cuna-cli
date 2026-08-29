import type { AgentSession, AgentSessionProcessState, Machine } from "../api/contracts.js";
import { decideCapability, requireCapability, type CunaApiClient } from "../api/client.js";
import { EXIT_CODES, CunaError, type ExitCode } from "../core/errors.js";
import { isObservationBudgetCode } from "../core/observation-budget.js";
import type { MachineSelectionState } from "./selection.js";
import type {
  AgentJourneyEffects,
  JourneyResourceLedger,
  JourneyWorkspaceReceipt,
  MachineCreateAuthorization,
} from "./orchestrator.js";

const MACHINE_POLL_LIMIT = 60;
const CHILD_POLL_LIMIT = 90;

export interface ApiAgentJourneyEffectsInput {
  readonly client: CunaApiClient;
  readonly inspectWorkspace: AgentJourneyEffects["inspectWorkspace"];
  readonly synchronizeWorkspace: AgentJourneyEffects["synchronizeWorkspace"];
  readonly attach: AgentJourneyEffects["attach"];
  readonly authorizeMachineCreate: (input: MachineCreateAuthorization) => Promise<boolean>;
  readonly reconcileCancellation?: (input: {
    readonly ledger: JourneyResourceLedger;
    readonly signal: AbortSignal;
  }) => Promise<void>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function fail(code: string, message: string, exitCode: ExitCode = EXIT_CODES.remote, details?: Record<string, string>): CunaError {
  return new CunaError({ code, message, exitCode, ...(details === undefined ? {} : { details }) });
}

/**
 * `agent_session_ready_timeout` collapsed at least four causes and exited with
 * a NETWORK code — on a run where the network answered ninety times.
 *
 * Nothing about the transport failed. The CLI asked the producer ninety times
 * and got ninety answers, and every one of them said the session was not ready.
 * `EXIT_CODES.network` sent the reader to their connection; the fault was on the
 * machine. That is what made conditions 6 and 7 expensive to diagnose.
 *
 * The three states a poll can exhaust on are three different faults with three
 * different next reads, so they get three names, and the exit status follows the
 * name rather than the shape of the loop that produced it:
 *
 *   starting     the producer sees it starting and it never finished
 *   unknown      the producer never observed a process state at all
 *   terminating  it was already shutting down before it was ever ready
 *
 * The partition below is proved exhaustive at COMPILE time against
 * `AgentSessionProcessState`. A state added to the contract without a decision
 * here is a type error, not a silent fall-through into whichever branch happens
 * to be last.
 */
const READY_STATES = ["ready", "running"] as const;
const TERMINAL_STATES = ["exited", "failed", "terminated"] as const;
const STALLED_STATES = ["unknown", "starting", "terminating"] as const;

const READY_PROCESS_STATES: ReadonlySet<AgentSessionProcessState> = new Set(READY_STATES);
const TERMINAL_PROCESS_STATES: ReadonlySet<AgentSessionProcessState> = new Set(TERMINAL_STATES);

type StalledProcessState = (typeof STALLED_STATES)[number];
type ClassifiedProcessState =
  | (typeof READY_STATES)[number]
  | (typeof TERMINAL_STATES)[number]
  | StalledProcessState;

// Both directions: no process state is unclassified, and no classification
// names a state the contract does not have.
type Unclassified = Exclude<AgentSessionProcessState, ClassifiedProcessState>;
type Invented = Exclude<ClassifiedProcessState, AgentSessionProcessState>;
type Exhaustive<T extends never> = T;
export type ProcessStateCoverage = [Exhaustive<Unclassified>, Exhaustive<Invented>];

const READINESS_STALL: Readonly<
  Record<StalledProcessState, { readonly code: string; readonly message: string; readonly exitCode: ExitCode }>
> = Object.freeze({
  starting: Object.freeze({
    code: "cuna.journey.agent_session_start_incomplete",
    message: "The AgentSession stayed in starting and never became ready. Inspect the machine, not the connection.",
    exitCode: EXIT_CODES.remote,
  }),
  unknown: Object.freeze({
    code: "cuna.journey.agent_session_unobservable",
    message: "The producer never observed a process state for this AgentSession.",
    exitCode: EXIT_CODES.remote,
  }),
  terminating: Object.freeze({
    code: "cuna.journey.agent_session_terminating",
    message: "The AgentSession was already shutting down before it was ever ready.",
    exitCode: EXIT_CODES.conflict,
  }),
});

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

function sessionObservation(session: AgentSession) {
  return Object.freeze({
    id: session.id,
    machineId: session.machineId,
    name: session.name,
    agent: session.agent,
    workspaceIdentity: session.workspaceBindingId ?? "unknown",
    workspaceGeneration: session.workspaceGeneration ?? 0,
    cwd: relativeCwd(session.cwd),
    authMode: session.authMode,
    processState: session.processState,
    // AgentSession does not own attachment state. Until a child-scoped
    // connection authority is exposed, automatic child reuse must abstain.
    attachment: "unknown" as const,
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
  const effects: AgentJourneyEffects = {
    inspectWorkspace: input.inspectWorkspace,
    async observeMachines({ signal }) {
      const page = await input.client.listMachines(signal);
      if (page.nextCursor !== undefined) {
        throw fail("cuna.journey.machine_page_incomplete", "Machine selection requires a complete bounded collection.", EXIT_CODES.policy);
      }
      return Promise.all(page.items.map(async (machine) => {
        let support: "supported" | "unsupported" | "unknown" = "unknown";
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
        } catch {
          support = "unknown";
        }
        return Object.freeze({
          id: machine.id,
          name: machine.name,
          agent: machine.agent === "claude-code" || machine.agent === "codex" || machine.agent === "openclaw" || machine.agent === "opencode"
            ? machine.agent
            : "unknown" as const,
          requestedAgentSupport: support,
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
    async createMachine({ requestedAgent, reason, stoppedMachineId, idempotencyKey, requestId, signal }) {
      await requireCapability({ client: input.client, scope: "account", capabilityId: "machines.create", now: now(), signal });
      if (!await input.authorizeMachineCreate({
        requestedAgent,
        reason,
        ...(stoppedMachineId === undefined ? {} : { stoppedMachineId }),
        signal,
      })) {
        throw fail(
          "cuna.journey.machine_create_not_authorized",
          "Machine creation was not authorized.",
          EXIT_CODES.policy,
        );
      }
      const machine = await input.client.createMachine({
        name: `cuna-${requestedAgent}-${requestId.slice(0, 8)}`,
        agent: requestedAgent,
        background: true,
      }, idempotencyKey, requestId, signal);
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
          return Object.freeze({ id: machine.id, state: machineState(machine.state) });
        }
        if (request.state === "terminal_failed" || request.action === "none") {
          throw fail("cuna.journey.machine_create_failed", "Machine creation reached an authoritative failure.");
        }
        await sleep(Math.min(2_000, 100 * 2 ** Math.min(attempt, 4)), signal);
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
      for (let attempt = 0; attempt < MACHINE_POLL_LIMIT; attempt += 1) {
        if (state === "running") return Object.freeze({ id: machineId, state });
        const observed = await input.client.getMachine(machineId, signal);
        state = machineState(observed.state);
        if (state === "deleted" || state === "error" || state === "unknown") {
          throw fail("cuna.journey.machine_not_ready", "The machine did not reach running state.");
        }
        await sleep(Math.min(2_000, 100 * 2 ** Math.min(attempt, 4)), signal);
      }
      throw fail("cuna.journey.machine_ready_timeout", "Machine readiness remained unproven.", EXIT_CODES.network);
    },
    synchronizeWorkspace: input.synchronizeWorkspace,
    async observeAgentSessions({ machineId, signal }) {
      const page = await input.client.listAgentSessions(machineId, { limit: 100 }, signal);
      if (page.nextCursor !== undefined) {
        throw fail("cuna.journey.agent_session_page_incomplete", "AgentSession selection requires a complete bounded collection.", EXIT_CODES.policy);
      }
      return Object.freeze(page.items.map(sessionObservation));
    },
    async createAgentSession({ machineId, agent, authMode, credentialBindingId, workspace, idempotencyKey, signal }) {
      await requireCapability({
        client: input.client,
        scope: "machine",
        resourceId: machineId,
        capabilityId: "agent_sessions.create",
        now: now(),
        signal,
      });
      const createInput = {
        agent,
        cwd: workspace.remoteCwd,
        workspaceBindingId: workspace.bindingId,
        workspaceGeneration: workspace.generation,
        authMode,
        ...(credentialBindingId === undefined ? {} : { credentialBindingId }),
      } as const;
      let session: AgentSession;
      try {
        session = await input.client.createAgentSession(
          machineId,
          createInput,
          idempotencyKey,
          signal,
        );
      } catch (error) {
        // "Uncertain" means no authoritative answer reached us. Read the
        // authority rather than a literal so a third budget kind cannot leave
        // this recovery path behind.
        const uncertain =
          error instanceof CunaError &&
          (isObservationBudgetCode(error.code) || error.code === "cuna.network.failed");
        if (!uncertain || signal.aborted) throw error;
        try {
          session = await input.client.inspectAgentSessionCreate(idempotencyKey, signal);
        } catch (inspectionError) {
          if (
            !(inspectionError instanceof CunaError) ||
            inspectionError.code !== "agent_session_not_found" ||
            signal.aborted
          ) {
            throw inspectionError;
          }
          // The first dispatch may have failed before durable admission. A
          // replay with the exact same key and canonical intent serializes on
          // the producer's idempotency authority and cannot create a sibling.
          session = await input.client.createAgentSession(
            machineId,
            createInput,
            idempotencyKey,
            signal,
          );
        }
      }
      if (
        session.machineId !== machineId ||
        session.agent !== agent ||
        session.cwd !== workspace.remoteCwd ||
        session.workspaceBindingId !== workspace.bindingId ||
        session.workspaceGeneration !== workspace.generation ||
        session.authMode !== authMode
      ) {
        throw fail(
          "cuna.journey.agent_session_create_authority_mismatch",
          "Recovered AgentSession authority does not match the requested canonical intent.",
          EXIT_CODES.conflict,
        );
      }
      return Object.freeze({ id: session.id, machineId: session.machineId });
    },
    async ensureAgentSessionReady({ agentSessionId, signal }) {
      const seen = new Set<AgentSessionProcessState>();
      let last: AgentSessionProcessState = "unknown";
      for (let attempt = 0; attempt < CHILD_POLL_LIMIT; attempt += 1) {
        const session = await input.client.getAgentSession(agentSessionId, signal);
        last = session.processState;
        seen.add(last);
        if (READY_PROCESS_STATES.has(last)) {
          return Object.freeze({ id: session.id, machineId: session.machineId });
        }
        if (TERMINAL_PROCESS_STATES.has(last)) {
          throw fail(
            "cuna.journey.agent_session_failed",
            `The AgentSession reached ${last} before attach.`,
            EXIT_CODES.remote,
            { observed_state: last },
          );
        }
        await sleep(Math.min(2_000, 100 * 2 ** Math.min(attempt, 4)), signal);
      }
      const stall = READINESS_STALL[last as StalledProcessState];
      throw fail(stall.code, stall.message, stall.exitCode, {
        observed_state: last,
        observed_states: [...seen].sort().join(","),
        observations: String(CHILD_POLL_LIMIT),
      });
    },
    attach: input.attach,
    async reconcileCancellation({ ledger, signal }) {
      if (input.reconcileCancellation !== undefined) {
        await input.reconcileCancellation({ ledger, signal });
        return;
      }
      if (ledger.createdAgentSessionId !== undefined) {
        await input.client.getAgentSession(ledger.createdAgentSessionId, signal).catch(() => undefined);
      } else {
        // Read-only recovery proves whether a cancelled in-flight create
        // durably admitted a child; it never creates a new AgentSession.
        await input.client
          .inspectAgentSessionCreate(`${ledger.idempotencyKey}-agent`, signal)
          .catch(() => undefined);
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
