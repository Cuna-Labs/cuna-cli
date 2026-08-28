import assert from "node:assert/strict";
import test from "node:test";

import { memoryStreams, runCli } from "../dist/index.js";
import { HELP_TOPICS } from "../dist/cli/command-help.js";
import { FULL_HELP, SHORT_HELP } from "../dist/cli/help.js";
import { parseArgv } from "../dist/cli/parser.js";
import { preflightInvocation } from "../dist/commands/commands.js";

const MACHINE_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_BINDING_ID = "44444444-4444-4444-8444-444444444444";

const platform = {
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
};

async function runJson(argv) {
  const streams = memoryStreams();
  let clientCreated = false;
  const exit = await runCli([...argv, "--json"], {
    streams: streams.streams,
    platform,
    clientFactory() {
      clientCreated = true;
      throw new Error("unavailable agent input reached the API client");
    },
  });
  const output = streams.stderr().trim() || streams.stdout().trim();
  return { exit, clientCreated, record: JSON.parse(output.split("\n").at(-1)) };
}

test("public help advertises contract-backed providers and keeps unsupported OpenClaw hidden", () => {
  const publicSurface = `${SHORT_HELP}\n${FULL_HELP}\n${HELP_TOPICS.join("\n")}`;
  assert.match(publicSurface, /\bclaude\b/u);
  assert.match(publicSurface, /\bcodex\b/u);
  assert.match(publicSurface, /\bopencode\b/iu);
  assert.doesNotMatch(publicSurface, /\bopenclaw\b/iu);
});

test("unavailable OpenClaw shorthand, including its help topic, fails before API selection", async () => {
  for (const command of ["openclaw"]) {
    for (const argv of [[command], [command, "--help"]]) {
      const result = await runJson(argv);
      assert.equal(result.exit, 2, argv.join(" "));
      assert.equal(result.record.error.code, "cuna.usage.invalid", argv.join(" "));
      assert.match(result.record.error.message, /Unknown command/u);
      assert.equal(result.clientCreated, false, argv.join(" "));
    }
  }
});

test("create selectors reject unavailable agents before API selection", async () => {
  for (const unavailableAgent of ["openclaw"]) {
    const invocations = [
      ["machines", "create", "--name", "truthful-surface", "--agent", unavailableAgent, "--yes"],
      [
        "agent-sessions", "create",
        "--machine", MACHINE_ID,
        "--workspace-binding-id", WORKSPACE_BINDING_ID,
        "--workspace-generation", "1",
        "--agent", unavailableAgent,
        "--yes",
      ],
    ];
    for (const argv of invocations) {
      const result = await runJson(argv);
      assert.equal(result.exit, 2, argv.join(" "));
      assert.equal(result.record.error.code, "cuna.usage.invalid", argv.join(" "));
      assert.match(result.record.error.message, /--agent must be claude-code, codex, or opencode/u);
      assert.equal(result.clientCreated, false, argv.join(" "));
    }
  }
});

test("OpenCode shorthand and create selectors are admitted by local preflight", () => {
  for (const argv of [
    ["opencode"],
    ["machines", "create", "--name", "truthful-surface", "--agent", "opencode", "--yes"],
    [
      "agent-sessions", "create",
      "--machine", MACHINE_ID,
      "--workspace-binding-id", WORKSPACE_BINDING_ID,
      "--workspace-generation", "1",
      "--agent", "opencode",
      "--yes",
    ],
  ]) {
    assert.doesNotThrow(() => preflightInvocation(parseArgv(argv)), argv.join(" "));
  }
});
