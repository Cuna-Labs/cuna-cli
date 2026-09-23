import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import { createPlatformAdapter } from "../dist/platform/adapter.js";
import {
  TERMINAL_CLIENT_BUSY_NOTICE,
  TERMINAL_CLIENT_RECORD_IDLE_MS,
  claimTerminalClientIdentity,
  forgetTerminalClientIdentity,
  isAgentSessionGone,
} from "../dist/runtime/terminal-client-identity.js";

/**
 * R14: this computer is the same terminal client for the same (profile,
 * AgentSession) across runs, and never for two of them, and never in two
 * processes at once.
 *
 * Why it matters: nothing releases a writer seat on detach, and every CLI run
 * used to mint a new `cli:<uuid>`, so a clean detach + re-attach met
 * `terminal_writer_held` and had to transfer (R12 saw epoch 2 -> 3 -> 4).
 */

const SESSION_A = Object.freeze({ id: "11111111-1111-4111-8111-111111111111", createdAt: "2026-09-22T15:00:00.000Z" });
const SESSION_B = Object.freeze({ id: "22222222-2222-4222-8222-222222222222", createdAt: "2026-09-22T15:05:00.000Z" });

async function stateScope(t, profile = "default") {
  const home = await mkdtemp(join(tmpdir(), "cuna-terminal-client-"));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const env = { APPDATA: join(home, "Roaming"), LOCALAPPDATA: join(home, "Local"), XDG_STATE_HOME: join(home, "state"), XDG_CONFIG_HOME: join(home, "config") };
  return { home, env, scope: { platform: createPlatformAdapter({ env, homeDirectory: home }), profile } };
}

async function claimAndRelease(scope, session, options) {
  const identity = await claimTerminalClientIdentity(scope, session, options);
  await identity.release();
  return identity;
}

test("a re-attach from this computer reuses the recorded client, and the record is owner-only", async (t) => {
  const { scope } = await stateScope(t);
  const first = await claimAndRelease(scope, SESSION_A);
  const second = await claimAndRelease(scope, SESSION_A);
  assert.equal(first.source, "minted");
  assert.equal(second.source, "reused");
  assert.equal(second.clientInstanceId, first.clientInstanceId);
  assert.match(first.clientInstanceId, /^cli:[0-9a-f-]{36}$/u);
  const directory = join(scope.platform.paths.stateDirectory, "terminal-clients");
  const [profile] = await readdir(directory);
  const record = join(directory, profile, `${SESSION_A.id}.json`);
  assert.equal(JSON.parse(await readFile(record, "utf8")).clientInstanceId, first.clientInstanceId);
  if (process.platform !== "win32") assert.equal((await stat(record)).mode & 0o777, 0o600);
});

test("NEGATIVE CONTROL: a forgotten record means the next attach is a new client", async (t) => {
  // The behaviour before R14 on every run, reproduced by removing the record.
  const { scope } = await stateScope(t);
  const first = await claimAndRelease(scope, SESSION_A);
  await forgetTerminalClientIdentity(scope, SESSION_A.id);
  const second = await claimAndRelease(scope, SESSION_A);
  assert.equal(second.source, "minted");
  assert.notEqual(second.clientInstanceId, first.clientInstanceId);
});

test("an id is never shared across AgentSessions, profiles, or two sessions that reuse one id", async (t) => {
  const { scope, env, home } = await stateScope(t, "work");
  const a = await claimAndRelease(scope, SESSION_A);
  const b = await claimAndRelease(scope, SESSION_B);
  const other = { platform: createPlatformAdapter({ env, homeDirectory: home }), profile: "personal" };
  const aOtherProfile = await claimAndRelease(other, SESSION_A);
  const aRecreated = await claimAndRelease(scope, { ...SESSION_A, createdAt: "2026-09-23T00:00:00.000Z" });
  assert.equal(new Set([a, b, aOtherProfile, aRecreated].map((identity) => identity.clientInstanceId)).size, 4);
  assert.equal(aRecreated.source, "minted", "a record older than the session it names is not that session's");
});

test("a typed terminal state is a gone session; a running one is not", () => {
  const running = { desiredState: "running", requestState: "launched", processState: "running" };
  assert.equal(isAgentSessionGone(running), false);
  for (const change of [
    { desiredState: "terminated" }, { requestState: "terminal" }, { requestState: "failed" },
    { processState: "exited" }, { processState: "failed" }, { processState: "terminated" },
  ]) assert.equal(isAgentSessionGone({ ...running, ...change }), true, JSON.stringify(change));
});

test("records idle past the bound are swept, but never one another process holds", async (t) => {
  const { scope } = await stateScope(t);
  const old = Date.parse("2026-08-01T00:00:00.000Z");
  const now = old + TERMINAL_CLIENT_RECORD_IDLE_MS + 1;
  await claimAndRelease(scope, SESSION_B, { now: () => old });
  // B's lock is held elsewhere: the sweep must leave its record alone.
  const heldB = async (key) => key.endsWith(SESSION_B.id) ? undefined : { release: async () => undefined };
  await claimAndRelease(scope, SESSION_A, { now: () => now, lock: heldB });
  assert.equal((await claimAndRelease(scope, SESSION_B, { now: () => old })).source, "reused");
  // Free now, and idle: swept.
  await claimAndRelease(scope, SESSION_A, { now: () => now });
  assert.equal((await claimAndRelease(scope, SESSION_B, { now: () => now })).source, "minted");
});

/* -------------------------------------------------------------------------- */
/* Two real processes, one computer                                             */
/* -------------------------------------------------------------------------- */

const HOLDER = `
import { createPlatformAdapter } from ${JSON.stringify(new URL("../dist/platform/adapter.js", import.meta.url).href)};
import { claimTerminalClientIdentity } from ${JSON.stringify(new URL("../dist/runtime/terminal-client-identity.js", import.meta.url).href)};
const scope = { platform: createPlatformAdapter({ env: JSON.parse(process.env.HOLDER_ENV), homeDirectory: process.env.HOLDER_HOME }), profile: "default" };
const identity = await claimTerminalClientIdentity(scope, JSON.parse(process.env.HOLDER_SESSION));
process.stdout.write(JSON.stringify({ clientInstanceId: identity.clientInstanceId, source: identity.source }) + "\\n");
process.stdin.once("data", async () => { await identity.release(); process.exit(0); });
`;

test("a second process cannot be the same client: it gets a new id and one line saying so", async (t) => {
  const { scope, env, home } = await stateScope(t);
  const recorded = await claimAndRelease(scope, SESSION_A);
  const holder = spawn(process.execPath, ["--input-type=module", "-e", HOLDER], {
    env: { ...process.env, HOLDER_ENV: JSON.stringify(env), HOLDER_HOME: home, HOLDER_SESSION: JSON.stringify(SESSION_A) },
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  t.after(() => holder.kill());
  const line = await new Promise((resolve) => createInterface({ input: holder.stdout }).once("line", resolve));
  const held = JSON.parse(line);
  assert.deepEqual(held, { clientInstanceId: recorded.clientInstanceId, source: "reused" }, "the other process holds the recorded id");

  const contender = await claimAndRelease(scope, SESSION_A);
  assert.equal(contender.source, "busy");
  assert.equal(contender.notice, TERMINAL_CLIENT_BUSY_NOTICE);
  assert.notEqual(contender.clientInstanceId, recorded.clientInstanceId);

  holder.stdin.write("release\n");
  await new Promise((resolve) => holder.once("exit", resolve));
  const after = await claimAndRelease(scope, SESSION_A);
  assert.equal(after.source, "reused", "the lock follows the process, so the next attach is the same client again");
  assert.equal(after.clientInstanceId, recorded.clientInstanceId);
});
