import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { sha256File } from "../scripts/lib/release-evidence.mjs";
import { syntheticReleaseEnvelope, syntheticReleaseInputs } from "../scripts/lib/release-test-fixture.mjs";
import { TestResourceLedger } from "./support/test-resource-ledger.mjs";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const resources = new TestResourceLedger();
test.after(() => resources.cleanup());

async function createAdmissionFixture() {
  const root = await resources.createTempDirectory("runa-admission-test-");
  const evidence = path.join(root, "release-artifacts");
  const receipts = path.join(root, "receipts");
  await mkdir(evidence, { recursive: true });
  await mkdir(receipts, { recursive: true });
  const version = "1.2.3-preview.1";
  const sourceCommit = "a".repeat(40);
  const tarballFile = `runa_laboratories-cli-${version}.tgz`;
  await writeFile(path.join(evidence, tarballFile), "candidate bytes\n");
  await cp(path.join(repositoryRoot, "packaging", "support-policy.json"), path.join(evidence, "support-policy.json"));
  const policy = JSON.parse(await readFile(path.join(evidence, "support-policy.json"), "utf8"));
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: { component: { type: "application", name: "@runa_laboratories/cli", version, purl: `pkg:npm/%40runa_laboratories/cli@${version}` } },
  };
  await writeFile(path.join(evidence, "sbom.cdx.json"), `${JSON.stringify(sbom)}\n`);
  const releaseInputs = syntheticReleaseInputs({ version, sourceCommit });
  await writeFile(path.join(evidence, "release-inputs.json"), `${JSON.stringify(releaseInputs)}\n`);
  const envelope = syntheticReleaseEnvelope({
    version,
    sourceCommit,
    tarball: {
      file: tarballFile,
      url: `https://registry.npmjs.org/@runa_laboratories/cli/-/cli-${version}.tgz`,
      sha256: await sha256File(path.join(evidence, tarballFile)),
      size: (await readFile(path.join(evidence, tarballFile))).length,
    },
    sbom: { file: "sbom.cdx.json", sha256: await sha256File(path.join(evidence, "sbom.cdx.json")) },
    supportPolicy: { file: "support-policy.json", sha256: await sha256File(path.join(evidence, "support-policy.json")) },
    releaseInputs,
    releaseInputsSha256: await sha256File(path.join(evidence, "release-inputs.json")),
  });
  await writeFile(path.join(evidence, "release-envelope.json"), `${JSON.stringify(envelope, null, 2)}\n`);
  const envelopeSha256 = await sha256File(path.join(evidence, "release-envelope.json"));
  for (const entry of policy.ciMatrix) {
    const receipt = {
      schemaVersion: 2,
      releaseEnvelopeSha256: envelopeSha256,
      candidateSha256: envelope.tarball.sha256,
      releaseInputsSha256: envelope.releaseInputs.sha256,
      identities: envelope.identities,
      sourceCommit,
      platform: entry.platform,
      architecture: entry.architecture,
      node: `v${entry.node}`,
      selfTest: "PASS",
      versionIdentity: "PASS",
      uninstallCleanup: "PASS",
      observedAt: new Date().toISOString(),
    };
    await writeFile(path.join(receipts, `${entry.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  }
  return { root, evidence, receipts, firstReceipt: path.join(receipts, `${policy.ciMatrix[0].id}.json`) };
}

async function verifyAdmission(fixture) {
  return execute(process.execPath, [
    "scripts/verify-release-admission.mjs",
    "--root", fixture.root,
    "--evidence", fixture.evidence,
    "--receipts", fixture.receipts,
    "--output", path.join(fixture.root, "admission.json"),
  ], { cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024 });
}

async function mutateFirstReceipt(fixture, mutate) {
  const receipt = JSON.parse(await readFile(fixture.firstReceipt, "utf8"));
  mutate(receipt);
  await writeFile(fixture.firstReceipt, `${JSON.stringify(receipt, null, 2)}\n`);
}

test("TC-053-12 complete platform receipts are never elevated to release authorization", async () => {
  const fixture = await createAdmissionFixture();
  await assert.doesNotReject(verifyAdmission(fixture));
  const admission = JSON.parse(await readFile(path.join(fixture.root, "admission.json"), "utf8"));
  assert.equal(admission.schemaVersion, 3);
  assert.equal(admission.decision, "PLATFORM_MATRIX_VERIFIED_NOT_RELEASE_AUTHORIZED");
  assert.equal(admission.releaseEligible, false);
  assert.ok(admission.limitations.includes("NO_AUTHENTICATED_RECEIPT_OBSERVER"));
});

test("TC-053-08 release admission rejects failed or missing uninstall cleanup", async () => {
  const failed = await createAdmissionFixture();
  await mutateFirstReceipt(failed, (receipt) => { receipt.uninstallCleanup = "FAIL"; });
  await assert.rejects(verifyAdmission(failed), /installed-artifact gates/);

  const missing = await createAdmissionFixture();
  await mutateFirstReceipt(missing, (receipt) => { delete receipt.uninstallCleanup; });
  await assert.rejects(verifyAdmission(missing), /keys differ/);
});

test("TC-053-09 release admission rejects unknown receipt fields", async () => {
  const fixture = await createAdmissionFixture();
  await mutateFirstReceipt(fixture, (receipt) => { receipt.unverifiedClaim = "PASS"; });
  await assert.rejects(verifyAdmission(fixture), /keys differ/);
});

test("TC-053-09 release admission rejects stale or future receipts", async () => {
  const stale = await createAdmissionFixture();
  await mutateFirstReceipt(stale, (receipt) => { receipt.observedAt = "2020-01-01T00:00:00.000Z"; });
  await assert.rejects(verifyAdmission(stale), /receipt is stale/);

  const future = await createAdmissionFixture();
  await mutateFirstReceipt(future, (receipt) => { receipt.observedAt = "2099-01-01T00:00:00.000Z"; });
  await assert.rejects(verifyAdmission(future), /observedAt is in the future/);
});

test("TC-053-09 release admission cannot widen receipt freshness beyond 24 hours", async () => {
  const fixture = await createAdmissionFixture();
  await assert.rejects(
    execute(process.execPath, [
      "scripts/verify-release-admission.mjs",
      "--root", fixture.root,
      "--evidence", fixture.evidence,
      "--receipts", fixture.receipts,
      "--output", path.join(fixture.root, "admission.json"),
      "--maximum-age-hours", "168",
    ], { cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024 }),
    /no more than 24/,
  );
});
