import type { CunaApiClient } from "../api/client.js";
import type { ForegroundTerminalHost } from "../terminal/foreground.js";
import { runNodeMachinesExplorer } from "../machines/explorer.js";
import type { ActionableProvider } from "../machines/provider-availability.js";

export type RootJourneySelection =
  | Readonly<{ readonly kind: "provider-check"; readonly agentSessionId: string }>
  | Readonly<{ readonly kind: "executions"; readonly machineId: string }>
  | Readonly<{ readonly kind: "workspaces"; readonly machineId: string }>
  | Readonly<{ readonly kind: "attach"; readonly agentSessionId: string; readonly agent: ActionableProvider }>
  | Readonly<{ readonly kind: "launch"; readonly agent: ActionableProvider; readonly machineId?: string; readonly machineName?: string; readonly newSession?: boolean }>
  | Readonly<{ readonly kind: "lifecycle"; readonly action: "start" | "stop"; readonly machineId: string }>
  /** PRD-PM-008 E13-R1: provider and name chosen on the screen; `machines create` does the rest. */
  | Readonly<{ readonly kind: "create"; readonly agent: ActionableProvider; readonly name: string }>
  | Readonly<{ readonly kind: "supervisor-update"; readonly machineId: string }>;

export interface RootJourneyInput {
  readonly client: CunaApiClient;
  readonly signal?: AbortSignal;
  readonly color?: boolean;
  /** Clears any caller-owned progress UI immediately before alternate-screen ownership. */
  readonly onBeforeTerminalOwnership?: () => void;
}

export interface RootJourneyDependencies {
  readonly host?: ForegroundTerminalHost;
  readonly now?: () => number;
}

export type RootJourneyRunner = (
  input: RootJourneyInput,
  dependencies?: RootJourneyDependencies,
) => Promise<RootJourneySelection | undefined>;

/**
 * The CLI command that launches one agent.
 *
 * ONE MAPPING, BECAUSE TWO NAMES FOR ONE THING IS HOW IT BROKE. `codex` and
 * `opencode` are spelled the same as their command; `claude-code` is not, and
 * it is the agent identifier everywhere else in the journey. `cli/run.ts`
 * re-invokes itself after a remote-only launch to attach, and it passed the
 * agent straight through — so the Claude Code arm of that path ended with
 * `Unknown command claude-code` (exit 2) immediately after creating the
 * AgentSession, while the two agents whose names happen to coincide worked.
 * Found 2026-09-22 by `test/recorded-launch-driver.test.mjs`, which is the
 * first test to drive that re-invocation; the defect predates the
 * responsiveness work.
 */
export function agentJourneyCommand(agent: ActionableProvider): string {
  return agent === "claude-code" ? "claude" : agent === "codex" ? "codex" : "opencode";
}

export function rootJourneyArgv(
  selection: Extract<RootJourneySelection, { readonly kind: "launch" }>,
  options: Readonly<{ readonly noColor?: boolean }> = {},
): readonly string[] {
  return Object.freeze([
    agentJourneyCommand(selection.agent),
    ...(selection.machineName === undefined ? [] : ["--machine", selection.machineName]),
    ...(selection.newSession === true ? ["--new-session"] : []),
    ...(options.noColor === true ? ["--no-color"] : []),
  ]);
}

/** Bare `cuna` and `cuna machines` intentionally share one reducer and runner. */
export async function runNodeRootJourney(
  input: RootJourneyInput,
  dependencies: RootJourneyDependencies = {},
): Promise<RootJourneySelection | undefined> {
  return await runNodeMachinesExplorer(input, dependencies);
}
