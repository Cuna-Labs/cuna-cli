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

function fixture(overrides = {}) {
  const backend = overrides.backend ?? new MemoryBackend();
  const clock = overrides.clock ?? (() => NOW);
  const vault = new CredentialVault({ backend, clock, platform: "linux" });
  const client = overrides.client ?? fakeClient();
  const opened = [];
  const service = createHumanAuthService({
    config,
    client,
    vault,
    browser: { async open(url) { opened.push(url); } },
    clock,
    random: (size) => new Uint8Array(size).fill(7),
    uuid: () => UUID_A,
    readLoginCode: overrides.readLoginCode ?? (async () => LOGIN),
  });
  return { backend, vault, client, opened, service };
}

test("login persists durable exchange authority but no access token", async () => {
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
  assert.equal(protectedBytes.includes(AT), false);
  assert.equal(protectedBytes.includes("code_verifier"), true);
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
  const signedUp = fixture({ client: signupClient });
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
  const admitted = fixture({ backend: signedUp.backend, client: admittedClient });
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
  const substituted = fixture({
    backend: signedUp.backend,
    client: substitutedClient,
  });
  await assert.rejects(
    substituted.service.acquireAccessToken(),
    (error) => error.code === "cuna.auth.reauthentication_required",
  );
  assert.equal(signedUp.backend.values.size, 0);
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

test("re-exchange races coalesce, retain the durable code once, and keep access tokens memory-only", async () => {
  const original = fixture();
  await original.service.login();
  const nextClient = fakeClient();
  const next = fixture({ backend: original.backend, client: nextClient });
  const tokens = await Promise.all(Array.from({ length: 12 }, () => next.service.acquireAccessToken()));
  assert.deepEqual(new Set(tokens), new Set([AT_2]));
  const exchanges = nextClient.calls.filter(([name]) => name === "exchange");
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0][1].expectedLoginCodeExpiresAt, "2026-09-07T00:00:00.000Z");
  assert.equal(JSON.stringify(nextClient.calls).includes(LOGIN), true);
  assert.equal(Buffer.concat([...original.backend.values.values()].map((value) => Buffer.from(value))).toString("utf8").includes(AT_2), false);

  const laterClient = fakeClient({
    async exchange(input) {
      this.calls.push(["exchange", input]);
      return exchangeResult({ accessToken: AT_3 });
    },
  });
  const later = fixture({ backend: original.backend, client: laterClient });
  assert.equal(await later.service.acquireAccessToken(), AT_3);
  assert.equal(laterClient.calls.filter(([name]) => name === "exchange").length, 1);
  assert.equal(laterClient.calls.find(([name]) => name === "exchange")[1].loginCode, LOGIN);
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
  assert.equal(client.calls.filter(([name]) => name === "exchange").length, 1);
  assert.equal(client.calls.filter(([name]) => name === "context").length, 1);
  // A fresh service still proves the backend once and reads its encrypted
  // record once. The old path did an initial load, a re-exchange read, and a
  // post-context load for the same immutable identity metadata.
  assert.equal(original.backend.probeCalls, 1);
  assert.equal(original.backend.readCalls, 1);
});

test("one cancelled re-exchange waiter neither aborts nor poisons the shared credential read", async () => {
  const original = fixture();
  await original.service.login();
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
  const subject = fixture({ backend: original.backend, client });
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
  const first = fixture();
  await first.service.login();
  const rejectedClient = fakeClient({
    async exchange() {
      throw new CunaError({
        code: "cuna.auth.rejected", message: "rejected", exitCode: 3,
        details: { http_status: 401, reason: "cli_session_revoked" },
      });
    },
  });
  const rejected = fixture({ backend: first.backend, client: rejectedClient });
  await assert.rejects(rejected.service.acquireAccessToken(), (error) => error.code === "cuna.auth.reauthentication_required");
  assert.equal(first.backend.values.size, 0);

  const second = fixture();
  await second.service.login();
  const unknown = fixture({ backend: second.backend, client: fakeClient({ async exchange() { throw new Error("network secret"); } }) });
  await assert.rejects(unknown.service.acquireAccessToken());
  assert.equal(second.backend.values.size, 1);

  const third = fixture();
  await third.service.login();
  const invalidContext = fixture({
    backend: third.backend,
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
  assert.equal(third.backend.values.size, 0);
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
    const original = fixture();
    await original.service.login();
    const retryClient = fakeClient({
      async exchange(input) {
        this.calls.push(["exchange", input]);
        throw failure;
      },
      async logout() {
        throw new Error("an unclassified re-exchange failure must not reach a logout mutation");
      },
    });
    const fresh = fixture({ backend: original.backend, client: retryClient });
    await assert.rejects(
      fresh.service.logout(),
      (error) => error.code === "credential_refresh_failed",
    );
    assert.equal(original.backend.values.size, 1);
    assert.equal(retryClient.calls.filter(([name]) => name === "exchange").length, 1);
    assert.equal(retryClient.calls.some(([name]) => name === "logout"), false);
  }
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
  const first = fixture({ client: firstClient });
  await first.service.login();
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
  const retry = fixture({ backend: first.backend, client: retryClient });
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

  const original = fixture();
  await original.service.login();
  let slowNow = NOW;
  const slowClient = fakeClient({
    async exchange(input) {
      this.calls.push(["exchange", input]);
      slowNow = Date.parse("2026-08-08T00:10:00.000Z");
      return exchangeResult({ accessToken: AT_2 });
    },
  });
  const slow = fixture({ backend: original.backend, client: slowClient, clock: () => slowNow });
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
