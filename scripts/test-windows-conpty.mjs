import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import xtermHeadless from "@xterm/headless";

const { Terminal } = xtermHeadless;
if (process.platform !== "win32") {
  console.log(JSON.stringify({ testId: "T14.2-WIN", result: "UNVERIFIED", reason: "requires Windows x64 ConPTY" }));
  process.exit(0);
}
if (process.arch !== "x64") {
  console.log(JSON.stringify({ testId: "T14.2-WIN", result: "UNVERIFIED", reason: `Windows ${process.arch} is outside the declared Windows x64 environment` }));
  process.exit(0);
}

const MACHINE_ID = "33333333-3333-4333-8333-333333333333";
const CLAUDE_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CODEX_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const TERMINATED_SESSION_A_ID = "55555555-5555-4555-8555-555555555555";
const TERMINATED_SESSION_B_ID = "66666666-6666-4666-8666-666666666666";
const PROCESS_EPOCH = "44444444-4444-4444-8444-444444444444";
const root = path.resolve(import.meta.dirname, "..");
const harnessRequire = createRequire(path.join(root, "test", "windows-conpty", "package.json"));
const { spawn } = harnessRequire("node-pty");
const entrypoint = path.join(root, "dist", "bin", "cuna.js");
const providerFixture = path.join(root, "scripts", "harness", "provider-ctrl-c-fixture.mjs");
const richFixture = path.join(root, "scripts", "harness", "cuna-rich-conpty-fixture.mjs");
const machinesToForegroundFixture = path.join(root, "scripts", "harness", "machines-to-foreground-fixture.mjs");
const sandbox = await mkdtemp(path.join(tmpdir(), "cuna-conpty-"));
const configFile = path.join(sandbox, "config.json");
const mutationLedger = [];
const requestLedger = [];
let machineGate;
let machineRequestObservedAt;
let agentSessionScenario = "default";
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const DIAGNOSTIC_TAIL_CHARACTERS = 1_200;

function machine() {
  return { id: MACHINE_ID, name: "conpty-界-🦊", agent: "claude-code", status: "running", memory_mib: 2048, vcpus: 1, url: "https://machine.invalid" };
}

function agentSession(agent, id, name) {
  const now = Date.now();
  return { id, machine_id: MACHINE_ID, name, agent, cwd: "/workspace/conpty", auth_mode: "interactive_login", desired_state: "running", request_state: "launched", process_state: "running", process_epoch: PROCESS_EPOCH, runtime_observed_at: new Date(now - 100).toISOString(), runtime_expires_at: new Date(now + 60_000).toISOString(), row_version: 1, created_at: new Date(now - 1_000).toISOString(), updated_at: new Date(now - 100).toISOString() };
}

function terminatedAgentSession(id, name) {
  return Object.freeze({
    ...agentSession("claude-code", id, name),
    request_state: "terminal",
    process_state: "terminated",
  });
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const observation = Object.freeze({ method: request.method ?? "UNKNOWN", path: url.pathname });
  requestLedger.push(observation);
  if (observation.method !== "GET" && observation.method !== "HEAD") mutationLedger.push(observation);
  if (request.headers.authorization !== "Bearer cuna_sk_abcdefghijklmnop") return send(response, 401, { error: "unauthenticated" });
  if (request.method === "GET" && url.pathname === "/v1/sessions") {
    machineRequestObservedAt = Date.now();
    if (machineGate !== undefined) await machineGate.promise;
    return send(response, 200, [machine()]);
  }
  if (request.method === "GET" && url.pathname === `/v1/sessions/${MACHINE_ID}/agent-sessions`) {
    const items = agentSessionScenario === "one-openable-with-terminated"
      ? [
          terminatedAgentSession(TERMINATED_SESSION_A_ID, "claude-ended-a"),
          agentSession("claude-code", CLAUDE_SESSION_ID, "claude-live"),
          terminatedAgentSession(TERMINATED_SESSION_B_ID, "claude-ended-b"),
        ]
      : [agentSession("claude-code", CLAUDE_SESSION_ID, "claude-live"), agentSession("codex", CODEX_SESSION_ID, "codex-live")];
    return send(response, 200, { items });
  }
  if (request.method === "GET" && url.pathname === "/v1/capabilities") {
    const now = Date.now();
    return send(response, 200, {
      schema_version: "1.0",
      subject_scope: url.searchParams.get("scope") ?? "account",
      subject_id: url.searchParams.get("resource_id") ?? undefined,
      observed_at: new Date(now - 100).toISOString(),
      expires_at: new Date(now + 30_000).toISOString(),
      etag: "conpty-fixture",
      capabilities: [{ id: "agent_sessions.create", availability: "supported", interaction: "native", mutation_class: "reversible", surfaces: ["cli"], required_permissions: ["agent_sessions:write"] }],
    });
  }
  return send(response, 404, { error: "unexpected_route", path: url.pathname });
});

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}
function listen() { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
function closeServer() { return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }

async function digestTree(directory) {
  const digest = createHash("sha256");
  async function visit(current, relative = "") {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const childRelative = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(absolute, childRelative);
      else if (entry.isFile()) digest.update(childRelative).update("\0").update(await readFile(absolute)).update("\0");
    }
  }
  await visit(directory);
  return digest.digest("hex");
}

async function sourceIdentity() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const diff = execFileSync("git", ["diff", "--binary", "HEAD", "--"], { cwd: root });
  const statusText = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
  const dirty = createHash("sha256").update(diff).update(statusText);
  for (const line of statusText.split(/\r?\n/u)) {
    if (!line.startsWith("?? ")) continue;
    const relative = line.slice(3);
    const absolute = path.join(root, relative);
    const metadata = await stat(absolute);
    if (metadata.isFile()) dirty.update(relative).update("\0").update(await readFile(absolute));
  }
  return Object.freeze({ commit, dirtyTreeDiffSha256: dirty.digest("hex"), builtArtifactSha256: await digestTree(path.join(root, "dist")) });
}

function decodedState(terminal, childState, exit) {
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let row = 0; row < terminal.rows; row += 1) lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
  return Object.freeze({ screen: lines.filter((line, index) => line.length > 0 || index < 4).join("\n"), cursor: Object.freeze({ x: buffer.cursorX, y: buffer.cursorY }), activeScreen: buffer.type, processState: childState, exitCode: exit?.exitCode ?? null, signal: exit?.signal ?? null });
}

function compactState(state) {
  const nonEmpty = state.screen.split("\n").filter((line) => line.length > 0);
  const screenPreview = nonEmpty.slice(0, 6).map((line) => line.slice(0, 160)).join("\n");
  return Object.freeze({
    screenPreview,
    screenSha256: createHash("sha256").update(state.screen).digest("hex"),
    cursor: state.cursor,
    activeScreen: state.activeScreen,
    processState: state.processState,
    exitCode: state.exitCode,
    signal: state.signal,
  });
}

async function waitUntil(predicate, failure, evidence, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const error = new Error(failure);
  error.evidence = evidence();
  throw error;
}

async function runConptyCase({ testId, args, environment = {}, drive, oracle }) {
  const terminal = new Terminal({ allowProposedApi: true, cols: 96, rows: 24, scrollback: 1_000 });
  let transcript = "";
  let transcriptBytes = 0;
  let transcriptOverflow;
  let writeTail = Promise.resolve();
  let childState = "starting";
  let exitResult;
  const observations = {};
  const childEnvironment = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...environment };
  if (!Object.hasOwn(environment, "NO_COLOR")) delete childEnvironment.NO_COLOR;
  const child = spawn(process.execPath, args, { name: "xterm-256color", cols: terminal.cols, rows: terminal.rows, cwd: root, useConpty: true, useConptyDll: false, env: childEnvironment });
  childState = "running";
  child.onData((data) => {
    transcriptBytes += Buffer.byteLength(data);
    if (transcriptBytes > MAX_TRANSCRIPT_BYTES && transcriptOverflow === undefined) {
      transcriptOverflow = new Error(`ConPTY transcript exceeded the ${MAX_TRANSCRIPT_BYTES}-byte safety bound.`);
    }
    if (transcriptOverflow === undefined) transcript += data;
    writeTail = writeTail.then(() => new Promise((resolve) => terminal.write(data, resolve)));
  });
  const exited = new Promise((resolve) => child.onExit((event) => { childState = "exited"; exitResult = event; resolve(event); }));
  const context = {
    child, terminal, observations, transcript: () => transcript, screen: () => decodedState(terminal, childState, exitResult).screen, state: () => decodedState(terminal, childState, exitResult), exited,
    resize(columns, rows) { terminal.resize(columns, rows); child.resize(columns, rows); },
    waitUntil: (predicate, failure, timeoutMs) => waitUntil(() => {
      if (transcriptOverflow !== undefined) throw transcriptOverflow;
      return predicate();
    }, failure, () => ({ ...compactState(decodedState(terminal, childState, exitResult)), transcriptTail: transcript.slice(-DIAGNOSTIC_TAIL_CHARACTERS) }), timeoutMs),
  };
  try {
    await drive(context);
    if (transcriptOverflow !== undefined) throw transcriptOverflow;
    const exit = await exited;
    await writeTail;
    const finalState = decodedState(terminal, childState, exit);
    await oracle({ ...context, finalState, exit });
    return Object.freeze({ testId, result: "PASS", observations: Object.freeze({ ...observations }), finalState: compactState(finalState), transcriptBytes });
  } catch (error) {
    console.error(JSON.stringify({ testId, result: "FAIL", timestamp: new Date().toISOString(), host: { platform: process.platform, arch: process.arch, release: process.version }, sourceIdentity: source ?? null, error: error instanceof Error ? error.message : String(error), ...(error?.evidence ?? compactState(decodedState(terminal, childState, exitResult))), transcriptTail: transcript.slice(-DIAGNOSTIC_TAIL_CHARACTERS), transcriptBytes }));
    throw error;
  } finally {
    if (childState !== "exited") {
      try { child.kill(); } catch {}
    }
    terminal.dispose();
  }
}

const results = [];
let source;
try {
  await listen();
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  await writeFile(configFile, `${JSON.stringify({ schema_version: 1, selected_profile: "conpty", profiles: { conpty: { development: true, base_url: baseUrl } } })}\n`);
  source = await sourceIdentity();
  const cliEnvironment = { CUNA_API_KEY: "cuna_sk_abcdefghijklmnop" };

  machineGate = deferred();
  results.push(await runConptyCase({
    testId: "T14.3-WIN-NAVIGATION", args: [entrypoint, "machines", "--config-file", configFile], environment: cliEnvironment,
    async drive(context) {
      const startedAt = Date.now();
      await context.waitUntil(() => machineRequestObservedAt !== undefined, "the CLI never began its machine request");
      await context.waitUntil(() => context.screen().includes("Discovering machines"), "no immediate feedback before the delayed backend response");
      context.observations.processLaunchToFeedbackMs = Date.now() - startedAt;
      context.observations.requestToFeedbackMs = Date.now() - machineRequestObservedAt;
      assert.ok(context.observations.requestToFeedbackMs < 1_000, "feedback exceeded one second after the request began");
      machineGate.resolve(); machineGate = undefined;
      await context.waitUntil(() => context.screen().includes("conpty-界-🦊") && context.screen().includes("claude-live") && context.screen().includes("codex-live"), "the decoded machine/session screen did not render");
      assert.match(context.transcript(), /\u001b\[(?:38|48);5;(?:208|42|45)m/u, "the ConPTY transcript lacks the declared palette");
      context.child.write("\u001b[B");
      await context.waitUntil(() => context.screen().includes("❯   ├─ Claude"), "coalesced Down did not select Claude");
      context.child.write("\u001b[1;5A");
      await context.waitUntil(() => context.screen().includes("❯ ▾ conpty-界-🦊"), "parameterized Up did not return to the machine");
      context.child.write("\u001b"); await new Promise((resolve) => setTimeout(resolve, 15)); context.child.write("["); await new Promise((resolve) => setTimeout(resolve, 15)); context.child.write("A");
      await context.waitUntil(() => context.screen().includes("❯ ▾ conpty-界-🦊"), "fragmented Up changed the first selection");
      context.child.write("\u001b[B");
      await context.waitUntil(() => context.screen().includes("❯   ├─ Claude"), "Down did not select Claude after fragmented input");
      context.child.write("\u001b[A");
      await context.waitUntil(() => context.screen().includes("❯ ▾ conpty-界-🦊"), "Up did not return to the machine");
      context.child.write("\u001b[C");
      await context.waitUntil(() => context.screen().includes("◆── conpty-界-🦊") && context.screen().includes("Claude  sessions"), "Right did not open the machine management screen");
      context.child.write("\u001b");
      await context.waitUntil(() => context.screen().includes("◆── Machines") && context.screen().includes("claude-live"), "Escape did not return to the machines screen");
      assert.equal(context.state().processState, "running", "Escape unexpectedly exited the explorer");
      const transcriptBeforeResize = context.transcript().length; context.resize(46, 12);
      await context.waitUntil(() =>
        context.transcript().length > transcriptBeforeResize &&
        context.screen().includes("conpty-") &&
        !context.screen().includes("Claude declared-installed  Claude 1/1 live"),
      "resize did not redraw the decoded viewport at the narrower width");
      assert.equal(context.terminal.cols, 46, "decoded terminal did not adopt the ConPTY column count");
      assert.ok(context.terminal.buffer.active.cursorX <= 46, "decoded cursor escaped the resized viewport");
      assert.match(context.screen(), /conpty-界-🦊/u, "wide Unicode graphemes were corrupted during resize");
      assert.doesNotMatch(context.screen(), /Claude declared-installed  Claude 1\/1 live/u, "narrow rendering did not crop content to the resized viewport");
      context.child.write("q");
    },
    async oracle({ finalState, transcript }) {
      assert.equal(finalState.exitCode, 0, "q exit was nonzero");
      assert.equal(finalState.activeScreen, "normal", "alternate screen was not restored after q");
      assert.match(transcript(), /\u001b\[\?1049h/u, "alternate screen was never entered");
      assert.match(transcript(), /\u001b\[\?1049l/u, "alternate screen restore sequence is absent");
    },
  }));

  results.push(await runConptyCase({
    testId: "T14.3-WIN-RICH-COMPOSITION", args: [richFixture, "--slow-detach"],
    async drive(context) {
      await context.waitUntil(
        () => context.screen().includes("CUNA") && context.screen().includes("REMOTE_ANSI256"),
        "the Cuna appbar and provider viewport were not composed on one screen",
      );
      assert.match(context.transcript(), /\u001b\[48;2;235;86;37m/u, "the Cuna appbar truecolor style was not emitted");
      assert.match(
        context.transcript(),
        /\u001b\[(?:0;)?(?:(?:1|2|3|4|5|7|8|9|53);)*38;5;208m(?:\u001b\[49m)?REMOTE_ANSI256/u,
        "the remote ANSI-256 foreground style did not survive rich composition",
      );
      context.observations.appbarVisible = true;
      context.observations.remoteAnsi256Visible = true;
      context.resize(64, 16);
      await context.waitUntil(
        () => context.screen().includes("CUNA") && context.screen().includes("RESIZED_64x14"),
        "resize did not preserve the appbar and repaint the provider viewport",
      );
      assert.equal(context.terminal.cols, 64, "decoded terminal did not adopt the resized width");
      assert.equal(context.terminal.rows, 16, "decoded terminal did not adopt the resized height");
      context.observations.resize = "64x16 host / 64x14 provider";
      const closingOffset = context.transcript().length;
      const interruptAt = Date.now();
      context.child.write("\u0003");
      await context.waitUntil(
        () => context.screen().includes("CUNA") && /[✦✧] Disconnecting\.\.\./u.test(context.screen()),
        "Ctrl-C did not render immediate closing feedback inside the Cuna appbar",
      );
      context.observations.ctrlCToClosingMs = Date.now() - interruptAt;
      assert.ok(context.observations.ctrlCToClosingMs < 500, "closing feedback was not immediate");
      await context.waitUntil(
        () => context.screen().includes("CUNA") && context.screen().includes("✓ Disconnected."),
        "successful detach did not render its brief Cuna confirmation",
      );
      const closingTranscript = context.transcript().slice(closingOffset);
      const firstFrame = closingTranscript.indexOf("✦ Disconnecting...");
      const middleFrame = closingTranscript.indexOf("✧ Disconnecting...", firstFrame + 1);
      const finalFrame = closingTranscript.indexOf("✦ Disconnecting...", middleFrame + 1);
      const confirmation = closingTranscript.indexOf("✓ Disconnected.", finalFrame + 1);
      assert.ok(firstFrame >= 0 && middleFrame > firstFrame && finalFrame > middleFrame, "disconnect animation frames were not emitted in order");
      assert.ok(confirmation > finalFrame, "disconnect confirmation preceded the completed animation");
      await Promise.race([context.exited, new Promise((_, reject) => setTimeout(() => reject(new Error("one Ctrl-C did not exit the rich composition within two seconds")), 2_000))]);
      context.observations.singleCtrlC = true;
      context.observations.closingAnimation = "✦ → ✧ → ✦";
      context.observations.confirmation = "✓ Disconnected.";
    },
    async oracle({ finalState, transcript }) {
      assert.equal(finalState.exitCode, 0, "rich composition Ctrl-C exit was nonzero");
      assert.equal(finalState.activeScreen, "normal", "rich composition did not restore the normal screen");
      assert.match(transcript(), /\u001b\[\?1049h/u, "rich composition never entered the alternate screen");
      assert.match(transcript(), /\u001b\[\?1049l/u, "rich composition did not leave the alternate screen");
      const restoredAt = transcript().lastIndexOf("\u001b[?1049l");
      assert.doesNotMatch(transcript().slice(restoredAt), /CUNA|Disconnecting|Disconnected/u, "foreground painted after restoring the normal screen");
    },
  }));

  results.push(await runConptyCase({
    testId: "T14.3-WIN-RICH-CLOSING-NO-COLOR", args: [richFixture, "--slow-detach", "--no-color"],
    async drive(context) {
      await context.waitUntil(
        () => context.screen().includes("CUNA") && context.screen().includes("REMOTE_ANSI256"),
        "no-color rich foreground did not compose its appbar and provider viewport",
      );
      assert.doesNotMatch(context.transcript(), /\u001b\[(?:38|48);(?:2|5);/u, "--no-color emitted an SGR foreground or background color");
      context.child.write("\u0003");
      await context.waitUntil(
        () => context.screen().includes("CUNA") && /[✦✧] Disconnecting\.\.\./u.test(context.screen()),
        "--no-color Ctrl-C did not render closing feedback",
      );
      await context.waitUntil(
        () => context.screen().includes("CUNA") && context.screen().includes("✓ Disconnected."),
        "--no-color detach did not render confirmation",
      );
      assert.doesNotMatch(context.transcript(), /\u001b\[(?:38|48);(?:2|5);/u, "--no-color closing frames emitted an SGR color");
      context.observations.appbarVisible = true;
      context.observations.closingVisible = true;
      context.observations.confirmationVisible = true;
      context.observations.colorSgrCount = 0;
      await Promise.race([context.exited, new Promise((_, reject) => setTimeout(() => reject(new Error("one Ctrl-C did not exit no-color rich foreground within two seconds")), 2_000))]);
    },
    async oracle({ finalState, transcript }) {
      assert.equal(finalState.exitCode, 0, "no-color rich closing exited nonzero");
      assert.equal(finalState.activeScreen, "normal", "no-color rich closing did not restore the normal screen");
      assert.match(transcript(), /\u001b\[\?1049l/u, "no-color rich closing did not leave the alternate screen");
    },
  }));

  results.push(await runConptyCase({
    testId: "T14.3-WIN-RICH-DETACH-FAILURE", args: [richFixture, "--slow-detach", "--detach-failure"],
    async drive(context) {
      await context.waitUntil(
        () => context.screen().includes("CUNA") && context.screen().includes("REMOTE_ANSI256"),
        "detach-failure rich foreground did not reach its active frame",
      );
      context.child.write("\u0003");
      await context.waitUntil(
        () => context.screen().includes("CUNA") && /[✦✧] Disconnecting\.\.\./u.test(context.screen()),
        "detach failure did not acknowledge Ctrl-C with closing feedback",
      );
      await Promise.race([context.exited, new Promise((_, reject) => setTimeout(() => reject(new Error("detach failure did not restore and exit within three seconds")), 3_000))]);
      context.observations.closingVisible = true;
      context.observations.failureSurfaced = true;
    },
    async oracle({ finalState, transcript }) {
      assert.notEqual(finalState.exitCode, 0, "detach failure was reported as success");
      assert.equal(finalState.activeScreen, "normal", "detach failure did not restore the normal screen");
      assert.match(transcript(), /LOCAL_DETACH_FAILURE/u, "detach failure cause was not preserved");
      assert.doesNotMatch(transcript(), /✓ Disconnected\./u, "detach failure emitted a false success confirmation");
      const restoredAt = transcript().lastIndexOf("\u001b[?1049l");
      assert.ok(restoredAt >= 0, "detach failure never restored the alternate screen");
      assert.doesNotMatch(transcript().slice(restoredAt), /CUNA|Disconnecting/u, "detach failure kept animating after host restoration");
    },
  }));

  results.push(await runConptyCase({
    testId: "T14.3-WIN-MACHINES-DIRECT-ATTACH", args: [machinesToForegroundFixture, configFile], environment: cliEnvironment,
    async drive(context) {
      await context.waitUntil(
        () => context.screen().includes("conpty-界-🦊") && context.screen().includes("claude-live"),
        "machines overview did not expose the attachable Claude AgentSession",
      );
      assert.match(context.screen(), /❯ ▾ conpty-界-🦊/u, "machines overview did not begin on the machine row");
      context.child.write("\u001b[B");
      await context.waitUntil(
        () => context.screen().includes("❯   ├─ Claude · claude-live"),
        "Down did not select the attachable Claude AgentSession",
      );
      const transitionOffset = context.transcript().length;
      context.child.write("\r");
      await context.waitUntil(
        () => context.screen().includes("CUNA") && context.screen().includes("FLOW_PROVIDER_ANSI256"),
        "Enter on the AgentSession did not enter the foreground provider viewport",
      );
      const transition = context.transcript().slice(transitionOffset);
      assert.doesNotMatch(transition, /◆── conpty-界-🦊/u, "direct AgentSession attach incorrectly opened the machine context menu");
      assert.doesNotMatch(transition, /Claude provider and sessions|Claude  provider and sessions|Stop  stop/u, "direct AgentSession attach rendered the intermediate machine menu");
      assert.match(transition, /Attaching to Claude Code/u, "direct attach did not identify the provider while loading");
      assert.match(transition, /◐/u, "direct attach did not render the first loading frame");
      assert.match(transition, /◓/u, "direct attach loading indicator did not animate");
      assert.match(transition, /\u001b\[48;2;235;86;37m/u, "direct attach did not render the Cuna foreground appbar");
      assert.match(
        transition,
        /\u001b\[(?:0;)?(?:(?:1|2|3|4|5|7|8|9|53);)*38;5;208m(?:\u001b\[49m)?FLOW_PROVIDER_ANSI256/u,
        "direct attach did not preserve provider ANSI-256 styling",
      );
      context.observations.arrowSelectedAgentSession = CLAUDE_SESSION_ID;
      context.observations.skippedMachineMenu = true;
      context.observations.enteredForeground = true;
      context.child.write("\u0003");
      await Promise.race([context.exited, new Promise((_, reject) => setTimeout(() => reject(new Error("one Ctrl-C did not exit the direct attach flow within two seconds")), 2_000))]);
    },
    async oracle({ finalState, transcript }) {
      assert.equal(finalState.exitCode, 0, "machines direct attach flow exited nonzero");
      assert.equal(finalState.activeScreen, "normal", "machines direct attach flow did not restore the normal screen");
      assert.match(transcript(), /Attaching to Claude Code/u, "CLI dispatch did not announce the exact selected provider");
      const foregroundStart = transcript().lastIndexOf("\u001b[?1049h");
      const foregroundEnd = transcript().lastIndexOf("\u001b[?1049l");
      assert.doesNotMatch(transcript().slice(foregroundStart, foregroundEnd), /Attaching to Claude Code/u, "attach spinner painted over the foreground PTY");
    },
  }));

  agentSessionScenario = "one-openable-with-terminated";
  try {
    results.push(await runConptyCase({
      testId: "T14.3-WIN-BARE-CUNA-LOADING-HANDOFF", args: [machinesToForegroundFixture, configFile, "--bare"], environment: cliEnvironment,
      async drive(context) {
        await context.waitUntil(
          () => context.screen().includes("claude-ended-a") && context.screen().includes("claude-live"),
          "bare cuna did not reach its machine-first selector",
        );
        assert.match(context.transcript(), /Finding a machine or AgentSession/u, "bare cuna did not render discovery progress");
        const transitionOffset = context.transcript().length;
        context.child.write("\r");
        await context.waitUntil(
          () => context.transcript().slice(transitionOffset).includes("◓") && context.transcript().slice(transitionOffset).includes("Attaching to Claude Code"),
          "bare cuna attach progress did not animate",
        );
        await context.waitUntil(
          () => context.screen().includes("CUNA") && context.screen().includes("FLOW_PROVIDER_ANSI256"),
          "bare cuna did not hand off from progress to the cloud terminal",
        );
        const transition = context.transcript().slice(transitionOffset);
        assert.match(transition, /◐/u, "bare cuna did not render the first attach frame");
        assert.doesNotMatch(transition, /Cuna: attaching to Claude Code/u, "bare cuna retained the old static attach line");
        const foregroundStart = transition.lastIndexOf("\u001b[?1049h");
        assert.doesNotMatch(transition.slice(foregroundStart), /Attaching to Claude Code/u, "bare cuna progress painted over the cloud terminal");
        context.observations.discoveryProgress = true;
        context.observations.attachFrames = "◐ → ◓";
        context.observations.cleanOwnershipHandoff = true;
        context.child.write("\u0003");
        await Promise.race([context.exited, new Promise((_, reject) => setTimeout(() => reject(new Error("one Ctrl-C did not exit bare cuna within two seconds")), 2_000))]);
      },
      async oracle({ finalState }) {
        assert.equal(finalState.exitCode, 0, "bare cuna loading journey exited nonzero");
        assert.equal(finalState.activeScreen, "normal", "bare cuna did not restore the normal screen");
      },
    }));

    results.push(await runConptyCase({
      testId: "T14.3-WIN-MACHINE-SMART-ATTACH", args: [machinesToForegroundFixture, configFile], environment: cliEnvironment,
      async drive(context) {
        await context.waitUntil(
          () => context.screen().includes("claude-ended-a") && context.screen().includes("claude-live") && context.screen().includes("claude-ended-b"),
          "machines overview did not render one attachable session among multiple terminated sessions",
        );
        assert.match(context.screen(), /❯ ▾ conpty-界-🦊/u, "initial selection did not remain on the machine row");
        assert.match(context.screen(), /Claude · claude-live  attachable/u, "the unique live AgentSession was not classified attachable");
        assert.match(context.screen(), /Claude · claude-ended-[ab]  terminated/u, "terminated sibling AgentSessions were not represented");
        const transitionOffset = context.transcript().length;
        // Exact user gesture: Enter on the initially-selected machine. No
        // Down, Right, or other navigation byte is sent before it.
        context.child.write("\r");
        await context.waitUntil(
          () => context.screen().includes("CUNA") && context.screen().includes("FLOW_PROVIDER_ANSI256"),
          "Enter on a machine with one openable child did not smart-attach foreground",
        );
        const transition = context.transcript().slice(transitionOffset);
        assert.doesNotMatch(transition, /◆── conpty-界-🦊/u, "machine smart-attach incorrectly opened the machine context menu");
        assert.doesNotMatch(transition, /Claude provider and sessions|Claude  provider and sessions|Stop  stop/u, "machine smart-attach rendered the intermediate machine menu");
        assert.match(transition, /Attaching to Claude Code/u, "machine smart-attach did not identify the provider while loading");
        assert.match(transition, /◐/u, "machine smart-attach did not render the first loading frame");
        assert.match(transition, /◓/u, "machine smart-attach loading indicator did not animate");
        assert.match(transition, /\u001b\[48;2;235;86;37m/u, "machine smart-attach did not render the Cuna foreground appbar");
        assert.match(transition, /FLOW_PROVIDER_ANSI256/u, "machine smart-attach did not render the provider viewport");
        context.observations.initialSelection = `machine:${MACHINE_ID}`;
        context.observations.openableSessions = 1;
        context.observations.terminatedSessions = 2;
        context.observations.inputBeforeAttach = "Enter only";
        context.observations.skippedMachineMenu = true;
        context.child.write("\u0003");
        await Promise.race([context.exited, new Promise((_, reject) => setTimeout(() => reject(new Error("one Ctrl-C did not exit the smart-attach flow within two seconds")), 2_000))]);
      },
      async oracle({ finalState, transcript }) {
        assert.equal(finalState.exitCode, 0, "machine smart-attach flow exited nonzero");
        assert.equal(finalState.activeScreen, "normal", "machine smart-attach flow did not restore the normal screen");
        assert.match(transcript(), /Attaching to Claude Code/u, "smart-attach dispatch did not preserve the selected provider");
        const foregroundStart = transcript().lastIndexOf("\u001b[?1049h");
        const foregroundEnd = transcript().lastIndexOf("\u001b[?1049l");
        assert.doesNotMatch(transcript().slice(foregroundStart, foregroundEnd), /Attaching to Claude Code/u, "smart-attach spinner painted over the foreground PTY");
      },
    }));
  } finally {
    agentSessionScenario = "default";
  }

  results.push(await runConptyCase({
    testId: "T14.3-WIN-NO-COLOR-CTRL-C", args: [entrypoint, "machines", "--config-file", configFile, "--no-color"], environment: { ...cliEnvironment, NO_COLOR: "1" },
    async drive(context) {
      await context.waitUntil(() => context.screen().includes("conpty-界-🦊"), "no-color explorer did not render");
      assert.doesNotMatch(context.transcript(), /\u001b\[(?:38|48);5;\d+m/u, "--no-color emitted palette colors");
      context.child.write("\u0003");
      await Promise.race([context.exited, new Promise((_, reject) => setTimeout(() => reject(new Error("one Ctrl-C did not exit within two seconds")), 2_000))]);
    },
    async oracle({ finalState }) { assert.equal(finalState.exitCode, 0, "one Ctrl-C exited nonzero"); assert.equal(finalState.activeScreen, "normal", "alternate screen was not restored after Ctrl-C"); },
  }));

  results.push(await runConptyCase({
    testId: "T14.3-WIN-PROVIDER-CTRL-C", args: [providerFixture],
    async drive(context) {
      await context.waitUntil(() => context.screen().includes("provider mock ready 界 🦊"), "provider PTY fixture did not render");
      context.child.write("\u0003");
      await Promise.race([context.exited, new Promise((_, reject) => setTimeout(() => reject(new Error("provider Ctrl-C chord did not exit within two seconds")), 2_000))]);
    },
    async oracle({ finalState, transcript }) {
      assert.equal(finalState.exitCode, 0, "provider Ctrl-C fixture exited nonzero");
      assert.equal(finalState.activeScreen, "normal", "provider alternate screen was not restored");
      assert.match(transcript(), /PROVIDER_CTRL_C_OBSERVED/u, "provider fixture did not observe the raw Ctrl-C byte");
    },
  }));

  assert.equal(mutationLedger.length, 0, `deterministic harness observed cloud mutations: ${JSON.stringify(mutationLedger)}`);
  console.log(JSON.stringify({ testId: "T14.1/T14.3/T14.4/T14.6-WIN", result: "PASS", timestamp: new Date().toISOString(), host: { platform: process.platform, arch: process.arch, release: process.version }, sourceIdentity: source, conpty: { implementation: "node-pty", useConpty: true, useConptyDll: false }, mutationLedger, requestLedger, cases: results, qualification: "Windows deterministic slice only; this is not PRD-014 acceptance." }));
} finally {
  machineGate?.resolve();
  if (server.listening) await closeServer();
  await rm(sandbox, { recursive: true, force: true });
}
process.exit(0);
