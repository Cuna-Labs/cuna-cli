import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createPkceAuthorization, startLoopbackCallback } from "../dist/index.js";

test("PKCE material is independent, bounded, and S256-verifiable", () => {
  let marker = 0;
  const material = createPkceAuthorization((size) => {
    marker += 1;
    return Uint8Array.from({ length: size }, (_, index) => (index + marker) % 256);
  });
  assert.notEqual(material.verifier, material.state);
  assert.equal(material.challengeMethod, "S256");
  assert.equal(material.challenge, createHash("sha256").update(material.verifier, "ascii").digest("base64url"));
  assert.match(material.verifier, /^[A-Za-z0-9_-]{43,128}$/u);
  assert.match(material.state, /^[A-Za-z0-9_-]{43,}$/u);
});

test("loopback callback binds a numeric ephemeral address and accepts one matching response", async () => {
  const state = "s".repeat(43);
  const listener = await startLoopbackCallback({ expectedState: state, timeoutMs: 1_000 });
  assert.match(listener.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/u);
  const response = await fetch(`${listener.redirectUri}?code=opaque-code&state=${state}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await listener.completion, { code: "opaque-code" });
  await assert.rejects(fetch(`${listener.redirectUri}?code=replay&state=${state}`));
});

test("wrong state is rejected and closes the listener without retaining a code", async () => {
  const listener = await startLoopbackCallback({ expectedState: "a".repeat(43), timeoutMs: 1_000 });
  const completion = listener.completion.catch((error) => error);
  const response = await fetch(`${listener.redirectUri}?code=secret-code&state=${"b".repeat(43)}`);
  assert.equal(response.status, 400);
  const error = await completion;
  assert.equal(error.code, "runa.auth.state_mismatch");
  assert.equal(JSON.stringify(error).includes("secret-code"), false);
});

test("IPv6 loopback remains numeric and state-bound when the host supports it", async (context) => {
  const state = "v".repeat(43);
  let listener;
  try {
    listener = await startLoopbackCallback({ expectedState: state, timeoutMs: 1_000, host: "::1" });
  } catch (error) {
    if (error?.code === "EADDRNOTAVAIL" || error?.code === "EAFNOSUPPORT") {
      context.skip("IPv6 loopback is unavailable on this host");
      return;
    }
    throw error;
  }
  assert.match(listener.redirectUri, /^http:\/\/\[::1\]:\d+\/oauth\/callback$/u);
  const response = await fetch(`${listener.redirectUri}?code=ipv6-code&state=${state}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await listener.completion, { code: "ipv6-code" });
});

test("duplicate or unexpected callback parameters fail closed", async () => {
  const state = "d".repeat(43);
  const listener = await startLoopbackCallback({ expectedState: state, timeoutMs: 1_000 });
  const completion = listener.completion.catch((error) => error);
  const response = await fetch(`${listener.redirectUri}?code=one&code=two&state=${state}`);
  assert.equal(response.status, 400);
  assert.equal((await completion).code, "runa.auth.callback_invalid");
});

test("timeout and cancellation are terminal and leave no listening callback", async () => {
  const timeout = await startLoopbackCallback({ expectedState: "t".repeat(43), timeoutMs: 10 });
  await assert.rejects(timeout.completion, (error) => error.code === "runa.auth.timeout");
  await assert.rejects(fetch(`${timeout.redirectUri}?code=late&state=${"t".repeat(43)}`));

  const cancelled = await startLoopbackCallback({ expectedState: "c".repeat(43), timeoutMs: 1_000 });
  cancelled.cancel();
  await assert.rejects(cancelled.completion, (error) => error.code === "runa.auth.cancelled");
});
