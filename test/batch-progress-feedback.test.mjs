// A batch command that waits on the network says so.
//
// The claim is about the WAITING, not the result, and it is asserted mid-flight
// from inside the injected dependency: after the command returns, a spinner
// that ran and one that never started look identical, because the spinner
// erases its own row.
//
// PRD-PM-008 D5-R18: waiting states are task-level, on stderr, never in
// structured output.
import test from "node:test";
import assert from "node:assert/strict";

import { EXIT_CODES, memoryStreams, runCli } from "../dist/index.js";

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

const PLATFORM = Object.freeze({
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
});

/**
 * Run one command whose single slow dependency reports what stderr held while
 * the command was still waiting. `observed` is the mid-flight transcript.
 */
async function runWithMidFlightObservation(argv, { humanAuth, clientFactory, isTTY = true } = {}) {
  const streams = memoryStreams({ stdoutIsTTY: isTTY, stderrIsTTY: isTTY });
  let observed = "";
  const observe = () => { observed = streams.stderr(); };
  const exit = await runCli([...argv, "--no-color"], {
    streams: streams.streams,
    platform: PLATFORM,
    env: {},
    ...(humanAuth === undefined ? {} : { humanAuth: humanAuth(observe) }),
    ...(clientFactory === undefined ? {} : { clientFactory: clientFactory(observe) }),
  });
  return { exit, observed, stderr: streams.stderr(), stdout: streams.stdout() };
}

test("cuna whoami shows a task-level waiting line while the identity read is in flight", async () => {
  const run = await runWithMidFlightObservation(["whoami"], {
    humanAuth: (observe) => ({
      async whoami() {
        observe();
        return IDENTITY_RESULT;
      },
    }),
    clientFactory: () => () => ({}),
  });

  assert.equal(run.exit, EXIT_CODES.success, run.stderr);
  assert.match(run.observed, /CUNA/u, `nothing on stderr while whoami was waiting: ${JSON.stringify(run.observed)}`);
  assert.match(run.observed, /Checking your Cuna sign-in/u);
  // The label names the task, not the transport. A person should never have to
  // know that an HTTP request is what they are waiting for.
  assert.doesNotMatch(run.observed, /http|GET |POST |request/iu);
});

test("cuna logout shows a task-level waiting line while the sign-out is in flight", async () => {
  const run = await runWithMidFlightObservation(["logout"], {
    humanAuth: (observe) => ({
      async logout() {
        observe();
        return { profile: "default", signedOut: true };
      },
    }),
    clientFactory: () => () => ({}),
  });

  assert.equal(run.exit, EXIT_CODES.success, run.stderr);
  assert.match(run.observed, /Signing out of Cuna/u, `nothing on stderr while logout was waiting: ${JSON.stringify(run.observed)}`);
  assert.match(run.stdout, /Signed out of Cuna on this device\./u);
});

test("a batch machines read shows a task-level waiting line while the list is in flight", async () => {
  const run = await runWithMidFlightObservation(["machines", "list"], {
    humanAuth: () => ({ async acquireAccessToken() { return `cuna_at_${"a".repeat(43)}`; } }),
    clientFactory: (observe) => () => ({
      async listMachines() {
        observe();
        return { items: [], nextCursor: undefined };
      },
    }),
  });

  assert.equal(run.exit, EXIT_CODES.success, run.stderr);
  assert.match(run.observed, /Loading machines/u, `nothing on stderr while machines list was waiting: ${JSON.stringify(run.observed)}`);
});

test("the waiting line is erased before the result and never reaches a pipe", async () => {
  const interactive = await runWithMidFlightObservation(["whoami"], {
    humanAuth: () => ({ async whoami() { return IDENTITY_RESULT; } }),
    clientFactory: () => () => ({}),
  });
  // The spinner owns one row and erases it before the result is written. A
  // memory stream keeps every byte ever written, so the proof is that the last
  // thing written is the erase sequence — on a real terminal that row is gone.
  assert.match(interactive.stderr, /\r\[2K$/u, JSON.stringify(interactive.stderr));

  // Redirected output is a machine's input. A progress row written there would
  // corrupt it, and `stderrIsTTY === false` is the only thing standing between
  // the two.
  const piped = await runWithMidFlightObservation(["whoami"], {
    humanAuth: () => ({ async whoami() { return IDENTITY_RESULT; } }),
    clientFactory: () => () => ({}),
    isTTY: false,
  });
  assert.equal(piped.exit, EXIT_CODES.success, piped.stderr);
  assert.doesNotMatch(piped.stderr, /Checking your Cuna sign-in/u);
  assert.doesNotMatch(piped.stderr, /◆ CUNA/u);
});
