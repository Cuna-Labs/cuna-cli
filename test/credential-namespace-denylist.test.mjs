import assert from "node:assert/strict";
import test from "node:test";

import { CREDENTIAL_BRANDS, CREDENTIAL_FAMILY_INFIXES } from "../dist/index.js";
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
