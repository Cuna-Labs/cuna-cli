// PRD cuna-truthful-machine-surfaces R4.1 (BL-4): every `--json` result and
// error envelope names the exact command path.
//
// Measured on the 0.1.7 drop c0dc53b (biotech-lab, 2026-10-02T23:45:34Z):
// `machines start ... --json` failed with `"command":"machines"` while every
// success names its leaf (`machines.list`, `machines.start`). The error label
// was the first positional token; the success label is written by the command
// that ran. A script that routes on `command` could not tell which one failed.
import test from "node:test";
import assert from "node:assert/strict";

import { memoryStreams, runCli } from "../dist/index.js";
import { CLI_ROUTE_REGISTRY } from "../dist/cli/parser.js";

const PLATFORM = Object.freeze({
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
});
const API_KEY = "cuna_sk_abcdefghijklmnop";

/** Leaves that own a terminal and refuse `--json` by design: no result envelope exists. */
const INTERACTIVE_ONLY = new Set(["observe", "share", "agent-sessions attach", "connect", "claude", "codex", "opencode"]);

/**
 * The `command` each leaf's result envelope carries, as the command writes it
 * (`src/commands/commands.ts`, `src/cli/run.ts`). The rows the success test
 * below runs are checked against a real result; the others are pinned by the
 * tests that already run them (machine create, live update, termination,
 * doctor, self-test).
 */
const RESULT_COMMAND = Object.freeze({
  signup: "signup",
  login: "login",
  logout: "logout",
  whoami: "whoami",
  "access status": "access.status",
  capabilities: "capabilities",
  machines: "machines.overview",
  "machines list": "machines.list",
  "machines create": "machines.create",
  "machines start": "machines.start",
  "machines pause": "machines.pause",
  "machines resume": "machines.resume",
  "machines stop": "machines.stop",
  "machines update-supervisor": "machines.update-supervisor",
  "machines live-update-supervisor": "machines.live-update-supervisor",
  "machines live-update-status": "machines.live-update-status",
  "machines delete": "machines.delete",
  "records list": "records.list",
  "executions list": "executions.list",
  "executions get": "executions.get",
  "executions cancel": "executions.cancel",
  "authorizations list": "authorizations.list",
  "account show": "account.show",
  "workspace show": "workspace.show",
  "usage show": "usage.show",
  "api-keys list": "api-keys.list",
  "api-keys create": "api-keys.create",
  "api-keys revoke": "api-keys.revoke",
  "agent-sessions list": "agent-sessions.list",
  "agent-sessions get": "agent-sessions.get",
  "agent-sessions create": "agent-sessions.create",
  "agent-sessions rename": "agent-sessions.rename",
  "agent-sessions terminate": "agent-sessions.terminate",
  "agent logout": "agent.logout",
  "config get": "config.get",
  // Its result is run for real in test/sync-recover-command.test.mjs.
  "sync recover": "sync.recover",
  doctor: "doctor",
  "self-test": "self-test",
  version: "version",
  help: "help",
});

const JSON_ROUTES = CLI_ROUTE_REGISTRY.filter((route) => route.dispatch === "routed" && !INTERACTIVE_ONLY.has(route.key));

async function run(argv, dependencies) {
  const streams = memoryStreams();
  const exit = await runCli(argv, { streams: streams.streams, platform: PLATFORM, ...dependencies });
  const last = (text) => text.trim() === "" ? undefined : JSON.parse(text.trim().split("\n").at(-1));
  return { exit, result: last(streams.stdout()), error: last(streams.stderr()), stderr: streams.stderr() };
}

/**
 * Fail the leaf after it has been recognised. `--timeout-ms 1` is refused
 * after the command's own preflight; `version` and `help` answer before that
 * option is read, so they fail on an operand they do not take.
 */
function failingArgv(route) {
  return route.key === "version" || route.key === "help"
    ? [...route.argv, "unexpected", "--json"]
    : [...route.argv, "--json", "--timeout-ms", "1"];
}

test("the result-command table covers exactly the leaves that print a JSON result", () => {
  assert.deepEqual(JSON_ROUTES.map((route) => route.key).sort(), Object.keys(RESULT_COMMAND).sort());
});

test("every leaf's error envelope names the command its result envelope names", async () => {
  const wrong = [];
  for (const route of JSON_ROUTES) {
    const { exit, error, stderr } = await run(failingArgv(route), { env: { CUNA_API_KEY: API_KEY } });
    assert.notEqual(exit, 0, `${route.key} must fail here: ${stderr}`);
    assert.equal(error?.type, "error", `${route.key}: ${stderr}`);
    if (error.command !== RESULT_COMMAND[route.key]) wrong.push(`${route.key}: ${error.command} != ${RESULT_COMMAND[route.key]}`);
  }
  assert.deepEqual(wrong, []);
});

test("a leaf that does not exist is still named by what was typed", async () => {
  // Nothing resolves, so there is no path to name; the typed command is the
  // most exact thing left, and an option value never is.
  const { error } = await run(["--config-file", "/home/me/cuna.toml", "machines", "frobnicate", "--json"], { env: {} });
  assert.equal(error.command, "machines");
  const unknown = await run(["bogus", "--json"], { env: {} });
  assert.equal(unknown.error.command, "bogus");
});

function capability(id, interaction) {
  return { id, availability: "supported", interaction, mutationClass: interaction === "read_only" ? "none" : "reversible", surfaces: ["cli"], requiredPermissions: [] };
}

/** An account where every read and mutation this test runs succeeds. */
function permissiveClient(machineState) {
  return {
    async getIdentity() {
      return {
        id: "11111111-1111-4111-8111-111111111111", email: "developer@example.test", workspaceAssigned: true,
        workspaceId: "22222222-2222-4222-8222-222222222222",
        workspaceUsage: { estimatedSpendUsd: 1, estimatedSpendIsLowerBound: true, balanceStatus: "unavailable", balanceUsd: null, balanceUnavailableReason: "no balance endpoint", note: "estimate" },
      };
    },
    async discoverCapabilities(scope, resourceId) {
      const now = Date.now();
      return {
        schemaVersion: "1.0", subjectScope: scope, ...(resourceId === undefined ? {} : { subjectId: resourceId }),
        observedAt: new Date(now - 100).toISOString(), expiresAt: new Date(now + 30_000).toISOString(), etag: "r4",
        capabilities: [
          capability("records.list", "read_only"),
          capability("authorizations.list", "read_only"),
          capability("machines.lifecycle", "native"),
          capability("machines.delete", "native"),
        ],
      };
    },
    async listMachines() { return { items: [] }; },
    async getMachine(id) { return { id, name: "envelope", state: machineState, agent: "claude-code" }; },
    async transitionMachine(id) { return { id, name: "envelope", state: machineState, agent: "claude-code" }; },
    async replaceMachineSupervisor(id) { return { id, name: "envelope", state: "running", agent: "claude-code" }; },
    async deleteMachine() {},
    async listRecords() { return []; },
    async listAuthorizations() { return { revision: 1, secret_configuration: [] }; },
    async listAgentSessions() { return { items: [] }; },
  };
}

const HUMAN_AUTH = Object.freeze({
  async whoami() {
    return {
      profile: "default", sessionId: "33333333-3333-4333-8333-333333333333",
      context: { requiredTermsVersion: "2026-08-01", identity: "developer@example.test", admission: "admitted", workspace: { state: "assigned" } },
    };
  },
  async logout() { return { profile: "default", revoked: true }; },
  async acquireAccessToken() { return `cuna_at_${"a".repeat(43)}`; },
});

/** The leaves this test runs to a real result, and what that run needs. */
const SUCCESS_RUNS = [
  ["capabilities"], ["machines"], ["machines list"], ["records list"], ["authorizations list"],
  ["account show"], ["workspace show"], ["usage show"], ["agent-sessions list"], ["config get"],
  ["version"], ["help"],
  ["machines start", "running"], ["machines resume", "running"], ["machines pause", "paused"],
  ["machines stop", "stopped"], ["machines update-supervisor", "stopped"], ["machines delete", "deleted"],
  ["whoami", undefined, "human"], ["access status", undefined, "human"], ["logout", undefined, "human"],
];

test("a leaf's result and error envelopes carry the same command (run for real)", async () => {
  for (const [key, machineState = "running", auth] of SUCCESS_RUNS) {
    const route = JSON_ROUTES.find((candidate) => candidate.key === key);
    assert.ok(route !== undefined, key);
    const dependencies = auth === "human"
      ? { env: {}, humanAuth: HUMAN_AUTH }
      : { env: { CUNA_API_KEY: API_KEY }, clientFactory: () => permissiveClient(machineState) };
    const success = await run([...route.argv, "--json"], dependencies);
    assert.equal(success.exit, 0, `${key}: ${success.stderr}`);
    assert.equal(success.result.type, "result", key);
    const failure = await run(failingArgv(route), dependencies);
    assert.equal(failure.error.type, "error", key);
    assert.equal(success.result.command, RESULT_COMMAND[key], `${key}: the table matches the command that ran`);
    assert.equal(failure.error.command, success.result.command, key);
  }
});
