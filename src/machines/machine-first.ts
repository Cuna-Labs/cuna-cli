import type { AgentSession, Machine } from "../api/contracts.js";
import { machineProviderAvailability, type ActionableProvider } from "./provider-availability.js";
import { classifySessionActionability } from "./session-actionability.js";

export type MachineFirstScreen =
  | Readonly<{ readonly kind: "machines" }>
  | Readonly<{ readonly kind: "machine"; readonly machineId: string }>
  | Readonly<{ readonly kind: "provider"; readonly machineId: string; readonly provider: ActionableProvider }>;

export interface MachineFirstNavigationState {
  readonly screen: MachineFirstScreen;
  readonly selectedIndex: number;
  readonly quit: boolean;
}

export type MachineFirstNavigationEvent =
  | Readonly<{ readonly type: "move"; readonly delta: -1 | 1; readonly itemCount: number }>
  | Readonly<{ readonly type: "open-machine"; readonly machineId: string }>
  | Readonly<{ readonly type: "open-provider"; readonly machineId: string; readonly provider: ActionableProvider }>
  | Readonly<{ readonly type: "back" }>
  | Readonly<{ readonly type: "quit" }>;

export type MachineContextAction =
  | Readonly<{ readonly kind: "start"; readonly label: "Start"; readonly machineId: string }>
  | Readonly<{ readonly kind: "stop"; readonly label: "Stop"; readonly machineId: string }>
  /**
   * An informational, non-mutating first action. It exists so a running
   * OpenCode Machine with a supervisor prerequisite does not make `Stop` the
   * default Enter target in the machine menu.
   */
  | Readonly<{ readonly kind: "supervisor-blocked"; readonly label: "OpenCode needs a terminal update"; readonly machineId: string }>
  /** Available only after the current Machine observation is stopped. */
  | Readonly<{ readonly kind: "update-supervisor"; readonly label: "Update terminal supervisor"; readonly machineId: string }>
  | Readonly<{ readonly kind: "provider"; readonly label: string; readonly machineId: string; readonly provider: ActionableProvider }>
  | Readonly<{ readonly kind: "new-session"; readonly label: string; readonly machineId: string; readonly provider: ActionableProvider }>;

export type ProviderContextAction =
  Readonly<{ readonly kind: "session"; readonly label: string; readonly session: AgentSession }>;

export const INITIAL_MACHINE_FIRST_STATE: MachineFirstNavigationState = Object.freeze({
  screen: Object.freeze({ kind: "machines" }),
  selectedIndex: 0,
  quit: false,
});

export function reduceMachineFirstNavigation(
  state: MachineFirstNavigationState,
  event: MachineFirstNavigationEvent,
): MachineFirstNavigationState {
  switch (event.type) {
    case "move":
      return Object.freeze({
        ...state,
        selectedIndex: Math.min(Math.max(0, event.itemCount - 1), Math.max(0, state.selectedIndex + event.delta)),
      });
    case "open-machine":
      return Object.freeze({ screen: Object.freeze({ kind: "machine", machineId: event.machineId }), selectedIndex: 0, quit: false });
    case "open-provider":
      return Object.freeze({
        screen: Object.freeze({ kind: "provider", machineId: event.machineId, provider: event.provider }),
        selectedIndex: 0,
        quit: false,
      });
    case "back":
      if (state.screen.kind === "provider") {
        return Object.freeze({ screen: Object.freeze({ kind: "machine", machineId: state.screen.machineId }), selectedIndex: 0, quit: false });
      }
      if (state.screen.kind === "machine") return INITIAL_MACHINE_FIRST_STATE;
      return state;
    case "quit": return Object.freeze({ ...state, quit: true });
  }
}

export function resolveMachineContextActions(
  machine: Machine,
  options: Readonly<{
    readonly hasSessions?: boolean;
    readonly canCreateSession?: boolean;
    /** Exact, current server evidence—not a local provider guess. */
    readonly opencodeSupervisorRepairRequired?: boolean;
  }> = {},
): readonly MachineContextAction[] {
  const provider = machineProviderAvailability(machine);
  if (machine.state === "stopped") {
    return Object.freeze([
      ...(options.opencodeSupervisorRepairRequired === true
        ? [Object.freeze({ kind: "update-supervisor" as const, label: "Update terminal supervisor" as const, machineId: machine.id })]
        : []),
      Object.freeze({ kind: "start", label: "Start", machineId: machine.id }),
    ]);
  }
  if (machine.state === "paused") {
    return Object.freeze([
      ...(options.opencodeSupervisorRepairRequired === true
        ? [Object.freeze({ kind: "supervisor-blocked" as const, label: "OpenCode needs a terminal update" as const, machineId: machine.id })]
        : []),
      Object.freeze({ kind: "start", label: "Start", machineId: machine.id }),
    ]);
  }
  if (machine.state !== "running") return Object.freeze([]);
  return Object.freeze([
    ...(options.opencodeSupervisorRepairRequired === true
      ? [Object.freeze({ kind: "supervisor-blocked" as const, label: "OpenCode needs a terminal update" as const, machineId: machine.id })]
      : []),
    ...(provider.actionable && provider.agent !== undefined && options.hasSessions !== false
      ? [Object.freeze({
          kind: "provider" as const,
          label: provider.displayName,
          machineId: machine.id,
          provider: provider.agent as ActionableProvider,
        })]
      : []),
    ...(provider.actionable && provider.agent !== undefined && options.canCreateSession === true
      ? [Object.freeze({
          kind: "new-session" as const,
          label: `New ${provider.displayName} session`,
          machineId: machine.id,
          provider: provider.agent as ActionableProvider,
        })]
      : []),
    Object.freeze({ kind: "stop" as const, label: "Stop" as const, machineId: machine.id }),
  ]);
}

export function resolveProviderContextActions(input: Readonly<{
  readonly machine: Machine;
  readonly provider: ActionableProvider;
  readonly sessions: readonly AgentSession[];
  readonly now: number;
}>): readonly ProviderContextAction[] {
  const availability = machineProviderAvailability(input.machine);
  if (input.machine.state !== "running" || !availability.actionable || availability.agent !== input.provider) return Object.freeze([]);
  const sessions = input.sessions
    .filter((session) => session.agent === input.provider)
    .filter((session) => classifySessionActionability({ session, machine: input.machine, now: input.now }).recoveryAction !== "none")
    .map((session) => Object.freeze({ kind: "session" as const, label: session.name, session }));
  return Object.freeze(sessions);
}

export function shouldShowRemoteWaitProgress(elapsedMs: number): boolean {
  return elapsedMs >= 100;
}

export function canAutoContinueMachineFirst(input: Readonly<{
  readonly safeContinuationCount: number;
  readonly screenShownAt: number;
  readonly now: number;
  readonly cancelled: boolean;
}>): boolean {
  // Deliberately retain the public helper as a fail-closed compatibility seam,
  // but never use uniqueness or elapsed time as consent to attach a remote
  // AgentSession.  A person must select the exact session in its provider
  // context.  Keeping this false also prevents a future caller from reviving
  // the former three-second auto-continue behaviour by accident.
  void input;
  return false;
}
