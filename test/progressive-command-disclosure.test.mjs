import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { commandHelp } from "../dist/cli/command-help.js";
import {
  COMPLETE_COMMAND_REFERENCE,
  FIRST_RUN_TRANSCRIPT,
  FULL_HELP,
  SHORT_HELP,
  renderShortHelp,
} from "../dist/cli/help.js";
import { CLI_ROUTE_REGISTRY, parseArgv, resolveCliRoute } from "../dist/cli/parser.js";
import { preflightInvocation } from "../dist/commands/commands.js";
import { EXIT_CODES, memoryStreams, runCli } from "../dist/index.js";

const UUID_HEAVY = /(?:MACHINE_ID|SESSION_ID|workspace-binding-id|workspace-generation|idempotency-key)/u;

function documentedRouteKeys(help) {
  return help
    .split("\n")
    .map((line) => /^  \[(?:supported|compatibility-reserved)\] (.+?) :: cuna /u.exec(line)?.[1])
    .filter((key) => key !== undefined);
}

test("default discovery leads with the supported machine-first journey", () => {
  const primary = SHORT_HELP.slice(SHORT_HELP.indexOf("Start here:"), SHORT_HELP.indexOf("First run:"));
  const ordered = ["cuna                    ", "cuna machines", "cuna claude", "cuna codex", "cuna opencode"];
  let previous = -1;
  for (const command of ordered) {
    const found = primary.indexOf(command);
    assert.ok(found > previous, `${command} must occur in primary order`);
    previous = found;
  }
  assert.doesNotMatch(SHORT_HELP, UUID_HEAVY);
  assert.match(SHORT_HELP, /\bcuna opencode\b/u);
  assert.match(SHORT_HELP, /2\. Run `cuna` to enter an attached provider terminal/u);
  assert.doesNotMatch(SHORT_HELP, /Continue with .*whoami|Continue with .*machines list/u);
  assert.match(commandHelp("machines", []), /Enter open/u);
  assert.doesNotMatch(commandHelp("machines", []), /Enter expand/u);
});

test("provider commands are rendered only when command capability and route both exist", () => {
  const none = renderShortHelp([]);
  assert.doesNotMatch(none, /^  cuna (?:claude|codex|opencode)\b/mu);

  const claude = renderShortHelp(["claude"]);
  assert.match(claude, /^  cuna claude\b/mu);
  assert.doesNotMatch(claude, /^  cuna codex\b/mu);

  const allClaims = renderShortHelp(["claude", "codex", "opencode"]);
  assert.match(allClaims, /^  cuna claude\b/mu);
  assert.match(allClaims, /^  cuna codex\b/mu);
  assert.match(allClaims, /^  cuna opencode\b/mu);
});

test("the documented first-run transcript ends in a foreground provider attach", async () => {
  assert.deepEqual(FIRST_RUN_TRANSCRIPT, [["login"], []]);
  const attached = [];
  const result = {
    profile: "default",
    sessionId: "00000000-0000-4000-8000-000000000001",
    context: {
      requiredTermsVersion: "2026-08",
      identity: "active",
      admission: "admitted",
      workspace: { state: "assigned", id: "00000000-0000-4000-8000-000000000002" },
    },
  };
  const humanAuth = {
    async login() { return result; },
    async acquireAccessToken() { return `cuna_at_${"a".repeat(43)}`; },
  };
  const platform = {
    kind: "linux",
    paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
    async readSafeConfig() { return { exists: false }; },
  };

  for (const argv of FIRST_RUN_TRANSCRIPT) {
    const streams = memoryStreams({ stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true });
    const exit = await runCli(argv, {
      streams: streams.streams,
      platform,
      env: {},
      humanAuth,
      clientFactory: () => ({}),
      rootJourneyRunner: async () => ({
        kind: "attach",
        agentSessionId: "00000000-0000-4000-8000-000000000003",
        agent: "claude-code",
      }),
      foregroundTerminalRunner: async (input) => { attached.push(input); },
    });
    assert.equal(exit, EXIT_CODES.success, argv.join(" "));
  }

  assert.equal(attached.length, 1);
  assert.deepEqual(attached[0].agentSessionIds, ["00000000-0000-4000-8000-000000000003"]);
  assert.deepEqual(attached[0].expectedAgentKinds, ["claude-code"]);
});

test("README first run uses the local package and ends in the guided terminal journey", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const section = readme.slice(
    readme.indexOf("## Use Cuna from a local package"),
    readme.indexOf("## Quick start for contributors"),
  );
  assert.match(section, /npm install --global .*cuna_labs-cli-0\.1\.0\.tgz/u);
  assert.match(section, /cuna login\s+cuna\s+```/u);
  assert.doesNotMatch(section, UUID_HEAVY);
  assert.match(section, /Exact resource commands .*`cuna help --all`/su);
});

test("complete help and parser discovery have an empty bidirectional difference", () => {
  const parserKeys = CLI_ROUTE_REGISTRY.map((route) => route.key);
  const helpKeys = documentedRouteKeys(COMPLETE_COMMAND_REFERENCE);
  assert.equal(new Set(parserKeys).size, parserKeys.length, "parser registry keys must be unique");
  assert.equal(new Set(helpKeys).size, helpKeys.length, "complete-help entries must occur exactly once");
  assert.deepEqual(helpKeys, parserKeys);
  assert.equal((FULL_HELP.match(/^  \[(?:supported|compatibility-reserved)\] /gmu) ?? []).length, parserKeys.length);

  for (const route of CLI_ROUTE_REGISTRY) {
    const parsed = parseArgv(route.argv);
    const keyTokens = route.key.split(" ");
    assert.equal(parsed.command, keyTokens[0], route.key);
    assert.deepEqual(parsed.operands.slice(0, keyTokens.length - 1), keyTokens.slice(1), route.key);
  }
});

test("preflight admission is closed over the shared command/action registry", () => {
  for (const route of CLI_ROUTE_REGISTRY.filter((candidate) => candidate.classification === "supported")) {
    const parsed = parseArgv(route.argv);
    assert.equal(resolveCliRoute(parsed)?.key, route.key, route.key);
    assert.doesNotThrow(() => preflightInvocation(parsed), route.key);
  }

  for (const argv of [
    ["not-a-command"],
    ["machines", "not-an-action"],
    ["agent-sessions", "not-an-action"],
    ["api-keys", "not-an-action"],
    ["config", "not-an-action"],
  ]) {
    const parsed = parseArgv(argv);
    assert.equal(resolveCliRoute(parsed), undefined, argv.join(" "));
    assert.throws(
      () => preflightInvocation(parsed),
      (error) => error?.code === "cuna.usage.invalid",
      argv.join(" "),
    );
  }
});

test("free operands are limited to PATH journeys and exact-session connect", () => {
  for (const argv of [
    ["claude", "C:/work/project"],
    ["codex", "/workspace/project"],
    ["opencode", "/workspace/project"],
    ["connect", "00000000-0000-4000-8000-000000000001"],
  ]) {
    assert.notEqual(resolveCliRoute(parseArgv(argv)), undefined, argv.join(" "));
  }
  for (const argv of [["doctor", "extra"], ["version", "extra"], ["machines", "extra"]]) {
    assert.equal(resolveCliRoute(parseArgv(argv)), undefined, argv.join(" "));
  }
});

test("complete help labels every reserved route and keeps exact-resource discovery advanced", () => {
  const reserved = CLI_ROUTE_REGISTRY.filter((route) => route.classification === "compatibility-reserved");
  assert.deepEqual(reserved.map((route) => route.key), ["config set", "shell", "sync", "companion"]);
  for (const route of reserved) {
    assert.match(COMPLETE_COMMAND_REFERENCE, new RegExp(`\\[compatibility-reserved\\] ${route.key} ::`, "u"));
    assert.match(commandHelp(route.key, []), /Compatibility-reserved command/u);
  }

  assert.match(FULL_HELP, UUID_HEAVY);
  assert.match(commandHelp("machines", ["delete"]), /MACHINE_ID/u);
  assert.match(commandHelp("agent-sessions", ["create"]), /workspace-binding-id/u);
  assert.match(commandHelp("agent-sessions", ["attach"]), /SESSION_ID/u);
});

test("primary help teaches one attach syntax while advanced help retains aliases", () => {
  assert.doesNotMatch(SHORT_HELP, /agent-sessions attach|connect SESSION_ID|--agent-session/u);
  assert.match(FULL_HELP, /agent-sessions attach SESSION_ID/u);
  assert.match(FULL_HELP, /connect SESSION_ID/u);
  assert.match(FULL_HELP, /claude --agent-session SESSION_ID/u);
  assert.match(FULL_HELP, /codex --agent-session SESSION_ID/u);
  assert.match(FULL_HELP, /opencode --agent-session SESSION_ID/u);
});
