import assert from "node:assert/strict";
import test from "node:test";

import { rootJourneyArgv, runNodeRootJourney } from "../dist/journey/root-entry.js";

const NOW = Date.parse("2026-08-27T01:00:00.000Z");
const MACHINE = "22222222-2222-4222-8222-222222222222";
const SESSION = "11111111-1111-4111-8111-111111111111";

class Host {
  writes = [];
  input;
  dimensions() { return { columns: 120, rows: 30 }; }
  async acquire() { return { async restore() {} }; }
  async write(bytes) { this.writes.push(new TextDecoder().decode(bytes)); }
  onInput(listener) { this.input = listener; return () => { this.input = undefined; }; }
  onResize() { return () => {}; }
  send(bytes) { this.input?.(Uint8Array.from(bytes)); }
}

async function waitUntil(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("expected machine-first frame");
}

function liveSession() {
  return {
    id: SESSION, machineId: MACHINE, name: "main", agent: "claude-code", cwd: "/workspace",
    authMode: "interactive_login", desiredState: "running", requestState: "launched", processState: "running",
    processEpoch: "epoch", runtimeObservedAt: new Date(NOW - 1_000).toISOString(), runtimeExpiresAt: new Date(NOW + 30_000).toISOString(),
    rowVersion: 1, createdAt: new Date(NOW - 10_000).toISOString(), updatedAt: new Date(NOW).toISOString(),
  };
}

function sessionCreateCapability() {
  return {
    schemaVersion: "1.0",
    subjectScope: "machine",
    subjectId: MACHINE,
    observedAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 30_000).toISOString(),
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
}

test("bare root zero-machine journey offers all normal provider choices without identifiers", async () => {
  const host = new Host();
  const operation = runNodeRootJourney({
    client: { async listMachines() { return { items: [] }; } },
  }, { host, now: () => NOW });
  await waitUntil(() => host.writes.some((frame) => frame.includes("Create OpenCode machine") && frame.includes("Create Claude machine") && frame.includes("Create Codex machine")));
  const transcript = host.writes.at(-1);
  assert.doesNotMatch(transcript, /UUID|binding|generation|idempotency/iu);
  host.send([0x1b, 0x5b, 0x42, 0x1b, 0x5b, 0x42, 0x0d]);
  assert.deepEqual(await operation, { kind: "launch", agent: "codex" });
});

test("bare root offers and returns OpenCode through the normal provider route", async () => {
  const host = new Host();
  const operation = runNodeRootJourney({
    client: { async listMachines() { return { items: [] }; } },
  }, { host, now: () => NOW });
  await waitUntil(() => host.writes.some((frame) => frame.includes("Create OpenCode machine")));
  const frame = host.writes.at(-1);
  assert.ok(frame.indexOf("Create OpenCode machine") < frame.indexOf("Create Claude machine"));
  assert.match(frame, /❯ Create OpenCode machine/u);
  host.send([0x0d]);
  assert.deepEqual(await operation, { kind: "launch", agent: "opencode" });
});

test("bare root traverses machine -> provider -> existing session using the shared runner", async () => {
  const host = new Host();
  const operation = runNodeRootJourney({
    client: {
      async listMachines() { return { items: [{ id: MACHINE, name: "dev", state: "running", agent: "claude-code", updatedAt: "v1" }] }; },
      async listAgentSessions() { return { items: [liveSession()] }; },
      async discoverCapabilities() { throw new Error("new session not advertised"); },
    },
  }, { host, now: () => NOW });
  await waitUntil(() => host.writes.some((frame) => frame.includes("dev") && frame.includes("1 session")));
  host.send([0x1b, 0x5b, 0x43]);
  await waitUntil(() => host.writes.at(-1).includes("Claude  sessions"));
  host.send([0x0d]);
  await waitUntil(() => host.writes.at(-1).includes("main  attachable"));
  host.send([0x1b]);
  await waitUntil(() => host.writes.at(-1).includes("Claude  sessions"));
  host.send([0x1b]);
  await waitUntil(() => host.writes.at(-1).includes("CUNA  ◆── Machines"));
  await waitUntil(() => host.writes.at(-1).includes("Enter/→ manage machine"));
  host.send([0x0d]);
  await waitUntil(() => host.writes.at(-1).includes("CUNA  ◆── dev"));
  host.send([0x0d]);
  await waitUntil(() => host.writes.at(-1).includes("Claude  sessions"));
  host.send([0x0d]);
  assert.deepEqual(await operation, { kind: "attach", agentSessionId: SESSION, agent: "claude-code" });
});

test("stopped machine exposes Start, runs it in place without an identifier prompt, and keeps the screen", async () => {
  const host = new Host();
  let state = "stopped";
  const transitions = [];
  const operation = runNodeRootJourney({
    client: {
      async listMachines() { return { items: [{ id: MACHINE, name: "paused-dev", state, agent: "claude-code", updatedAt: "v2" }] }; },
      async listAgentSessions() { return { items: [] }; },
      async discoverCapabilities(scope, resourceId) {
        return {
          ...sessionCreateCapability(),
          subjectScope: scope,
          subjectId: resourceId,
          capabilities: [{
            id: "machines.lifecycle",
            availability: "supported",
            interaction: "native",
            mutationClass: "reversible",
            surfaces: ["cli"],
            requiredPermissions: ["machines:write"],
          }],
        };
      },
      async transitionMachine(id, action) {
        transitions.push([id, action]);
        return { id, name: "paused-dev", state: "starting", agent: "claude-code" };
      },
      async getMachine(id) {
        state = "running";
        return { id, name: "paused-dev", state, agent: "claude-code" };
      },
    },
  }, { host, now: () => NOW, convergence: { pollIntervalMs: 1, budgetMs: 1_000 } });
  await waitUntil(() => host.writes.some((frame) => frame.includes("paused-dev")));
  host.send([0x0d]);
  await waitUntil(() => host.writes.at(-1).includes("Start machine"));
  assert.doesNotMatch(host.writes.at(-1), /UUID|binding|generation|idempotency/iu);
  assert.doesNotMatch(host.writes.at(-1), /Claude  provider|OpenCode|ensure/iu);
  assert.match(host.writes.at(-1), /Delete machine/u);
  host.send([0x0d]);
  await waitUntil(() => host.writes.at(-1).includes("Stop machine"));
  assert.deepEqual(transitions, [[MACHINE, "start"]]);
  assert.equal(host.input !== undefined, true, "a lifecycle action must not leave the screen");
  host.send([0x03]);
  assert.equal(await operation, undefined);
});

test("bare root offers New machine from any overview and returns the create selection", async () => {
  const host = new Host();
  const operation = runNodeRootJourney({
    client: {
      async listMachines() { return { items: [{ id: MACHINE, name: "dev", state: "running", agent: "claude-code", updatedAt: "v1" }] }; },
      async listAgentSessions() { return { items: [liveSession()] }; },
      async discoverCapabilities(scope) {
        return scope === "account"
          ? {
              ...sessionCreateCapability(),
              subjectScope: "account",
              subjectId: undefined,
              capabilities: [{
                id: "machines.create",
                availability: "supported",
                interaction: "native",
                mutationClass: "financial",
                surfaces: ["cli"],
                requiredPermissions: ["machines:create"],
              }],
            }
          : sessionCreateCapability();
      },
    },
  }, { host, now: () => NOW });
  await waitUntil(() => host.writes.some((frame) => frame.includes("dev") && frame.includes("1 session")));
  assert.match(host.writes.at(-1), /n new machine/u);
  host.send([0x6e]);
  await waitUntil(() => host.writes.at(-1).includes("❯ OpenCode"));
  host.send([0x1b, 0x5b, 0x42, 0x1b, 0x5b, 0x42, 0x0d]);
  await waitUntil(() => host.writes.at(-1).includes("cuna-codex-1"));
  assert.doesNotMatch(host.writes.at(-1), /UUID|binding|generation|idempotency/iu);
  host.send([0x0d]);
  assert.deepEqual(await operation, { kind: "create", agent: "codex", name: "cuna-codex-1" });
});

test("running provider exposes New session only when current capability advertises it", async () => {
  const host = new Host();
  const operation = runNodeRootJourney({
    client: {
      async listMachines() { return { items: [{ id: MACHINE, name: "dev", state: "running", agent: "claude-code", updatedAt: "v3" }] }; },
      async listAgentSessions() { return { items: [] }; },
      async discoverCapabilities() { return sessionCreateCapability(); },
    },
  }, { host, now: () => NOW });
  await waitUntil(() => host.writes.some((frame) => frame.includes("dev")));
  host.send([0x0d]);
  await waitUntil(() => host.writes.at(-1).includes("New Claude session"));
  assert.doesNotMatch(host.writes.at(-1), /OpenCode|ensure/iu);
  host.send([0x0d]);
  assert.deepEqual(await operation, { kind: "launch", agent: "claude-code", machineId: MACHINE, machineName: "dev", newSession: true });
});

test("root journey argv contains no internal identifiers", () => {
  const selection = { kind: "launch", agent: "codex", machineId: MACHINE, machineName: "owner-dev" };
  assert.deepEqual(rootJourneyArgv(selection), ["codex", "--machine", "owner-dev"]);
  assert.deepEqual(
    rootJourneyArgv({ kind: "launch", agent: "claude-code", machineName: "dev", newSession: true }),
    ["claude", "--machine", "dev", "--new-session"],
  );
  assert.deepEqual(rootJourneyArgv({ kind: "launch", agent: "codex" }), ["codex"]);
  assert.deepEqual(rootJourneyArgv({ kind: "launch", agent: "opencode" }), ["opencode"]);
});

test("pre-aborted root journey performs no API or terminal effect", async () => {
  const controller = new AbortController();
  controller.abort();
  let effects = 0;
  assert.equal(await runNodeRootJourney({
    signal: controller.signal,
    client: { async listMachines() { effects += 1; return { items: [] }; } },
  }, { host: { async acquire() { effects += 1; throw new Error("unreachable"); } } }), undefined);
  assert.equal(effects, 0);
});
