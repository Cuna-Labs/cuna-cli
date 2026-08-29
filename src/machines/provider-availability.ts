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

/**
 * The provider verdict a person acts on, not the declaration they cannot act on.
 *
 * `usability` and `actionable` are independent by construction above: a machine
 * declaring a provider this CLI cannot drive comes back
 * `usability: "declared-installed"` WITH `actionable: false` and a reason code.
 * The human renderings printed the first field alone, so
 * `Unknown (foo) declared-installed` read as installed and usable on exactly
 * the machines where `agent-sessions create` fails closed with
 * `cuna.agent.provider_not_installed`. One word decides whether the next
 * command can run, so that is the word; the reason follows only when the
 * answer is no.
 *
 * It lives here, beside the two fields it reconciles, so that every surface
 * reaches one verdict instead of deriving its own. `machines` and
 * `machines list` use it; the TUI explorer at `explorer.ts` still prints raw
 * `usability` and carries the same defect until it adopts this.
 */
export function providerVerdict(provider: MachineProviderAvailability): string {
  return provider.actionable
    ? "ready"
    : `unusable — ${provider.reasonCode ?? "provider_unusable"}`;
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
