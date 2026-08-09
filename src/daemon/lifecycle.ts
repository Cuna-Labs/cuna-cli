export type DaemonLifecycleState =
  | "absent"
  | "starting"
  | "ready"
  | "quiescing"
  | "degraded"
  | "reconciling"
  | "recovery_required"
  | "stopped";

const TRANSITIONS: Readonly<Record<DaemonLifecycleState, ReadonlySet<DaemonLifecycleState>>> = Object.freeze({
  absent: new Set<DaemonLifecycleState>(["starting"]),
  starting: new Set<DaemonLifecycleState>(["ready", "recovery_required", "stopped"]),
  ready: new Set<DaemonLifecycleState>(["quiescing", "degraded"]),
  quiescing: new Set<DaemonLifecycleState>(["ready", "stopped", "recovery_required"]),
  degraded: new Set<DaemonLifecycleState>(["reconciling", "quiescing", "recovery_required"]),
  reconciling: new Set<DaemonLifecycleState>(["ready", "recovery_required", "quiescing"]),
  recovery_required: new Set<DaemonLifecycleState>(["ready", "stopped"]),
  stopped: new Set<DaemonLifecycleState>(["starting"]),
});

export interface DaemonLifecycleSnapshot {
  readonly state: DaemonLifecycleState;
  readonly revision: number;
  readonly observedAt: number;
  readonly reason: string;
}

export class DaemonLifecycle {
  #snapshot: DaemonLifecycleSnapshot;

  constructor(now: number) {
    this.#snapshot = Object.freeze({ state: "absent", revision: 0, observedAt: now, reason: "not_started" });
  }

  snapshot(): DaemonLifecycleSnapshot {
    return this.#snapshot;
  }

  transition(state: DaemonLifecycleState, reason: string, now: number): DaemonLifecycleSnapshot {
    if (!TRANSITIONS[this.#snapshot.state].has(state)) {
      throw new Error(`Illegal daemon lifecycle transition: ${this.#snapshot.state} -> ${state}`);
    }
    if (reason.length === 0 || reason.length > 128) throw new Error("A bounded safe daemon lifecycle reason is required.");
    this.#snapshot = Object.freeze({ state, revision: this.#snapshot.revision + 1, observedAt: now, reason });
    return this.#snapshot;
  }
}
