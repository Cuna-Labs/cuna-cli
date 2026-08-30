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
    // OpenCode v1.18.23 owns provider selection and authentication inside its
    // TUI (`/connect`, then `/models`). It has no Cuna console-device handoff,
    // so the foreground must not advertise or execute a local auth action for
    // it. Keeping the provider enabled here preserves direct terminal attach.
    authTopologies: Object.freeze(["provider_defined"] satisfies ProviderAuthTopology[]),
    allowedActions: Object.freeze([] satisfies LocalActionKind[]),
    remoteAdapter: "mcp_stdio",
  }),
});

export function providerAllowsLocalAction(provider: LocalActionProvider, kind: LocalActionKind): boolean {
  const descriptor = (LOCAL_ACTION_PROVIDERS as Readonly<Record<string, LocalActionProviderDescriptor | undefined>>)[provider];
  return descriptor !== undefined && descriptor.enabled && descriptor.allowedActions.includes(kind);
}
