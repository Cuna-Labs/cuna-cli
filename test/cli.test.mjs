import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EXIT_CODES, memoryStreams, parseArgv, runCli } from "../dist/index.js";

const API_KEY = "runa_sk_abcdefghijklmnop";
const future = "2099-01-01T00:00:00.000Z";

const platform = {
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
};

function capabilitySnapshot(capabilities) {
  return {
    schemaVersion: "1",
    subjectScope: "account",
    observedAt: "2026-08-08T00:00:00.000Z",
    expiresAt: future,
    etag: "fixture",
    capabilities,
  };
}

function fakeClient(overrides = {}) {
  return {
    async discoverCapabilities() { return capabilitySnapshot([]); },
    async listMachines() { return { items: [] }; },
    async createMachine() { throw new Error("unexpected create"); },
    async transitionMachine() { throw new Error("unexpected transition"); },
    async deleteMachine() { throw new Error("unexpected delete"); },
    async listAgentSessions() { return { items: [] }; },
    async createAgentSession() { throw new Error("unexpected create agent"); },
    async getAgentSession() { throw new Error("unexpected get agent"); },
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

test("non-TTY help and version are versioned JSON records", async () => {
  const help = memoryStreams();
  assert.equal(await runCli(["--help"], { streams: help.streams }), EXIT_CODES.success);
  const helpRecord = JSON.parse(help.stdout());
  assert.equal(helpRecord.schema_version, "1");
  assert.equal(helpRecord.type, "result");
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
  assert.equal(JSON.parse(streams.stderr()).error.code, "runa.auth.required");
});

test("machine list calls the real public legacy Machine projection", async () => {
  const requests = [];
  const streams = memoryStreams();
  const exit = await runCli(["machines", "list"], {
    streams: streams.streams,
    platform,
    env: { RUNA_API_KEY: API_KEY },
    fetch: async (url, init) => {
      requests.push({ url: url.toString(), init });
      return new Response(JSON.stringify([{ id: "m_1", name: "dev", status: "running" }]), { status: 200 });
    },
  });
  assert.equal(exit, EXIT_CODES.success);
  assert.equal(requests[0].url, "https://api.runacode.io/v1/sessions");
  assert.equal(JSON.parse(streams.stdout()).data.items[0].id, "m_1");
  assert.equal(streams.stdout().includes(API_KEY), false);
});

test("absent capability is a negative control: no machine mutation occurs", async () => {
  let creates = 0;
  const streams = memoryStreams();
  const exit = await runCli(["machines", "create", "--name", "dev", "--yes", "--idempotency-key", "op_1"], {
    streams: streams.streams,
    platform,
    env: { RUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => fakeClient({ async createMachine() { creates += 1; return {}; } }),
  });
  assert.equal(exit, EXIT_CODES.unsupported);
  assert.equal(creates, 0);
  assert.equal(JSON.parse(streams.stderr()).error.code, "runa.capability.unknown");
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
  });
  const exit = await runCli(["machines", "create", "--name", "dev", "--yes", "--idempotency-key", "op_1"], {
    streams: streams.streams,
    platform,
    env: { RUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  });
  assert.equal(exit, EXIT_CODES.success);
  assert.equal(creates, 1);
  assert.equal(key, "op_1");
  assert.equal(JSON.parse(streams.stdout()).data.state, "creating");
});

test("reserved cloud-terminal commands fail explicitly instead of simulating a session", async () => {
  const streams = memoryStreams();
  const exit = await runCli(["claude"], { streams: streams.streams, platform, env: {} });
  assert.equal(exit, EXIT_CODES.unsupported);
  const error = JSON.parse(streams.stderr()).error;
  assert.equal(error.code, "runa.capability.unsupported");
  assert.equal(error.details.reason, "prd_008_035_038_runtime_missing");
});

test("package and runtime versions remain identical", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const streams = memoryStreams();
  await runCli(["--version"], { streams: streams.streams });
  assert.equal(JSON.parse(streams.stdout()).data.version, packageJson.version);
});
