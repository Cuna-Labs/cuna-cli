import assert from "node:assert/strict";
import test from "node:test";

import {
  CUNA_AGENT_SESSION_MCP_COMMAND,
  CUNA_AGENT_SESSION_MCP_SERVER,
  ProviderMcpConfigurationError,
  buildClaudeMcpLaunchPlan,
  buildCodexMcpLaunchPlan,
  buildOpenCodeMcpLaunchPlan,
  buildProviderMcpLaunchPlan,
} from "../dist/local-actions/provider-mcp-config.js";

const binding = Object.freeze({
  agentSessionId: "300a55d0-661c-4da0-9b93-eb41a3a319f6",
  processEpoch: "8f4ac7a4-d814-4997-8207-2df00d8f79b7",
  attachmentGeneration: 7,
  privateSocketPath: "/run/cuna/agent-sessions/300a55d0/local-actions.sock",
  capabilityReference: "lacap:01J6MW3ZH4M6Q84HM9C86ZJ5W7",
});

const target = Object.freeze({
  path: "/run/cuna/agent-sessions/300a55d0/mcp-7.json",
  exclusiveCreate: true,
  mode: 0o600,
  lifetime: "provider_process",
});

test("Claude MCP plan uses strict ephemeral config and a fenced private socket", () => {
  const plan = buildClaudeMcpLaunchPlan(binding, target);
  assert.deepEqual(plan.argvSuffix, ["--mcp-config", target.path, "--strict-mcp-config"]);
  const server = plan.config.mcpServers[CUNA_AGENT_SESSION_MCP_SERVER];
  assert.equal(server.type, "stdio");
  assert.equal(server.command, CUNA_AGENT_SESSION_MCP_COMMAND);
  assert.deepEqual(server.args, [
    "--transport", "unix",
    "--socket", binding.privateSocketPath,
    "--agent-session", binding.agentSessionId,
    "--process-epoch", binding.processEpoch,
    "--attachment-generation", "7",
    "--capability-ref", binding.capabilityReference,
  ]);
  assert.deepEqual(plan.cleanup.targets, [target.path]);
  assert.equal(plan.cleanup.completion, "absence_verified");
  assert.doesNotMatch(plan.serializedConfig, /access[_-]?token|api[_-]?key|password/iu);
});

test("Codex MCP plan is a deterministic mcp_servers TOML overlay", () => {
  const plan = buildCodexMcpLaunchPlan(binding, { ...target, path: "/run/cuna/agent-sessions/300a55d0/mcp-7.toml" });
  assert.equal(plan.config.mcp_servers.cuna_local_actions.enabled, true);
  assert.match(plan.serializedConfig, /^\[mcp_servers\.cuna_local_actions\]$/mu);
  assert.match(plan.serializedConfig, /^command = "cuna-agent-session-mcp"$/mu);
  assert.match(plan.serializedConfig, /"--attachment-generation", "7"/u);
  assert.equal(plan.argvSuffix[0], "-c");
  assert.equal(plan.argvSuffix[1], 'mcp_servers.cuna_local_actions.command="cuna-agent-session-mcp"');
  assert.equal(plan.argvSuffix[2], "-c");
  assert.match(plan.argvSuffix.join("\n"), /mcp_servers\.cuna_local_actions\.args=.*--attachment-generation/u);
  assert.doesNotMatch(plan.serializedConfig, /access[_-]?token|api[_-]?key|password/iu);
});

test("OpenCode uses a process-scoped JSON MCP overlay with the same fenced private socket", () => {
  const direct = buildOpenCodeMcpLaunchPlan(binding, target);
  const routed = buildProviderMcpLaunchPlan("opencode", binding, target);
  for (const plan of [direct, routed]) {
    assert.equal(plan.enabled, true);
    assert.equal(plan.format, "opencode_local_mcp");
    assert.equal(plan.config.mcp[CUNA_AGENT_SESSION_MCP_SERVER].type, "local");
    assert.deepEqual(plan.config.mcp[CUNA_AGENT_SESSION_MCP_SERVER].command.slice(0, 1), [CUNA_AGENT_SESSION_MCP_COMMAND]);
    assert.match(plan.serializedConfig, /--attachment-generation/u);
    assert.deepEqual(plan.argvSuffix, []);
    assert.deepEqual(plan.environment, { OPENCODE_CONFIG: target.path });
    assert.equal(plan.target, target);
    assert.deepEqual(plan.cleanup.targets, [target.path]);
    assert.doesNotMatch(plan.serializedConfig, /access[_-]?token|api[_-]?key|password/iu);
  }
});

test("MCP plans reject unfenced identity, network endpoints, and unsafe config targets", () => {
  assert.throws(
    () => buildClaudeMcpLaunchPlan({ ...binding, processEpoch: "bad epoch" }, target),
    ProviderMcpConfigurationError,
  );
  assert.throws(
    () => buildClaudeMcpLaunchPlan({ ...binding, privateSocketPath: "https://gateway.example/mcp" }, target),
    ProviderMcpConfigurationError,
  );
  assert.throws(
    () => buildClaudeMcpLaunchPlan(binding, { ...target, mode: 0o644 }),
    ProviderMcpConfigurationError,
  );
  assert.throws(
    () => buildClaudeMcpLaunchPlan(binding, { ...target, path: "bad\npath" }),
    ProviderMcpConfigurationError,
  );
});
