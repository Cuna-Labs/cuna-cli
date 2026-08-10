import assert from "node:assert/strict";
import test from "node:test";

import {
  CREDENTIAL_BRANDS,
  CREDENTIAL_FAMILY_INFIXES,
  decodeAuditRecords,
  isBrowserCallbackNonce,
} from "../dist/index.js";
import { detectHighConfidenceSecret } from "../dist/workspace/index.js";

/**
 * The floor of the credential-namespace authority: every brand and every family
 * infix the product has ever minted, written out literally.
 *
 * `CREDENTIAL_FAMILY_INFIXES` feeds the workspace secret detector, which is a
 * denylist over bytes about to leave the user's machine. A test that only
 * iterates the exported list cannot notice the list shrinking — it just runs
 * one case fewer and stays green. That is how `cb` went missing while the
 * service minted `cuna_cb_…` for every human sign-in: `SERVICE_TOKEN` never
 * recognized it, so those files were uploaded rather than blocked.
 *
 * These lists may only ever GROW.
 */
const REQUIRED_CREDENTIAL_BRANDS = ["cuna", "runa"];
const REQUIRED_CREDENTIAL_FAMILY_INFIXES = [
  "sk", // programmatic secret key
  "at", // interactive access token
  "rt", // interactive refresh token
  "ct", // browser sign-in continuation secret
  "tc", // one-use terminal connect token
  "se", // session credential
  "sc", // session credential
  "cb", // browser callback nonce
];

const OPAQUE_SUFFIX = "A".repeat(43);

test("the credential namespace authority never loses a brand or a family", () => {
  // Deletion detector: names the missing entry, and needs no edit to fire.
  for (const brand of REQUIRED_CREDENTIAL_BRANDS) {
    assert.equal(CREDENTIAL_BRANDS.includes(brand), true, brand);
  }
  for (const infix of REQUIRED_CREDENTIAL_FAMILY_INFIXES) {
    assert.equal(CREDENTIAL_FAMILY_INFIXES.includes(infix), true, infix);
  }
});

test("the workspace secret detector blocks every brand and family it must", () => {
  // One case per brand x family, drawn from the floor union the live list, so a
  // family added later is covered with no edit here.
  const brands = new Set([...REQUIRED_CREDENTIAL_BRANDS, ...CREDENTIAL_BRANDS]);
  const infixes = new Set([...REQUIRED_CREDENTIAL_FAMILY_INFIXES, ...CREDENTIAL_FAMILY_INFIXES]);
  for (const brand of brands) {
    for (const infix of infixes) {
      const credential = `${brand}_${infix}_${OPAQUE_SUFFIX}`;
      const label = `${brand}_${infix}_`;
      assert.equal(
        detectHighConfidenceSecret(Buffer.from(credential, "utf8")),
        "service_token",
        label,
      );
      // A credential is just as leaked when it is embedded in a config file as
      // when it is the whole file.
      assert.equal(
        detectHighConfidenceSecret(
          Buffer.from(`API_TOKEN="${credential}"\nOTHER=1\n`, "utf8"),
        ),
        "service_token",
        `${label} embedded`,
      );
    }
  }
});

/**
 * The second denylist over the same namespace. `safePublicString` guards what
 * the CLI prints to the operator's terminal and, under `--json`, into CI logs
 * and shell history; `decodeAuditRecords` is its widest sink, because the
 * service controls `summary` (2048 chars) and every string nested in `detail`
 * (16384 chars).
 *
 * This guard used to carry its own hand-written family list that stopped at
 * five of eight — it did not know `se`, `sc` or `cb` — while the workspace
 * detector above knew all eight. Two detectors over one namespace, and the
 * weaker one guarded the terminal. `sc` is not hypothetical: the edge matches
 * `^Bearer (runa_sc_…)$` on the production wire today.
 *
 * The guard also had zero coverage: it was invariant under deletion. These
 * cases fire on any narrowing of the authority without being edited.
 */
function auditRecord(overrides) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    session_id: "22222222-2222-4222-8222-222222222222",
    kind: "agent.start",
    summary: "started",
    detail: { note: "clean" },
    created_at: "2026-08-10T00:00:00Z",
    ...overrides,
  };
}

test("an audit record carrying no credential still decodes", () => {
  const [decoded] = decodeAuditRecords([auditRecord({})]);
  assert.equal(decoded.summary, "started");
  assert.equal(decoded.detail.note, "clean");
});

test("no credential brand or family can reach stdout through an audit record", () => {
  const brands = new Set([...REQUIRED_CREDENTIAL_BRANDS, ...CREDENTIAL_BRANDS]);
  const infixes = new Set([...REQUIRED_CREDENTIAL_FAMILY_INFIXES, ...CREDENTIAL_FAMILY_INFIXES]);
  for (const brand of brands) {
    for (const infix of infixes) {
      const credential = `${brand}_${infix}_${OPAQUE_SUFFIX}`;
      // Every field the service controls, including nested detail strings and
      // object keys — each one is printed verbatim in human and JSON output.
      const sinks = [
        { summary: `authenticated with ${credential}` },
        { kind: credential },
        { detail: { authorization: `Bearer ${credential}` } },
        { detail: { [credential]: "value" } },
        { detail: { nested: [{ deeper: credential }] } },
      ];
      for (const [index, overrides] of sinks.entries()) {
        assert.throws(
          () => decodeAuditRecords([auditRecord(overrides)]),
          TypeError,
          `${brand}_${infix}_ sink ${index} leaked to stdout`,
        );
      }
    }
  }
});

test("the browser callback nonce is validated by the authority, in both brands", () => {
  for (const brand of REQUIRED_CREDENTIAL_BRANDS) {
    assert.equal(isBrowserCallbackNonce(`${brand}_cb_${OPAQUE_SUFFIX}`), true, brand);
  }
  for (const rejected of [
    `cuna_cb_${"A".repeat(42)}`, // one character short of the minted suffix
    `cuna_cb_${"A".repeat(44)}`, // one character long
    `cuna_ct_${OPAQUE_SUFFIX}`, // a different family must not authenticate as cb
    `nope_cb_${OPAQUE_SUFFIX}`, // an unminted brand
    `prefix_cuna_cb_${OPAQUE_SUFFIX}`, // must stay anchored
  ]) {
    assert.equal(isBrowserCallbackNonce(rejected), false, rejected);
  }
});

test("the secret detector still admits ordinary workspace content", () => {
  for (const benign of [
    "const skew = 1;\n",
    "cunacode is the product name\n",
    "runaway_process_handler()\n",
    "",
  ]) {
    assert.equal(detectHighConfidenceSecret(Buffer.from(benign, "utf8")), undefined, benign);
  }
});
