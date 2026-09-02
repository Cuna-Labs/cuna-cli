import type { AgentSession, AgentSessionTerminalSeat, Machine } from "../api/contracts.js";
import { decideCapability, requireCapability, type CunaApiClient } from "../api/client.js";
import { EXIT_CODES, CunaError, type ExitCode } from "../core/errors.js";
import { isObservationBudgetCode } from "../core/observation-budget.js";
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

const MACHINE_POLL_LIMIT = 60;
const CHILD_POLL_LIMIT = 90;

export interface ApiAgentJourneyEffectsInput {
  readonly client: CunaApiClient;
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

function sessionObservation(session: AgentSession, seat: SeatAttachment) {
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
  const effects: AgentJourneyEffects = {
    inspectWorkspace: input.inspectWorkspace,
    async observeMachines({ signal }) {
      const page = await input.client.listMachines(signal);
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
    async createMachine({ requestedAgent, idempotencyKey, requestId, signal }) {
      await requireCapability({ client: input.client, scope: "account", capabilityId: "machines.create", now, signal });
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
      return Object.freeze(await Promise.all(page.items.map(async (session) => {
        // Only a session that could be reused is asked for its seat. A
        // terminal or starting one is refused on its process state before the
        // seat would matter, and reading it would only spend a request.
        if (session.processState !== "ready" && session.processState !== "running") {
          return sessionObservation(session, { attachment: "unknown" });
        }
        let seat: AgentSessionTerminalSeat;
        try {
          seat = await input.client.getAgentSessionTerminalSeat(session.id, signal);
        } catch (error) {
          if (isSeatUnserved(error)) return sessionObservation(session, { attachment: "unknown" });
          throw error;
        }
        return sessionObservation(session, attachmentFromSeat(seat, input.clientInstanceId));
      })));
    },
    async createAgentSession({ machineId, agent, authMode, credentialBindingId, workspace, idempotencyKey, signal }) {
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
