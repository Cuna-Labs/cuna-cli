import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAgentJourneyIntent,
  preflightAgentJourneyInvocation,
} from "../dist/journey/intent.js";

const AGENT_SESSION_ID = "10000000-0000-4000-8000-000000000001";
const CREDENTIAL_BINDING_ID = "20000000-0000-4000-8000-000000000002";

function assertUsageError(operation, messagePattern) {
  assert.throws(operation, (error) => {
    assert.equal(error?.code, "cuna.usage.invalid");
    assert.equal(error?.exitCode, 2);
    if (messagePattern !== undefined) assert.match(error.message, messagePattern);
    return true;
  });
}

test("agent commands normalize to closed agent kinds without performing journey effects", () => {
  const cases = [
    ["claude", "claude-code"],
    ["codex", "codex"],
    ["openclaw", "openclaw"],
    ["opencode", "opencode"],
  ];
  for (const [command, agent] of cases) {
    const argv = [command];
    const before = [...argv];
    const intent = parseAgentJourneyIntent(argv);
    assert.deepEqual(intent, {
      schemaVersion: "1.0",
      command,
      agent,
      target: "reconcile",
      machine: { kind: "automatic" },
      syncMode: "enabled",
      newSession: false,
    });
    assert.deepEqual(argv, before);
    assert.equal(Object.isFrozen(intent), true);
    assert.equal(Object.isFrozen(intent.machine), true);
  }
});

test("the admitted reconcile intent preserves exact path, machine selector, auth mode, and session choice", () => {
  const intent = parseAgentJourneyIntent([
    "claude",
    "services/api",
    "--machine",
    "review-machine",
    "--new-session",
    "--no-sync",
    "--auth-mode",
    "credential_binding",
    "--credential-binding",
    CREDENTIAL_BINDING_ID,
  ]);
  assert.deepEqual(intent, {
    schemaVersion: "1.0",
    command: "claude",
    agent: "claude-code",
    target: "reconcile",
    machine: { kind: "exact-name", name: "review-machine" },
    localPath: "services/api",
    syncMode: "disabled",
    newSession: true,
    authMode: "credential_binding",
    credentialBindingId: CREDENTIAL_BINDING_ID,
  });
});

test("--new produces a distinct creation intent without claiming machine or filesystem validation", () => {
  const intent = parseAgentJourneyIntent([
    "codex",
    "C:\\work tree\\project",
    "--new",
    "--auth-mode=interactive_login",
  ]);
  assert.deepEqual(intent, {
    schemaVersion: "1.0",
    command: "codex",
    agent: "codex",
    target: "reconcile",
    machine: { kind: "new" },
    localPath: "C:\\work tree\\project",
    syncMode: "enabled",
    newSession: false,
    authMode: "interactive_login",
  });
});

test("explicit --agent-session semantics remain exact and bypass path, sync, and machine reconciliation", () => {
  for (const [command, agent] of [
    ["claude", "claude-code"],
    ["codex", "codex"],
    ["openclaw", "openclaw"],
    ["opencode", "opencode"],
  ]) {
    const intent = parseAgentJourneyIntent([
      command,
      "--agent-session",
      AGENT_SESSION_ID,
      "--json",
    ]);
    assert.deepEqual(intent, {
      schemaVersion: "1.0",
      command,
      agent,
      target: "agent-session",
      agentSessionId: AGENT_SESSION_ID,
      syncMode: "not-applicable",
    });
  }
});

test("explicit AgentSession attachment rejects every misleading journey combination", () => {
  const conflicts = [
    ["."],
    ["--machine", "review-machine"],
    ["--new"],
    ["--new-session"],
    ["--no-sync"],
    ["--auth-mode", "interactive_login"],
    ["--credential-binding", CREDENTIAL_BINDING_ID],
  ];
  for (const conflict of conflicts) {
    assertUsageError(
      () => parseAgentJourneyIntent([
        "claude",
        "--agent-session",
        AGENT_SESSION_ID,
        ...conflict,
      ]),
      /cannot be combined/u,
    );
  }
  assertUsageError(
    () => parseAgentJourneyIntent(["codex", "--agent-session", "not-a-session"]),
    /Invalid AgentSession ID/u,
  );
});

test("duplicate journey options are rejected before intent admission", () => {
  const duplicates = [
    ["--machine", "one", "--machine=two"],
    ["--new", "--new"],
    ["--no-sync", "--no-sync"],
    ["--new-session", "--new-session"],
    ["--agent-session", AGENT_SESSION_ID, "--agent-session", AGENT_SESSION_ID],
    ["--auth-mode", "interactive_login", "--auth-mode=credential_binding"],
    ["--credential-binding", CREDENTIAL_BINDING_ID, "--credential-binding", CREDENTIAL_BINDING_ID],
  ];
  for (const duplicate of duplicates) {
    assertUsageError(
      () => parseAgentJourneyIntent(["claude", ...duplicate]),
      /provided more than once/u,
    );
  }
});

test("mutually exclusive and command-specific options fail closed", () => {
  for (const argv of [
    ["claude", "--new", "--machine", "existing"],
    ["codex", "--new", "--new-session"],
  ]) {
    assertUsageError(() => parseAgentJourneyIntent(argv), /mutually exclusive/u);
  }
  assertUsageError(
    () => parseAgentJourneyIntent(["openclaw", "--no-sync"]),
    /not available for openclaw/u,
  );
  assert.equal(parseAgentJourneyIntent(["claude", "--no-sync"]).syncMode, "disabled");
  assert.equal(parseAgentJourneyIntent(["codex", "--no-sync"]).syncMode, "disabled");
  assert.equal(parseAgentJourneyIntent(["opencode", "--no-sync"]).syncMode, "disabled");
  assertUsageError(
    () => parseAgentJourneyIntent(["claude", "--auth-mode", "credential_binding"]),
    /--credential-binding is required/u,
  );
  assertUsageError(
    () => parseAgentJourneyIntent(["claude", "--credential-binding", CREDENTIAL_BINDING_ID]),
    /requires --auth-mode credential_binding/u,
  );
  assertUsageError(
    () => parseAgentJourneyIntent(["opencode", "--auth-mode", "credential_binding", "--credential-binding", CREDENTIAL_BINDING_ID]),
    /interactive_login only/u,
  );
  assertUsageError(
    () => parseAgentJourneyIntent(["opencode", "--credential-binding", CREDENTIAL_BINDING_ID]),
    /interactive_login only/u,
  );
  assertUsageError(
    () => parseAgentJourneyIntent([
      "claude",
      "--auth-mode",
      "credential_binding",
      "--credential-binding",
      "not-a-binding",
    ]),
    /Invalid credential binding ID/u,
  );
});

test("surplus operands, unknown options, and malformed auth modes never produce an intent", () => {
  assertUsageError(
    () => parseAgentJourneyIntent(["claude", "one", "two"]),
    /at most one local path/u,
  );
  assertUsageError(
    () => parseAgentJourneyIntent(["codex", "--background"]),
    /Unknown option --background/u,
  );
  assertUsageError(
    () => parseAgentJourneyIntent(["openclaw", "--auth-mode", "automatic"]),
    /interactive_login or credential_binding/u,
  );
  assertUsageError(() => parseAgentJourneyIntent(["shell"]), /must be claude, codex, openclaw, or opencode/u);
});

test("argv-derived values with unsafe types, controls, empty paths, or oversized selectors are rejected safely", () => {
  for (const argv of [
    ["claude", 42],
    ["claude", null],
    ["claude", "bad\u0000path"],
    ["claude", "bad\u202ename"],
    ["claude", ""],
    ["claude", "--machine", `m${"x".repeat(80)}`],
    ["claude", "--machine", "bad\u0007machine"],
  ]) {
    assertUsageError(() => parseAgentJourneyIntent(argv));
  }
});

test("the option terminator preserves an exact path that begins with two hyphens", () => {
  const intent = parseAgentJourneyIntent(["claude", "--", "--machine"]);
  assert.equal(intent.target, "reconcile");
  assert.equal(intent.localPath, "--machine");
  assert.deepEqual(intent.machine, { kind: "automatic" });
});

test("known outer CLI options are shape-checked but do not alter the journey intent", () => {
  const baseline = parseAgentJourneyIntent(["codex"]);
  const withOuterOptions = parseAgentJourneyIntent([
    "codex",
    "--json",
    "--no-color",
    "--profile",
    "work",
    "--timeout-ms=2000",
  ]);
  assert.deepEqual(withOuterOptions, baseline);

  assertUsageError(() =>
    preflightAgentJourneyInvocation({
      command: "codex",
      operands: [],
      options: { json: "true" },
    }), /does not accept a value/u);
});
