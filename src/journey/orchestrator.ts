import { randomUUID } from "node:crypto";

import type { AgentAuthMode, AgentKind } from "../api/contracts.js";
import { EXIT_CODES, CunaError } from "../core/errors.js";
import { deriveMachineCreateIdentity } from "./derived-identity.js";
import type { ReconciledAgentJourneyIntent } from "./intent.js";
import {
  planAgentSessionSelection,
  planMachineSelection,
  type AgentSessionSelectionObservation,
  type MachineSelectionObservation,
} from "./selection.js";

export type AgentJourneyPhase =
  | "inspect-workspace"
  | "observe-machines"
  | "create-machine"
  | "reconcile-machine-create"
  | "ready-machine"
  | "synchronize-workspace"
  | "observe-agent-sessions"
  | "create-agent-session"
  | "ready-agent-session"
  | "attach";

export interface JourneyMachine {
  readonly id: string;
  readonly state: MachineSelectionObservation["state"];
}

export type MachineCreateReconciliation =
  | { readonly kind: "reconciled"; readonly machine: JourneyMachine }
  | { readonly kind: "unreconcilable" };

export interface JourneyWorkspaceReceipt {
  readonly bindingId: string;
  readonly workspaceIdentity: string;
  readonly generation: number;
  readonly remoteCwd: string;
}

export interface JourneyAgentSession {
  readonly id: string;
  readonly machineId: string;
}

/**
 * The account authority one journey runs under.
 *
 * It is required rather than optional because it enters the machine-create
 * request identity, and an absent-means-random fallback would restore the
 * unreconcilable create silently, on exactly the path that has no test.
 */
export interface AgentJourneyScope {
  /** The authenticated principal, from the producer's identity authority. */
  readonly userId: string;
  /** The workspace that principal creates machines inside. */
  readonly workspaceId: string;
}

export interface JourneyResourceLedger {
  readonly idempotencyKey: string;
  /**
   * Present once a machine create has been dispatched, and only then. Before
   * that there is no producer-side request to reconcile, and claiming one made
   * cancellation query a request identity that was never sent.
   */
  readonly machineCreateRequestId?: string;
  readonly createdMachineId?: string;
  readonly createdAgentSessionId?: string;
  readonly synchronizedBindingId?: string;
  readonly lastCompletedPhase?: AgentJourneyPhase;
}

export interface AgentJourneyEffects {
  inspectWorkspace(input: {
    readonly localPath: string;
    readonly syncMode: ReconciledAgentJourneyIntent["syncMode"];
    readonly signal: AbortSignal;
  }): Promise<Readonly<{
    /**
     * The project root, canonicalized by the workspace authority. It is the
     * project half of the machine-create request identity, so it is returned
     * by the layer that already computes it rather than recomputed.
     */
    readonly canonicalLocalRoot: string;
    readonly projectMachineId?: string;
  }>>;
  observeMachines(input: {
    readonly requestedAgent: AgentKind;
    readonly signal: AbortSignal;
  }): Promise<readonly MachineSelectionObservation[]>;
  createMachine(input: {
    readonly requestedAgent: AgentKind;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly signal: AbortSignal;
  }): Promise<JourneyMachine>;
  /**
   * Reconcile a create whose response was not authoritative. `unreconcilable`
   * is a safe terminal result; callers must never retry with another key.
   */
  reconcileMachineCreate(input: {
    readonly requestId: string;
    readonly signal: AbortSignal;
  }): Promise<MachineCreateReconciliation>;
  ensureMachineReady(input: {
    readonly machineId: string;
    readonly observedState: JourneyMachine["state"];
    readonly signal: AbortSignal;
  }): Promise<JourneyMachine>;
  synchronizeWorkspace(input: {
    readonly machineId: string;
    readonly localPath: string;
    readonly syncMode: ReconciledAgentJourneyIntent["syncMode"];
    readonly signal: AbortSignal;
  }): Promise<JourneyWorkspaceReceipt>;
  observeAgentSessions(input: {
    readonly machineId: string;
    readonly signal: AbortSignal;
  }): Promise<readonly AgentSessionSelectionObservation[]>;
  createAgentSession(input: {
    readonly machineId: string;
    readonly agent: AgentKind;
    readonly authMode: AgentAuthMode;
    readonly credentialBindingId?: string;
    readonly workspace: JourneyWorkspaceReceipt;
    readonly idempotencyKey: string;
    readonly signal: AbortSignal;
  }): Promise<JourneyAgentSession>;
  ensureAgentSessionReady(input: {
    readonly agentSessionId: string;
    readonly signal: AbortSignal;
  }): Promise<JourneyAgentSession>;
  attach(input: {
    readonly agentSessionId: string;
    readonly expectedAgent: AgentKind;
    readonly signal: AbortSignal;
  }): Promise<void>;
  reconcileCancellation(input: {
    readonly ledger: JourneyResourceLedger;
    readonly signal: AbortSignal;
  }): Promise<void>;
  onPhase?(phase: AgentJourneyPhase): void;
}

export interface AgentJourneyResult {
  readonly machineId: string;
  readonly agentSessionId: string;
  readonly workspaceBindingId: string;
  readonly workspaceGeneration: number;
}

interface MutableLedger {
  idempotencyKey: string;
  machineCreateRequestId?: string;
  createdMachineId?: string;
  createdAgentSessionId?: string;
  synchronizedBindingId?: string;
  lastCompletedPhase?: AgentJourneyPhase;
}

function frozenLedger(ledger: MutableLedger): JourneyResourceLedger {
  return Object.freeze({
    idempotencyKey: ledger.idempotencyKey,
    ...(ledger.machineCreateRequestId === undefined
      ? {}
      : { machineCreateRequestId: ledger.machineCreateRequestId }),
    ...(ledger.createdMachineId === undefined ? {} : { createdMachineId: ledger.createdMachineId }),
    ...(ledger.createdAgentSessionId === undefined
      ? {}
      : { createdAgentSessionId: ledger.createdAgentSessionId }),
    ...(ledger.synchronizedBindingId === undefined
      ? {}
      : { synchronizedBindingId: ledger.synchronizedBindingId }),
    ...(ledger.lastCompletedPhase === undefined
      ? {}
      : { lastCompletedPhase: ledger.lastCompletedPhase }),
  });
}

function cancelled(): CunaError {
  return new CunaError({
    code: "cuna.journey.cancelled",
    message: "The Cuna journey was cancelled before completion.",
    exitCode: EXIT_CODES.network,
    retryable: true,
    hint: "No cloud resource was assumed deleted. Inspect `cuna machines list` before retrying.",
  });
}

function selectionFailure(
  target: "machine" | "AgentSession",
  plan: Exclude<
    ReturnType<typeof planMachineSelection> | ReturnType<typeof planAgentSessionSelection>,
    { readonly kind: "select" }
  >,
): CunaError {
  const candidates = plan.kind === "ambiguous" ? plan.candidates.map((candidate) => candidate.id) : undefined;
  return new CunaError({
    code: plan.kind === "ambiguous" ? "cuna.journey.ambiguous" : "cuna.journey.authority_unavailable",
    message: plan.kind === "ambiguous"
      ? `More than one exact ${target} candidate remains.`
      : `Cuna could not prove a safe ${target} selection.`,
    exitCode: plan.kind === "ambiguous" ? EXIT_CODES.conflict : EXIT_CODES.policy,
    hint: target === "machine"
      ? "Select an exact machine with --machine NAME."
      : "Select an exact child with --agent-session ID or request --new-session.",
    details: {
      target: target === "machine" ? "machine" : "agent_session",
      reason: plan.reason,
      ...(candidates === undefined ? {} : { candidates }),
    },
  });
}

function unreconcilableCreate(cause: unknown): CunaError {
  return new CunaError({
    code: "cuna.journey.machine_create_outcome_unreconcilable",
    message: "Cuna cannot prove whether the machine-create request committed.",
    exitCode: EXIT_CODES.remote,
    retryable: false,
    // This hint used to read "the producer must expose the create request
    // identity". It already did; the client was throwing the key away by
    // minting it from randomness. The identity is now derived from the
    // invocation, so repeating the SAME command is the recovery: it re-derives
    // the same request identity and reconciles instead of creating a sibling.
    hint: "Repeat this exact command to reconcile the same create request. Run `cuna machines list` first if you want to see the outcome before retrying.",
    details: { unproven_outcome: "machine_create_request" },
    cause,
  });
}

function unreconcilableAgentSessionCreate(cause: unknown): CunaError {
  return new CunaError({
    code: "cuna.journey.agent_session_create_outcome_unreconcilable",
    message: "Cuna cannot prove whether the AgentSession create request committed.",
    exitCode: EXIT_CODES.remote,
    retryable: false,
    hint: "Do not request another child with a new key. Retry recovery with the original journey identity.",
    details: { recovery: "exhausted" },
    cause,
  });
}

/**
 * The single authority for a failure raised while handling an earlier failure.
 * The later failure remains the surfaced error; the earlier one is reachable
 * through the standard Error `cause` chain.
 */
function withCause(failure: unknown, cause: unknown): Error {
  const error = failure instanceof Error
    ? failure
    : new Error(`A recovery step threw a non-Error value: ${String(failure)}`);
  Object.defineProperty(error, "cause", {
    configurable: true,
    value: cause,
  });
  return error;
}

function defaultAuthMode(intent: ReconciledAgentJourneyIntent): AgentAuthMode {
  if (intent.authMode !== undefined) return intent.authMode;
  return intent.agent === "openclaw" ? "credential_binding" : "interactive_login";
}

async function boundary<T>(input: {
  readonly phase: AgentJourneyPhase;
  readonly signal: AbortSignal;
  readonly effects: AgentJourneyEffects;
  readonly ledger: MutableLedger;
  readonly action: () => Promise<T>;
}): Promise<T> {
  if (input.signal.aborted) throw cancelled();
  input.effects.onPhase?.(input.phase);
  if (input.signal.aborted) throw cancelled();
  const value = await input.action();
  if (input.signal.aborted) throw cancelled();
  input.ledger.lastCompletedPhase = input.phase;
  return value;
}

/**
 * Executes the automatic CLI journey as a fenced sequence. A later phase can
 * consume only authoritative output returned by its direct predecessor.
 */
export async function orchestrateAgentJourney(input: {
  readonly intent: ReconciledAgentJourneyIntent;
  readonly effects: AgentJourneyEffects;
  readonly scope: AgentJourneyScope;
  readonly signal?: AbortSignal;
  readonly idempotencyKey?: string;
}): Promise<AgentJourneyResult> {
  const controller = input.signal === undefined ? new AbortController() : undefined;
  const signal = input.signal ?? controller?.signal;
  if (signal === undefined) throw new TypeError("Missing journey cancellation authority.");
  const ledger: MutableLedger = {
    // Scoped to this process on purpose. It keys the AgentSession create, whose
    // canonical intent includes the workspace generation the sync is about to
    // advance, so a value derived before that generation exists would replay
    // the wrong child. The machine create, whose canonical intent IS known up
    // front, gets a derived identity instead — see below.
    idempotencyKey: input.idempotencyKey ?? `cuna-journey-${randomUUID()}`,
  };
  try {
    const localPath = input.intent.localPath ?? process.cwd();
    const workspaceInspection = await boundary({
      phase: "inspect-workspace", signal, effects: input.effects, ledger,
      action: () => input.effects.inspectWorkspace({
        localPath,
        syncMode: input.intent.syncMode,
        signal,
      }),
    });
    const machines = await boundary({
      phase: "observe-machines", signal, effects: input.effects, ledger,
      action: () => input.effects.observeMachines({ requestedAgent: input.intent.agent, signal }),
    });
    const machinePlan = planMachineSelection({
      requestedAgent: input.intent.agent,
      forceNew: input.intent.machine.kind === "new",
      ...(input.intent.machine.kind === "exact-name"
        ? { selector: { kind: "name" as const, value: input.intent.machine.name } }
        : {}),
      ...(workspaceInspection.projectMachineId === undefined || input.intent.machine.kind !== "automatic"
        ? {}
        : { projectBinding: { machineId: workspaceInspection.projectMachineId, freshness: "fresh" as const } }),
      collectionFreshness: "fresh",
      machines,
    });

    let machine: JourneyMachine;
    if (machinePlan.kind === "select" && machinePlan.target === "machine") {
      machine = { id: machinePlan.machineId, state: machinePlan.machine.state };
    } else if (machinePlan.kind === "create-required" && machinePlan.target === "machine") {
      // Derived, not minted. A re-run of this exact invocation re-derives this
      // identity and finds its own previous attempt; a random one is lost with
      // the process that held it, and the orphan it leaves behind bills with
      // nothing able to name it.
      const createIdentity = deriveMachineCreateIdentity({
        userId: input.scope.userId,
        workspaceId: input.scope.workspaceId,
        canonicalLocalRoot: workspaceInspection.canonicalLocalRoot,
        agent: input.intent.agent,
        machine: input.intent.machine,
      });
      const requestId = createIdentity.requestId;
      try {
        machine = await boundary({
          phase: "create-machine", signal, effects: input.effects, ledger,
          action: () => {
            // Recorded before dispatch: from here on an interrupted journey has
            // a request identity to reconcile against.
            ledger.machineCreateRequestId = requestId;
            return input.effects.createMachine({
              requestedAgent: input.intent.agent,
              idempotencyKey: createIdentity.idempotencyKey,
              requestId,
              signal,
            });
          },
        });
        ledger.createdMachineId = machine.id;
      } catch (createError) {
        if (signal.aborted) throw createError;
        let reconciliation: MachineCreateReconciliation;
        try {
          reconciliation = await boundary({
            phase: "reconcile-machine-create", signal, effects: input.effects, ledger,
            action: () => input.effects.reconcileMachineCreate({ requestId, signal }),
          });
        } catch (reconcileError) {
          throw withCause(reconcileError, createError);
        }
        if (reconciliation.kind === "unreconcilable") throw unreconcilableCreate(createError);
        machine = reconciliation.machine;
        ledger.createdMachineId = machine.id;
      }
    } else {
      throw selectionFailure("machine", machinePlan);
    }

    machine = await boundary({
      phase: "ready-machine", signal, effects: input.effects, ledger,
      action: () => input.effects.ensureMachineReady({
        machineId: machine.id,
        observedState: machine.state,
        signal,
      }),
    });
    if (machine.state !== "running") {
      throw new CunaError({
        code: "cuna.journey.machine_not_ready",
        message: "The selected machine did not reach authoritative running state.",
        exitCode: EXIT_CODES.remote,
        hint: "Run `cuna machines list` to see its current state, then start it before attaching.",
        details: { machine_id: machine.id, observed_state: machine.state },
      });
    }

    const workspace = await boundary({
      phase: "synchronize-workspace", signal, effects: input.effects, ledger,
      action: () => input.effects.synchronizeWorkspace({
        machineId: machine.id,
        localPath,
        syncMode: input.intent.syncMode,
        signal,
      }),
    });
    ledger.synchronizedBindingId = workspace.bindingId;

    const agentSessions = await boundary({
      phase: "observe-agent-sessions", signal, effects: input.effects, ledger,
      action: () => input.effects.observeAgentSessions({ machineId: machine.id, signal }),
    });
    const authMode = defaultAuthMode(input.intent);
    const sessionPlan = planAgentSessionSelection({
      machineId: machine.id,
      requestedAgent: input.intent.agent,
      workspaceIdentity: workspace.workspaceIdentity,
      workspaceGeneration: workspace.generation,
      cwd: workspace.remoteCwd.replace(/^\/workspace\/?/u, "") || ".",
      authMode,
      forceNewSession: input.intent.newSession || ledger.createdMachineId !== undefined,
      collectionFreshness: "fresh",
      agentSessions,
    });

    let agentSession: JourneyAgentSession;
    if (sessionPlan.kind === "select" && sessionPlan.target === "agent-session") {
      agentSession = { id: sessionPlan.agentSessionId, machineId: sessionPlan.machineId };
    } else if (sessionPlan.kind === "create-required" && sessionPlan.target === "agent-session") {
      try {
        agentSession = await boundary({
          phase: "create-agent-session", signal, effects: input.effects, ledger,
          action: () => input.effects.createAgentSession({
            machineId: machine.id,
            agent: input.intent.agent,
            authMode,
            ...(input.intent.credentialBindingId === undefined
              ? {}
              : { credentialBindingId: input.intent.credentialBindingId }),
            workspace,
            idempotencyKey: `${ledger.idempotencyKey}-agent`,
            signal,
          }),
        });
      } catch (createError) {
        if (signal.aborted) throw createError;
        throw unreconcilableAgentSessionCreate(createError);
      }
      ledger.createdAgentSessionId = agentSession.id;
    } else {
      throw selectionFailure("AgentSession", sessionPlan);
    }

    agentSession = await boundary({
      phase: "ready-agent-session", signal, effects: input.effects, ledger,
      action: () => input.effects.ensureAgentSessionReady({ agentSessionId: agentSession.id, signal }),
    });
    await boundary({
      phase: "attach", signal, effects: input.effects, ledger,
      action: () => input.effects.attach({
        agentSessionId: agentSession.id,
        expectedAgent: input.intent.agent,
        signal,
      }),
    });
    return Object.freeze({
      machineId: machine.id,
      agentSessionId: agentSession.id,
      workspaceBindingId: workspace.bindingId,
      workspaceGeneration: workspace.generation,
    });
  } catch (error) {
    if (signal.aborted || (error instanceof CunaError && error.code === "cuna.journey.cancelled")) {
      const cleanupSignal = AbortSignal.timeout(5_000);
      try {
        await input.effects.reconcileCancellation({ ledger: frozenLedger(ledger), signal: cleanupSignal });
      } catch {
        // Cancellation reconciliation is advisory evidence only. Its failure
        // must not turn an unproven cloud outcome into successful cleanup.
      }
      throw cancelled();
    }
    throw error;
  }
}
