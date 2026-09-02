import type { CunaApiClient } from "../api/client.js";
import type { ForegroundTerminalHost } from "../terminal/foreground.js";
import { runNodeMachinesExplorer } from "../machines/explorer.js";
import type { ActionableProvider } from "../machines/provider-availability.js";

export type RootJourneySelection =
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

export function rootJourneyArgv(
  selection: Extract<RootJourneySelection, { readonly kind: "launch" }>,
  options: Readonly<{ readonly noColor?: boolean }> = {},
): readonly string[] {
  const command = selection.agent === "claude-code"
    ? "claude"
    : selection.agent === "codex"
      ? "codex"
      : "opencode";
  return Object.freeze([
    command,
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
