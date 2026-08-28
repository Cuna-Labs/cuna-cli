import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_ACTION_PROTOCOL_VERSION,
  LocalActionBroker,
  LocalActionExecutor,
  LocalActionExecutorError,
  digestLocalActionArguments,
} from "../dist/local-actions/index.js";

const IDENTITY = Object.freeze({
  userId: "user-1",
  deviceId: "device-1",
  machineId: "machine-1",
  workspaceBindingId: "workspace-1",
  workspaceBindingGeneration: 3,
  agentSessionId: "session-1",
  processEpoch: "epoch-1",
  fencingGeneration: 2,
});

function makeRequest(kind, argumentsValue, overrides = {}) {
  const now = Date.now();
  return Object.freeze({
    version: LOCAL_ACTION_PROTOCOL_VERSION,
    id: overrides.id ?? `request-${kind.replaceAll(".", "-")}`,
    identity: overrides.identity ?? IDENTITY,
    provider: overrides.provider ?? "claude-code",
    kind,
    arguments: Object.freeze(argumentsValue),
    argumentsDigest: digestLocalActionArguments(argumentsValue),
    requestedScope: kind,
    createdAt: now - 10,
    expiresAt: overrides.expiresAt ?? now + 10_000,
    nonce: overrides.nonce ?? `nonce-${kind.replaceAll(".", "-")}`,
  });
}

function harness(request, adapters, overrides = {}) {
  let live = true;
  let completeCalls = 0;
  const broker = new LocalActionBroker({ isIdentityLive: () => live });
  const pending = broker.submit(request);
  assert.equal(pending.state, "pending_user");
  const executing = broker.decide(request.id, true);
  const authority = {
    get: (id) => broker.get(id),
    awaitingRemoteCompletion: (id) => broker.awaitingRemoteCompletion(id),
    complete(...args) { completeCalls += 1; return broker.complete(...args); },
    cancelBinding: (...args) => broker.cancelBinding(...args),
    expire: () => broker.expire(),
  };
  const executor = new LocalActionExecutor({
    authority,
    adapters,
    isIdentityLive: () => live,
    maximumExecutionMs: overrides.maximumExecutionMs ?? 5_000,
  });
  return {
    broker,
    executor,
    executing,
    completeCalls: () => completeCalls,
    setLive(value) { live = value; },
  };
}

test("one approved request dispatches once, revalidates authority, cleans up, and commits exactly one result", async () => {
  const request = makeRequest("auth.result.observe", {});
  let effects = 0;
  let cleanups = 0;
  const adapter = {
    kind: "auth.result.observe",
    async execute(context) {
      effects += 1;
      assert.equal(context.request.id, request.id);
      assert.equal(context.signal.aborted, false);
      assert.ok(context.deadlineMs <= request.expiresAt);
      context.registerCleanup(() => { cleanups += 1; });
      return { status: "succeeded", safeData: { authenticated: true } };
    },
  };
  const subject = harness(request, [adapter]);
  const first = subject.executor.execute(subject.executing);
  const duplicate = subject.executor.execute(subject.executing);
  assert.equal(first, duplicate, "a concurrent duplicate shares the original execution promise");
  const result = await first;
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.safeData, { authenticated: true });
  assert.equal(effects, 1);
  assert.equal(cleanups, 1);
  assert.equal(subject.completeCalls(), 1);
});

test("unregistered kinds fail closed while enabled OpenCode dispatches only its registered adapter", async () => {
  const clipboard = makeRequest("clipboard.write", { text: "hello" });
  const unregistered = harness(clipboard, []);
  const unsupported = await unregistered.executor.execute(unregistered.executing);
  assert.equal(unsupported.status, "failed");
  assert.equal(unsupported.safeReason, "unsupported");

  const request = makeRequest("auth.result.observe", {}, { provider: "opencode", id: "request-opencode", nonce: "nonce-opencode" });
  let effects = 0;
  let snapshot = Object.freeze({
    request,
    state: "executing",
    decision: Object.freeze({
      requestId: request.id,
      decision: "allow_once",
      grantedScope: request.requestedScope,
      policySource: "interactive_user",
      decidedAt: Date.now(),
    }),
  });
  const authority = {
    get: () => snapshot,
    awaitingRemoteCompletion: () => { throw new Error("must not transition"); },
    complete(requestId, identity, status, safeData, safeReason) {
      const result = Object.freeze({
        version: LOCAL_ACTION_PROTOCOL_VERSION, requestId, kind: request.kind, identity, status,
        ...(safeData === undefined ? {} : { safeData }), ...(safeReason === undefined ? {} : { safeReason }),
        completedAt: Date.now(),
      });
      snapshot = Object.freeze({ ...snapshot, state: status, result });
      return snapshot;
    },
    cancelBinding: () => [],
    expire: () => [],
  };
  const executor = new LocalActionExecutor({
    authority,
    isIdentityLive: () => true,
    adapters: [{ kind: "auth.result.observe", async execute() { effects += 1; return { status: "succeeded", safeData: { authenticated: true } }; } }],
  });
  assert.equal((await executor.execute(snapshot)).status, "succeeded");
  assert.equal(effects, 1);
});

test("a pending or forged snapshot never reaches an adapter", async () => {
  const request = makeRequest("auth.result.observe", {});
  let effects = 0;
  const broker = new LocalActionBroker({ isIdentityLive: () => true });
  const pending = broker.submit(request);
  const executor = new LocalActionExecutor({
    authority: broker,
    isIdentityLive: () => true,
    adapters: [{ kind: "auth.result.observe", async execute() { effects += 1; return { status: "succeeded" }; } }],
  });
  assert.throws(
    () => executor.execute(pending),
    (error) => error instanceof LocalActionExecutorError && error.code === "not_executing",
  );
  assert.equal(effects, 0);
});

test("cancel aborts in-flight work, awaits cleanup, and emits cancelled exactly once", async () => {
  const request = makeRequest("auth.result.observe", {});
  let cleanupCalls = 0;
  const adapter = {
    kind: "auth.result.observe",
    execute(context) {
      context.registerCleanup(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        cleanupCalls += 1;
      });
      return new Promise((resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
    },
  };
  const subject = harness(request, [adapter]);
  const resultPromise = subject.executor.execute(subject.executing);
  await new Promise((resolve) => setImmediate(resolve));
  await subject.executor.cancel(request.id);
  const result = await resultPromise;
  assert.equal(result.status, "cancelled");
  assert.equal(result.safeReason, "cancelled_by_foreground");
  assert.equal(cleanupCalls, 1);
  assert.equal(subject.completeCalls(), 1);
});

test("cancel before the dispatch microtask prevents every adapter effect", async () => {
  const request = makeRequest("auth.result.observe", {});
  let effects = 0;
  const subject = harness(request, [{
    kind: "auth.result.observe",
    async execute() { effects += 1; return { status: "succeeded", safeData: { authenticated: true } }; },
  }]);
  const resultPromise = subject.executor.execute(subject.executing);
  await subject.executor.cancel(request.id);
  assert.equal((await resultPromise).status, "cancelled");
  assert.equal(effects, 0);
  assert.equal(subject.completeCalls(), 1);
});

test("liveness loss after adapter execution cancels the fenced binding instead of committing success", async () => {
  const request = makeRequest("auth.result.observe", {});
  let subject;
  const adapter = {
    kind: "auth.result.observe",
    async execute() {
      subject.setLive(false);
      return { status: "succeeded", safeData: { authenticated: true } };
    },
  };
  subject = harness(request, [adapter]);
  const result = await subject.executor.execute(subject.executing);
  assert.equal(result.status, "cancelled");
  assert.equal(result.safeReason, "stale_identity");
  assert.equal(subject.completeCalls(), 0, "stale identity never reaches normal completion authority");
});

test("adapter can mark awaiting-remote exactly once before its final result", async () => {
  const request = makeRequest("browser.open", { url: "https://platform.claude.com/oauth/authorize?code=true&state=opaque" });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const adapter = {
    kind: "browser.open",
    async execute(context) {
      context.markAwaitingRemoteCompletion();
      context.markAwaitingRemoteCompletion();
      await gate;
      return { status: "succeeded", safeData: { awaitingProvider: true } };
    },
  };
  const subject = harness(request, [adapter]);
  const resultPromise = subject.executor.execute(subject.executing);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subject.broker.get(request.id).state, "awaiting_remote_completion");
  release();
  assert.equal((await resultPromise).status, "succeeded");
  assert.equal(subject.completeCalls(), 1);
});

test("execution timeout aborts the adapter, cleans up, and emits one safe failure", async () => {
  const request = makeRequest("auth.result.observe", {});
  let cleaned = false;
  const adapter = {
    kind: "auth.result.observe",
    execute(context) {
      context.registerCleanup(() => { cleaned = true; });
      return new Promise((resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
    },
  };
  const subject = harness(request, [adapter], { maximumExecutionMs: 20 });
  const result = await subject.executor.execute(subject.executing);
  assert.equal(result.status, "failed");
  assert.equal(result.safeReason, "execution_timeout");
  assert.equal(cleaned, true);
  assert.equal(subject.completeCalls(), 1);
});

test("request-lifetime cleanup survives the result but cancel cannot emit a second result", async () => {
  const request = makeRequest("port.forward", {
    remoteHost: "127.0.0.1", remotePort: 4310, requestedLocalPort: 0, purpose: "preview", deadlineMs: Date.now() + 5_000,
  });
  let cleaned = 0;
  const adapter = {
    kind: "port.forward",
    async execute(context) {
      context.registerCleanup(() => { cleaned += 1; });
      return {
        status: "succeeded",
        safeData: { localHost: "127.0.0.1", localPort: 54321, expiresAt: Date.now() + 5_000, streamId: "stream-1" },
        cleanupLifetime: "request",
      };
    },
  };
  const subject = harness(request, [adapter]);
  assert.equal((await subject.executor.execute(subject.executing)).status, "succeeded");
  assert.equal(cleaned, 0);
  await subject.executor.cancel(request.id);
  assert.equal(cleaned, 1);
  assert.equal(subject.completeCalls(), 1);
  assert.equal(subject.broker.get(request.id).result.status, "succeeded");
});

test("malformed adapter output becomes one safe failure instead of stranding executing state", async () => {
  const request = makeRequest("auth.result.observe", {});
  const subject = harness(request, [{
    kind: "auth.result.observe",
    async execute() { return { status: "succeeded", safeData: { secret: "must-not-escape" }, unexpected: true }; },
  }]);
  const result = await subject.executor.execute(subject.executing);
  assert.equal(result.status, "failed");
  assert.equal(result.safeReason, "adapter_failed");
  assert.equal(result.safeData, undefined);
  assert.equal(subject.completeCalls(), 1);
});

test("duplicate adapter registration is rejected without invoking either adapter", () => {
  let effects = 0;
  const adapter = { kind: "auth.result.observe", async execute() { effects += 1; return { status: "failed" }; } };
  assert.throws(
    () => new LocalActionExecutor({ authority: {}, isIdentityLive: () => true, adapters: [adapter, adapter] }),
    (error) => error instanceof LocalActionExecutorError && error.code === "invalid_registration",
  );
  assert.equal(effects, 0);
});
