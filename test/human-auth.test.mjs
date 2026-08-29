import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CREDENTIAL_BACKEND_PROTOCOL,
  CredentialVault,
  SecretMaterial,
} from "../dist/credentials/index.js";
import {
  createHumanAuthService,
  createHttpTransport,
  decodeCliAuthBootstrap,
  decodeCliContinuationIssued,
  decodeCliSignupCapability,
  decodeCliLoginCodeExchangeResult,
  decodeRevocation,
  CunaError,
} from "../dist/index.js";

const NOW = Date.parse("2026-08-08T00:00:00.000Z");
const UUID_A = "00000000-0000-0000-0000-000000000001";
const UUID_B = "00000000-0000-0000-0000-000000000002";
const UUID_C = "00000000-0000-0000-0000-000000000003";
const AT = `cuna_at_${"a".repeat(43)}`;
const AT_2 = `cuna_at_${"b".repeat(43)}`;
const AT_3 = `cuna_at_${"d".repeat(43)}`;
const LOGIN = `cuna_login_${"l".repeat(43)}`;
const STATE = "x".repeat(43);

const config = Object.freeze({
  platformKind: "linux",
  profile: "default",
  profileSource: "default",
  baseUrl: "https://api.getcuna.com",
  baseUrlSource: "default",
  configFile: "/config.json",
  developmentProfile: false,
  apiKey: undefined,
  apiKeySource: "absent",
});

const HUMAN_SESSION_BINDING = Object.freeze({
  profileId: config.profile,
  accountId: config.baseUrl,
  workspaceId: "cli-human-auth",
  kind: "login-code-session-v1",
});

const context = Object.freeze({
  requiredTermsVersion: "2026-08",
  identity: "active",
  admission: "admitted",
  workspace: Object.freeze({ state: "assigned", id: UUID_C }),
});

class MemoryBackend {
  backendId = "memory-vault";
  platform = "linux";
  values = new Map();
  probeCalls = 0;
  readCalls = 0;
  beforeCompareDelete = undefined;
  async probe() {
    this.probeCalls += 1;
    return {
      protocol: CREDENTIAL_BACKEND_PROTOCOL,
      backendId: this.backendId,
      platform: this.platform,
      status: "verified",
      observedAt: NOW,
      expiresAt: NOW + 60_000,
      source: "live_round_trip",
    };
  }
  async read(target) {
    this.readCalls += 1;
    return this.values.has(target) ? Uint8Array.from(this.values.get(target)) : undefined;
  }
  async replace(target, value) { this.values.set(target, Uint8Array.from(value)); }
  async delete(target) { return this.values.delete(target) ? "deleted" : "absent"; }
  async compareAndSwap(target, expectedSha256, value) {
    const current = this.values.get(target);
    const currentSha256 = current === undefined ? null : createHash("sha256").update(current).digest("hex");
    if (currentSha256 !== expectedSha256) return "conflict";
    this.values.set(target, Uint8Array.from(value));
    return "replaced";
  }
  async compareAndDelete(target, expectedSha256) {
    await this.beforeCompareDelete?.();
    const current = this.values.get(target);
    if (current === undefined) return "absent";
    const currentSha256 = createHash("sha256").update(current).digest("hex");
    if (currentSha256 !== expectedSha256) return "conflict";
    this.values.delete(target);
    return "deleted";
  }
}

function exchangeResult(overrides = {}) {
  return {
    accessToken: AT,
    tokenType: "Bearer",
    expiresIn: 600,
    accessExpiresAt: "2026-08-08T00:10:00.000Z",
    loginCodeExpiresAt: "2026-09-07T00:00:00.000Z",
    sessionId: UUID_B,
    context,
    ...overrides,
  };
}

function fakeClient(overrides = {}) {
  const calls = [];
  const client = {
    calls,
    async bootstrap() {
      calls.push(["bootstrap"]);
      return {
        enabled: true,
        completionMode: "paste_login_code",
        pkceMethod: "S256",
        continuationTtlSeconds: 600,
        accessTokenTtlSeconds: 600,
        browserOrigin: "https://app.getcuna.com",
      };
    },
    async signupCapability() {
      calls.push(["signupCapability"]);
      return {
        enabled: true,
        enrollment: "waitlist_only",
        identityMethods: ["email_password", "oauth"],
      };
    },
    async createContinuation(input) {
      calls.push(["create", input]);
      return {
        id: UUID_A,
        browserUrl: `https://app.getcuna.com/cli/continue#continuation=${UUID_A}&nonce=cuna_cb_${"n".repeat(43)}&state=${input.state}`,
        expiresAt: "2026-08-08T00:10:00.000Z",
        completionMode: "paste_login_code",
      };
    },
    async exchange(input) {
      calls.push(["exchange", input]);
      return exchangeResult({
        accessToken: input.expectedLoginCodeExpiresAt === undefined ? AT : AT_2,
      });
    },
    async context(token) { calls.push(["context", token]); return context; },
    async logout(token) { calls.push(["logout", token]); return true; },
    ...overrides,
  };
  return client;
}

/**
 * A stored bearer is reused until it nears expiry, so any test about the
 * EXCHANGE path has to start past that margin — otherwise the CLI correctly
 * reuses the bearer, never calls `exchange`, and the test either asserts the
 * wrong count or waits forever for a call that will not come.
 *
 * The backend's platform evidence is time-bound too, so it has to follow the
 * same clock or the vault refuses before the bearer is ever consulted.
 */
function exchangeClock() {
  const state = { now: NOW };
  const backend = new MemoryBackend();
  backend.probe = async () => ({
    protocol: CREDENTIAL_BACKEND_PROTOCOL,
    backendId: backend.backendId,
    platform: backend.platform,
    status: "verified",
    observedAt: state.now,
    expiresAt: state.now + 60_000,
    source: "live_round_trip",
  });
  return {
    backend,
    clock: () => state.now,
    /** Move past the stored bearer's reuse margin so the next call exchanges. */
    expireStoredBearer() { state.now = Date.parse("2026-08-08T00:09:00.000Z"); },
    advanceTo(iso) { state.now = Date.parse(iso); },
  };
}

function fixture(overrides = {}) {
  const backend = overrides.backend ?? new MemoryBackend();
  const clock = overrides.clock ?? (() => NOW);
  const vault = new CredentialVault({ backend, clock, platform: "linux" });
  const client = overrides.client ?? fakeClient();
  const opened = [];
  const handoff = [];
  const service = createHumanAuthService({
    config,
    client,
    vault,
    browser: overrides.browser ?? { async open(url) { opened.push(url); } },
    browserHandoff: {
      continuationUrl(url) { handoff.push(["url", url]); },
      browserOpened() { handoff.push(["opened"]); },
      browserOpenFailed() { handoff.push(["open_failed"]); },
    },
    clock,
    random: (size) => new Uint8Array(size).fill(7),
    uuid: () => UUID_A,
    readLoginCode: overrides.readLoginCode ?? (async () => LOGIN),
  });
  return { backend, vault, client, opened, handoff, service };
}

// POLICY CHANGED, deliberately. This test used to assert that the bearer never
// reached disk. It does now, inside the SAME AES-GCM envelope that already
// holds the login code — never beside it, never in a second file.
//
// The reason is a measured user-facing defect, not convenience: every
// authenticated command re-exchanged the login code, the server allows ten
// exchanges per rolling minute, so the eleventh command in a minute failed.
// 35 failures in 88 attempts.
//
// The capability argument for allowing it: the login code already on disk
// mints bearers for thirty days; this bearer is terminal, capped at ten
// minutes by the server, and re-checked against `revoked_at is null` on every
// use. Storing it adds strictly less capability than the file already carries,
// and co-locating it means logout's existing revision-fenced delete destroys
// it with no second invalidation path to keep correct.
//
// What must stay true is asserted below and in the tests that follow: the
// bearer never lands anywhere except that envelope.
test("login persists durable exchange authority and the bearer, in one envelope", async () => {
  const subject = fixture();
  const result = await subject.service.login();
  assert.equal(result.sessionId, UUID_B);
  assert.equal(subject.opened.length, 1);
  const create = subject.client.calls.find(([name]) => name === "create")[1];
  assert.match(create.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/u);
  assert.equal(Object.hasOwn(create, "codeVerifier"), false);
  assert.equal(subject.client.calls.filter(([name]) => name === "exchange").length, 1);
  assert.equal(subject.client.calls.some(([name]) => name === "poll" || name === "cancel"), false);
  const protectedBytes = Buffer.concat([...subject.backend.values.values()].map((value) => Buffer.from(value))).toString("utf8");
  assert.equal(protectedBytes.includes("code_verifier"), true);
  // The bearer is stored, and stored in exactly one place: the same record as
  // the login code. One envelope means one delete on logout.
  assert.equal(protectedBytes.includes(AT), true);
  assert.equal(subject.backend.values.size, 1, "the bearer must not create a second protected record");
  assert.equal(protectedBytes.includes("access_expires_at"), true);
  assert.equal(protectedBytes.includes("access_observed_at"), true);
});

test("login announces the continuation URL it hands to the browser, in that order", async () => {
  const subject = fixture();
  await subject.service.login();
  // Derived from the state the service actually sent, never restated here: an
  // expectation rebuilt from the fixture's own constants would follow a
  // mutation that changed the state instead of catching it.
  const sentState = subject.client.calls.find(([name]) => name === "create")[1].state;
  const issued = `https://app.getcuna.com/cli/continue#continuation=${UUID_A}&nonce=cuna_cb_${"n".repeat(43)}&state=${sentState}`;
  // One URL, delivered to the user and to the opener, and the user first.
  assert.deepEqual(subject.opened, [issued]);
  assert.deepEqual(subject.handoff, [["url", issued], ["opened"]]);
  // Literal oracle on the approved origin. A brand-order mutation moves these
  // exact bytes rather than moving the expectation with them.
  assert.equal(new URL(subject.handoff[0][1]).origin, "https://app.getcuna.com");
});

test("login still announces the continuation URL when the browser cannot be opened", async () => {
  const subject = fixture({
    browser: { async open() { throw new Error("spawn xdg-open ENOENT"); } },
  });
  const result = await subject.service.login();
  assert.equal(result.sessionId, UUID_B);
  assert.equal(subject.handoff[0][0], "url");
  assert.deepEqual(subject.handoff[1], ["open_failed"]);
});

test("login refuses a completion mode it cannot drive instead of running the paste flow", async () => {
  // The server is the authority on how a sign-in completes. A CLI that ignores
  // the advertised mode tells the user to paste a code the service will never
  // show them, so this must refuse before any browser or prompt effect.
  let promptCalls = 0;
  const subject = fixture({
    client: fakeClient({
      async bootstrap() {
        this.calls.push(["bootstrap"]);
        return {
          enabled: true,
          completionMode: "poll",
          pkceMethod: "S256",
          continuationTtlSeconds: 600,
          accessTokenTtlSeconds: 600,
          browserOrigin: "https://app.getcuna.com",
        };
      },
    }),
    readLoginCode: async () => { promptCalls += 1; return LOGIN; },
  });
  await assert.rejects(
    subject.service.login(),
    (error) => error instanceof CunaError && error.code === "cuna.auth.completion_mode_unsupported",
  );
  assert.equal(promptCalls, 0);
  assert.deepEqual(subject.handoff, []);
  assert.deepEqual(subject.opened, []);
  assert.equal(subject.client.calls.some(([name]) => name === "exchange"), false);
});

test("waitlist-only signup stores a restricted session and permits one pinned admission transition", async () => {
  const waitlisted = Object.freeze({
    requiredTermsVersion: "2026-08",
    identity: "active",
    admission: "waitlisted",
    workspace: Object.freeze({ state: "unavailable" }),
    waitlistPosition: 9,
  });
  const signupClient = fakeClient({
    async exchange(input) {
      this.calls.push(["exchange", input]);
      return exchangeResult({ context: waitlisted });
    },
  });
  // The admission transition below is only observable on a real exchange, and
  // a stored bearer is now reused until it nears expiry. Keep this test about
  // the transition — not about bearer reuse, which has its own test — by
  // letting the clock reach the point where an exchange is due. The backend's
  // platform evidence is time-bound, so it has to follow the same clock.
  let now = NOW;
  const backend = new MemoryBackend();
  backend.probe = async () => ({
    protocol: CREDENTIAL_BACKEND_PROTOCOL,
    backendId: backend.backendId,
    platform: backend.platform,
    status: "verified",
    observedAt: now,
    expiresAt: now + 60_000,
    source: "live_round_trip",
  });
  const signedUp = fixture({ backend, client: signupClient, clock: () => now });
  const result = await signedUp.service.signup();
  assert.equal(result.context.admission, "waitlisted");
  assert.equal(
    signupClient.calls.find(([name]) => name === "create")[1].intentClass,
    "signup",
  );
  assert.equal(signupClient.calls.some(([name]) => name === "signupCapability"), true);

  const admittedContext = Object.freeze({
    ...waitlisted,
    admission: "admitted",
    workspace: Object.freeze({ state: "assigned", id: UUID_C }),
    waitlistPosition: undefined,
  });
  const admittedClient = fakeClient({
    async exchange(input) {
      this.calls.push(["exchange", input]);
      return exchangeResult({
        accessToken: AT_2,
        context: admittedContext,
      });
    },
  });
  now = Date.parse("2026-08-08T00:09:00.000Z");
  const admitted = fixture({ backend, client: admittedClient, clock: () => now });
  assert.equal(await admitted.service.acquireAccessToken(), AT_2);

  const substitutedClient = fakeClient({
    async exchange(input) {
      this.calls.push(["exchange", input]);
      return exchangeResult({
        accessToken: AT_3,
        context: {
          ...admittedContext,
          requiredTermsVersion: "2026-09",
        },
      });
    },
  });
  // Same clock, and far enough past the stored bearer that this reaches a real
  // exchange — a reused bearer would never see the substituted terms version
  // that this case exists to refuse.
  now = Date.parse("2026-08-08T00:19:00.000Z");
  const substituted = fixture({ backend, client: substitutedClient, clock: () => now });
  await assert.rejects(
    substituted.service.acquireAccessToken(),
    (error) => error.code === "cuna.auth.reauthentication_required",
  );
  assert.equal(backend.values.size, 0);
});

test("signup capability is closed and never fabricates providers while disabled", () => {
  assert.deepEqual(
    decodeCliSignupCapability({
      enabled: false,
      enrollment: "waitlist_only",
      identity_methods: [],
      reason_code: "remote_signup_abuse_controls_unverified",
    }).identityMethods,
    [],
  );
  assert.throws(() => decodeCliSignupCapability({
    enabled: false,
    enrollment: "waitlist_only",
    identity_methods: ["email_password", "oauth"],
    reason_code: "remote_signup_abuse_controls_unverified",
  }));
  assert.throws(() => decodeCliSignupCapability({
    enabled: true,
    enrollment: "waitlist_only",
    identity_methods: ["email_password", "invented"],
  }));
});

test("a second login fails before creating a new continuation or orphaning the old family", async () => {
  const subject = fixture();
  await subject.service.login();
  const creates = subject.client.calls.filter(([name]) => name === "create").length;
  await assert.rejects(subject.service.login(), (error) => error.code === "cuna.auth.already_signed_in");
  assert.equal(subject.client.calls.filter(([name]) => name === "create").length, creates);
});

test("deferred code cancellation and expiry remain local without exchange or persistence", async () => {
  const controller = new AbortController();
  const cancelled = fixture({
    readLoginCode: async (readerSignal) => {
      const readerStopped = new Promise((_, reject) => {
        readerSignal.addEventListener("abort", () => reject(new Error("hidden reader aborted")), { once: true });
      });
      controller.abort(new Error("operator interrupt"));
      return await readerStopped;
    },
  });
  await assert.rejects(cancelled.service.login({ signal: controller.signal }), (error) => error.code === "cuna.auth.cancelled");
  assert.equal(cancelled.client.calls.some(([name]) => name === "exchange"), false);
  assert.equal(cancelled.client.calls.some(([name]) => name === "poll" || name === "cancel"), false);
  assert.equal(cancelled.backend.values.size, 0);

  const expiryClient = fakeClient({
    async createContinuation(input) {
      this.calls.push(["create", input]);
      return {
        id: UUID_A,
        browserUrl: `https://app.getcuna.com/cli/continue#continuation=${UUID_A}&nonce=cuna_cb_${"n".repeat(43)}&state=${input.state}`,
        expiresAt: new Date(Date.now() + 50).toISOString(),
        completionMode: "paste_login_code",
      };
    },
  });
  const expired = fixture({
    client: expiryClient,
    clock: () => Date.now(),
    backend: Object.assign(new MemoryBackend(), {
      async probe() {
        const observedAt = Date.now();
        return {
          protocol: CREDENTIAL_BACKEND_PROTOCOL,
          backendId: "memory-vault",
          platform: "linux",
          status: "verified",
          observedAt,
          expiresAt: observedAt + 60_000,
          source: "live_round_trip",
        };
      },
    }),
    readLoginCode: async (readerSignal) => await new Promise((_, reject) => {
      readerSignal.addEventListener("abort", () => reject(new Error("hidden reader expired")), { once: true });
    }),
  });
  await assert.rejects(expired.service.login(), (error) => error.code === "cuna.auth.continuation_expired");
  assert.equal(expiryClient.calls.some(([name]) => name === "exchange"), false);
  assert.equal(expiryClient.calls.some(([name]) => name === "poll" || name === "cancel"), false);
  assert.equal(expired.backend.values.size, 0);
});

test("cancellation between preflight and abort-listener registration never starts the hidden reader", async () => {
  const controller = new AbortController();
  const originalAddEventListener = controller.signal.addEventListener.bind(controller.signal);
  Object.defineProperty(controller.signal, "addEventListener", {
    configurable: true,
    value(type, listener, options) {
      // This is the exact EventTarget race: abort happens before the original
      // listener attaches, so EventTarget will not replay the event for it.
      controller.abort(new Error("operator interrupted during listener registration"));
      return originalAddEventListener(type, listener, options);
    },
  });
  let readerStarted = false;
  const subject = fixture({
    readLoginCode: async (readerSignal) => {
      readerStarted = true;
      return await new Promise((_, reject) => {
        readerSignal.addEventListener("abort", () => reject(new Error("hidden reader aborted")), { once: true });
      });
    },
  });
  const timeout = Symbol("deferred-reader-timeout");
  let timer;
  const outcome = await Promise.race([
    subject.service.login({ signal: controller.signal }).then(
      () => new Error("cancelled sign-in unexpectedly succeeded"),
      (error) => error,
    ),
    new Promise((resolve) => { timer = setTimeout(() => resolve(timeout), 100); }),
  ]);
  clearTimeout(timer);

  assert.notEqual(outcome, timeout, "cancellation must not leave hidden input blocked until expiry");
  assert.equal(outcome?.code, "cuna.auth.cancelled");
  assert.equal(readerStarted, false, "a cancellation already observed must not start hidden-code input");
  assert.equal(subject.client.calls.some(([name]) => name === "exchange"), false);
  assert.equal(subject.client.calls.some(([name]) => name === "poll" || name === "cancel"), false);
  assert.equal(subject.backend.values.size, 0);
});

test("a pre-aborted sign-in performs no vault, browser, or network effect", async () => {
  const subject = fixture();
  subject.backend.probe = async () => { throw new Error("vault probe must not run"); };
  const controller = new AbortController();
  controller.abort(new Error("operator interrupt"));
  await assert.rejects(
    subject.service.login({ signal: controller.signal }),
    (error) => error.code === "cuna.auth.cancelled",
  );
  assert.deepEqual(subject.client.calls, []);
  assert.deepEqual(subject.opened, []);
  assert.equal(subject.backend.values.size, 0);
});

test("authoritative exchange rejection never retries or persists, and post-exchange validation failure revokes the new family", async () => {
  const rejectedClient = fakeClient({
    async exchange(input) {
      this.calls.push(["exchange", input]);
      throw new CunaError({
        code: "cuna.auth.rejected",
        message: "Cuna rejected the browser continuation exchange.",
        exitCode: 4,
        details: { reason: "cli_auth_rejected" },
      });
    },
  });
  const rejected = fixture({ client: rejectedClient });
  await assert.rejects(rejected.service.login(), (error) => error.code === "cuna.auth.rejected");
  assert.equal(rejectedClient.calls.filter(([name]) => name === "create").length, 1);
  assert.equal(rejectedClient.calls.filter(([name]) => name === "exchange").length, 1);
  assert.equal(rejectedClient.calls.some(([name]) => name === "poll" || name === "cancel"), false);
  assert.equal(rejected.backend.values.size, 0);

  const mismatchClient = fakeClient({
    async exchange(input) {
      this.calls.push(["exchange", input]);
      return exchangeResult({ context: { ...context, identity: "verification_required" } });
    },
  });
  const mismatch = fixture({ client: mismatchClient });
  await assert.rejects(mismatch.service.login(), (error) => error.code === "cuna.auth.onboarding_incomplete");
  assert.equal(mismatch.client.calls.some(([name, token]) => name === "logout" && token === AT), true);
  assert.equal(mismatch.backend.values.size, 0);

  const failingBackend = new MemoryBackend();
  failingBackend.compareAndSwap = async () => { throw new Error("vault write unavailable"); };
  const vaultFailure = fixture({ backend: failingBackend });
  await assert.rejects(vaultFailure.service.login());
  assert.equal(vaultFailure.client.calls.some(([name, token]) => name === "logout" && token === AT), true);
  assert.equal(failingBackend.values.size, 0);
});

test("post-exchange cancellation compensates the remote family without persisting or caching authority", async () => {
  const controller = new AbortController();
  const client = fakeClient({
    async exchange(input) {
      this.calls.push(["exchange", input]);
      controller.abort(new Error("operator interrupted after exchange"));
      return exchangeResult();
    },
  });
  const subject = fixture({ client });

  await assert.rejects(
    subject.service.login({ signal: controller.signal }),
    (error) => error.code === "cuna.auth.cancelled",
  );
  assert.equal(client.calls.filter(([name]) => name === "exchange").length, 1);
  assert.equal(client.calls.filter(([name]) => name === "logout").length, 1);
  assert.equal(client.calls.some(([name]) => name === "poll" || name === "cancel"), false);
  assert.equal(subject.backend.values.size, 0);
  await assert.rejects(subject.service.acquireAccessToken(), (error) => error.code === "cuna.auth.required");
  assert.equal(client.calls.filter(([name]) => name === "exchange").length, 1);
});

test("post-rotation cancellation compare-deletes only the just-written session before returning", async () => {
  const controller = new AbortController();
  const backend = new MemoryBackend();
  const compareAndSwap = backend.compareAndSwap.bind(backend);
  const compareAndDelete = backend.compareAndDelete.bind(backend);
  let compareDeleteCalls = 0;
  backend.compareAndSwap = async (...args) => {
    const outcome = await compareAndSwap(...args);
    if (outcome === "replaced") controller.abort(new Error("operator interrupted after local rotation"));
    return outcome;
  };
  backend.compareAndDelete = async (...args) => {
    compareDeleteCalls += 1;
    return await compareAndDelete(...args);
  };
  const subject = fixture({ backend });

  await assert.rejects(
    subject.service.login({ signal: controller.signal }),
    (error) => error.code === "cuna.auth.cancelled",
  );
  assert.equal(compareDeleteCalls, 1);
  assert.equal(subject.client.calls.filter(([name]) => name === "logout").length, 1);
  assert.equal(subject.client.calls.some(([name]) => name === "poll" || name === "cancel"), false);
  assert.equal(subject.backend.values.size, 0);
  await assert.rejects(subject.service.acquireAccessToken(), (error) => error.code === "cuna.auth.required");
  assert.equal(subject.client.calls.filter(([name]) => name === "exchange").length, 1);
});

test("a stored bearer is reused across processes, and only a stale one buys an exchange", async () => {
  // This is the fix for the defect that made one authenticated command in
  // three fail: every command re-exchanged the login code, against a server
  // budget of ten exchanges per rolling minute, so the eleventh command in a
  // minute was refused. A second process must now spend ZERO exchanges while
  // the stored bearer still has real life left.
  // The backend's platform evidence is time-bound, so the clock this test
  // advances has to carry it along or the vault refuses before the bearer is
  // ever consulted.
  let now = NOW;
  const backend = new MemoryBackend();
  backend.probe = async () => ({
    protocol: CREDENTIAL_BACKEND_PROTOCOL,
    backendId: backend.backendId,
    platform: backend.platform,
    status: "verified",
    observedAt: now,
    expiresAt: now + 60_000,
    source: "live_round_trip",
  });
  const original = fixture({ backend, clock: () => now });
  await original.service.login();
  const nextClient = fakeClient();
  const next = fixture({ backend, client: nextClient, clock: () => now });
  const tokens = await Promise.all(Array.from({ length: 12 }, () => next.service.acquireAccessToken()));
  assert.deepEqual(new Set(tokens), new Set([AT]), "a fresh process did not reuse the stored bearer");
  assert.equal(
    nextClient.calls.filter(([name]) => name === "exchange").length,
    0,
    "reusing a live bearer must cost no exchange at all",
  );

  // Past the reuse margin the bearer is no longer safe to hand to a request
  // that could outlive it, so exactly one exchange happens — and concurrent
  // acquisitions still coalesce into that one, which is the property the
  // original version of this test existed to hold.
  const staleClient = fakeClient({
    async exchange(input) {
      this.calls.push(["exchange", input]);
      return exchangeResult({ accessToken: AT_2 });
    },
  });
  now = Date.parse("2026-08-08T00:09:00.000Z");
  const stale = fixture({ backend, client: staleClient, clock: () => now });
  const staleTokens = await Promise.all(Array.from({ length: 12 }, () => stale.service.acquireAccessToken()));
  assert.deepEqual(new Set(staleTokens), new Set([AT_2]));
  const exchanges = staleClient.calls.filter(([name]) => name === "exchange");
  assert.equal(exchanges.length, 1, "concurrent acquisitions must still coalesce into one exchange");
  assert.equal(exchanges[0][1].expectedLoginCodeExpiresAt, "2026-09-07T00:00:00.000Z");
  assert.equal(JSON.stringify(staleClient.calls).includes(LOGIN), true);
});

test("one long-lived HTTP transport reacquires an interactive bearer after the 600 second access TTL", async () => {
  let now = NOW;
  let exchanges = 0;
  const backend = new MemoryBackend();
  backend.probe = async () => ({
    protocol: CREDENTIAL_BACKEND_PROTOCOL,
    backendId: backend.backendId,
    platform: backend.platform,
    status: "verified",
    observedAt: now,
    expiresAt: now + 60_000,
    source: "live_round_trip",
  });
  const client = fakeClient({
    async exchange(input) {
      this.calls.push(["exchange", input]);
      exchanges += 1;
      return exchangeResult({
        accessToken: exchanges === 1 ? AT : AT_2,
        accessExpiresAt: new Date(now + 600_000).toISOString(),
      });
    },
  });
  const subject = fixture({ backend, client, clock: () => now });
  await subject.service.login();

  const authorizations = [];
  const transport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    bearerTokenProvider: (signal) => subject.service.acquireAccessToken(signal),
    fetch: async (_url, init) => {
      authorizations.push(init.headers.Authorization);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  await transport.request({ method: "GET", path: "/v1/context" });
  now += 601_000;
  await transport.request({ method: "GET", path: "/v1/context" });

  assert.deepEqual(authorizations, [`Bearer ${AT}`, `Bearer ${AT_2}`]);
  assert.equal(exchanges, 2, "login plus one expiry-driven re-exchange");
  assert.equal(backend.values.size, 1, "refreshing an access bearer retains the durable login code");
});

test("response timeout begins after interprocess credential acquisition, not while waiting for it", async () => {
  let fetches = 0;
  const transport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    timeoutMs: 20,
    bearerTokenProvider: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return AT;
    },
    fetch: async () => {
      fetches += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  assert.deepEqual(await transport.request({ method: "GET", path: "/v1/context" }), { ok: true });
  assert.equal(fetches, 1);
});

test("a protected GET 401 forces one bearer rotation, retries once, and retains the durable login code", async () => {
  const subject = fixture();
  await subject.service.login();
  let fetches = 0;
  const authorizations = [];
  const transport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    bearerTokenProvider: (signal, refresh) => refresh === undefined
      ? subject.service.acquireAccessToken(signal)
      : subject.service.refreshRejectedAccessToken(refresh.rejectedToken, signal),
    fetch: async (_url, init) => {
      fetches += 1;
      authorizations.push(init.headers.Authorization);
      if (fetches === 2) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({
        type: "https://api.getcuna.com/problems/unauthenticated",
        title: "Authentication required",
        status: 401,
        code: "unauthenticated",
        request_id: UUID_C,
        retryable: false,
        action: "sign_in",
      }), { status: 401, headers: { "content-type": "application/problem+json" } });
    },
  });

  assert.deepEqual(await transport.request({ method: "GET", path: "/v1/context" }), { ok: true });
  assert.equal(fetches, 2, "401 permits exactly one safe replay");
  assert.deepEqual(authorizations, [`Bearer ${AT}`, `Bearer ${AT_2}`]);
  assert.equal(subject.backend.values.size, 1, "an access-token rejection does not revoke durable login");
});

test("401 retry is bounded to GET or a valid idempotency key and preserves mutation identity", async () => {
  for (const request of [
    { method: "POST", path: "/v1/write", body: { value: 1 } },
    { method: "POST", path: "/v1/write", body: { value: 1 }, idempotencyKey: "bad" },
  ]) {
    let fetches = 0;
    let refreshes = 0;
    const transport = createHttpTransport({
      baseUrl: "https://api.getcuna.com",
      bearerTokenProvider: async (_signal, refresh) => {
        if (refresh !== undefined) refreshes += 1;
        return AT;
      },
      fetch: async () => {
        fetches += 1;
        return new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 });
      },
    });
    await assert.rejects(transport.request(request), (error) => error.code === "cuna.auth.rejected");
    assert.equal(fetches, 1);
    assert.equal(refreshes, 0);
  }

  const attempts = [];
  let providerCalls = 0;
  const transport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    bearerTokenProvider: async (_signal, refresh) => {
      providerCalls += 1;
      if (refresh !== undefined) {
        assert.equal(refresh.reason, "unauthorized");
        assert.equal(refresh.rejectedToken, AT);
        return AT_2;
      }
      return AT;
    },
    fetch: async (_url, init) => {
      attempts.push({ authorization: init.headers.Authorization, key: init.headers["Idempotency-Key"], body: init.body });
      return new Response(JSON.stringify(attempts.length === 1 ? { error: "unauthenticated" } : { ok: true }), {
        status: attempts.length === 1 ? 401 : 200,
      });
    },
  });
  assert.deepEqual(await transport.request({
    method: "POST",
    path: "/v1/write",
    body: { value: 1 },
    idempotencyKey: "stable-operation-1",
  }), { ok: true });
  assert.equal(providerCalls, 2);
  assert.deepEqual(attempts, [
    { authorization: `Bearer ${AT}`, key: "stable-operation-1", body: JSON.stringify({ value: 1 }) },
    { authorization: `Bearer ${AT_2}`, key: "stable-operation-1", body: JSON.stringify({ value: 1 }) },
  ]);
});

test("a second 401 is authoritative and never starts a retry loop", async () => {
  let fetches = 0;
  let providerCalls = 0;
  const transport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    bearerTokenProvider: async (_signal, refresh) => {
      providerCalls += 1;
      return refresh === undefined ? AT : AT_2;
    },
    fetch: async () => {
      fetches += 1;
      return new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 });
    },
  });
  await assert.rejects(transport.request({ method: "GET", path: "/v1/context" }), (error) => error.code === "cuna.auth.rejected");
  assert.equal(fetches, 2);
  assert.equal(providerCalls, 2);
});

test("fresh whoami reuses identity validated by re-exchange instead of rereading the encrypted session", async () => {
  const original = fixture();
  await original.service.login();
  original.backend.probeCalls = 0;
  original.backend.readCalls = 0;

  const client = fakeClient();
  const fresh = fixture({ backend: original.backend, client });
  const result = await fresh.service.whoami();

  assert.equal(result.profile, config.profile);
  assert.equal(result.sessionId, UUID_B);
  // Zero, not one: the bearer stored by the previous process is still live, so
  // a fresh `whoami` costs no exchange at all. Identity is still proved live —
  // the context read below is what does that, and it is unchanged.
  assert.equal(client.calls.filter(([name]) => name === "exchange").length, 0);
  assert.equal(client.calls.filter(([name]) => name === "context").length, 1);
  // A fresh service still proves the backend once and reads its encrypted
  // record once. The old path did an initial load, a re-exchange read, and a
  // post-context load for the same immutable identity metadata.
  assert.equal(original.backend.probeCalls, 1);
  assert.equal(original.backend.readCalls, 1);
});

test("one cancelled re-exchange waiter neither aborts nor poisons the shared credential read", async () => {
  // This case is about sharing ONE in-flight exchange, so the stored bearer
  // has to be past its reuse margin — otherwise the CLI correctly reuses it,
  // no exchange is ever entered, and the test waits forever on a promise that
  // nothing will resolve. The backend's platform evidence follows the clock.
  let now = NOW;
  const backend = new MemoryBackend();
  backend.probe = async () => ({
    protocol: CREDENTIAL_BACKEND_PROTOCOL,
    backendId: backend.backendId,
    platform: backend.platform,
    status: "verified",
    observedAt: now,
    expiresAt: now + 60_000,
    source: "live_round_trip",
  });
  const original = fixture({ backend, clock: () => now });
  await original.service.login();
  now = Date.parse("2026-08-08T00:09:00.000Z");
  let releaseExchange;
  let exchangeEntered;
  const entered = new Promise((resolve) => { exchangeEntered = resolve; });
  const client = fakeClient({
    async exchange(input) {
      this.calls.push(["exchange", input]);
      exchangeEntered();
      await new Promise((resolve) => { releaseExchange = resolve; });
      return exchangeResult({ accessToken: AT_2 });
    },
  });
  const subject = fixture({ backend, client, clock: () => now });
  const controller = new AbortController();
  const cancelled = subject.service.acquireAccessToken(controller.signal);
  await entered;
  const surviving = subject.service.acquireAccessToken();
  controller.abort(new Error("caller no longer needs the token"));
  await assert.rejects(cancelled, (error) => error.code === "cuna.auth.cancelled");
  releaseExchange();
  assert.equal(await surviving, AT_2);
  const exchanges = client.calls.filter(([name]) => name === "exchange");
  assert.equal(exchanges.length, 1);
  assert.equal(Object.hasOwn(exchanges[0][1], "signal"), false, "caller cancellation cannot own shared re-exchange authority");
});

test("authoritative re-exchange rejection deletes the family while unknown failure preserves it", async () => {
  const gate = exchangeClock();
  const first = fixture({ backend: gate.backend, clock: gate.clock });
  await first.service.login();
  gate.expireStoredBearer();
  const rejectedClient = fakeClient({
    async exchange() {
      throw new CunaError({
        code: "cuna.auth.rejected", message: "rejected", exitCode: 3,
        details: { http_status: 401, reason: "cli_session_revoked" },
      });
    },
  });
  const rejected = fixture({ backend: gate.backend, client: rejectedClient, clock: gate.clock });
  await assert.rejects(rejected.service.acquireAccessToken(), (error) => error.code === "cuna.auth.reauthentication_required");
  assert.equal(first.backend.values.size, 0);

  const secondGate = exchangeClock();
  const second = fixture({ backend: secondGate.backend, clock: secondGate.clock });
  await second.service.login();
  secondGate.expireStoredBearer();
  const unknown = fixture({ backend: secondGate.backend, client: fakeClient({ async exchange() { throw new Error("network secret"); } }), clock: secondGate.clock });
  await assert.rejects(unknown.service.acquireAccessToken());
  assert.equal(secondGate.backend.values.size, 1);

  const thirdGate = exchangeClock();
  const third = fixture({ backend: thirdGate.backend, clock: thirdGate.clock });
  await third.service.login();
  thirdGate.expireStoredBearer();
  const invalidContext = fixture({
    clock: thirdGate.clock,
    backend: thirdGate.backend,
    client: fakeClient({
      async exchange(input) {
        this.calls.push(["exchange", input]);
        return exchangeResult({
          accessToken: AT_2,
          context: { ...context, admission: "waitlisted", workspace: { state: "unavailable" } },
        });
      },
      async logout(token) { this.calls.push(["logout", token]); throw new Error("unknown logout"); },
    }),
  });
  await assert.rejects(invalidContext.service.acquireAccessToken(), (error) => error.code === "cuna.auth.reauthentication_required");
  assert.equal(thirdGate.backend.values.size, 0);
  assert.equal(invalidContext.client.calls.some(([name, token]) => name === "logout" && token === AT_2), true);
});

test("logout retains encrypted local material for network, 5xx, and unknown outcomes", async () => {
  for (const failure of [
    new Error("response lost before an authoritative answer"),
    new CunaError({
      code: "cuna.network.service_unavailable",
      message: "temporary upstream failure",
      exitCode: 5,
      retryable: true,
      details: { http_status: 503 },
    }),
    new CunaError({
      code: "cuna.remote.rejected",
      message: "unclassified server result",
      exitCode: 8,
      details: { http_status: 500 },
    }),
  ]) {
    const subject = fixture({
      client: fakeClient({
        async logout(token) {
          this.calls.push(["logout", token]);
          throw failure;
        },
      }),
    });
    await subject.service.login();
    await assert.rejects(subject.service.logout(), (error) => error === failure);
    assert.equal(subject.backend.values.size, 1, "an indeterminate logout result must retain the durable login code");
  }
});

test("an ambiguous logout discards its cached bearer and forces a fresh acquisition without erasing the login code", { concurrency: false }, async () => {
  const created = [];
  const originalFromUtf8 = SecretMaterial.fromUtf8;
  SecretMaterial.fromUtf8 = function captureAccessMaterial(value) {
    const material = originalFromUtf8.call(this, value);
    if (value === AT) created.push(material);
    return material;
  };
  try {
    const subject = fixture({
      client: fakeClient({
        async logout(token) {
          this.calls.push(["logout", token]);
          throw new Error("response lost before an authoritative logout receipt");
        },
      }),
    });
    await subject.service.login();
    assert.equal(created.length, 1);
    await assert.rejects(subject.service.logout(), /response lost/u);
    assert.equal(subject.backend.values.size, 1, "an ambiguous write preserves the encrypted login code");
    assert.equal(created[0].disposed, true, "an ambiguous write must not leave a possibly revoked bearer reusable");
    assert.equal(await subject.service.acquireAccessToken(), AT_2);
    assert.equal(subject.client.calls.filter(([name]) => name === "exchange").length, 2);
  } finally {
    SecretMaterial.fromUtf8 = originalFromUtf8;
  }
});

test("a fresh logout preserves encrypted material when re-exchange returns generic not-found or terms conflict", async () => {
  for (const failure of [
    new CunaError({
      code: "cuna.remote.not_found",
      message: "the route response names no CLI-session terminal reason",
      exitCode: 8,
      details: { http_status: 404 },
    }),
    new CunaError({
      code: "cuna.remote.conflict",
      message: "terms changed while the session was refreshed",
      exitCode: 6,
      details: { http_status: 409, reason: "terms_version_mismatch" },
    }),
  ]) {
    const gate = exchangeClock();
    const original = fixture({ backend: gate.backend, clock: gate.clock });
    await original.service.login();
    gate.expireStoredBearer();
    const retryClient = fakeClient({
      async exchange(input) {
        this.calls.push(["exchange", input]);
        throw failure;
      },
      async logout() {
        throw new Error("an unclassified re-exchange failure must not reach a logout mutation");
      },
    });
    const fresh = fixture({ backend: gate.backend, client: retryClient, clock: gate.clock });
    await assert.rejects(
      fresh.service.logout(),
      (error) => error.code === "credential_refresh_failed",
    );
    assert.equal(gate.backend.values.size, 1);
    assert.equal(retryClient.calls.filter(([name]) => name === "exchange").length, 1);
    assert.equal(retryClient.calls.some(([name]) => name === "logout"), false);
  }
});

test("a rate-limited re-exchange names its reason and keeps the encrypted login code", async () => {
  // The server allows ten exchanges per rolling minute and every authenticated
  // command performs one, so this is the eleventh command in a minute: the most
  // likely failure a real user meets. Two properties matter. The reason must
  // survive to the surface, because the caller cannot otherwise tell a wait
  // from a revoked session. And the durable code must stay, because a 429 is
  // not proof that this login-code family was rejected.
  const gate = exchangeClock();
  const original = fixture({ backend: gate.backend, clock: gate.clock });
  await original.service.login();
  gate.expireStoredBearer();
  const limited = fakeClient({
    async exchange(input) {
      this.calls.push(["exchange", input]);
      throw new CunaError({
        code: "cuna.network.rate_limited",
        message: "Cuna is rate limiting this request.",
        exitCode: 5,
        retryable: true,
        details: { http_status: 429 },
      });
    },
    async logout() {
      throw new Error("a rate limit must never reach a logout mutation");
    },
  });
  const fresh = fixture({ backend: gate.backend, client: limited, clock: gate.clock });
  await assert.rejects(
    fresh.service.acquireAccessToken(),
    (error) =>
      error.code === "credential_refresh_failed" &&
      error.retryable === true &&
      error.safeDetails?.reason === "cuna.network.rate_limited",
  );
  assert.equal(gate.backend.values.size, 1, "a rate limit must not remove the durable login code");
  assert.equal(limited.calls.some(([name]) => name === "logout"), false);
});

test("a response-lost logout is cleaned up idempotently when a retry receives definitive 401 re-exchange rejection", async () => {
  const firstClient = fakeClient({
    async logout(token) {
      this.calls.push(["logout", token]);
      // The server has committed family revocation, but its response vanished
      // after that commit. The first CLI must retain the durable code because
      // it has no authoritative receipt yet.
      throw new Error("logout response lost after server commit");
    },
  });
  const gate = exchangeClock();
  const first = fixture({ backend: gate.backend, client: firstClient, clock: gate.clock });
  await first.service.login();
  gate.expireStoredBearer();
  await assert.rejects(first.service.logout(), /logout response lost/u);
  assert.equal(first.backend.values.size, 1);

  const retryClient = fakeClient({
    async exchange(input) {
      this.calls.push(["exchange", input]);
      throw new CunaError({
        code: "cuna.auth.rejected",
        message: "the revoked family cannot mint a new access token",
        exitCode: 3,
        details: { http_status: 401, reason: "cli_session_revoked" },
      });
    },
    async logout() {
      throw new Error("a revoked family must not reach a second logout mutation");
    },
  });
  const retry = fixture({ backend: gate.backend, client: retryClient, clock: gate.clock });
  assert.deepEqual(await retry.service.logout(), { revoked: true });
  assert.equal(first.backend.values.size, 0, "a definitive revoked response must remove the encrypted durable login code");
  assert.equal(retryClient.calls.filter(([name]) => name === "exchange").length, 1);
  assert.equal(retryClient.calls.some(([name]) => name === "logout"), false, "retry cannot re-authorize a remote logout after re-exchange rejection");
});

test("logout treats a definitive direct unauthenticated response as idempotent local cleanup", async () => {
  const failure = new CunaError({
    code: "cuna.auth.rejected",
    message: "revoked access token",
    exitCode: 3,
    details: { http_status: 401, reason: "cli_session_revoked" },
  });
  const subject = fixture({
    client: fakeClient({
      async logout(token) {
        this.calls.push(["logout", token]);
        throw failure;
      },
    }),
  });
  await subject.service.login();
  assert.deepEqual(await subject.service.logout(), { revoked: true });
  assert.equal(subject.backend.values.size, 0);
});

test("logout retains encrypted material for unclassified unauthenticated, not-found, and terms responses", async () => {
  for (const failure of [
    new CunaError({
      code: "cuna.auth.rejected",
      message: "the server did not name a terminal CLI-session reason",
      exitCode: 3,
      details: { http_status: 401 },
    }),
    new CunaError({
      code: "cuna.remote.not_found",
      message: "an unclassified route was not found",
      exitCode: 8,
      details: { http_status: 404 },
    }),
    new CunaError({
      code: "cuna.remote.conflict",
      message: "terms changed while the remote operation was evaluated",
      exitCode: 6,
      details: { http_status: 409, reason: "terms_version_mismatch" },
    }),
    new CunaError({
      code: "cuna.auth.reauthentication_required",
      message: "a nonterminal reauthentication condition is not a logout receipt",
      exitCode: 3,
      details: { http_status: 409, reason: "terms_version_mismatch" },
    }),
  ]) {
    const subject = fixture({
      client: fakeClient({
        async logout(token) {
          this.calls.push(["logout", token]);
          throw failure;
        },
      }),
    });
    await subject.service.login();
    await assert.rejects(subject.service.logout(), (error) => error === failure);
    assert.equal(subject.backend.values.size, 1, "an unclassified remote error must not erase the durable login code");
  }
});

test("confirmed logout cannot delete a newer encrypted session written by another shell", async () => {
  const backend = new MemoryBackend();
  const subject = fixture({ backend });
  await subject.service.login();
  const concurrentVault = new CredentialVault({ backend, clock: () => NOW + 1, platform: "linux" });

  backend.beforeCompareDelete = async () => {
    backend.beforeCompareDelete = undefined;
    const newerMaterial = SecretMaterial.fromUtf8("newer-login-survives-prior-logout");
    try {
      await concurrentVault.rotate({
        binding: HUMAN_SESSION_BINDING,
        material: newerMaterial,
        expectedRevision: 1,
        expiresAt: NOW + 120_000,
      });
    } finally {
      newerMaterial.dispose();
    }
  };

  await assert.rejects(
    subject.service.logout(),
    (error) => error.code === "cuna.auth.session_cleanup_conflict" &&
      error.details?.reason === "newer_local_session",
  );
  const preserved = await concurrentVault.load(HUMAN_SESSION_BINDING);
  assert.equal(preserved.revision, 2);
  assert.equal(
    preserved.material.withBytes((bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    "newer-login-survives-prior-logout",
  );
  preserved.material.dispose();
});

test("access-token cache is byte-backed and zeroized on logout while the HTTP string boundary remains explicit", { concurrency: false }, async () => {
  const created = [];
  const originalFromUtf8 = SecretMaterial.fromUtf8;
  SecretMaterial.fromUtf8 = function capture(value) {
    const material = originalFromUtf8.call(this, value);
    if (value === AT) created.push(material);
    return material;
  };
  try {
    const subject = fixture();
    await subject.service.login();
    assert.equal(created.length, 1, "the long-lived access cache is owned byte-backed material");
    await subject.service.logout();
    assert.equal(created[0].disposed, true, "logout deterministically wipes the owned access-token bytes");
    const logoutCall = subject.client.calls.find(([name]) => name === "logout");
    assert.equal(typeof logoutCall[1], "string", "the managed HTTP client contract still requires an unavoidable transient string");
  } finally {
    SecretMaterial.fromUtf8 = originalFromUtf8;
  }
});

test("human authentication rejects clock rollback and tokens that expire during a slow re-exchange", async () => {
  let now = NOW;
  const rollback = fixture({ clock: () => now });
  await rollback.service.login();
  now = NOW - 1;
  await assert.rejects(
    rollback.service.acquireAccessToken(),
    (error) => error.code === "cuna.auth.clock_untrusted",
  );

  // The bearer has to be past its reuse margin or no exchange happens at all,
  // and the backend evidence has to move with the clock this case advances.
  const slowGate = exchangeClock();
  const original = fixture({ backend: slowGate.backend, clock: slowGate.clock });
  await original.service.login();
  slowGate.expireStoredBearer();
  const slowClient = fakeClient({
    async exchange(input) {
      this.calls.push(["exchange", input]);
      slowGate.advanceTo("2026-08-08T00:10:00.000Z");
      return exchangeResult({ accessToken: AT_2 });
    },
  });
  const slow = fixture({ backend: slowGate.backend, client: slowClient, clock: slowGate.clock });
  await assert.rejects(
    slow.service.acquireAccessToken(),
    (error) => error.code === "cuna.auth.reauthentication_required",
  );
  assert.equal(original.backend.values.size, 0, "an already-expired re-exchange is removed rather than cached");
});

test("exact decoders reject widened, mismatched, and malformed auth responses", () => {
  const bootstrap = {
    enabled: true, completion_mode: "paste_login_code", pkce_method: "S256", continuation_ttl_seconds: 600,
    access_token_ttl_seconds: 600,
    browser_origin: "https://app.getcuna.com",
  };
  assert.equal(decodeCliAuthBootstrap(bootstrap).completionMode, "paste_login_code");
  assert.throws(() => decodeCliAuthBootstrap({ ...bootstrap, future_field: true }));
  assert.throws(() => decodeCliAuthBootstrap({ ...bootstrap, completion_mode: "callback" }));

  const legacyDisabled = {
    enabled: false, completion_mode: "poll", pkce_method: "S256", continuation_ttl_seconds: 600,
    poll_after_ms: 2000, poll_limit: 10, access_token_ttl_seconds: 600, browser_origin: null,
  };
  assert.throws(() => decodeCliAuthBootstrap(legacyDisabled));

  const issued = {
    id: UUID_A,
    browser_url: `https://app.getcuna.com/cli/continue#continuation=${UUID_A}&nonce=cuna_cb_${"n".repeat(43)}&state=${STATE}`,
    expires_at: "2026-08-08T00:10:00.000Z", completion_mode: "paste_login_code",
  };
  const decodedIssued = decodeCliContinuationIssued(issued, { browserOrigin: "https://app.getcuna.com", state: STATE });
  assert.equal(decodedIssued.id, UUID_A);
  assert.equal(Object.hasOwn(decodedIssued, "browserNonce"), false);
  assert.equal(Object.hasOwn(decodedIssued, "continuationSecret"), false);
  assert.throws(() => decodeCliContinuationIssued({ ...issued, continuation_secret: `cuna_ct_${"c".repeat(43)}` }, {
    browserOrigin: "https://app.getcuna.com", state: STATE,
  }));
  assert.throws(() => decodeCliContinuationIssued({
    ...issued,
    browser_url: issued.browser_url.replace("cuna_cb_", "runa_cb_"),
  }, { browserOrigin: "https://app.getcuna.com", state: STATE }));
  assert.throws(() => decodeCliContinuationIssued({ ...issued, browser_url: issued.browser_url.replace(UUID_A, UUID_B) }, {
    browserOrigin: "https://app.getcuna.com", state: STATE,
  }));
  assert.throws(() => decodeCliLoginCodeExchangeResult({ access_token: AT }, LOGIN));
  assert.equal(decodeCliLoginCodeExchangeResult({
    access_token: `cuna_at_${"a".repeat(43)}`,
    token_type: "Bearer",
    expires_in: 600,
    access_expires_at: "2026-08-08T00:10:00.000Z",
    login_code_expires_at: "2026-09-07T00:00:00.000Z",
    session_id: UUID_B,
    context: {
      required_terms_version: "2026-08",
      identity: "active",
      admission: "admitted",
      workspace: { state: "assigned", id: UUID_C },
    },
  }, LOGIN).accessToken.startsWith("cuna_at_"), true);
  assert.equal(decodeRevocation({ revoked: true }), true);
  assert.throws(() => decodeRevocation({ revoked: false }));
  assert.throws(() => decodeRevocation({ revoked: true, ambiguous: true }));
});

// Measured on this host, 2026-08-10: the signed native credential package is
// unadmitted, so the vault backend never probes `verified` and `cuna login`
// can never succeed here. It exited 3 with no hint at all — a dead end, while
// `CUNA_API_KEY` reached production in the same session and was answered on its
// merits. The error must name the path that works.
test("an unusable encrypted local session store names the local repair path", async () => {
  class UnavailableBackend extends MemoryBackend {
    async probe() {
      return {
        protocol: CREDENTIAL_BACKEND_PROTOCOL,
        backendId: this.backendId,
        platform: this.platform,
        status: "unavailable",
        observedAt: NOW,
        expiresAt: NOW + 60_000,
        source: "live_round_trip",
      };
    }
  }
  const subject = fixture({ backend: new UnavailableBackend() });
  await assert.rejects(
    subject.service.login(),
    (error) => error instanceof CunaError &&
      error.code === "cuna.auth.session_store_unavailable" &&
      error.exitCode === 3 &&
      typeof error.hint === "string" &&
      error.hint.includes("cuna doctor") &&
      !error.hint.includes("CUNA_API_KEY"),
  );
  // The alternative is named before any network effect is attempted.
  assert.deepEqual(subject.client.calls, []);
});

// The same fact, the same sentence, at the other site where interactive
// sign-in cannot start: a deployment that does not enable it.
test("a deployment with interactive sign-in disabled names the same alternative", async () => {
  const subject = fixture({
    client: fakeClient({
      async bootstrap() {
        this.calls.push(["bootstrap"]);
        return {
          enabled: false,
          completionMode: "paste_login_code",
          pkceMethod: "S256",
          continuationTtlSeconds: 600,
          accessTokenTtlSeconds: 600,
          browserOrigin: null,
        };
      },
    }),
  });
  await assert.rejects(
    subject.service.login(),
    (error) => error instanceof CunaError &&
      error.code === "cuna.auth.unavailable" &&
      typeof error.hint === "string" &&
      error.hint.includes("CUNA_API_KEY") &&
      error.hint.includes("https://app.getcuna.com/api-keys"),
  );
});
