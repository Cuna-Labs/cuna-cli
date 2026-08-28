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
  options: Readonly<{ readonly hasSessions?: boolean; readonly canCreateSession?: boolean }> = {},
): readonly MachineContextAction[] {
  const provider = machineProviderAvailability(machine);
  if (machine.state === "stopped" || machine.state === "paused") {
    return Object.freeze([Object.freeze({ kind: "start", label: "Start", machineId: machine.id })]);
  }
  if (machine.state !== "running") return Object.freeze([]);
  return Object.freeze([
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
  return input.safeContinuationCount === 1 && !input.cancelled && input.now - input.screenShownAt >= 3_000;
}
