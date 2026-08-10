import assert from "node:assert/strict";
import test from "node:test";

import { runCli, memoryStreams } from "../dist/cli/run.js";
import { evaluateRuntimeSupport, isSupportedNodeVersion } from "../dist/platform/support.js";

function parseSingleRecord(value) {
  const lines = value.trim().split("\n");
  assert.equal(lines.length, 1);
  return JSON.parse(lines[0]);
}

test("version JSON carries a candidate-bound runtime identity", async () => {
  const capture = memoryStreams();
  const exitCode = await runCli(["version", "--json"], { streams: capture.streams });
  assert.equal(exitCode, 0);
  assert.equal(capture.stderr(), "");
  const record = parseSingleRecord(capture.stdout());
  assert.equal(record.schema_version, "1");
  assert.equal(record.type, "result");
  assert.equal(record.command, "version");
  assert.equal(record.data.version, "0.1.0");
  assert.match(record.data.buildDigest, /^[0-9a-f]{64}$/u);
  assert.equal(record.data.platform, process.platform);
  assert.equal(record.data.architecture, process.arch);
  assert.equal(record.data.artifactChannel, "npm");
  assert.equal(record.data.updateChannel, "npm");
  assert.deepEqual(record.data.protocolRange, { minimum: "1", maximum: "1" });
});

test("offline self-test is network-free and reports explicit checks", async () => {
  const capture = memoryStreams();
  let requests = 0;
  const exitCode = await runCli(["self-test", "--offline", "--json"], {
    streams: capture.streams,
    env: {},
    fetch: async () => {
      requests += 1;
      throw new Error("offline self-test attempted network I/O");
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(requests, 0);
  assert.equal(capture.stderr(), "");
  const record = parseSingleRecord(capture.stdout());
  assert.equal(record.command, "self-test");
  assert.equal(record.data.ok, true);
  assert.equal(record.data.mode, "offline");
  assert.equal(record.data.checks.network_requests, 0);
  assert.equal(record.data.checks.virtual_terminal, true);
  assert.match(record.data.buildDigest, /^[0-9a-f]{64}$/u);
  assert.equal(record.data.updateChannel, "npm");
  assert.equal(record.data.artifactChannel, "npm");
});

test("self-test fails closed without the explicit offline mode", async () => {
  const capture = memoryStreams();
  const exitCode = await runCli(["self-test", "--json"], {
    streams: capture.streams,
    env: {},
  });
  assert.notEqual(exitCode, 0);
  const record = parseSingleRecord(capture.stderr());
  assert.equal(record.type, "error");
  assert.equal(record.error.code, "cuna.usage.invalid");
});

test("runtime support admits the architecture-neutral x64 and arm64 package", () => {
  assert.equal(isSupportedNodeVersion("22.17.0"), false);
  assert.equal(isSupportedNodeVersion("22.17.1"), true);
  assert.equal(isSupportedNodeVersion("23.9.0"), false);
  assert.equal(isSupportedNodeVersion("24.4.0"), false);
  assert.equal(isSupportedNodeVersion("24.4.1"), true);
  assert.equal(isSupportedNodeVersion("25.0.0"), false);
  assert.equal(isSupportedNodeVersion("not-semver"), false);
  assert.deepEqual(
    evaluateRuntimeSupport({ nodeVersion: "24.4.1", platform: "darwin", architecture: "arm64" }),
    { nodeRuntime: true, platform: true, architecture: true },
  );
  assert.deepEqual(
    evaluateRuntimeSupport({ nodeVersion: "24.4.1", platform: "freebsd", architecture: "x64" }),
    { nodeRuntime: true, platform: false, architecture: true },
  );
  assert.deepEqual(
    evaluateRuntimeSupport({ nodeVersion: "24.4.1", platform: "linux", architecture: "arm" }),
    { nodeRuntime: true, platform: true, architecture: false },
  );
});
