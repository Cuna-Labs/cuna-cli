import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { invariant, parseArgs, readJson, sha256File, verifyEnvelopeFiles } from "./lib/release-evidence.mjs";
import { validatePlatformReceipt } from "./lib/platform-receipt.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const evidenceRoot = path.resolve(root, args.get("evidence") ?? "release-artifacts");
const receiptsRoot = path.resolve(root, args.get("receipts") ?? "evidence/platform-receipts");
const output = path.resolve(root, args.get("output") ?? "evidence/admission.json");
const maximumAgeHours = Number(args.get("maximum-age-hours") ?? "24");
invariant(
  Number.isFinite(maximumAgeHours) && maximumAgeHours > 0 && maximumAgeHours <= 24,
  "maximum-age-hours must be greater than zero and no more than 24",
);
const observedNow = Date.now();
const envelope = await readJson(path.join(evidenceRoot, "release-envelope.json"));
await verifyEnvelopeFiles(envelope, evidenceRoot);
const releaseEnvelopeSha256 = await sha256File(path.join(evidenceRoot, "release-envelope.json"));
const policy = await readJson(path.join(evidenceRoot, envelope.supportPolicy.file));
invariant(Array.isArray(policy.architectures) && policy.architectures.length > 0, "Support policy architectures are missing");
invariant(Array.isArray(policy.ciMatrix) && policy.ciMatrix.length > 0, "Support policy CI matrix is missing");
const supportedArchitectures = new Set(policy.architectures);
const policyEntries = new Map();
for (const entry of policy.ciMatrix) {
  invariant(typeof entry.id === "string" && entry.id.length > 0, "Support policy matrix entry id is invalid");
  invariant(!policyEntries.has(entry.id), `Duplicate support policy matrix entry: ${entry.id}`);
  policyEntries.set(entry.id, entry);
}
const requiredEntries = policy.ciMatrix.filter((entry) => entry.claim !== "observation-only");
const observationEntries = policy.ciMatrix.filter((entry) => entry.claim === "observation-only");
invariant(requiredEntries.length > 0, "Support policy has no release-admissible platform entries");
for (const entry of requiredEntries) {
  invariant(
    supportedArchitectures.has(entry.architecture),
    `Release-admissible platform ${entry.id} uses unsupported architecture ${entry.architecture}`,
  );
}
const requiredIds = requiredEntries.map((entry) => entry.id).sort();
const observationIds = new Set(observationEntries.map((entry) => entry.id));
const files = (await readdir(receiptsRoot)).filter((file) => file.endsWith(".json")).sort();

const observedIds = [];
for (const file of files) {
  const id = file.slice(0, -5);
  const policyEntry = policyEntries.get(id);
  invariant(policyEntry, `Unexpected platform receipt: ${id}`);
  const receipt = JSON.parse(await readFile(path.join(receiptsRoot, file), "utf8"));
  validatePlatformReceipt({
    receipt,
    file,
    id,
    policyEntry,
    envelope,
    releaseEnvelopeSha256,
    observedNow,
    maximumAgeHours,
  });
  observedIds.push(id);
}
const observedIdSet = new Set(observedIds);
const missingRequiredIds = requiredIds.filter((id) => !observedIdSet.has(id));
invariant(
  missingRequiredIds.length === 0,
  `Missing release-admissible platform receipts: ${missingRequiredIds.join(", ")}`,
);
const observedRequiredIds = observedIds.filter((id) => !observationIds.has(id)).sort();
invariant(
  JSON.stringify(observedRequiredIds) === JSON.stringify(requiredIds),
  "Release-admissible platform receipt set differs from policy",
);
invariant(observedIds.every((id) => !observationIds.has(id)), "Observation-only receipts must be summarized outside admission");

await writeFile(output, `${JSON.stringify({
  schemaVersion: 3,
  decision: "PLATFORM_MATRIX_VERIFIED_NOT_RELEASE_AUTHORIZED",
  releaseEligible: false,
  releaseEnvelopeSha256,
  candidateSha256: envelope.tarball.sha256,
  releaseInputsSha256: envelope.releaseInputs.sha256,
  identities: envelope.identities,
  sourceCommit: envelope.sourceCommit,
  platformReceipts: requiredIds,
  limitations: [
    "OBSERVATION_ONLY_EVIDENCE_REPORTED_SEPARATELY_AND_NON_AUTHORIZING",
    "NO_AUTHENTICATED_RECEIPT_OBSERVER",
    "NO_SEMANTIC_CHANNEL_TRANSACTION_EVIDENCE",
    "NO_CROSS_CHANNEL_UPDATE_OR_RECOVERY_REHEARSAL",
    "NO_RELEASE_APPROVAL_LEASE",
  ],
}, null, 2)}\n`, { flag: "wx" });
process.stdout.write('{"status":"platform-matrix-verified-not-release-authorized","releaseEligible":false}\n');
