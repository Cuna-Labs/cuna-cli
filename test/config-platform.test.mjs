import assert from "node:assert/strict";
import test from "node:test";

import {
  CREDENTIAL_BRANDS,
  DEFAULT_BASE_URL,
  EXIT_CODES,
  assertApiKeyUsable,
  brandedEnvironmentNames,
  environmentCredentialState,
  memoryStreams,
  publicConfig,
  resolveConfig,
  resolvePlatformPaths,
  runCli,
  CunaError,
} from "../dist/index.js";

function fakePlatform(text) {
  return {
    kind: "linux",
    paths: {
      configDirectory: "/home/test/.config/cuna",
      stateDirectory: "/home/test/.local/state/cuna",
      runtimeDirectory: "/run/user/1000/cuna",
    },
    async readSafeConfig() {
      return text === undefined ? { exists: false } : { exists: true, text };
    },
  };
}

test("platform paths are explicit for all three Tier-1 families", () => {
  const win = resolvePlatformPaths({ platform: "win32", env: { APPDATA: "C:\\A", LOCALAPPDATA: "C:\\L" }, homeDirectory: "C:\\U" });
  const mac = resolvePlatformPaths({ platform: "darwin", env: { TMPDIR: "/tmp/u" }, homeDirectory: "/Users/u", userId: 501 });
  const linux = resolvePlatformPaths({ platform: "linux", env: { XDG_CONFIG_HOME: "/cfg", XDG_STATE_HOME: "/state", XDG_RUNTIME_DIR: "/run" }, homeDirectory: "/home/u", userId: 1000 });
  assert.equal(win.configDirectory, "C:\\A\\Cuna");
  assert.equal(mac.configDirectory, "/Users/u/Library/Application Support/Cuna");
  assert.equal(linux.runtimeDirectory, "/run/cuna");
});

test("configuration defaults to the canonical production origin and never persists an API key", async () => {
  const config = await resolveConfig({ platform: fakePlatform(), env: { CUNA_API_KEY: "cuna_sk_abcdefghijklmnop" } });
  assert.equal(config.baseUrl, DEFAULT_BASE_URL);
  assert.equal(config.apiKeySource, "environment");
});

// The key store still issues and holds `runa_sk_` keys, and no issued key was
// ever revoked. A single-brand pin here rejected every key the service actually
// mints before a single request left the process — the CLI was unusable with a
// valid credential. Every brand the product has ever issued must resolve.
test("CUNA_API_KEY admits every credential brand the service has issued", async () => {
  // Literal floor. A loop over CREDENTIAL_BRANDS alone cannot detect its own
  // subject shrinking: drop a brand and the loop just runs one case fewer,
  // still green. These two names are live credentials and may never be dropped.
  assert.ok(CREDENTIAL_BRANDS.includes("cuna"));
  assert.ok(CREDENTIAL_BRANDS.includes("runa"));
  for (const brand of new Set(["cuna", "runa", ...CREDENTIAL_BRANDS])) {
    const apiKey = `${brand}_sk_${"a".repeat(43)}`;
    const config = await resolveConfig({
      platform: fakePlatform(),
      env: { CUNA_API_KEY: apiKey },
    });
    assert.equal(config.apiKey, apiKey, apiKey);
    assert.equal(config.apiKeySource, "environment", apiKey);
  }
  for (const unusable of [`evil_sk_${"a".repeat(43)}`, "cuna_sk_short"]) {
    const config = await resolveConfig({ platform: fakePlatform(), env: { CUNA_API_KEY: unusable } });
    assert.equal(config.apiKey, undefined, unusable);
    assert.throws(
      () => { assertApiKeyUsable(config); },
      (error) => error instanceof CunaError && error.details?.reason === "invalid_api_key",
      unusable,
    );
  }
});

// This test replaces one named "only Cuna environment names configure the
// pre-GA CLI", which asserted that `RUNA_API_KEY` alone yields no credential.
// That assertion encoded the defect: the rename REPLACED four `RUNA_*` reads
// instead of adding to them, while `CREDENTIAL_BRANDS` and both SDKs went on
// accepting the earlier brand. A customer holding a live `runa_sk_` key and
// exporting `RUNA_API_KEY` authenticated through both SDKs and was refused here
// with exit 2. The old test was not weakened to pass; it was asserting the
// wrong thing, and the behaviour it pinned is the one being removed.
test("configuration names are Cuna-only while deployed credential bytes remain compatible", async () => {
  assert.deepEqual(brandedEnvironmentNames("API_KEY"), ["CUNA_API_KEY"]);
  assert.deepEqual(brandedEnvironmentNames("BASE_URL"), ["CUNA_BASE_URL"]);
  assert.deepEqual(brandedEnvironmentNames("PROFILE"), ["CUNA_PROFILE"]);
  assert.deepEqual(brandedEnvironmentNames("CONFIG_FILE"), ["CUNA_CONFIG_FILE"]);

  const profileText = JSON.stringify({
    schema_version: 1,
    profiles: { dev: { development: true } },
  });
  for (const brand of new Set(["cuna", "runa", ...CREDENTIAL_BRANDS])) {
    const prefix = "CUNA";
    const apiKey = `${brand}_sk_${"a".repeat(43)}`;

    const credential = await resolveConfig({
      platform: fakePlatform(),
      env: { [`${prefix}_API_KEY`]: apiKey },
    });
    assert.equal(credential.apiKey, apiKey, `${prefix}_API_KEY`);
    assert.equal(credential.apiKeySource, "environment", `${prefix}_API_KEY`);
    assert.equal(credential.apiKeyVariable, `${prefix}_API_KEY`, `${prefix}_API_KEY`);

    const origin = await resolveConfig({
      platform: fakePlatform(profileText),
      env: { [`${prefix}_PROFILE`]: "dev", [`${prefix}_BASE_URL`]: "https://environment.example" },
    });
    assert.equal(origin.profile, "dev", `${prefix}_PROFILE`);
    assert.equal(origin.profileSource, "environment", `${prefix}_PROFILE`);
    assert.equal(origin.baseUrl, "https://environment.example", `${prefix}_BASE_URL`);
    assert.equal(origin.baseUrlSource, "environment", `${prefix}_BASE_URL`);

    const file = await resolveConfig({
      platform: fakePlatform(profileText),
      env: { [`${prefix}_CONFIG_FILE`]: "/explicit/config.json" },
    });
    assert.equal(file.configFile, "/explicit/config.json", `${prefix}_CONFIG_FILE`);
  }
});

test("unpublished legacy configuration aliases are ignored and cannot become fallback authority", async () => {
  const canonical = `cuna_sk_${"a".repeat(43)}`;
  const legacy = `runa_sk_${"b".repeat(43)}`;
  const legacyOnly = await resolveConfig({ platform: fakePlatform(), env: { RUNA_API_KEY: legacy } });
  assert.equal(legacyOnly.apiKey, undefined);
  assert.equal(legacyOnly.apiKeyVariable, undefined);
  const both = await resolveConfig({
    platform: fakePlatform(),
    env: { CUNA_API_KEY: canonical, RUNA_API_KEY: legacy },
  });
  assert.equal(both.apiKey, canonical);
  assert.equal(both.apiKeyVariable, "CUNA_API_KEY");

  // The realistic trigger: `export CUNA_API_KEY=$(fetch-secret)` where the
  // fetch failed, in a shell that still exports a stale legacy key. Falling
  // back would authenticate as a credential the caller did not choose.
  const emptyCanonical = await resolveConfig({
    platform: fakePlatform(),
    env: { CUNA_API_KEY: "", RUNA_API_KEY: legacy },
  });
  assert.equal(emptyCanonical.apiKey, undefined);
  assert.equal(emptyCanonical.apiKeyVariable, "CUNA_API_KEY");
  assert.equal(environmentCredentialState(emptyCanonical), "invalid");
  assert.throws(
    () => { assertApiKeyUsable(emptyCanonical); },
    (error) => error instanceof CunaError &&
      error.details.reason === "invalid_api_key" &&
      error.details.variable === "CUNA_API_KEY",
  );

  const text = JSON.stringify({ schema_version: 1, profiles: { dev: { development: true } } });
  await assert.rejects(
    resolveConfig({
      platform: fakePlatform(text),
      env: { CUNA_PROFILE: "dev", CUNA_BASE_URL: "", RUNA_BASE_URL: "https://legacy.example" },
    }),
    (error) => error instanceof CunaError &&
      error.details.reason === "invalid_base_url" &&
      error.details.variable === "CUNA_BASE_URL",
  );
  await assert.rejects(
    resolveConfig({
      platform: fakePlatform(text),
      env: { CUNA_PROFILE: "", RUNA_PROFILE: "dev" },
    }),
    (error) => error instanceof CunaError &&
      error.details.reason === "invalid_profile_name" &&
      error.details.variable === "CUNA_PROFILE",
  );
});

test("an environment fault names the variable at fault, not the user profile", async () => {
  // The hint said "correct the selected user profile" while the same payload's
  // `details.source` said `environment` — the two halves of one error naming
  // different authorities, and the half a human reads naming the one that was
  // not involved. With two accepted spellings that is no longer merely vague.
  const config = await resolveConfig({ platform: fakePlatform(), env: { CUNA_API_KEY: "" } });
  assert.throws(
    () => { assertApiKeyUsable(config); },
    (error) => error instanceof CunaError &&
      error.details.source === "environment" &&
      error.hint.includes("CUNA_API_KEY") &&
      !error.hint.includes("user profile"),
  );
});

test("a broken environment credential stops the commands that use one and only those", async () => {
  const platform = {
    kind: "linux",
    paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
    async readSafeConfig() { return { exists: false }; },
  };
  // Set but empty is exactly what a failed `$(fetch-secret)` produces.
  const env = { CUNA_API_KEY: "" };

  async function run(argv, extra = {}) {
    const streams = memoryStreams();
    const exit = await runCli([...argv, "--json"], { streams: streams.streams, platform, env, ...extra });
    const stderr = streams.stderr().trim();
    const stdout = streams.stdout().trim();
    return { exit, record: JSON.parse((stderr === "" ? stdout : stderr).split("\n").at(-1)) };
  }

  // Diagnostics read no credential. They used to die on this one, which is
  // exactly when a user needs them.
  const doctor = await run(["doctor"], { runtimeFeatures: [] });
  assert.equal(doctor.exit, EXIT_CODES.success);
  assert.equal(doctor.record.data.environment_credential, "invalid");
  assert.equal(doctor.record.data.environment_credential_variable, "CUNA_API_KEY");

  const selfTest = await run(["self-test", "--offline"]);
  assert.equal(selfTest.exit, EXIT_CODES.success);

  const configGet = await run(["config", "get"]);
  assert.equal(configGet.exit, EXIT_CODES.success);
  assert.equal(configGet.record.data.api_key, "invalid");
  assert.equal(configGet.record.data.api_key_variable, "CUNA_API_KEY");

  // Fail closed everywhere a credential authority is selected. `login` in
  // particular must NOT quietly become an interactive sign-in: that would be a
  // change of authority the caller never asked for.
  for (const argv of [["login"], ["whoami"], ["machines", "list"], ["account", "show"]]) {
    const { exit, record } = await run(argv);
    assert.equal(exit, EXIT_CODES.usage, argv.join(" "));
    assert.equal(record.error.code, "cuna.config.invalid", argv.join(" "));
    assert.equal(record.error.details.reason, "invalid_api_key", argv.join(" "));
  }
});

test("the redacted configuration never prints a credential value", async () => {
  const apiKey = `runa_sk_${"a".repeat(43)}`;
  const config = await resolveConfig({ platform: fakePlatform(), env: { CUNA_API_KEY: apiKey } });
  const redacted = JSON.stringify(publicConfig(config));
  assert.ok(!redacted.includes(apiKey));
  assert.ok(redacted.includes("configured_not_validated"));
  assert.ok(redacted.includes("CUNA_API_KEY"));
});

test("flag, environment, profile, default precedence is deterministic", async () => {
  const text = JSON.stringify({
    schema_version: 1,
    selected_profile: "dev",
    profiles: { dev: { development: true, base_url: "https://profile.example" } },
  });
  const fromEnvironment = await resolveConfig({
    platform: fakePlatform(text),
    env: { CUNA_BASE_URL: "https://environment.example", CUNA_PROFILE: "dev" },
  });
  assert.equal(fromEnvironment.baseUrl, "https://environment.example");
  assert.equal(fromEnvironment.baseUrlSource, "environment");

  const fromFlag = await resolveConfig({
    platform: fakePlatform(text),
    env: { CUNA_BASE_URL: "https://environment.example", CUNA_PROFILE: "dev" },
    overrides: { baseUrl: "https://flag.example" },
  });
  assert.equal(fromFlag.baseUrl, "https://flag.example");
  assert.equal(fromFlag.baseUrlSource, "flag");
});

test("an invalid higher-precedence origin fails instead of falling through", async () => {
  const text = JSON.stringify({
    schema_version: 1,
    selected_profile: "dev",
    profiles: { dev: { development: true, base_url: "https://safe.example" } },
  });
  await assert.rejects(
    resolveConfig({ platform: fakePlatform(text), env: { CUNA_PROFILE: "dev", CUNA_BASE_URL: "file:///etc/passwd" } }),
    (error) => error instanceof CunaError && error.code === "cuna.config.invalid",
  );
});

test("custom origins require an explicit development profile", async () => {
  await assert.rejects(
    resolveConfig({ platform: fakePlatform(), env: { CUNA_BASE_URL: "https://staging.example" } }),
    (error) => error instanceof CunaError && error.details.reason === "custom_origin_requires_development_profile",
  );
  const text = JSON.stringify({
    schema_version: 1,
    profiles: { local: { development: true, base_url: "http://127.0.0.1:8787" } },
  });
  const config = await resolveConfig({ platform: fakePlatform(text), env: { CUNA_PROFILE: "local" } });
  assert.equal(config.baseUrl, "http://127.0.0.1:8787");
});

test("secret-shaped fields in the user configuration are rejected", async () => {
  const text = JSON.stringify({ schema_version: 1, profiles: { default: { api_key: "cuna_sk_should_never_load" } } });
  await assert.rejects(
    resolveConfig({ platform: fakePlatform(text), env: {} }),
    (error) => error instanceof CunaError && error.details.reason === "unsafe_profile_field",
  );
});
