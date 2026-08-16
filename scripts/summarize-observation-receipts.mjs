import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { validatePlatformReceipt } from "./lib/platform-receipt.mjs";
import { invariant, parseArgs, readJson, sha256File, verifyEnvelopeFiles } from "./lib/release-evidence.mjs";
import { validateSupportPolicy } from "./release-distribution-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const evidenceRoot = path.resolve(root, args.get("evidence") ?? "release-artifacts");
const receiptsRoot = path.resolve(root, args.get("receipts") ?? "evidence/observation-receipts");
const output = path.resolve(root, args.get("output") ?? "evidence/observation-summary.json");
const maximumAgeHours = Number(args.get("maximum-age-hours") ?? "24");
invariant(Number.isFinite(maximumAgeHours) && maximumAgeHours > 0 && maximumAgeHours <= 24, "maximum-age-hours must be greater than zero and no more than 24");

const envelope = await readJson(path.join(evidenceRoot, "release-envelope.json"));
await verifyEnvelopeFiles(envelope, evidenceRoot);
const releaseEnvelopeSha256 = await sha256File(path.join(evidenceRoot, "release-envelope.json"));
const supportPolicyFile = path.join(evidenceRoot, envelope.supportPolicy.file);
const supportPolicy = await readJson(supportPolicyFile);
validateSupportPolicy(supportPolicy);
const supportPolicySha256 = await sha256File(supportPolicyFile);
invariant(supportPolicySha256 === envelope.supportPolicy.sha256, "Observation summary support-policy digest mismatch");

const expectedEntries = supportPolicy.ciMatrix.filter((entry) => entry.claim === "observation-only");
const expectedById = new Map(expectedEntries.map((entry) => [entry.id, entry]));
const expectedObservationIds = [...expectedById.keys()].sort();
let files = [];
try {
  files = (await readdir(receiptsRoot)).filter((file) => file.endsWith(".json")).sort();
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const receivedObservationIds = [];
const verifiedObservationIds = [];
const rejected = [];
const observedNow = Date.now();
for (const file of files) {
  const rawId = file.slice(0, -5);
  const id = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(rawId)
    ? rawId
    : `invalid-${createHash("sha256").update(rawId, "utf8").digest("hex").slice(0, 16)}`;
  receivedObservationIds.push(id);
  const policyEntry = expectedById.get(rawId);
  if (!policyEntry) {
    rejected.push({ id, reasonCode: "UNEXPECTED_RECEIPT", message: `Receipt filename is not an observation-only policy identity: ${JSON.stringify(rawId)}` });
    continue;
  }
  let receipt;
  try {
    receipt = JSON.parse(await readFile(path.join(receiptsRoot, file), "utf8"));
  } catch (error) {
    rejected.push({ id, reasonCode: "INVALID_JSON", message: `Observation receipt is not valid JSON: ${String(error.message).slice(0, 400)}` });
    continue;
  }
  try {
    validatePlatformReceipt({
      receipt,
      file,
      id: rawId,
      policyEntry,
      envelope,
      releaseEnvelopeSha256,
      observedNow,
      maximumAgeHours,
    });
    verifiedObservationIds.push(rawId);
  } catch (error) {
    rejected.push({ id, reasonCode: "RECEIPT_VALIDATION_FAILED", message: String(error.message).slice(0, 512) });
  }
}

receivedObservationIds.sort();
verifiedObservationIds.sort();
rejected.sort((left, right) => left.id.localeCompare(right.id));
const receivedExpected = new Set(receivedObservationIds.filter((id) => expectedById.has(id)));
const missingObservationIds = expectedObservationIds.filter((id) => !receivedExpected.has(id));
const summary = {
  schemaVersion: 1,
  releaseEnvelopeSha256,
  supportPolicySha256,
  expectedObservationIds,
  receivedObservationIds,
  verifiedObservationIds,
  missingObservationIds,
  rejected,
  admissionImpact: "NONE",
  releaseEligible: false,
  generatedAt: new Date().toISOString(),
};

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify({ status: "observation-summary-written", verified: verifiedObservationIds.length, missing: missingObservationIds.length, rejected: rejected.length, admissionImpact: "NONE", releaseEligible: false })}\n`);
