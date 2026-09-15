import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkspaceJourneyEffects, conservativeFilesystemCapabilities } from "../dist/journey/workspace-effects.js";
import { orchestrateAgentJourney } from "../dist/journey/orchestrator.js";
import { createWorkspaceManifest } from "../dist/workspace/manifest.js";
import { compileExclusionPolicy } from "../dist/workspace/exclusion.js";
import { workspaceError } from "../dist/workspace/errors.js";

const USER = "10000000-0000-4000-8000-000000000001";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";
const MACHINE = "30000000-0000-4000-8000-000000000001";
const capabilities = conservativeFilesystemCapabilities("windows");
const secret = ["cuna_", "sk_", "a".repeat(43)].join("");

async function fixture(t, overrides = {}) {
  const base = await mkdtemp(join(tmpdir(), "cuna-preflight-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  await mkdir(root);
  const calls = [];
  const local = createWorkspaceJourneyEffects({
    profileId: "default", userId: USER, workspaceId: WORKSPACE,
    stateDirectory: join(base, "state"), filesystemCapabilities: capabilities,
    client: { async createWorkspaceBinding(input) {
      calls.push("binding");
      return { ...input, bindingId: "40000000-0000-4000-8000-000000000001", activeGeneration: 0, activeManifestRoot: null, remoteRoot: "/workspace/project" };
    } },
    transport: { authentication: "authenticated", credentialAuthority: "interactive", async request() { calls.push("upload"); throw new Error("unexpected upload"); } },
    ...overrides,
  });
  const stop = new Error("safe preflight reached provisioning");
  const effects = {
    ...local,
    async observeMachines() { calls.push("observe"); return []; },
    async createMachine() { calls.push("create"); throw stop; },
    async reconcileMachineCreate() { calls.push("reconcile"); throw new Error("unexpected reconcile"); },
    async ensureMachineReady() { calls.push("ready"); return { id: MACHINE, state: "running" }; },
    async createAgentSession() { calls.push("session"); throw new Error("unexpected session"); },
    async reconcileCancellation() { calls.push("cancel"); },
  };
  const run = (signal = new AbortController().signal) => orchestrateAgentJourney({
    effects, signal, scope: { userId: USER, workspaceId: WORKSPACE },
    intent: { schemaVersion: "1.0", command: "claude", agent: "claude-code", target: "reconcile", machine: { kind: "new" }, localPath: root, syncMode: "enabled", newSession: false },
  });
  return { root, local, effects, calls, stop, run };
}

test("secret preflight refuses before cloud effects and gives only safe recovery guidance", async t => {
  assert.equal(workspaceError("path_escape", "Unsafe path", "policy", "outside_root").hint, undefined);
  const fx = await fixture(t);
  const filename = "untrusted-private-location.txt";
  await writeFile(join(fx.root, filename), secret);
  await assert.rejects(fx.run(), error => {
    assert.equal(error.code, "cuna.workspace.secret_blocked");
    assert.equal(error.details.reason, "service_token");
    assert.match(error.hint, /synchronization scope.*intended project folder/u);
    const rendered = JSON.stringify({ message: error.message, hint: error.hint, details: error.details });
    assert.ok(!rendered.includes(secret) && !rendered.includes(filename) && !rendered.includes(fx.root));
    return true;
  });
  assert.deepEqual(fx.calls, []);
});

test("oversized local content refuses before provisioning without reading its bytes", async t => {
  const fx = await fixture(t);
  const handle = await open(join(fx.root, "large.bin"), "w");
  try { await handle.truncate(512 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await assert.rejects(fx.run(), error => error.details?.reason === "file_bytes_limit");
  assert.deepEqual(fx.calls, []);
});

test("unportable local path refuses before provisioning", async t => {
  const fx = await fixture(t, { filesystemCapabilities: { ...capabilities, maximumComponentBytes: 8 } });
  await writeFile(join(fx.root, "long-filename.txt"), "safe");
  await assert.rejects(fx.run(), error => error.details?.reason === "component_too_long");
  assert.deepEqual(fx.calls, []);
});

for (const excluded of [false, true]) {
  test(`safe preflight proceeds to provisioning; excluded secret=${excluded}`, async t => {
    const fx = await fixture(t);
    await writeFile(join(fx.root, "main.txt"), "ordinary project");
    if (excluded) {
      await writeFile(join(fx.root, ".cunaignore"), "private.txt\n");
      await writeFile(join(fx.root, "private.txt"), secret);
    }
    await assert.rejects(fx.run(), error => error === fx.stop);
    assert.deepEqual(fx.calls, ["observe", "create"]);
  });
}

test("no-sync inspection retains policy-only behavior and existing binding requirement", async t => {
  const fx = await fixture(t);
  await writeFile(join(fx.root, "private.txt"), secret);
  const input = { localPath: fx.root, syncMode: "disabled", signal: new AbortController().signal };
  await fx.local.inspectWorkspace(input);
  await assert.rejects(fx.local.synchronizeWorkspace({ ...input, machineId: MACHINE }), error => error.code === "cuna.journey.workspace_binding_required");
  assert.deepEqual(fx.calls, []);
});

test("secret introduced after preflight is rejected by real synchronization before upload or session", async t => {
  const fx = await fixture(t);
  await writeFile(join(fx.root, "main.txt"), "safe");
  fx.effects.createMachine = async () => {
    fx.calls.push("create");
    await writeFile(join(fx.root, "main.txt"), secret);
    return { id: MACHINE, state: "running" };
  };
  await assert.rejects(fx.run(), error => error.code === "cuna.workspace.secret_blocked");
  assert.deepEqual(fx.calls, ["observe", "create", "ready", "binding"]);
});

for (const during of [false, true]) {
  test(`preflight cancellation prevents provisioning; during traversal=${during}`, async t => {
    const fx = await fixture(t);
    await writeFile(join(fx.root, "main.txt"), "safe");
    const controller = new AbortController();
    let checks = 0;
    if (during) {
      const original = controller.signal.throwIfAborted.bind(controller.signal);
      // Inject cancellation at the actual fourth scan checkpoint, not a timer race.
      controller.signal.throwIfAborted = () => { if (++checks === 4) controller.abort(); original(); };
    } else controller.abort();
    await assert.rejects(fx.run(controller.signal), error => error.code === "cuna.journey.cancelled");
    if (during) assert.equal(checks, 4);
    assert.deepEqual(fx.calls, ["cancel"]);
  });
}

test("cancellation at content admission closes the file and rejects the manifest", async t => {
  const fx = await fixture(t);
  const path = join(fx.root, "main.txt");
  await writeFile(path, "safe");
  const controller = new AbortController();
  await assert.rejects(createWorkspaceManifest({
    root: fx.root, capabilities, policy: compileExclusionPolicy([], capabilities), signal: controller.signal,
    beforeContentRead() { controller.abort(); },
  }), error => error.name === "AbortError");
  await rm(path);
});
