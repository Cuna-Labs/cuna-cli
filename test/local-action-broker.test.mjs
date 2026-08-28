import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_ACTION_PROTOCOL_VERSION,
  MAX_LOCAL_ACTION_TTL_MS,
  LocalActionBroker,
  LocalActionBrokerError,
  LocalActionPolicyEvaluator,
  digestLocalActionArguments,
  parseLocalActionDevicePolicy,
} from "../dist/local-actions/index.js";

const identity = Object.freeze({
  userId: "user-1",
  deviceId: "device-1",
  machineId: "machine-1",
  workspaceBindingId: "workspace-1",
  workspaceBindingGeneration: 2,
  agentSessionId: "session-1",
  processEpoch: "epoch-1",
  fencingGeneration: 3,
});

function request(overrides = {}) {
  const argumentsValue = overrides.arguments ?? { url: "https://platform.claude.com/oauth/authorize" };
  return {
    version: LOCAL_ACTION_PROTOCOL_VERSION,
    id: "request-1",
    identity,
    provider: "claude-code",
    kind: "browser.open",
    arguments: argumentsValue,
    argumentsDigest: digestLocalActionArguments(argumentsValue),
    requestedScope: "provider-auth",
    createdAt: 1_000,
    expiresAt: 61_000,
    nonce: "nonce-1",
    ...overrides,
  };
}

function broker(options = {}) {
  return new LocalActionBroker({ clock: () => 2_000, isIdentityLive: () => true, ...options });
}

test("an effect cannot succeed before explicit consent", () => {
  const subject = broker();
  const pending = subject.submit(request());
  assert.equal(pending.state, "pending_user");
  assert.throws(
    () => subject.complete(pending.request.id, identity, "succeeded"),
    (error) => error instanceof LocalActionBrokerError && error.code === "illegal_transition",
  );
  assert.equal(subject.decide(pending.request.id, true).state, "executing");
  assert.equal(subject.awaitingRemoteCompletion(pending.request.id).state, "awaiting_remote_completion");
  assert.equal(subject.complete(pending.request.id, identity, "succeeded", { awaitingProvider: true }).state, "succeeded");
});

test("result schemas reject local paths and credential-shaped output", () => {
  const subject = broker();
  const pending = subject.submit(request());
  subject.decide(pending.request.id, true);
  assert.throws(
    () => subject.complete(pending.request.id, identity, "succeeded", { path: "C:\\Users\\angel\\secret", authorizationCode: "secret" }),
    (error) => error instanceof LocalActionBrokerError && error.code === "invalid_result",
  );
});

test("exact duplicate delivery is idempotent while conflicting reuse is rejected", () => {
  const subject = broker();
  const original = request();
  assert.equal(subject.submit(original), subject.submit(structuredClone(original)));
  assert.throws(
    () => subject.submit(request({ arguments: { url: "https://claude.com/oauth/authorize" }, argumentsDigest: digestLocalActionArguments({ url: "https://claude.com/oauth/authorize" }) })),
    (error) => error instanceof LocalActionBrokerError && error.code === "duplicate_request",
  );
});

test("disabled OpenCode is rejected before it can enter the queue", () => {
  const subject = broker();
  assert.throws(
    () => subject.submit(request({ provider: "opencode" })),
    (error) => error instanceof LocalActionBrokerError && error.code === "provider_action_unavailable",
  );
  assert.equal(subject.current(), undefined);
});

test("closed schemas reject unknown properties and unsafe local targets", () => {
  const subject = broker();
  const browserArgs = { url: "https://platform.claude.com/oauth/authorize", command: "calc.exe" };
  assert.throws(
    () => subject.submit(request({ arguments: browserArgs, argumentsDigest: digestLocalActionArguments(browserArgs) })),
    (error) => error instanceof LocalActionBrokerError && error.code === "invalid_request",
  );
  const serviceArgs = { serviceId: "preview", method: "GET", path: "https://example.com/" };
  assert.throws(
    () => subject.submit(request({ id: "request-service", nonce: "nonce-service", kind: "local_service.request", arguments: serviceArgs, argumentsDigest: digestLocalActionArguments(serviceArgs) })),
    (error) => error instanceof LocalActionBrokerError && error.code === "invalid_request",
  );
});

test("validated arguments are copied and deeply frozen", () => {
  const mutable = {
    purpose: "attachment",
    multiple: false,
    accept: [{ mediaType: "text/plain" }],
    maximumFiles: 1,
    maximumTotalBytes: 1_024,
  };
  const subject = broker();
  const accepted = subject.submit(request({ kind: "file.select", arguments: mutable, argumentsDigest: digestLocalActionArguments(mutable) }));
  mutable.accept[0].mediaType = "application/x-mutated";
  assert.equal(accepted.request.arguments.accept[0].mediaType, "text/plain");
  assert.equal(Object.isFrozen(accepted.request.arguments.accept), true);
  assert.equal(Object.isFrozen(accepted.request.arguments.accept[0]), true);
});

test("deny dominates broader allow rules", () => {
  const policy = new LocalActionPolicyEvaluator({
    localDevicePolicy: [
      { kind: "browser.open", decision: "allow_once" },
      { kind: "browser.open", providers: ["claude-code"], decision: "deny" },
    ],
  });
  assert.equal(broker({ policy }).submit(request()).state, "denied");
});

test("persisted allow-once cannot bypass a fresh interactive decision", () => {
  const policy = new LocalActionPolicyEvaluator({
    localDevicePolicy: [{ kind: "browser.open", decision: "allow_once" }],
  });
  assert.equal(broker({ policy }).submit(request()).state, "pending_user");
});

test("even an in-memory scoped preference is not a grant for another request", () => {
  const policy = new LocalActionPolicyEvaluator({
    localDevicePolicy: [{ kind: "browser.open", decision: "allow_scoped", userApproved: true }],
  });
  assert.equal(broker({ policy }).submit(request()).state, "pending_user");
});

test("local policy storage is closed, bounded in shape, and cannot persist allow-once", () => {
  assert.throws(
    () => parseLocalActionDevicePolicy(JSON.stringify({ version: 1, rules: [{ kind: "browser.open", decision: "allow_once" }] })),
    /persist allow_once/u,
  );
  assert.throws(
    () => parseLocalActionDevicePolicy(JSON.stringify({ version: 1, rules: [{ kind: "browser.open", decision: "allow_scoped", userApproved: true }] })),
    /malformed|grant/u,
  );
  const parsed = parseLocalActionDevicePolicy(JSON.stringify({ version: 1, rules: [{ kind: "browser.open", decision: "ask" }] }));
  assert.equal(parsed.localDevicePolicy[0].decision, "ask");
  assert.equal(Object.isFrozen(parsed.localDevicePolicy), true);
});

test("identity authority is rechecked at approval and completion", () => {
  let live = true;
  const subject = broker({ isIdentityLive: () => live });
  const pending = subject.submit(request());
  live = false;
  assert.throws(
    () => subject.decide(pending.request.id, true),
    (error) => error instanceof LocalActionBrokerError && error.code === "stale_identity",
  );
});

test("interactive scope cannot be widened", () => {
  const subject = broker();
  const pending = subject.submit(request());
  assert.throws(
    () => subject.decide(pending.request.id, true, "all-local-actions"),
    (error) => error instanceof LocalActionBrokerError && error.code === "scope_widening",
  );
});

test("observer failures cannot roll back or orphan admitted broker state", () => {
  const observed = [];
  const subject = broker({
    onChange: (snapshot) => { observed.push(snapshot.state); throw new Error("renderer failed"); },
  });
  assert.equal(subject.submit(request()).state, "pending_user");
  assert.deepEqual(observed, ["validated", "pending_user"]);
});

test("nonce replay under another request id is rejected", () => {
  const subject = broker();
  subject.submit(request());
  assert.throws(
    () => subject.submit(request({ id: "request-2" })),
    (error) => error instanceof LocalActionBrokerError && error.code === "replayed_nonce",
  );
});

test("only the visible FIFO consent card can be decided", () => {
  const subject = broker();
  subject.submit(request());
  const second = subject.submit(request({ id: "request-2", nonce: "nonce-2" }));
  assert.equal(second.state, "validated", "non-head work is queued without becoming a second consent card");
  assert.throws(
    () => subject.decide("request-2", true),
    (error) => error instanceof LocalActionBrokerError && error.code === "illegal_transition",
  );
});

test("finishing the head promotes the next consent card without polling current", () => {
  const observed = [];
  const subject = broker({ onChange: (snapshot) => observed.push([snapshot.request.id, snapshot.state]) });
  subject.submit(request());
  subject.submit(request({ id: "request-2", nonce: "nonce-2" }));
  subject.decide("request-1", false);
  assert.deepEqual(observed.slice(-2), [
    ["request-1", "denied"],
    ["request-2", "pending_user"],
  ]);
  assert.equal(subject.get("request-2").state, "pending_user");
});

test("an evicted result cannot be replayed while its nonce remains live", () => {
  const subject = broker();
  for (let index = 0; index < 129; index += 1) {
    const item = request({ id: `request-${index}`, nonce: `nonce-${index}` });
    subject.submit(item);
    subject.decide(item.id, true);
    subject.complete(item.id, identity, "succeeded", { awaitingProvider: true });
  }
  assert.throws(
    () => subject.submit(request({ id: "request-0", nonce: "nonce-0" })),
    (error) => error instanceof LocalActionBrokerError && error.code === "replayed_nonce",
  );
});

test("new epoch or fencing generation cancels outstanding work for the same session", () => {
  const subject = broker();
  subject.submit(request());
  const current = { ...identity, processEpoch: "epoch-2", fencingGeneration: 4 };
  const cancelled = subject.cancelStaleForIdentity(current);
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].state, "cancelled");
});

test("TTL and workspace identity pairs are bounded", () => {
  const subject = broker();
  assert.throws(
    () => subject.submit(request({ expiresAt: 1_000 + MAX_LOCAL_ACTION_TTL_MS + 1 })),
    (error) => error instanceof LocalActionBrokerError && error.code === "invalid_request",
  );
  assert.throws(
    () => subject.submit(request({ identity: { ...identity, workspaceBindingGeneration: null } })),
    (error) => error instanceof LocalActionBrokerError && error.code === "invalid_request",
  );
  assert.throws(
    () => subject.submit(request({ createdAt: 9_000_000_000_000, expiresAt: 9_000_000_100_000 })),
    (error) => error instanceof LocalActionBrokerError && error.code === "invalid_request",
  );
});

test("workspace actions fail closed without authentic binding evidence", () => {
  const args = {
    remoteArtifactId: "artifact-1",
    expectedSha256: `sha256:${"a".repeat(64)}`,
    suggestedName: "result.txt",
    maximumBytes: 1_024,
  };
  const subject = broker();
  assert.throws(
    () => subject.submit(request({
      kind: "artifact.save",
      identity: { ...identity, workspaceBindingId: null, workspaceBindingGeneration: null },
      arguments: args,
      argumentsDigest: digestLocalActionArguments(args),
    })),
    (error) => error instanceof LocalActionBrokerError && error.code === "invalid_request",
  );
});

test("unknown envelope properties and expired transitions fail closed", () => {
  const subject = broker();
  assert.throws(
    () => subject.submit({ ...request(), unexpected: true }),
    (error) => error instanceof LocalActionBrokerError && error.code === "invalid_request",
  );
  let now = 2_000;
  const expiring = new LocalActionBroker({ clock: () => now, isIdentityLive: () => true });
  const pending = expiring.submit(request({ expiresAt: 3_000 }));
  expiring.decide(pending.request.id, true);
  now = 3_000;
  assert.equal(expiring.awaitingRemoteCompletion(pending.request.id).state, "expired");
});
