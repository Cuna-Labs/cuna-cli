import assert from "node:assert/strict";
import test from "node:test";

import {
  CREDENTIAL_BRANDS,
  CREDENTIAL_FAMILIES_WITHOUT_WIRE_GRAMMAR,
  CREDENTIAL_FAMILY_INFIXES,
  credentialFamilyValidator,
  decodeAuditRecords,
  isBrowserCallbackNonce,
} from "../dist/index.js";
// `isLoginCode` is not on the public index surface, and that absence is why the
// `login` family had no mint oracle while its sibling `isBrowserCallbackNonce`
// did. Reach for it directly rather than widening the published surface.
import { isLoginCode } from "../dist/core/namespace.js";
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
  "sc", // supervisor control bearer, live on the production edge today
  "cb", // browser callback nonce
  "cr", // browser continuation resume handle, minted by the console
  // `login` is the durable 30-day browser-issued CLI login credential, and it
  // was missing from this floor while it sat in CREDENTIAL_FAMILY_INFIXES —
  // the third time this file's own header describes, after `cb` and `cr`.
  // Losing it stops `detectHighConfidenceSecret` matching `cuna_login_…`, so
  // the CLI uploads a live credential into a synced workspace instead of
  // blocking it. It is stored on disk by `cuna login`, which is exactly the
  // kind of file that ends up inside a workspace directory.
  "login", // durable browser-issued CLI login credential
];

/**
 * The families that MUST carry a wire grammar in the authority.
 *
 * The companion test below decides "validated or explicitly unvalidated" by
 * reading `CREDENTIAL_FAMILIES_WITHOUT_WIRE_GRAMMAR` — the implementation's own
 * list. That makes it invariant under the regression it exists to catch:
 * deleting a family's grammar and adding the family to that list is green, and
 * `every validated family accepts its own mint` then skips the family entirely
 * via its `validator === undefined` guard. Coverage silently drops to zero for a
 * validator that guards live credentials.
 *
 * This literal floor is the authority for that half. A family may be added, but
 * a validated family may never quietly become an unvalidated one.
 */
const REQUIRED_VALIDATED_CREDENTIAL_FAMILIES = [
  "sk", // isSecretApiKey — the programmatic bearer
  "at", // isAccessToken — the interactive bearer
  "tc", // isTerminalConnectToken
  "cb", // isBrowserCallbackNonce
  "cr", // browser continuation resume handle
  "sc", // supervisor control bearer, matched on the production wire today
  "login", // isLoginCode
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
  // A literal oracle on the mint itself. Every assertion above is membership,
  // so reordering the brands satisfies all of them while inverting which brand
  // the product presents as current. `cuna` is what we mint; `runa` is only
  // what we still accept.
  assert.equal(CREDENTIAL_BRANDS[0], "cuna", "cuna must remain the minted brand");
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

/**
 * The infix list and the wire grammar are two halves of the authority, and they
 * drifted: `cb` sat in the infix list with no grammar entry, so a call site that
 * needed to validate a browser callback nonce had nothing to import and wrote
 * its own regex. Every hand-rolled copy this repository grew started that way.
 *
 * A family must therefore be either validated here or explicitly recorded as
 * unvalidated. Adding one and forgetting the grammar now fails; so does listing
 * an exception that has since acquired a grammar.
 */
test("every family that must be validated still has a wire grammar", () => {
  // The literal oracle for the grammar half. Reading only
  // CREDENTIAL_FAMILIES_WITHOUT_WIRE_GRAMMAR lets a deletion move a family from
  // validated to unvalidated and stay green; this cannot, because the floor
  // does not move when the implementation does.
  for (const infix of REQUIRED_VALIDATED_CREDENTIAL_FAMILIES) {
    assert.notEqual(
      credentialFamilyValidator(infix),
      undefined,
      `${infix} must keep a wire grammar; it is a validated family, not an exception`,
    );
    assert.equal(
      CREDENTIAL_FAMILIES_WITHOUT_WIRE_GRAMMAR.includes(infix),
      false,
      `${infix} must not be recorded as unvalidated`,
    );
  }
});

test("every minted family is either validated by the authority or recorded as unvalidated", () => {
  const unvalidated = new Set(CREDENTIAL_FAMILIES_WITHOUT_WIRE_GRAMMAR);
  for (const infix of new Set([...REQUIRED_CREDENTIAL_FAMILY_INFIXES, ...CREDENTIAL_FAMILY_INFIXES])) {
    const validator = credentialFamilyValidator(infix);
    assert.equal(
      validator === undefined,
      unvalidated.has(infix),
      validator === undefined
        ? `${infix} has no wire grammar and is not recorded in CREDENTIAL_FAMILIES_WITHOUT_WIRE_GRAMMAR`
        : `${infix} has a wire grammar but is still recorded as unvalidated`,
    );
  }
  for (const infix of unvalidated) {
    assert.equal(CREDENTIAL_FAMILY_INFIXES.includes(infix), true, `${infix} is recorded as unvalidated but is not a minted family`);
  }
});

test("every validated family accepts its own mint and nothing else", () => {
  for (const infix of new Set([...REQUIRED_CREDENTIAL_FAMILY_INFIXES, ...CREDENTIAL_FAMILY_INFIXES])) {
    const validator = credentialFamilyValidator(infix);
    if (validator === undefined) continue;
    for (const brand of REQUIRED_CREDENTIAL_BRANDS) {
      assert.equal(validator(`${brand}_${infix}_${OPAQUE_SUFFIX}`), true, `${brand}_${infix}_ must authenticate`);
    }
    // A family must not accept another family's value, or a rename lands on one
    // side and every value keeps authenticating under the wrong grammar.
    const other = infix === "at" ? "rt" : "at";
    assert.equal(validator(`cuna_${other}_${OPAQUE_SUFFIX}`), false, `${infix} must reject a ${other} value`);
    assert.equal(validator(`nope_${infix}_${OPAQUE_SUFFIX}`), false, `${infix} must reject an unminted brand`);
    assert.equal(validator(`cuna_${infix}_`), false, `${infix} must reject an empty suffix`);
  }
});

test("the browser callback nonce admits only the current Cuna callback flow", () => {
  assert.equal(isBrowserCallbackNonce(`cuna_cb_${OPAQUE_SUFFIX}`), true);
  for (const rejected of [
    `runa_cb_${OPAQUE_SUFFIX}`, // former callback values remain denylist-only
    `cuna_cb_${"A".repeat(42)}`, // one character short of the minted suffix
    `cuna_cb_${"A".repeat(44)}`, // one character long
    `cuna_ct_${OPAQUE_SUFFIX}`, // a different family must not authenticate as cb
    `nope_cb_${OPAQUE_SUFFIX}`, // an unminted brand
    `prefix_cuna_cb_${OPAQUE_SUFFIX}`, // must stay anchored
  ]) {
    assert.equal(isBrowserCallbackNonce(rejected), false, rejected);
  }
});

/**
 * `isLoginCode` had no test anywhere in this repository, while its exact
 * sibling `isBrowserCallbackNonce` had the case above. Both are anchored,
 * both hard-require the current `cuna_` mint, and both guard a durable
 * credential — the login code for thirty days. An untested predicate is how a
 * family becomes invisible to the deletion detector in the first place.
 */
test("the CLI login code admits only the current Cuna sign-in flow", () => {
  assert.equal(isLoginCode(`cuna_login_${OPAQUE_SUFFIX}`), true);
  for (const rejected of [
    `runa_login_${OPAQUE_SUFFIX}`, // former login values remain denylist-only
    `cuna_login_${"A".repeat(42)}`, // one character short of the minted suffix
    `cuna_login_${"A".repeat(44)}`, // one character long
    `cuna_at_${OPAQUE_SUFFIX}`, // a different family must not authenticate as login
    `nope_login_${OPAQUE_SUFFIX}`, // an unminted brand
    `prefix_cuna_login_${OPAQUE_SUFFIX}`, // must stay anchored
  ]) {
    assert.equal(isLoginCode(rejected), false, rejected);
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
