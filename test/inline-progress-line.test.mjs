// What the single inline progress row says, asserted without a clock or a TTY.
//
// The defect this guards is measured in prds/cuna-cli-latency-before-20260922.md
// § 3: the row repainted every 90 ms for 61 259 ms while saying the same eleven
// words (`Starting Claude Code · still working — Ctrl-C cancels`), so a
// byte-level liveness check passed and a reader still saw a frozen screen.
import assert from "node:assert/strict";
import test from "node:test";

import {
  INLINE_CANCEL_HINT_MS,
  INLINE_DWELL_HINT_MS,
  agentSessionDispositionLine,
  composeInlineProgressLine,
} from "../dist/cli/progress-line.js";

const SESSION = "00b6d65a-c744-4882-aca0-d02267767d2d";

function line(input) {
  const composed = composeInlineProgressLine(input);
  return `${composed.headline}${composed.trailer}`;
}

test("a step under the dwell threshold reads as its plain label", () => {
  assert.equal(
    line({ label: "Preparing Claude Code", labelElapsedMs: 1_999, totalElapsedMs: 1_999 }),
    "Preparing Claude Code",
  );
});

test("a dwelling step carries the seconds it has been dwelling", () => {
  assert.equal(
    line({ label: "Starting Claude Code", labelElapsedMs: 2_000, totalElapsedMs: 2_000 }),
    "Starting Claude Code · 2s",
  );
  // The exact dwell the measurement recorded. The escalation this replaces
  // reached `Starting Claude Code · still working — Ctrl-C cancels` at second
  // 12 and then said it unchanged through second 61.
  assert.equal(
    line({ label: "Starting Claude Code", labelElapsedMs: 61_259, totalElapsedMs: 72_913 }),
    "Starting Claude Code · 61s — Ctrl-C cancels",
  );
});

test("the counter moves every second, so the line cannot repeat for 2 000 ms", () => {
  const seen = new Set();
  for (let elapsed = INLINE_DWELL_HINT_MS; elapsed <= 61_000; elapsed += 1_000) {
    seen.add(line({ label: "Starting Claude Code", labelElapsedMs: elapsed, totalElapsedMs: elapsed }));
  }
  // 60 distinct renderings over the interval that previously produced one.
  assert.equal(seen.size, 60);
});

test("the elapsed figure is the STEP's, not the command's", () => {
  // A phase that has just started must not inherit the previous phase's age;
  // the number is evidence about this step, and only this step.
  assert.equal(
    line({ label: "Syncing workspace", labelElapsedMs: 300, totalElapsedMs: 45_000 }),
    "Syncing workspace — Ctrl-C cancels",
  );
});

test("the cancel affordance is bound to the command and survives a phase change", () => {
  assert.equal(
    line({ label: "Finding a compatible machine", labelElapsedMs: 0, totalElapsedMs: INLINE_CANCEL_HINT_MS - 1 }),
    "Finding a compatible machine",
  );
  assert.equal(
    line({ label: "Finding a compatible machine", labelElapsedMs: 0, totalElapsedMs: INLINE_CANCEL_HINT_MS }),
    "Finding a compatible machine — Ctrl-C cancels",
  );
});

test("a declared wait replaces the label and names what has not answered", () => {
  assert.equal(
    line({
      label: "Starting Claude Code",
      waiting: {
        waitingFor: "the machine's terminal supervisor to register",
        elapsedMs: 23_400,
        deadlineMs: 180_000,
      },
      labelElapsedMs: 23_400,
      totalElapsedMs: 35_000,
    }),
    "Still waiting for the machine's terminal supervisor to register · 23s of 180s — Ctrl-C cancels",
  );
});

test("a wait never shows two different elapsed figures on one row", () => {
  // The wait sentence carries its own seconds AND its deadline, which is
  // strictly more than the dwell counter would add. Both would force a reader
  // to reconcile two numbers that mean almost the same thing.
  const composed = composeInlineProgressLine({
    label: "Starting Claude Code",
    waiting: { waitingFor: "the session to accept a terminal", elapsedMs: 61_000, deadlineMs: 180_000 },
    labelElapsedMs: 61_000,
    totalElapsedMs: 61_000,
  });
  assert.equal(composed.trailer, " — Ctrl-C cancels");
  assert.doesNotMatch(composed.trailer, /\d+s/u);
});

test("the row never says `still working`, which was the whole escalation", () => {
  for (const elapsed of [0, 2_000, 4_000, 12_000, 61_259]) {
    assert.doesNotMatch(
      line({ label: "Starting Claude Code", labelElapsedMs: elapsed, totalElapsedMs: elapsed }),
      /still working/u,
    );
  }
});

test("the AgentSession line names the row and whether this journey made it", () => {
  assert.equal(
    agentSessionDispositionLine({ agentSessionId: SESSION, machineId: "m", disposition: "created" }),
    "AgentSession 00b6d65a · created",
  );
  assert.equal(
    agentSessionDispositionLine({ agentSessionId: SESSION, machineId: "m", disposition: "reused" }),
    "AgentSession 00b6d65a · reused",
  );
  // A prefix, never the whole identifier: the same 8-character truncation
  // `src/runtime/owner-grants-screen.ts` uses when it puts an id on screen.
  assert.doesNotMatch(
    agentSessionDispositionLine({ agentSessionId: SESSION, machineId: "m", disposition: "created" }),
    new RegExp(SESSION, "u"),
  );
});
