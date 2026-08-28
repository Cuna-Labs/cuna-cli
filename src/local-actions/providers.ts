import type { LocalActionKind, LocalActionProvider } from "./contracts.js";

export type ProviderAuthTopology = "browser_paste_code" | "device_code" | "loopback_callback" | "provider_defined";

export interface LocalActionProviderDescriptor {
  readonly provider: LocalActionProvider;
  readonly enabled: boolean;
  readonly authTopologies: readonly ProviderAuthTopology[];
  readonly allowedActions: readonly LocalActionKind[];
  readonly remoteAdapter: "mcp_stdio";
}

const COMMON_ACTIONS: readonly LocalActionKind[] = Object.freeze([
  "browser.open", "clipboard.write", "file.select", "attachment.import", "artifact.save",
  "port.forward", "preview.open", "diff.open", "editor.open", "notification.show",
  "git.sign", "local_service.request", "device.select",
]);

export const LOCAL_ACTION_PROVIDERS: Readonly<Record<LocalActionProvider, LocalActionProviderDescriptor>> = Object.freeze({
  "claude-code": Object.freeze({
    provider: "claude-code",
    enabled: true,
    authTopologies: Object.freeze(["browser_paste_code"] satisfies ProviderAuthTopology[]),
    allowedActions: Object.freeze([...COMMON_ACTIONS, "auth.result.observe"] satisfies LocalActionKind[]),
    remoteAdapter: "mcp_stdio",
  }),
  codex: Object.freeze({
    provider: "codex",
    enabled: true,
    authTopologies: Object.freeze(["device_code", "loopback_callback"] satisfies ProviderAuthTopology[]),
    allowedActions: Object.freeze([
      ...COMMON_ACTIONS,
      "auth.device.present",
      "auth.callback.relay",
      "auth.result.observe",
    ] satisfies LocalActionKind[]),
    remoteAdapter: "mcp_stdio",
  }),
  opencode: Object.freeze({
    provider: "opencode",
    enabled: true,
    authTopologies: Object.freeze(["provider_defined"] satisfies ProviderAuthTopology[]),
    // OpenCode can front many model providers, so arbitrary browser URLs are
    // never inferred from PTY text. Typed callback relay and observed auth are
    // admitted; the remaining common actions retain their ordinary policy.
    allowedActions: Object.freeze([
      ...COMMON_ACTIONS.filter((kind) => kind !== "browser.open"),
      "auth.callback.relay",
      "auth.result.observe",
    ] satisfies LocalActionKind[]),
    remoteAdapter: "mcp_stdio",
  }),
});

export function providerAllowsLocalAction(provider: LocalActionProvider, kind: LocalActionKind): boolean {
  const descriptor = (LOCAL_ACTION_PROVIDERS as Readonly<Record<string, LocalActionProviderDescriptor | undefined>>)[provider];
  return descriptor !== undefined && descriptor.enabled && descriptor.allowedActions.includes(kind);
}
