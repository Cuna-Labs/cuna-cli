import { readFile, lstat, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { invariant, parseArgs, readJson, sha256File } from "./lib/release-evidence.mjs";
import {
  DISTRIBUTION_MANIFEST_FILE,
  distributionReceiptId,
  normalizeReceiptEvidenceFile,
  validateDistributionObservations,
  validateDistributionReceipt,
  validateSigningVerificationEvidence,
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
const { supportPolicy, channelDefinitions, channelOrder } = await verifyDistributionInputs(envelope, evidenceRoot);
const manifestFile = path.join(distributionsRoot, DISTRIBUTION_MANIFEST_FILE);
const manifest = await readJson(manifestFile);
await verifyDistributionFiles(manifest, envelope, distributionsRoot, channelDefinitions);
const manifestSha256 = await sha256File(manifestFile);
const receiptsRealRoot = await realpath(receiptsRoot);

const expectedReceiptIds = channelOrder.flatMap((channel) =>
  channelDefinitions[channel].platforms.flatMap((platform) =>
    channelDefinitions[channel].testedNodeVersions.map((nodeVersion) => distributionReceiptId(channel, platform, `v${nodeVersion}`)),
  ),
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
const issuerCohorts = new Set();
const evidenceLogicalPaths = new Set();
const evidencePhysicalFiles = new Set();
const derivedObservationResults = new Map();

async function resolveEvidenceFile(relativeValue, label) {
  const relative = normalizeReceiptEvidenceFile(relativeValue, label);
  const logicalIdentity = relative.toLowerCase();
  invariant(!evidenceLogicalPaths.has(logicalIdentity), `Raw evidence file is reused case-insensitively: ${relative}`);

  let absolute = receiptsRoot;
  let finalStat;
  const segments = relative.split("/");
  for (const [index, segment] of segments.entries()) {
    absolute = path.join(absolute, segment);
    finalStat = await lstat(absolute);
    invariant(!finalStat.isSymbolicLink(), `${label} contains a symbolic link or junction: ${relative}`);
    invariant(
      index === segments.length - 1 ? finalStat.isFile() : finalStat.isDirectory(),
      `${label} is not a regular file beneath ordinary directories: ${relative}`,
    );
  }

  const canonical = await realpath(absolute);
  const fromRoot = path.relative(receiptsRealRoot, canonical);
  invariant(fromRoot.length > 0 && !fromRoot.startsWith(`..${path.sep}`) && fromRoot !== ".." && !path.isAbsolute(fromRoot), `${label} escapes the receipt root`);
  const physicalIdentity = finalStat && Number.isSafeInteger(finalStat.ino) && finalStat.ino > 0
    ? `${finalStat.dev}:${finalStat.ino}`
    : canonical.toLowerCase();
  invariant(!evidencePhysicalFiles.has(physicalIdentity), `Raw evidence file is physically reused: ${relative}`);
  evidenceLogicalPaths.add(logicalIdentity);
  evidencePhysicalFiles.add(physicalIdentity);
  return { relative, absolute: canonical };
}

async function readBoundJson(absolute, expectedSha256, label) {
  const bytes = await readFile(absolute);
  const observedSha256 = createHash("sha256").update(bytes).digest("hex");
  invariant(observedSha256 === expectedSha256, label);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label}: bound bytes are not valid JSON`);
  }
}

for (const id of expectedReceiptIds) {
  const receiptFile = path.join(receiptsRoot, `${id}.json`);
  const receipt = await readJson(receiptFile);
  const { statement } = validateDistributionReceipt(receipt, {
    manifest,
    manifestSha256,
    supportedNodeVersions: channelDefinitions[receipt.attestation.statement.subject.channel].testedNodeVersions.map((version) => `v${version}`),
    supportPolicy,
    supportPolicySha256: envelope.supportPolicy.sha256,
  });
  invariant(id === statement.subject.receiptId, `${id} attestation subject does not match its filename`);
  const observedAt = Date.parse(statement.observedAt);
  invariant(observedAt <= now + 5 * 60 * 1000, `${id} receipt is implausibly future-dated`);
  invariant(now - observedAt <= maximumAgeHours * 60 * 60 * 1000, `${id} receipt is stale`);
  issuerCohorts.add(JSON.stringify({
    repository: statement.issuer.repository,
    workflow: statement.issuer.workflow,
    workflowRef: statement.issuer.workflowRef,
    sourceRef: statement.issuer.sourceRef,
    sourceCommit: statement.issuer.sourceCommit,
    runId: statement.issuer.runId,
    runAttempt: statement.issuer.runAttempt,
  }));

  const rawObservations = {};
  for (const [name, observation] of Object.entries(statement.observations)) {
    const { relative, absolute } = await resolveEvidenceFile(observation.file, `${id} ${name} observation file`);
    rawObservations[name] = await readBoundJson(absolute, observation.sha256, `${id} raw observation digest mismatch: ${relative}`);
  }
  derivedObservationResults.set(id, validateDistributionObservations(receipt, rawObservations, { manifest }));

  const signingReference = receipt.attestation.signingEvidence;
  const { relative: signingRelative, absolute: signingAbsolute } = await resolveEvidenceFile(signingReference.file, `${id} signing-evidence file`);
  validateSigningVerificationEvidence(
    receipt,
    await readBoundJson(signingAbsolute, signingReference.sha256, `${id} signing-evidence digest mismatch: ${signingRelative}`),
  );

  observedBuildDigests.add(statement.runtimeIdentity.buildDigest);
  observedProtocolRanges.add(JSON.stringify(statement.runtimeIdentity.protocolRange));
}

invariant(observedBuildDigests.size === 1, "Cross-installer installed build identities differ");
invariant(observedProtocolRanges.size === 1, "Cross-installer protocol ranges differ");
invariant(issuerCohorts.size === 1, "Distribution receipts do not belong to one immutable workflow-run cohort");

process.stdout.write(`${JSON.stringify({
  status: "TYPED_OBSERVATION_CONSISTENCY_PASS",
  typedObservationConsistencyGate: "PASS",
  observationTruthAuthority: "NOT_ESTABLISHED",
  attestationAuthentication: "UNVERIFIED",
  distributionGate: "BLOCKED",
  releaseDecision: "BLOCKED",
  releaseEligible: false,
  candidateSha256: envelope.tarball.sha256,
  installedBuildDigest: [...observedBuildDigests][0],
  receipts: expectedReceiptIds,
  derivedChecks: Object.fromEntries(derivedObservationResults),
  residualBlockers: [
    "CRYPTOGRAPHIC_OIDC_ATTESTATION_VERIFICATION_NOT_PRESENT",
    "INDEPENDENT_CAUSAL_OBSERVATION_AUTHORITY_NOT_PRESENT",
    "RECEIPT_REPLAY_LEASE_AUTHORITY_NOT_PRESENT",
    "FULL_RELEASE_DAGS_AND_APPROVAL_LEASE_NOT_VERIFIED_BY_THIS_GATE",
    "COHORT_OBSERVATION_THRESHOLDS_AND_TELEMETRY_NOT_VERIFIED_BY_THIS_GATE",
  ],
})}\n`);
