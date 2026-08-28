import type { AgentKind, Machine } from "../api/contracts.js";

export type ActionableProvider = "claude-code" | "codex" | "opencode";
export type ProviderUsability = "declared-installed" | "unavailable";

export interface MachineProviderAvailability {
  readonly machineId: string;
  readonly declaredId?: string;
  readonly agent?: AgentKind;
  readonly displayName: string;
  readonly usability: ProviderUsability;
  readonly actionable: boolean;
  readonly reasonCode?: "provider_not_observed" | "provider_not_supported_by_cli" | "provider_not_publicly_supported";
  readonly observationVersion?: string;
}

const DISPLAY_NAMES: Readonly<Record<AgentKind, string>> = Object.freeze({
  "claude-code": "Claude",
  codex: "Codex",
  openclaw: "OpenClaw",
  opencode: "OpenCode",
});

/**
 * Until the producer exposes an observed installed-provider collection,
 * `machine.agent` is the sole provider inventory. Never infer a different
 * provider from sessions, capabilities, or a display fallback.
 */
export function machineProviderAvailability(machine: Pick<Machine, "id" | "agent" | "updatedAt">): MachineProviderAvailability {
  const declaredId = machine.agent?.trim();
  const agent = normalizeKnownProvider(declaredId);
  if (agent === undefined) {
    return Object.freeze({
      machineId: machine.id,
      ...(declaredId === undefined || declaredId.length === 0 ? {} : { declaredId }),
      displayName: declaredId === undefined || declaredId.length === 0 ? "Unknown" : `Unknown (${declaredId})`,
      usability: declaredId === undefined || declaredId.length === 0 ? "unavailable" : "declared-installed",
      actionable: false,
      reasonCode: declaredId === undefined || declaredId.length === 0
        ? "provider_not_observed"
        : "provider_not_supported_by_cli",
      ...(machine.updatedAt === undefined ? {} : { observationVersion: machine.updatedAt }),
    });
  }
  const actionable = agent === "claude-code" || agent === "codex" || agent === "opencode";
  return Object.freeze({
    machineId: machine.id,
    declaredId: declaredId!,
    agent,
    displayName: DISPLAY_NAMES[agent],
    usability: actionable ? "declared-installed" : "unavailable",
    actionable,
    ...(actionable ? {} : { reasonCode: "provider_not_publicly_supported" as const }),
    ...(machine.updatedAt === undefined ? {} : { observationVersion: machine.updatedAt }),
  });
}

export function providerDisplayName(provider: string): string {
  const normalized = normalizeKnownProvider(provider);
  return normalized === undefined ? `Unknown (${provider})` : DISPLAY_NAMES[normalized];
}

export function providerAuthLabel(provider: string): string {
  return `${providerDisplayName(provider)} auth`;
}

export function machineSupportsProvider(
  machine: Pick<Machine, "id" | "agent" | "updatedAt">,
  requested: AgentKind,
): boolean {
  const availability = machineProviderAvailability(machine);
  return availability.actionable && availability.agent === requested;
}

function normalizeKnownProvider(provider: string | undefined): AgentKind | undefined {
  if (provider === "claude") return "claude-code";
  if (provider === "claude-code" || provider === "codex" || provider === "openclaw" || provider === "opencode") {
    return provider;
  }
  return undefined;
}
