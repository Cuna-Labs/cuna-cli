import assert from "node:assert/strict";
import test from "node:test";

import { HostMouseParser } from "../dist/terminal/host-mouse.js";
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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

test("a name equal to the agent is dropped; equal labels are told apart by folder, start time, then id", () => {
  const single = sessionRosterEntries(mergeSessionRoster([], [session(A)]));
  assert.deepEqual(single.map((entry) => entry.label), [""], "one default-named session is just `1:Claude`");
  const byFolder = sessionRosterEntries(mergeSessionRoster([], [
    session(A, { cwd: "/workspace/projA" }),
    session(B, { cwd: "/workspace/projB/" }),
  ]));
  assert.deepEqual(byFolder.map((entry) => entry.label), ["projA", "projB"]);
  // Published sessions run in /workspace/workspaces/<uuid>: a UUID is not a name.
  const early = "2026-09-23T02:47:42.000Z";
  const late = "2026-09-23T03:10:34.000Z";
  const hhmm = (iso) => { const date = new Date(iso); return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; };
  const byTime = sessionRosterEntries(mergeSessionRoster([], [
    session(A, { cwd: "/workspace/workspaces/2a695c79-4ee7-4764-925f-577bae1f068c", createdAt: early }),
    session(B, { cwd: "/workspace/workspaces/da064bc9-8fc9-47af-a0c7-84cbd5d214c2", createdAt: late }),
  ]));
  assert.deepEqual(byTime.map((entry) => entry.label), [hhmm(early), hhmm(late)]);
  const byId = sessionRosterEntries(mergeSessionRoster([], [
    session(A, { cwd: "/workspace/workspaces/2a695c79-4ee7-4764-925f-577bae1f068c", createdAt: early }),
    session(B, { cwd: "/workspace/workspaces/da064bc9-8fc9-47af-a0c7-84cbd5d214c2", createdAt: early }),
  ]));
  assert.deepEqual(byId.map((entry) => entry.label), [`${hhmm(early)} aaaa`, `${hhmm(early)} bbbb`]);
  const named = sessionRosterEntries(mergeSessionRoster([], [session(A, { name: "api" }), session(B)]));
  assert.deepEqual(named.map((entry) => entry.label), ["api", ""], "unique labels stay short");
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

test("SGR mouse reports are taken out of host input in order, across chunk splits", () => {
  const parser = new HostMouseParser();
  const segments = [
    ...parser.push(encoder.encode("ab\u001b[<0;12;1")),
    ...parser.push(encoder.encode("Mcd\u001b[<0;12;1m\u001b[<65;3;9M")),
  ];
  assert.deepEqual(segments.map((segment) => segment.kind === "bytes"
    ? decoder.decode(segment.bytes)
    : `${segment.event.kind}:${segment.event.button}@${segment.event.column},${segment.event.row}`),
  ["ab", "press:0@12,1", "cd", "release:0@12,1", "wheel_down:1@3,9"]);
});

test("Escape and arrow keys are never held back, and malformed reports stay input", () => {
  const parser = new HostMouseParser();
  assert.deepEqual(parser.push(Uint8Array.of(0x1b)).map((segment) => segment.kind), ["bytes"]);
  assert.equal(decoder.decode(parser.push(encoder.encode("\u001b[A"))[0].bytes), "\u001b[A");
  assert.equal(decoder.decode(parser.push(encoder.encode("\u001b[<x"))[0].bytes), "\u001b[<x");
  assert.equal(decoder.decode(parser.push(encoder.encode("\u001b[<0;1;1;1M"))[0].bytes), "\u001b[<0;1;1;1M");
});

test("a bracketed paste containing a mouse-like sequence is passed through as paste", () => {
  const parser = new HostMouseParser();
  const pasted = "\u001b[200~text \u001b[<0;5;1M more\u001b[201~";
  const segments = [...parser.push(encoder.encode(pasted)), ...parser.push(encoder.encode("\u001b[<0;5;1M"))];
  assert.equal(segments[0].kind, "bytes");
  assert.equal(decoder.decode(segments[0].bytes), pasted);
  assert.equal(segments[1].kind, "mouse", "after the paste ends, reports are mouse again");
});
