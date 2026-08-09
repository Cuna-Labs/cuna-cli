import { readdir } from "node:fs/promises";
import path from "node:path";

import { invariant, parseArgs, readJson, sha256File } from "./lib/release-evidence.mjs";
import {
  CHANNEL_DEFINITIONS,
  CHANNEL_ORDER,
  DISTRIBUTION_MANIFEST_FILE,
  normalizeRelativeFile,
  validateDistributionReceipt,
  verifyDistributionFiles,
  verifyDistributionInputs,
} from "./release-distribution-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const repositoryRoot = path.resolve(args.get("root") ?? process.cwd());
const evidenceRoot = path.resolve(repositoryRoot, args.get("evidence") ?? "release-artifacts");
const distributionsRoot = path.resolve(repositoryRoot, args.get("distributions") ?? "release-artifacts/distributions");
const receiptsRoot = path.resolve(repositoryRoot, args.get("receipts") ?? "evidence/distribution-receipts");
const maximumAgeHours = Number(args.get("maximum-age-hours") ?? "24");
invariant(Number.isFinite(maximumAgeHours) && maximumAgeHours > 0 && maximumAgeHours <= 24, "Receipt maximum age must be in (0, 24] hours");

const envelope = await readJson(path.join(evidenceRoot, "release-envelope.json"));
await verifyDistributionInputs(envelope, evidenceRoot);
const manifestFile = path.join(distributionsRoot, DISTRIBUTION_MANIFEST_FILE);
const manifest = await readJson(manifestFile);
await verifyDistributionFiles(manifest, envelope, distributionsRoot);
const manifestSha256 = await sha256File(manifestFile);

const expectedReceiptIds = CHANNEL_ORDER.flatMap((channel) =>
  CHANNEL_DEFINITIONS[channel].platforms.map((platform) => `${channel}-${platform}`),
).sort();
const receiptFiles = (await readdir(receiptsRoot))
  .filter((file) => file.endsWith(".json"))
  .sort();
invariant(
  JSON.stringify(receiptFiles) === JSON.stringify(expectedReceiptIds.map((id) => `${id}.json`)),
  `Distribution receipt set differs from policy. Expected: ${expectedReceiptIds.join(", ")}`,
);

const now = Date.now();
const observedBuildDigests = new Set();
const observedProtocolRanges = new Set();
const evidenceFiles = new Set();
for (const id of expectedReceiptIds) {
  const receiptFile = path.join(receiptsRoot, `${id}.json`);
  const receipt = await readJson(receiptFile);
  validateDistributionReceipt(receipt, { manifest, manifestSha256 });
  invariant(id.startsWith(`${receipt.channel}-`), `${id} channel does not match its filename`);
  invariant(
    id === `${receipt.channel}-${receipt.runtimeIdentity.platform}-${receipt.runtimeIdentity.architecture}`,
    `${id} runtime identity does not match its filename`,
  );
  const observedAt = Date.parse(receipt.observedAt);
  invariant(observedAt <= now + 5 * 60 * 1000, `${id} receipt is implausibly future-dated`);
  invariant(now - observedAt <= maximumAgeHours * 60 * 60 * 1000, `${id} receipt is stale`);

  for (const evidence of Object.values(receipt.evidence)) {
    const relative = normalizeRelativeFile(evidence.file, `${id} evidence file`);
    invariant(!evidenceFiles.has(relative), `Raw evidence file is reused across receipts: ${relative}`);
    evidenceFiles.add(relative);
    const absolute = path.resolve(receiptsRoot, relative);
    invariant(absolute.startsWith(`${receiptsRoot}${path.sep}`), `${id} evidence path escapes the receipt root`);
    invariant((await sha256File(absolute)) === evidence.sha256, `${id} raw evidence digest mismatch: ${relative}`);
  }
  observedBuildDigests.add(receipt.runtimeIdentity.buildDigest);
  observedProtocolRanges.add(JSON.stringify(receipt.runtimeIdentity.protocolRange));
}

invariant(observedBuildDigests.size === 1, "Cross-installer installed build identities differ");
invariant(observedProtocolRanges.size === 1, "Cross-installer protocol ranges differ");

process.stdout.write(`${JSON.stringify({
  status: "DISTRIBUTION_EVIDENCE_VERIFIED",
  distributionGate: "PASS",
  releaseDecision: "BLOCKED",
  candidateSha256: envelope.tarball.sha256,
  installedBuildDigest: [...observedBuildDigests][0],
  receipts: expectedReceiptIds,
  residualBlockers: [
    "FULL_RELEASE_DAGS_AND_APPROVAL_LEASE_NOT_VERIFIED_BY_THIS_GATE",
    "COHORT_OBSERVATION_THRESHOLDS_AND_TELEMETRY_NOT_VERIFIED_BY_THIS_GATE",
  ],
})}\n`);

