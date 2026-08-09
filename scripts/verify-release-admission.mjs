import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { invariant, parseArgs, readJson, sha256File, verifyEnvelopeFiles } from "./lib/release-evidence.mjs";
import { exactKeys } from "./release-distribution-lib.mjs";

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
const maximumFutureSkewMs = 5 * 60 * 1_000;
const observedNow = Date.now();
const envelope = await readJson(path.join(evidenceRoot, "release-envelope.json"));
await verifyEnvelopeFiles(envelope, evidenceRoot);
const releaseEnvelopeSha256 = await sha256File(path.join(evidenceRoot, "release-envelope.json"));
const policy = await readJson(path.join(evidenceRoot, envelope.supportPolicy.file));
const expectedIds = policy.ciMatrix.map((entry) => entry.id).sort();
const files = (await readdir(receiptsRoot)).filter((file) => file.endsWith(".json")).sort();
invariant(files.length === expectedIds.length, `Expected ${expectedIds.length} platform receipts, found ${files.length}`);

const observedIds = [];
for (const file of files) {
  const receipt = JSON.parse(await readFile(path.join(receiptsRoot, file), "utf8"));
  exactKeys(receipt, [
    "schemaVersion", "releaseEnvelopeSha256", "candidateSha256", "releaseInputsSha256", "identities",
    "sourceCommit", "platform", "architecture", "node", "selfTest", "versionIdentity", "uninstallCleanup", "observedAt",
  ], `${file} platform receipt`);
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
  invariant(observedAt <= observedNow + maximumFutureSkewMs, `${file} observedAt is in the future`);
  invariant(observedNow - observedAt <= maximumAgeHours * 60 * 60 * 1_000, `${file} platform receipt is stale`);
  const id = file.slice(0, -5);
  const policyEntry = policy.ciMatrix.find((entry) => entry.id === id);
  invariant(policyEntry, `Unexpected platform receipt: ${id}`);
  invariant(receipt.platform === policyEntry.platform, `${id} platform mismatch`);
  invariant(receipt.architecture === policyEntry.architecture, `${id} architecture mismatch`);
  invariant(receipt.node === `v${policyEntry.node}`, `${id} Node version mismatch`);
  observedIds.push(id);
}
invariant(JSON.stringify(observedIds.sort()) === JSON.stringify(expectedIds), "Mandatory platform receipt set differs from policy");

await writeFile(output, `${JSON.stringify({
  schemaVersion: 3,
  decision: "PLATFORM_MATRIX_VERIFIED_NOT_RELEASE_AUTHORIZED",
  releaseEligible: false,
  releaseEnvelopeSha256,
  candidateSha256: envelope.tarball.sha256,
  releaseInputsSha256: envelope.releaseInputs.sha256,
  identities: envelope.identities,
  sourceCommit: envelope.sourceCommit,
  platformReceipts: expectedIds,
  limitations: [
    "NO_AUTHENTICATED_RECEIPT_OBSERVER",
    "NO_SEMANTIC_CHANNEL_TRANSACTION_EVIDENCE",
    "NO_CROSS_CHANNEL_UPDATE_OR_RECOVERY_REHEARSAL",
    "NO_RELEASE_APPROVAL_LEASE",
  ],
}, null, 2)}\n`, { flag: "wx" });
process.stdout.write('{"status":"platform-matrix-verified-not-release-authorized","releaseEligible":false}\n');
