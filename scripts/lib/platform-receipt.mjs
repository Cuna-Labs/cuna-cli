import { invariant } from "./release-evidence.mjs";
import { exactKeys } from "../release-distribution-lib.mjs";

const PLATFORM_RECEIPT_KEYS = Object.freeze([
  "schemaVersion",
  "releaseEnvelopeSha256",
  "candidateSha256",
  "releaseInputsSha256",
  "identities",
  "sourceCommit",
  "platform",
  "architecture",
  "node",
  "selfTest",
  "versionIdentity",
  "uninstallCleanup",
  "observedAt",
]);

export function validatePlatformReceipt({
  receipt,
  file,
  id,
  policyEntry,
  envelope,
  releaseEnvelopeSha256,
  observedNow,
  maximumAgeHours,
}) {
  exactKeys(receipt, PLATFORM_RECEIPT_KEYS, `${file} platform receipt`);
  invariant(receipt.schemaVersion === 2, `${file} platform receipt schema is obsolete`);
  invariant(receipt.releaseEnvelopeSha256 === releaseEnvelopeSha256, `${file} release-envelope digest mismatch`);
  invariant(receipt.candidateSha256 === envelope.tarball.sha256, `${file} candidate digest mismatch`);
  invariant(receipt.releaseInputsSha256 === envelope.releaseInputs.sha256, `${file} release-input digest mismatch`);
  invariant(JSON.stringify(receipt.identities) === JSON.stringify(envelope.identities), `${file} release identities mismatch`);
  invariant(receipt.sourceCommit === envelope.sourceCommit, `${file} source commit mismatch`);
  invariant(
    receipt.selfTest === "PASS" && receipt.versionIdentity === "PASS" && receipt.uninstallCleanup === "PASS",
    `${file} did not pass installed-artifact gates`,
  );
  const observedAt = Date.parse(receipt.observedAt);
  invariant(Number.isFinite(observedAt), `${file} observedAt is invalid`);
  invariant(observedAt <= observedNow + 5 * 60 * 1_000, `${file} observedAt is in the future`);
  invariant(observedNow - observedAt <= maximumAgeHours * 60 * 60 * 1_000, `${file} platform receipt is stale`);
  invariant(receipt.platform === policyEntry.platform, `${id} platform mismatch`);
  invariant(receipt.architecture === policyEntry.architecture, `${id} architecture mismatch`);
  invariant(receipt.node === `v${policyEntry.node}`, `${id} Node version mismatch`);
  return receipt;
}

export const PLATFORM_RECEIPT_SCHEMA_VERSION = 2;
