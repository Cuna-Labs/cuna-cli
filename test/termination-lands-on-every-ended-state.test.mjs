// A termination has landed when the process is no longer running, whichever of
// its end words the producer chose.
//
// The consumer's real predicate is driven with the producer's whole vocabulary
// rather than a fixture of one value: matching a single value of a vocabulary
// the other side chooses from can never settle. Five states must still hold.
import test from "node:test";
import assert from "node:assert/strict";

import { EXIT_CODES, memoryStreams, runCli } from "../dist/index.js";

// The complete `AgentSessionProcessState` union, copied from the wire contract
// in `src/api/contracts.ts`. If the producer gains a state, this list must gain
// it too — a test that enumerates only what it already handles proves nothing.
const PROCESS_STATES = [
  "unknown",
  "starting",
  "ready",
  "running",
  "exited",
  "failed",
  "terminating",
  "terminated",
];

// The three in which nothing of the session is running.
const ENDED = new Set(["exited", "failed", "terminated"]);

// The CLI refuses capability evidence whose lifetime is longer than the
// contract allows (`excessive_ttl`), so the stub uses the same 30-second window
// the real server sends rather than a century.
const NOW_MS = Date.parse("2026-09-02T00:00:00.000Z");
const OBSERVED_AT = new Date(NOW_MS).toISOString();
const EXPIRES_AT = new Date(NOW_MS + 30_000).toISOString();

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const MACHINE_ID = "22222222-2222-4222-8222-222222222222";

const PLATFORM = Object.freeze({
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
});

function session(processState) {
  return Object.freeze({
    id: SESSION_ID,
    machineId: MACHINE_ID,
    name: "opencode",
    agent: "opencode",
    cwd: "/workspace/projects/demo",
    desiredState: "terminated",
    requestState: "terminal",
    processState,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:01.000Z",
  });
}

async function terminate(processState) {
  const streams = memoryStreams({ stdoutIsTTY: false, stderrIsTTY: false });
  let convergenceClock = 0;
  let reads = 0;
  const exit = await runCli(
    ["agent-sessions", "terminate", SESSION_ID, "--yes", "--json"],
    {
      streams: streams.streams,
      platform: PLATFORM,
      env: {},
      now: () => NOW_MS,
      humanAuth: { async acquireAccessToken() { return `cuna_at_${"a".repeat(43)}`; } },
      // The clock is driven by the sleeps themselves, so an unsettleable state
      // exhausts its budget in milliseconds of real time instead of two minutes.
      convergencePoller: {
        now: () => convergenceClock,
        async sleep(milliseconds) { convergenceClock += milliseconds; },
      },
      clientFactory: () => ({
        async discoverCapabilities(scope, resourceId) {
          return {
            schemaVersion: "1.0",
            subjectScope: scope,
            subjectId: resourceId,
            observedAt: OBSERVED_AT,
            expiresAt: EXPIRES_AT,
            etag: "e",
            capabilities: [{
              id: "agent_sessions.terminate",
              // `interaction` is how the surface acts, not how dangerous it
              // is: the vocabulary is native / read_only / browser_handoff /
              // unknown, and a CLI mutation is `native`. The destructiveness
              // lives in `mutationClass`.
              availability: "supported",
              interaction: "native",
              mutationClass: "destructive",
              surfaces: ["cli"],
            }],
          };
        },
        async terminateAgentSession() { return undefined; },
        async getAgentSession() { reads += 1; return session(processState); },
      }),
    },
  );
  const stdout = streams.stdout().trim();
  const stderr = streams.stderr().trim();
  const record = JSON.parse((stdout === "" ? stderr : stdout).split("\n").at(-1));
  return { exit, record, reads };
}

for (const processState of PROCESS_STATES) {
  const ended = ENDED.has(processState);
  test(`a terminated/terminal/${processState} session ${ended ? "settles" : "keeps waiting"}`, async () => {
    const run = await terminate(processState);
    if (ended) {
      assert.equal(run.exit, EXIT_CODES.success, JSON.stringify(run.record));
      assert.equal(run.record.command, "agent-sessions.terminate");
      assert.equal(run.record.data.process_state, processState);
      // The one that mattered: `exited` is what production actually answers.
      assert.ok(run.reads >= 1);
    } else {
      // The negative control. If every state settled, the fix would have
      // removed the wait rather than corrected it, and a session still shutting
      // down would be reported as finished.
      assert.equal(run.exit, EXIT_CODES.network, JSON.stringify(run.record));
      assert.equal(run.record.error.code, "cuna.client.convergence_budget_elapsed");
    }
  });
}

test("a session the caller never asked to end is not read as terminated", async () => {
  // The conjunction over all three fields is what keeps this honest: a process
  // that died on its own, with no termination requested, must not be reported
  // as a completed termination.
  const streams = memoryStreams({ stdoutIsTTY: false, stderrIsTTY: false });
  let convergenceClock = 0;
  const exit = await runCli(
    ["agent-sessions", "terminate", SESSION_ID, "--yes", "--json"],
    {
      streams: streams.streams,
      platform: PLATFORM,
      env: {},
      now: () => NOW_MS,
      humanAuth: { async acquireAccessToken() { return `cuna_at_${"a".repeat(43)}`; } },
      convergencePoller: {
        now: () => convergenceClock,
        async sleep(milliseconds) { convergenceClock += milliseconds; },
      },
      clientFactory: () => ({
        async discoverCapabilities(scope, resourceId) {
          return {
            schemaVersion: "1.0",
            subjectScope: scope,
            subjectId: resourceId,
            observedAt: OBSERVED_AT,
            expiresAt: EXPIRES_AT,
            etag: "e",
            capabilities: [{
              id: "agent_sessions.terminate",
              // `interaction` is how the surface acts, not how dangerous it
              // is: the vocabulary is native / read_only / browser_handoff /
              // unknown, and a CLI mutation is `native`. The destructiveness
              // lives in `mutationClass`.
              availability: "supported",
              interaction: "native",
              mutationClass: "destructive",
              surfaces: ["cli"],
            }],
          };
        },
        async terminateAgentSession() { return undefined; },
        async getAgentSession() {
          return Object.freeze({ ...session("exited"), desiredState: "running", requestState: "launched" });
        },
      }),
    },
  );
  assert.equal(exit, EXIT_CODES.network);
  assert.equal(JSON.parse(streams.stderr().trim().split("\n").at(-1)).error.code, "cuna.client.convergence_budget_elapsed");
});
