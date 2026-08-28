import assert from "node:assert/strict";
import test from "node:test";

import { CunaError, runNodeMachinesExplorer } from "../dist/index.js";

const MACHINE_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

class FakeHost {
  columns = 120;
  rows = 30;
  writes = [];
  input;
  resize;
  restored = 0;
  acquireModes = [];
  dimensions() { return { columns: this.columns, rows: this.rows }; }
  async acquire(mode) {
    this.acquireModes.push(mode);
    return { restore: async () => { this.restored += 1; } };
  }
  async write(bytes) { this.writes.push(new TextDecoder().decode(bytes)); }
  onInput(listener) { this.input = listener; return () => { this.input = undefined; }; }
  onResize(listener) { this.resize = listener; return () => { this.resize = undefined; }; }
  emitInput(bytes) { this.input?.(Uint8Array.from(bytes)); }
  emitResize() { this.resize?.(); }
}

function agentSession(overrides = {}) {
  const now = Date.now();
  return {
    id: SESSION_ID,
    machineId: MACHINE_ID,
    name: "goal0-claude",
    agent: "claude-code",
    cwd: "/workspace/project",
    authMode: "interactive_login",
    desiredState: "running",
    requestState: "launched",
    processState: "running",
    processEpoch: "epoch-1",
    runtimeObservedAt: new Date(now - 1_000).toISOString(),
    runtimeExpiresAt: new Date(now + 59_000).toISOString(),
    rowVersion: 1,
    createdAt: "2026-08-27T01:00:00.000Z",
    updatedAt: "2026-08-27T01:00:00.000Z",
    ...overrides,
  };
}

function visibleCellWidth(value) {
  return [...value].reduce((width, character) =>
    width + (/\p{Script=Han}|\p{Extended_Pictographic}/u.test(character) ? 2 : 1), 0);
}

function stripAnsi(value) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 0x1b && value[index + 1] === "[") {
      index += 2;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) break;
        index += 1;
      }
      continue;
    }
    result += value[index];
  }
  return result;
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

test("machines explorer renders nested counts, opens machine actions, resizes, and exits on one Ctrl+C", async () => {
  const host = new FakeHost();
  const calls = [];
  const client = {
    async listMachines() {
      calls.push("machines");
      return { items: [{ id: MACHINE_ID, name: "goal0", state: "running", agent: "claude-code" }] };
    },
    async listAgentSessions(machineId, options) {
      calls.push({ machineId, options });
      return { items: [agentSession()] };
    },
  };
  const operation = runNodeMachinesExplorer({ client, color: true }, { host });
  await waitUntil(() => host.writes.some((write) => write.includes("Claude 1/1 live")), "nested machine inventory should render");
  const expanded = host.writes.at(-1);
  assert.match(stripAnsi(expanded), /Claude · goal0-claude  attachable/u);
  assert.match(stripAnsi(expanded), /Enter attach Claude.*→ manage machine/u);
  assert.equal(expanded.includes("\u001b[48;5;202m"), true, "brand cell should use Cuna flare");
  assert.equal(expanded.includes("\u001b[38;5;232m"), true, "brand text should use theme-independent Cuna ground");
  assert.equal(expanded.includes("\u001b[30m"), false, "brand text should not inherit a terminal's remapped basic black");
  assert.equal(expanded.includes("\u001b[48;5;52m"), true, "context cell should use Cuna ember");
  assert.equal(expanded.includes("\u001b[38;5;223m"), true, "context text should use Cuna cream");
  assert.equal(stripAnsi(expanded).match(/◆──/gu)?.length, 1, "the header should have one machine-graph signature");
  assert.deepEqual(host.acquireModes, ["rich"]);
  assert.deepEqual(calls, ["machines", { machineId: MACHINE_ID, options: { limit: 100 } }]);

  host.emitInput([0x1b, 0x5b, 0x42]);
  await waitUntil(() => stripAnsi(host.writes.at(-1)).includes("❯   └─ Claude"), "Down should visibly select the AgentSession child");
  assert.match(stripAnsi(host.writes.at(-1)), /Enter\/→ attach Claude/u);
  host.emitInput([0x1b, 0x5b, 0x41]);
  await waitUntil(() => stripAnsi(host.writes.at(-1)).includes("❯ ▾ goal0"), "Up should return to the machine row");

  host.emitInput([0x1b, 0x5b, 0x43]);
  await waitUntil(() => stripAnsi(host.writes.at(-1)).includes("CUNA  ◆── goal0"), "Right should move forward into the selected machine");
  assert.match(stripAnsi(host.writes.at(-1)), /Claude  sessions/u);
  assert.match(stripAnsi(host.writes.at(-1)), /Stop machine/u);
  assert.doesNotMatch(stripAnsi(host.writes.at(-1)), /Stop\s+stop/u);
  assert.equal(host.writes.at(-1).includes("\u001b[48;5;202m"), true, "context header should retain the flare brand cell");
  assert.equal(host.writes.at(-1).includes("\u001b[48;5;52m"), true, "context header should retain the ember context cell");

  host.emitInput([0x1b, 0x5b, 0x44]);
  await waitUntil(() => stripAnsi(host.writes.at(-1)).includes("❯ ▾ goal0"), "Left should return to the same machine row");

  host.emitInput([0x1b, 0x5b, 0x43]);
  await waitUntil(() => stripAnsi(host.writes.at(-1)).includes("CUNA  ◆── goal0"), "Right should always open explicit machine management");
  host.emitInput([0x08]);
  await waitUntil(() => stripAnsi(host.writes.at(-1)).includes("CUNA  ◆── Machines"), "Backspace should return one level");

  host.columns = 36;
  host.emitResize();
  await waitUntil(() => stripAnsi(host.writes.at(-1))
    .split("\r\n")
    .every((line) => line.length <= 36), "resize should repaint to the latest width");

  host.emitInput([0x03]);
  await operation;
  assert.equal(host.writes.some((write) => stripAnsi(write).includes("✦ Closing Cuna...")), true);
  assert.equal(host.writes.some((write) => stripAnsi(write).includes("✓ Closed.")), true);
  assert.equal(host.restored, 1);
  assert.equal(host.input, undefined);
  assert.equal(host.resize, undefined);
});

for (const [label, key] of [["Enter", 0x0d], ["Space", 0x20]]) {
  test(`${label} on a machine with one openable child attaches that exact AgentSession directly`, async () => {
    const host = new FakeHost();
    const operation = runNodeMachinesExplorer({
      client: {
        async listMachines() { return { items: [{ id: MACHINE_ID, name: "goal0", state: "running", agent: "claude-code" }] }; },
        async listAgentSessions() {
          return { items: [
            agentSession(),
            agentSession({ id: "22222222-2222-4222-8222-222222222222", name: "old-1", requestState: "terminal", processState: "exited" }),
            agentSession({ id: "33333333-3333-4333-8333-333333333334", name: "old-2", requestState: "terminal", processState: "exited" }),
            agentSession({ id: "44444444-4444-4444-8444-444444444444", name: "old-3", requestState: "terminal", processState: "exited" }),
          ] };
        },
      },
    }, { host });
    await waitUntil(() => host.writes.some((frame) => stripAnsi(frame).includes("Claude 1/4 live")), "one live child among history should render");
    assert.match(stripAnsi(host.writes.at(-1)), /Enter attach Claude.*→ manage machine/u);

    host.emitInput([key]);
    assert.deepEqual(await operation, { kind: "attach", agentSessionId: SESSION_ID, agent: "claude-code" });
    assert.equal(host.writes.some((frame) => stripAnsi(frame).includes("CUNA  ◆── goal0\r\n")), false, "direct attach must not visit the machine submenu");
    assert.equal(host.restored, 1);
  });
}

test("Enter on a machine with multiple openable children opens management without choosing arbitrarily", async () => {
  const host = new FakeHost();
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() { return { items: [{ id: MACHINE_ID, name: "goal0", state: "running", agent: "claude-code" }] }; },
      async listAgentSessions() {
        return { items: [
          agentSession(),
          agentSession({ id: "22222222-2222-4222-8222-222222222222", name: "second-live", rowVersion: 2 }),
        ] };
      },
    },
  }, { host });
  await waitUntil(() => host.writes.some((frame) => stripAnsi(frame).includes("Claude 2/2 live")), "both openable children should render");
  assert.match(stripAnsi(host.writes.at(-1)), /Enter\/→ manage machine/u);
  host.emitInput([0x0d]);
  await waitUntil(() => stripAnsi(host.writes.at(-1)).includes("CUNA  ◆── goal0"), "ambiguous Enter should open machine management");
  host.emitInput([0x03]);
  assert.equal(await operation, undefined);
});

test("terminated visible sessions remain selectable but Right never opens the provider creation menu", async () => {
  const host = new FakeHost();
  const now = Date.now();
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() { return { items: [{ id: MACHINE_ID, name: "goal0", state: "running", agent: "claude-code" }] }; },
      async listAgentSessions() {
        return { items: [agentSession({
          desiredState: "running",
          requestState: "terminal",
          processState: "exited",
          runtimeExpiresAt: new Date(now - 1_000).toISOString(),
        })] };
      },
      async discoverCapabilities() {
        return {
          schemaVersion: "1.0",
          subjectScope: "machine",
          subjectId: MACHINE_ID,
          observedAt: new Date(now - 1_000).toISOString(),
          expiresAt: new Date(now + 30_000).toISOString(),
          etag: "session-create",
          capabilities: [{
            id: "agent_sessions.create",
            availability: "supported",
            interaction: "native",
            mutationClass: "reversible",
            surfaces: ["cli"],
            requiredPermissions: ["agent_sessions:create"],
          }],
        };
      },
    },
  }, { host, now: () => now });
  await waitUntil(() => host.writes.some((write) => stripAnsi(write).includes("terminated")), "terminated session should remain visible with one human state label");
  const visible = stripAnsi(host.writes.at(-1));
  assert.doesNotMatch(visible, /termination_intended/u);
  assert.equal(visible.match(/\bterminated\b/gu)?.length, 1);
  assert.match(visible, /Enter\/→ manage machine/u);
  host.emitInput([0x0d]);
  await waitUntil(() => stripAnsi(host.writes.at(-1)).includes("CUNA  ◆── goal0"), "zero openable children should open machine management");
  host.emitInput([0x1b, 0x5b, 0x44]);
  await waitUntil(() => stripAnsi(host.writes.at(-1)).includes("CUNA  ◆── Machines"), "Left should return to the overview");
  host.emitInput([0x1b, 0x5b, 0x42]);
  await waitUntil(() => stripAnsi(host.writes.at(-1)).includes("❯   └─ Claude"), "Down should visibly select the terminated child");
  host.emitInput([0x1b, 0x5b, 0x43]);
  await waitUntil(() => stripAnsi(host.writes.at(-1)).includes("Session ended."), "Right should explain why the selected historical session cannot open");
  assert.equal(stripAnsi(host.writes.at(-1)).includes("New Claude session"), false, "opening a historical session must not masquerade as the create-session menu");
  host.emitInput([0x03]);
  await operation;
});

test("an arrow selection made during refresh is not reset by the pending response", async () => {
  const host = new FakeHost();
  let machineReads = 0;
  let sessionReads = 0;
  let releaseRefresh;
  const pendingRefresh = new Promise((resolve) => { releaseRefresh = resolve; });
  const machine = { id: MACHINE_ID, name: "goal0", state: "running", agent: "claude-code" };
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() {
        machineReads += 1;
        if (machineReads === 2) await pendingRefresh;
        return { items: [machine] };
      },
      async listAgentSessions() {
        sessionReads += 1;
        return { items: [agentSession()] };
      },
    },
  }, { host });
  await waitUntil(() => host.writes.some((write) => write.includes("goal0-claude")), "initial session should render");

  host.emitInput([0x72]);
  await waitUntil(() => machineReads === 2, "manual refresh should be pending");
  host.emitInput([0x1b, 0x5b, 0x42]);
  await waitUntil(() => stripAnsi(host.writes.at(-1)).includes("❯   └─ Claude"), "Down should select the session during refresh");

  releaseRefresh();
  await waitUntil(() => sessionReads === 2
    && !stripAnsi(host.writes.at(-1)).includes("Refreshing live sessions")
    && stripAnsi(host.writes.at(-1)).includes("❯   └─ Claude"), "the completed refresh must preserve the current session selection");

  host.emitInput([0x03]);
  await operation;
});

test("machine-menu selection remains on New session when refresh inserts another session", async () => {
  const host = new FakeHost();
  let sessionReads = 0;
  const secondSessionId = "22222222-2222-4222-8222-222222222222";
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() {
        return { items: [{ id: MACHINE_ID, name: "goal0", state: "running", agent: "claude-code" }] };
      },
      async listAgentSessions() {
        sessionReads += 1;
        return { items: sessionReads === 1
          ? [agentSession()]
          : [agentSession(), agentSession({ id: secondSessionId, name: "newly-observed" })] };
      },
      async discoverCapabilities() {
        const now = Date.now();
        return {
          schemaVersion: "1.0",
          subjectScope: "machine",
          subjectId: MACHINE_ID,
          observedAt: new Date(now - 1_000).toISOString(),
          expiresAt: new Date(now + 30_000).toISOString(),
          etag: `session-create-${sessionReads}`,
          capabilities: [{
            id: "agent_sessions.create",
            availability: "supported",
            interaction: "native",
            mutationClass: "reversible",
            surfaces: ["cli"],
            requiredPermissions: ["agent_sessions:create"],
          }],
        };
      },
    },
  }, { host });
  await waitUntil(() => host.writes.some((write) => write.includes("goal0-claude")), "initial provider session should render");
  host.emitInput([0x1b, 0x5b, 0x43]);
  await waitUntil(() => stripAnsi(host.writes.at(-1)).includes("Claude  sessions")
    && stripAnsi(host.writes.at(-1)).includes("New Claude session"), "Right should explicitly open machine context with sessions and creation as separate actions");
  host.emitInput([0x1b, 0x5b, 0x42]);
  await waitUntil(() => stripAnsi(host.writes.at(-1)).includes("❯ New Claude session"), "New session should be selected");

  host.emitInput([0x72]);
  await waitUntil(() => sessionReads === 2
    && stripAnsi(host.writes.at(-1)).includes("❯ New Claude session"), "refresh should preserve the semantic machine-menu New session selection");
  host.emitInput([0x0d]);
  assert.deepEqual(await operation, {
    kind: "launch",
    agent: "claude-code",
    newSession: true,
    machineId: MACHINE_ID,
    machineName: "goal0",
  });
});

test("Enter on a Claude or Codex child returns the exact attach selection", async () => {
  const host = new FakeHost();
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() { return { items: [{ id: MACHINE_ID, name: "goal0", state: "running", agent: "claude-code" }] }; },
      async listAgentSessions() { return { items: [agentSession()] }; },
    },
  }, { host });
  await waitUntil(() => host.writes.some((write) => write.includes("goal0-claude")), "session should render");
  host.emitInput([0x1b, 0x5b, 0x42]);
  await waitUntil(() => stripAnsi(host.writes.at(-1)).includes("❯   └─ Claude"), "session should be selected");
  host.emitInput([0x0d]);
  assert.deepEqual(await operation, { kind: "attach", agentSessionId: SESSION_ID, agent: "claude-code" });
  assert.equal(host.restored, 1);
});

test("OpenCode counts and a live OpenCode child are visible and attachable when enabled", async () => {
  const host = new FakeHost();
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() { return { items: [{ id: MACHINE_ID, name: "open-dev", state: "running", agent: "opencode" }] }; },
      async listAgentSessions() { return { items: [agentSession({ agent: "opencode", name: "open-main" })] }; },
    },
    opencodeEnabled: true,
  }, { host });
  await waitUntil(() => host.writes.some((write) => write.includes("OpenCode 1/1 live")), "OpenCode count should render");
  const overview = stripAnsi(host.writes.at(-1));
  assert.ok(overview.indexOf("OpenCode 1/1 live") < overview.indexOf("Claude 0/0 live"), "OpenCode should be the first recommended provider summary when enabled");
  host.emitInput([0x1b, 0x5b, 0x42]);
  await waitUntil(() => stripAnsi(host.writes.at(-1)).includes("❯   └─ OpenCode"), "OpenCode child should be selected");
  host.emitInput([0x0d]);
  assert.deepEqual(await operation, { kind: "attach", agentSessionId: SESSION_ID, agent: "opencode" });
  assert.equal(host.restored, 1);
});

test("bare explorer offers machine creation when every observed machine is unusable", async () => {
  const host = new FakeHost();
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() {
        return { items: [{ id: MACHINE_ID, name: "failed-open", state: "error", agent: "opencode" }] };
      },
      async listAgentSessions() { return { items: [] }; },
      async discoverCapabilities() {
        return {
          schemaVersion: "1.0",
          subjectScope: "machine",
          subjectId: MACHINE_ID,
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          etag: "runtime-unavailable",
          capabilities: [{
            id: "agent_sessions.create",
            availability: "temporarily_unavailable",
            interaction: "native",
            mutationClass: "reversible",
            surfaces: ["cli"],
            requiredPermissions: ["agent_sessions:create"],
            reason: "opencode_runtime_unverified",
          }],
        };
      },
    },
    opencodeEnabled: true,
  }, { host });

  await waitUntil(
    () => host.writes.some((write) => stripAnsi(write).includes("No available machine can open an AgentSession")),
    "unusable inventory should expose global creation choices",
  );
  const frame = stripAnsi(host.writes.at(-1));
  assert.match(frame, /failed-open\s+error/u);
  assert.match(frame, /Create OpenCode machine/u);

  host.emitInput([0x1b, 0x5b, 0x42]);
  await waitUntil(() => stripAnsi(host.writes.at(-1)).includes("❯ Create OpenCode machine"), "Down should select OpenCode creation");
  host.emitInput([0x0d]);
  assert.deepEqual(await operation, { kind: "launch", agent: "opencode" });
  assert.equal(host.restored, 1);
});

test("Right on an attachable child opens that exact session instead of the provider creation menu", async () => {
  const host = new FakeHost();
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() { return { items: [{ id: MACHINE_ID, name: "goal0", state: "running", agent: "claude-code" }] }; },
      async listAgentSessions() { return { items: [agentSession()] }; },
    },
  }, { host });
  await waitUntil(() => host.writes.some((write) => write.includes("goal0-claude")), "session should render");
  host.emitInput([0x1b, 0x5b, 0x42]);
  await waitUntil(() => stripAnsi(host.writes.at(-1)).includes("❯   └─ Claude"), "session should be selected");
  host.emitInput([0x1b, 0x5b, 0x43]);
  assert.deepEqual(await operation, { kind: "attach", agentSessionId: SESSION_ID, agent: "claude-code" });
  assert.equal(stripAnsi(host.writes.at(-1)).includes("New Claude session"), false);
});

test("machines explorer treats a producer-renewed future runtime expiry as live", async () => {
  const now = Date.parse("2026-08-27T05:00:00.000Z");
  const host = new FakeHost();
  const session = agentSession({
    runtimeObservedAt: "2026-08-27T04:00:00.000Z",
    runtimeExpiresAt: "2026-08-27T05:00:30.000Z",
  });
  const operation = runNodeMachinesExplorer({
    color: false,
    client: {
      async listMachines() { return { items: [{ id: MACHINE_ID, name: "renewed", state: "running", agent: "claude-code" }] }; },
      async listAgentSessions() { return { items: [session] }; },
    },
  }, { host, now: () => now });
  await waitUntil(() => host.writes.some((write) => write.includes("Claude 1/1 live")), "renewed lease should render live");
  host.emitInput(Buffer.from("q"));
  await operation;
});

test("machines explorer excludes sessions whose termination is intended or pending", async () => {
  const host = new FakeHost();
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() { return { items: [{ id: MACHINE_ID, name: "goal0", state: "running", agent: "claude-code" }] }; },
      async listAgentSessions() {
        return { items: [
          agentSession(),
          agentSession({
            id: "22222222-2222-4222-8222-222222222222",
            name: "already-terminating",
            desiredState: "terminated",
          }),
          agentSession({
            id: "33333333-3333-4333-8333-333333333333",
            name: "pending-termination",
            requestState: "termination_pending",
          }),
        ] };
      },
    },
  }, { host });
  await waitUntil(() => host.writes.some((write) => write.includes("Claude 1/1 live")), "only the intended-active session should count");
  const frame = host.writes.at(-1);
  assert.match(frame, /goal0-claude/u);
  assert.doesNotMatch(frame, /already-terminating|pending-termination/u);
  host.emitInput([0x03]);
  await operation;
  assert.equal(host.restored, 1);
});

test("machines explorer uses one public machine-list request without pagination", async () => {
  const host = new FakeHost();
  const machineCalls = [];
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines(signal) {
        machineCalls.push(signal);
        return { items: [{ id: MACHINE_ID, name: "first", state: "running", agent: "claude-code" }] };
      },
      async listAgentSessions() { return { items: [] }; },
    },
  }, { host });
  await waitUntil(() => host.writes.some((write) => write.includes("first")), "the machine should render");
  assert.equal(machineCalls.length, 1);
  assert.equal(machineCalls[0] instanceof AbortSignal, true);
  host.emitInput([0x03]);
  await operation;
});

test("machines explorer keeps stale sessions visible without counting them as running", async () => {
  const host = new FakeHost();
  let reads = 0;
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() { return { items: [{ id: MACHINE_ID, name: "goal0", state: "running", agent: "claude-code" }] }; },
      async listAgentSessions() {
        reads += 1;
        return { items: [agentSession({ runtimeExpiresAt: "2020-01-01T00:00:00.000Z" })] };
      },
    },
  }, { host, now: () => Date.parse("2026-08-27T01:00:00.000Z") });
  await waitUntil(() => host.writes.some((write) => write.includes("Claude 0/1 live")), "expired runtime evidence must not count as running");
  assert.match(host.writes.at(-1), /Claude · goal0-claude  stale/u);
  host.emitInput([0x1b, 0x5b, 0x42]);
  await waitUntil(() => host.writes.at(-1).includes("❯   └─ Claude"), "a stale session with refresh recovery should be selectable");
  host.emitInput([0x0d]);
  await waitUntil(() => reads === 2, "Enter on stale must execute refresh in place");
  host.emitInput([0x03]);
  await operation;
});

test("machines explorer renders an unknown declared provider truthfully beside independent OpenCode counts", async () => {
  const host = new FakeHost();
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() {
        return { items: [{ id: MACHINE_ID, name: "future", state: "running", agent: "future-agent" }] };
      },
      async listAgentSessions() { return { items: [] }; },
    },
  }, { host });
  await waitUntil(() => host.writes.some((write) => write.includes("Unknown (future-agent) declared-installed")), "unknown provider should be explicit");
  assert.match(host.writes.at(-1), /OpenCode 0\/0 live/u);
  host.emitInput([0x03]);
  await operation;
});

test("machines explorer paints machines before slower AgentSession reads finish", async () => {
  const host = new FakeHost();
  let resolveSessions;
  const sessions = new Promise((resolve) => { resolveSessions = resolve; });
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() { return { items: [{ id: MACHINE_ID, name: "immediate-machine", state: "running", agent: "claude-code" }] }; },
      async listAgentSessions() { return await sessions; },
    },
  }, { host });
  await waitUntil(
    () => host.writes.some((write) => write.includes("immediate-machine") && write.includes("Loading AgentSessions")),
    "the machine row and progress should render before sessions finish",
  );
  assert.equal(host.writes.at(-1).includes("goal0-claude"), false);
  resolveSessions({ items: [agentSession()] });
  await waitUntil(() => host.writes.some((write) => write.includes("goal0-claude")), "sessions should fill in incrementally");
  host.emitInput([0x03]);
  await operation;
});

test("machines explorer does not turn a cached live session stale while refresh is pending", async () => {
  const host = new FakeHost();
  const start = Date.parse("2026-08-27T05:00:00.000Z");
  let now = start;
  let reads = 0;
  let releaseRefresh;
  const pendingRefresh = new Promise((resolve) => { releaseRefresh = resolve; });
  const initial = agentSession({
    runtimeObservedAt: new Date(start - 1_000).toISOString(),
    runtimeExpiresAt: new Date(start + 5_000).toISOString(),
  });
  const renewed = agentSession({
    runtimeObservedAt: new Date(start + 10_000).toISOString(),
    runtimeExpiresAt: new Date(start + 40_000).toISOString(),
    rowVersion: 2,
  });
  const operation = runNodeMachinesExplorer({
    color: false,
    client: {
      async listMachines() { return { items: [{ id: MACHINE_ID, name: "stable", state: "running", agent: "claude-code" }] }; },
      async listAgentSessions() {
        reads += 1;
        if (reads === 1) return { items: [initial] };
        await pendingRefresh;
        return { items: [renewed] };
      },
    },
  }, { host, now: () => now });
  await waitUntil(() => host.writes.some((write) => write.includes("Claude 1/1 live")), "initial live snapshot should render");

  now = start + 10_000;
  host.emitInput([0x72]);
  await waitUntil(() => reads === 2 && host.writes.at(-1).includes("Refreshing live sessions"), "refresh should be visibly pending");
  assert.match(host.writes.at(-1), /Claude 1\/1 live/u);
  assert.doesNotMatch(host.writes.at(-1), /goal0-claude  stale/u);

  releaseRefresh();
  await waitUntil(() => host.writes.some((write) => write.includes("goal0-claude  attachable") && !write.includes("Refreshing live sessions")), "renewed snapshot should commit");
  host.emitInput([0x03]);
  await operation;
});

test("failed refresh retains the last confirmed session membership", async () => {
  const host = new FakeHost();
  let reads = 0;
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() { return { items: [{ id: MACHINE_ID, name: "stable-on-failure", state: "running", agent: "claude-code" }] }; },
      async listAgentSessions() {
        reads += 1;
        if (reads === 1) return { items: [agentSession()] };
        throw new Error("upstream child read failed");
      },
    },
  }, { host });
  await waitUntil(() => host.writes.some((write) => write.includes("goal0-claude  attachable")), "initial membership should be confirmed");
  host.emitInput([0x72]);
  await waitUntil(() => reads === 2 && host.writes.at(-1).includes("showing last confirmed sessions"), "failed refresh should be explicit");
  assert.match(host.writes.at(-1), /goal0-claude  attachable/u);
  assert.doesNotMatch(host.writes.at(-1), /upstream child read failed/u);
  host.emitInput([0x03]);
  await operation;
});

test("retryable machine refresh failure keeps navigation alive and recovers on the next refresh", async () => {
  const host = new FakeHost();
  let machineReads = 0;
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() {
        machineReads += 1;
        if (machineReads === 2) {
          throw new CunaError({
            code: "cuna.network.service_unavailable",
            message: "temporary upstream failure",
            exitCode: 5,
            retryable: true,
          });
        }
        return { items: [{
          id: MACHINE_ID,
          name: machineReads === 1 ? "stable-machine" : "recovered-machine",
          state: "running",
          agent: "claude-code",
        }] };
      },
      async listAgentSessions() { return { items: [agentSession()] }; },
    },
  }, { host });
  await waitUntil(() => host.writes.some((write) => write.includes("goal0-claude")), "initial inventory should render");
  host.emitInput([0x1b, 0x5b, 0x42]);
  await waitUntil(() => stripAnsi(host.writes.at(-1)).includes("❯   └─ Claude"), "session should be selected before refresh");

  host.emitInput([0x72]);
  await waitUntil(() => machineReads === 2 && host.writes.at(-1).includes("showing last confirmed machines"), "retryable refresh failure should retain the snapshot");
  assert.match(stripAnsi(host.writes.at(-1)), /stable-machine/u);
  assert.match(stripAnsi(host.writes.at(-1)), /❯   └─ Claude/u);

  host.emitInput([0x72]);
  await waitUntil(() => machineReads === 3
    && host.writes.at(-1).includes("recovered-machine")
    && !host.writes.at(-1).includes("showing last confirmed machines"), "next refresh should recover without leaving the explorer");
  assert.match(stripAnsi(host.writes.at(-1)), /❯   └─ Claude/u);
  host.emitInput([0x71]);
  await operation;
});

test("successful refresh authoritatively removes omitted sessions", async () => {
  const host = new FakeHost();
  let reads = 0;
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() { return { items: [{ id: MACHINE_ID, name: "authoritative", state: "running", agent: "claude-code" }] }; },
      async listAgentSessions() {
        reads += 1;
        return { items: reads === 1 ? [agentSession()] : [] };
      },
    },
  }, { host });
  await waitUntil(() => host.writes.some((write) => write.includes("goal0-claude")), "initial membership should render");
  host.emitInput([0x72]);
  await waitUntil(() => reads === 2 && host.writes.at(-1).includes("No AgentSessions"), "successful empty membership should remove the prior session");
  assert.doesNotMatch(host.writes.at(-1), /goal0-claude/u);
  host.emitInput([0x03]);
  await operation;
});

test("unknown-provider sessions remain visible but are never selectable or aliased to an OpenCode child", async () => {
  const host = new FakeHost();
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() { return { items: [{ id: MACHINE_ID, name: "future", state: "running", agent: "future-agent" }] }; },
      async listAgentSessions() { return { items: [agentSession({ agent: "future-agent", name: "future-child" })] }; },
    },
  }, { host });
  await waitUntil(() => host.writes.some((write) => write.includes("future-child  unsupported")), "unsupported session should stay observable");
  assert.match(host.writes.at(-1), /Unknown \(future-agent\)/u);
  assert.match(host.writes.at(-1), /OpenCode 0\/0 live/u);
  assert.doesNotMatch(host.writes.at(-1), /OpenCode · future-child/u);
  host.emitInput([0x1b, 0x5b, 0x42]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.doesNotMatch(host.writes.at(-1), /❯   └─ Unknown/u);
  host.emitInput([0x03]);
  await operation;
});

test("machines explorer keeps a machine visible when its sessions are unavailable", async () => {
  const host = new FakeHost();
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() { return { items: [{ id: MACHINE_ID, name: "partial", state: "running", agent: "claude-code" }] }; },
      async listAgentSessions() { throw new Error("private upstream detail"); },
    },
  }, { host });
  await waitUntil(() => host.writes.some((write) => write.includes("sessions unavailable")), "partial failure should be explicit");
  assert.match(host.writes.at(-1), /partial/u);
  assert.doesNotMatch(host.writes.at(-1), /private upstream detail/u);
  host.emitInput([0x03]);
  await operation;
  assert.equal(host.restored, 1);
});

test("machines explorer scrolls the viewport to keep the selected machine visible after navigation and shrink", async () => {
  const host = new FakeHost();
  host.rows = 20;
  const machines = Array.from({ length: 8 }, (_, index) => ({
    id: `33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`,
    name: `machine-${index + 1}`,
    state: "running",
    agent: "claude-code",
  }));
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() { return { items: machines }; },
      async listAgentSessions() { return { items: [] }; },
    },
  }, { host });
  await waitUntil(() => host.writes.some((write) => write.includes("machine-8")), "all machine rows should load");

  const down = [0x1b, 0x5b, 0x42];
  host.emitInput([...down, ...down, ...down, ...down, ...down, ...down, ...down]);
  await waitUntil(() => host.writes.at(-1).includes("❯ ▾ machine-8"), "coalesced arrows should select the last machine");

  host.rows = 3;
  host.emitResize();
  await waitUntil(() => {
    const visible = host.writes.at(-1).split("\r\n");
    return visible.length <= 3 && visible.some((line) => line.includes("❯ ▾ machine-8"));
  }, "shrinking must retain the selected machine in the visible viewport");

  host.emitInput([0x71]);
  await operation;
  assert.equal(host.restored, 1);
});

test("machines explorer parses split and coalesced cursor input without treating bare Escape as exit", async () => {
  const host = new FakeHost();
  const machines = [1, 2, 3, 4].map((index) => ({
    id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
    name: `machine-${index}`,
    state: "running",
    agent: "claude-code",
  }));
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() { return { items: machines }; },
      async listAgentSessions() { return { items: [] }; },
    },
  }, { host });
  await waitUntil(() => host.writes.some((write) => write.includes("machine-4")), "machines should load");

  host.emitInput([0x1b]);
  host.emitInput([0x5b]);
  host.emitInput([0x42]);
  await waitUntil(() => host.writes.at(-1).includes("❯ ▾ machine-2"), "a split Down sequence should move selection");

  host.emitInput([0x1b, 0x5b, 0x42, 0x1b, 0x5b, 0x42]);
  await waitUntil(() => host.writes.at(-1).includes("❯ ▾ machine-4"), "every arrow in one coalesced chunk should be processed");

  host.emitInput([0x1b]);
  host.emitInput([0x5b]);
  host.emitInput([0x41]);
  await waitUntil(() => host.writes.at(-1).includes("❯ ▾ machine-3"), "a split Up sequence should move selection");

  host.emitInput([0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x42]);
  await waitUntil(() => host.writes.at(-1).includes("❯ ▾ machine-4"), "a parameterized Windows CSI Down sequence should move selection");

  host.emitInput([0x1b]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  host.emitInput([0x5b]);
  host.emitInput([0x41]);
  await waitUntil(() => host.writes.at(-1).includes("❯ ▾ machine-3"), "a delayed split Up sequence should remain one cursor key");

  host.emitInput([0x1b]);
  host.emitInput([0x6b]);
  await waitUntil(() => host.writes.at(-1).includes("❯ ▾ machine-2"), "bare Escape must not exit or swallow the following navigation key");

  host.emitInput([0x71]);
  await operation;
  assert.equal(host.restored, 1);
});

test("machines explorer coalesces resize storms into one latest-width repaint", async () => {
  const host = new FakeHost();
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() { return { items: [{ id: MACHINE_ID, name: "resize", state: "running", agent: "claude-code" }] }; },
      async listAgentSessions() { return { items: [] }; },
    },
  }, { host });
  await waitUntil(() => host.writes.some((write) => write.includes("resize")), "machine should render");
  await new Promise((resolve) => setImmediate(resolve));
  const baseline = host.writes.length;

  for (let width = 120; width >= 21; width -= 1) {
    host.columns = width;
    host.emitResize();
  }
  await waitUntil(() => host.writes.length > baseline, "resize storm should repaint");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(host.writes.length, baseline + 1);
  assert.equal(stripAnsi(host.writes.at(-1))
    .split("\r\n")
    .every((line) => line.length <= 21), true);

  host.emitInput([0x03]);
  await operation;
  assert.equal(host.restored, 1);
});

test("machines explorer truncates by terminal cells without splitting wide names", async () => {
  const host = new FakeHost();
  host.columns = 20;
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() { return { items: [{ id: MACHINE_ID, name: "界".repeat(20), state: "running", agent: "claude-code" }] }; },
      async listAgentSessions() { return { items: [] }; },
    },
  }, { host });
  await waitUntil(() => host.writes.some((write) => write.includes("界")), "wide machine name should render");
  const lines = stripAnsi(host.writes.at(-1))
    .split("\r\n");
  assert.equal(lines.every((line) => visibleCellWidth(line) <= host.columns), true);
  host.emitInput([0x03]);
  await operation;
});

test("machines explorer refresh preserves the open machine by id across sorting", async () => {
  const host = new FakeHost();
  let refresh = 0;
  const operation = runNodeMachinesExplorer({
    client: {
      async listMachines() {
        refresh += 1;
        return { items: refresh === 1
          ? [
              { id: MACHINE_ID, name: "zulu", state: "running", agent: "claude-code" },
              { id: "44444444-4444-4444-8444-444444444444", name: "alpha", state: "running", agent: "claude-code" },
            ]
          : [
              { id: MACHINE_ID, name: "aardvark", state: "running", agent: "claude-code" },
              { id: "44444444-4444-4444-8444-444444444444", name: "zebra", state: "running", agent: "claude-code" },
            ] };
      },
      async listAgentSessions(machineId) {
        return { items: [agentSession({ id: machineId, machineId, name: `child-${machineId.slice(0, 4)}` })] };
      },
    },
  }, { host });
  await waitUntil(() => host.writes.some((write) => write.includes("zulu")), "initial machine ordering should render");
  host.emitInput([0x1b, 0x5b, 0x42, 0x1b, 0x5b, 0x42]);
  await waitUntil(() => host.writes.at(-1).includes("❯ ▾ zulu"), "zulu should be selected");
  host.emitInput([0x1b, 0x5b, 0x43]);
  await waitUntil(() => host.writes.at(-1).includes("CUNA  ◆── zulu"), "selected machine should open");
  host.emitInput([0x72]);
  await waitUntil(() => host.writes.at(-1).includes("CUNA  ◆── aardvark"), "open context should follow the machine id across sorting");
  assert.match(host.writes.at(-1), /Claude  sessions/u);
  host.emitInput([0x03]);
  await operation;
});

test("a pre-aborted machines explorer performs no API or terminal effect", async () => {
  const controller = new AbortController();
  controller.abort();
  let effects = 0;
  await runNodeMachinesExplorer({
    signal: controller.signal,
    client: {
      async listMachines() { effects += 1; return { items: [] }; },
    },
  }, {
    host: {
      async acquire() { effects += 1; throw new Error("unreachable"); },
    },
  });
  assert.equal(effects, 0);
});

test("an abort during machine discovery restores the host without starting child reads", async () => {
  const controller = new AbortController();
  const host = new FakeHost();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let childReads = 0;
  const operation = runNodeMachinesExplorer({
    signal: controller.signal,
    client: {
      async listMachines() {
        await pending;
        return { items: [{ id: MACHINE_ID, name: "late", state: "running", agent: "claude-code" }] };
      },
      async listAgentSessions() { childReads += 1; return { items: [] }; },
    },
  }, { host });
  await waitUntil(() => host.acquireModes.length === 1, "host should be acquired before discovery");
  controller.abort();
  release();
  await operation;
  assert.equal(childReads, 0);
  assert.equal(host.writes.some((write) => stripAnsi(write).includes("✦ Closing Cuna...")), true);
  assert.equal(host.writes.some((write) => stripAnsi(write).includes("✓ Closed.")), true);
  assert.equal(host.restored, 1);
});
