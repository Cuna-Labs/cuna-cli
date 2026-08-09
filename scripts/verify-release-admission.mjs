import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { invariant, parseArgs, readJson, verifyEnvelopeFiles } from "./lib/release-evidence.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const evidenceRoot = path.resolve(root, args.get("evidence") ?? "release-artifacts");
const receiptsRoot = path.resolve(root, args.get("receipts") ?? "evidence/platform-receipts");
const output = path.resolve(root, args.get("output") ?? "evidence/admission.json");
const envelope = await readJson(path.join(evidenceRoot, "release-envelope.json"));
await verifyEnvelopeFiles(envelope, evidenceRoot);
const policy = await readJson(path.join(evidenceRoot, envelope.supportPolicy.file));
const expectedIds = policy.ciMatrix.map((entry) => entry.id).sort();
const files = (await readdir(receiptsRoot)).filter((file) => file.endsWith(".json")).sort();
invariant(files.length === expectedIds.length, `Expected ${expectedIds.length} platform receipts, found ${files.length}`);

const observedIds = [];
for (const file of files) {
  const receipt = JSON.parse(await readFile(path.join(receiptsRoot, file), "utf8"));
  invariant(receipt.candidateSha256 === envelope.tarball.sha256, `${file} candidate digest mismatch`);
  invariant(receipt.sourceCommit === envelope.sourceCommit, `${file} source commit mismatch`);
  invariant(receipt.selfTest === "PASS" && receipt.versionIdentity === "PASS", `${file} did not pass installed-artifact gates`);
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
  decision: "CANDIDATE_ADMITTED_FOR_EXTERNAL_RELEASE_REVIEW",
  candidateSha256: envelope.tarball.sha256,
  sourceCommit: envelope.sourceCommit,
  platformReceipts: expectedIds,
  limitation: "This receipt does not publish, promote, or prove any installation channel is live.",
}, null, 2)}\n`, { flag: "wx" });
process.stdout.write('{"status":"admitted-for-external-release-review"}\n');
