import assert from "node:assert/strict";
import test from "node:test";

import { runCli, memoryStreams } from "../dist/cli/run.js";
import { packageBuildManifest } from "../dist/build-identity.js";
import { evaluateRuntimeSupport, isSupportedNodeVersion } from "../dist/platform/support.js";

function parseSingleRecord(value) {
  const lines = value.trim().split("\n");
  assert.equal(lines.length, 1);
  return JSON.parse(lines[0]);
}

test("package identity excludes the non-public credential preview files", async () => {
  const manifest = await packageBuildManifest();
  assert.equal(
    manifest.files.some((entry) => entry.file.startsWith("dist/credentials/local-session-preview.")),
    false,
  );
});

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
  assert.equal(record.data.artifactChannel, "local");
  assert.equal(record.data.updateChannel, "local");
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
  assert.equal(record.data.updateChannel, "local");
  assert.equal(record.data.artifactChannel, "local");
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

// `self-test --offline` and `doctor` read different sources — host
// admissibility versus product feature admission — and both answers are
// correct. What was wrong was the CLAIM: measured on this host, `self-test`
// reported `ok: true` and printed "Offline self-test passed." while `doctor`
// reported all six runtime features `unsupported`. The aggregate is scoped to
// what it actually covers, and the uncovered ground is enumerated in the
// record rather than left to be inferred.
test("the offline self-test states the ground it does not cover", async () => {
  const capture = memoryStreams();
  const exitCode = await runCli(["self-test", "--offline", "--json"], {
    streams: capture.streams,
    env: {},
    fetch: async () => { throw new Error("offline self-test attempted network I/O"); },
  });
  assert.equal(exitCode, 0);
  const record = parseSingleRecord(capture.stdout());
  assert.equal(record.data.ok, true);
  assert.equal(record.data.scope, "installation_integrity");
  assert.deepEqual(record.data.notChecked, ["runtime_features", "server_contract", "credential_state"]);

  // The human line must not read as a verdict on the product.
  const human = memoryStreams({ stdoutIsTTY: true });
  assert.equal(await runCli(["self-test", "--offline"], {
    streams: human.streams,
    env: {},
    fetch: async () => { throw new Error("offline self-test attempted network I/O"); },
  }), 0);
  assert.match(human.stdout(), /installation integrity only/u);
  assert.match(human.stdout(), /cuna doctor/u);
});

// `canonical_api_origin` was `config.baseUrl === DEFAULT_BASE_URL ||
// config.developmentProfile`. `normalizeBaseUrl` returns `DEFAULT_BASE_URL` or
// throws unless a development profile is active, so the disjunction restated
// its own precondition and could not return false. It was reported inside
// `checks`, whose aggregate is `ok`, which additionally claimed a configuration
// choice was an installation defect.
test("the reported API origin is a fact that can disagree with the canonical one", async () => {
  const platform = (text) => ({
    kind: "linux",
    paths: {
      configDirectory: "/home/test/.config/cuna",
      stateDirectory: "/home/test/.local/state/cuna",
      runtimeDirectory: "/run/user/1000/cuna",
    },
    async readSafeConfig() {
      return text === undefined ? { exists: false } : { exists: true, text };
    },
  });
  const run = async (dependencies) => {
    const capture = memoryStreams();
    const exitCode = await runCli(["self-test", "--offline", "--json"], {
      streams: capture.streams,
      fetch: async () => { throw new Error("offline self-test attempted network I/O"); },
      ...dependencies,
    });
    return { exitCode, record: parseSingleRecord(capture.stdout()) };
  };

  const canonical = await run({ env: {}, platform: platform() });
  assert.equal(canonical.record.data.apiOrigin, "https://api.getcuna.com");
  assert.equal(canonical.record.data.apiOriginSource, "default");
  assert.equal(canonical.record.data.apiOriginIsCanonical, true);

  // A development profile pointed at a loopback origin. The removed check
  // returned `true` here; the reported fact returns `false`.
  const development = await run({
    env: { CUNA_PROFILE: "dev" },
    platform: platform(JSON.stringify({
      schema_version: 1,
      profiles: { dev: { development: true, base_url: "http://127.0.0.1:8787" } },
    })),
  });
  assert.equal(development.record.data.apiOrigin, "http://127.0.0.1:8787");
  assert.equal(development.record.data.apiOriginSource, "profile");
  assert.equal(development.record.data.apiOriginIsCanonical, false);

  // A configuration choice is not an installation defect: `ok` stays true, and
  // the tautology is gone from the aggregate rather than moved into it.
  assert.equal(development.exitCode, 0);
  assert.equal(development.record.data.ok, true);
  assert.equal(Object.hasOwn(development.record.data.checks, "canonical_api_origin"), false);
});
