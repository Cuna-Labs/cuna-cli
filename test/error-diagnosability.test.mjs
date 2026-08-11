import assert from "node:assert/strict";
import test from "node:test";

import {
  API_KEYS_URL,
  ContractViolation,
  CunaError,
  SUPPORT_URL,
  createHttpTransport,
  createCunaApiClient,
  decodeCunaIdentity,
  memoryStreams,
  runCli,
} from "../dist/index.js";

/* -------------------------------------------------------------------------- */
/* Why this file exists                                                        */
/*                                                                             */
/* Measured against production with a valid credential, five commands:         */
/*                                                                             */
/*   capabilities   details YES   hint YES                                     */
/*   records list   details YES   hint YES                                     */
/*   account show   details NO    hint NO                                      */
/*   workspace show details NO    hint NO                                      */
/*   usage show     details NO    hint NO                                      */
/*                                                                             */
/* The best diagnostics were on the failure a user can do least about, and the */
/* failure they actually hit — `cuna.remote.malformed_response`, exit 7 — shipped */
/* one sentence and nothing else. The decoders knew which predicate failed and  */
/* the client discarded it.                                                     */
/* -------------------------------------------------------------------------- */

const API_KEY = `cuna_sk_${"a".repeat(43)}`;
const USER_ID = "11111111-1111-4111-8111-111111111111";
const EMAIL = "developer@example.test";

/**
 * The exact `/v1/me` body production serves today: `assigned` is true and
 * `workspace.id` is absent, which the canonical OpenAPI marks required. This is
 * not a hypothetical — it is why `account show`, `workspace show` and
 * `usage show` all fail against the deployed API right now.
 */
function productionIdentityBody() {
  return {
    id: USER_ID,
    email: EMAIL,
    workspace: {
      assigned: true,
      usage: { est_spend_usd: 1, est_remaining_usd: 49, note: "estimate" },
    },
  };
}

function clientReturning(body, status = 200) {
  return createCunaApiClient(createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    apiKey: API_KEY,
    fetch: async () => new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  }));
}

/* -------------------------------------------------------------------------- */
/* S-1: the offending field survives the throw                                 */
/* -------------------------------------------------------------------------- */

test("a malformed response names the operation and the field that did not match", async () => {
  await assert.rejects(
    clientReturning(productionIdentityBody()).getIdentity(),
    (error) => {
      assert.ok(error instanceof CunaError);
      assert.equal(error.code, "cuna.remote.malformed_response");
      assert.equal(error.exitCode, 7);
      // The three facts a user needs and could not previously obtain without
      // isolating the decoder in a throwaway script.
      assert.equal(error.details?.operation, "GET /v1/me");
      assert.equal(error.details?.field, "workspace.id");
      assert.equal(error.details?.predicate, "required_when_workspace_assigned");
      return true;
    },
  );
});

test("a different field in the same response yields a different field name", async () => {
  // Without this, one hard-coded `field` would satisfy the test above. The
  // authority here is the response body, not the decoder's own list.
  const body = productionIdentityBody();
  body.workspace.id = "22222222-2222-4222-8222-222222222222";
  body.workspace.usage.est_spend_usd = "1";
  await assert.rejects(
    clientReturning(body).getIdentity(),
    (error) => error instanceof CunaError &&
      error.details?.field === "workspace.usage.est_spend_usd" &&
      error.details?.predicate === "finite_number",
  );
});

test("a malformed item inside a page names its index", async () => {
  await assert.rejects(
    clientReturning({ items: [{ id: USER_ID }, { id: "not-a-uuid" }] }).listMachines(),
    (error) => error instanceof CunaError &&
      error.details?.operation === "GET /v1/sessions" &&
      error.details?.field === "items[1].id" &&
      error.details?.predicate === "canonical_uuid",
  );
});

/* -------------------------------------------------------------------------- */
/* S-1: names and shapes only — never response values                          */
/* -------------------------------------------------------------------------- */

test("malformed-response details disclose no value from the response body", async () => {
  // A `/v1/me` body carries an email address; an `/v1/api-keys` body carries key
  // metadata. `details` is printed to the terminal AND emitted in `--json`, so a
  // value echoed here is a value written to whatever consumes that record.
  const secret = `cuna_sk_${"z".repeat(43)}`;
  const body = productionIdentityBody();
  body.email = secret;
  await assert.rejects(
    clientReturning(body).getIdentity(),
    (error) => {
      const rendered = JSON.stringify(error.details);
      assert.ok(!rendered.includes(secret), "details must not echo a credential-shaped value");
      assert.ok(!rendered.includes(EMAIL), "details must not echo an address from the body");
      // A substring scan alone is a blind guard: it passes for any leak whose
      // value this test did not happen to plant. The real control is that the
      // key set is CLOSED. Three keys, all of them derived from the request or
      // from this source tree, none of them from the payload.
      assert.deepEqual(Object.keys(error.details).sort(), ["field", "operation", "predicate"]);
      for (const value of Object.values(error.details)) {
        assert.equal(typeof value, "string");
      }
      return true;
    },
  );
});

test("a decode failure with no known field still carries a closed key set", async () => {
  await assert.rejects(
    clientReturning(["not", "an", "object"]).getIdentity(),
    (error) => {
      // `field` is absent when the check spans no one key — the error must not
      // invent a location. What may never vary is the ADMITTED set.
      const keys = Object.keys(error.details);
      assert.ok(keys.every((key) => ["field", "operation", "predicate"].includes(key)), keys.join(","));
      assert.ok(keys.includes("operation") && keys.includes("predicate"));
      return true;
    },
  );
});

/* -------------------------------------------------------------------------- */
/* S-2: the hint says what to do, and names a destination                      */
/* -------------------------------------------------------------------------- */

test("a malformed response tells the user this cannot be fixed locally, and where to report it", async () => {
  await assert.rejects(
    clientReturning(productionIdentityBody()).getIdentity(),
    (error) => {
      assert.equal(typeof error.hint, "string");
      assert.ok(error.hint.includes(SUPPORT_URL), error.hint);
      // Literal oracle. Deriving the expectation from the constant alone would
      // survive the constant being changed to something meaningless.
      assert.ok(error.hint.includes("https://github.com/Cuna-Labs/cuna-cli/issues"));
      return true;
    },
  );
});

test("a body that is not JSON at all is told apart from a body of the wrong shape", async () => {
  const transport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    apiKey: API_KEY,
    fetch: async () => new Response("not json", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }),
  });
  await assert.rejects(
    transport.request({ method: "GET", path: "/v1/me" }),
    (error) => error instanceof CunaError &&
      error.code === "cuna.remote.malformed_response" &&
      error.details?.operation === "GET /v1/me" &&
      // Not a field predicate: this points at a proxy or a truncated transfer,
      // which is a different investigation from "the API is behind its contract".
      error.details?.predicate === "response_body_is_json" &&
      typeof error.hint === "string" && error.hint.length > 0,
  );
});

/* -------------------------------------------------------------------------- */
/* S-1/S-2 end to end, through the real dispatcher and the real output writer  */
/* -------------------------------------------------------------------------- */

test("account show against the deployed body prints the field and the hint", async () => {
  const streams = memoryStreams();
  const exit = await runCli(["account", "show", "--json"], {
    streams: streams.streams,
    env: { CUNA_API_KEY: API_KEY },
    platform: {
      kind: "linux",
      paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
      async readSafeConfig() { return { exists: false }; },
    },
    fetch: async () => new Response(JSON.stringify(productionIdentityBody()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.equal(exit, 7);
  const record = JSON.parse(streams.stderr().trim().split("\n").at(-1));
  assert.equal(record.error.code, "cuna.remote.malformed_response");
  assert.equal(record.error.details.field, "workspace.id");
  assert.equal(record.error.details.operation, "GET /v1/me");
  assert.ok(record.error.hint.includes("https://github.com/Cuna-Labs/cuna-cli/issues"));
});

/* -------------------------------------------------------------------------- */
/* S-3: the classes that used to carry neither                                 */
/* -------------------------------------------------------------------------- */

test("a rejected automation credential says where a replacement comes from", async () => {
  const transport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    apiKey: API_KEY,
    fetch: async () => new Response("Unauthorized", {
      status: 401,
      headers: { "content-type": "text/plain" },
    }),
  });
  await assert.rejects(
    transport.request({ method: "GET", path: "/v1/me" }),
    (error) => error instanceof CunaError &&
      error.code === "cuna.auth.rejected" &&
      error.hint.includes(API_KEYS_URL) &&
      // Literal oracle: the constant could be renamed to any string and the
      // reference above would still pass.
      error.hint.includes("https://app.getcuna.com/api-keys"),
  );
});

test("every error class that reaches a user through the transport carries a hint", async () => {
  // Parametrized over the STATUSES the transport discriminates on, which is the
  // authority, rather than over a list of hints the source happens to build.
  const statuses = [401, 403, 409, 429, 500, 503, 404];
  for (const status of statuses) {
    const transport = createHttpTransport({
      baseUrl: "https://api.getcuna.com",
      apiKey: API_KEY,
      fetch: async () => new Response("plain", {
        status,
        headers: { "content-type": "text/plain" },
      }),
    });
    await assert.rejects(
      transport.request({ method: "GET", path: "/v1/me" }),
      (error) => {
        assert.ok(error instanceof CunaError, `status ${status}`);
        assert.equal(typeof error.hint, "string", `status ${status} must carry a hint`);
        assert.ok(error.hint.length > 0, `status ${status} must carry a non-empty hint`);
        return true;
      },
    );
  }
});

/* -------------------------------------------------------------------------- */
/* The mechanism itself                                                        */
/* -------------------------------------------------------------------------- */

test("a contract violation carries its field and predicate, and nesting narrows the path", () => {
  assert.throws(
    () => decodeCunaIdentity(productionIdentityBody()),
    (error) => error instanceof ContractViolation &&
      error.field === "workspace.id" &&
      error.predicate === "required_when_workspace_assigned" &&
      // It is still a TypeError, so every existing `catch` keeps working.
      error instanceof TypeError,
  );
});
