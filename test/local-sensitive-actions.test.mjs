import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import {
  DeviceSelectionActions,
  DeviceSelectionError,
  GitSigningActions,
  GitSigningError,
  LocalServiceActions,
  LocalServiceError,
  createNodeLoopbackServiceTransport,
} from "../dist/local-actions/index.js";

const CONTEXT = Object.freeze({
  requestId: "request-1",
  identityFingerprint: "identity-1",
  isIdentityCurrent: () => true,
  isForegroundAlive: () => true,
});

const COMMIT = Buffer.from(
  `tree ${"a".repeat(40)}\nauthor Alice <alice@example.com> 1 +0000\ncommitter Alice <alice@example.com> 1 +0000\n\nmessage\n`,
  "utf8",
);

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function signArgs(payload = COMMIT) {
  return {
    objectType: "commit",
    canonicalPayloadBase64url: payload.toString("base64url"),
    decodedLength: payload.byteLength,
    payloadSha256: digest(payload),
    keySelectorId: "owner-key",
  };
}

test("git.sign binds one-time consent to canonical bytes and verifies the returned signature", async () => {
  const prompts = [];
  let signCalls = 0;
  const actions = new GitSigningActions({
    consent: { async approveOnce(prompt) { prompts.push(prompt); return true; } },
    keys: {
      async resolve(selectorId) {
        return {
          selectorId,
          algorithm: "ssh-ed25519",
          publicKeyFingerprint: "SHA256:public-fingerprint",
          async signCanonicalPayload(payload) { signCalls += 1; return createHash("sha256").update(payload).digest(); },
          async verifyCanonicalPayload(payload, signature) {
            return createHash("sha256").update(payload).digest().equals(Buffer.from(signature));
          },
        };
      },
    },
  });
  const result = await actions.sign(signArgs(), CONTEXT);
  assert.equal(signCalls, 1);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].operationDigest, digest(COMMIT));
  assert.equal(prompts[0].persistentChoiceAllowed, false);
  assert.equal(result.algorithm, "ssh-ed25519");
  assert.equal(result.publicKeyFingerprint, "SHA256:public-fingerprint");
  assert.equal(result.signatureSha256, digest(Buffer.from(result.signatureBase64url, "base64url")));
  assert.deepEqual(Object.keys(result).sort(), [
    "algorithm", "decodedLength", "publicKeyFingerprint", "signatureBase64url", "signatureSha256",
  ]);
});

test("git.sign rejects non-canonical, changed, denied, and unverifiable payloads before key use succeeds", async () => {
  let signCalls = 0;
  const args = signArgs();
  const actions = new GitSigningActions({
    consent: {
      async approveOnce() {
        const changed = Buffer.from(`${COMMIT.toString("utf8")}changed\n`, "utf8");
        args.canonicalPayloadBase64url = changed.toString("base64url");
        args.decodedLength = changed.byteLength;
        args.payloadSha256 = digest(changed);
        return true;
      },
    },
    keys: { async resolve(selectorId) {
      return {
        selectorId, algorithm: "ssh-ed25519", publicKeyFingerprint: "SHA256:key",
        async signCanonicalPayload() { signCalls += 1; return Buffer.from("signature"); },
        async verifyCanonicalPayload() { return true; },
      };
    } },
  });
  await assert.rejects(actions.sign(args, CONTEXT),
    (error) => error instanceof GitSigningError && error.code === "payload_changed");
  assert.equal(signCalls, 0);

  const malformed = Buffer.from(`tree ${"a".repeat(40)}\r\n\r\nmessage\n`, "utf8");
  await assert.rejects(actions.sign(signArgs(malformed), CONTEXT),
    (error) => error instanceof GitSigningError && error.code === "payload_not_canonical");

  const denied = new GitSigningActions({
    consent: { async approveOnce() { return false; } },
    keys: actionsKeyRegistry(false),
  });
  await assert.rejects(denied.sign(signArgs(), CONTEXT),
    (error) => error instanceof GitSigningError && error.code === "consent_denied");

  const badSignature = new GitSigningActions({
    consent: { async approveOnce() { return true; } },
    keys: actionsKeyRegistry(false),
  });
  await assert.rejects(badSignature.sign(signArgs(), CONTEXT),
    (error) => error instanceof GitSigningError && error.code === "signature_verification_failed");
});

test("git.sign serializes one selector and never offers an always-allow grant", async () => {
  let releaseConsent;
  const consentGate = new Promise((resolve) => { releaseConsent = resolve; });
  const actions = new GitSigningActions({
    consent: { async approveOnce(prompt) { assert.equal(prompt.persistentChoiceAllowed, false); await consentGate; return true; } },
    keys: actionsKeyRegistry(true),
  });
  const first = actions.sign(signArgs(), CONTEXT);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(actions.sign(signArgs(), { ...CONTEXT, requestId: "request-2" }),
    (error) => error instanceof GitSigningError && error.code === "signer_busy");
  releaseConsent();
  await first;
});

function actionsKeyRegistry(valid) {
  return { async resolve(selectorId) {
    return {
      selectorId, algorithm: "ssh-ed25519", publicKeyFingerprint: "SHA256:key",
      async signCanonicalPayload(payload) { return createHash("sha256").update(payload).digest(); },
      async verifyCanonicalPayload() { return valid; },
    };
  } };
}

const SERVICE_REGISTRATION = Object.freeze({
  registrationId: "dev-server",
  host: "127.0.0.1",
  port: 4310,
  maximumConcurrent: 2,
  operations: Object.freeze([Object.freeze({
    operationId: "render",
    method: "POST",
    path: "/api/render",
    requestEncoding: "canonical_json",
    responseEncoding: "canonical_json",
    requestContentType: "application/json",
    responseContentType: "application/json",
    requestSchemaId: "render.request.v1",
    responseSchemaId: "render.response.v1",
    maximumRequestBytes: 1_024,
    maximumResponseBytes: 1_024,
    timeoutMs: 1_000,
    idempotent: false,
  })]),
});

function serviceArgs(body = { value: 1 }) {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  return {
    registrationId: "dev-server",
    operationId: "render",
    bodyEncoding: "canonical_json",
    body,
    decodedLength: bytes.byteLength,
    bodySha256: digest(bytes),
  };
}

function serviceHarness(response = {
  statusCode: 200,
  contentType: "application/json; charset=utf-8",
  body: Buffer.from('{"ok":true}', "utf8"),
  remoteAddress: "127.0.0.1",
  redirected: false,
}) {
  const calls = [];
  const prompts = [];
  const actions = new LocalServiceActions({
    consent: { async approveOnce(prompt) { prompts.push(prompt); return true; } },
    schemas: {
      validate(schemaId, value) {
        if (schemaId === "render.request.v1") return value?.value === 1;
        if (schemaId === "render.response.v1") return value?.ok === true;
        return false;
      },
    },
    transport: { async request(input) { calls.push(input); return response; } },
  });
  actions.register(SERVICE_REGISTRATION);
  return { actions, calls, prompts };
}

test("local_service.request resolves only the exact registration and returns independently derived integrity", async () => {
  const { actions, calls, prompts } = serviceHarness();
  const result = await actions.request(serviceArgs(), CONTEXT);
  assert.equal(calls.length, 1);
  assert.deepEqual({ host: calls[0].host, port: calls[0].port, method: calls[0].method, path: calls[0].path }, {
    host: "127.0.0.1", port: 4310, method: "POST", path: "/api/render",
  });
  assert.equal(prompts[0].persistentChoiceAllowed, false);
  assert.deepEqual(result.body, { ok: true });
  assert.equal(result.bodySha256, digest(Buffer.from('{"ok":true}', "utf8")));
});

test("local_service.request rejects unknown operations, hostnames, redirects, bad peers and noncanonical responses", async () => {
  const unknown = serviceHarness();
  const unknownArgs = { ...serviceArgs(), operationId: "shell" };
  await assert.rejects(unknown.actions.request(unknownArgs, CONTEXT),
    (error) => error instanceof LocalServiceError && error.code === "operation_unregistered");
  assert.equal(unknown.calls.length, 0);

  const registration = { ...SERVICE_REGISTRATION, registrationId: "bad-host", host: "localhost" };
  assert.throws(() => unknown.actions.register(registration), /literal loopback/u);

  for (const [field, value, code] of [
    ["statusCode", 302, "redirect_rejected"],
    ["remoteAddress", "192.168.1.10", "response_peer_not_loopback"],
    ["body", Buffer.from('{ "ok": true }', "utf8"), "response_not_canonical"],
  ]) {
    const response = {
      statusCode: 200, contentType: "application/json", body: Buffer.from('{"ok":true}', "utf8"),
      remoteAddress: "127.0.0.1", redirected: false, [field]: value,
    };
    const harness = serviceHarness(response);
    await assert.rejects(harness.actions.request(serviceArgs(), CONTEXT),
      (error) => error instanceof LocalServiceError && error.code === code);
  }
});

test("local_service.request never retries and revocation cancels in-flight work", async () => {
  let attempts = 0;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const actions = new LocalServiceActions({
    consent: { async approveOnce() { return true; } },
    schemas: { validate() { return true; } },
    transport: {
      request(input) {
        attempts += 1;
        started();
        return new Promise((_resolve, reject) => input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      },
    },
  });
  actions.register(SERVICE_REGISTRATION);
  const pending = actions.request(serviceArgs(), CONTEXT);
  await startedPromise;
  actions.revoke("dev-server");
  await assert.rejects(pending, (error) => error instanceof LocalServiceError && error.code === "cancelled");
  assert.equal(attempts, 1);
});

test("the Node service transport connects to a literal loopback peer without proxy use or redirect following", async (t) => {
  let redirectedTargetHits = 0;
  const server = createServer((request, response) => {
    if (request.url === "/redirect-target") redirectedTargetHits += 1;
    response.writeHead(302, { location: "/redirect-target", "content-type": "application/json" });
    response.end('{"redirect":true}');
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, "object");
  const previousProxy = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = "http://192.0.2.1:9";
  t.after(() => {
    if (previousProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = previousProxy;
  });
  const result = await createNodeLoopbackServiceTransport().request({
    host: "127.0.0.1",
    port: address.port,
    method: "POST",
    path: "/start",
    contentType: "application/json",
    body: Buffer.from("{}"),
    maximumResponseBytes: 1_024,
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  });
  assert.equal(result.statusCode, 302);
  assert.equal(result.redirected, false, "transport reports the response and never follows it");
  assert.equal(result.remoteAddress, "127.0.0.1");
  assert.equal(redirectedTargetHits, 0);
});

const ALLOWLIST = Object.freeze({
  serial: Object.freeze(["baud-rate", "read-only"]),
  usb: Object.freeze(["hid"]),
  camera: Object.freeze(["preview"]),
  microphone: Object.freeze(["levels"]),
});

test("device.select requires a human choice, filters metadata, releases the device and exposes no reusable handle", async () => {
  let released = 0;
  const prompts = [];
  const actions = new DeviceSelectionActions({
    consent: { async approveOnce(prompt) { prompts.push(prompt); return true; } },
    selector: {
      async selectDevice() {
        return {
          localIdentityToken: "COM7-internal",
          displayName: "Owner serial\nport",
          deviceClass: "serial",
          capabilities: ["baud-rate", "dangerous-write"],
        };
      },
      async isStillPresent() { return true; },
      async release() { released += 1; },
    },
    allowedCapabilities: ALLOWLIST,
    randomBytes: () => Buffer.alloc(32, 7),
  });
  const result = await actions.select({
    deviceClass: "serial", purpose: "Inspect build output", requestedMetadata: ["display_name", "capabilities"],
  }, CONTEXT);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].persistentChoiceAllowed, false);
  assert.equal(result.displayName, "Owner serial port");
  assert.deepEqual(result.capabilities, ["baud-rate"]);
  assert.equal(JSON.stringify(result).includes("COM7"), false);
  assert.deepEqual(Object.keys(result).sort(), ["capabilities", "deviceClass", "displayName", "opaqueDeviceId"]);
  assert.equal(released, 1);
});

test("device.select denial, unplug and revoke fail before any reusable device authority exists", async () => {
  let selections = 0;
  const denied = new DeviceSelectionActions({
    consent: { async approveOnce() { return false; } },
    selector: {
      async selectDevice() { selections += 1; return null; },
      async isStillPresent() { return true; },
      async release() {},
    },
    allowedCapabilities: ALLOWLIST,
  });
  await assert.rejects(denied.select({ deviceClass: "usb", purpose: "Choose", requestedMetadata: [] }, CONTEXT),
    (error) => error instanceof DeviceSelectionError && error.code === "consent_denied");
  assert.equal(selections, 0);

  let released = 0;
  const unplugged = new DeviceSelectionActions({
    consent: { async approveOnce() { return true; } },
    selector: {
      async selectDevice() { return { localIdentityToken: "local", displayName: "USB", deviceClass: "usb", capabilities: [] }; },
      async isStillPresent() { return false; },
      async release() { released += 1; },
    },
    allowedCapabilities: ALLOWLIST,
  });
  await assert.rejects(unplugged.select({ deviceClass: "usb", purpose: "Choose", requestedMetadata: [] }, CONTEXT),
    (error) => error instanceof DeviceSelectionError && error.code === "device_disappeared");
  assert.equal(released, 1);

  let selectorStarted;
  const selectorStartedPromise = new Promise((resolve) => { selectorStarted = resolve; });
  const revoked = new DeviceSelectionActions({
    consent: { async approveOnce() { return true; } },
    selector: {
      selectDevice(_args, signal) {
        selectorStarted();
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("revoked")), { once: true }));
      },
      async isStillPresent() { return true; },
      async release() {},
    },
    allowedCapabilities: ALLOWLIST,
  });
  const pending = revoked.select({ deviceClass: "camera", purpose: "Choose", requestedMetadata: [] }, CONTEXT);
  await selectorStartedPromise;
  revoked.revokeAll();
  await assert.rejects(pending, /revoked/u);
});
