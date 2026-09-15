// A lifecycle command says whether it changed anything.
//
// The answer is not a refusal: `machines start` in a script that wants the
// Machine up keeps succeeding, and the transition is still requested, because
// this side's idea of the state and the provider's can diverge. What the result
// must carry is which of the two happened.
import test from "node:test";
import assert from "node:assert/strict";

import { EXIT_CODES, memoryStreams, runCli } from "../dist/index.js";

const MACHINE_ID = "22222222-2222-4222-8222-222222222222";
const NOW_MS = Date.parse("2026-09-02T00:00:00.000Z");
const OBSERVED_AT = new Date(NOW_MS).toISOString();
const EXPIRES_AT = new Date(NOW_MS + 30_000).toISOString();

const PLATFORM = Object.freeze({
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
});

function machine(state) {
  return Object.freeze({
    id: MACHINE_ID,
    name: "harness",
    state,
    agent: "opencode",
    vcpus: 1,
    memoryMiB: 2048,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:01.000Z",
  });
}

function capabilities(scope, resourceId) {
  return {
    schemaVersion: "1.0",
    subjectScope: scope,
    subjectId: resourceId,
    observedAt: OBSERVED_AT,
    expiresAt: EXPIRES_AT,
    etag: "e",
    capabilities: [{
      id: "machines.lifecycle",
      availability: "supported",
      interaction: "native",
      mutationClass: "reversible",
      surfaces: ["cli"],
    }],
  };
}

/**
 * Run one transition. `states` is the sequence `getMachine` answers with: the
 * first read is the prestate the command takes before asking for anything, the
 * rest are the convergence probe.
 */
async function transition(action, states) {
  const streams = memoryStreams({ stdoutIsTTY: false, stderrIsTTY: false });
  let convergenceClock = 0;
  let call = 0;
  let transitions = 0;
  const exit = await runCli(
    ["machines", action, MACHINE_ID, "--yes", "--json"],
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
        async discoverCapabilities(scope, resourceId) { return capabilities(scope, resourceId); },
        async getMachine() {
          const state = states[Math.min(call, states.length - 1)];
          call += 1;
          return machine(state);
        },
        async transitionMachine() { transitions += 1; return machine(states.at(-1)); },
      }),
    },
  );
  const stdout = streams.stdout().trim();
  const stderr = streams.stderr().trim();
  const record = JSON.parse((stdout === "" ? stderr : stdout).split("\n").at(-1));
  return { exit, record, transitions };
}

const MOVED = [
  ["start", "stopped", "running"],
  ["stop", "running", "stopped"],
  ["pause", "running", "paused"],
  ["resume", "paused", "running"],
];

for (const [action, from, to] of MOVED) {
  test(`machines ${action} on a ${from} Machine reports that it moved`, async () => {
    const run = await transition(action, [from, to]);
    assert.equal(run.exit, EXIT_CODES.success, JSON.stringify(run.record));
    assert.equal(run.record.data.state, to);
    assert.equal(run.record.data.state_changed, true);
  });

  test(`machines ${action} on a Machine already ${to} says nothing changed`, async () => {
    const run = await transition(action, [to]);
    assert.equal(run.exit, EXIT_CODES.success, JSON.stringify(run.record));
    assert.equal(run.record.data.state, to);
    assert.equal(run.record.data.state_changed, false);
    // The transition is still requested on purpose: the two sides can disagree,
    // and skipping it would turn a recovery command into a no-op exactly when
    // it is needed. If this ever reads 0, that decision has been reversed
    // silently.
    assert.equal(run.transitions, 1);
  });
}

test("the human line says it plainly, not only the JSON", async () => {
  // A field only a script can read is not feedback. This codebase has shipped a
  // hint the renderer dropped before.
  const streams = memoryStreams({ stdoutIsTTY: true, stderrIsTTY: true });
  let convergenceClock = 0;
  const exit = await runCli(
    ["machines", "stop", MACHINE_ID, "--yes", "--no-color"],
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
        async discoverCapabilities(scope, resourceId) { return capabilities(scope, resourceId); },
        async getMachine() { return machine("stopped"); },
        async transitionMachine() { return machine("stopped"); },
      }),
    },
  );
  assert.equal(exit, EXIT_CODES.success, streams.stderr());
  assert.match(streams.stdout(), /was already stopped; nothing changed\./u);
});
