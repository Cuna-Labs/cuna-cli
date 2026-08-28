import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, connect } from "node:net";
import { request as httpRequest } from "node:http";
import test from "node:test";

import {
  CallbackRelayError,
  startCallbackRelay,
  startPrivatePortForward,
} from "../dist/local-actions/index.js";

const digest = (value) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end();
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("callback relay rejects duplicate query keys and consumes valid authority before awaiting relay", async () => {
  const port = await unusedPort();
  const relayGate = deferred();
  const seen = [];
  const handle = await startCallbackRelay({
    provider: "codex",
    localHost: "127.0.0.1",
    exactLocalPort: port,
    localPath: "/oauth/callback",
    expectedStateDigest: digest("expected-state"),
    expectedNonceDigest: digest("expected-nonce"),
    requestNonce: "expected-nonce",
    deadlineMs: Date.now() + 10_000,
    maxAttempts: 4,
    maxConnections: 3,
    relay: async (callback) => { seen.push(callback); await relayGate.promise; },
  });

  const duplicate = await get(port, "/oauth/callback?code=one&code=two&state=expected-state");
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.headers.location, undefined, "the local relay never redirects");
  assert.equal(seen.length, 0);

  const accepted = await get(port, "/oauth/callback?code=opaque-code&state=expected-state");
  assert.equal(accepted.status, 202);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { provider: "codex", code: "opaque-code", state: "expected-state" });

  const repeated = await get(port, "/oauth/callback?code=second&state=expected-state").catch(() => undefined);
  if (repeated !== undefined) assert.equal(repeated.status, 410);
  assert.equal(seen.length, 1, "the consumed one-shot token cannot relay twice");
  let completed = false;
  handle.completion.then(() => { completed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false, "opening the callback is not relay success");
  relayGate.resolve();
  assert.equal((await handle.completion).outcome, "relayed");
});

test("callback relay binds the exact port and fails closed after its attempt budget", async () => {
  const port = await unusedPort();
  const handle = await startCallbackRelay({
    provider: "codex",
    localHost: "127.0.0.1",
    exactLocalPort: port,
    localPath: "/oauth/callback",
    expectedStateDigest: digest("state"),
    expectedNonceDigest: digest("nonce"),
    requestNonce: "nonce",
    deadlineMs: Date.now() + 10_000,
    maxAttempts: 1,
    maxConnections: 2,
    relay: async () => { throw new Error("must not run"); },
  });
  const completionRejection = assert.rejects(
    handle.completion,
    (error) => error instanceof CallbackRelayError && error.code === "attempt_limit",
  );
  assert.equal(handle.port, port);
  assert.equal((await get(port, "/wrong?code=x&state=state")).status, 400);
  assert.equal((await get(port, "/wrong?code=x&state=state")).status, 429);
  await completionRejection;
});

test("callback nonce is envelope authority, never a browser query parameter", async () => {
  const port = await unusedPort();
  const common = {
    provider: "codex",
    localHost: "127.0.0.1",
    exactLocalPort: port,
    localPath: "/oauth/callback",
    expectedStateDigest: digest("state"),
    expectedNonceDigest: digest("envelope-nonce"),
    deadlineMs: Date.now() + 10_000,
    maxAttempts: 2,
    maxConnections: 2,
  };
  await assert.rejects(
    startCallbackRelay({ ...common, requestNonce: "wrong", relay: async () => {} }),
    /approved envelope digest/u,
  );
  const seen = [];
  const handle = await startCallbackRelay({
    ...common,
    requestNonce: "envelope-nonce",
    relay: async (callback) => { seen.push(callback); },
  });
  const response = await get(port, "/oauth/callback?state=state&error=access_denied");
  assert.equal(response.status, 202);
  await handle.completion;
  assert.deepEqual(seen, [{ provider: "codex", state: "state", error: "access_denied" }]);
});

test("private forward connects only to the predeclared loopback target and cleans up", async () => {
  const upstream = createServer((socket) => socket.pipe(socket));
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const targets = [];
  const forward = await startPrivatePortForward({
    localHost: "127.0.0.1",
    requestedLocalPort: 0,
    remoteHost: "127.0.0.1",
    remotePort: upstreamAddress.port,
    deadlineMs: Date.now() + 10_000,
    maximumConnections: 2,
    maximumBytes: 1_024,
    connector: { connect(target) { targets.push(target); return connect(target); } },
  });

  const client = connect({ host: forward.localHost, port: forward.localPort });
  const echoed = new Promise((resolve, reject) => {
    client.once("data", resolve);
    client.once("error", reject);
  });
  client.write(Buffer.from("byte-exact", "utf8"));
  assert.equal((await echoed).toString("utf8"), "byte-exact");
  assert.deepEqual(targets, [{ host: "127.0.0.1", port: upstreamAddress.port }]);
  assert.equal(forward.transferredBytes(), Buffer.byteLength("byte-exact") * 2);
  client.destroy();
  await forward.close();
  await forward.closed;
  await assert.rejects(new Promise((resolve, reject) => {
    const denied = connect({ host: forward.localHost, port: forward.localPort });
    denied.once("connect", resolve);
    denied.once("error", reject);
  }));
  await new Promise((resolve) => upstream.close(resolve));
});

test("private forward rejects DNS names before invoking a connector and enforces byte budget", async () => {
  let connectorCalls = 0;
  await assert.rejects(
    startPrivatePortForward({
      localHost: "127.0.0.1",
      requestedLocalPort: 0,
      remoteHost: "localhost",
      remotePort: 9,
      deadlineMs: Date.now() + 10_000,
      maximumConnections: 1,
      maximumBytes: 10,
      connector: { connect() { connectorCalls += 1; throw new Error("unreachable"); } },
    }),
    /literal loopback/u,
  );
  assert.equal(connectorCalls, 0);

  const upstream = createServer((socket) => socket.pipe(socket));
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const forward = await startPrivatePortForward({
    localHost: "127.0.0.1",
    requestedLocalPort: 0,
    remoteHost: "127.0.0.1",
    remotePort: upstreamAddress.port,
    deadlineMs: Date.now() + 10_000,
    maximumConnections: 1,
    maximumBytes: 3,
  });
  const client = connect({ host: forward.localHost, port: forward.localPort });
  await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("error", reject); });
  client.write("four");
  await forward.closed;
  assert.ok(forward.transferredBytes() > 3);
  if (!client.destroyed) await new Promise((resolve) => client.once("close", resolve));
  assert.equal(client.destroyed, true);
  await new Promise((resolve) => upstream.close(resolve));
});

test("abort closes a private listener and every active stream", async () => {
  const upstreamSockets = new Set();
  const upstream = createServer((socket) => {
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const controller = new AbortController();
  const forward = await startPrivatePortForward({
    localHost: "127.0.0.1",
    requestedLocalPort: 0,
    remoteHost: "127.0.0.1",
    remotePort: upstreamAddress.port,
    deadlineMs: Date.now() + 10_000,
    maximumConnections: 1,
    maximumBytes: 1_024,
    signal: controller.signal,
  });
  const client = connect({ host: forward.localHost, port: forward.localPort });
  await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("error", reject); });
  controller.abort();
  await forward.closed;
  if (!client.destroyed) await new Promise((resolve) => client.once("close", resolve));
  assert.equal(client.destroyed, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(upstreamSockets.size, 0);
  await new Promise((resolve) => upstream.close(resolve));
});
