import assert from "node:assert/strict";

const REQUESTS = 3;
const MAX_QUEUE = 3;
const MAX_RESOURCES = 2;
const terminal = new Set(["succeeded", "failed", "denied", "expired", "cancelled"]);

function request(state = "detected") {
  return { state, approved: false, live: true, committed: false, resource: false, resultCount: 0, cached: false, acked: false, outcomeUnknown: false };
}

function initial() {
  return { requests: Array.from({ length: REQUESTS }, () => request()), reconnects: 0 };
}

function clone(value) {
  return structuredClone(value);
}

function key(value) {
  return JSON.stringify(value);
}

function finish(source, index, state, outcomeUnknown = false) {
  const next = clone(source);
  const item = next.requests[index];
  item.state = state;
  item.resource = false;
  item.resultCount += 1;
  item.cached = true;
  item.outcomeUnknown = outcomeUnknown;
  return next;
}

function successors(source) {
  const out = [];
  const prompting = source.requests.filter((item) => item.state === "pending_user").length;
  const occupied = source.requests.filter((item) => item.resource).length;
  for (let index = 0; index < source.requests.length; index += 1) {
    const item = source.requests[index];
    if (item.state === "detected") {
      const validated = clone(source); validated.requests[index].state = "validated"; out.push(validated);
      out.push(finish(source, index, "failed"));
      out.push(finish(source, index, "cancelled"));
    } else if (item.state === "validated") {
      if (prompting === 0) { const queued = clone(source); queued.requests[index].state = "pending_user"; out.push(queued); }
      out.push(finish(source, index, "denied"));
      out.push(finish(source, index, "expired"));
      out.push(finish(source, index, "cancelled"));
    } else if (item.state === "pending_user") {
      if (occupied < MAX_RESOURCES) {
        const approved = clone(source); approved.requests[index].approved = true; approved.requests[index].state = "executing"; approved.requests[index].resource = true; out.push(approved);
      }
      out.push(finish(source, index, "denied"));
      out.push(finish(source, index, "expired"));
      out.push(finish(source, index, "cancelled"));
    } else if (item.state === "executing" && !item.committed) {
      const committed = clone(source); committed.requests[index].committed = true; out.push(committed);
      out.push(finish(source, index, "failed"));
      out.push(finish(source, index, "expired"));
      out.push(finish(source, index, "cancelled"));
    } else if (item.state === "executing" && item.committed) {
      const awaiting = clone(source); awaiting.requests[index].state = "awaiting_remote_completion"; out.push(awaiting);
      out.push(finish(source, index, "succeeded"));
      out.push(finish(source, index, "failed", true));
    } else if (item.state === "awaiting_remote_completion") {
      out.push(finish(source, index, "succeeded"));
      out.push(finish(source, index, "failed"));
      out.push(finish(source, index, "failed", true));
    } else if (terminal.has(item.state) && item.cached && !item.acked) {
      const acked = clone(source); acked.requests[index].acked = true; acked.requests[index].cached = false; out.push(acked);
    }
    if (!terminal.has(item.state) && item.live) {
      const fenced = clone(source);
      fenced.requests[index].live = false;
      out.push(item.committed ? finish(fenced, index, "failed", true) : finish(fenced, index, "cancelled"));
    }
  }
  if (source.reconnects < 2) {
    const reconnected = clone(source);
    reconnected.reconnects += 1;
    out.push(reconnected);
  }
  return out;
}

let counterexamples = 0;

function check(condition, message) {
  if (condition) return;
  counterexamples += 1;
  throw new assert.AssertionError({ message });
}

function verify(state) {
  const prompting = state.requests.filter((item) => item.state === "pending_user").length;
  const resources = state.requests.filter((item) => item.resource).length;
  const queued = state.requests.filter((item) => ["validated", "pending_user"].includes(item.state)).length;
  check(prompting <= 1, "more than one consent prompt");
  check(resources <= MAX_RESOURCES, "resource oversubscription");
  check(queued <= MAX_QUEUE, "queue overflow");
  for (const item of state.requests) {
    check(item.resultCount <= 1, "duplicate terminal result");
    if (item.committed) check(item.approved, "effect without interactive approval");
    if (item.resource) check(["executing", "awaiting_remote_completion"].includes(item.state), "orphan resource");
    if (terminal.has(item.state)) check(item.resource === false, "terminal request owns a resource");
    if (item.committed && terminal.has(item.state)) check(!["cancelled", "expired"].includes(item.state), "committed effect disguised as cancellation/expiry");
    if (item.cached && !item.acked) check(item.resultCount === 1, "cached outcome lacks one result");
  }
}

const queue = [initial()];
const seen = new Map([[key(queue[0]), queue[0]]]);
const edges = new Map();
for (let cursor = 0; cursor < queue.length; cursor += 1) {
  const state = queue[cursor];
  verify(state);
  const nextKeys = [];
  for (const next of successors(state)) {
    verify(next);
    const nextKey = key(next);
    nextKeys.push(nextKey);
    if (!seen.has(nextKey)) { seen.set(nextKey, next); queue.push(next); }
  }
  edges.set(key(state), nextKeys);
}

const canReachAllTerminal = new Set();
for (const [stateKey, state] of seen) {
  if (state.requests.every((item) => terminal.has(item.state))) canReachAllTerminal.add(stateKey);
}
let changed = true;
while (changed) {
  changed = false;
  for (const [stateKey, nextKeys] of edges) {
    if (!canReachAllTerminal.has(stateKey) && nextKeys.some((nextKey) => canReachAllTerminal.has(nextKey))) {
      canReachAllTerminal.add(stateKey); changed = true;
    }
  }
}
check(canReachAllTerminal.size === seen.size, "a reachable state has no path to terminal cleanup");

process.stdout.write(JSON.stringify({
  model: "cuna.local-actions.v1",
  requests: REQUESTS,
  reconnectBound: 2,
  queueBound: MAX_QUEUE,
  resourceBound: MAX_RESOURCES,
  reachableStates: seen.size,
  checkedTransitions: [...edges.values()].reduce((sum, values) => sum + values.length, 0),
  proved: ["bounded_safety", "EF_terminal_reachability"],
  notProved: ["fairness", "AF_liveness", "reconnect_identity", "RTP_retransmission", "queue_overflow_submission"],
  counterexamples,
}) + "\n");
