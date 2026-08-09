import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { PACKAGE_NAME, REPOSITORY, invariant, parseArgs, readJson, sha256File } from "./lib/release-evidence.mjs";
import { exactKeys, normalizeRelativeFile, validateCycloneDxSbom, validateSupportPolicy } from "./release-distribution-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? "evidence/local-distribution");
const record = await readJson(path.join(root, "local-artifact-evidence.json"));
exactKeys(record, [
  "schemaVersion", "authority", "releaseEligible", "limitations", "repository", "sourceCommit", "sourceTreeStatus",
  "sourceStatusSha256", "package", "artifact", "sbom", "supportPolicy", "runtimeIdentity", "observations", "environment", "generatedAt",
], "local artifact evidence");
invariant(record.schemaVersion === 1, "Unsupported local-artifact evidence schema");
invariant(record.authority === "LOCAL_NON_RELEASE_EVIDENCE", "Local evidence authority was elevated");
invariant(record.releaseEligible === false, "Local evidence may not claim release eligibility");
invariant(record.repository === REPOSITORY, "Local evidence repository mismatch");
invariant(/^[0-9a-f]{40}$/.test(record.sourceCommit), "Local evidence source commit is invalid");
invariant(["CLEAN", "DIRTY"].includes(record.sourceTreeStatus), "Local source-tree state is invalid");
invariant(/^[0-9a-f]{64}$/.test(record.sourceStatusSha256), "Local source-status digest is invalid");
invariant(record.package?.name === PACKAGE_NAME, "Local package name mismatch");
invariant(typeof record.package.version === "string", "Local package version is missing");
const limitations = new Set(record.limitations);
for (const limitation of [
  "NO_TRUSTED_PUBLISHER_OR_REGISTRY_PROVENANCE",
  "NO_EXTERNAL_CHANNEL_INSTALL_RECEIPTS",
  "NO_CROSS_PLATFORM_RECEIPTS",
  "NO_ROLLBACK_OR_FIXED_FORWARD_REHEARSAL",
  "NO_COHORT_OBSERVATION_OR_RELEASE_APPROVAL_LEASE",
]) invariant(limitations.has(limitation), `Mandatory local-evidence limitation missing: ${limitation}`);

for (const [label, evidence] of [
  ["artifact", record.artifact],
  ["sbom", record.sbom],
  ["supportPolicy", record.supportPolicy],
  ["selfTest", record.observations?.selfTest],
  ["version", record.observations?.version],
]) {
  invariant(evidence && typeof evidence === "object", `${label} evidence is missing`);
  const relative = normalizeRelativeFile(evidence.file, `${label}.file`);
  const absolute = path.resolve(root, relative);
  invariant(absolute.startsWith(`${root}${path.sep}`), `${label} evidence escapes its root`);
  invariant((await sha256File(absolute)) === evidence.sha256, `${label} evidence digest mismatch`);
}
invariant((await stat(path.join(root, record.artifact.file))).size === record.artifact.size, "Local artifact size mismatch");
await validateCycloneDxSbom(path.join(root, record.sbom.file), { version: record.package.version });
validateSupportPolicy(await readJson(path.join(root, record.supportPolicy.file)));
const selfTest = await readJson(path.join(root, record.observations.selfTest.file));
const version = await readJson(path.join(root, record.observations.version.file));
invariant(selfTest?.data?.ok === true, "Recorded local self-test did not pass");
invariant(version?.data?.version === record.package.version, "Recorded local runtime version mismatch");
invariant(version?.data?.buildDigest === record.runtimeIdentity?.buildDigest, "Recorded local build identity mismatch");
invariant(version?.data?.platform === record.environment?.platform, "Recorded local platform mismatch");
invariant(version?.data?.architecture === record.environment?.architecture, "Recorded local architecture mismatch");
invariant(version?.data?.updateChannel === "npm", "Recorded local artifact channel mismatch");
invariant(!Number.isNaN(Date.parse(record.generatedAt)), "Local evidence timestamp is invalid");

process.stdout.write(`${JSON.stringify({
  status: "LOCAL_DISTRIBUTION_EVIDENCE_VERIFIED",
  releaseEligible: false,
  artifactSha256: record.artifact.sha256,
  buildDigest: record.runtimeIdentity.buildDigest,
  limitations: record.limitations,
})}\n`);

