import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, readJson, sha256File, validateEnvelope, verifyEnvelopeFiles } from "./lib/release-evidence.mjs";
import { releaseInputIdentities } from "./lib/release-inputs.mjs";
import { syntheticReleaseInputs } from "./lib/release-test-fixture.mjs";
import { withOwnedTempDirectory } from "./lib/owned-temp.mjs";

const args = parseArgs(process.argv.slice(2));

if (args.get("self-test") === "true") {
  await withOwnedTempDirectory("cuna-envelope-test-", async (root) => {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "cuna.tgz"), "candidate");
    await writeFile(path.join(root, "sbom.json"), "{}");
    await writeFile(path.join(root, "support.json"), "{}");
    const releaseInputs = syntheticReleaseInputs({ version: "1.2.3-test.1", sourceCommit: "a".repeat(40) });
    await writeFile(path.join(root, "release-inputs.json"), `${JSON.stringify(releaseInputs)}\n`);
    const envelope = {
    schemaVersion: 2,
    packageName: "@cuna_labs/cli",
    version: "1.2.3-test.1",
    sourceCommit: "a".repeat(40),
    repository: "Cuna-Labs/cuna-cli",
    registry: "https://registry.npmjs.org",
    tarball: {
      file: "cuna.tgz",
      url: "https://registry.npmjs.org/@cuna_labs/cli/-/cli-1.2.3-test.1.tgz",
      sha256: await sha256File(path.join(root, "cuna.tgz")),
      size: 9,
    },
    sbom: { file: "sbom.json", sha256: await sha256File(path.join(root, "sbom.json")) },
    supportPolicy: { file: "support.json", sha256: await sha256File(path.join(root, "support.json")) },
    releaseInputs: { file: "release-inputs.json", sha256: await sha256File(path.join(root, "release-inputs.json")) },
    identities: releaseInputIdentities(releaseInputs),
    authority: {
      phase: "CANDIDATE_BUILT",
      releaseEligible: false,
      approval: { state: "REQUIRED_NOT_PRESENT", environment: "npm", receiptSha256: null },
      provenance: { state: "REQUIRED_NOT_PRESENT", workflow: ".github/workflows/ci.yml", receiptSha256: null },
    },
    builder: { workflow: ".github/workflows/ci.yml", runId: "1", runAttempt: "1" },
    };
    await verifyEnvelopeFiles(envelope, root);
    await writeFile(path.join(root, "cuna.tgz"), "substituted");
    await expectRejected(() => verifyEnvelopeFiles(envelope, root), "substituted tarball was accepted");
    await writeFile(path.join(root, "cuna.tgz"), "candidate");
    await writeFile(path.join(root, "release-inputs.json"), `${JSON.stringify({ ...releaseInputs, sourceCommit: "b".repeat(40) })}\n`);
    await expectRejected(() => verifyEnvelopeFiles(envelope, root), "substituted release inputs were accepted");
    const fabricatedApproval = structuredClone(envelope);
    fabricatedApproval.authority.approval = { state: "VERIFIED", environment: "npm", receiptSha256: "f".repeat(64) };
    await expectRejected(() => Promise.resolve(validateEnvelope(fabricatedApproval)), "fabricated approval was accepted");
    const legacy = structuredClone(envelope);
    legacy.schemaVersion = 1;
    await expectRejected(() => Promise.resolve(validateEnvelope(legacy)), "release-envelope v1 was accepted");
  });
  process.stdout.write('{"status":"negative-control-passed"}\n');
} else {
  const root = path.resolve(args.get("root") ?? "release-artifacts");
  const envelope = await readJson(path.join(root, args.get("envelope") ?? "release-envelope.json"));
  validateEnvelope(envelope);
  await verifyEnvelopeFiles(envelope, root);
  process.stdout.write(`${JSON.stringify({ status: "verified", version: envelope.version, sha256: envelope.tarball.sha256 })}\n`);
}

async function expectRejected(action, message) {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`Negative control failed: ${message}`);
}
