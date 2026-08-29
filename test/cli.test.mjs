import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { CunaError, EXIT_CODES, memoryStreams, parseArgv, runCli } from "../dist/index.js";
import { CREDENTIAL_BACKEND_PROTOCOL } from "../dist/credentials/contracts.js";

const API_KEY = "cuna_sk_abcdefghijklmnop";
// A machine ID in the one shape the product accepts. This fixture used to be
// "m_1", which the command layer waved through and the transport would have
// rejected -- so the test asserted a success the real client cannot produce.
const MACHINE_ID = "33333333-3333-4333-8333-333333333333";
const future = "2026-08-08T00:00:30.000Z";
const FOREGROUND_SESSION_A = "11111111-1111-4111-8111-111111111111";
const FOREGROUND_SESSION_B = "22222222-2222-4222-8222-222222222222";
const FOREGROUND_SESSION_C = "33333333-3333-4333-8333-333333333333";
const FOREGROUND_SESSION_D = "44444444-4444-4444-8444-444444444444";
const ESCAPE = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESCAPE}\\[[0-?]*[ -/]*[@-~]`, "gu");

function stripAnsi(value) {
  return value.replaceAll(ANSI_PATTERN, "");
}

const platform = {
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
};

function capabilitySnapshot(capabilities, subjectScope = "account", subjectId) {
  return {
    schemaVersion: "1.0",
    subjectScope,
    ...(subjectId === undefined ? {} : { subjectId }),
    observedAt: "2026-08-08T00:00:00.000Z",
    expiresAt: future,
    etag: "fixture",
    capabilities,
  };
}

function fakeClient(overrides = {}) {
  return {
    async getIdentity() {
      return {
        id: "11111111-1111-4111-8111-111111111111",
        email: "developer@example.test",
        workspaceAssigned: true,
        workspaceId: "22222222-2222-4222-8222-222222222222",
        workspaceUsage: { estimatedSpendUsd: 1, estimatedRemainingUsd: 49, note: "estimate" },
      };
    },
    async discoverCapabilities() { return capabilitySnapshot([]); },
    async listMachines() { return { items: [] }; },
    async getMachine(id) { return { id, name: "fixture-machine", state: "running", agent: "claude-code" }; },
    async listRecords() { return []; },
    async listAuthorizations() { return []; },
    async listApiKeys() { return []; },
    async createApiKey() { throw new Error("unexpected create API key"); },
    async revokeApiKey() { throw new Error("unexpected revoke API key"); },
    async createMachine() { throw new Error("unexpected create"); },
    async transitionMachine() { throw new Error("unexpected transition"); },
    async replaceMachineSupervisor() { throw new Error("unexpected terminal supervisor replacement"); },
    async deleteMachine() { throw new Error("unexpected delete"); },
    async listAgentSessions() { return { items: [] }; },
    async createAgentSession() { throw new Error("unexpected create agent"); },
    async getAgentSession() { throw new Error("unexpected get agent"); },
    async logoutAgentSessionAuth() { throw new Error("unexpected logout agent"); },
    async renameAgentSession() { throw new Error("unexpected rename agent"); },
    async terminateAgentSession() { throw new Error("unexpected terminate agent"); },
    ...overrides,
  };
}

test("parser keeps subcommands separate from options and rejects duplicates", () => {
  const parsed = parseArgv(["machines", "create", "--name", "dev", "--yes", "--json"]);
  assert.equal(parsed.command, "machines");
  assert.deepEqual(parsed.operands, ["create"]);
  assert.deepEqual(parsed.options, { name: "dev", yes: true, json: true });
  assert.throws(() => parseArgv(["machines", "--json", "--json"]));
});

test("bare machines opens the TTY explorer while JSON returns the nested read-only inventory", async () => {
  let explorerCalls = 0;
  const interactive = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
  assert.equal(await runCli(["machines"], {
    streams: interactive.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => fakeClient(),
    machinesExplorerRunner: async ({ client }) => {
      explorerCalls += 1;
      assert.equal(typeof client.listMachines, "function");
    },
  }), EXIT_CODES.success);
  assert.equal(explorerCalls, 1);
  assert.equal(interactive.stdout(), "");

  const machine = { id: MACHINE_ID, name: "goal0", state: "running", agent: "claude-code" };
  const session = (id, agent, processState, overrides = {}) => ({
    id,
    machineId: MACHINE_ID,
    name: `${agent}-${processState}`,
    agent,
    cwd: "/workspace",
    authMode: "interactive_login",
    desiredState: "running",
    requestState: "launched",
    processState,
    processEpoch: `epoch-${id}`,
    runtimeObservedAt: "2026-08-27T01:00:00.000Z",
    runtimeExpiresAt: "2026-08-27T01:01:00.000Z",
    rowVersion: 1,
    createdAt: "2026-08-27T01:00:00.000Z",
    updatedAt: "2026-08-27T01:00:00.000Z",
    ...overrides,
  });
  const json = memoryStreams();
  assert.equal(await runCli(["machines", "--json"], {
    streams: json.streams,
    platform,
    now: () => Date.parse("2026-08-27T01:00:30.000Z"),
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => fakeClient({
      async listMachines() { return { items: [machine] }; },
      async listAgentSessions() {
        return { items: [
          session(FOREGROUND_SESSION_A, "claude-code", "running"),
          session(FOREGROUND_SESSION_B, "claude-code", "ready"),
          session(FOREGROUND_SESSION_C, "codex", "running"),
          session(FOREGROUND_SESSION_D, "claude-code", "running", { desiredState: "terminated" }),
          session("55555555-5555-4555-8555-555555555555", "codex", "running", { requestState: "termination_pending" }),
          session("66666666-6666-4666-8666-666666666666", "opencode", "running"),
        ] };
      },
    }),
  }), EXIT_CODES.success);
  const record = JSON.parse(json.stdout());
  assert.equal(record.command, "machines.overview");
  assert.deepEqual(record.data.items[0].session_counts.claude, { running: 1, total: 2 });
  assert.deepEqual(record.data.items[0].session_counts.codex, { running: 0, total: 1 });
  assert.deepEqual(record.data.items[0].session_counts.opencode, { running: 0, total: 1 });
  assert.deepEqual(Object.keys(record.data.items[0].session_counts), ["claude", "codex", "opencode"]);
  assert.equal(record.data.items[0].agent_sessions.length, 4);
  assert.equal(record.data.items[0].agent_sessions.some((item) => item.desired_state === "terminated"), false);
  assert.equal(record.data.items[0].agent_sessions.some((item) => item.request_state === "termination_pending"), false);
  const visibleOpenCode = record.data.items[0].agent_sessions.find((item) => item.agent === "opencode");
  assert.equal(visibleOpenCode.can_attach, false);
  assert.equal(visibleOpenCode.base_state, "unsupported");
  assert.equal(visibleOpenCode.reason_code, "provider_mismatch");
  assert.deepEqual(record.data.items[0].provider_availability, {
    declared_id: "claude-code",
    display_name: "Claude",
    usability: "declared-installed",
    actionable: true,
  });
  assert.equal(record.data.items[0].agent_sessions.find((item) => item.agent === "codex").base_state, "unsupported");
});

test("machines overview keeps OpenCode observations visible and actionable on a compatible machine", async () => {
  const machine = { id: MACHINE_ID, name: "legacy-opencode", state: "running", agent: "opencode", updatedAt: "provider-v4" };
  const client = fakeClient({
    async listMachines() { return { items: [machine] }; },
    async listAgentSessions() { return { items: [agentSession({
      machineId: MACHINE_ID,
      agent: "opencode",
      name: "observed-opencode",
      requestState: "launched",
      processState: "running",
      processEpoch: "open-epoch",
      runtimeObservedAt: "2026-08-07T23:59:59.000Z",
      runtimeExpiresAt: "2026-08-08T00:00:30.000Z",
    })] }; },
  });
  const json = memoryStreams();
  assert.equal(await runCli(["machines", "--json"], {
    streams: json.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    clientFactory: () => client,
  }), EXIT_CODES.success);
  const item = JSON.parse(json.stdout()).data.items[0];
  assert.deepEqual(item.provider_availability, {
    declared_id: "opencode",
    display_name: "OpenCode",
    usability: "declared-installed",
    actionable: true,
    observation_version: "provider-v4",
  });
  assert.equal(item.agent_sessions[0].agent, "opencode");
  assert.equal(item.agent_sessions[0].can_attach, true);
  assert.equal(item.agent_sessions[0].base_state, "attachable");

  const human = memoryStreams({ stdoutIsTTY: true });
  assert.equal(await runCli(["machines"], {
    streams: human.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    clientFactory: () => client,
  }), EXIT_CODES.success);
  assert.match(human.stdout(), /OpenCode declared-installed/u);
  assert.match(human.stdout(), /observed-opencode  attachable/u);
  assert.ok(human.stdout().indexOf("OpenCode 1/1 running") < human.stdout().indexOf("Claude 0/0 running"));
});

test("machines overview degrades one AgentSession child-read failure without losing inventory", async () => {
  const failedId = MACHINE_ID;
  const healthyId = "44444444-4444-4444-8444-444444444444";
  const client = fakeClient({
    async listMachines() {
      return { items: [
        { id: failedId, name: "partial", state: "running", agent: "claude-code" },
        { id: healthyId, name: "healthy", state: "running", agent: "codex" },
      ] };
    },
    async listAgentSessions(machineId) {
      if (machineId === failedId) throw new Error("private upstream failure");
      return { items: [agentSession({ id: FOREGROUND_SESSION_B, machineId: healthyId, agent: "codex", name: "healthy-codex" })] };
    },
  });
  const json = memoryStreams();
  assert.equal(await runCli(["machines", "--json"], {
    streams: json.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    clientFactory: () => client,
  }), EXIT_CODES.success);
  const items = JSON.parse(json.stdout()).data.items;
  assert.equal(items.length, 2);
  assert.equal(items.find((item) => item.id === failedId).agent_sessions_error, "sessions_unavailable");
  assert.deepEqual(items.find((item) => item.id === failedId).agent_sessions, []);
  assert.equal(items.find((item) => item.id === healthyId).agent_sessions[0].name, "healthy-codex");
  assert.doesNotMatch(json.stdout(), /private upstream failure/u);

  const human = memoryStreams({ stdoutIsTTY: true });
  assert.equal(await runCli(["machines"], {
    streams: human.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    clientFactory: () => client,
  }), EXIT_CODES.success);
  assert.match(human.stdout(), /partial[\s\S]*AgentSessions unavailable/u);
  assert.match(human.stdout(), /healthy[\s\S]*healthy-codex/u);
});

test("machines explorer selection attaches through the shared foreground runner", async () => {
  const interactive = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
  const attached = [];
  assert.equal(await runCli(["machines"], {
    streams: interactive.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => fakeClient(),
    machinesExplorerRunner: async () => ({
      kind: "attach",
      agentSessionId: FOREGROUND_SESSION_A,
      agent: "claude-code",
    }),
    foregroundTerminalRunner: async (input) => { attached.push(input); },
  }), EXIT_CODES.success);
  assert.equal(attached.length, 1);
  assert.deepEqual(attached[0].agentSessionIds, [FOREGROUND_SESSION_A]);
  assert.deepEqual(attached[0].expectedAgentKinds, ["claude-code"]);
  assert.match(stripAnsi(interactive.stderr()), /Attaching to Claude Code/u);
});

test("machine lifecycle recursion preserves --no-color for explorer and progress", async () => {
  const interactive = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true, stderrIsTTY: true });
  let explorerCalls = 0;
  const client = fakeClient({
    async discoverCapabilities(scope, resourceId) {
      return capabilitySnapshot([{
        id: "machines.lifecycle",
        availability: "supported",
        interaction: "native",
        mutationClass: "reversible",
        surfaces: ["cli"],
        requiredPermissions: ["machines:write"],
      }], scope, resourceId);
    },
    async transitionMachine(id) { return { id, name: "paused-dev", state: "starting", agent: "claude-code" }; },
    async getMachine(id) { return { id, name: "paused-dev", state: "running", agent: "claude-code" }; },
  });
  assert.equal(await runCli(["machines", "--no-color"], {
    streams: interactive.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    clientFactory: () => client,
    machinesExplorerRunner: async (input) => {
      explorerCalls += 1;
      assert.equal(input.color, false);
      return explorerCalls === 1
        ? { kind: "lifecycle", action: "start", machineId: MACHINE_ID }
        : undefined;
    },
  }), EXIT_CODES.success);
  assert.equal(explorerCalls, 2, "successful lifecycle should reopen the same no-color explorer");
  assert.match(interactive.stderr(), /Starting machine/u);
  assert.equal(interactive.stderr().includes("\u001b[38;"), false);
  assert.equal(interactive.stderr().includes("\u001b[48;"), false);
});

test("no-args remains help off-TTY but a real TTY infers and attaches the selected AgentSession", async () => {
  const redirected = memoryStreams();
  assert.equal(await runCli([], { streams: redirected.streams }), EXIT_CODES.success);
  assert.match(JSON.parse(redirected.stdout()).data.help, /cuna machines/u);

  const interactive = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
  const attached = [];
  assert.equal(await runCli([], {
    streams: interactive.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => fakeClient(),
    rootJourneyRunner: async () => ({
      kind: "attach",
      agentSessionId: FOREGROUND_SESSION_A,
      agent: "claude-code",
    }),
    foregroundTerminalRunner: async (input) => { attached.push(input); },
  }), EXIT_CODES.success);
  assert.equal(attached.length, 1);
  assert.deepEqual(attached[0].agentSessionIds, [FOREGROUND_SESSION_A]);
  assert.deepEqual(attached[0].expectedAgentKinds, ["claude-code"]);
  assert.match(stripAnsi(interactive.stderr()), /Finding a machine or AgentSession/u);
  assert.equal(interactive.stderr().includes(`${ESCAPE}[38;5;202m`), true, "the root journey should use the Cuna flare accent");
  const progressOutput = stripAnsi(interactive.stderr());
  assert.match(progressOutput, /[◐◓◑◒] Finding a machine or AgentSession/u);
  assert.match(progressOutput, /◐ Attaching to Claude Code  ━╺━━━━/u);
  assert.doesNotMatch(progressOutput, /Cuna: attaching to Claude/u);
});

test("bare cuna paints a neutral loader before a delayed local sign-in check", async () => {
  const interactive = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true, stderrIsTTY: true });
  let resolveToken;
  const token = new Promise((resolve) => { resolveToken = resolve; });
  const pending = runCli([], {
    streams: interactive.streams,
    platform,
    env: {},
    humanAuth: {
      async acquireAccessToken() { return token; },
      async login() { throw new Error("login is not expected when a stored session resolves"); },
    },
    clientFactory: () => fakeClient(),
    rootJourneyRunner: async () => undefined,
  });

  await new Promise((resolve) => setImmediate(resolve));
  const beforeCredential = stripAnsi(interactive.stderr());
  assert.match(beforeCredential, /Starting Cuna/u);
  assert.doesNotMatch(beforeCredential, /Finding a machine or AgentSession/u);

  resolveToken(`cuna_at_${"h".repeat(43)}`);
  assert.equal(await pending, EXIT_CODES.success);
  const complete = stripAnsi(interactive.stderr());
  assert.ok(complete.indexOf("Starting Cuna") < complete.indexOf("Finding a machine or AgentSession"));
});

test("bare cuna explains a replaced terminal link without exposing resume-handle internals", async () => {
  const interactive = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true, stderrIsTTY: true });
  const exit = await runCli([], {
    streams: interactive.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => fakeClient(),
    rootJourneyRunner: async () => ({
      kind: "attach",
      agentSessionId: FOREGROUND_SESSION_A,
      agent: "claude-code",
    }),
    foregroundTerminalRunner: async () => {
      throw new CunaError({
        code: "cuna.remote.conflict",
        message: "Cuna could not apply the operation because current state conflicts with it.",
        exitCode: EXIT_CODES.conflict,
        details: {
          http_status: 409,
          request_id: "11111111-1111-4111-8111-111111111111",
          reason: "terminal_connection_resume_handle_conflict",
        },
      });
    },
  });

  assert.equal(exit, EXIT_CODES.conflict);
  const visible = stripAnsi(interactive.stderr());
  assert.match(visible, /CUNA  Terminal connection changed/u);
  assert.match(visible, /previous terminal link was already replaced/u);
  assert.match(visible, /Cuna did not stop the remote AgentSession/u);
  assert.match(visible, /Run `cuna` again to reconnect/u);
  assert.doesNotMatch(visible, /terminal_connection_resume_handle_conflict|request_id|Re-read the resource/u);
});

test("foreground Cuna explains a terminal supervisor that is not ready without creating another terminal", async () => {
  const interactive = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true, stderrIsTTY: true });
  const exit = await runCli([], {
    streams: interactive.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => fakeClient(),
    rootJourneyRunner: async () => ({
      kind: "attach",
      agentSessionId: FOREGROUND_SESSION_A,
      agent: "opencode",
    }),
    foregroundTerminalRunner: async () => {
      throw new CunaError({
        code: "cuna.runtime.capability_unknown",
        message: "The server cannot currently prove this capability.",
        exitCode: EXIT_CODES.policy,
        details: {
          capability_id: "terminal_connections.create",
          reason_code: "supervisor_registry_unavailable",
        },
      });
    },
  });

  assert.equal(exit, EXIT_CODES.policy);
  const visible = stripAnsi(interactive.stderr());
  assert.match(visible, /CUNA  Waiting for the machine terminal supervisor/u);
  assert.match(visible, /No terminal connection was created and the remote AgentSession was not changed/u);
  assert.match(visible, /When the machine terminal control reconnects, open this same AgentSession again/u);
  assert.doesNotMatch(visible, /Error \[/u);
});

test("foreground Cuna translates a terminal-capability abstention without leaking its internal capability name", async () => {
  const interactive = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true, stderrIsTTY: true });
  const exit = await runCli([], {
    streams: interactive.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => fakeClient(),
    rootJourneyRunner: async () => ({
      kind: "attach",
      agentSessionId: FOREGROUND_SESSION_A,
      agent: "claude-code",
    }),
    foregroundTerminalRunner: async () => {
      throw new CunaError({
        code: "cuna.runtime.capability_unknown",
        message: "The server cannot currently prove this capability.",
        exitCode: EXIT_CODES.policy,
        details: { capability_id: "terminal_connections.create" },
      });
    },
  });

  assert.equal(exit, EXIT_CODES.policy);
  const visible = stripAnsi(interactive.stderr());
  assert.match(visible, /CUNA  Terminal connection not ready/u);
  assert.match(visible, /could not verify this machine's terminal authority yet/u);
  assert.match(visible, /did not attach a terminal and did not change the remote AgentSession/u);
  assert.match(visible, /Open this same AgentSession again in a moment/u);
  assert.doesNotMatch(visible, /terminal_connections\.create|Error \[/u);
});

test("bare Cuna keeps the terminal-capability recovery human when Windows exposes visible stderr as non-TTY", async () => {
  const interactive = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true, stderrIsTTY: false });
  const exit = await runCli([], {
    streams: interactive.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => fakeClient(),
    rootJourneyRunner: async () => ({
      kind: "attach",
      agentSessionId: FOREGROUND_SESSION_A,
      agent: "opencode",
    }),
    foregroundTerminalRunner: async () => {
      throw new CunaError({
        code: "cuna.runtime.capability_unknown",
        message: "The server cannot currently prove this capability.",
        exitCode: EXIT_CODES.policy,
        details: { capability_id: "terminal_connections.create" },
      });
    },
  });

  assert.equal(exit, EXIT_CODES.policy);
  const visible = interactive.stderr();
  assert.match(visible, /CUNA  Terminal connection not ready/u);
  assert.match(visible, /did not attach a terminal and did not change the remote AgentSession/u);
  assert.doesNotMatch(visible, /terminal_connections\.create|Error \[/u);
  // Kept out of the regex above on purpose: a control character inside a
  // pattern trips no-control-regex, and suppressing the rule would hide the
  // next one too. A substring check states the same thing more plainly.
  assert.ok(!visible.includes("\u001b["), "an ANSI escape must not reach non-TTY output");
  // Kept out of the regex above on purpose: a control character inside a
  // pattern trips no-control-regex, and suppressing the rule would hide the
  // next one too. A substring check states the same thing more plainly.
  assert.ok(!visible.includes("["), "an ANSI escape must not reach non-TTY output");
});

test("foreground Cuna explains an expired AgentSession runtime lease without pretending the terminal is reconnecting", async () => {
  const interactive = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true, stderrIsTTY: true });
  const exit = await runCli([], {
    streams: interactive.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => fakeClient(),
    rootJourneyRunner: async () => ({
      kind: "attach",
      agentSessionId: FOREGROUND_SESSION_A,
      agent: "opencode",
    }),
    foregroundTerminalRunner: async () => {
      throw new CunaError({
        code: "cuna.runtime.capability_unavailable",
        message: "The terminal runtime lease expired.",
        exitCode: EXIT_CODES.policy,
        details: {
          capability_id: "terminal_connections.create",
          reason_code: "runtime_lease_expired",
        },
      });
    },
  });

  assert.equal(exit, EXIT_CODES.policy);
  const visible = stripAnsi(interactive.stderr());
  assert.match(visible, /CUNA  AgentSession needs a fresh runtime check/u);
  assert.match(visible, /has not recently confirmed that this selected AgentSession is still running/u);
  assert.match(visible, /No terminal connection was created and the remote AgentSession was not changed/u);
  assert.match(visible, /Wait for a fresh runtime observation, then open this same AgentSession again/u);
  assert.doesNotMatch(visible, /reconnecting its terminal control|Error \[/u);
});

test("foreground Cuna recognizes the OpenCode supervisor-upgrade reason without claiming a session changed", async () => {
  const interactive = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true, stderrIsTTY: true });
  const exit = await runCli([], {
    streams: interactive.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => fakeClient(),
    rootJourneyRunner: async () => ({
      kind: "attach",
      agentSessionId: FOREGROUND_SESSION_A,
      agent: "opencode",
    }),
    foregroundTerminalRunner: async () => {
      throw new CunaError({
        code: "cuna.runtime.capability_unavailable",
        message: "The terminal supervisor must be upgraded.",
        exitCode: EXIT_CODES.policy,
        details: {
          capability_id: "terminal_connections.create",
          reason_code: "opencode_supervisor_upgrade_required",
        },
      });
    },
  });

  assert.equal(exit, EXIT_CODES.policy);
  const visible = stripAnsi(interactive.stderr());
  assert.match(visible, /CUNA  Machine terminal update needed/u);
  assert.match(visible, /No terminal connection was created and the remote AgentSession was not changed/u);
  assert.doesNotMatch(visible, /Error \[/u);
});

test("Ctrl-C while bare cuna is attaching closes visibly and returns success", async () => {
  const interactive = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true, stderrIsTTY: true });
  const controller = new AbortController();
  const exit = await runCli([], {
    streams: interactive.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    signal: controller.signal,
    clientFactory: () => fakeClient(),
    rootJourneyRunner: async () => ({
      kind: "attach",
      agentSessionId: FOREGROUND_SESSION_A,
      agent: "claude-code",
    }),
    foregroundTerminalRunner: async () => {
      controller.abort(new Error("Cuna was interrupted by SIGINT."));
      throw controller.signal.reason;
    },
  });

  assert.equal(exit, EXIT_CODES.success);
  const visible = stripAnsi(interactive.stderr());
  assert.match(visible, /✦ Closing Cuna/u);
  assert.match(visible, /✓ Closed/u);
  assert.doesNotMatch(visible, /Error \[/u);
});

test("Ctrl-C during an OpenCode automatic journey closes visibly instead of printing a journey error", async () => {
  const interactive = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true, stderrIsTTY: true });
  const controller = new AbortController();
  const exit = await runCli(["opencode", ".", "--new", "--no-sync"], {
    streams: interactive.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY, TERM: "xterm-256color" },
    signal: controller.signal,
    clientFactory: () => fakeClient(),
    automaticJourneyEffectsFactory: () => ({
      onPhase() {},
      async inspectWorkspace() {
        controller.abort(new Error("Cuna was interrupted by SIGINT."));
        return { canonicalLocalRoot: "C:\\work\\project" };
      },
      async observeMachines() { throw new Error("unreachable"); },
      async createMachine() { throw new Error("unreachable"); },
      async reconcileMachineCreate() { return "unreconcilable"; },
      async ensureMachineReady() { throw new Error("unreachable"); },
      async synchronizeWorkspace() { throw new Error("unreachable"); },
      async observeAgentSessions() { throw new Error("unreachable"); },
      async createAgentSession() { throw new Error("unreachable"); },
      async ensureAgentSessionReady() { throw new Error("unreachable"); },
      async attach() { throw new Error("unreachable"); },
      async reconcileCancellation() {},
    }),
  });

  assert.equal(exit, EXIT_CODES.success);
  const visible = stripAnsi(interactive.stderr());
  assert.match(visible, /✦ Closing Cuna/u);
  assert.match(visible, /✓ Closed/u);
  assert.doesNotMatch(visible, /cuna\.journey\.cancelled|Error \[/u);
});

test("bare cuna signs in before it claims to search machines", async () => {
  const interactive = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true, stderrIsTTY: true });
  let signedIn = false;
  let loginCalls = 0;
  let rootCalls = 0;
  const authResult = {
    profile: "default",
    sessionId: "00000000-0000-4000-8000-000000000002",
    context: {
      requiredTermsVersion: "2026-08-01",
      identity: "active",
      admission: "admitted",
      workspace: { state: "assigned", id: "00000000-0000-4000-8000-000000000003" },
    },
  };
  const humanAuth = {
    async acquireAccessToken() {
      if (!signedIn) {
        throw new CunaError({
          code: "cuna.auth.required",
          message: "No interactive Cuna session is stored.",
          exitCode: EXIT_CODES.auth,
        });
      }
      return `cuna_at_${"g".repeat(43)}`;
    },
    async login() {
      loginCalls += 1;
      signedIn = true;
      return authResult;
    },
  };

  assert.equal(await runCli([], {
    streams: interactive.streams,
    platform,
    env: {},
    humanAuth,
    clientFactory: () => fakeClient(),
    rootJourneyRunner: async () => {
      rootCalls += 1;
      assert.equal(signedIn, true, "machine discovery must begin only after login succeeds");
      return undefined;
    },
  }), EXIT_CODES.success);
  assert.equal(loginCalls, 1);
  assert.equal(rootCalls, 1);
  const output = interactive.stderr();
  assert.match(output, /let's sign you in first/u);
  assert.match(output, /signed in\. Continuing/u);
  assert.ok(output.indexOf("signed in. Continuing") < output.indexOf("Finding a machine or AgentSession"));
  assert.doesNotMatch(output, /Error \[cuna\.auth\.required\]/u);
});

test("non-TTY help and version are versioned JSON records", async () => {
  const help = memoryStreams();
  assert.equal(await runCli(["--help"], { streams: help.streams }), EXIT_CODES.success);
  const helpRecord = JSON.parse(help.stdout());
  assert.equal(helpRecord.schema_version, "1");
  assert.equal(helpRecord.type, "result");
  // `cuna --help` is now the SHORT orientation. Both sentences below still
  // exist verbatim — they were relocated to `cuna help --all`, not removed —
  // and the two assertions that follow prove exactly that: absent from the
  // short help, present in the full one.
  assert.doesNotMatch(helpRecord.data.help, /Automatic local-to-cloud journey:/u);
  assert.match(helpRecord.data.help, /cuna help --all/u);
  assert.match(helpRecord.data.help, /Run `cuna login`, approve in the browser, and paste the displayed login code/u);
  assert.doesNotMatch(helpRecord.data.help, /Create an automation credential at/u);
  const all = memoryStreams();
  assert.equal(await runCli(["help", "--all"], { streams: all.streams }), EXIT_CODES.success);
  const allRecord = JSON.parse(all.stdout());
  assert.match(allRecord.data.help, /Automatic local-to-cloud journey:/u);
  assert.match(allRecord.data.help, /Use --agent-session SESSION_ID to bypass reconciliation/u);
  const version = memoryStreams();
  assert.equal(await runCli(["--version"], { streams: version.streams }), EXIT_CODES.success);
  assert.equal(JSON.parse(version.stdout()).data.version, "0.1.0");
});

test("missing automation auth fails before a remote call and emits no prompt", async () => {
  let calls = 0;
  const streams = memoryStreams();
  const exit = await runCli(["machines", "list"], {
    streams: streams.streams,
    platform,
    env: {},
    clientFactory: () => fakeClient({ async listMachines() { calls += 1; return { items: [] }; } }),
  });
  assert.equal(exit, EXIT_CODES.auth);
  assert.equal(calls, 0);
  assert.equal(JSON.parse(streams.stderr()).error.code, "cuna.auth.required");
});

test("TC-037-03/07 records and authorizations remain capability-gated read-only parity operations", async () => {
  const machineId = "22222222-2222-4222-8222-222222222222";
  const recordId = "11111111-1111-4111-8111-111111111111";
  const observed = [];
  const client = fakeClient({
    async discoverCapabilities(scope, resourceId) {
      observed.push({ kind: "capability", scope, resourceId });
      const id = scope === "account" ? "records.list" : "authorizations.list";
      return capabilitySnapshot([{
        id,
        availability: "supported",
        interaction: "read_only",
        mutationClass: "none",
        surfaces: ["cli"],
        requiredPermissions: [],
      }], scope, resourceId);
    },
    async listRecords() {
      observed.push({ kind: "records" });
      return [{
        id: recordId,
        machineId,
        kind: "session.create",
        summary: "Machine created",
        detail: {},
        createdAt: "2026-08-08T00:00:00.000Z",
      }];
    },
    async listAuthorizations(id) {
      observed.push({ kind: "authorizations", id });
      return [{
        id: "rule-1",
        host: "api.example.com",
        path: "/v1",
        credential: "ANTHROPIC_API_KEY",
        target: { kind: "header", name: "Authorization", format: "Bearer ${credential}" },
        cacheTtlSeconds: 60,
      }];
    },
  });
  const records = memoryStreams();
  assert.equal(await runCli(["records", "list"], {
    streams: records.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  }), EXIT_CODES.success);
  assert.equal(JSON.parse(records.stdout()).data.items[0].id, recordId);

  const authorizations = memoryStreams();
  assert.equal(await runCli(["authorizations", "list", "--machine", machineId], {
    streams: authorizations.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  }), EXIT_CODES.success);
  assert.equal(JSON.parse(authorizations.stdout()).data.items[0].credential, "ANTHROPIC_API_KEY");
  assert.deepEqual(observed, [
    { kind: "capability", scope: "account", resourceId: undefined },
    { kind: "records" },
    { kind: "capability", scope: "machine", resourceId: machineId },
    { kind: "authorizations", id: machineId },
  ]);
});

test("TC-037-07 account, workspace, and usage expose only the closed public identity projection", async () => {
  const requests = [];
  const identity = {
    id: "11111111-1111-4111-8111-111111111111",
    email: "developer@example.test",
    workspaceAssigned: true,
    workspaceId: "22222222-2222-4222-8222-222222222222",
    workspaceUsage: { estimatedSpendUsd: 1.25, estimatedRemainingUsd: 48.75, note: "estimate" },
  };
  const client = fakeClient({ async getIdentity() { requests.push("identity"); return identity; } });
  const cases = [
    [["account", "show"], "account.show", { id: identity.id, email: identity.email }],
    [["workspace", "show"], "workspace.show", { assigned: true }],
    [["usage", "show"], "usage.show", {
      estimated_spend_usd: 1.25,
      estimated_remaining_usd: 48.75,
      note: "estimate",
    }],
  ];
  for (const [argv, command, data] of cases) {
    const streams = memoryStreams();
    assert.equal(await runCli(argv, {
      streams: streams.streams,
      platform,
      env: { CUNA_API_KEY: API_KEY },
      clientFactory: () => client,
    }), EXIT_CODES.success);
    const record = JSON.parse(streams.stdout());
    assert.equal(record.command, command);
    assert.deepEqual(record.data, data);
    assert.doesNotMatch(streams.stdout(), /tenant|credential|token/u);
  }
  assert.deepEqual(requests, ["identity", "identity", "identity"]);
});

test("workspace and usage preserve unassigned waitlist truth without fabricating estimates", async () => {
  const client = fakeClient({
    async getIdentity() {
      return {
        id: "11111111-1111-4111-8111-111111111111",
        email: "developer@example.test",
        workspaceAssigned: false,
        waitlistPosition: 7,
      };
    },
  });
  const workspace = memoryStreams();
  assert.equal(await runCli(["workspace", "show"], {
    streams: workspace.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => client,
  }), EXIT_CODES.success);
  assert.deepEqual(JSON.parse(workspace.stdout()).data, { assigned: false, waitlist_position: 7 });

  const usage = memoryStreams();
  assert.equal(await runCli(["usage", "show"], {
    streams: usage.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => client,
  }), EXIT_CODES.unsupported);
  assert.equal(JSON.parse(usage.stderr()).error.details.reason, "workspace_usage_unavailable");
});

test("unadvertised account and workspace browser actions are rejected as usage", async () => {
  for (const argv of [["account", "open"], ["workspace", "open"]]) {
    let identityReads = 0;
    const streams = memoryStreams();
    assert.equal(await runCli(argv, {
      streams: streams.streams,
      platform,
      env: { CUNA_API_KEY: API_KEY },
      clientFactory: () => fakeClient({ async getIdentity() { identityReads += 1; throw new Error("unexpected"); } }),
    }), EXIT_CODES.usage);
    assert.equal(identityReads, 0);
    assert.equal(JSON.parse(streams.stderr()).error.code, "cuna.usage.invalid");
  }
});

test("TC-037-02 unavailable parity capabilities perform no record or authorization request", async () => {
  const machineId = "22222222-2222-4222-8222-222222222222";
  let effects = 0;
  const client = fakeClient({
    async discoverCapabilities(scope, resourceId) {
      return capabilitySnapshot([], scope, resourceId);
    },
    async listRecords() { effects += 1; return []; },
    async listAuthorizations() { effects += 1; return []; },
  });
  for (const argv of [
    ["records", "list"],
    ["authorizations", "list", "--machine", machineId],
  ]) {
    const streams = memoryStreams();
    assert.equal(await runCli(argv, {
      streams: streams.streams,
      platform,
      env: { CUNA_API_KEY: API_KEY },
      now: () => Date.parse("2026-08-08T00:00:00Z"),
      clientFactory: () => client,
    }), EXIT_CODES.unsupported);
  }
  assert.equal(effects, 0);
});

test("TC-037-05 API-key management requires interactive authority, fresh capability, and explicit destructive confirmation", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const effects = [];
  let revokedAt = null;
  const client = fakeClient({
    async discoverCapabilities(scope) {
      effects.push("capability");
      return capabilitySnapshot([{
        id: "api_keys.manage",
        availability: "supported",
        interaction: "native",
        mutationClass: "secret_revealing",
        surfaces: ["cli"],
        requiredPermissions: ["api_keys:manage", "auth:interactive"],
      }], scope);
    },
    async listApiKeys() {
      effects.push("list");
      return [{
        id,
        name: "automation",
        prefix: "cuna_sk_abcd",
        lastFour: "WXYZ",
        createdAt: "2026-08-08T00:00:00.000Z",
        expiresAt: null,
        lastUsedAt: null,
        revokedAt,
      }];
    },
    async revokeApiKey(observed) {
      effects.push(`revoke:${observed}`);
      revokedAt = "2026-08-08T00:00:01.000Z";
      return true;
    },
  });
  for (const argv of [["api-keys", "list"], ["api-keys", "revoke", id, "--yes"]]) {
    const automation = memoryStreams();
    assert.equal(await runCli(argv, {
      streams: automation.streams,
      platform,
      env: { CUNA_API_KEY: API_KEY },
      now: () => Date.parse("2026-08-08T00:00:00Z"),
      clientFactory: () => client,
    }), EXIT_CODES.auth);
    assert.equal(JSON.parse(automation.stderr()).error.code, "cuna.auth.interactive_required");
  }
  assert.deepEqual(effects, []);

  const humanAuth = { async acquireAccessToken() { return `cuna_at_${"b".repeat(43)}`; } };
  const list = memoryStreams();
  assert.equal(await runCli(["api-keys", "list"], {
    streams: list.streams,
    platform,
    env: {},
    humanAuth,
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  }), EXIT_CODES.success);
  assert.equal(JSON.parse(list.stdout()).data.items[0].last_four, "WXYZ");

  const unconfirmed = memoryStreams();
  assert.equal(await runCli(["api-keys", "revoke", id], {
    streams: unconfirmed.streams,
    platform,
    env: {},
    humanAuth,
    clientFactory: () => client,
  }), EXIT_CODES.policy);

  const revoke = memoryStreams();
  assert.equal(await runCli(["api-keys", "revoke", id, "--yes"], {
    streams: revoke.streams,
    platform,
    env: {},
    humanAuth,
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  }), EXIT_CODES.success);
  assert.equal(JSON.parse(revoke.stdout()).data.revoked, true);
  assert.deepEqual(effects, ["capability", "list", "capability", `revoke:${id}`, "list"]);
});

test("API-key creation requires interactive authority and prints the one-time secret exactly once", async () => {
  let effects = 0;
  const automation = memoryStreams();
  const automationExit = await runCli(["api-keys", "create", "--name", "local automation", "--yes"], {
    streams: automation.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => fakeClient({ async discoverCapabilities() { effects += 1; return capabilitySnapshot([]); } }),
  });
  assert.equal(automationExit, EXIT_CODES.auth);
  assert.equal(effects, 0);
  assert.equal(JSON.parse(automation.stderr()).error.code, "cuna.auth.interactive_required");

  const oneTimeKey = `cuna_sk_${"a".repeat(16)}WXYZ`;
  const interactive = memoryStreams();
  const client = fakeClient({
    async discoverCapabilities(scope) {
      effects += 1;
      return capabilitySnapshot([{
        id: "api_keys.manage",
        availability: "supported",
        interaction: "native",
        mutationClass: "secret_revealing",
        surfaces: ["cli"],
        requiredPermissions: ["api_keys:manage", "auth:interactive"],
      }], scope);
    },
    async createApiKey(input) {
      effects += 1;
      assert.deepEqual(input, { name: "local automation", expiresAt: "2026-09-01T00:00:00.000Z" });
      return {
        id: "11111111-1111-4111-8111-111111111111",
        name: input.name,
        prefix: "cuna_sk_",
        lastFour: "WXYZ",
        createdAt: "2026-08-08T00:00:00.000Z",
        expiresAt: input.expiresAt,
        lastUsedAt: null,
        revokedAt: null,
        idempotencyReplayed: false,
        key: oneTimeKey,
      };
    },
  });
  const humanAuth = {
    async acquireAccessToken() { return `cuna_at_${"b".repeat(43)}`; },
  };
  const interactiveExit = await runCli([
    "api-keys", "create", "--name", "local automation", "--expires-at", "2026-09-01T00:00:00.000Z", "--yes",
  ], {
    streams: interactive.streams,
    platform,
    env: {},
    humanAuth,
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  });
  assert.equal(interactiveExit, EXIT_CODES.success, interactive.stderr());
  const output = interactive.stdout();
  assert.equal(output.split(oneTimeKey).length - 1, 1);
  assert.equal(JSON.parse(output).data.key, oneTimeKey);
  assert.equal(interactive.stderr(), "");
  assert.equal(effects, 2);
});

test("malformed API-key create response reconciles, revokes, and verifies no active orphan", async () => {
  const createdAt = "2026-08-08T00:00:01.000Z";
  let createCalls = 0;
  let revoked = false;
  const metadata = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "malformed commit",
    prefix: "cuna_sk_",
    lastFour: "WXYZ",
    createdAt,
    expiresAt: null,
    lastUsedAt: null,
    get revokedAt() { return revoked ? "2026-08-08T00:00:02.000Z" : null; },
  };
  const client = fakeClient({
    async discoverCapabilities(scope) {
      return capabilitySnapshot([{
        id: "api_keys.manage", availability: "supported", interaction: "native",
        mutationClass: "secret_revealing", surfaces: ["cli"], requiredPermissions: ["api_keys:manage"],
      }], scope);
    },
    async listApiKeys() { return createCalls === 0 ? [] : [metadata]; },
    async createApiKey(_input, idempotencyKey) {
      createCalls += 1;
      assert.match(idempotencyKey, /^cuna-api-key-create-[0-9a-f-]{36}$/u);
      if (createCalls === 1) throw new Error("malformed response after commit");
      return { ...metadata, idempotencyReplayed: true };
    },
    async revokeApiKey(id) { assert.equal(id, metadata.id); revoked = true; return true; },
  });
  const streams = memoryStreams();
  const exit = await runCli(["api-keys", "create", "--name", metadata.name, "--yes"], {
    streams: streams.streams,
    platform,
    env: {},
    humanAuth: { async acquireAccessToken() { return `cuna_at_${"b".repeat(43)}`; } },
    now: () => Date.parse("2026-08-08T00:00:00.000Z"),
    clientFactory: () => client,
  });
  assert.equal(exit, EXIT_CODES.network);
  assert.equal(JSON.parse(streams.stderr()).error.code, "cuna.api_keys.create_secret_unobserved");
  assert.equal(createCalls, 2);
  assert.equal(revoked, true);
  assert.equal((await client.listApiKeys()).some((key) => key.revokedAt === null), false);
  assert.equal(streams.stdout(), "");
});

test("explicit signup, login, whoami, access status, and logout dispatch only to the interactive authority", async () => {
  const calls = [];
  const result = {
    profile: "default",
    sessionId: "00000000-0000-0000-0000-000000000002",
    context: {
      requiredTermsVersion: "2026-08",
      identity: "active",
      admission: "admitted",
      workspace: { state: "assigned", id: "00000000-0000-0000-0000-000000000003" },
    },
  };
  const humanAuth = {
    async signup() { calls.push("signup"); return { ...result, context: { ...result.context, admission: "waitlisted", workspace: { state: "unavailable" }, waitlistPosition: 17 } }; },
    async login() { calls.push("login"); return result; },
    async acquireAccessToken() { throw new Error("unexpected acquire"); },
    async whoami() { calls.push("whoami"); return result; },
    async logout() { calls.push("logout"); return { revoked: true }; },
  };
  for (const [argv, expectedCommand] of [
    [["signup"], "signup"],
    [["login"], "login"],
    [["whoami"], "whoami"],
    [["access", "status"], "access.status"],
    [["logout"], "logout"],
  ]) {
    const streams = memoryStreams();
    assert.equal(await runCli(argv, { streams: streams.streams, platform, env: {}, humanAuth }), EXIT_CODES.success);
    const record = JSON.parse(streams.stdout());
    assert.equal(record.command, expectedCommand);
    if (expectedCommand === "access.status") {
      assert.equal(record.data.identity, "active");
      assert.equal(record.data.admission, "admitted");
      assert.deepEqual(record.data.workspace, {
        state: "assigned",
        id: "00000000-0000-0000-0000-000000000003",
      });
    }
  }
  assert.deepEqual(calls, ["signup", "login", "whoami", "whoami", "logout"]);
});

test("login defaults to encrypted local storage and authenticated commands reuse the injected authority", async () => {
  const result = {
    profile: "default",
    sessionId: "00000000-0000-0000-0000-000000000002",
    context: {
      requiredTermsVersion: "2026-08",
      identity: "active",
      admission: "admitted",
      workspace: { state: "assigned", id: "00000000-0000-0000-0000-000000000003" },
    },
  };
  let loginRequest;
  const humanAuth = {
    async login(request) { loginRequest = request; return result; },
    async signup() { throw new Error("unexpected"); },
    async acquireAccessToken() { return `runa_at_${"a".repeat(43)}`; },
    async whoami() { throw new Error("unexpected"); },
    async logout() { throw new Error("unexpected"); },
  };
  const loginStreams = memoryStreams();
  assert.equal(
    await runCli(["login"], { streams: loginStreams.streams, platform, env: {}, humanAuth }),
    EXIT_CODES.success,
  );
  assert.deepEqual(loginRequest, {});
  assert.equal(JSON.parse(loginStreams.stdout()).data.storage_mode, "encrypted-local");

  const humanLoginStreams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true, stderrIsTTY: true });
  assert.equal(
    await runCli(["login"], { streams: humanLoginStreams.streams, platform, env: {}, humanAuth }),
    EXIT_CODES.success,
  );
  assert.equal(humanLoginStreams.stdout(), "Signed in to Cuna.\n");

  let observedAuthorization;
  const commandStreams = memoryStreams();
  assert.equal(
    await runCli(["machines", "list"], {
      streams: commandStreams.streams,
      platform,
      env: {},
      humanAuth,
      fetch: async (_url, init) => {
        observedAuthorization = init.headers.Authorization;
        return new Response(JSON.stringify([]), { status: 200 });
      },
    }),
    EXIT_CODES.success,
  );
  assert.equal(observedAuthorization, `Bearer runa_at_${"a".repeat(43)}`);
});

test("preview login never prints a capability-bearing browser URL to JSON or redirected output", async () => {
  const streams = memoryStreams();
  const exit = await runCli(["login", "--session-only", "--json"], {
    streams: streams.streams,
    platform,
    env: { CUNA_SESSION_PASSPHRASE: "preview-passphrase-2026" },
  });
  assert.equal(exit, EXIT_CODES.usage);
  const urlCount = (text) => [...text.matchAll(/https?:\/\/[^\s"'`]+/gu)].length;
  assert.equal(urlCount(streams.stdout()), 0);
  assert.equal(urlCount(streams.stderr()), 0);
});

test("preview login refuses a redirected stderr before creating a browser continuation", async () => {
  const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true, stderrIsTTY: false });
  const exit = await runCli(["login", "--session-only"], {
    streams: streams.streams,
    platform,
    env: { CUNA_SESSION_PASSPHRASE: "preview-passphrase-2026" },
  });
  assert.equal(exit, EXIT_CODES.usage);
  const urlCount = (text) => [...text.matchAll(/https?:\/\/[^\s"'`]+/gu)].length;
  assert.equal(urlCount(streams.stdout()), 0);
  assert.equal(urlCount(streams.stderr()), 0);
});

test("production login uses the encrypted backend and reuses the canonical durable exchange", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "cuna-cli-preview-"));
  const continuationId = "123e4567-e89b-12d3-a456-426614174000";
  const sessionId = "123e4567-e89b-12d3-a456-426614174001";
  const browserNonce = `cuna_cb_${"n".repeat(43)}`;
  // The issued continuation must be a coherent, short-lived browser code
  // fixture. A distant calendar date overflows Node's signed timer bound and
  // can turn an immediate code-entry test into a spurious expiry race.
  const continuationDeadlineMs = Date.now() + 5 * 60_000;
  const continuationExpiresAt = new Date(continuationDeadlineMs).toISOString();
  assert.ok(continuationDeadlineMs - Date.now() > 0 && continuationDeadlineMs - Date.now() <= 600_000);
  let observedAuthorization;
  let exchangeCount = 0;
  let retiredContinuationStatusRequests = 0;
  const timeoutWarnings = [];
  const recordWarning = (warning) => {
    if (warning?.name === "TimeoutOverflowWarning") timeoutWarnings.push(warning);
  };
  const context = {
    required_terms_version: "2026-08",
    identity: "active",
    admission: "admitted",
    workspace: { state: "assigned", id: "22222222-2222-4222-8222-222222222222" },
  };
  let browserUrl;
  const fetch = async (url, init = {}) => {
    const requestUrl = new URL(url);
    if (requestUrl.pathname === "/v1/cli-auth/bootstrap") {
      return new Response(JSON.stringify({
        enabled: true,
        completion_mode: "paste_login_code",
        pkce_method: "S256",
        continuation_ttl_seconds: 600,
        access_token_ttl_seconds: 600,
        browser_origin: "https://app.getcuna.com",
      }), { status: 200 });
    }
    if (requestUrl.pathname === "/v1/cli-auth/continuations" && init.method === "POST") {
      const body = JSON.parse(String(init.body));
      browserUrl = `https://app.getcuna.com/cli/continue#continuation=${continuationId}&nonce=${browserNonce}&state=${body.state}`;
      return new Response(JSON.stringify({
        id: continuationId,
        browser_url: browserUrl,
        expires_at: continuationExpiresAt,
        completion_mode: "paste_login_code",
      }), { status: 200 });
    }
    if (requestUrl.pathname === `/v1/cli-auth/continuations/${continuationId}`) {
      retiredContinuationStatusRequests += 1;
      throw new Error("strict paste-code CLI must not fetch a retired continuation status route");
    }
    if (requestUrl.pathname === `/v1/cli-auth/continuations/${continuationId}/exchange`) {
      const body = JSON.parse(String(init.body));
      assert.equal(body.login_code, `cuna_login_${"l".repeat(43)}`);
      assert.equal(Object.hasOwn(body, "refresh_token"), false);
      const initial = exchangeCount === 0;
      exchangeCount += 1;
      return new Response(JSON.stringify({
        access_token: `cuna_at_${(initial ? "a" : "b").repeat(43)}`,
        token_type: "Bearer",
        expires_in: 600,
        access_expires_at: initial ? "2030-01-01T00:10:00.000Z" : "2030-01-01T00:20:00.000Z",
        login_code_expires_at: "2030-02-01T00:00:00.000Z",
        session_id: sessionId,
        context,
      }), { status: 200 });
    }
    if (requestUrl.pathname === "/v1/sessions") {
      observedAuthorization = init.headers?.Authorization;
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }
    if (requestUrl.pathname === "/v1/cli-auth/context") {
      return new Response(JSON.stringify(context), { status: 200 });
    }
    if (requestUrl.pathname === "/v1/cli-auth/logout") {
      return new Response(JSON.stringify({ revoked: true }), { status: 200 });
    }
    throw new Error(`unexpected preview auth request: ${requestUrl.pathname}`);
  };
  const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true, stderrIsTTY: true });
  process.on("warning", recordWarning);
  try {
    const exit = await runCli(["login"], {
      streams: streams.streams,
      platform: {
        ...platform,
        kind: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
        paths: { ...platform.paths, configDirectory },
      },
      env: {},
      fetch,
      browser: { async open(url) { browserUrl = url; } },
      readLoginCode: async () => `cuna_login_${"l".repeat(43)}`,
    });
    assert.equal(exit, EXIT_CODES.success, streams.stderr());
    assert.match(browserUrl, /^https:\/\/app\.getcuna\.com\/cli\/continue#/u);
    const files = await readdir(join(configDirectory, "sessions-v1"));
    assert.equal(files.length, 2);
    const storedFile = files.find((file) => file.endsWith(".json"));
    const stored = await readFile(join(configDirectory, "sessions-v1", storedFile), "utf8");
    assert.doesNotMatch(stored, /cuna_(?:at|rt)_/u);

    const laterStreams = memoryStreams();
    const laterExit = await runCli(["machines", "list"], {
      streams: laterStreams.streams,
      platform: {
        ...platform,
        kind: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
        paths: { ...platform.paths, configDirectory },
      },
      env: { CUNA_SESSION_PASSPHRASE: "preview-passphrase-2026" },
      fetch,
    });
    assert.equal(laterExit, EXIT_CODES.success, laterStreams.stderr());
    // The first bearer, not a second one. A stored bearer with real life left
    // is now reused across processes: every authenticated command used to
    // re-exchange, against a server budget of ten exchanges per rolling
    // minute, so the eleventh command in a minute failed. Asserting the
    // exchange count is the stronger half of this — one sign-in, one exchange.
    assert.equal(observedAuthorization, `Bearer cuna_at_${"a".repeat(43)}`);
    assert.equal(exchangeCount, 1, "a second command must not buy another exchange");
    assert.equal(retiredContinuationStatusRequests, 0);

    const whoamiStreams = memoryStreams();
    const whoamiExit = await runCli(["whoami"], {
      streams: whoamiStreams.streams,
      platform: {
        ...platform,
        kind: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
        paths: { ...platform.paths, configDirectory },
      },
      env: { CUNA_SESSION_PASSPHRASE: "preview-passphrase-2026" },
      fetch,
    });
    assert.equal(whoamiExit, EXIT_CODES.success, whoamiStreams.stderr());

    const logoutStreams = memoryStreams();
    const logoutExit = await runCli(["logout"], {
      streams: logoutStreams.streams,
      platform: {
        ...platform,
        kind: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
        paths: { ...platform.paths, configDirectory },
      },
      env: { CUNA_SESSION_PASSPHRASE: "preview-passphrase-2026" },
      fetch,
    });
    assert.equal(logoutExit, EXIT_CODES.success, logoutStreams.stderr());
    assert.equal((await readdir(join(configDirectory, "sessions-v1"))).length, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(timeoutWarnings.length, 0, "a coherent continuation deadline must not overflow Node's timer");
  } finally {
    process.off("warning", recordWarning);
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("access status rejects alternate actions before configuration or authentication effects", async () => {
  for (const argv of [["access"], ["access", "ready"], ["access", "status", "extra"]]) {
    let effects = 0;
    const streams = memoryStreams();
    const exit = await runCli(argv, {
      streams: streams.streams,
      platform: { ...platform, async readSafeConfig() { effects += 1; return { exists: false }; } },
      humanAuth: { async whoami() { effects += 1; throw new Error("unexpected"); } },
    });
    assert.equal(exit, EXIT_CODES.usage);
    assert.equal(effects, 0);
  }
});

test("CUNA_API_KEY automation mode never falls back to or mutates interactive auth", async () => {
  let calls = 0;
  const humanAuth = {
    async signup() { calls += 1; throw new Error("unexpected"); },
    async login() { calls += 1; throw new Error("unexpected"); },
    async acquireAccessToken() { calls += 1; throw new Error("unexpected"); },
    async whoami() { calls += 1; throw new Error("unexpected"); },
    async logout() { calls += 1; throw new Error("unexpected"); },
  };
  const streams = memoryStreams();
  const exit = await runCli(["login"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    humanAuth,
  });
  assert.equal(exit, EXIT_CODES.auth);
  assert.equal(JSON.parse(streams.stderr()).error.code, "cuna.auth.mode_conflict");
  assert.equal(calls, 0);
});

test("removed session-only mode is rejected before automation auth", async () => {
  const streams = memoryStreams();
  const exit = await runCli(["machines", "list", "--session-only"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY, CUNA_SESSION_PASSPHRASE: "preview-passphrase-2026" },
  });
  assert.equal(exit, EXIT_CODES.usage);
  assert.equal(JSON.parse(streams.stderr()).error.code, "cuna.usage.invalid");
});

test("interactive bearer authenticates cloud commands without exposing or persisting the access token", async () => {
  const accessToken = `runa_at_${"a".repeat(43)}`;
  let observedAuthorization;
  const streams = memoryStreams();
  const exit = await runCli(["machines", "list"], {
    streams: streams.streams,
    platform,
    env: {},
    humanAuth: {
      async login() { throw new Error("unexpected"); },
      async acquireAccessToken() { return accessToken; },
      async whoami() { throw new Error("unexpected"); },
      async logout() { throw new Error("unexpected"); },
    },
    fetch: async (_url, init) => {
      observedAuthorization = init.headers.Authorization;
      return new Response(JSON.stringify([]), { status: 200 });
    },
  });
  assert.equal(exit, EXIT_CODES.success);
  assert.equal(observedAuthorization, `Bearer ${accessToken}`);
  assert.equal(streams.stdout().includes(accessToken), false);
  assert.equal(streams.stderr().includes(accessToken), false);
});

test("interactive capabilities use memory bearer without opening login, and auth errors remain secret-free", async () => {
  const accessToken = `runa_at_${"z".repeat(43)}`;
  const refreshedAccessToken = `runa_at_${"y".repeat(43)}`;
  let acquires = 0;
  let refreshes = 0;
  let logins = 0;
  const humanAuth = {
    async login() { logins += 1; throw new Error("unexpected browser login"); },
    async acquireAccessToken() { acquires += 1; return accessToken; },
    async refreshRejectedAccessToken(rejectedToken) {
      assert.equal(rejectedToken, accessToken);
      refreshes += 1;
      return refreshedAccessToken;
    },
    async whoami() { throw new Error("unexpected"); },
    async logout() { throw new Error("unexpected"); },
  };
  const success = memoryStreams();
  assert.equal(await runCli(["capabilities"], {
    streams: success.streams,
    platform,
    env: {},
    humanAuth,
    fetch: async () => new Response(JSON.stringify({
      schema_version: "1.0",
      subject_scope: "account",
      observed_at: "2026-08-08T00:00:00.000Z",
      expires_at: future,
      etag: "interactive",
      capabilities: [],
    }), { status: 200 }),
  }), EXIT_CODES.success);
  assert.equal(acquires, 1);
  assert.equal(logins, 0);

  const rejected = memoryStreams();
  assert.equal(await runCli(["capabilities"], {
    streams: rejected.streams,
    platform,
    env: {},
    humanAuth,
    fetch: async () => new Response(JSON.stringify({ code: "cli_auth_rejected", detail: accessToken }), { status: 401 }),
  }), EXIT_CODES.auth);
  assert.equal(rejected.stderr().includes(accessToken), false);
  assert.equal(rejected.stderr().includes(refreshedAccessToken), false);
  assert.doesNotMatch(JSON.parse(rejected.stderr()).error.hint, /cuna login|reauthenticate/iu);
  assert.match(JSON.parse(rejected.stderr()).error.hint, /fresh token from the encrypted local session/iu);
  assert.equal(logins, 0);
  assert.equal(refreshes, 1);
});

test("machine list calls the real public legacy Machine projection", async () => {
  const machineId = "22222222-2222-4222-8222-222222222222";
  const requests = [];
  const streams = memoryStreams();
  const exit = await runCli(["machines", "list"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    fetch: async (url, init) => {
      requests.push({ url: url.toString(), init });
      return new Response(JSON.stringify([{ id: machineId, name: "dev", status: "running" }]), { status: 200 });
    },
  });
  assert.equal(exit, EXIT_CODES.success);
  assert.equal(requests[0].url, "https://api.getcuna.com/v1/sessions");
  assert.equal(JSON.parse(streams.stdout()).data.items[0].id, machineId);
  assert.equal(streams.stdout().includes(API_KEY), false);
});

test("absent capability is a negative control: no machine mutation occurs", async () => {
  let creates = 0;
  const streams = memoryStreams();
  const exit = await runCli(["machines", "create", "--name", "dev", "--yes", "--idempotency-key", "operation-1"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => fakeClient({ async createMachine() { creates += 1; return {}; } }),
  });
  assert.equal(exit, EXIT_CODES.unsupported);
  assert.equal(creates, 0);
  assert.equal(JSON.parse(streams.stderr()).error.code, "cuna.capability.unknown");
});

test("malformed remote commands fail before vault, client, or configuration effects", async () => {
  let authCalls = 0;
  let clientCalls = 0;
  let configReads = 0;
  const streams = memoryStreams();
  const exit = await runCli(["machines", "list", "--bogus", "value", "--json"], {
    streams: streams.streams,
    platform: {
      ...platform,
      async readSafeConfig() { configReads += 1; return { exists: false }; },
    },
    humanAuth: {
      async acquireAccessToken() { authCalls += 1; return "never"; },
    },
    clientFactory: () => {
      clientCalls += 1;
      return fakeClient();
    },
  });
  assert.equal(exit, EXIT_CODES.usage);
  assert.equal(authCalls, 0);
  assert.equal(clientCalls, 0);
  assert.equal(configReads, 0);
  assert.equal(JSON.parse(streams.stderr()).error.code, "cuna.usage.invalid");
});

test("root options cannot bypass validation by falling through to help", async () => {
  const streams = memoryStreams();
  const exit = await runCli(["--timeout-ms", "not-a-number", "--json"], { streams: streams.streams });
  assert.equal(exit, EXIT_CODES.usage);
  assert.equal(streams.stdout(), "");
  assert.equal(JSON.parse(streams.stderr()).error.code, "cuna.usage.invalid");
});

test("advertised native capability admits exactly one documented mutation", async () => {
  let creates = 0;
  let key;
  const streams = memoryStreams();
  const client = fakeClient({
    async discoverCapabilities() {
      return capabilitySnapshot([{
        id: "machines.create",
        availability: "supported",
        interaction: "native",
        mutationClass: "financial",
        surfaces: ["cli"],
        requiredPermissions: ["machines:create"],
      }]);
    },
    async createMachine(_body, idempotencyKey) {
      creates += 1;
      key = idempotencyKey;
      return { id: "m_1", name: "dev", state: "creating" };
    },
    async getMachine(id) { return { id, name: "dev", state: "creating" }; },
  });
  const exit = await runCli(["machines", "create", "--name", "dev", "--yes", "--idempotency-key", "operation-1"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  });
  assert.equal(exit, EXIT_CODES.success);
  assert.equal(creates, 1);
  assert.equal(key, "operation-1");
  assert.equal(JSON.parse(streams.stdout()).data.state, "creating");
});

test("machine lifecycle uses the producer-owned grouped capability ID", async () => {
  const discoveries = [];
  let transitions = 0;
  const streams = memoryStreams();
  const client = fakeClient({
    async discoverCapabilities(scope, resourceId) {
      discoveries.push({ scope, resourceId });
      return capabilitySnapshot([{
        id: "machines.lifecycle",
        availability: "supported",
        interaction: "native",
        mutationClass: "reversible",
        surfaces: ["cli"],
        requiredPermissions: ["machines:update"],
      }], scope, resourceId);
    },
    async transitionMachine(id, action) {
      transitions += 1;
      assert.equal(id, MACHINE_ID);
      assert.equal(action, "pause");
      return { id, name: "dev", state: "paused" };
    },
    async getMachine(id) { return { id, name: "dev", state: "paused" }; },
  });
  const exit = await runCli(["machines", "pause", MACHINE_ID, "--yes"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  });
  assert.equal(exit, EXIT_CODES.success);
  assert.equal(transitions, 1);
  assert.deepEqual(discoveries, [{ scope: "machine", resourceId: MACHINE_ID }]);
  assert.equal(JSON.parse(streams.stdout()).data.state, "paused");
});

test("terminal supervisor update is an explicit OpenCode-only remediation and preserves lifecycle ownership", async () => {
  const discoveries = [];
  let replacements = 0;
  let lifecycleTransitions = 0;
  const streams = memoryStreams();
  const client = fakeClient({
    async discoverCapabilities(scope, resourceId) {
      discoveries.push({ scope, resourceId });
      if (discoveries.length === 1) {
        return capabilitySnapshot([{
          id: "agent_sessions.create",
          availability: "unsupported",
          interaction: "native",
          mutationClass: "reversible",
          surfaces: ["cli"],
          requiredPermissions: ["agent_sessions:create"],
          reasonCode: "opencode_supervisor_upgrade_required",
        }], scope, resourceId);
      }
      return capabilitySnapshot([{
        id: "machines.lifecycle",
        availability: "supported",
        interaction: "native",
        mutationClass: "reversible",
        surfaces: ["cli"],
        requiredPermissions: ["machines:update"],
      }], scope, resourceId);
    },
    async getMachine(id) {
      return { id, name: "open-dev", state: "stopped", agent: "opencode" };
    },
    async transitionMachine() {
      lifecycleTransitions += 1;
      throw new Error("the explicit supervisor action must not transition lifecycle");
    },
    async replaceMachineSupervisor(id) {
      replacements += 1;
      assert.equal(id, MACHINE_ID);
      return { id, name: "open-dev", state: "running", agent: "opencode" };
    },
  });
  const exit = await runCli(["machines", "update-supervisor", MACHINE_ID, "--yes", "--json"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  });
  assert.equal(exit, EXIT_CODES.success, streams.stderr());
  assert.equal(replacements, 1);
  assert.equal(lifecycleTransitions, 0);
  assert.deepEqual(discoveries, [
    { scope: "machine", resourceId: MACHINE_ID },
    { scope: "machine", resourceId: MACHINE_ID },
  ]);
  const record = JSON.parse(streams.stdout());
  assert.equal(record.command, "machines.update-supervisor");
  assert.equal(record.data.state, "running");
});

test("terminal supervisor update admits a stopped OpenCode runtime-unverified preflight", async () => {
  let discoveries = 0;
  let replacements = 0;
  const streams = memoryStreams();
  const exit = await runCli(["machines", "update-supervisor", MACHINE_ID, "--yes", "--json"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => fakeClient({
      async discoverCapabilities(scope, resourceId) {
        discoveries += 1;
        if (discoveries === 1) {
          return capabilitySnapshot([{
            id: "agent_sessions.create",
            availability: "temporarily_unavailable",
            interaction: "native",
            mutationClass: "reversible",
            surfaces: ["cli"],
            requiredPermissions: ["agent_sessions:create"],
            reasonCode: "opencode_runtime_unverified",
          }], scope, resourceId);
        }
        return capabilitySnapshot([{
          id: "machines.lifecycle",
          availability: "supported",
          interaction: "native",
          mutationClass: "reversible",
          surfaces: ["cli"],
          requiredPermissions: ["machines:update"],
        }], scope, resourceId);
      },
      async getMachine(id) {
        return { id, name: "stopped-open-dev", state: "stopped", agent: "opencode" };
      },
      async replaceMachineSupervisor(id) {
        replacements += 1;
        return { id, name: "stopped-open-dev", state: "running", agent: "opencode" };
      },
    }),
  });
  assert.equal(exit, EXIT_CODES.success, streams.stderr());
  assert.equal(replacements, 1);
  assert.equal(JSON.parse(streams.stdout()).data.state, "running");
});

test("terminal supervisor update admits the exact OpenCode protocol-unavailable repair signal", async () => {
  let discoveries = 0;
  let replacements = 0;
  const streams = memoryStreams();
  const exit = await runCli(["machines", "update-supervisor", MACHINE_ID, "--yes", "--json"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => fakeClient({
      async discoverCapabilities(scope, resourceId) {
        discoveries += 1;
        if (discoveries === 1) {
          return capabilitySnapshot([{
            id: "agent_sessions.create",
            availability: "temporarily_unavailable",
            interaction: "native",
            mutationClass: "reversible",
            surfaces: ["cli"],
            requiredPermissions: ["agent_sessions:create"],
            reasonCode: "opencode_supervisor_protocol_unavailable",
          }], scope, resourceId);
        }
        return capabilitySnapshot([{
          id: "machines.lifecycle",
          availability: "supported",
          interaction: "native",
          mutationClass: "reversible",
          surfaces: ["cli"],
          requiredPermissions: ["machines:update"],
        }], scope, resourceId);
      },
      async getMachine(id) {
        return { id, name: "protocol-open-dev", state: "stopped", agent: "opencode" };
      },
      async replaceMachineSupervisor(id) {
        replacements += 1;
        return { id, name: "protocol-open-dev", state: "running", agent: "opencode" };
      },
    }),
  });
  assert.equal(exit, EXIT_CODES.success, streams.stderr());
  assert.equal(replacements, 1);
  assert.equal(JSON.parse(streams.stdout()).data.state, "running");
});

test("terminal supervisor update never stops a running Machine or terminates sessions", async () => {
  let replacements = 0;
  let discoveries = 0;
  const streams = memoryStreams();
  const client = fakeClient({
    async discoverCapabilities(scope, resourceId) {
      // The second discovery authorizes the same lifecycle/update authority as
      // start. It is deliberately separate from the unsupported create proof.
      discoveries += 1;
      if (discoveries === 1) {
        return capabilitySnapshot([{
          id: "agent_sessions.create",
          availability: "unsupported",
          interaction: "native",
          mutationClass: "reversible",
          surfaces: ["cli"],
          requiredPermissions: ["agent_sessions:create"],
          reasonCode: "opencode_supervisor_upgrade_required",
        }], scope, resourceId);
      }
      return capabilitySnapshot([{
        id: "machines.lifecycle",
        availability: "supported",
        interaction: "native",
        mutationClass: "reversible",
        surfaces: ["cli"],
        requiredPermissions: ["machines:update"],
      }], scope, resourceId);
    },
    async getMachine(id) {
      return { id, name: "protected-open-dev", state: "running", agent: "opencode" };
    },
    async replaceMachineSupervisor() {
      replacements += 1;
      throw new Error("must not replace a running Machine");
    },
  });
  const exit = await runCli(["machines", "update-supervisor", MACHINE_ID, "--yes", "--json"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  });
  assert.equal(exit, EXIT_CODES.conflict);
  assert.equal(replacements, 0);
  const error = JSON.parse(streams.stderr()).error;
  assert.equal(error.code, "cuna.machine.supervisor_update_requires_stopped");
  assert.match(error.hint, /will not stop protected-open-dev or terminate any AgentSessions/u);
});

test("terminal supervisor update remains hidden unless the exact OpenCode prerequisite is advertised", async () => {
  let machineReads = 0;
  let replacements = 0;
  const streams = memoryStreams();
  const exit = await runCli(["machines", "update-supervisor", MACHINE_ID, "--yes", "--json"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => fakeClient({
      async discoverCapabilities(scope, resourceId) {
        return capabilitySnapshot([{
          id: "agent_sessions.create",
          availability: "unsupported",
          interaction: "native",
          mutationClass: "reversible",
          surfaces: ["cli"],
          requiredPermissions: ["agent_sessions:create"],
          reasonCode: "supervisor_upgrade_required",
        }], scope, resourceId);
      },
      async getMachine() { machineReads += 1; throw new Error("must not inspect a hidden remediation"); },
      async replaceMachineSupervisor() { replacements += 1; throw new Error("must not replace"); },
    }),
  });
  assert.equal(exit, EXIT_CODES.unsupported);
  assert.equal(machineReads, 0);
  assert.equal(replacements, 0);
  assert.equal(JSON.parse(streams.stderr()).error.code, "cuna.capability.unsupported");
});

test("mutations fail closed when independent readback contradicts the write response", async () => {
  // TWO ANSWERS, DELIBERATELY DIFFERENT, and the difference is the fix.
  //
  // A machine that has not reached the requested state yet is a state the
  // producer may still be converging to, so the CLI reads back until its own
  // budget elapses and then reports THAT -- `cuna.client.convergence_budget_elapsed`,
  // exit 5, retryable. An API key still listed as active after revocation is
  // read from a list the producer answered authoritatively in the same breath,
  // and stays a postcondition contradiction at exit 6.
  const cases = [
    {
      argv: ["machines", "pause", MACHINE_ID, "--yes", "--json"],
      capability: "machines.lifecycle",
      scope: "machine",
      exit: EXIT_CODES.network,
      code: "cuna.client.convergence_budget_elapsed",
      client: {
        async transitionMachine(id) { return { id, name: "dev", state: "paused" }; },
        async getMachine(id) { return { id, name: "dev", state: "running" }; },
      },
    },
    {
      argv: ["api-keys", "revoke", "11111111-1111-4111-8111-111111111111", "--yes", "--json"],
      capability: "api_keys.manage",
      scope: "account",
      authority: "interactive",
      exit: EXIT_CODES.conflict,
      code: "cuna.remote.postcondition_unverified",
      client: {
        async revokeApiKey() { return true; },
        async listApiKeys() { return [{ id: "11111111-1111-4111-8111-111111111111", name: "still-active", prefix: "cuna_sk_", lastFour: "WXYZ", createdAt: "2026-08-08T00:00:00.000Z", expiresAt: null, lastUsedAt: null, revokedAt: null }]; },
      },
    },
  ];
  for (const candidate of cases) {
    const streams = memoryStreams();
    const client = fakeClient({
      async discoverCapabilities(scope, resourceId) {
        return capabilitySnapshot([{ id: candidate.capability, availability: "supported", interaction: "native", mutationClass: "reversible", surfaces: ["cli"], requiredPermissions: ["write"] }], scope, resourceId);
      },
      ...candidate.client,
    });
    const authority = candidate.authority === "interactive"
      ? {
          env: {},
          humanAuth: { async acquireAccessToken() { return `cuna_at_${"b".repeat(43)}`; } },
        }
      : { env: { CUNA_API_KEY: API_KEY } };
    let convergenceClock = 0;
    assert.equal(await runCli(candidate.argv, {
      streams: streams.streams,
      platform,
      ...authority,
      now: () => Date.parse("2026-08-08T00:00:00Z"),
      convergencePoller: {
        now: () => convergenceClock,
        async sleep(milliseconds) { convergenceClock += milliseconds; },
      },
      clientFactory: () => client,
    }), candidate.exit);
    assert.equal(JSON.parse(streams.stderr()).error.code, candidate.code);
  }
});

function agentSession(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    machineId: "22222222-2222-4222-8222-222222222222",
    workspaceBindingId: "33333333-3333-4333-8333-333333333333",
    workspaceGeneration: 7,
    name: "primary",
    agent: "claude-code",
    cwd: "/workspace",
    authMode: "interactive_login",
    desiredState: "running",
    requestState: "launch_pending",
    processState: "unknown",
    rowVersion: 0,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

test("AgentSession termination waits for a fenced supervisor terminal observation", async () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  let now = 0;
  let sleeps = 0;
  let reads = 0;
  let terminations = 0;
  const client = fakeClient({
    async discoverCapabilities(scope, resourceId) {
      assert.equal(scope, "agent_session");
      assert.equal(resourceId, sessionId);
      return capabilitySnapshot([{
        id: "agent_sessions.terminate",
        availability: "supported",
        interaction: "native",
        mutationClass: "destructive",
        surfaces: ["cli"],
        requiredPermissions: ["agent_sessions:terminate"],
      }], scope, resourceId);
    },
    async terminateAgentSession(id) {
      assert.equal(id, sessionId);
      terminations += 1;
      return agentSession({
        id,
        desiredState: "terminated",
        requestState: "termination_pending",
        processState: "ready",
      });
    },
    async getAgentSession(id) {
      assert.equal(id, sessionId);
      reads += 1;
      return reads === 1
        ? agentSession({
          id,
          desiredState: "terminated",
          requestState: "termination_pending",
          processState: "ready",
        })
        : agentSession({
          id,
          desiredState: "terminated",
          requestState: "terminal",
          processState: "terminated",
        });
    },
  });
  const streams = memoryStreams();
  const exit = await runCli([
    "agent-sessions", "terminate", sessionId, "--yes",
  ], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    convergencePoller: {
      now: () => now,
      async sleep(milliseconds) {
        sleeps += 1;
        now += milliseconds;
      },
    },
    clientFactory: () => client,
  });
  assert.equal(exit, EXIT_CODES.success);
  assert.equal(terminations, 1);
  assert.equal(reads, 2);
  assert.equal(sleeps, 1);
  const record = JSON.parse(streams.stdout());
  assert.equal(record.data.request_state, "terminal");
  assert.equal(record.data.process_state, "terminated");
});

test("AgentSession termination fails closed only when the terminal observation deadline expires", async () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  let now = 0;
  let sleeps = 0;
  let reads = 0;
  let terminations = 0;
  const client = fakeClient({
    async discoverCapabilities(scope, resourceId) {
      assert.equal(scope, "agent_session");
      assert.equal(resourceId, sessionId);
      return capabilitySnapshot([{
        id: "agent_sessions.terminate",
        availability: "supported",
        interaction: "native",
        mutationClass: "destructive",
        surfaces: ["cli"],
        requiredPermissions: ["agent_sessions:terminate"],
      }], scope, resourceId);
    },
    async terminateAgentSession(id) {
      assert.equal(id, sessionId);
      terminations += 1;
      return agentSession({
        id,
        desiredState: "terminated",
        requestState: "termination_pending",
        processState: "ready",
      });
    },
    async getAgentSession(id) {
      assert.equal(id, sessionId);
      reads += 1;
      return agentSession({
        id,
        desiredState: "terminated",
        requestState: "termination_pending",
        processState: "ready",
      });
    },
  });
  const streams = memoryStreams();
  const exit = await runCli([
    "agent-sessions", "terminate", sessionId, "--yes",
  ], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    convergencePoller: {
      now: () => now,
      async sleep(milliseconds) {
        sleeps += 1;
        now += milliseconds;
      },
    },
    clientFactory: () => client,
  });
  // The CLI's own convergence budget elapsed. That is not the producer failing
  // and not a state contradiction, so it is exit 5 and retryable, naming the
  // read that settles it -- not exit 6 with `retryable: false`.
  assert.equal(exit, EXIT_CODES.network);
  assert.equal(terminations, 1);
  assert.equal(sleeps, 60);
  assert.equal(now, 30_000);
  assert.equal(reads, 61);
  const record = JSON.parse(streams.stderr());
  assert.equal(record.error.code, "cuna.client.convergence_budget_elapsed");
  assert.equal(record.error.retryable, true);
  assert.equal(record.error.details.observed_desired_state, "terminated");
  assert.equal(record.error.details.observed_request_state, "termination_pending");
  assert.equal(record.error.details.settle_with, `cuna agent-sessions get ${sessionId}`);
});

test("agent-sessions get shows all three states when they disagree", async () => {
  // The timeout above names this exact command as the way to settle a session,
  // and it reports desired/request/process because one state cannot explain
  // anything on its own. The human rendering used to print processState alone,
  // so a session that is terminated/termination_pending/running displayed as a
  // plain "running" — the disagreement replaced by the word that hides it.
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const disagreeing = {
    desiredState: "terminated",
    requestState: "termination_pending",
    processState: "running",
  };
  const streams = memoryStreams({ stdoutIsTTY: true, stderrIsTTY: true });
  const exit = await runCli(["agent-sessions", "get", sessionId], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => fakeClient({
      async getAgentSession(id) {
        assert.equal(id, sessionId);
        return agentSession({ id, ...disagreeing });
      },
    }),
  });
  assert.equal(exit, EXIT_CODES.success, streams.stderr());
  const printed = streams.stdout();
  assert.match(printed, /terminated\/termination_pending\/running/u, printed);
  // NEGATIVE CONTROL: a settled session must stay a single word, or every
  // healthy row becomes noise and the triple stops meaning "look here".
  const settledStreams = memoryStreams({ stdoutIsTTY: true, stderrIsTTY: true });
  const settledExit = await runCli(["agent-sessions", "get", sessionId], {
    streams: settledStreams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => fakeClient({
      async getAgentSession(id) {
        return agentSession({
          id,
          desiredState: "terminated",
          requestState: "terminal",
          processState: "terminated",
        });
      },
    }),
  });
  assert.equal(settledExit, EXIT_CODES.success, settledStreams.stderr());
  // Check the state FIELD, not the whole line: the cwd is a path and contains
  // the separator this control looks for.
  const settledState = settledStreams.stdout().trimEnd().split("\t")[3];
  assert.equal(settledState, "terminated", settledStreams.stdout());
});

test("AgentSession create keeps auth mode explicit and rename is capability-gated", async () => {
  const machineId = "22222222-2222-4222-8222-222222222222";
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const bindingId = "44444444-4444-4444-8444-444444444444";
  const workspaceBindingId = "33333333-3333-4333-8333-333333333333";
  const calls = [];
  const client = fakeClient({
    async getMachine(id) { return { id, name: "codex-machine", state: "running", agent: "codex" }; },
    async discoverCapabilities(scope, resourceId) {
      const id = scope === "machine" ? "agent_sessions.create" : "agent_sessions.rename";
      return capabilitySnapshot([{
        id,
        availability: "supported",
        interaction: "native",
        mutationClass: "reversible",
        surfaces: ["cli"],
        requiredPermissions: [`${id}:permission`],
      }], scope, resourceId);
    },
    async createAgentSession(observedMachine, input, key) {
      calls.push({ operation: "create", observedMachine, input, key });
      return agentSession({ machineId: observedMachine, name: input.name, agent: input.agent, cwd: input.cwd, authMode: input.authMode });
    },
    async getAgentSession(id) {
      const created = calls.find((entry) => entry.operation === "create");
      const renamed = calls.find((entry) => entry.operation === "rename");
      return agentSession({
        id,
        name: renamed?.name ?? created?.input.name ?? "review",
        agent: created?.input.agent ?? "claude-code",
        cwd: created?.input.cwd ?? "/workspace",
        workspaceBindingId: created?.input.workspaceBindingId ?? workspaceBindingId,
        workspaceGeneration: created?.input.workspaceGeneration ?? 7,
        authMode: created?.input.authMode ?? "interactive_login",
      });
    },
    async renameAgentSession(id, name) {
      calls.push({ operation: "rename", id, name });
      return agentSession({ id, name });
    },
  });

  const createStreams = memoryStreams();
  const createExit = await runCli([
    "agent-sessions", "create", "--machine", machineId, "--name", "review",
    "--workspace-binding-id", workspaceBindingId, "--workspace-generation", "7",
    "--agent", "codex", "--cwd", "/workspace/repo", "--auth-mode", "credential_binding",
    "--credential-binding", bindingId, "--idempotency-key", "operation-1", "--yes",
  ], {
    streams: createStreams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  });
  assert.equal(createExit, EXIT_CODES.success);
  assert.deepEqual(calls[0], {
    operation: "create",
    observedMachine: machineId,
    input: {
      name: "review",
      agent: "codex",
      cwd: "/workspace/repo",
      workspaceBindingId,
      workspaceGeneration: 7,
      authMode: "credential_binding",
      credentialBindingId: bindingId,
    },
    key: "operation-1",
  });
  assert.equal(JSON.parse(createStreams.stdout()).data.process_state, "unknown");

  const renameStreams = memoryStreams();
  const renameExit = await runCli([
    "agent-sessions", "rename", sessionId, "--name", "renamed", "--yes",
  ], {
    streams: renameStreams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  });
  assert.equal(renameExit, EXIT_CODES.success);
  assert.deepEqual(calls[1], { operation: "rename", id: sessionId, name: "renamed" });
  assert.equal(JSON.parse(renameStreams.stdout()).data.name, "renamed");
});

test("AgentSession create rejects a provider not installed on the machine before capability discovery or mutation", async () => {
  let capabilityReads = 0;
  let creates = 0;
  const streams = memoryStreams();
  const exit = await runCli([
    "agent-sessions", "create", "--machine", MACHINE_ID,
    "--workspace-binding-id", "44444444-4444-4444-8444-444444444444",
    "--workspace-generation", "1", "--agent", "codex", "--yes", "--json",
  ], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => fakeClient({
      async getMachine(id) { return { id, name: "claude-only", state: "running", agent: "claude-code" }; },
      async discoverCapabilities() { capabilityReads += 1; return capabilitySnapshot([]); },
      async createAgentSession() { creates += 1; throw new Error("unreachable"); },
    }),
  });
  assert.equal(exit, EXIT_CODES.unsupported);
  assert.equal(capabilityReads, 0);
  assert.equal(creates, 0);
  const error = JSON.parse(streams.stderr()).error;
  assert.equal(error.code, "cuna.agent.provider_not_installed");
  assert.match(error.message, /Codex is unavailable on machine claude-only.*Declared installed provider: Claude/u);
  assert.match(error.hint, /machines create --agent codex/u);
});

test("OpenCode create names a supervisor prerequisite before any session dispatch", async () => {
  let creates = 0;
  const streams = memoryStreams();
  const exit = await runCli([
    "agent-sessions", "create", "--machine", MACHINE_ID,
    "--workspace-binding-id", "33333333-3333-4333-8333-333333333333",
    "--workspace-generation", "7", "--agent", "opencode", "--cwd", "/workspace/repo",
    "--yes", "--json",
  ], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => fakeClient({
      async getMachine(id) { return { id, name: "open-dev", state: "running", agent: "opencode" }; },
      async discoverCapabilities(scope, resourceId) {
        return capabilitySnapshot([{
          id: "agent_sessions.create",
          availability: "unsupported",
          interaction: "native",
          mutationClass: "reversible",
          surfaces: ["cli"],
          requiredPermissions: ["agent_sessions:create"],
          reasonCode: "opencode_supervisor_upgrade_required",
        }], scope, resourceId);
      },
      async createAgentSession() { creates += 1; throw new Error("unreachable"); },
    }),
  });
  assert.equal(exit, EXIT_CODES.unsupported);
  assert.equal(creates, 0);
  const error = JSON.parse(streams.stderr()).error;
  assert.equal(error.code, "cuna.agent.opencode_supervisor_upgrade_required");
  assert.match(error.hint, /No OpenCode AgentSession was created/u);
  assert.match(error.hint, /Update terminal supervisor/u);
  assert.match(error.hint, /will not stop the Machine or terminate sessions/u);
});

test("OpenCode runtime verification is a retryable no-create result", async () => {
  let creates = 0;
  const streams = memoryStreams();
  const exit = await runCli([
    "agent-sessions", "create", "--machine", MACHINE_ID,
    "--workspace-binding-id", "33333333-3333-4333-8333-333333333333",
    "--workspace-generation", "7", "--agent", "opencode", "--cwd", "/workspace/repo",
    "--yes", "--json",
  ], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => fakeClient({
      async getMachine(id) { return { id, name: "open-verifying", state: "running", agent: "opencode" }; },
      async discoverCapabilities(scope, resourceId) {
        return capabilitySnapshot([{
          id: "agent_sessions.create",
          availability: "temporarily_unavailable",
          interaction: "native",
          mutationClass: "reversible",
          surfaces: ["cli"],
          requiredPermissions: ["agent_sessions:create"],
          reasonCode: "opencode_runtime_unverified",
        }], scope, resourceId);
      },
      async createAgentSession() { creates += 1; throw new Error("unreachable"); },
    }),
  });
  assert.equal(exit, EXIT_CODES.network);
  assert.equal(creates, 0);
  const error = JSON.parse(streams.stderr()).error;
  assert.equal(error.code, "cuna.agent.opencode_runtime_unverified");
  assert.equal(error.retryable, true);
  assert.match(error.hint, /No OpenCode AgentSession was created/u);
  assert.match(error.hint, /will not create another Machine/u);
});

test("OpenCode protocol-unavailable evidence names a replacement before any session dispatch", async () => {
  let creates = 0;
  const streams = memoryStreams();
  const exit = await runCli([
    "agent-sessions", "create", "--machine", MACHINE_ID,
    "--workspace-binding-id", "33333333-3333-4333-8333-333333333333",
    "--workspace-generation", "7", "--agent", "opencode", "--cwd", "/workspace/repo",
    "--yes", "--json",
  ], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => fakeClient({
      async getMachine(id) { return { id, name: "protocol-open-dev", state: "running", agent: "opencode" }; },
      async discoverCapabilities(scope, resourceId) {
        return capabilitySnapshot([{
          id: "agent_sessions.create",
          availability: "temporarily_unavailable",
          interaction: "native",
          mutationClass: "reversible",
          surfaces: ["cli"],
          requiredPermissions: ["agent_sessions:create"],
          reasonCode: "opencode_supervisor_protocol_unavailable",
        }], scope, resourceId);
      },
      async createAgentSession() { creates += 1; throw new Error("unreachable"); },
    }),
  });
  assert.equal(exit, EXIT_CODES.unsupported);
  assert.equal(creates, 0);
  const error = JSON.parse(streams.stderr()).error;
  assert.equal(error.code, "cuna.agent.opencode_supervisor_upgrade_required");
  assert.equal(error.details.reason, "opencode_supervisor_protocol_unavailable");
  assert.match(error.hint, /cannot provide the OpenCode protocol/u);
});

test("OpenCode AgentSession creation uses live machine and capability evidence, not a local flag", async () => {
  let effects = 0;
  const client = fakeClient({
    async getMachine(id) { return { id, name: "open-dev", state: "running", agent: "opencode" }; },
    async discoverCapabilities(scope, resourceId) {
      effects += 1;
      return capabilitySnapshot([{
        id: "agent_sessions.create",
        availability: "supported",
        interaction: "native",
        mutationClass: "reversible",
        surfaces: ["cli"],
        requiredPermissions: ["agent_sessions:create"],
      }], scope, resourceId);
    },
    async createAgentSession(machineId, input) {
      effects += 1;
      return agentSession({ machineId, agent: input.agent, cwd: input.cwd, authMode: input.authMode });
    },
    async getAgentSession(id) {
      effects += 1;
      return agentSession({
        id,
        machineId: MACHINE_ID,
        workspaceBindingId: "33333333-3333-4333-8333-333333333333",
        workspaceGeneration: 7,
        agent: "opencode",
        cwd: "/workspace/repo",
        authMode: "interactive_login",
      });
    },
  });
  const streams = memoryStreams();
  const exit = await runCli([
    "agent-sessions", "create", "--machine", MACHINE_ID,
    "--workspace-binding-id", "33333333-3333-4333-8333-333333333333",
    "--workspace-generation", "7", "--agent", "opencode", "--cwd", "/workspace/repo",
    "--yes",
  ], {
    streams: streams.streams,
    platform: {
      ...platform,
      async readSafeConfig() { effects += 1; return { exists: false }; },
    },
    env: { CUNA_API_KEY: API_KEY, CUNA_OPENCODE_ENABLED: "false" },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => { effects += 1; return client; },
  });
  assert.equal(exit, EXIT_CODES.success);
  const record = JSON.parse(streams.stdout());
  assert.equal(record.data.agent, "opencode");
  assert.equal(record.data.auth_mode, "interactive_login");
  assert.ok(effects > 0);
});

test("OpenCode AgentSession creation rejects credential-binding auth before effects", async () => {
  let effects = 0;
  const client = fakeClient({
    async discoverCapabilities() { effects += 1; return capabilitySnapshot([]); },
    async createAgentSession() { effects += 1; throw new Error("unreachable"); },
  });
  for (const suffix of [
    ["--auth-mode", "credential_binding"],
    ["--credential-binding", "44444444-4444-4444-8444-444444444444"],
  ]) {
    const streams = memoryStreams();
    const exit = await runCli([
      "agent-sessions", "create", "--machine", MACHINE_ID,
      "--workspace-binding-id", "33333333-3333-4333-8333-333333333333",
      "--workspace-generation", "7", "--agent", "opencode", "--cwd", "/workspace/repo",
      ...suffix,
      "--yes",
    ], {
      streams: streams.streams,
      platform,
      env: { CUNA_API_KEY: API_KEY },
      clientFactory: () => client,
    });
    assert.equal(exit, EXIT_CODES.usage);
    assert.match(streams.stderr(), /interactive_login only/u);
  }
  assert.equal(effects, 0);
});

test("OpenCode machine creation is stopped by a live backend capability refusal before mutation", async () => {
  let capabilityReads = 0;
  let creates = 0;
  const streams = memoryStreams();
  const exit = await runCli([
    "machines", "create", "--name", "open-dev", "--agent", "opencode", "--yes",
  ], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY, CUNA_OPENCODE_ENABLED: "true" },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => fakeClient({
      async discoverCapabilities(scope, resourceId) {
        capabilityReads += 1;
        return capabilitySnapshot([{
          id: "machines.create",
          availability: "unsupported",
          interaction: "native",
          mutationClass: "reversible",
          surfaces: ["cli"],
          requiredPermissions: ["machines:create"],
          reason: "provider_not_advertised",
        }], scope, resourceId);
      },
      async createMachine() { creates += 1; throw new Error("unreachable"); },
    }),
  });
  assert.equal(exit, EXIT_CODES.unsupported);
  assert.equal(capabilityReads, 1);
  assert.equal(creates, 0);
  assert.equal(JSON.parse(streams.stderr()).error.code, "cuna.capability.unsupported");
});

test("OpenCode AgentSession journey surfaces the server's compatible-Machine remedy", async () => {
  const requests = [];
  const streams = memoryStreams();
  const exit = await runCli([
    "agent-sessions", "create", "--machine", MACHINE_ID,
    "--workspace-binding-id", "33333333-3333-4333-8333-333333333333",
    "--workspace-generation", "7", "--agent", "opencode", "--cwd", "/workspace/repo", "--yes",
  ], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    fetch: async (url, init) => {
      const request = { url: url.toString(), method: init?.method ?? "GET" };
      requests.push(request);
      if (request.method === "GET" && request.url.endsWith(`/v1/sessions/${MACHINE_ID}`)) {
        return new Response(JSON.stringify({ id: MACHINE_ID, name: "open-dev", status: "running", agent: "opencode" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (request.method === "GET" && request.url.startsWith("https://api.getcuna.com/v1/capabilities?")) {
        return new Response(JSON.stringify({
          schema_version: "1.0",
          subject_scope: "machine",
          subject_id: MACHINE_ID,
          observed_at: "2026-08-08T00:00:00.000Z",
          expires_at: future,
          etag: "agent-session-create",
          capabilities: [{
            id: "agent_sessions.create",
            availability: "supported",
            interaction: "native",
            mutation_class: "reversible",
            surfaces: ["cli"],
            required_permissions: ["agent_sessions:create"],
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (request.method === "POST" && request.url === `https://api.getcuna.com/v1/sessions/${MACHINE_ID}/agent-sessions`) {
        return new Response(JSON.stringify({
          type: "https://api.getcuna.com/problems/agent_session_provider_unavailable",
          title: "Agent provider unavailable",
          status: 409,
          code: "agent_session_provider_unavailable",
          request_id: "55555555-5555-4555-8555-555555555555",
          retryable: false,
          detail: "The requested provider is not installed on this Machine.",
          action: "none",
        }), { status: 409, headers: { "content-type": "application/problem+json" } });
      }
      assert.fail(`unexpected request ${request.method} ${request.url}`);
    },
  });
  const error = JSON.parse(streams.stderr()).error;
  assert.equal(exit, EXIT_CODES.unsupported, JSON.stringify({ requests, error }));
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0], {
    url: `https://api.getcuna.com/v1/sessions/${MACHINE_ID}`,
    method: "GET",
  });
  assert.match(requests[1].url, /^https:\/\/api\.getcuna\.com\/v1\/capabilities\?/u);
  assert.deepEqual(requests[2], {
    url: `https://api.getcuna.com/v1/sessions/${MACHINE_ID}/agent-sessions`,
    method: "POST",
  });
  assert.equal(error.code, "cuna.agent.provider_not_installed");
  assert.match(error.hint, /Machine configured for OpenCode/u);
});

test("OpenCode create rejects a remotely downgraded auth mode after authoritative readback", async () => {
  let effects = 0;
  const client = fakeClient({
    async getMachine(id) { return { id, name: "open-dev", state: "running", agent: "opencode" }; },
    async discoverCapabilities(scope, resourceId) {
      effects += 1;
      return capabilitySnapshot([{
        id: "agent_sessions.create",
        availability: "supported",
        interaction: "native",
        mutationClass: "reversible",
        surfaces: ["cli"],
        requiredPermissions: ["agent_sessions:create"],
      }], scope, resourceId);
    },
    async createAgentSession(machineId) {
      effects += 1;
      return agentSession({ machineId, agent: "opencode", authMode: "interactive_login" });
    },
    async getAgentSession(id) {
      effects += 1;
      return agentSession({ id, agent: "opencode", authMode: "credential_binding" });
    },
  });
  const streams = memoryStreams();
  const exit = await runCli([
    "agent-sessions", "create", "--machine", MACHINE_ID,
    "--workspace-binding-id", "33333333-3333-4333-8333-333333333333",
    "--workspace-generation", "7", "--agent", "opencode", "--yes",
  ], {
    streams: streams.streams,
    platform: { ...platform, async readSafeConfig() { effects += 1; return { exists: false }; } },
    env: { CUNA_API_KEY: API_KEY, CUNA_OPENCODE_ENABLED: "true" },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => { effects += 1; return client; },
  });
  assert.equal(exit, EXIT_CODES.conflict);
  assert.match(streams.stderr(), /postcondition|does not match|authority/iu);
  assert.ok(effects > 0);
});

test("agent logout binds confirmation to one exact AgentSession generation", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const epoch = "33333333-3333-4333-8333-333333333333";
  const calls = [];
  const client = fakeClient({
    async getAgentSession(observedId) {
      calls.push({ operation: "get", id: observedId });
      return agentSession({ id, processEpoch: epoch, processState: "running", requestState: "launched" });
    },
    async discoverCapabilities(scope, resourceId) {
      calls.push({ operation: "capabilities", scope, resourceId });
      return capabilitySnapshot([{
        id: "agent_sessions.auth_logout",
        availability: "supported",
        interaction: "native",
        mutationClass: "destructive",
        surfaces: ["cli"],
        requiredPermissions: ["agent_sessions:update", "auth:interactive"],
      }], scope, resourceId);
    },
    async logoutAgentSessionAuth(observedId, observedEpoch) {
      calls.push({ operation: "logout", id: observedId, epoch: observedEpoch });
      return {
        observationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        agentSessionId: id,
        processEpoch: epoch,
        authMode: "interactive_login",
        agent: "claude-code",
        agentVersion: "2.1.226",
        adapterVersion: "runa.agent-auth.v1",
        observedAt: "2026-08-08T00:00:01.000Z",
        outcome: "logout_confirmed",
      };
    },
    async getAgentSessionAuth(observedId) {
      calls.push({ operation: "observe-auth", id: observedId });
      return {
        observationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        agentSessionId: id,
        processEpoch: epoch,
        authMode: "interactive_login",
        agent: "claude-code",
        agentVersion: "2.1.226",
        adapterVersion: "runa.agent-auth.v1",
        observedAt: "2026-08-08T00:00:02.000Z",
        evidenceClass: "provider_cli_login_status",
        state: "login_required",
      };
    },
  });
  const streams = memoryStreams();
  const exit = await runCli(["agent", "logout", "--agent-session", id, "--yes"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  });
  assert.equal(exit, EXIT_CODES.success);
  assert.equal(JSON.parse(streams.stdout()).data.outcome, "logout_confirmed");
  assert.deepEqual(calls, [
    { operation: "get", id },
    { operation: "capabilities", scope: "agent_session", resourceId: id },
    { operation: "logout", id, epoch },
    { operation: "observe-auth", id },
  ]);

  const denied = memoryStreams();
  assert.notEqual(await runCli(["agent", "logout", "--agent-session", id], {
    streams: denied.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => client,
  }), EXIT_CODES.success);
  assert.equal(calls.length, 4);
});

test("AgentSession capability subject mismatch blocks mutation before the client call", async () => {
  let creates = 0;
  const streams = memoryStreams();
  const client = fakeClient({
    async discoverCapabilities() {
      return capabilitySnapshot([{
        id: "agent_sessions.create",
        availability: "supported",
        interaction: "native",
        mutationClass: "reversible",
        surfaces: ["cli"],
        requiredPermissions: ["agent_sessions:create"],
      }], "machine", "another-machine");
    },
    async createAgentSession() { creates += 1; return agentSession(); },
  });
  const exit = await runCli([
    "agent-sessions", "create", "--machine", "22222222-2222-4222-8222-222222222222",
    "--workspace-binding-id", "33333333-3333-4333-8333-333333333333",
    "--workspace-generation", "7",
    "--agent", "claude-code", "--idempotency-key", "operation-1", "--yes",
  ], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  });
  assert.equal(exit, EXIT_CODES.unsupported);
  assert.equal(creates, 0);
  assert.equal(JSON.parse(streams.stderr()).error.details.reason, "subject_scope_mismatch");
});

test("valid automatic agent intents execute the effects-fenced journey and exact attach", async () => {
  const cases = [
    [
      "claude", "services/api", "--machine", "review", "--new-session", "--no-sync",
      "--auth-mode", "credential_binding", "--credential-binding", "44444444-4444-4444-8444-444444444444",
    ],
    ["codex", ".", "--new", "--auth-mode", "interactive_login"],
  ];
  for (const argv of cases) {
    const phases = [];
    let attached;
    const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
    const invoke = () => runCli(argv, {
      streams: streams.streams,
      platform,
      env: {
        CUNA_API_KEY: "cuna_sk_abcdefghijklmnop",
      },
      clientFactory: () => fakeClient(),
      automaticJourneyEffectsFactory: () => ({
        onPhase(phase) { phases.push(phase); },
        async inspectWorkspace() { return { canonicalLocalRoot: "C:\\work\\project" }; },
        async observeMachines() {
          return [{ id: FOREGROUND_SESSION_A, name: "review", agent: "unknown", requestedAgentSupport: "supported", state: "running", ownership: "owned", freshness: "fresh", recency: "recent", resources: {}, costStatus: "known" }];
        },
        async createMachine() { return { id: FOREGROUND_SESSION_A, state: "running" }; },
        async reconcileMachineCreate() { return "unreconcilable"; },
        async ensureMachineReady({ machineId }) { return { id: machineId, state: "running" }; },
        async synchronizeWorkspace() { return { bindingId: FOREGROUND_SESSION_B, workspaceIdentity: FOREGROUND_SESSION_B, generation: 1, remoteCwd: "/workspace/projects/project" }; },
        async observeAgentSessions() { return []; },
        async createAgentSession({ machineId }) { return { id: FOREGROUND_SESSION_C, machineId }; },
        async ensureAgentSessionReady() { return { id: FOREGROUND_SESSION_C, machineId: FOREGROUND_SESSION_A }; },
        async attach(input) { attached = { id: input.agentSessionId, agent: input.expectedAgent }; },
        async reconcileCancellation() {},
      }),
    });
    const exit = await invoke();
    assert.equal(exit, EXIT_CODES.success);
    assert.deepEqual(attached, { id: FOREGROUND_SESSION_C, agent: argv[0] === "claude" ? "claude-code" : argv[0] });
    assert.equal(phases[0], "inspect-workspace");
    assert.equal(phases.at(-1), "attach");
  }
});

test("TC-004-01 explicit agent shorthand binds one AgentSession and its expected agent kind", async () => {
  const expectations = [
    ["claude", "claude-code"],
    ["codex", "codex"],
  ];
  for (const [command, expectedAgent] of expectations) {
    let observed;
    const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
    const exit = await runCli([command, "--agent-session", FOREGROUND_SESSION_A], {
      streams: streams.streams,
      platform,
      env: { CUNA_API_KEY: API_KEY, TERM: "xterm-256color" },
      clientFactory: () => fakeClient(),
      foregroundTerminalRunner: async (input) => { observed = input; },
    });
    assert.equal(exit, EXIT_CODES.success);
    assert.deepEqual(observed.agentSessionIds, [FOREGROUND_SESSION_A]);
    assert.deepEqual(observed.expectedAgentKinds, [expectedAgent]);
    assert.equal(streams.stdout(), "");
    const display = expectedAgent === "claude-code" ? "Claude Code" : expectedAgent === "codex" ? "Codex" : "OpenClaw";
    const progress = streams.stderr();
    const visible = stripAnsi(progress).replaceAll("\r", "");
    assert.match(visible, new RegExp(`Preparing ${display}`, "u"));
    assert.match(visible, new RegExp(`Connecting to ${display}`, "u"));
    assert.match(visible, new RegExp(`Attaching to ${display}`, "u"));
    assert.match(progress, /[◐◓◑◒]/u, "the journey should show an immediate spinner");
    assert.match(progress, /[━╺╸]{6}/u, "the journey should show animated progress");
    assert.equal(progress.includes(`${ESCAPE}[38;5;202m`), true, "the spinner should use the Cuna flare accent");
  }
});

test("explicit agent shorthand rejects ambiguous or misleading input before effects", async () => {
  for (const argv of [
    ["claude", ".", "--agent-session", FOREGROUND_SESSION_A],
    ["codex", "--agent-session", "not-a-session"],
    ["openclaw", "--agent-session", FOREGROUND_SESSION_A, "--new"],
    ["opencode", "--agent-session", FOREGROUND_SESSION_A, "--no-sync"],
  ]) {
    let effects = 0;
    const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
    const exit = await runCli(argv, {
      streams: streams.streams,
      platform: { ...platform, async readSafeConfig() { effects += 1; return { exists: false }; } },
      env: {},
      clientFactory: () => { effects += 1; return fakeClient(); },
      foregroundTerminalRunner: async () => { effects += 1; },
    });
    assert.equal(exit, EXIT_CODES.usage);
    assert.equal(effects, 0);
  }
});

test("agent shorthand shows truthful preparation feedback before configuration or network work completes", async () => {
  let releaseConfig;
  const configGate = new Promise((resolve) => { releaseConfig = resolve; });
  const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
  const execution = runCli(["claude", "--agent-session", FOREGROUND_SESSION_A], {
    streams: streams.streams,
    platform: { ...platform, async readSafeConfig() { await configGate; return { exists: false }; } },
    env: { CUNA_API_KEY: API_KEY, TERM: "xterm-256color" },
    clientFactory: () => fakeClient(),
    foregroundTerminalRunner: async () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  const immediate = streams.stderr();
  assert.match(stripAnsi(immediate), /Preparing Claude Code/u);
  assert.match(immediate, /[◐◓◑◒]/u, "feedback should animate before configuration resolves");
  releaseConfig();
  assert.equal(await execution, EXIT_CODES.success);
});

test("OpenCode shorthand directs provider sign-in to its remote TUI before configuration resolves", async () => {
  let releaseConfig;
  const configGate = new Promise((resolve) => { releaseConfig = resolve; });
  const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
  const execution = runCli(["opencode", "--agent-session", FOREGROUND_SESSION_A], {
    streams: streams.streams,
    platform: { ...platform, async readSafeConfig() { await configGate; return { exists: false }; } },
    env: { CUNA_API_KEY: API_KEY, TERM: "xterm-256color" },
    clientFactory: () => fakeClient(),
    foregroundTerminalRunner: async () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  const immediate = streams.stderr();
  assert.match(stripAnsi(immediate), /Preparing OpenCode — use \/connect in its terminal/u);
  assert.match(immediate, /[◐◓◑◒]/u, "feedback should animate before configuration resolves");
  releaseConfig();
  assert.equal(await execution, EXIT_CODES.success);
  assert.match(stripAnsi(streams.stderr()).replaceAll("\r", ""), /Opening OpenCode terminal — use \/connect there/u);
});

test("invalid automatic agent intents fail before config, auth, API, or terminal effects", async () => {
  const invalidIntents = [
    ["claude", "one", "two"],
    ["claude", "--new", "--machine", "existing"],
    ["codex", "--new", "--new-session"],
    ["openclaw", "--no-sync"],
    ["codex", "--auth-mode", "automatic"],
    ["claude", "--auth-mode", "credential_binding"],
    ["codex", "--credential-binding", "44444444-4444-4444-8444-444444444444"],
    ["claude", "--machine", "one", "--machine=two"],
    ["openclaw", "bad\u0000path"],
  ];
  for (const argv of invalidIntents) {
    let effects = 0;
    const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
    const exit = await runCli(argv, {
      streams: streams.streams,
      platform: {
        ...platform,
        async readSafeConfig() { effects += 1; return { exists: false }; },
      },
      env: {},
      humanAuth: {
        async acquireAccessToken() { effects += 1; return "unexpected"; },
      },
      clientFactory: () => { effects += 1; return fakeClient(); },
      foregroundTerminalRunner: async () => { effects += 1; },
    });
    assert.equal(exit, EXIT_CODES.usage);
    assert.equal(effects, 0);
  }
});

test("TC-055-01 connect and AgentSession attach dispatch only explicit session IDs to the foreground runner", async () => {
  const calls = [];
  const runner = async (input) => { calls.push(input); };
  for (const argv of [
    ["connect", FOREGROUND_SESSION_A, FOREGROUND_SESSION_B],
    ["agent-sessions", "attach", FOREGROUND_SESSION_C],
    ["connect", FOREGROUND_SESSION_A, FOREGROUND_SESSION_B, FOREGROUND_SESSION_C],
    ["connect", FOREGROUND_SESSION_A, FOREGROUND_SESSION_B, FOREGROUND_SESSION_C, FOREGROUND_SESSION_D],
  ]) {
    const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
    const exit = await runCli(argv, {
      streams: streams.streams,
      platform,
      env: { CUNA_API_KEY: API_KEY, TERM: "xterm-256color" },
      clientFactory: () => fakeClient(),
      foregroundTerminalRunner: runner,
    });
    assert.equal(exit, EXIT_CODES.success);
    assert.equal(streams.stdout(), "");
    const visibleProgress = stripAnsi(streams.stderr()).replaceAll("\r", "");
    const sessionCount = argv[0] === "agent-sessions" ? argv.length - 2 : argv.length - 1;
    const expectedLabel = sessionCount === 1 ? "Attaching to AgentSession" : `Attaching to ${sessionCount} AgentSessions`;
    assert.match(visibleProgress, new RegExp(expectedLabel, "u"));
  }
  assert.deepEqual(calls.map((call) => call.agentSessionIds), [
    [FOREGROUND_SESSION_A, FOREGROUND_SESSION_B],
    [FOREGROUND_SESSION_C],
    [FOREGROUND_SESSION_A, FOREGROUND_SESSION_B, FOREGROUND_SESSION_C],
    [FOREGROUND_SESSION_A, FOREGROUND_SESSION_B, FOREGROUND_SESSION_C, FOREGROUND_SESSION_D],
  ]);
  assert.equal(calls.every((call) => call.baseUrl === "https://api.getcuna.com"), true);
});

test("TC-055-11 non-TTY and JSON foreground requests fail before auth, configuration, client, or runner effects", async () => {
  for (const input of [
    { argv: ["connect", FOREGROUND_SESSION_A], streams: memoryStreams() },
    { argv: ["connect", FOREGROUND_SESSION_A, "--json"], streams: memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true }) },
    { argv: ["claude", "--agent-session", FOREGROUND_SESSION_A], streams: memoryStreams() },
    { argv: ["codex", "--agent-session", FOREGROUND_SESSION_A, "--json"], streams: memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true }) },
  ]) {
    let effects = 0;
    const exit = await runCli(input.argv, {
      streams: input.streams.streams,
      platform: {
        ...platform,
        async readSafeConfig() { effects += 1; return { exists: false }; },
      },
      env: {},
      humanAuth: {
        async acquireAccessToken() { effects += 1; return "unexpected"; },
      },
      clientFactory: () => { effects += 1; return fakeClient(); },
      foregroundTerminalRunner: async () => { effects += 1; },
    });
    assert.equal(exit, EXIT_CODES.usage);
    assert.equal(effects, 0);
    assert.equal(JSON.parse(input.streams.stderr()).error.code, "cuna.usage.invalid");
  }
});

test("TC-055-07/11 terminal admission keeps Windows rich while selecting truthful fallbacks and preserving NO_COLOR", async () => {
  for (const kind of ["linux", "macos"]) {
    for (const env of [{}, { TERM: "" }, { TERM: "   " }, { TERM: "dumb" }]) {
      let observed;
      const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
      const exit = await runCli(["connect", FOREGROUND_SESSION_A], {
        streams: streams.streams,
        platform: { ...platform, kind },
        env: { ...env, CUNA_API_KEY: API_KEY },
        clientFactory: () => fakeClient(),
        foregroundTerminalRunner: async (input) => { observed = input; },
      });
      assert.equal(exit, EXIT_CODES.success);
      assert.equal(observed.presentationMode, "plain");
    }
  }

  for (const env of [
    { TERM: "xterm-256color", TMUX: "/tmp/tmux" },
    { TERM: "xterm-256color", SSH_TTY: "/dev/pts/1" },
    { TERM: "xterm-256color", CUNA_TERMINAL_MODE: "plain" },
  ]) {
    let observed;
    const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
    assert.equal(await runCli(["connect", FOREGROUND_SESSION_A], {
      streams: streams.streams,
      platform,
      env: { ...env, CUNA_API_KEY: API_KEY },
      clientFactory: () => fakeClient(),
      foregroundTerminalRunner: async (input) => { observed = input; },
    }), EXIT_CODES.success);
    assert.equal(observed.presentationMode, "plain");
  }

  let windowsObserved;
  const windows = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
  assert.equal(await runCli(["connect", FOREGROUND_SESSION_A], {
    streams: windows.streams,
    platform: { ...platform, kind: "windows" },
    env: { CUNA_API_KEY: API_KEY, TERM: "dumb" },
    clientFactory: () => fakeClient(),
    foregroundTerminalRunner: async (input) => { windowsObserved = input; },
  }), EXIT_CODES.success);
  assert.equal(windowsObserved.hostPlatform, "win32");
  assert.equal(windowsObserved.terminalKind, "dumb");
  assert.equal(
    windowsObserved.presentationMode,
    "rich",
    "Windows ConPTY stays capable even when an inherited TERM=dumb value is present",
  );

  let observed;
  const noColor = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
  assert.equal(await runCli(["connect", FOREGROUND_SESSION_A], {
    streams: noColor.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY, NO_COLOR: "1", TERM: "xterm-256color", CUNA_TERMINAL_MODE: "rich" },
    clientFactory: () => fakeClient(),
    foregroundTerminalRunner: async (input) => { observed = input; },
  }), EXIT_CODES.success);
  assert.equal(observed.color, false);
  assert.equal(observed.presentationMode, "rich");
  assert.equal(observed.hostPlatform, "linux");
  assert.equal(observed.terminalKind, "xterm-256color");
});

test("plain fallback rejects multiplexing and invalid mode before configuration, auth, or runner effects", async () => {
  for (const env of [
    { TERM: "dumb" },
    { TERM: "xterm-256color", TMUX: "/tmp/tmux" },
  ]) {
    let effects = 0;
    const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
    const exit = await runCli(["connect", FOREGROUND_SESSION_A, FOREGROUND_SESSION_B], {
      streams: streams.streams,
      platform: { ...platform, async readSafeConfig() { effects += 1; return { exists: false }; } },
      env,
      clientFactory: () => { effects += 1; return fakeClient(); },
      foregroundTerminalRunner: async () => { effects += 1; },
    });
    assert.equal(exit, EXIT_CODES.usage);
    assert.equal(effects, 0);
  }

  let effects = 0;
  const invalid = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
  const exit = await runCli(["connect", FOREGROUND_SESSION_A], {
    streams: invalid.streams,
    platform: { ...platform, async readSafeConfig() { effects += 1; return { exists: false }; } },
    env: { TERM: "xterm", CUNA_TERMINAL_MODE: "decorated" },
    foregroundTerminalRunner: async () => { effects += 1; },
  });
  assert.equal(exit, EXIT_CODES.unsupported);
  assert.equal(effects, 0);
});

test("TC-055-01 malformed, duplicate, and oversized connect identities fail before all effects", async () => {
  const invalid = [
    ["connect"],
    ["connect", FOREGROUND_SESSION_A, FOREGROUND_SESSION_A],
    ["connect", FOREGROUND_SESSION_A, FOREGROUND_SESSION_B, FOREGROUND_SESSION_C, "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"],
    ["connect", "bad/session"],
  ];
  for (const argv of invalid) {
    let effects = 0;
    const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
    const exit = await runCli(argv, {
      streams: streams.streams,
      platform: { ...platform, async readSafeConfig() { effects += 1; return { exists: false }; } },
      foregroundTerminalRunner: async () => { effects += 1; },
    });
    assert.equal(exit, EXIT_CODES.usage);
    assert.equal(effects, 0);
  }
});

test("doctor keeps the local encrypted-store probe separate from the unprobed remote browser-login bootstrap", async () => {
  for (const kind of ["windows"]) {
    const streams = memoryStreams();
    let remoteCalls = 0;
    const exit = await runCli(["doctor"], {
      streams: streams.streams,
      platform: { ...platform, kind },
      env: {},
      doctorCredentialBackend: {
        backendId: "cuna-local-aes256gcm-v1",
        async probe() {
          return {
            protocol: CREDENTIAL_BACKEND_PROTOCOL,
            backendId: "cuna-local-aes256gcm-v1",
            platform: "windows",
            status: "verified",
            observedAt: Date.parse("2026-08-08T00:00:00.000Z"),
            expiresAt: Date.parse("2026-08-08T00:01:00.000Z"),
            source: "encrypted_local_file",
          };
        },
      },
      fetch: async () => {
        remoteCalls += 1;
        throw new Error("default doctor must not make a network request");
      },
    });
    assert.equal(exit, EXIT_CODES.success);
    const browserAuth = JSON.parse(streams.stdout()).data.runtime_features.find((item) => item.feature === "browser_auth");
    const remoteBrowserLogin = JSON.parse(streams.stdout()).data.runtime_features.find((item) => item.feature === "browser_login_remote");
    const encryptedStore = JSON.parse(streams.stdout()).data.runtime_features.find((item) => item.feature === "encrypted_local_session_store");
    assert.equal(remoteCalls, 0);
    assert.equal(browserAuth.implementation, "unsupported");
    assert.equal(browserAuth.reason, "remote_browser_login_not_checked");
    assert.equal(remoteBrowserLogin.implementation, "unsupported");
    assert.equal(remoteBrowserLogin.reason, "remote_browser_login_not_checked");
    assert.equal(encryptedStore.implementation, "available");
    assert.equal(encryptedStore.reason, "encrypted_local_aes256gcm_verified");
  }
});

test("doctor probes browser login only when explicitly requested and composes it with the local AES gate", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "cuna-doctor-remote-"));
  try {
    const streams = memoryStreams();
    let remoteCalls = 0;
    let localStoreProbes = 0;
    const exit = await runCli(["doctor", "--check-browser-login"], {
      streams: streams.streams,
      platform: {
        kind: "linux",
        paths: { configDirectory, stateDirectory: configDirectory, runtimeDirectory: configDirectory },
        async readSafeConfig() { return { exists: false }; },
      },
      env: {},
      doctorCredentialBackend: {
        backendId: "cuna-local-aes256gcm-v1",
        async probe() {
          localStoreProbes += 1;
          return {
            protocol: CREDENTIAL_BACKEND_PROTOCOL,
            backendId: "cuna-local-aes256gcm-v1",
            platform: "linux",
            status: "verified",
            observedAt: Date.parse("2026-08-08T00:00:00.000Z"),
            expiresAt: Date.parse("2026-08-08T00:01:00.000Z"),
            source: "encrypted_local_file",
          };
        },
      },
      fetch: async (input) => {
        remoteCalls += 1;
        assert.match(String(input), /\/v1\/cli-auth\/bootstrap$/u);
        return new Response(JSON.stringify({
          enabled: true,
          completion_mode: "paste_login_code",
          pkce_method: "S256",
          continuation_ttl_seconds: 600,
          access_token_ttl_seconds: 600,
          browser_origin: "https://app.getcuna.com",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    assert.equal(exit, EXIT_CODES.success);
    assert.equal(localStoreProbes, 1);
    assert.equal(remoteCalls, 1);
    const features = JSON.parse(streams.stdout()).data.runtime_features;
    assert.deepEqual(features.find((item) => item.feature === "browser_login_remote"), {
      feature: "browser_login_remote",
      implementation: "available",
      reason: "remote_browser_login_bootstrap_verified",
    });
    assert.deepEqual(features.find((item) => item.feature === "browser_auth"), {
      feature: "browser_auth",
      implementation: "available",
      reason: "browser_login_remote_and_encrypted_local_verified",
    });
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("doctor reports the composed journey locally without claiming live producer evidence", async () => {
  const streams = memoryStreams();
  const exit = await runCli(["doctor"], {
    streams: streams.streams,
    platform: { ...platform, kind: "windows" },
    env: {},
  });
  assert.equal(exit, EXIT_CODES.success);
  const features = JSON.parse(streams.stdout()).data.runtime_features;
  assert.deepEqual(
    features.filter((item) => item.feature === "terminal_workspace" || item.feature === "workspace_sync"),
    [
      {
        feature: "terminal_workspace",
        implementation: "available",
        reason: "foreground_exact_session_composed_live_producer_required",
      },
      {
        feature: "workspace_sync",
        implementation: "available",
        reason: "initial_and_continuous_sync_composed_live_producer_required",
      },
    ],
  );
});

test("package and runtime versions remain identical", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const streams = memoryStreams();
  await runCli(["--version"], { streams: streams.streams });
  assert.equal(JSON.parse(streams.stdout()).data.version, packageJson.version);
});
