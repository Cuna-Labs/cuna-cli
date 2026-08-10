import assert from "node:assert/strict";
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
  decodeCliContinuationStatus,
  decodeCliSignupCapability,
  decodeCliTokenSet,
  decodeRevocation,
  RunaError,
} from "../dist/index.js";

const NOW = Date.parse("2026-08-08T00:00:00.000Z");
const UUID_A = "00000000-0000-0000-0000-000000000001";
const UUID_B = "00000000-0000-0000-0000-000000000002";
const UUID_C = "00000000-0000-0000-0000-000000000003";
const CT = `runa_ct_${"c".repeat(43)}`;
const AT = `runa_at_${"a".repeat(43)}`;
const AT_2 = `runa_at_${"b".repeat(43)}`;
const RT = `runa_rt_${"r".repeat(43)}`;
const RT_2 = `runa_rt_${"s".repeat(43)}`;
const AT_3 = `runa_at_${"d".repeat(43)}`;
const RT_3 = `runa_rt_${"t".repeat(43)}`;
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
  async probe() {
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
  async read(target) { return this.values.has(target) ? Uint8Array.from(this.values.get(target)) : undefined; }
  async replace(target, value) { this.values.set(target, Uint8Array.from(value)); }
  async delete(target) { return this.values.delete(target) ? "deleted" : "absent"; }
}

function tokenSet(overrides = {}) {
  return {
    accessToken: AT,
    refreshToken: RT,
    tokenType: "Bearer",
    expiresIn: 600,
    accessExpiresAt: "2026-08-08T00:10:00.000Z",
    refreshExpiresAt: "2026-09-07T00:00:00.000Z",
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
        completionMode: "poll",
        pkceMethod: "S256",
        continuationTtlSeconds: 600,
        pollAfterMs: 2000,
        pollLimit: 3,
        accessTokenTtlSeconds: 600,
        refreshFamilyTtlSeconds: 2592000,
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
        continuationSecret: CT,
        browserUrl: `https://app.getcuna.com/cli/continue#continuation=${UUID_A}&nonce=runa_cb_${"n".repeat(43)}&state=${input.state}`,
        browserNonce: `runa_cb_${"n".repeat(43)}`,
        expiresAt: "2026-08-08T00:10:00.000Z",
        pollAfterMs: 2000,
        completionMode: "poll",
      };
    },
    async continuation(input) {
      calls.push(["poll", input]);
      return {
        id: UUID_A,
        phase: "completed",
        expiresAt: "2026-08-08T00:10:00.000Z",
        context,
        requiredTermsVersion: "2026-08",
      };
    },
    async cancel(input) {
      calls.push(["cancel", input]);
      return { id: UUID_A, phase: "cancelled", expiresAt: "2026-08-08T00:10:00.000Z", requiredTermsVersion: "2026-08" };
    },
    async exchange(input) { calls.push(["exchange", input]); return tokenSet(); },
    async refresh(input) { calls.push(["refresh", input]); return tokenSet({ accessToken: AT_2, refreshToken: RT_2 }); },
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
    sleep: overrides.sleep ?? (async () => undefined),
    random: (size) => new Uint8Array(size).fill(7),
    uuid: () => UUID_A,
  });
  return { backend, vault, client, opened, service };
}

test("login uses polling-only PKCE, opens the exact issued URL, and persists no access token", async () => {
  const subject = fixture();
  const result = await subject.service.login();
  assert.equal(result.sessionId, UUID_B);
  assert.equal(subject.opened.length, 1);
  const create = subject.client.calls.find(([name]) => name === "create")[1];
  assert.match(create.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/u);
  assert.equal(Object.hasOwn(create, "codeVerifier"), false);
  assert.equal(subject.client.calls.filter(([name]) => name === "exchange").length, 1);
  const protectedBytes = Buffer.concat([...subject.backend.values.values()].map((value) => Buffer.from(value))).toString("utf8");
  assert.equal(protectedBytes.includes(AT), false);
  assert.equal(protectedBytes.includes("code_verifier"), false);
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
    async continuation(input) {
      this.calls.push(["poll", input]);
      return {
        id: UUID_A,
        phase: "completed",
        expiresAt: "2026-08-08T00:10:00.000Z",
        context: waitlisted,
        requiredTermsVersion: "2026-08",
      };
    },
    async exchange(input) {
      this.calls.push(["exchange", input]);
      return tokenSet({ context: waitlisted });
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
    async refresh(input) {
      this.calls.push(["refresh", input]);
      return tokenSet({
        accessToken: AT_2,
        refreshToken: RT_2,
        context: admittedContext,
      });
    },
  });
  const admitted = fixture({ backend: signedUp.backend, client: admittedClient });
  assert.equal(await admitted.service.acquireAccessToken(), AT_2);

  const substitutedClient = fakeClient({
    async refresh(input) {
      this.calls.push(["refresh", input]);
      return tokenSet({
        accessToken: AT_3,
        refreshToken: RT_3,
        context: {
          ...admittedContext,
          workspace: { state: "assigned", id: UUID_B },
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
    (error) => error.code === "runa.auth.reauthentication_required",
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
  await assert.rejects(subject.service.login(), (error) => error.code === "runa.auth.already_signed_in");
  assert.equal(subject.client.calls.filter(([name]) => name === "create").length, creates);
});

test("cancellation and bounded timeout call the secret-authorized cancellation endpoint", async () => {
  const controller = new AbortController();
  const cancelled = fixture({
    sleep: async () => {
      controller.abort(new Error("operator interrupt"));
      throw new DOMException("cancelled", "AbortError");
    },
  });
  await assert.rejects(cancelled.service.login({ signal: controller.signal }), (error) => error.code === "runa.auth.cancelled");
  assert.equal(cancelled.client.calls.some(([name, request]) => name === "cancel" && request.secret === CT), true);

  const timedClient = fakeClient({
    async continuation(input) {
      this.calls.push(["poll", input]);
      return { id: UUID_A, phase: "issued", expiresAt: "2026-08-08T00:10:00.000Z", pollAfterMs: 2000, requiredTermsVersion: "2026-08" };
    },
  });
  const timed = fixture({ client: timedClient });
  await assert.rejects(timed.service.login(), (error) => error.code === "runa.auth.timeout");
  assert.equal(timed.client.calls.filter(([name]) => name === "poll").length, 3);
  assert.equal(timed.client.calls.some(([name]) => name === "cancel"), true);
});

test("a pre-aborted sign-in performs no vault, browser, or network effect", async () => {
  const subject = fixture();
  subject.backend.probe = async () => { throw new Error("vault probe must not run"); };
  const controller = new AbortController();
  controller.abort(new Error("operator interrupt"));
  await assert.rejects(
    subject.service.login({ signal: controller.signal }),
    (error) => error.code === "runa.auth.cancelled",
  );
  assert.deepEqual(subject.client.calls, []);
  assert.deepEqual(subject.opened, []);
  assert.equal(subject.backend.values.size, 0);
});

test("consumed replay never exchanges and post-exchange validation failure revokes the new family", async () => {
  const replayClient = fakeClient({
    async continuation(input) {
      this.calls.push(["poll", input]);
      return { id: UUID_A, phase: "consumed", expiresAt: "2026-08-08T00:10:00.000Z", requiredTermsVersion: "2026-08" };
    },
  });
  const replay = fixture({ client: replayClient });
  await assert.rejects(replay.service.login(), (error) => error.code === "runa.auth.continuation_consumed");
  assert.equal(replay.client.calls.some(([name]) => name === "exchange"), false);

  const mismatchClient = fakeClient({
    async exchange(input) {
      this.calls.push(["exchange", input]);
      return tokenSet({ context: { ...context, requiredTermsVersion: "other" } });
    },
  });
  const mismatch = fixture({ client: mismatchClient });
  await assert.rejects(mismatch.service.login(), (error) => error.code === "runa.auth.context_mismatch");
  assert.equal(mismatch.client.calls.some(([name, token]) => name === "logout" && token === AT), true);
  assert.equal(mismatch.backend.values.size, 0);

  const failingBackend = new MemoryBackend();
  failingBackend.replace = async () => { throw new Error("vault write unavailable"); };
  const vaultFailure = fixture({ backend: failingBackend });
  await assert.rejects(vaultFailure.service.login());
  assert.equal(vaultFailure.client.calls.some(([name, token]) => name === "logout" && token === AT), true);
  assert.equal(failingBackend.values.size, 0);
});

test("refresh races coalesce, rotate the vault once, and keep access tokens memory-only", async () => {
  const original = fixture();
  await original.service.login();
  const nextClient = fakeClient();
  const next = fixture({ backend: original.backend, client: nextClient });
  const tokens = await Promise.all(Array.from({ length: 12 }, () => next.service.acquireAccessToken()));
  assert.deepEqual(new Set(tokens), new Set([AT_2]));
  const refreshes = nextClient.calls.filter(([name]) => name === "refresh");
  assert.equal(refreshes.length, 1);
  assert.match(refreshes[0][1].idempotencyKey, /^refresh-[A-Za-z0-9_-]{43}$/u);
  assert.equal(JSON.stringify(nextClient.calls).includes(RT), true);
  assert.equal(Buffer.concat([...original.backend.values.values()].map((value) => Buffer.from(value))).toString("utf8").includes(AT_2), false);
});

test("one cancelled refresh waiter neither aborts nor poisons the shared credential rotation", async () => {
  const original = fixture();
  await original.service.login();
  let releaseRefresh;
  let refreshEntered;
  const entered = new Promise((resolve) => { refreshEntered = resolve; });
  const client = fakeClient({
    async refresh(input) {
      this.calls.push(["refresh", input]);
      refreshEntered();
      await new Promise((resolve) => { releaseRefresh = resolve; });
      return tokenSet({ accessToken: AT_2, refreshToken: RT_2 });
    },
  });
  const subject = fixture({ backend: original.backend, client });
  const controller = new AbortController();
  const cancelled = subject.service.acquireAccessToken(controller.signal);
  await entered;
  const surviving = subject.service.acquireAccessToken();
  controller.abort(new Error("caller no longer needs the token"));
  await assert.rejects(cancelled, (error) => error.code === "runa.auth.cancelled");
  releaseRefresh();
  assert.equal(await surviving, AT_2);
  const refreshes = client.calls.filter(([name]) => name === "refresh");
  assert.equal(refreshes.length, 1);
  assert.equal(Object.hasOwn(refreshes[0][1], "signal"), false, "caller cancellation cannot own shared refresh authority");
});

test("authoritative refresh rejection deletes the family while unknown failure preserves it", async () => {
  const first = fixture();
  await first.service.login();
  const rejectedClient = fakeClient({
    async refresh() {
      throw new RunaError({
        code: "runa.auth.rejected", message: "rejected", exitCode: 3, details: { reason: "cli_refresh_reuse" },
      });
    },
  });
  const rejected = fixture({ backend: first.backend, client: rejectedClient });
  await assert.rejects(rejected.service.acquireAccessToken(), (error) => error.code === "runa.auth.reauthentication_required");
  assert.equal(first.backend.values.size, 0);

  const second = fixture();
  await second.service.login();
  const unknown = fixture({ backend: second.backend, client: fakeClient({ async refresh() { throw new Error("network secret"); } }) });
  await assert.rejects(unknown.service.acquireAccessToken());
  assert.equal(second.backend.values.size, 1);

  const third = fixture();
  await third.service.login();
  const invalidContext = fixture({
    backend: third.backend,
    client: fakeClient({
      async refresh(input) {
        this.calls.push(["refresh", input]);
        return tokenSet({
          accessToken: AT_2,
          refreshToken: RT_2,
          context: { ...context, admission: "waitlisted", workspace: { state: "unavailable" } },
        });
      },
      async logout(token) { this.calls.push(["logout", token]); throw new Error("unknown logout"); },
    }),
  });
  await assert.rejects(invalidContext.service.acquireAccessToken(), (error) => error.code === "runa.auth.reauthentication_required");
  assert.equal(third.backend.values.size, 0);
  assert.equal(invalidContext.client.calls.some(([name, token]) => name === "logout" && token === AT_2), true);
});

test("logout is server-first and deletes local state only after exact revoked true", async () => {
  const original = fixture();
  await original.service.login();
  const unknown = fixture({ backend: original.backend, client: fakeClient({ async logout() { throw new Error("unknown"); } }) });
  await assert.rejects(unknown.service.logout());
  assert.equal(original.backend.values.size, 1);

  const confirmed = fixture({
    backend: original.backend,
    client: fakeClient({
      async refresh(input) {
        this.calls.push(["refresh", input]);
        return tokenSet({
          accessToken: `runa_at_${"d".repeat(43)}`,
          refreshToken: `runa_rt_${"t".repeat(43)}`,
        });
      },
    }),
  });
  assert.deepEqual(await confirmed.service.logout(), { revoked: true });
  assert.equal(original.backend.values.size, 0);
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

test("human authentication rejects clock rollback and tokens that expire during a slow refresh", async () => {
  let now = NOW;
  const rollback = fixture({ clock: () => now });
  await rollback.service.login();
  now = NOW - 1;
  await assert.rejects(
    rollback.service.acquireAccessToken(),
    (error) => error.code === "runa.auth.clock_untrusted",
  );

  const original = fixture();
  await original.service.login();
  let slowNow = NOW;
  const slowClient = fakeClient({
    async refresh(input) {
      this.calls.push(["refresh", input]);
      slowNow = Date.parse("2026-08-08T00:10:00.000Z");
      return tokenSet({ accessToken: AT_2, refreshToken: RT_2 });
    },
  });
  const slow = fixture({ backend: original.backend, client: slowClient, clock: () => slowNow });
  await assert.rejects(
    slow.service.acquireAccessToken(),
    (error) => error.code === "runa.auth.reauthentication_required",
  );
  assert.equal(original.backend.values.size, 0, "an already-expired rotated family is removed rather than cached");
});

test("exact decoders reject widened, mismatched, and malformed auth responses", () => {
  const bootstrap = {
    enabled: true, completion_mode: "poll", pkce_method: "S256", continuation_ttl_seconds: 600,
    poll_after_ms: 2000, poll_limit: 10, access_token_ttl_seconds: 600,
    refresh_family_ttl_seconds: 2592000, browser_origin: "https://app.getcuna.com",
  };
  assert.equal(decodeCliAuthBootstrap(bootstrap).pollLimit, 10);
  assert.throws(() => decodeCliAuthBootstrap({ ...bootstrap, future_field: true }));
  assert.throws(() => decodeCliAuthBootstrap({ ...bootstrap, completion_mode: "callback" }));

  const issued = {
    id: UUID_A, continuation_secret: CT,
    browser_url: `https://app.getcuna.com/cli/continue#continuation=${UUID_A}&nonce=runa_cb_${"n".repeat(43)}&state=${STATE}`,
    expires_at: "2026-08-08T00:10:00.000Z", poll_after_ms: 2000, completion_mode: "poll",
  };
  assert.equal(decodeCliContinuationIssued(issued, { browserOrigin: "https://app.getcuna.com", state: STATE }).id, UUID_A);
  const cunaIssued = {
    ...issued,
    continuation_secret: `cuna_ct_${"c".repeat(43)}`,
    browser_url: `https://app.getcuna.com/cli/continue#continuation=${UUID_A}&nonce=cuna_cb_${"n".repeat(43)}&state=${STATE}`,
  };
  assert.equal(decodeCliContinuationIssued(cunaIssued, { browserOrigin: "https://app.getcuna.com", state: STATE }).browserNonce.startsWith("cuna_cb_"), true);
  assert.throws(() => decodeCliContinuationIssued({ ...issued, browser_url: issued.browser_url.replace(UUID_A, UUID_B) }, {
    browserOrigin: "https://app.getcuna.com", state: STATE,
  }));
  assert.throws(() => decodeCliContinuationStatus({
    id: UUID_B,
    phase: "completed",
    expires_at: "2026-08-08T00:10:00.000Z",
    required_terms_version: "2026-08",
  }, UUID_A));
  assert.throws(() => decodeCliTokenSet({ access_token: AT }));
  assert.equal(decodeCliTokenSet({
    access_token: `cuna_at_${"a".repeat(43)}`,
    refresh_token: `cuna_rt_${"r".repeat(43)}`,
    token_type: "Bearer",
    expires_in: 600,
    access_expires_at: "2026-08-08T00:10:00.000Z",
    refresh_expires_at: "2026-09-07T00:00:00.000Z",
    session_id: UUID_B,
    context: {
      required_terms_version: "2026-08",
      identity: "active",
      admission: "admitted",
      workspace: { state: "assigned", id: UUID_C },
    },
  }).accessToken.startsWith("cuna_at_"), true);
  assert.equal(decodeRevocation({ revoked: true }), true);
  assert.throws(() => decodeRevocation({ revoked: false }));
  assert.throws(() => decodeRevocation({ revoked: true, ambiguous: true }));
});
