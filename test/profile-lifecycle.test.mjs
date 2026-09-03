import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  DEFAULT_BASE_URL,
  EXIT_CODES,
  createPlatformAdapter,
  ensureProfileRecorded,
  memoryStreams,
  resolveConfig,
  runCli,
} from "../dist/index.js";

const POSIX = process.platform !== "win32";

/**
 * A profile only exists when `config.json` lists it. Before this suite there
 * was no way to put it there: `cuna config` refuses every write and the
 * platform adapter exposed only `readSafeConfig`, so `cuna login --profile
 * rexbit` answered `profile_not_found` and named no way out. Credentials ARE
 * namespaced per profile (`localEncryptedSessionPaths` and
 * `localSessionPreviewPath` both digest the profile name into their file
 * names), so a second profile is exactly how a person holds two Cuna
 * identities on one machine.
 */

const IDENTITY_RESULT = Object.freeze({
  profile: "rexbit",
  sessionId: "00000000-0000-4000-8000-000000000001",
  context: {
    requiredTermsVersion: "2026-08",
    identity: "active",
    admission: "admitted",
    workspace: { state: "assigned", id: "00000000-0000-4000-8000-000000000002" },
  },
});

async function scratchConfigFile() {
  const root = await mkdtemp(join(tmpdir(), "cuna-profile-lifecycle-"));
  return { root, configFile: join(root, "Cuna", "config.json") };
}

/**
 * The real adapter, on the real platform kind. A stub cannot answer the
 * questions this suite exists to ask — the file mode, the atomic replacement,
 * and whether a refused file is also a file the writer declines to overwrite.
 */
function realPlatform() {
  return createPlatformAdapter({ env: process.env });
}

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
    async writeSafeConfig() {
      // A command that refuses an unknown profile must not have written first.
      throw new Error("a refusal wrote to the configuration file");
    },
  };
}

async function runJson(argv) {
  const streams = memoryStreams();
  const exit = await runCli([...argv, "--json"], {
    streams: streams.streams,
    platform: fakePlatform(),
    env: {},
    clientFactory: () => ({}),
  });
  const stderr = streams.stderr().trim();
  const stdout = streams.stdout().trim();
  return { exit, record: JSON.parse((stderr === "" ? stdout : stderr).split("\n").at(-1)) };
}

test("an unknown profile refuses and the refusal names the command that creates it", async () => {
  const { exit, record } = await runJson(["machines", "list", "--profile", "ghost"]);
  assert.equal(exit, EXIT_CODES.usage);
  assert.equal(record.error.code, "cuna.config.invalid");
  assert.equal(record.error.details.reason, "profile_not_found");
  assert.equal(record.error.details.profile, "ghost");
  assert.equal(record.error.details.source, "flag");
  // The remedy, in the product's own words, naming the profile the person
  // actually typed. The old hint sent them to `cuna config get --json`, which
  // reports the profile they could not select and never says how to make one.
  assert.match(record.error.hint, /Run `cuna login --profile ghost` to create it/u);
  assert.doesNotMatch(record.error.message, /Cuna configuration is invalid/u);
});

test("a typo on a destructive command still refuses; it is never treated as a new profile", async () => {
  const { exit, record } = await runJson([
    "machines", "delete", "00000000-0000-4000-8000-0000000000ff", "--yes", "--profile", "prodction",
  ]);
  assert.equal(exit, EXIT_CODES.usage);
  assert.equal(record.error.details.reason, "profile_not_found");
  assert.equal(record.error.details.profile, "prodction");
});

test("the remedy survives the human renderer, not only the JSON record", async () => {
  // A hint the renderer drops is not a fix. This reads the terminal bytes.
  const streams = memoryStreams({ stdoutIsTTY: true, stderrIsTTY: true });
  const exit = await runCli(["machines", "list", "--profile", "ghost", "--no-color"], {
    streams: streams.streams,
    platform: fakePlatform(),
    env: {},
    clientFactory: () => ({}),
  });
  assert.equal(exit, EXIT_CODES.usage);
  const rendered = streams.stderr();
  assert.match(rendered, /Error \[cuna\.config\.invalid\]: No Cuna profile named ghost exists on this machine\./u);
  assert.match(rendered, /Next: Run `cuna login --profile ghost` to create it and sign in\./u);
});

test("an unknown profile from the environment says how to create it and how to stop selecting it", async () => {
  const streams = memoryStreams();
  const exit = await runCli(["machines", "list", "--json"], {
    streams: streams.streams,
    platform: fakePlatform(),
    env: { CUNA_PROFILE: "ghost" },
    clientFactory: () => ({}),
  });
  assert.equal(exit, EXIT_CODES.usage);
  const record = JSON.parse(streams.stderr().trim().split("\n").at(-1));
  assert.equal(record.error.details.source, "environment");
  assert.equal(record.error.details.variable, "CUNA_PROFILE");
  assert.match(record.error.hint, /Run `cuna login --profile ghost` to create it/u);
  assert.match(record.error.hint, /unset CUNA_PROFILE/u);
});

test("recording a profile creates the file, and the next ordinary invocation resolves it", async () => {
  const { root, configFile } = await scratchConfigFile();
  try {
    const platform = realPlatform();
    // What `cuna login --profile rexbit` resolves: the profile is not listed
    // yet, and login is the one command allowed to proceed anyway.
    const config = await resolveConfig({
      platform,
      env: {},
      overrides: { profile: "rexbit", configFile },
      allowMissingProfile: true,
    });
    assert.equal(config.profile, "rexbit");
    assert.equal(config.baseUrl, DEFAULT_BASE_URL);
    assert.equal(config.developmentProfile, false);

    assert.equal(await ensureProfileRecorded({ platform, config }), true);

    // The next invocation is an ordinary one: no allowance, so this resolving
    // at all is the proof that the profile now exists.
    const next = await resolveConfig({ platform, env: {}, overrides: { profile: "rexbit", configFile } });
    assert.equal(next.profile, "rexbit");
    assert.equal(next.baseUrl, DEFAULT_BASE_URL);
    assert.equal(next.developmentProfile, false);

    const text = await readFile(configFile, "utf8");
    const written = JSON.parse(text);
    assert.deepEqual(written.profiles.rexbit, {});
    assert.equal(written.schema_version, 1);
    // No credential, ever. The file carries settings only.
    assert.doesNotMatch(text, /_sk_|token|api_key/u);

    // Owner-only, and the atomic replacement left no sibling behind.
    const directory = dirname(configFile);
    assert.deepEqual(await readdir(directory), ["config.json"]);
    if (POSIX) {
      assert.equal((await lstat(configFile)).mode & 0o077, 0);
      assert.equal((await lstat(directory)).mode & 0o077, 0);
    }

    // Recording a profile that is already listed writes nothing at all.
    assert.equal(await ensureProfileRecorded({ platform, config }), false);
    assert.equal(await readFile(configFile, "utf8"), text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a login into an existing profile leaves every other profile's settings byte-identical", async () => {
  const { root, configFile } = await scratchConfigFile();
  try {
    const platform = realPlatform();
    await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });
    // Hand-written, including a field the normalizer would otherwise invent
    // (`work` states no `development` at all) and a development profile whose
    // custom origin must keep resolving afterwards.
    const original = `${JSON.stringify({
      schema_version: 1,
      selected_profile: "work",
      profiles: {
        work: {},
        lab: { development: true, base_url: "http://127.0.0.1:8787" },
      },
    }, null, 2)}\n`;
    await writeFile(configFile, original, { encoding: "utf8", mode: 0o600 });

    // Signing in again to a profile that already exists must not rewrite it.
    const existing = await resolveConfig({ platform, env: {}, overrides: { profile: "lab", configFile } });
    assert.equal(await ensureProfileRecorded({ platform, config: existing }), false);
    assert.equal(await readFile(configFile, "utf8"), original);

    // Adding a third profile preserves the other two, in order, unchanged.
    const created = await resolveConfig({
      platform,
      env: {},
      overrides: { profile: "rexbit", configFile },
      allowMissingProfile: true,
    });
    assert.equal(await ensureProfileRecorded({ platform, config: created }), true);

    const written = JSON.parse(await readFile(configFile, "utf8"));
    assert.deepEqual(Object.keys(written.profiles), ["work", "lab", "rexbit"]);
    assert.deepEqual(written.profiles.work, {});
    assert.deepEqual(written.profiles.lab, { development: true, base_url: "http://127.0.0.1:8787" });
    assert.equal(written.selected_profile, "work");
    assert.equal(written.schema_version, 1);

    // Preserved semantically, not only textually.
    const lab = await resolveConfig({ platform, env: {}, overrides: { profile: "lab", configFile } });
    assert.equal(lab.baseUrl, "http://127.0.0.1:8787");
    assert.equal(lab.developmentProfile, true);
    if (POSIX) assert.equal((await lstat(configFile)).mode & 0o077, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the writer refuses every file the reader would refuse", async () => {
  const { root, configFile } = await scratchConfigFile();
  try {
    const platform = realPlatform();
    await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });

    // A directory where the configuration file belongs.
    await mkdir(configFile, { recursive: true });
    await assert.rejects(
      platform.writeSafeConfig(configFile, "{}\n", 65_536),
      (error) => error.code === "cuna.config.unsafe_file" && error.details.reason === "unsafe_type",
    );
    await rm(configFile, { recursive: true, force: true });

    // Larger than the ceiling the reader enforces.
    await assert.rejects(
      platform.writeSafeConfig(configFile, "x".repeat(70_000), 65_536),
      (error) => error.code === "cuna.config.unsafe_file" && error.details.reason === "oversized",
    );

    if (POSIX) {
      // Group-writable: the reader rejects it, so the writer must not replace
      // it either.
      await writeFile(configFile, "{}\n", { encoding: "utf8", mode: 0o600 });
      await chmod(configFile, 0o620);
      await assert.rejects(
        platform.writeSafeConfig(configFile, "{}\n", 65_536),
        (error) => error.details.reason === "unsafe_permissions",
      );
      await rm(configFile, { force: true });

      // A symlink is never followed, on either side.
      const elsewhere = join(root, "elsewhere.json");
      await writeFile(elsewhere, "{}\n", { encoding: "utf8", mode: 0o600 });
      await symlink(elsewhere, configFile);
      await assert.rejects(
        platform.writeSafeConfig(configFile, '{"schema_version":1}\n', 65_536),
        (error) => error.details.reason === "unsafe_type",
      );
      assert.equal(await readFile(elsewhere, "utf8"), "{}\n");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("`cuna login --profile <name>` creates the profile the flag names", async () => {
  const { root, configFile } = await scratchConfigFile();
  try {
    const platform = realPlatform();
    const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true, stderrIsTTY: true });
    let loginCalls = 0;
    const exit = await runCli(
      ["login", "--profile", "rexbit", "--config-file", configFile, "--no-color"],
      {
        streams: streams.streams,
        platform,
        env: {},
        humanAuth: {
          async login() { loginCalls += 1; return IDENTITY_RESULT; },
          async whoami() { return IDENTITY_RESULT; },
        },
      },
    );
    assert.equal(exit, EXIT_CODES.success, streams.stderr());
    assert.equal(loginCalls, 1);

    // The claim is about the file, not about the success line.
    const written = JSON.parse(await readFile(configFile, "utf8"));
    assert.deepEqual(written.profiles.rexbit, {});

    // And the profile now works for a command that never creates one.
    const next = await resolveConfig({ platform, env: {}, overrides: { profile: "rexbit", configFile } });
    assert.equal(next.profile, "rexbit");
    assert.equal(next.baseUrl, DEFAULT_BASE_URL);
    assert.equal(next.developmentProfile, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a login that fails leaves no profile behind", async () => {
  const { root, configFile } = await scratchConfigFile();
  try {
    const platform = realPlatform();
    const streams = memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true, stderrIsTTY: true });
    const exit = await runCli(
      ["login", "--profile", "rexbit", "--config-file", configFile, "--no-color"],
      {
        streams: streams.streams,
        platform,
        env: {},
        humanAuth: {
          async login() { throw new Error("the person closed the browser"); },
          async whoami() { throw new Error("no session"); },
        },
      },
    );
    assert.notEqual(exit, EXIT_CODES.success);
    await assert.rejects(lstat(configFile), (error) => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
