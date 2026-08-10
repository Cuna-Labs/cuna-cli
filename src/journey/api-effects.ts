import type { AgentSession, Machine } from "../api/contracts.js";
import { decideCapability, requireCapability, type RunaApiClient } from "../api/client.js";
import { EXIT_CODES, CunaError, type ExitCode } from "../core/errors.js";
import type { MachineSelectionState } from "./selection.js";
import type {
  AgentJourneyEffects,
  JourneyResourceLedger,
  JourneyWorkspaceReceipt,
} from "./orchestrator.js";

const MACHINE_POLL_LIMIT = 60;
const CHILD_POLL_LIMIT = 90;

export interface ApiAgentJourneyEffectsInput {
  readonly client: RunaApiClient;
  readonly inspectWorkspace: AgentJourneyEffects["inspectWorkspace"];
  readonly synchronizeWorkspace: AgentJourneyEffects["synchronizeWorkspace"];
  readonly attach: AgentJourneyEffects["attach"];
  readonly authorizeMachineCreate: (input: {
    readonly requestedAgent: "claude-code" | "codex" | "openclaw";
    readonly signal: AbortSignal;
  }) => Promise<boolean>;
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
          agent: machine.agent === "claude-code" || machine.agent === "codex" || machine.agent === "openclaw"
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
    async createMachine({ requestedAgent, idempotencyKey, requestId, signal }) {
      await requireCapability({ client: input.client, scope: "account", capabilityId: "machines.create", now: now(), signal });
      if (!await input.authorizeMachineCreate({ requestedAgent, signal })) {
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
        const uncertain =
          error instanceof CunaError &&
          (error.code === "cuna.network.timeout" || error.code === "cuna.network.failed");
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
      for (let attempt = 0; attempt < CHILD_POLL_LIMIT; attempt += 1) {
        const session = await input.client.getAgentSession(agentSessionId, signal);
        if (session.processState === "ready" || session.processState === "running") {
          return Object.freeze({ id: session.id, machineId: session.machineId });
        }
        if (["exited", "failed", "terminated"].includes(session.processState)) {
          throw fail("cuna.journey.agent_session_failed", "The AgentSession reached a terminal state before attach.");
        }
        await sleep(Math.min(2_000, 100 * 2 ** Math.min(attempt, 4)), signal);
      }
      throw fail("cuna.journey.agent_session_ready_timeout", "AgentSession readiness remained unproven.", EXIT_CODES.network);
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
      if (ledger.createdMachineId === undefined) {
        try {
          let request = await input.client.getMachineCreateRequest(ledger.machineCreateRequestId, signal);
          if (request.state === "unknown" || request.action === "reconcile") {
            request = await input.client.reconcileMachineCreateRequest(ledger.machineCreateRequestId, signal);
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
