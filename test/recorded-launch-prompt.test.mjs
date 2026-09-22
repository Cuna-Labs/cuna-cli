import assert from "node:assert/strict";
import test from "node:test";

import {
  RECORDED_LAUNCH_ACKNOWLEDGEMENT_BUDGET_MS,
  RECORDED_LAUNCH_QUESTION,
  askRecordedLaunch,
  recordedLaunchAcknowledgement,
  recordedLaunchWantsNewSession,
} from "../dist/cli/recorded-launch-prompt.js";

const CREATE_LABEL = "Creating Claude Code session";

/**
 * The worst byte silence measured after this answer: run `reattach4` of
 * prds/cuna-cli-latency-before-20260922.md § 3, finding 1. Two other runs of
 * five showed 2 317 ms and 3 864 ms of the same thing.
 */
const MEASURED_SILENCE_MS = 18_314;

/**
 * ONE DRIVER, TWO POLICIES — the only variable is who owns the moment between
 * the answer and the next remote step.
 *
 * The clock moves exactly where the measurement says it moved: not at all
 * while the answer is read, then 18 314 ms while the CLI does whatever it does
 * next. No real clock is involved, so the figure this reports is the one the
 * test decided, and a policy cannot pass by being fast.
 */
async function silenceAfterTheAnswer(policy, answer = "n") {
  let clock = 0;
  const lines = [];
  const write = (line) => { lines.push(Object.freeze({ line, at: clock })); };
  let answeredAt;
  const ask = async () => { answeredAt = clock; return answer; };
  const wantsNewSession = await policy({ ask, acknowledge: write, createLabel: CREATE_LABEL });
  clock += MEASURED_SILENCE_MS;
  write("Starting Claude Code");
  return Object.freeze({
    wantsNewSession,
    lines,
    firstLine: lines[0].line,
    silenceMs: lines[0].at - answeredAt,
  });
}

/**
 * The behaviour this repairs, written out rather than referred to: ask, parse,
 * return, and let the next thing that happens to report own the screen.
 */
const previousPolicy = async ({ ask }) =>
  recordedLaunchWantsNewSession(await ask(RECORDED_LAUNCH_QUESTION));

test("a line answers the recorded-launch question within its budget", async () => {
  const observed = await silenceAfterTheAnswer(askRecordedLaunch);
  assert.equal(observed.silenceMs, 0);
  assert.ok(observed.silenceMs < RECORDED_LAUNCH_ACKNOWLEDGEMENT_BUDGET_MS);
  assert.equal(observed.firstLine, "Resuming the recorded launch");
});

test("NEGATIVE CONTROL: without it the screen holds the measured 18 314 ms of silence", async () => {
  const observed = await silenceAfterTheAnswer(previousPolicy);
  assert.equal(observed.silenceMs, MEASURED_SILENCE_MS);
  assert.ok(observed.silenceMs > RECORDED_LAUNCH_ACKNOWLEDGEMENT_BUDGET_MS);
  // Nothing at all belonged to the answer: the first thing on screen is the
  // next step, which is why the freeze read as the keystroke having broken it.
  assert.equal(observed.firstLine, "Starting Claude Code");
});

test("the acknowledgement is on screen before the caller can dispatch anything", async () => {
  // The bound is structural, not timed: there is nowhere for a remote call to
  // go between the answer and the line, because the line is written before the
  // promise the caller is awaiting resolves.
  const order = [];
  await askRecordedLaunch({
    ask: async (question) => { order.push(`asked:${question}`); return "y"; },
    acknowledge: (line) => order.push(`screen:${line}`),
    createLabel: CREATE_LABEL,
  });
  order.push("resolved");
  assert.deepEqual(order, [
    `asked:${RECORDED_LAUNCH_QUESTION}`,
    `screen:${CREATE_LABEL}`,
    "resolved",
  ]);
});

test("the line names the branch that was taken, not the question that was asked", async () => {
  assert.equal(recordedLaunchAcknowledgement(true, CREATE_LABEL), CREATE_LABEL);
  assert.equal(recordedLaunchAcknowledgement(false, CREATE_LABEL), "Resuming the recorded launch");
  const created = await silenceAfterTheAnswer(askRecordedLaunch, "y");
  assert.equal(created.wantsNewSession, true);
  assert.equal(created.firstLine, CREATE_LABEL);
  assert.equal(created.silenceMs, 0);
});

test("only an explicit yes creates; everything else resumes", () => {
  for (const answer of ["y", "Y", "yes", "YES", " yes "]) {
    assert.equal(recordedLaunchWantsNewSession(answer), true, answer);
  }
  for (const answer of ["", " ", "n", "no", "N", "yep", "sure", "1"]) {
    assert.equal(recordedLaunchWantsNewSession(answer), false, JSON.stringify(answer));
  }
});
