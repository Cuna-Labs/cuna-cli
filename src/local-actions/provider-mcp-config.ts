import { LOCAL_ACTION_PROTOCOL_VERSION, type LocalActionProvider } from "./contracts.js";

export const CUNA_AGENT_SESSION_MCP_SERVER = "cuna_local_actions" as const;
export const CUNA_AGENT_SESSION_MCP_COMMAND = "cuna-agent-session-mcp" as const;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const UNIX_SOCKET = /^\/(?:[^/]+\/)*[^/]+$/u;

export interface RemoteMcpSessionBinding {
  readonly agentSessionId: string;
  readonly processEpoch: string;
  readonly attachmentGeneration: number;
  /**
   * Private, per-AgentSession Unix socket inside the remote VM. The local CLI
   * never opens this path and the provider never receives a network endpoint.
   */
  readonly privateSocketPath: string;
  /**
   * Opaque, non-exportable reference understood only by the supervisor. This
   * is not an access token or provider credential.
   */
  readonly capabilityReference: string;
}

export interface EphemeralMcpConfigTarget {
  /** Provider-visible path owned by the current AgentSession runtime. */
  readonly path: string;
  readonly exclusiveCreate: true;
  readonly mode: 0o600;
  readonly lifetime: "provider_process";
}

export interface EphemeralMcpCleanupContract {
  readonly required: true;
  readonly triggers: readonly ["provider_exit", "attach_cancelled", "identity_changed"];
  readonly targets: readonly string[];
  readonly completion: "absence_verified";
}

interface McpStdioServerConfiguration {
  readonly command: typeof CUNA_AGENT_SESSION_MCP_COMMAND;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface ClaudeMcpLaunchPlan {
  readonly provider: "claude-code";
  readonly enabled: true;
  readonly format: "claude_mcp_json";
  readonly config: Readonly<{
    mcpServers: Readonly<Record<typeof CUNA_AGENT_SESSION_MCP_SERVER, Readonly<McpStdioServerConfiguration & { readonly type: "stdio" }>>>;
  }>;
  readonly serializedConfig: string;
  readonly argvSuffix: readonly ["--mcp-config", string, "--strict-mcp-config"];
  readonly target: EphemeralMcpConfigTarget;
  readonly cleanup: EphemeralMcpCleanupContract;
}

export interface CodexMcpLaunchPlan {
  readonly provider: "codex";
  readonly enabled: true;
  readonly format: "codex_toml_overlay";
  readonly config: Readonly<{
    mcp_servers: Readonly<Record<typeof CUNA_AGENT_SESSION_MCP_SERVER, Readonly<McpStdioServerConfiguration & {
      readonly enabled: true;
      readonly startup_timeout_sec: 10;
      readonly tool_timeout_sec: 300;
    }>>>;
  }>;
  readonly serializedConfig: string;
  /** Repeatable Codex `-c key=value` overlays; no global config is mutated. */
  readonly argvSuffix: readonly string[];
  readonly target: EphemeralMcpConfigTarget;
  readonly cleanup: EphemeralMcpCleanupContract;
}

export interface OpenCodeMcpLaunchPlan {
  readonly provider: "opencode";
  readonly enabled: true;
  readonly format: "opencode_local_mcp";
  readonly config: Readonly<{
    readonly $schema: "https://opencode.ai/config.json";
    readonly mcp: Readonly<Record<typeof CUNA_AGENT_SESSION_MCP_SERVER, Readonly<{
      readonly type: "local";
      readonly command: readonly string[];
      readonly enabled: true;
      readonly environment: Readonly<Record<string, string>>;
    }>>>;
  }>;
  readonly serializedConfig: string;
  readonly argvSuffix: readonly [];
  /** OpenCode loads the process-scoped overlay from this exact file. */
  readonly environment: Readonly<{ readonly OPENCODE_CONFIG: string }>;
  readonly target: EphemeralMcpConfigTarget;
  readonly cleanup: EphemeralMcpCleanupContract;
}

export type ProviderMcpLaunchPlan = ClaudeMcpLaunchPlan | CodexMcpLaunchPlan | OpenCodeMcpLaunchPlan;

export class ProviderMcpConfigurationError extends Error {
  override readonly name = "ProviderMcpConfigurationError";
}

function assertOpaqueIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new ProviderMcpConfigurationError(`${label} must be an opaque identifier without whitespace or control characters.`);
  }
}

function validateBinding(binding: RemoteMcpSessionBinding): void {
  assertOpaqueIdentifier(binding.agentSessionId, "agentSessionId");
  assertOpaqueIdentifier(binding.processEpoch, "processEpoch");
  assertOpaqueIdentifier(binding.capabilityReference, "capabilityReference");
  if (!Number.isSafeInteger(binding.attachmentGeneration) || binding.attachmentGeneration < 0) {
    throw new ProviderMcpConfigurationError("attachmentGeneration must be a non-negative safe integer.");
  }
  if (
    binding.privateSocketPath.length > 512 ||
    hasControlCharacters(binding.privateSocketPath) ||
    !UNIX_SOCKET.test(binding.privateSocketPath)
  ) {
    throw new ProviderMcpConfigurationError("privateSocketPath must be an absolute Unix socket path without control characters.");
  }
}

function validateTarget(target: EphemeralMcpConfigTarget): void {
  if (
    target.path.length === 0 ||
    target.path.length > 1_024 ||
    hasControlCharacters(target.path)
  ) {
    throw new ProviderMcpConfigurationError("The ephemeral MCP config path is invalid.");
  }
  if (target.exclusiveCreate !== true || target.mode !== 0o600 || target.lifetime !== "provider_process") {
    throw new ProviderMcpConfigurationError("The MCP config target must be exclusive, mode 0600, and provider-process scoped.");
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 31 || point === 127;
  });
}

function remoteServer(binding: RemoteMcpSessionBinding): Readonly<McpStdioServerConfiguration> {
  validateBinding(binding);
  return Object.freeze({
    command: CUNA_AGENT_SESSION_MCP_COMMAND,
    args: Object.freeze([
      "--transport", "unix",
      "--socket", binding.privateSocketPath,
      "--agent-session", binding.agentSessionId,
      "--process-epoch", binding.processEpoch,
      "--attachment-generation", String(binding.attachmentGeneration),
      "--capability-ref", binding.capabilityReference,
    ]),
    env: Object.freeze({ CUNA_LOCAL_ACTION_PROTOCOL: String(LOCAL_ACTION_PROTOCOL_VERSION) }),
  });
}

function cleanupFor(target: EphemeralMcpConfigTarget): EphemeralMcpCleanupContract {
  return Object.freeze({
    required: true,
    triggers: Object.freeze(["provider_exit", "attach_cancelled", "identity_changed"] as const),
    targets: Object.freeze([target.path]),
    completion: "absence_verified",
  });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

export function buildClaudeMcpLaunchPlan(
  binding: RemoteMcpSessionBinding,
  target: EphemeralMcpConfigTarget,
): ClaudeMcpLaunchPlan {
  validateTarget(target);
  const server = Object.freeze({ ...remoteServer(binding), type: "stdio" as const });
  const config = Object.freeze({
    mcpServers: Object.freeze({ [CUNA_AGENT_SESSION_MCP_SERVER]: server }),
  });
  return Object.freeze({
    provider: "claude-code",
    enabled: true,
    format: "claude_mcp_json",
    config,
    serializedConfig: `${JSON.stringify(config)}\n`,
    argvSuffix: Object.freeze(["--mcp-config", target.path, "--strict-mcp-config"] as const),
    target,
    cleanup: cleanupFor(target),
  });
}

export function buildCodexMcpLaunchPlan(
  binding: RemoteMcpSessionBinding,
  target: EphemeralMcpConfigTarget,
): CodexMcpLaunchPlan {
  validateTarget(target);
  const base = remoteServer(binding);
  const server = Object.freeze({
    ...base,
    enabled: true as const,
    startup_timeout_sec: 10 as const,
    tool_timeout_sec: 300 as const,
  });
  const config = Object.freeze({
    mcp_servers: Object.freeze({ [CUNA_AGENT_SESSION_MCP_SERVER]: server }),
  });
  const section = `[mcp_servers.${CUNA_AGENT_SESSION_MCP_SERVER}]`;
  const env = `{ CUNA_LOCAL_ACTION_PROTOCOL = ${tomlString(String(LOCAL_ACTION_PROTOCOL_VERSION))} }`;
  const serializedConfig = [
    section,
    `command = ${tomlString(server.command)}`,
    `args = ${tomlStringArray(server.args)}`,
    "enabled = true",
    `startup_timeout_sec = ${server.startup_timeout_sec}`,
    `tool_timeout_sec = ${server.tool_timeout_sec}`,
    `env = ${env}`,
    "",
  ].join("\n");
  const argvSuffix = Object.freeze([
    "-c", `mcp_servers.${CUNA_AGENT_SESSION_MCP_SERVER}.command=${tomlString(server.command)}`,
    "-c", `mcp_servers.${CUNA_AGENT_SESSION_MCP_SERVER}.args=${tomlStringArray(server.args)}`,
    "-c", `mcp_servers.${CUNA_AGENT_SESSION_MCP_SERVER}.enabled=true`,
    "-c", `mcp_servers.${CUNA_AGENT_SESSION_MCP_SERVER}.startup_timeout_sec=${server.startup_timeout_sec}`,
    "-c", `mcp_servers.${CUNA_AGENT_SESSION_MCP_SERVER}.tool_timeout_sec=${server.tool_timeout_sec}`,
    "-c", `mcp_servers.${CUNA_AGENT_SESSION_MCP_SERVER}.env=${env}`,
  ]);
  return Object.freeze({
    provider: "codex",
    enabled: true,
    format: "codex_toml_overlay",
    config,
    serializedConfig,
    argvSuffix,
    target,
    cleanup: cleanupFor(target),
  });
}

export function buildOpenCodeMcpLaunchPlan(
  binding: RemoteMcpSessionBinding,
  target: EphemeralMcpConfigTarget,
): OpenCodeMcpLaunchPlan {
  validateTarget(target);
  const base = remoteServer(binding);
  const server = Object.freeze({
    type: "local" as const,
    command: Object.freeze([base.command, ...base.args]),
    enabled: true as const,
    environment: base.env,
  });
  const config = Object.freeze({
    $schema: "https://opencode.ai/config.json" as const,
    mcp: Object.freeze({ [CUNA_AGENT_SESSION_MCP_SERVER]: server }),
  });
  return Object.freeze({
    provider: "opencode",
    enabled: true,
    format: "opencode_local_mcp",
    config,
    serializedConfig: `${JSON.stringify(config)}\n`,
    argvSuffix: Object.freeze([] as const),
    environment: Object.freeze({ OPENCODE_CONFIG: target.path }),
    target,
    cleanup: cleanupFor(target),
  });
}

/** @deprecated Use buildOpenCodeMcpLaunchPlan with an exact fenced binding. */
export const describeOpenCodeMcpContract = buildOpenCodeMcpLaunchPlan;

export function buildProviderMcpLaunchPlan(
  provider: LocalActionProvider,
  binding: RemoteMcpSessionBinding,
  target: EphemeralMcpConfigTarget,
): ProviderMcpLaunchPlan {
  if (provider === "claude-code") return buildClaudeMcpLaunchPlan(binding, target);
  if (provider === "codex") return buildCodexMcpLaunchPlan(binding, target);
  return buildOpenCodeMcpLaunchPlan(binding, target);
}
