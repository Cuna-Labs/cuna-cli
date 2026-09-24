import assert from "node:assert/strict";
import test from "node:test";

import { PollingSessionRoster, mergeSessionRoster, sessionRosterEntries } from "../dist/terminal/session-roster.js";

const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const C = "cccccccc-3333-4333-8333-333333333333";
const D = "dddddddd-4444-4444-8444-444444444444";

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
  assert.deepEqual(sessionRosterEntries(first).map((entry) => [entry.number, entry.label]), [[1, "alpha"], [2, "beta"]]);
  // A newer session created BEFORE the others is still appended, never inserted.
  const second = mergeSessionRoster(first, [
    session(A, { name: "alpha" }),
    session(B, { name: "beta" }),
    session(C, { createdAt: "2026-09-22T00:00:00.000Z", name: "gamma" }),
  ]);
  assert.deepEqual(sessionRosterEntries(second).map((entry) => [entry.number, entry.label]), [[1, "alpha"], [2, "beta"], [3, "gamma"]]);
});

test("roster hides sessions already gone and marks sessions that end, keeping their number", () => {
  const first = mergeSessionRoster([], [
    session(A, { name: "alpha" }),
    session(B, { name: "beta", processState: "terminated", desiredState: "terminated" }),
    session(C, { name: "gamma", agent: "openclaw" }),
    session(D, { name: "delta" }),
  ]);
  assert.deepEqual(sessionRosterEntries(first).map((entry) => entry.label), ["alpha", "delta"]);
  const ended = mergeSessionRoster(first, [
    session(A, { name: "alpha", processState: "exited", rowVersion: 2 }),
    session(D, { name: "delta" }),
  ]);
  assert.deepEqual(sessionRosterEntries(ended).map((entry) => [entry.number, entry.label, entry.ended]),
    [[1, "alpha", true], [2, "delta", false]]);
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
  assert.deepEqual(sessionRosterEntries(older).map((entry) => [entry.label, entry.ended]), [["new", false]]);
});

test("a name equal to the agent is dropped; equal labels use the last folder segment, then four id characters", () => {
  const single = sessionRosterEntries(mergeSessionRoster([], [session(A)]));
  assert.deepEqual(single.map((entry) => entry.label), [""], "one default-named session is just `1:Claude`");
  const byFolder = sessionRosterEntries(mergeSessionRoster([], [
    session(A, { cwd: "/workspace/projA" }),
    session(B, { cwd: "/workspace/projB/" }),
  ]));
  assert.deepEqual(byFolder.map((entry) => entry.label), ["projA", "projB"]);
  // Even a UUID-shaped working folder is the required suffix, not a local timestamp.
  const byUuidFolder = sessionRosterEntries(mergeSessionRoster([], [
    session(A, { cwd: "/workspace/workspaces/2a695c79-4ee7-4764-925f-577bae1f068c" }),
    session(B, { cwd: "/workspace/workspaces/da064bc9-8fc9-47af-a0c7-84cbd5d214c2" }),
  ]));
  assert.deepEqual(byUuidFolder.map((entry) => entry.label), [
    "2a695c79-4ee7-4764-925f-577bae1f068c", "da064bc9-8fc9-47af-a0c7-84cbd5d214c2",
  ]);
  const byId = sessionRosterEntries(mergeSessionRoster([], [
    session(A, { cwd: "/workspace/same", createdAt: "2026-09-23T02:47:42.000Z" }),
    session(B, { cwd: "/workspace/same", createdAt: "2026-09-23T03:10:34.000Z" }),
  ]));
  assert.deepEqual(byId.map((entry) => entry.label), ["aaaa", "bbbb"]);
  const named = sessionRosterEntries(mergeSessionRoster([], [session(A, { name: "api" }), session(B)]));
  assert.deepEqual(named.map((entry) => entry.label), ["api", ""], "unique labels stay short");
});

test("visible labels stay distinct when long names or folder suffixes exceed the display limit", () => {
  const sameVisiblePrefix = "x".repeat(40);
  const longNames = sessionRosterEntries(mergeSessionRoster([], [
    session(A, { name: `${sameVisiblePrefix}A`, cwd: "/workspace/projA" }),
    session(B, { name: `${sameVisiblePrefix}B`, cwd: "/workspace/projB" }),
  ]));
  assert.notEqual(longNames[0].label, longNames[1].label);
  assert.match(longNames[0].label, /projA$/u);
  assert.match(longNames[1].label, /projB$/u);
  assert.ok(longNames.every((entry) => [...entry.label].length <= 40));
  const sameFolder = sessionRosterEntries(mergeSessionRoster([], [
    session(A, { name: `${sameVisiblePrefix}A`, cwd: "/workspace/same" }),
    session(B, { name: `${sameVisiblePrefix}B`, cwd: "/workspace/same" }),
  ]));
  assert.match(sameFolder[0].label, /aaaa$/u);
  assert.match(sameFolder[1].label, /bbbb$/u);
  assert.notEqual(sameFolder[0].label, sameFolder[1].label);
});

test("roster labels cannot carry terminal controls", () => {
  const [entry] = sessionRosterEntries(mergeSessionRoster([], [session(A, { name: "bad\u001b[2J\nname" })]));
  assert.equal(entry.label, "bad [2J name");
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
    assert.deepEqual(roster.entries().map((entry) => entry.label), ["alpha"]);
    fail = true;
    await roster.refresh();
    assert.deepEqual(roster.entries().map((entry) => entry.label), ["alpha"], "a failure keeps the roster");
    fail = false;
    await roster.refresh();
    assert.equal(changes, 1, "an unchanged listing is not a change");
    sessions = [session(A, { name: "alpha" }), session(B, { name: "beta" })];
    await roster.refresh();
    assert.equal(changes, 2);
  } finally { roster.stop(); }
});
