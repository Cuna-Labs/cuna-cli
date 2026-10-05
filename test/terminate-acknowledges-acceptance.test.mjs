import assert from "node:assert/strict";
import test from "node:test";

import { EXIT_CODES, memoryStreams, runCli } from "../dist/index.js";

/*
 * W3 of the 2026-09-29 wait-truth goal. Measured LIVE on CLI 8df1553 against
 * Edge v240: `cuna agent-sessions terminate <id> --yes --json` printed nothing
 * for 120 s and was killed by its caller's timeout, while the server had
 * recorded `termination_requested` at +9 s. The supervisor that would end the
 * process had lost control 37 minutes earlier, so the read-back could never
 * settle, and the acceptance the server HAD given was never said.
 *
 * Boundary modelled: `runCli` with a fake API client (capability, POST
 * terminate, GET session) and a hand-driven convergence clock. It does not
 * model the server's termination path.
 */

const NOW_MS = Date.parse("2026-09-29T22:20:00.000Z");
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const MACHINE_ID = "22222222-2222-4222-8222-222222222222";
const REQUESTED_AT = "2026-09-29T22:20:09.000Z";

const PLATFORM = Object.freeze({
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
});

function session(overrides = {}) {
  return Object.freeze({
    id: SESSION_ID, machineId: MACHINE_ID, name: "opencode", agent: "opencode", cwd: "/workspace/projects/demo",
    authMode: "interactive_login", desiredState: "terminated", requestState: "termination_pending", processState: "unknown",
    terminationRequestedAt: REQUESTED_AT, rowVersion: 5,
    createdAt: "2026-09-29T22:13:00.000Z", updatedAt: REQUESTED_AT,
    ...overrides,
  });
}

async function terminate({ argv = [], tty = false, reads }) {
  const streams = memoryStreams({ stdoutIsTTY: tty, stderrIsTTY: tty });
  // A wide terminal, so the painted row is not cut at the default 80 columns.
  if (tty) streams.streams.stderr.columns = 240;
  let convergenceClock = 0;
  const events = [];
  const exit = await runCli(
    ["agent-sessions", "terminate", SESSION_ID, "--yes", ...(tty ? [] : ["--json"]), ...argv],
    {
      streams: streams.streams,
      platform: PLATFORM,
      env: {},
      now: () => NOW_MS,
      humanAuth: { async acquireAccessToken() { return `cuna_at_${"a".repeat(43)}`; } },
      convergencePoller: { now: () => convergenceClock, async sleep(milliseconds) { convergenceClock += milliseconds; } },
      clientFactory: () => ({
        async discoverCapabilities(scope, resourceId) {
          return {
            schemaVersion: "1.0", subjectScope: scope, subjectId: resourceId,
            observedAt: new Date(NOW_MS).toISOString(), expiresAt: new Date(NOW_MS + 30_000).toISOString(), etag: "e",
            capabilities: [{
              id: "agent_sessions.terminate", availability: "supported", interaction: "native",
              mutationClass: "destructive", surfaces: ["cli"],
            }],
          };
        },
        async terminateAgentSession() { events.push("post"); return session(); },
        async getAgentSession(_id, _signal, options) {
          // What had reached stdout by the time the CLI began waiting.
          events.push({ read: events.filter((event) => typeof event === "object").length + 1, stdout: streams.stdout(), options });
          return reads(events.length);
        },
      }),
    },
  );
  return { exit, events, stdout: streams.stdout(), stderr: streams.stderr() };
}

const lines = (text) => text.trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));

test("W3: --json prints the accepted state before the first read-back, then the settled result", async () => {
  const run = await terminate({ reads: (count) => session(count < 4 ? {} : { requestState: "terminal", processState: "terminated" }) });
  assert.equal(run.exit, EXIT_CODES.success, run.stderr);
  const firstRead = run.events.find((event) => typeof event === "object");
  const [accepted] = lines(firstRead.stdout);
  assert.equal(accepted.type, "accepted");
  assert.equal(accepted.command, "agent-sessions.terminate");
  assert.equal(accepted.data.id, SESSION_ID);
  assert.equal(accepted.data.desired_state, "terminated");
  assert.equal(accepted.data.request_state, "termination_pending");
  assert.equal(accepted.data.termination_requested_at, REQUESTED_AT);
  const all = lines(run.stdout);
  assert.deepEqual(all.map((line) => line.type), ["accepted", "result"]);
  assert.equal(all[1].data.process_state, "terminated");
  // The read-back asks for the supervisor evidence it can name while waiting.
  assert.deepEqual(firstRead.options, { runtimeEvidence: true });
});

test("W3: a termination that never settles still said it was accepted, then exits 5 with the cause", async () => {
  const run = await terminate({ reads: () => session({ requestState: "launch_pending" }) });
  assert.equal(run.exit, EXIT_CODES.network);
  assert.deepEqual(lines(run.stdout).map((line) => line.type), ["accepted"]);
  const error = lines(run.stderr).at(-1).error;
  assert.equal(error.code, "cuna.client.convergence_budget_elapsed");
  assert.equal(error.details.remote_outcome, "unobserved");
  assert.equal(error.details.wait_cause, "no supervisor has claimed the launch");
});

test("W3: --no-wait answers with the acceptance alone and reads nothing back", async () => {
  const run = await terminate({ argv: ["--no-wait"], reads: () => assert.fail("--no-wait must not read back") });
  assert.equal(run.exit, EXIT_CODES.success, run.stderr);
  const all = lines(run.stdout);
  assert.deepEqual(all.map((line) => line.type), ["result"]);
  assert.equal(all[0].data.request_state, "termination_pending");
  assert.equal(all[0].data.termination_requested_at, REQUESTED_AT);
  assert.deepEqual(run.events, ["post"]);
});

test("W3: a person at a terminal sees the acceptance and what the wait is on", async () => {
  const run = await terminate({
    tty: true,
    reads: (count) => session(count < 3 ? { requestState: "launch_pending" } : { requestState: "terminal", processState: "terminated" }),
  });
  assert.equal(run.exit, EXIT_CODES.success, run.stderr);
  assert.match(run.stderr, new RegExp(`Termination requested for AgentSession ${SESSION_ID} at ${REQUESTED_AT}\\.`, "u"));
  assert.match(run.stderr, /Still waiting for the machine's supervisor to end the session process · no supervisor has claimed the launch · \d+s of 120s/u);
  assert.match(run.stdout, new RegExp(`AgentSession ${SESSION_ID} is terminal/terminated\\.`, "u"));
});

test("W3 NEGATIVE CONTROL: a refused request prints no acceptance", async () => {
  // Varies only whether the server accepted. An `accepted` line for a request
  // the server refused would be the one lie this line exists to avoid.
  const streams = memoryStreams({ stdoutIsTTY: false, stderrIsTTY: false });
  const exit = await runCli(["agent-sessions", "terminate", SESSION_ID, "--yes", "--json"], {
    streams: streams.streams, platform: PLATFORM, env: {}, now: () => NOW_MS,
    humanAuth: { async acquireAccessToken() { return `cuna_at_${"a".repeat(43)}`; } },
    clientFactory: () => ({
      async discoverCapabilities(scope, resourceId) {
        return {
          schemaVersion: "1.0", subjectScope: scope, subjectId: resourceId,
          observedAt: new Date(NOW_MS).toISOString(), expiresAt: new Date(NOW_MS + 30_000).toISOString(), etag: "e",
          capabilities: [{ id: "agent_sessions.terminate", availability: "supported", interaction: "native", mutationClass: "destructive", surfaces: ["cli"] }],
        };
      },
      async terminateAgentSession() {
        const { CunaError } = await import("../dist/index.js");
        throw new CunaError({ code: "cuna.remote.conflict", message: "Conflict.", exitCode: EXIT_CODES.conflict });
      },
      async getAgentSession() { assert.fail("a refused termination must not be read back"); },
    }),
  });
  assert.equal(exit, EXIT_CODES.conflict);
  assert.equal(streams.stdout(), "");
});
