// D7 and D8: the progress row is there, and it names the read in flight.
//
// Measured on the installed 0.1.3 on 2026-09-28: `cuna executions list` showed
// a blank screen for 0.96-2.7 s and then the whole answer, while every other
// network read shows a `◆ CUNA` row; `cuna account show` said `Reading your
// workspace` for up to 4.0 s while it read the account identity.
//
// Asserted mid-flight from inside the injected dependency: the row erases
// itself, so after the command returns a row that ran and one that never
// started look identical.
import test from "node:test";
import assert from "node:assert/strict";

import { EXIT_CODES, memoryStreams, runCli } from "../dist/index.js";

const PLATFORM = Object.freeze({
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
});
const MACHINE_ID = "11111111-1111-4111-8111-111111111111";
const EXECUTION_ID = "22222222-2222-4222-8222-222222222222";

async function midFlight(argv, clientFactory) {
  const streams = memoryStreams({ stdoutIsTTY: true, stderrIsTTY: true });
  let observed = "";
  const observe = () => { observed = streams.stderr(); };
  const exit = await runCli([...argv, "--no-color"], {
    streams: streams.streams,
    platform: PLATFORM,
    env: {},
    humanAuth: { async acquireAccessToken() { return `cuna_at_${"a".repeat(43)}`; } },
    clientFactory: () => clientFactory(observe),
  });
  return { exit, observed, stderr: streams.stderr(), stdout: streams.stdout() };
}

test("executions list shows a progress row while the list is in flight", async () => {
  const run = await midFlight(["executions", "list", "--machine", MACHINE_ID], (observe) => ({
    async listManagedExecutions() {
      observe();
      return { machineId: MACHINE_ID, items: [], nextCursor: null };
    },
  }));
  assert.equal(run.exit, EXIT_CODES.success, run.stderr);
  assert.match(run.observed, /◆ CUNA/u, `blank screen while executions list waited: ${JSON.stringify(run.observed)}`);
  assert.match(run.observed, /Reading remote commands/u);
  assert.match(run.stdout, new RegExp(`Remote executions on Machine ${MACHINE_ID}`, "u"));
});

test("executions cancel says it is requesting, not reading", async () => {
  const run = await midFlight(["executions", "cancel", EXECUTION_ID, "--machine", MACHINE_ID, "--yes"], (observe) => ({
    async cancelManagedExecution() {
      observe();
      throw new Error("the answer does not matter here");
    },
  }));
  assert.match(run.observed, /Requesting cancellation of the remote command/u, JSON.stringify(run.observed));
});

test("account show names the account read, and workspace show keeps its own label", async () => {
  const identity = { id: "33333333-3333-4333-8333-333333333333", email: "person@example.com", workspaceAssigned: true };
  const account = await midFlight(["account", "show"], (observe) => ({
    async getIdentity() { observe(); return identity; },
  }));
  assert.equal(account.exit, EXIT_CODES.success, account.stderr);
  assert.match(account.observed, /Reading your account/u, JSON.stringify(account.observed));
  assert.doesNotMatch(account.observed, /workspace/iu, "account show reads the account identity, not the workspace");

  const workspace = await midFlight(["workspace", "show"], (observe) => ({
    async getIdentity() { observe(); return identity; },
  }));
  assert.equal(workspace.exit, EXIT_CODES.success, workspace.stderr);
  assert.match(workspace.observed, /Reading your workspace/u);
});
