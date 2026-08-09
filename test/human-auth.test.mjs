import assert from "node:assert/strict";
import test from "node:test";

import {
  CREDENTIAL_BACKEND_PROTOCOL,
  CredentialVault,
} from "../dist/credentials/index.js";
import {
  createHumanAuthService,
  decodeCliAuthBootstrap,
  decodeCliContinuationIssued,
  decodeCliContinuationStatus,
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
const STATE = "x".repeat(43);

const config = Object.freeze({
  platformKind: "linux",
  profile: "default",
  profileSource: "default",
  baseUrl: "https://api.runacode.io",
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
        browserOrigin: "https://app.runacode.io",
      };
    },
    async createContinuation(input) {
      calls.push(["create", input]);
      return {
        id: UUID_A,
        continuationSecret: CT,
        browserUrl: `https://app.runacode.io/cli/continue#continuation=${UUID_A}&nonce=runa_cb_${"n".repeat(43)}&state=${input.state}`,
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
  const vault = new CredentialVault({ backend, clock: () => NOW, platform: "linux" });
  const client = overrides.client ?? fakeClient();
  const opened = [];
  const service = createHumanAuthService({
    config,
    client,
    vault,
    browser: { async open(url) { opened.push(url); } },
    clock: () => NOW,
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

test("exact decoders reject widened, mismatched, and malformed auth responses", () => {
  const bootstrap = {
    enabled: true, completion_mode: "poll", pkce_method: "S256", continuation_ttl_seconds: 600,
    poll_after_ms: 2000, poll_limit: 10, access_token_ttl_seconds: 600,
    refresh_family_ttl_seconds: 2592000, browser_origin: "https://app.runacode.io",
  };
  assert.equal(decodeCliAuthBootstrap(bootstrap).pollLimit, 10);
  assert.throws(() => decodeCliAuthBootstrap({ ...bootstrap, future_field: true }));
  assert.throws(() => decodeCliAuthBootstrap({ ...bootstrap, completion_mode: "callback" }));

  const issued = {
    id: UUID_A, continuation_secret: CT,
    browser_url: `https://app.runacode.io/cli/continue#continuation=${UUID_A}&nonce=runa_cb_${"n".repeat(43)}&state=${STATE}`,
    expires_at: "2026-08-08T00:10:00.000Z", poll_after_ms: 2000, completion_mode: "poll",
  };
  assert.equal(decodeCliContinuationIssued(issued, { browserOrigin: "https://app.runacode.io", state: STATE }).id, UUID_A);
  assert.throws(() => decodeCliContinuationIssued({ ...issued, browser_url: issued.browser_url.replace(UUID_A, UUID_B) }, {
    browserOrigin: "https://app.runacode.io", state: STATE,
  }));
  assert.throws(() => decodeCliContinuationStatus({
    id: UUID_B,
    phase: "completed",
    expires_at: "2026-08-08T00:10:00.000Z",
    required_terms_version: "2026-08",
  }, UUID_A));
  assert.throws(() => decodeCliTokenSet({ access_token: AT }));
  assert.equal(decodeRevocation({ revoked: true }), true);
  assert.throws(() => decodeRevocation({ revoked: false }));
  assert.throws(() => decodeRevocation({ revoked: true, ambiguous: true }));
});
