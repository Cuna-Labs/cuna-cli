import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_BASE_URL,
  resolveConfig,
  resolvePlatformPaths,
  RunaError,
} from "../dist/index.js";

function fakePlatform(text) {
  return {
    kind: "linux",
    paths: {
      configDirectory: "/home/test/.config/cuna",
      stateDirectory: "/home/test/.local/state/cuna",
      runtimeDirectory: "/run/user/1000/cuna",
      legacyConfigDirectory: "/home/test/.config/runa",
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
  assert.equal(win.legacyConfigDirectory, "C:\\A\\Runa");
  assert.equal(mac.configDirectory, "/Users/u/Library/Application Support/Cuna");
  assert.equal(linux.runtimeDirectory, "/run/cuna");
});

test("configuration defaults to the canonical production origin and never persists an API key", async () => {
  const config = await resolveConfig({ platform: fakePlatform(), env: { CUNA_API_KEY: "cuna_sk_abcdefghijklmnop" } });
  assert.equal(config.baseUrl, DEFAULT_BASE_URL);
  assert.equal(config.apiKeySource, "environment");
});

test("only Cuna environment names configure the pre-GA CLI", async () => {
  const configured = await resolveConfig({
    platform: fakePlatform(),
    env: {
      CUNA_API_KEY: "cuna_sk_abcdefghijklmnop",
      RUNA_API_KEY: "cuna_sk_ponmlkjihgfedcba",
    },
  });
  assert.equal(configured.apiKey, "cuna_sk_abcdefghijklmnop");

  const legacy = await resolveConfig({
    platform: fakePlatform(),
    env: { RUNA_API_KEY: "cuna_sk_abcdefghijklmnop" },
  });
  assert.equal(legacy.apiKey, undefined);
});

test("an existing legacy config is discovered only when the Cuna config is absent", async () => {
  const platform = fakePlatform();
  platform.readSafeConfig = async (path) => path.includes("/.config/runa/")
    ? { exists: true, text: JSON.stringify({ schema_version: 1, selected_profile: "legacy", profiles: { legacy: { development: false } } }) }
    : { exists: false };
  const config = await resolveConfig({ platform, env: {} });
  assert.equal(config.profile, "legacy");
  assert.equal(config.configFile, "/home/test/.config/runa/config.json");
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
    (error) => error instanceof RunaError && error.code === "runa.config.invalid",
  );
});

test("custom origins require an explicit development profile", async () => {
  await assert.rejects(
    resolveConfig({ platform: fakePlatform(), env: { CUNA_BASE_URL: "https://staging.example" } }),
    (error) => error instanceof RunaError && error.details.reason === "custom_origin_requires_development_profile",
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
    (error) => error instanceof RunaError && error.details.reason === "unsafe_profile_field",
  );
});
