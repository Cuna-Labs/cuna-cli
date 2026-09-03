// A 5xx the server marked final is an answer, not an outage.
//
// `retryable` is the server's own word, so it decides rather than the status
// class: exit 5 tells a caller to wait, and a refusal is not something waiting
// can clear. The two negative controls keep a genuinely transient failure
// retryable.
import test from "node:test";
import assert from "node:assert/strict";

import { createHttpTransport, CunaError, EXIT_CODES } from "../dist/index.js";

const REQUEST_ID = "99999999-9999-4999-8999-999999999999";

/** One Problem body, served at `status`, through the real transport. */
function transportAnswering(status, body) {
  return createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    apiKey: "cuna_sk_abcdefghijklmnop",
    fetch: async () => new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/problem+json" },
    }),
  });
}

function refusal(detail) {
  return {
    type: "https://api.getcuna.com/problems/machine_create_provider_refused",
    title: "Workspace provider refused this machine",
    status: 502,
    code: "machine_create_provider_refused",
    request_id: REQUEST_ID,
    retryable: false,
    detail,
    action: "none",
  };
}

const CREATED = "The workspace provider refused to create this machine: billing restricted: " +
  "balance_exhausted. Clear that condition, then send this request again with the same Idempotency-Key.";
const UNCONFIRMED = "The workspace provider refused to confirm whether this machine was created: " +
  "billing restricted: balance_exhausted. Clear that condition, then send this request again with the " +
  "same Idempotency-Key.";

test("a 502 the server marked final is a refusal, not a service outage", async () => {
  await assert.rejects(
    transportAnswering(502, refusal(CREATED)).request({ method: "POST", path: "/v1/sessions" }),
    (error) => {
      assert.ok(error instanceof CunaError);
      assert.equal(error.code, "cuna.remote.rejected");
      // Exit 5 means "the server is behind, wait". Exit 7 means "the server
      // answered and the answer was no". A script has to be able to tell.
      assert.equal(error.exitCode, EXIT_CODES.remote);
      assert.equal(error.retryable, false);
      assert.equal(error.message, "Workspace provider refused this machine");
      assert.equal(error.details?.request_id, REQUEST_ID);
      return true;
    },
  );
});

test("the provider's own reason reaches the reader, not a generic sentence", async () => {
  await assert.rejects(
    transportAnswering(502, refusal(CREATED)).request({ method: "POST", path: "/v1/sessions" }),
    (error) => {
      assert.match(error.hint ?? "", /billing restricted: balance_exhausted/u);
      assert.doesNotMatch(error.hint ?? "", /temporarily unavailable/u);
      // Bound to the refusal branch on purpose. The old 5xx branch also mapped
      // `hint: problem?.detail`, so the two assertions above passed before the
      // change and proved nothing about it; without this line the test is a
      // renderer guard wearing a fix's name.
      assert.equal(error.exitCode, EXIT_CODES.remote);
      return true;
    },
  );
});

test("two sites sharing one code stay distinguishable in what is rendered", async () => {
  // The catalogue fixes `title` per code, so both sites answer with the same
  // title by design. The whole difference between "refused to create" and
  // "refused to confirm whether it was created" lives in `detail`, and `detail`
  // reaches the reader only through `hint`. This codebase has already shipped
  // the opposite: three sites emitting one reason string, and a renderer that
  // dropped the one field that separated them. The ambiguity survived three
  // source readings.
  const seen = [];
  for (const detail of [CREATED, UNCONFIRMED]) {
    await assert.rejects(
      transportAnswering(502, refusal(detail)).request({ method: "POST", path: "/v1/sessions" }),
      (error) => {
        // Same reason as above: without the exit-code assertion this passes on
        // the old branch too.
        assert.equal(error.exitCode, EXIT_CODES.remote);
        seen.push({ message: error.message, hint: error.hint });
        return true;
      },
    );
  }
  assert.equal(seen[0].message, seen[1].message);
  assert.notEqual(seen[0].hint, seen[1].hint);
  assert.match(seen[0].hint, /refused to create this machine/u);
  assert.match(seen[1].hint, /refused to confirm whether this machine was created/u);
});

test("NEGATIVE CONTROL: a 5xx the server left retryable is still an outage", async () => {
  // If this ever reads `cuna.remote.rejected`, the change has swallowed the
  // case it was carved out of, and a genuinely transient failure would stop
  // being retried.
  await assert.rejects(
    transportAnswering(503, {
      type: "https://api.getcuna.com/problems/machine_restart_settlement_failed",
      title: "Machine restart settlement failed",
      status: 503,
      code: "machine_restart_settlement_failed",
      request_id: REQUEST_ID,
      retryable: true,
      detail: "The Machine restarted but its AgentSessions have not settled yet.",
      action: "retry",
    }).request({ method: "POST", path: "/v1/sessions" }),
    (error) => {
      assert.equal(error.code, "cuna.network.service_unavailable");
      assert.equal(error.exitCode, EXIT_CODES.network);
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("NEGATIVE CONTROL: a 5xx carrying no Problem at all is still an outage", async () => {
  // A real outage does not answer in `application/problem+json`. The new branch
  // requires a Problem, so a bare 500 must keep its retryable meaning.
  const transport = createHttpTransport({
    baseUrl: "https://api.getcuna.com",
    apiKey: "cuna_sk_abcdefghijklmnop",
    fetch: async () => new Response("upstream connect error", { status: 503 }),
  });
  await assert.rejects(
    transport.request({ method: "GET", path: "/v1/machines" }),
    (error) => {
      assert.equal(error.code, "cuna.network.service_unavailable");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});
