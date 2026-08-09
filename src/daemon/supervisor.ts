export type SupervisedProcessState =
  | "starting"
  | "ready"
  | "running"
  | "terminating"
  | "exited"
  | "failed"
  | "terminated";

export interface ProcessIdentity {
  readonly agentSessionId: string;
  readonly processEpoch: string;
}

export interface ProcessSnapshot extends ProcessIdentity {
  readonly state: SupervisedProcessState;
  readonly operatingSystemPid?: number;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly exitCode?: number;
  readonly failureReason?: string;
}

export class SupervisorError extends Error {
  readonly code: "duplicate_process" | "unknown_process" | "invalid_transition" | "identity_mismatch";

  constructor(code: SupervisorError["code"], message: string) {
    super(message);
    this.name = "SupervisorError";
    this.code = code;
  }
}

const TRANSITIONS: Readonly<Record<SupervisedProcessState, ReadonlySet<SupervisedProcessState>>> = Object.freeze({
  starting: new Set<SupervisedProcessState>(["ready", "failed", "terminating"]),
  ready: new Set<SupervisedProcessState>(["running", "terminating", "exited", "failed"]),
  running: new Set<SupervisedProcessState>(["terminating", "exited", "failed"]),
  terminating: new Set<SupervisedProcessState>(["terminated", "failed"]),
  exited: new Set<SupervisedProcessState>(),
  failed: new Set<SupervisedProcessState>(),
  terminated: new Set<SupervisedProcessState>(),
});

export class ProcessSupervisorModel {
  readonly #processes = new Map<string, ProcessSnapshot>();

  register(identity: ProcessIdentity, now: number, operatingSystemPid?: number): ProcessSnapshot {
    assertIdentity(identity);
    const current = this.#processes.get(identity.agentSessionId);
    if (current !== undefined && !isTerminal(current.state)) {
      throw new SupervisorError("duplicate_process", "An active process already exists for this AgentSession.");
    }
    const next = freezeSnapshot({
      ...identity,
      state: "starting",
      ...(operatingSystemPid === undefined ? {} : { operatingSystemPid }),
      startedAt: now,
      updatedAt: now,
    });
    this.#processes.set(identity.agentSessionId, next);
    return next;
  }

  transition(
    identity: ProcessIdentity,
    nextState: SupervisedProcessState,
    now: number,
    details: { readonly exitCode?: number; readonly failureReason?: string } = {},
  ): ProcessSnapshot {
    const current = this.require(identity);
    if (current.state === nextState) return current;
    if (!TRANSITIONS[current.state].has(nextState)) {
      throw new SupervisorError("invalid_transition", `Process cannot transition from ${current.state} to ${nextState}.`);
    }
    if ((nextState === "exited" || nextState === "terminated") && details.failureReason !== undefined) {
      throw new SupervisorError("invalid_transition", "A successful terminal state cannot carry a failure reason.");
    }
    if (nextState === "failed" && (details.failureReason === undefined || details.failureReason.length === 0)) {
      throw new SupervisorError("invalid_transition", "A failed process requires a safe reason class.");
    }
    const next = freezeSnapshot({
      ...current,
      state: nextState,
      updatedAt: now,
      ...(details.exitCode === undefined ? {} : { exitCode: details.exitCode }),
      ...(details.failureReason === undefined ? {} : { failureReason: details.failureReason }),
    });
    this.#processes.set(identity.agentSessionId, next);
    return next;
  }

  require(identity: ProcessIdentity): ProcessSnapshot {
    const current = this.#processes.get(identity.agentSessionId);
    if (current === undefined) throw new SupervisorError("unknown_process", "The AgentSession process is not supervised.");
    // A PID may be reused. Epoch equality, not PID equality, proves continuity.
    if (current.processEpoch !== identity.processEpoch) {
      throw new SupervisorError("identity_mismatch", "The process epoch does not match the supervised generation.");
    }
    return current;
  }

  list(): readonly ProcessSnapshot[] {
    return Object.freeze([...this.#processes.values()]);
  }
}

export function isTerminal(state: SupervisedProcessState): boolean {
  return state === "exited" || state === "failed" || state === "terminated";
}

function assertIdentity(identity: ProcessIdentity): void {
  if (
    identity.agentSessionId.length === 0 ||
    identity.agentSessionId.length > 256 ||
    identity.processEpoch.length === 0 ||
    identity.processEpoch.length > 256
  ) {
    throw new SupervisorError("identity_mismatch", "The process identity is invalid.");
  }
}

function freezeSnapshot(snapshot: ProcessSnapshot): ProcessSnapshot {
  return Object.freeze(snapshot);
}
