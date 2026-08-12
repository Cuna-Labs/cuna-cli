import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { API_KEYS_URL, SUPPORT_URL, memoryStreams, runCli, runtimeFeatureGates } from "../dist/index.js";
import { FULL_HELP, SHORT_HELP } from "../dist/cli/help.js";
import { NATIVE_PLATFORM_RELEASE_INDEX } from "../dist/credentials/native-platform-release-index.js";

const platform = {
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
};

async function helpFor(argv) {
  const streams = memoryStreams();
  const exit = await runCli([...argv, "--json"], { streams: streams.streams, platform });
  return { exit, record: JSON.parse(streams.stdout().trim().split("\n").at(-1)) };
}

/* -------------------------------------------------------------------------- */
/* S-4: there was not one URL anywhere in the CLI                              */
/* -------------------------------------------------------------------------- */

test("the full help names where an API key comes from while short help leads with browser login", () => {
  // Bare help must lead a new user through the default browser-link flow and
  // must not expose an automation URL as the first-run path. The full help
  // still documents the explicit automation mode and its source.
  assert.doesNotMatch(SHORT_HELP, /https?:\/\//u);
  assert.doesNotMatch(SHORT_HELP, /Create an automation credential at/u);
  assert.match(SHORT_HELP, /Run `cuna login` and complete the one-time browser link/u);
  assert.match(FULL_HELP, /https?:\/\//u);
  const fullHelpUrls = new Set(
    (FULL_HELP.match(/https?:\/\/[^\s`]+/gu) ?? []).map((url) => url.replace(/[.,)]+$/u, "")),
  );
  assert.ok(fullHelpUrls.has(API_KEYS_URL), [...fullHelpUrls].join(", "));
});

test("the published support destination is the one package.json declares", () => {
  // Two spellings of one fact is how they drift. This is the only oracle that
  // can catch a `bugs.url` change that leaves the shipped hints behind.
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(SUPPORT_URL, manifest.bugs.url);
  assert.equal(SUPPORT_URL, "https://github.com/Cuna-Labs/cuna-cli/issues");
});

/* -------------------------------------------------------------------------- */
/* S-5: which URLs the CLI carries, and which it deliberately does not         */
/* -------------------------------------------------------------------------- */

test("the CLI ships exactly two product destinations", () => {
  // A CLI that prints marketing URLs everywhere is its own defect. Each of these
  // exists because a specific shipped message dead-ends without it; nothing else
  // is admitted. This test fails if a third is added without a decision.
  const urls = new Set(
    (FULL_HELP.match(/https?:\/\/[^\s`]+/gu) ?? []).map((url) => url.replace(/[.,)]+$/u, "")),
  );
  assert.deepEqual([...urls].sort(), ["https://app.getcuna.com/api-keys"]);
  assert.equal(SUPPORT_URL, "https://github.com/Cuna-Labs/cuna-cli/issues");
});

/* -------------------------------------------------------------------------- */
/* S-6: the split — nothing removed, only relocated                            */
/* -------------------------------------------------------------------------- */

test("bare cuna and cuna --help both answer with the short orientation", async () => {
  for (const argv of [[], ["--help"]]) {
    const { exit, record } = await helpFor(argv);
    assert.equal(exit, 0, argv.join(" "));
    assert.equal(record.data.help, SHORT_HELP, argv.join(" "));
  }
});

test("the short help is materially shorter and reaches a command sooner", () => {
  const shortLines = SHORT_HELP.split("\n");
  const fullLines = FULL_HELP.split("\n");
  // The measured wall: 105 lines, 23 of them the exit-code table, first usable
  // command on line 9.
  assert.ok(fullLines.length >= 100, `full help is ${fullLines.length} lines`);
  assert.ok(
    shortLines.length < fullLines.length / 2,
    `short help is ${shortLines.length} lines against ${fullLines.length}`,
  );
  const firstCommand = shortLines.findIndex((line) => /^\s{2}doctor\s/u.test(line));
  assert.ok(firstCommand >= 0 && firstCommand < 16, `first command at line ${firstCommand + 1}`);
});

test("the full surface stays reachable and keeps every relocated section", async () => {
  for (const argv of [["help", "--all"], ["--help", "--all"]]) {
    const { exit, record } = await helpFor(argv);
    assert.equal(exit, 0, argv.join(" "));
    assert.equal(record.data.help, FULL_HELP, argv.join(" "));
  }
  // The sections that used to be in the bare help, asserted present in the full
  // one. Relocation is only legitimate if the destination actually holds them.
  for (const section of [
    "Available now:",
    "Capability-gated foreground preview:",
    "Automatic local-to-cloud journey:",
    "Reserved and fail-closed in this build:",
    "Global options:",
    "Exit codes:",
    "Authentication:",
    "Canonical install:",
  ]) {
    assert.ok(FULL_HELP.includes(section), `full help must still carry "${section}"`);
  }
});

test("the short help names the route to the full surface", () => {
  // Relocating content without a route to it is a deletion.
  assert.ok(SHORT_HELP.includes("cuna help --all"), SHORT_HELP);
  assert.ok(SHORT_HELP.includes("cuna <command> --help"), SHORT_HELP);
});

test("per-command help is unchanged by the split", async () => {
  const cases = [
    [["machines", "create", "--help"], "machines create", "--memory-mib N"],
    [["agent-sessions", "create", "--help"], "agent-sessions create", "--workspace-generation N"],
    [["doctor", "--help"], "doctor", "credential vault"],
    [["claude", "--help"], "claude", "--agent-session ID"],
  ];
  for (const [argv, topic, fragment] of cases) {
    const { exit, record } = await helpFor(argv);
    assert.equal(exit, 0, argv.join(" "));
    assert.equal(record.data.topic, topic);
    assert.ok(record.data.help.includes(fragment), `${argv.join(" ")} must document ${fragment}`);
    assert.notEqual(record.data.help, SHORT_HELP);
    assert.notEqual(record.data.help, FULL_HELP);
  }
});

test("--all on a command topic is refused rather than silently ignored", async () => {
  const streams = memoryStreams();
  const exit = await runCli(["machines", "--help", "--all", "--json"], {
    streams: streams.streams,
    platform,
  });
  assert.equal(exit, 2);
  const record = JSON.parse(streams.stderr().trim().split("\n").at(-1));
  assert.equal(record.error.code, "cuna.usage.invalid");
  assert.ok(record.error.hint.includes("cuna help --all"), record.error.hint);
});

/* -------------------------------------------------------------------------- */
/* S-7: the short help must not promise what this build cannot do              */
/* -------------------------------------------------------------------------- */

test("the short help presents the composed journey and distinguishes preview sign-in from native storage", () => {
  const available = SHORT_HELP.slice(
    SHORT_HELP.indexOf("Works with no network:"),
    SHORT_HELP.indexOf("Not available in this build:"),
  );
  assert.ok(available.length > 0);
  for (const command of ["login", "signup", "logout"]) {
    assert.ok(
      !new RegExp(`^\\s{2}${command}\\b`, "mu").test(available),
      `${command} must not be listed as available`,
    );
  }
  for (const command of ["claude", "codex", "openclaw", "connect"]) {
    assert.ok(new RegExp(`^\\s{2}${command}\\b`, "mu").test(available), `${command} must be listed as available`);
  }
  const unavailable = SHORT_HELP.slice(SHORT_HELP.indexOf("Not available in this build:"));
  assert.ok(unavailable.includes("native credential vault"), unavailable);
  assert.ok(unavailable.includes("cuna login"), unavailable);
  assert.ok(unavailable.includes("encrypted browser-link"), unavailable);
  for (const command of ["claude", "codex", "openclaw", "connect"]) {
    assert.ok(!unavailable.includes(command), `${command} must not be marked unavailable`);
  }
});

test("the unavailability the short help claims is the unavailability this build has", () => {
  // Derived from the authorities, not from the help text, so the help cannot go
  // on claiming an outage after the build gains the capability.
  //
  // Interactive sign-in: the signed native release index is empty, so
  // `createProductionNativeAuthBridges` fails closed before package resolution.
  assert.equal(NATIVE_PLATFORM_RELEASE_INDEX.length, 0);

  // The journey and foreground attach are local composition claims. Remote
  // capability and resource authority are re-proven per invocation.
  for (const platformName of ["windows", "macos", "linux"]) {
    for (const credentialBackendStatus of ["verified", "unavailable", "unknown"]) {
      const gates = runtimeFeatureGates({ platform: platformName, credentialBackendStatus });
      for (const feature of ["workspace_sync", "terminal_workspace"]) {
        const gate = gates.find((candidate) => candidate.feature === feature);
        assert.equal(
          gate?.implementation,
          "available",
          `${feature} on ${platformName}/${credentialBackendStatus}`,
        );
      }
    }
  }
});

test("the short help points at doctor rather than asserting a platform list", () => {
  // A static string cannot know the vault verdict, which is a runtime fact and
  // is genuinely different on linux. Claiming a platform list here would be the
  // "universal claim from a partial set" this workspace keeps paying for.
  assert.ok(SHORT_HELP.includes("cuna doctor"), SHORT_HELP);
  assert.ok(!/win32|darwin|macOS|Windows/u.test(SHORT_HELP), SHORT_HELP);
});
