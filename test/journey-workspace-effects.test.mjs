import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { conservativeFilesystemCapabilities, createWorkspaceJourneyEffects } from "../dist/journey/workspace-effects.js";

const USER = "10000000-0000-4000-8000-000000000001";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";
const MACHINE = "30000000-0000-4000-8000-000000000001";
const OTHER_MACHINE = "30000000-0000-4000-8000-000000000002";

async function roots(t) {
  const base = await mkdtemp(join(tmpdir(), "cuna-journey-workspace-"));
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(base, { recursive: true, force: true })); });
  const project = join(base, "project");
  const state = join(base, "state");
  await Promise.all([mkdir(project), mkdir(state)]);
  return { project, state };
}

function effects(client, stateDirectory) {
  return createWorkspaceJourneyEffects({
    client,
    transport: { authentication: "authenticated", credentialAuthority: "interactive", async request() { throw new Error("unexpected sync"); } },
    profileId: "default",
    userId: USER,
    workspaceId: WORKSPACE,
    stateDirectory,
    filesystemCapabilities: conservativeFilesystemCapabilities("windows"),
  });
}

test("workspace create retry reuses the exact durable identity tuple and idempotency key", async (t) => {
  const { project, state } = await roots(t);
  const creates = [];
  const client = {
    async createWorkspaceBinding(input, key) {
      creates.push(structuredClone({ input, key }));
      throw new Error("response lost");
    },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      effects(client, state).synchronizeWorkspace({ machineId: MACHINE, localPath: project, syncMode: "enabled", signal: new AbortController().signal }),
      /response lost/u,
    );
  }
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[1], creates[0]);
  assert.match(creates[0].input.projectId, /^[0-9a-f-]{36}$/u);
  assert.match(creates[0].input.localInstanceId, /^[0-9a-f-]{36}$/u);
  assert.match(creates[0].key, /^cuna-workspace-binding-v2-[0-9a-f]{64}$/u);
});

test("workspace create idempotency changes when the request body selects another machine", async (t) => {
  const { project, state } = await roots(t);
  const creates = [];
  const client = {
    async createWorkspaceBinding(input, key) {
      creates.push(structuredClone({ input, key }));
      throw new Error("stop after create boundary");
    },
  };
  for (const machineId of [MACHINE, OTHER_MACHINE]) {
    await assert.rejects(
      effects(client, state).synchronizeWorkspace({ machineId, localPath: project, syncMode: "enabled", signal: new AbortController().signal }),
      /stop after create boundary/u,
    );
  }
  assert.equal(creates.length, 2);
  assert.notEqual(creates[0].key, creates[1].key);
  assert.equal(creates[0].input.machineId, MACHINE);
  assert.equal(creates[1].input.machineId, OTHER_MACHINE);
});

test("--no-sync without a committed local binding performs no producer mutation", async (t) => {
  const { project, state } = await roots(t);
  let creates = 0;
  const client = { async createWorkspaceBinding() { creates += 1; throw new Error("unexpected"); } };
  await assert.rejects(
    effects(client, state).synchronizeWorkspace({ machineId: MACHINE, localPath: project, syncMode: "disabled", signal: new AbortController().signal }),
    (error) => error.code === "cuna.journey.workspace_binding_required",
  );
  assert.equal(creates, 0);
});
