import assert from "node:assert/strict";
import test from "node:test";

import * as run from "../dist/cli/run.js";

/*
 * R7.2, BL-7 (LIVE_RUNTIME 2026-10-03): the journey's attach is where the
 * agent takes the terminal and the workspace lines start being held. Before
 * this, nothing about workspace sync crossed into the foreground runner, so the
 * attached bar could not say that sync stopped. Boundary modelled: the
 * journey's attach in `cli/run.ts` with a capturing foreground runner; the
 * runner and the workspace effects are fakes.
 */

function fakeWorkspace(events) {
  return {
    syncAttention: Object.freeze({ current: () => undefined, subscribe: () => () => undefined }),
    holdNotices() { events.push("hold"); },
    releaseNotices() { events.push("release"); },
  };
}

test("R7.2: the journey's attach hands the workspace sync attention to the foreground runner", async () => {
  assert.equal(typeof run.attachJourneyForeground, "function", "the journey attach is reachable");
  const events = [];
  const workspace = fakeWorkspace(events);
  const captured = [];
  await run.attachJourneyForeground(async (input) => {
    captured.push(input);
    input.onBeforeTerminalOwnership?.();
    events.push("attached");
  }, workspace, {
    client: {},
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: ["11111111-1111-4111-8111-111111111111"],
    expectedAgentKinds: ["opencode"],
    onBeforeTerminalOwnership: () => events.push("progress:stop"),
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].syncAttention, workspace.syncAttention, "the runner receives the projection itself");
  assert.deepEqual(captured[0].agentSessionIds, ["11111111-1111-4111-8111-111111111111"]);
  // The held lines keep their behaviour: held once the agent owns the
  // terminal, after the caller's own progress row is gone, released at return.
  assert.deepEqual(events, ["progress:stop", "hold", "attached", "release"]);
});

test("R7.2 NEGATIVE CONTROL: a runner that fails still releases the held lines, and still had the projection", async () => {
  assert.equal(typeof run.attachJourneyForeground, "function", "the journey attach is reachable");
  const events = [];
  const workspace = fakeWorkspace(events);
  let received;
  await assert.rejects(run.attachJourneyForeground(async (input) => {
    received = input.syncAttention;
    input.onBeforeTerminalOwnership?.();
    throw new Error("terminal refused");
  }, workspace, {
    client: {},
    baseUrl: "https://api.getcuna.com",
    agentSessionIds: ["11111111-1111-4111-8111-111111111111"],
  }), /terminal refused/u);
  assert.equal(received, workspace.syncAttention);
  assert.deepEqual(events, ["hold", "release"]);
});
