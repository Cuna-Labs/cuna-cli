import assert from "node:assert/strict";
import test from "node:test";

import { PollingSessionRoster, mergeSessionRoster, sessionRosterEntries } from "../dist/terminal/session-roster.js";

const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const C = "cccccccc-3333-4333-8333-333333333333";
const D = "dddddddd-4444-4444-8444-444444444444";

/** A named entry's label: its name, then the first eight characters of its id. */
const named = (name, id) => `${name} ${id.slice(0, 8)}`;

function session(id, overrides = {}) {
  return {
    id,
    machineId: "33333333-3333-4333-8333-333333333333",
    name: "claude-code",
    agent: "claude-code",
    cwd: `/workspace/${id.slice(0, 1)}`,
    authMode: "interactive_login",
    desiredState: "running",
    requestState: "launched",
    processState: "running",
    rowVersion: 1,
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    ...overrides,
  };
}

test("roster numbers sessions by creation and keeps each number for the run", () => {
  const first = mergeSessionRoster([], [
    session(B, { createdAt: "2026-09-23T00:00:02.000Z", name: "beta" }),
    session(A, { createdAt: "2026-09-23T00:00:01.000Z", name: "alpha" }),
  ]);
  assert.deepEqual(sessionRosterEntries(first).map((entry) => [entry.number, entry.label]), [[1, named("alpha", A)], [2, named("beta", B)]]);
  // A newer session created BEFORE the others is still appended, never inserted.
  const second = mergeSessionRoster(first, [
    session(A, { name: "alpha" }),
    session(B, { name: "beta" }),
    session(C, { createdAt: "2026-09-22T00:00:00.000Z", name: "gamma" }),
  ]);
  assert.deepEqual(sessionRosterEntries(second).map((entry) => [entry.number, entry.label]),
    [[1, named("alpha", A)], [2, named("beta", B)], [3, named("gamma", C)]]);
});

test("roster hides sessions already gone and marks sessions that end, keeping their number", () => {
  const first = mergeSessionRoster([], [
    session(A, { name: "alpha" }),
    session(B, { name: "beta", processState: "terminated", desiredState: "terminated" }),
    session(C, { name: "gamma", agent: "openclaw" }),
    session(D, { name: "delta" }),
  ]);
  assert.deepEqual(sessionRosterEntries(first).map((entry) => entry.label), [named("alpha", A), named("delta", D)]);
  const ended = mergeSessionRoster(first, [
    session(A, { name: "alpha", processState: "exited", rowVersion: 2 }),
    session(D, { name: "delta" }),
  ]);
  assert.deepEqual(sessionRosterEntries(ended).map((entry) => [entry.number, entry.label, entry.ended]),
    [[1, named("alpha", A), true], [2, named("delta", D), false]]);
  // Missing from a successful listing: not attachable any more, same number.
  const missing = mergeSessionRoster(ended, [session(A, { name: "alpha", processState: "exited", rowVersion: 2 })]);
  assert.deepEqual(sessionRosterEntries(missing).map((entry) => [entry.number, entry.ended]), [[1, true], [2, true]]);
  // An ended entry never comes back, even if a later row looks live.
  const stale = mergeSessionRoster(missing, [session(A, { name: "alpha", rowVersion: 3 })]);
  assert.equal(sessionRosterEntries(stale)[0].ended, true);
});

test("roster ignores an older or equal row revision", () => {
  const first = mergeSessionRoster([], [session(A, { name: "new", rowVersion: 5 })]);
  const older = mergeSessionRoster(first, [session(A, { name: "old", rowVersion: 4, processState: "exited" })]);
  assert.deepEqual(sessionRosterEntries(older).map((entry) => [entry.label, entry.ended]), [[named("new", A), false]]);
});

test("D15: a journey session is labelled by its AgentSession id, never by its execution Workspace folder", () => {
  // Measured on installed 0.1.4, 2026-09-28: journey sessions are named after
  // their agent and live in `/workspace/<execution Workspace id>`, and the bar
  // read `d3127234…` and `9fd19a2c…` -- Workspace ids, not sessions.
  const S1 = "f3cd5d5c-b042-4e48-ad91-c2e62d1b9692";
  const S2 = "0b6e2c11-7f00-4a55-9d3e-1c2b3a4d5e6f";
  const entries = sessionRosterEntries(mergeSessionRoster([], [
    session(S1, { cwd: "/workspace/d3127234-1111-4111-8111-111111111111" }),
    session(S2, { cwd: "/workspace/9fd19a2c-2222-4222-8222-222222222222", createdAt: "2026-09-23T00:00:01.000Z" }),
  ]));
  assert.deepEqual(entries.map((entry) => entry.label), ["f3cd5d5c", "0b6e2c11"]);
  assert.ok(entries.every((entry) => !/d3127234|9fd19a2c/u.test(entry.label)), "no folder id in any label");
  // One session alone is named the same way, so `1:Claude f3cd5d5c` matches
  // `cuna agent-sessions list` and the Detached line's `cuna connect` id.
  const single = sessionRosterEntries(mergeSessionRoster([], [session(S1)]));
  assert.deepEqual(single.map((entry) => entry.label), ["f3cd5d5c"]);
});

test("a name equal to the agent is dropped; a real name comes first and the id follows", () => {
  const entries = sessionRosterEntries(mergeSessionRoster([], [session(A, { name: "api" }), session(B)]));
  assert.deepEqual(entries.map((entry) => entry.label), [named("api", A), B.slice(0, 8)]);
});

test("ids sharing their first eight characters are lengthened until they differ", () => {
  const twinA = "abcdef01-1111-4111-8111-111111111111";
  const twinB = "abcdef01-2222-4222-8222-222222222222";
  const entries = sessionRosterEntries(mergeSessionRoster([], [
    session(twinA, { createdAt: "2026-09-23T00:00:01.000Z" }),
    session(twinB, { createdAt: "2026-09-23T00:00:02.000Z" }),
  ]));
  assert.deepEqual(entries.map((entry) => entry.label), ["abcdef01-1111", "abcdef01-2222"]);
});

test("the id survives the display limit when the name is long", () => {
  const long = sessionRosterEntries(mergeSessionRoster([], [
    session(A, { name: `${"x".repeat(40)}A` }),
    session(B, { name: `${"x".repeat(40)}B` }),
  ]));
  assert.notEqual(long[0].label, long[1].label);
  assert.match(long[0].label, / aaaaaaaa$/u);
  assert.match(long[1].label, / bbbbbbbb$/u);
  assert.ok(long.every((entry) => [...entry.label].length <= 40));
});

test("roster labels cannot carry terminal controls", () => {
  const [entry] = sessionRosterEntries(mergeSessionRoster([], [session(A, { name: "bad\u001b[2J\nname" })]));
  assert.equal(entry.label, named("bad [2J name", A));
});

test("a failed refresh keeps the last confirmed roster; a listener hears each change once", async () => {
  let fail = false;
  let sessions = [session(A, { name: "alpha" })];
  const roster = new PollingSessionRoster({
    intervalMs: 60_000,
    list: async () => { if (fail) throw new Error("network"); return sessions; },
  });
  let changes = 0;
  roster.subscribe(() => { changes += 1; });
  try {
    await roster.refresh();
    assert.deepEqual(roster.entries().map((entry) => entry.label), [named("alpha", A)]);
    fail = true;
    await roster.refresh();
    assert.deepEqual(roster.entries().map((entry) => entry.label), [named("alpha", A)], "a failure keeps the roster");
    fail = false;
    await roster.refresh();
    assert.equal(changes, 1, "an unchanged listing is not a change");
    sessions = [session(A, { name: "alpha" }), session(B, { name: "beta" })];
    await roster.refresh();
    assert.equal(changes, 2);
  } finally { roster.stop(); }
});
