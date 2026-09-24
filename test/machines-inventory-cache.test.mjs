import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CunaError, runNodeMachinesExplorer } from "../dist/index.js";
import { machineInventoryCache, parseMachineInventorySnapshot } from "../dist/machines/inventory-cache.js";
import { createPlatformAdapter } from "../dist/platform/adapter.js";

const MACHINE_ID = "33333333-3333-4333-8333-333333333333";

class FakeHost {
  columns = 120;
  rows = 30;
  writes = [];
  input;
  restored = 0;
  dimensions() { return { columns: this.columns, rows: this.rows }; }
  async acquire() { return { restore: async () => { this.restored += 1; } }; }
  async write(bytes) { this.writes.push(new TextDecoder().decode(bytes)); }
  onInput(listener) { this.input = listener; return () => { this.input = undefined; }; }
  onResize() { return () => {}; }
  emitInput(bytes) { this.input?.(Uint8Array.from(bytes)); }
}

function memoryCache(snapshot) {
  const cache = { snapshot, writes: [], async read() { return cache.snapshot; }, async write(next) { cache.writes.push(next); cache.snapshot = next; }, async clear() { cache.snapshot = undefined; } };
  return cache;
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

const lastFrame = (host) => host.writes.at(-1) ?? "";

test("the first frame shows the last known Machines, not selectable, until the live list replaces them", async () => {
  const host = new FakeHost();
  const cache = memoryCache({ savedAt: Date.now() - 5 * 60_000, machines: [{ id: MACHINE_ID, name: "rexbit-claude-qa6", state: "running", sessionCount: 2 }] });
  let answerList;
  const client = {
    listMachines: () => new Promise((resolve) => { answerList = resolve; }),
    async listAgentSessions() { return { items: [] }; },
  };
  const operation = runNodeMachinesExplorer({ client, color: false, inventoryCache: cache }, { host });
  try {
    await waitUntil(() => lastFrame(host).includes("rexbit-claude-qa6"), "the cached row is in a frame before the list answers");
    const cachedFrame = lastFrame(host);
    assert.match(cachedFrame, /Refreshing machines · last known list from 5 min ago/u);
    assert.match(cachedFrame, / {2}· rexbit-claude-qa6 {2}running {2}2 sessions/u);
    assert.doesNotMatch(cachedFrame, /❯/u, "nothing is selectable on a picture");
    assert.doesNotMatch(cachedFrame, /Discovering machines/u);
    // Enter and Right on the picture do nothing.
    host.emitInput([0x0d]);
    host.emitInput([0x1b, 0x5b, 0x43]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(host.restored, 0);
    assert.doesNotMatch(lastFrame(host), /CUNA {2}◆── rexbit/u, "no machine detail opened from the picture");

    answerList({ items: [{ id: MACHINE_ID, name: "rexbit-claude-qa6", state: "running", agent: "claude-code" }] });
    await waitUntil(() => /❯ ▾ rexbit-claude-qa6/u.test(lastFrame(host)) && lastFrame(host).includes("no sessions"), "the live row replaces the picture");
    assert.doesNotMatch(lastFrame(host), /last known|^ {2}· /mu);
    await waitUntil(() => cache.writes.some((snapshot) => snapshot.machines[0]?.sessionCount === 0), "the settled list is saved with its session count");
    assert.deepEqual(cache.writes.at(-1).machines, [{ id: MACHINE_ID, name: "rexbit-claude-qa6", state: "running", sessionCount: 0 }]);
  } finally {
    answerList?.({ items: [] });
    host.emitInput([0x71]);
    assert.equal(await operation, undefined);
  }
});

test("without a picture the first frame still says it is discovering", async () => {
  const host = new FakeHost();
  let answerList;
  const operation = runNodeMachinesExplorer({ client: {
    listMachines: () => new Promise((resolve) => { answerList = resolve; }),
    async listAgentSessions() { return { items: [] }; },
  }, color: false, inventoryCache: memoryCache(undefined) }, { host });
  try {
    await waitUntil(() => lastFrame(host).includes("Discovering machines"), "discovering frame");
    assert.doesNotMatch(lastFrame(host), /last known/u);
  } finally {
    answerList?.({ items: [] });
    host.emitInput([0x71]);
    await operation;
  }
});

test("a failed live list keeps the picture, labelled as last known, next to the typed failure", async () => {
  const host = new FakeHost();
  const cache = memoryCache({ savedAt: Date.now() - 30_000, machines: [{ id: MACHINE_ID, name: "old-box", state: "stopped" }] });
  const operation = runNodeMachinesExplorer({ client: {
    async listMachines() { throw new CunaError({ code: "cuna.network.service_unavailable", message: "offline", exitCode: 5, retryable: true }); },
    async listAgentSessions() { return { items: [] }; },
  }, color: false, inventoryCache: cache }, { host, listRetry: { windowMs: 0 } });
  try {
    await waitUntil(() => lastFrame(host).includes("Machines could not be listed."), "failure frame");
    assert.match(lastFrame(host), /Last known list, from 30 s ago:/u);
    assert.match(lastFrame(host), / {2}· old-box {2}stopped/u);
    assert.equal(cache.writes.length, 0, "a failure never overwrites the picture");
  } finally {
    host.emitInput([0x71]);
    await operation.catch(() => undefined);
  }
});

test("the picture file round-trips per profile, parses strictly and clears", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cuna-inventory-cache-"));
  try {
    const platform = createPlatformAdapter({ homeDirectory: root, env: { LOCALAPPDATA: root, APPDATA: root, XDG_STATE_HOME: root, XDG_CONFIG_HOME: root, HOME: root } });
    const cache = machineInventoryCache(platform, { baseUrl: "https://api.getcuna.com", profile: "default" });
    const other = machineInventoryCache(platform, { baseUrl: "https://api.getcuna.com", profile: "work" });
    assert.equal(await cache.read(), undefined);
    const snapshot = { savedAt: 1_790_000_000_000, machines: [{ id: MACHINE_ID, name: "box", state: "running", sessionCount: 1 }, { id: "m2", name: "idle", state: "stopped" }] };
    await cache.write(snapshot);
    assert.deepEqual(await cache.read(), snapshot);
    assert.equal(await other.read(), undefined, "another profile never sees this picture");
    await cache.clear();
    assert.equal(await cache.read(), undefined);
    await cache.clear();
  } finally { await rm(root, { recursive: true, force: true }); }

  const good = { savedAt: 1, machines: [{ id: "a", name: "b", state: "running" }] };
  assert.deepEqual(parseMachineInventorySnapshot(JSON.stringify(good)), good);
  for (const bad of [
    { ...good, extra: 1 },
    { savedAt: -1, machines: [] },
    { savedAt: 1, machines: [{ id: "a", name: "b", state: "running", token: "x" }] },
    { savedAt: 1, machines: [{ id: "a", name: "b", state: "RUNNING\u001b[2J" }] },
    { savedAt: 1, machines: [{ id: "a", name: "b", state: "running", sessionCount: -1 }] },
    { savedAt: 1, machines: Array.from({ length: 201 }, () => good.machines[0]) },
  ]) assert.equal(parseMachineInventorySnapshot(JSON.stringify(bad)), undefined, JSON.stringify(bad).slice(0, 80));
  assert.equal(parseMachineInventorySnapshot("{"), undefined);
});
