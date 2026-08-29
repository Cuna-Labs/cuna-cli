import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { HELP_TOPICS, commandHelp } from "../dist/cli/command-help.js";
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
    .map((line) => /^  \[(?:routed|reserved)\] (.+?) :: cuna /u.exec(line)?.[1])
    .filter((key) => key !== undefined);
}

/**
 * The SERVER's availability vocabulary, read from the contract source rather
 * than retyped here.
 *
 * Retyping it would defeat the control: the defect being fenced is precisely
 * that one word lived in two places and drifted into meaning two things, so a
 * second hand-written copy is the same mistake one layer out. Reading
 * `src/api/contracts.ts` also means a value ADDED to the server enum
 * immediately starts being forbidden in static CLI declarations.
 */
function serverAvailabilityVocabulary() {
  const source = readFileSync(new URL("../src/api/contracts.ts", import.meta.url), "utf8");
  const union = /export type CapabilityAvailability\s*=([\s\S]*?);/u.exec(source);
  assert.ok(union, "CapabilityAvailability must remain readable from the contract source");
  const words = [...union[1].matchAll(/"([a-z_]+)"/gu)].map((match) => match[1]);
  // A positive control on the control: if this extraction ever silently returns
  // nothing, every assertion below would pass vacuously.
  assert.ok(words.includes("supported"), `extracted ${JSON.stringify(words)}`);
  assert.ok(words.length >= 4, `extracted ${JSON.stringify(words)}`);
  return new Set(words);
}

function lowercaseWords(text) {
  return String(text).toLowerCase().match(/[a-z_]+/gu) ?? [];
}

function helpTopicBody(topic) {
  const [command, ...operands] = topic.split(" ");
  return commandHelp(command, operands);
}

const IDENTITY_RESULT = Object.freeze({
  profile: "default",
  sessionId: "00000000-0000-4000-8000-000000000001",
  context: {
    requiredTermsVersion: "2026-08",
    identity: "active",
    admission: "admitted",
    workspace: { state: "assigned", id: "00000000-0000-4000-8000-000000000002" },
  },
});

async function humanLine(argv) {
  const streams = memoryStreams({ stdoutIsTTY: true, stderrIsTTY: true });
  const exit = await runCli([...argv, "--no-color"], {
    streams: streams.streams,
    platform: {
      kind: "linux",
      paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
      async readSafeConfig() { return { exists: false }; },
    },
    env: {},
    humanAuth: { async whoami() { return IDENTITY_RESULT; } },
    clientFactory: () => ({}),
  });
  assert.equal(exit, EXIT_CODES.success, `${argv.join(" ")} -> ${streams.stderr()}`);
  return streams.stdout();
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

test("short help lists the provider routes this build has, and narrows only when a caller narrows it", () => {
  // The default is a projection of the route registry, not a capability filter.
  // Production calls `renderShortHelp()` with no argument, so the filter can
  // only ever intersect the registry with itself; the earlier comment claiming
  // it "keeps OpenCode hidden until both halves exist" described a branch that
  // never fired. What is asserted here is what is true.
  const routedProviders = CLI_ROUTE_REGISTRY
    .filter((route) => ["claude", "codex", "opencode"].includes(route.key))
    .map((route) => route.key);
  for (const command of routedProviders) {
    assert.match(SHORT_HELP, new RegExp(`^  cuna ${command}\\b`, "mu"));
  }
  assert.equal(SHORT_HELP, renderShortHelp(routedProviders));

  // The parameter is still real for a caller that holds a narrower truth.
  const none = renderShortHelp([]);
  assert.doesNotMatch(none, /^  cuna (?:claude|codex|opencode)\b/mu);

  const claude = renderShortHelp(["claude"]);
  assert.match(claude, /^  cuna claude\b/mu);
  assert.doesNotMatch(claude, /^  cuna codex\b/mu);
});

test("OpenCode help sends provider sign-in to its remote TUI", () => {
  const opencodeHelp = commandHelp("opencode", []);
  assert.match(opencodeHelp, /remote OpenCode terminal, use \/connect/u);
  assert.match(opencodeHelp, /\/models to select a model/u);
  assert.match(opencodeHelp, /does not broker\s+an OpenCode device-sign-in page/u);
  assert.match(FULL_HELP, /\/connect to choose and sign in to a provider/u);
  assert.doesNotMatch(FULL_HELP, /Cuna device-sign-in prompt/u);
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
  // Anchored on the whole reference shape, not just the marker: the legend
  // above the reference opens two lines with the same brackets on purpose.
  assert.equal((FULL_HELP.match(/^  \[(?:routed|reserved)\] .+ :: cuna /gmu) ?? []).length, parserKeys.length);
  assert.deepEqual(documentedRouteKeys(FULL_HELP), parserKeys);

  for (const route of CLI_ROUTE_REGISTRY) {
    const parsed = parseArgv(route.argv);
    const keyTokens = route.key.split(" ");
    assert.equal(parsed.command, keyTokens[0], route.key);
    assert.deepEqual(parsed.operands.slice(0, keyTokens.length - 1), keyTokens.slice(1), route.key);
  }
});

/* -------------------------------------------------------------------------- */
/* PRD-OC-011 R3.1 — the contradiction detector                                */
/* -------------------------------------------------------------------------- */

test("CONTRADICTION DETECTOR: no static command declaration speaks the server's availability vocabulary", () => {
  // WHY THIS EXISTS. `cuna help --all` printed `[supported]` beside every
  // command, offline, from a compile-time constant -- in the exact word the
  // server's `CapabilityAvailability` enum uses for a live answer. A live
  // `cuna capabilities` returned a fraction of that set. Two authorities, one
  // word, and the one that could not know won the screen.
  //
  // The rename alone does not stop the next one. This does: it enumerates every
  // static declaration and fails if any of them borrows a server word.
  const server = serverAvailabilityVocabulary();

  // (1) The label itself, over the WHOLE server vocabulary. A label is a claim
  // about a command's status, which is the only thing the server may say.
  const labels = new Set(CLI_ROUTE_REGISTRY.map((route) => route.dispatch));
  for (const route of CLI_ROUTE_REGISTRY) {
    assert.ok(
      !server.has(route.dispatch),
      `${route.key} is statically declared "${route.dispatch}", which is what the SERVER says about a live capability`,
    );
  }
  // The vocabulary stays closed as well, so a third label cannot appear without
  // a decision about which authority it belongs to.
  assert.deepEqual([...labels].sort(), ["reserved", "routed"], "the static label vocabulary is closed");

  // (2) What `cuna help --all` actually prints, which is the surface a person
  // reads. Deriving it from the registry is not enough: the renderer could
  // translate one vocabulary into the other on the way out, which is exactly
  // what it used to do.
  const markers = [...COMPLETE_COMMAND_REFERENCE.matchAll(/^ {2}\[([a-z-]+)\]/gmu)].map((match) => match[1]);
  assert.equal(markers.length, CLI_ROUTE_REGISTRY.length, "one marker per route");
  assert.deepEqual([...new Set(markers)].sort(), [...labels].sort());
  for (const marker of new Set(markers)) {
    assert.ok(!server.has(marker), `help --all prints [${marker}], a server availability value`);
  }
  // And the legend must name the authority in the same view, so the marker
  // cannot be read as a status at all.
  assert.match(FULL_HELP, /Neither marker is a server answer/u);
  assert.match(FULL_HELP, /Run `cuna capabilities` for what the\s+server currently proves/u);

  // (3) The prose of every static declaration and every per-command help topic.
  // `unknown` is excluded on purpose and only here: in this prose it is
  // ordinary English about an OUTCOME ("stale, cancelled or unknown outcomes
  // fail closed"), never a status stamped on a command. The other three have no
  // such second meaning, so their presence is always the defect.
  const statusWords = new Set([...server].filter((word) => word !== "unknown"));
  assert.ok(statusWords.size >= 3, `expected at least three status words, got ${statusWords.size}`);
  const declarations = [
    ...CLI_ROUTE_REGISTRY.map((route) => [route.key, `${route.key} ${route.syntax} ${route.summary}`]),
    ...HELP_TOPICS.map((topic) => [`${topic} --help`, helpTopicBody(topic)]),
  ];
  for (const [where, text] of declarations) {
    for (const word of lowercaseWords(text)) {
      assert.ok(!statusWords.has(word), `${where} says "${word}", which is the server's word for a live answer`);
    }
  }
});

/* -------------------------------------------------------------------------- */
/* PRD-OC-011 R3 — one command, one story                                      */
/* -------------------------------------------------------------------------- */

test("agent-sessions attach carries one status across the parser, help, and its gate", () => {
  // It used to carry three in one build: `[supported]` from the parser, a
  // "Capability-gated foreground preview" heading in help, and a runtime
  // refusal saying the capability is not available in this build or contract.
  const route = CLI_ROUTE_REGISTRY.find((candidate) => candidate.key === "agent-sessions attach");
  assert.ok(route);
  assert.equal(route.dispatch, "routed");

  // `routed` is a checkable claim, not a label: the preflight really admits it.
  assert.doesNotThrow(() => preflightInvocation(parseArgv(route.argv)));

  // And every surface names the same gate, so nothing has to be reconciled by
  // the reader.
  const topic = commandHelp("agent-sessions", ["attach"]);
  for (const surface of [route.summary, topic, FULL_HELP, commandHelp("connect", [])]) {
    assert.match(surface, /terminal_connections\.create/u);
  }
  assert.doesNotMatch(FULL_HELP, /Capability-gated foreground preview/u);
  assert.doesNotMatch(`${FULL_HELP}\n${topic}`, /\bpreview\b/iu);
});

test("access status help promises only the output access status produces", async () => {
  // Help said it shows identity, admission and workspace "separately"; run.ts
  // serves it from the same branch as whoami and prints the same tab-separated
  // line. This is a biconditional on purpose: if someone later gives the
  // command its own rendering, the assertion flips rather than rots.
  const whoami = await humanLine(["whoami"]);
  const accessStatus = await humanLine(["access", "status"]);
  const claim = /\bseparately\b/u;
  const help = [
    commandHelp("access", ["status"]),
    FULL_HELP.split("\n").find((line) => line.startsWith("  access status")),
    CLI_ROUTE_REGISTRY.find((route) => route.key === "access status").summary,
  ].join("\n");

  if (whoami === accessStatus) {
    assert.doesNotMatch(help, claim, "identical output must not be described as shown separately");
    assert.match(help, /whoami/u, "help must name the command whose output it duplicates");
  } else {
    assert.match(help, claim, "differentiated output must be described");
  }
  // The one thing that genuinely does differ is the record name, and help says so.
  assert.match(commandHelp("access", ["status"]), /access\.status/u);
});

test("preflight admission is closed over the shared command/action registry", () => {
  for (const route of CLI_ROUTE_REGISTRY.filter((candidate) => candidate.dispatch === "routed")) {
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
  const reserved = CLI_ROUTE_REGISTRY.filter((route) => route.dispatch === "reserved");
  assert.deepEqual(reserved.map((route) => route.key), ["config set", "shell", "sync", "companion"]);
  for (const route of reserved) {
    assert.match(COMPLETE_COMMAND_REFERENCE, new RegExp(`\\[reserved\\] ${route.key} ::`, "u"));
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
