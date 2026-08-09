import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { sha256File } from "../scripts/lib/release-evidence.mjs";
import { syntheticReleaseEnvelope, syntheticReleaseInputs } from "../scripts/lib/release-test-fixture.mjs";
import { CHANNEL_DEFINITIONS, CHANNEL_ORDER } from "../scripts/release-distribution-lib.mjs";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const node = process.execPath;

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "runa-distribution-test-"));
  const evidence = path.join(root, "evidence");
  const distributions = path.join(root, "distributions");
  await mkdir(evidence, { recursive: true });
  const version = "1.2.3-preview.1";
  const tarballFile = "runa_laboratories-cli-1.2.3-preview.1.tgz";
  await writeFile(path.join(evidence, tarballFile), "immutable candidate bytes\n");
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: "urn:uuid:97b8e913-1cf0-4f90-8a12-ace7670af258",
    version: 1,
    metadata: { component: { type: "application", name: "@runa_laboratories/cli", version } },
    components: [],
  };
  await writeFile(path.join(evidence, "sbom.cdx.json"), `${JSON.stringify(sbom)}\n`);
  await cp(path.join(repositoryRoot, "packaging", "support-policy.json"), path.join(evidence, "support-policy.json"));
  const releaseInputs = syntheticReleaseInputs({ version, sourceCommit: "a".repeat(40) });
  await writeFile(path.join(evidence, "release-inputs.json"), `${JSON.stringify(releaseInputs)}\n`);
  const envelope = syntheticReleaseEnvelope({
    version,
    sourceCommit: "a".repeat(40),
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
  return { root, evidence, distributions, envelope };
}

async function project(fixture, output = fixture.distributions) {
  return execute(node, [
    "scripts/release-project-distributions.mjs",
    "--root", repositoryRoot,
    "--evidence", fixture.evidence,
    "--output", output,
  ], { cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024 });
}

async function verify(fixture, output = fixture.distributions) {
  return execute(node, [
    "scripts/verify-release-distributions.mjs",
    "--root", repositoryRoot,
    "--evidence", fixture.evidence,
    "--distributions", output,
  ], { cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024 });
}

test("all approved channels are deterministic projections of one blocked local candidate", async () => {
  const fixture = await createFixture();
  const first = JSON.parse((await project(fixture)).stdout);
  assert.equal(first.status, "DISTRIBUTIONS_PROJECTED_NOT_PUBLISHED");
  assert.equal(first.decision, "BLOCKED");
  assert.deepEqual(first.channels, CHANNEL_ORDER);
  const verified = JSON.parse((await verify(fixture)).stdout);
  assert.equal(verified.status, "DISTRIBUTION_PROJECTIONS_VERIFIED");
  assert.equal(verified.decision, "BLOCKED");
  assert.ok(verified.channels.every((channel) => channel.availability === "PROJECTED_NOT_PUBLISHED"));

  const secondOutput = path.join(fixture.root, "second-distributions");
  await project(fixture, secondOutput);
  const firstManifest = await readFile(path.join(fixture.distributions, "distribution-manifest.json"), "utf8");
  const secondManifest = await readFile(path.join(secondOutput, "distribution-manifest.json"), "utf8");
  assert.equal(firstManifest, secondManifest);
  for (const definition of Object.values(CHANNEL_DEFINITIONS)) {
    assert.doesNotMatch(await readFile(path.join(fixture.distributions, definition.projectionFile), "utf8"), /\r/);
    assert.equal(
      await sha256File(path.join(fixture.distributions, definition.projectionFile)),
      await sha256File(path.join(secondOutput, definition.projectionFile)),
    );
  }
});

test("a substituted candidate tarball invalidates every distribution projection", async () => {
  const fixture = await createFixture();
  await project(fixture);
  await writeFile(path.join(fixture.evidence, fixture.envelope.tarball.file), "substituted bytes\n");
  await assert.rejects(verify(fixture), /Tarball digest mismatch/);
});

test("a syntactically valid but semantically mismatched SBOM is rejected", async () => {
  const fixture = await createFixture();
  const sbomFile = path.join(fixture.evidence, fixture.envelope.sbom.file);
  const sbom = JSON.parse(await readFile(sbomFile, "utf8"));
  sbom.metadata.component.version = "9.9.9";
  await writeFile(sbomFile, `${JSON.stringify(sbom)}\n`);
  fixture.envelope.sbom.sha256 = await sha256File(sbomFile);
  await writeFile(path.join(fixture.evidence, "release-envelope.json"), `${JSON.stringify(fixture.envelope, null, 2)}\n`);
  await assert.rejects(project(fixture), /SBOM component version differs/);
});

test("local projection evidence cannot be relabeled as a live channel", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const manifestFile = path.join(fixture.distributions, "distribution-manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.channels[0].availability = "LIVE";
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(verify(fixture), /may not claim live availability/);
});

test("cross-channel candidate substitution is rejected even with a well-formed digest", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const manifestFile = path.join(fixture.distributions, "distribution-manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.channels.find((channel) => channel.id === "bun").artifactSha256 = "f".repeat(64);
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(verify(fixture), /does not bind the candidate tarball/);
});

test("generation refuses to overwrite an existing projection bundle", async () => {
  const fixture = await createFixture();
  await project(fixture);
  await assert.rejects(project(fixture), /EEXIST/);
});

async function createReceiptSet(fixture) {
  const receipts = path.join(fixture.root, "receipts");
  await mkdir(receipts, { recursive: true });
  const manifestFile = path.join(fixture.distributions, "distribution-manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const manifestSha256 = await sha256File(manifestFile);
  const observedAt = new Date().toISOString();
  for (const channel of manifest.channels) {
    for (const platformKey of channel.platforms) {
      const id = `${channel.id}-${platformKey}`;
      const [platform, architecture] = platformKey.split("-");
      const raw = {};
      for (const evidenceName of ["install", "selfTest", "version", "provenance", "uninstall", "recovery"]) {
        const relative = `raw/${id}/${evidenceName}.txt`;
        const absolute = path.join(receipts, ...relative.split("/"));
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, `${id} ${evidenceName} PASS\n`);
        raw[evidenceName] = { file: relative, sha256: await sha256File(absolute) };
      }
      const receipt = {
        schemaVersion: 2,
        channel: channel.id,
        distributionManifestSha256: manifestSha256,
        candidate: {
          packageName: manifest.candidate.packageName,
          version: manifest.candidate.version,
          sourceCommit: manifest.candidate.sourceCommit,
          tarballSha256: manifest.candidate.tarball.sha256,
          sbomSha256: manifest.candidate.sbom.sha256,
          releaseInputsSha256: manifest.candidate.releaseInputs.sha256,
          payloadSha256: manifest.candidate.identities.payloadSha256,
        },
        projectionSha256: channel.projection.sha256,
        runtimeIdentity: {
          version: manifest.candidate.version,
          buildDigest: manifest.candidate.identities.payloadSha256,
          platform,
          architecture,
          artifactChannel: "npm",
          installerOfRecord: channel.installerOfRecord,
          protocolRange: { minimum: "1", maximum: "1" },
        },
        checks: {
          selfTest: "PASS",
          provenance: "PASS",
          supportPolicy: "PASS",
          uninstallCleanup: "PASS",
          rollbackOrFixedForward: "PASS",
        },
        evidence: raw,
        observer: { kind: "policy-approved-real-host", identity: `fixture:${id}` },
        observedAt,
      };
      await writeFile(path.join(receipts, `${id}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
    }
  }
  return receipts;
}

async function verifyReceipts(fixture, receipts) {
  return execute(node, [
    "scripts/verify-distribution-receipts.mjs",
    "--root", repositoryRoot,
    "--evidence", fixture.evidence,
    "--distributions", fixture.distributions,
    "--receipts", receipts,
    "--maximum-age-hours", "24",
  ], { cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024 });
}

test("complete content-addressed receipts prove channel identity but not full release readiness", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  const result = JSON.parse((await verifyReceipts(fixture, receipts)).stdout);
  assert.equal(result.distributionGate, "PASS");
  assert.equal(result.releaseDecision, "BLOCKED");
  assert.equal(result.receipts.length, 11);
  assert.equal(result.installedBuildDigest, fixture.envelope.identities.payloadSha256);
});

test("receipt verification detects cross-installer build drift", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  const file = path.join(receipts, "bun-win32-x64.json");
  const receipt = JSON.parse(await readFile(file, "utf8"));
  receipt.runtimeIdentity.buildDigest = "f".repeat(64);
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  await assert.rejects(verifyReceipts(fixture, receipts), /Cross-installer installed build identities differ/);
});

test("receipt verification detects tampered raw recovery evidence", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  await writeFile(path.join(receipts, "raw", "aur-linux-x64", "recovery.txt"), "tampered\n");
  await assert.rejects(verifyReceipts(fixture, receipts), /raw evidence digest mismatch/);
});

test("receipt verification rejects stale evidence", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  const file = path.join(receipts, "npm-linux-x64.json");
  const receipt = JSON.parse(await readFile(file, "utf8"));
  receipt.observedAt = "2020-01-01T00:00:00.000Z";
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  await assert.rejects(verifyReceipts(fixture, receipts), /receipt is stale/);
});

test("actual local artifact evidence is useful but can never authorize release", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runa-local-evidence-test-"));
  const output = path.join(root, "local-evidence");
  const generated = JSON.parse((await execute(node, [
    "scripts/release-local-artifact-evidence.mjs",
    "--root", repositoryRoot,
    "--output", output,
  ], { cwd: repositoryRoot, maxBuffer: 32 * 1024 * 1024, timeout: 180_000 })).stdout);
  assert.equal(generated.status, "LOCAL_CANDIDATE_VERIFIED_NOT_RELEASE_ELIGIBLE");
  const verified = JSON.parse((await execute(node, [
    "scripts/verify-local-distribution-evidence.mjs",
    "--root", output,
  ], { cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024 })).stdout);
  assert.equal(verified.releaseEligible, false);

  const recordFile = path.join(output, "local-artifact-evidence.json");
  const record = JSON.parse(await readFile(recordFile, "utf8"));
  record.releaseEligible = true;
  await writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  await assert.rejects(
    execute(node, ["scripts/verify-local-distribution-evidence.mjs", "--root", output], { cwd: repositoryRoot }),
    /may not claim release eligibility/,
  );
});
