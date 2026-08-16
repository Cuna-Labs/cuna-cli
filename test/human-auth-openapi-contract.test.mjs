import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  decodeCliAuthBootstrap,
  decodeCliContinuationIssued,
  decodeCliLoginCodeExchangeResult,
} from "../dist/auth/human-contracts.js";

const openapi = JSON.parse(await readFile(
  new URL("../contracts/infra/cuna-api.openapi.json", import.meta.url),
  "utf8",
));

const CONTINUATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const STATE = "s".repeat(43);
const LOGIN_CODE = `cuna_login_${"l".repeat(43)}`;

const strictCliSource = Object.freeze([
  new URL("../src/auth/human-contracts.ts", import.meta.url),
  new URL("../src/auth/human-client.ts", import.meta.url),
  new URL("../src/auth/human-session.ts", import.meta.url),
  new URL("../src/api/http.ts", import.meta.url),
]);

test("CLI source contains no retired terminal continuation protocol", async () => {
  const source = await Promise.all(strictCliSource.map(async (file) => await readFile(file, "utf8")));
  for (const forbidden of [
    "continuation_secret",
    "continuationSecret",
    "poll_after_ms",
    "poll_limit",
    "isLegacyDisabledBootstrap",
    "X-Cuna-Continuation",
    "X-Runa-Continuation",
    "/continuations/${id}/cancel",
    "/v1/cli-auth/refresh",
    "cuna_rt_",
    "refresh_token",
    "refresh_family_ttl_seconds",
  ]) {
    assert.equal(source.some((text) => text.includes(forbidden)), false, forbidden);
  }
  const client = source[1];
  assert.equal(client.includes('method: "GET",\n        path: `/v1/cli-auth/continuations/${id}`'), false);
});

test("installed auth decoders consume the exact producer paste-code shapes", () => {
  const bootstrapSchema = openapi.components.schemas.CliAuthBootstrap;
  assert.deepEqual(bootstrapSchema.required, [
    "enabled",
    "completion_mode",
    "pkce_method",
    "continuation_ttl_seconds",
    "access_token_ttl_seconds",
    "browser_origin",
  ]);
  assert.equal(bootstrapSchema.properties.completion_mode.const, "paste_login_code");
  assert.equal(bootstrapSchema.properties.poll_after_ms, undefined);
  assert.equal(bootstrapSchema.properties.poll_limit, undefined);
  assert.equal(decodeCliAuthBootstrap({
    enabled: true,
    completion_mode: "paste_login_code",
    pkce_method: "S256",
    continuation_ttl_seconds: 600,
    access_token_ttl_seconds: 600,
    browser_origin: "https://app.getcuna.com",
  }).completionMode, "paste_login_code");

  const issuedSchema = openapi.components.schemas.CliContinuationIssued;
  assert.deepEqual(issuedSchema.required, ["id", "browser_url", "expires_at", "completion_mode"]);
  assert.equal(issuedSchema.additionalProperties, false);
  assert.equal(issuedSchema.properties.continuation_secret, undefined);
  assert.equal(issuedSchema.properties.completion_mode.const, "paste_login_code");
  assert.equal(issuedSchema.properties.browser_url.pattern, "^https://[^/?#@]+/cli/continue#[^?#]+$");
  const issued = {
    id: CONTINUATION_ID,
    browser_url: `https://app.getcuna.com/cli/continue#continuation=${CONTINUATION_ID}&nonce=cuna_cb_${"n".repeat(43)}&state=${STATE}`,
    expires_at: "2030-01-01T00:10:00.000Z",
    completion_mode: "paste_login_code",
  };
  const decoded = decodeCliContinuationIssued(issued, { browserOrigin: "https://app.getcuna.com", state: STATE });
  assert.equal(decoded.completionMode, "paste_login_code");
  assert.equal(Object.hasOwn(decoded, "continuationSecret"), false);
  assert.equal(Object.hasOwn(decoded, "browserNonce"), false);
  assert.throws(() => decodeCliContinuationIssued({
    ...issued,
    continuation_secret: `cuna_ct_${"c".repeat(43)}`,
  }, { browserOrigin: "https://app.getcuna.com", state: STATE }));
  assert.throws(() => decodeCliContinuationIssued({
    ...issued,
    browser_url: issued.browser_url.replace("cuna_cb_", "runa_cb_"),
  }, { browserOrigin: "https://app.getcuna.com", state: STATE }));
  assert.throws(() => decodeCliContinuationIssued({
    ...issued,
    browser_url: issued.browser_url.replace("https://", "https://untrusted@"),
  }, { browserOrigin: "https://app.getcuna.com", state: STATE }));
  assert.throws(() => decodeCliContinuationIssued({
    ...issued,
    browser_url: `${issued.browser_url}?query-in-fragment`,
  }, { browserOrigin: "https://app.getcuna.com", state: STATE }));
  assert.equal(
    decodeCliContinuationIssued({
      ...issued,
      browser_url: issued.browser_url.replace("https://app.getcuna.com", "https://staging.getcuna.com:8443"),
    }, { browserOrigin: "https://staging.getcuna.com:8443", state: STATE }).id,
    CONTINUATION_ID,
  );
});

test("producer exposes no CLI secret polling or terminal cancellation route", () => {
  assert.equal(openapi.paths["/v1/cli-auth/refresh"], undefined);
  assert.equal(openapi.paths["/v1/cli-auth/continuations/{id}"], undefined);
  assert.equal(openapi.paths["/v1/cli-auth/continuations/{id}/cancel"], undefined);
  assert.equal(openapi.components.parameters.CliContinuationSecret, undefined);
  assert.equal(openapi.components.schemas.CliContinuationSecret, undefined);
  assert.equal(openapi.components.schemas.CliContinuationStatus, undefined);
  assert.equal(openapi.components.schemas.CliRefreshRequest, undefined);
  assert.equal(openapi.components.schemas.CliTokenSet, undefined);
  assert.equal(JSON.stringify(openapi).includes("cuna_rt_"), false);
  assert.equal(JSON.stringify(openapi).includes("refresh_token"), false);

  const browserCancel = openapi.paths["/v1/cli-auth/continuations/{id}/browser-cancel"].post;
  assert.deepEqual(browserCancel.security, [{ SupabaseJwt: [] }]);
  const cancelSchema = openapi.components.schemas.CliContinuationBrowserCancel;
  assert.deepEqual(cancelSchema.required, ["browser_nonce", "state"]);
  assert.equal(cancelSchema.properties.browser_nonce.pattern, "^cuna_cb_[A-Za-z0-9_-]{43}$");
});

test("every durable login-code exchange binds and returns the authoritative expiry", () => {
  const exchangeResult = openapi.components.schemas.CliLoginCodeExchangeResult;
  assert.ok(exchangeResult.required.includes("login_code_expires_at"));
  assert.equal(exchangeResult.properties.refresh_token, undefined);
  const response = {
    access_token: `cuna_at_${"a".repeat(43)}`,
    token_type: "Bearer",
    expires_in: 600,
    access_expires_at: "2030-01-01T00:10:00.000Z",
    login_code_expires_at: "2030-01-30T00:00:00.000Z",
    session_id: "223e4567-e89b-42d3-a456-426614174000",
    context: {
      required_terms_version: "2026-08",
      identity: "active",
      admission: "admitted",
      workspace: { state: "assigned", id: "323e4567-e89b-42d3-a456-426614174000" },
    },
  };
  assert.equal(decodeCliLoginCodeExchangeResult(response, LOGIN_CODE).loginCodeExpiresAt, response.login_code_expires_at);
  assert.throws(() => decodeCliLoginCodeExchangeResult(response, LOGIN_CODE, "2030-01-29T00:00:00.000Z"));
  assert.throws(() => decodeCliLoginCodeExchangeResult({ ...response, login_code_expires_at: undefined }, LOGIN_CODE));
});

test("producer uses one complete seven-intent authority from continuation creation through browser completion", () => {
  const intents = [
    "signup", "login", "account.read", "machines.read", "machines.create",
    "agent_sessions.read", "agent_sessions.create",
  ];
  assert.deepEqual(openapi.components.schemas.CliContinuationCreate.properties.intent_class.enum, intents);
  const completed = openapi.components.schemas.CliContinuationCompleted;
  assert.equal(completed.properties.phase.const, "completed");
  assert.deepEqual(completed.properties.request_context.properties.intent.enum, intents);
  assert.equal(completed.properties.request_context.properties.client_name.const, "Cuna CLI");
  assert.deepEqual(completed.properties.request_context.properties.scopes.const, ["cli:session"]);
});

test("OpenCode AgentSession creation is interactive-only at the producer boundary", () => {
  const create = openapi.components.schemas.AgentSessionCreate;
  const openCodeBranch = create.oneOf.find((branch) => branch.properties?.agent?.const === "opencode");
  assert.deepEqual(openCodeBranch.required, ["agent", "auth_mode"]);
  assert.equal(openCodeBranch.properties.auth_mode.const, "interactive_login");
  assert.deepEqual(openCodeBranch.not.required, ["credential_binding_id"]);
});
