import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { sha256File } from "../scripts/lib/release-evidence.mjs";
import { syntheticReleaseEnvelope, syntheticReleaseInputs } from "../scripts/lib/release-test-fixture.mjs";
import {
  canonicalSha256,
  CHANNEL_DEFINITIONS,
  CHANNEL_ORDER,
  distributionReceiptId,
  normalizeReceiptEvidenceFile,
} from "../scripts/release-distribution-lib.mjs";
import { TestResourceLedger } from "./support/test-resource-ledger.mjs";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const node = process.execPath;
const resources = new TestResourceLedger();
test.after(() => resources.cleanup());

async function createFixture() {
  const root = await resources.createTempDirectory("runa-distribution-test-");
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
    metadata: {
      component: {
        type: "application",
        name: "@runa_laboratories/cli",
        version,
        purl: `pkg:npm/%40runa_laboratories/cli@${version}`,
        "bom-ref": `@runa_laboratories/cli@${version}`,
      },
    },
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

async function mutateAndRebindProjection(fixture, channelId, mutate) {
  const manifestFile = path.join(fixture.distributions, "distribution-manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const channel = manifest.channels.find((entry) => entry.id === channelId);
  assert.ok(channel, `fixture must contain ${channelId}`);
  const projectionFile = path.join(fixture.distributions, ...channel.projection.file.split("/"));
  const original = await readFile(projectionFile, "utf8");
  const mutated = mutate(original);
  assert.notEqual(mutated, original, `${channelId} negative control must alter the projection`);
  await chmod(projectionFile, 0o644);
  await writeFile(projectionFile, mutated);
  const digest = await sha256File(projectionFile);
  channel.projection.sha256 = digest;
  manifest.files[channel.projection.file] = digest;
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
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

test("SBOM authority follows package identity rather than checkout-derived display metadata", async () => {
  const fixture = await createFixture();
  const sbomFile = path.join(fixture.evidence, fixture.envelope.sbom.file);
  const sbom = JSON.parse(await readFile(sbomFile, "utf8"));
  sbom.metadata.component.name = path.basename(fixture.root);
  sbom.metadata.component["bom-ref"] = fixture.root;
  await writeFile(sbomFile, `${JSON.stringify(sbom)}\n`);
  fixture.envelope.sbom.sha256 = await sha256File(sbomFile);
  await writeFile(path.join(fixture.evidence, "release-envelope.json"), `${JSON.stringify(fixture.envelope, null, 2)}\n`);
  await assert.doesNotReject(project(fixture));
});

test("SBOM display metadata cannot substitute a different package identity", async () => {
  const fixture = await createFixture();
  const sbomFile = path.join(fixture.evidence, fixture.envelope.sbom.file);
  const sbom = JSON.parse(await readFile(sbomFile, "utf8"));
  sbom.metadata.component.name = "@runa_laboratories/cli";
  sbom.metadata.component.purl = `pkg:npm/other-package@${fixture.envelope.version}`;
  await writeFile(sbomFile, `${JSON.stringify(sbom)}\n`);
  fixture.envelope.sbom.sha256 = await sha256File(sbomFile);
  await writeFile(path.join(fixture.evidence, "release-envelope.json"), `${JSON.stringify(fixture.envelope, null, 2)}\n`);
  await assert.rejects(project(fixture), /SBOM component identity differs/);
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

test("curl projection verification detects loss of atomic activation after digest rebinding", async () => {
  const fixture = await createFixture();
  await project(fixture);
  await mutateAndRebindProjection(
    fixture,
    "curl",
    (source) => source.replace('mv -f "$launcher_tmp" "$launcher"', 'cp "$launcher_tmp" "$launcher"'),
  );
  await assert.rejects(verify(fixture), /does not atomically activate/);
});

test("Homebrew projection verification detects fallback to ambient Node after digest rebinding", async () => {
  const fixture = await createFixture();
  await project(fixture);
  await mutateAndRebindProjection(
    fixture,
    "homebrew",
    (source) => source.replace('exec "#{node_formula.opt_bin}/node" "#{cli}" "$@"', 'exec node "#{cli}" "$@"'),
  );
  await assert.rejects(verify(fixture), /does not pin Node/);
});

test("AUR projection verification detects an unsupported Node-major range after digest rebinding", async () => {
  const fixture = await createFixture();
  await project(fixture);
  await mutateAndRebindProjection(
    fixture,
    "aur",
    (source) => source.replace("depends=('nodejs-lts-jod>=22.17.1')", "depends=('nodejs>=22')"),
  );
  await assert.rejects(verify(fixture), /runtime dependency differs from support policy/);
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
  const supportPolicy = JSON.parse(await readFile(path.join(fixture.evidence, "support-policy.json"), "utf8"));
  const manifestSha256 = await sha256File(manifestFile);
  const observedAt = new Date().toISOString();
  const packageManagerVersions = { npm: "10.9.2", bun: "1.2.19", homebrew: "4.4.32", pacman: "7.0.0" };
  for (const channel of manifest.channels) {
    const definition = supportPolicy.channels[channel.id];
    assert.ok(definition, `support policy defines ${channel.id}`);
    for (const platformKey of channel.platforms) {
      const [platform, architecture] = platformKey.split("-");
      for (const testedNodeVersion of definition.testedNodeVersions) {
      const nodeVersion = `v${testedNodeVersion}`;
      const id = distributionReceiptId(channel.id, platformKey, nodeVersion);
      const runtimeIdentity = {
        version: manifest.candidate.version,
        buildDigest: manifest.candidate.identities.payloadSha256,
        platform,
        architecture,
        node: nodeVersion,
        artifactChannel: "npm",
        installerOfRecord: channel.installerOfRecord,
        protocolRange: { minimum: "1", maximum: "1" },
      };
      const execution = {
        stableTestId: "TC-053-DISTRIBUTION-CHANNEL-TRANSACTION-V1",
        packageManager: {
          name: channel.installerOfRecord,
          version: packageManagerVersions[channel.installerOfRecord],
        },
        candidateInvocation: channel.candidateInvocation,
        environmentPolicy: {
          kind: "ephemeral-dedicated-prefix",
          networkPolicy: "INSTALL_ONLY_THEN_OFFLINE",
          userStateSentinels: true,
          environmentId: id,
        },
        publicShimResolution: {
          command: "runa",
          resolutionMethod: "shell-path",
          resolvedPath: platform === "win32"
            ? `C:\\runa-receipt-fixture\\${id}\\bin\\runa.cmd`
            : `/tmp/runa-receipt-fixture/${id}/bin/runa`,
          internalModuleBypass: false,
        },
      };
      const executionContextSha256 = canonicalSha256(execution);
      const raw = {
        install: {
          schemaVersion: 1,
          type: "INSTALL",
          executionContextSha256,
          commandExitCode: 0,
          packageName: manifest.candidate.packageName,
          version: manifest.candidate.version,
          tarballSha256: manifest.candidate.tarball.sha256,
          payloadSha256: manifest.candidate.identities.payloadSha256,
          artifactChannel: "npm",
          installerOfRecord: channel.installerOfRecord,
          projectionSha256: channel.projection.sha256,
        },
        selfTest: {
          schemaVersion: 1,
          type: "SELF_TEST",
          executionContextSha256,
          commandExitCode: 0,
          offline: true,
          networkRequests: 0,
          runtimeIdentity,
        },
        version: {
          schemaVersion: 1,
          type: "VERSION",
          executionContextSha256,
          commandExitCode: 0,
          reportedVersion: manifest.candidate.version,
        },
        provenance: {
          schemaVersion: 1,
          type: "PROVENANCE",
          executionContextSha256,
          packageName: manifest.candidate.packageName,
          version: manifest.candidate.version,
          sourceCommit: manifest.candidate.sourceCommit,
          tarballSha256: manifest.candidate.tarball.sha256,
          sbomSha256: manifest.candidate.sbom.sha256,
          releaseInputsSha256: manifest.candidate.releaseInputs.sha256,
          payloadSha256: manifest.candidate.identities.payloadSha256,
          projectionSha256: channel.projection.sha256,
        },
        uninstall: {
          schemaVersion: 1,
          type: "UNINSTALL",
          executionContextSha256,
          commandExitCode: 0,
          managedPathsBefore: 4,
          managedPathsAfter: 0,
          foreignPathsBefore: 2,
          foreignPathsAfter: 2,
          commandAvailableAfter: false,
        },
        recovery: {
          schemaVersion: 1,
          type: "RECOVERY",
          executionContextSha256,
          strategy: "ROLLBACK",
          commandExitCode: 0,
          sourceVersion: manifest.candidate.version,
          sourceBuildDigest: manifest.candidate.identities.payloadSha256,
          recoveredVersion: "1.2.2",
          recoveredBuildDigest: "b".repeat(64),
          healthCheckExitCode: 0,
        },
      };
      const observationTypes = {
        install: "INSTALL",
        selfTest: "SELF_TEST",
        version: "VERSION",
        provenance: "PROVENANCE",
        uninstall: "UNINSTALL",
        recovery: "RECOVERY",
      };
      const observationReferences = {};
      for (const [observationName, observation] of Object.entries(raw)) {
        const relative = `raw/${id}/${observationName}.json`;
        const absolute = path.join(receipts, ...relative.split("/"));
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, `${JSON.stringify(observation, null, 2)}\n`);
        observationReferences[observationName] = {
          type: observationTypes[observationName],
          file: relative,
          sha256: await sha256File(absolute),
        };
      }
      const matrixEntry = supportPolicy.ciMatrix.find((entry) =>
        entry.claim !== "observation-only" &&
        entry.platform === platform &&
        entry.architecture === architecture &&
        entry.node === testedNodeVersion);
      assert.ok(matrixEntry, `fixture lacks a required support-policy lane for ${id}`);
      const runnerImage = matrixEntry.runner;
      const statement = {
        schemaVersion: 1,
        predicateType: "https://runacode.io/attestations/runa-cli-distribution-observation/v1",
        issuer: {
          provider: "github-actions",
          repository: manifest.candidate.repository,
          workflow: ".github/workflows/release.yml",
          workflowRef: `${manifest.candidate.repository}/.github/workflows/release.yml@refs/heads/main`,
          sourceRef: `refs/tags/v${manifest.candidate.version}`,
          sourceCommit: manifest.candidate.sourceCommit,
          runId: "987654321",
          runAttempt: 1,
        },
        subject: {
          receiptId: id,
          channel: channel.id,
          platform,
          architecture,
          node: nodeVersion,
          distributionManifestSha256: manifestSha256,
          candidatePayloadSha256: manifest.candidate.identities.payloadSha256,
          projectionSha256: channel.projection.sha256,
        },
        hostPolicy: {
          kind: "github-hosted-runner",
          runnerImage,
          platform,
          architecture,
          node: nodeVersion,
          supportPolicySha256: manifest.candidate.supportPolicy.sha256,
        },
        candidate: {
          packageName: manifest.candidate.packageName,
          version: manifest.candidate.version,
          sourceCommit: manifest.candidate.sourceCommit,
          tarballSha256: manifest.candidate.tarball.sha256,
          sbomSha256: manifest.candidate.sbom.sha256,
          releaseInputsSha256: manifest.candidate.releaseInputs.sha256,
          payloadSha256: manifest.candidate.identities.payloadSha256,
        },
        runtimeIdentity,
        execution,
        observations: observationReferences,
        observationsSha256: canonicalSha256(observationReferences),
        observedAt,
      };
      const statementSha256 = canonicalSha256(statement);
      const signingRelative = `raw/${id}/signing-verification.json`;
      const signingAbsolute = path.join(receipts, ...signingRelative.split("/"));
      const signingEvidence = {
        schemaVersion: 1,
        type: "GITHUB_OIDC_SIGNATURE_VERIFICATION",
        verificationState: "NOT_VERIFIED_PREPUBLICATION",
        statementSha256,
        bundleSha256: null,
        certificateIssuer: null,
        certificateIdentity: null,
        verifiedAt: null,
      };
      await writeFile(signingAbsolute, `${JSON.stringify(signingEvidence, null, 2)}\n`);
      const attestation = {
        statement,
        statementSha256,
        signingEvidence: {
          type: "GITHUB_OIDC_SIGNATURE_VERIFICATION",
          file: signingRelative,
          sha256: await sha256File(signingAbsolute),
        },
      };
      const receipt = {
        schemaVersion: 3,
        attestation,
        attestationSha256: canonicalSha256(attestation),
        releaseEligible: false,
      };
      await writeFile(path.join(receipts, `${id}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
      }
    }
  }
  return receipts;
}

function rebindReceipt(receipt) {
  receipt.attestation.statement.observationsSha256 = canonicalSha256(receipt.attestation.statement.observations);
  receipt.attestation.statementSha256 = canonicalSha256(receipt.attestation.statement);
  receipt.attestationSha256 = canonicalSha256(receipt.attestation);
}

async function rebindReceiptAndSigningEvidence(receipts, receipt) {
  rebindReceipt(receipt);
  const signingFile = path.join(receipts, ...receipt.attestation.signingEvidence.file.split("/"));
  const signingEvidence = JSON.parse(await readFile(signingFile, "utf8"));
  signingEvidence.statementSha256 = receipt.attestation.statementSha256;
  await writeFile(signingFile, `${JSON.stringify(signingEvidence, null, 2)}\n`);
  receipt.attestation.signingEvidence.sha256 = await sha256File(signingFile);
  receipt.attestationSha256 = canonicalSha256(receipt.attestation);
}

async function mutateRawObservation(receipts, id, observationName, mutate) {
  const receiptFile = path.join(receipts, `${id}.json`);
  const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
  const reference = receipt.attestation.statement.observations[observationName];
  const observationFile = path.join(receipts, ...reference.file.split("/"));
  const observation = JSON.parse(await readFile(observationFile, "utf8"));
  mutate(observation);
  await writeFile(observationFile, `${JSON.stringify(observation, null, 2)}\n`);
  reference.sha256 = await sha256File(observationFile);
  rebindReceipt(receipt);
  await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
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

test("typed self-authored receipts prove internal consistency but not observation truth or release readiness", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  const result = JSON.parse((await verifyReceipts(fixture, receipts)).stdout);
  assert.equal(result.status, "TYPED_OBSERVATION_CONSISTENCY_PASS");
  assert.equal(result.typedObservationConsistencyGate, "PASS");
  assert.equal(result.observationTruthAuthority, "NOT_ESTABLISHED");
  assert.equal(result.attestationAuthentication, "UNVERIFIED");
  assert.equal(result.distributionGate, "BLOCKED");
  assert.equal(result.releaseDecision, "BLOCKED");
  assert.equal(result.releaseEligible, false);
  assert.equal(result.receipts.length, 19);
  assert.ok(result.receipts.includes("npm-linux-x64-node22.17.1"));
  assert.ok(result.receipts.includes("npm-linux-x64-node24.4.1"));
  assert.equal(result.derivedChecks["npm-linux-x64-node22.17.1"].evidenceClass, "SELF_AUTHORED_TYPED_CLAIM");
  assert.ok(result.residualBlockers.includes("RECEIPT_REPLAY_LEASE_AUTHORITY_NOT_PRESENT"));
  assert.equal(result.installedBuildDigest, fixture.envelope.identities.payloadSha256);
});

test("receipt verification detects cross-installer build drift", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  const file = path.join(receipts, "bun-win32-x64-node22.17.1.json");
  const receipt = JSON.parse(await readFile(file, "utf8"));
  receipt.attestation.statement.runtimeIdentity.buildDigest = "f".repeat(64);
  rebindReceipt(receipt);
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  await assert.rejects(verifyReceipts(fixture, receipts), /Installed build digest differs from the candidate payload identity/);
});

test("receipt verification rejects a Node runtime outside the bound support policy", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  const file = (await readdir(receipts)).find((entry) => entry.endsWith(".json"));
  assert.ok(file);
  const receiptFile = path.join(receipts, file);
  const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
  receipt.attestation.statement.runtimeIdentity.node = "v25.0.0";
  receipt.attestation.statement.hostPolicy.node = "v25.0.0";
  rebindReceipt(receipt);
  await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  await assert.rejects(verifyReceipts(fixture, receipts), /Node version is outside the bound support policy/);
});

test("receipt verification detects tampered raw recovery evidence", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  await writeFile(path.join(receipts, "raw", "aur-linux-x64-node22.17.1", "recovery.json"), "{}\n");
  await assert.rejects(verifyReceipts(fixture, receipts), /raw observation digest mismatch/);
});

test("receipt verification rejects stale evidence", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  const file = path.join(receipts, "npm-linux-x64-node22.17.1.json");
  const receipt = JSON.parse(await readFile(file, "utf8"));
  receipt.attestation.statement.observedAt = "2020-01-01T00:00:00.000Z";
  rebindReceipt(receipt);
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  await assert.rejects(verifyReceipts(fixture, receipts), /receipt is stale/);
});

test("semantic verification rejects producer-authored cleanup success after every digest is rebound", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  await mutateRawObservation(receipts, "npm-linux-x64-node22.17.1", "uninstall", (observation) => {
    observation.managedPathsAfter = 1;
  });
  await assert.rejects(verifyReceipts(fixture, receipts), /Uninstall cleanup left managed product paths/);
});

test("issuer substitution fails even when the attacker recomputes content-addresses", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  const file = path.join(receipts, "npm-linux-x64-node22.17.1.json");
  const receipt = JSON.parse(await readFile(file, "utf8"));
  receipt.attestation.statement.issuer.repository = "attacker/runa-cli";
  receipt.attestation.statement.issuer.workflowRef = "attacker/runa-cli/.github/workflows/release.yml@refs/heads/main";
  rebindReceipt(receipt);
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  await assert.rejects(verifyReceipts(fixture, receipts), /issuer repository substitution detected/);
});

test("fabricated signing-evidence hashes cannot pass content-address verification", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  const file = path.join(receipts, "npm-linux-x64-node22.17.1.json");
  const receipt = JSON.parse(await readFile(file, "utf8"));
  receipt.attestation.signingEvidence.sha256 = "f".repeat(64);
  receipt.attestationSha256 = canonicalSha256(receipt.attestation);
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  await assert.rejects(verifyReceipts(fixture, receipts), /signing-evidence digest mismatch/);
});

test("self-asserted OIDC verification cannot authorize a pre-publication receipt", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  const id = "npm-linux-x64-node22.17.1";
  const receiptFile = path.join(receipts, `${id}.json`);
  const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
  const signingFile = path.join(receipts, ...receipt.attestation.signingEvidence.file.split("/"));
  const signingEvidence = JSON.parse(await readFile(signingFile, "utf8"));
  signingEvidence.verificationState = "VERIFIED";
  signingEvidence.bundleSha256 = "a".repeat(64);
  signingEvidence.certificateIssuer = "https://token.actions.githubusercontent.com";
  signingEvidence.certificateIdentity = receipt.attestation.statement.issuer.workflowRef;
  signingEvidence.verifiedAt = new Date().toISOString();
  await writeFile(signingFile, `${JSON.stringify(signingEvidence, null, 2)}\n`);
  receipt.attestation.signingEvidence.sha256 = await sha256File(signingFile);
  receipt.attestationSha256 = canonicalSha256(receipt.attestation);
  await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  await assert.rejects(verifyReceipts(fixture, receipts), /Cryptographic\/OIDC claims are not accepted without an independent offline verifier/);
});

test("a receipt can never self-promote to release eligible", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  const file = path.join(receipts, "npm-linux-x64-node22.17.1.json");
  const receipt = JSON.parse(await readFile(file, "utf8"));
  receipt.releaseEligible = true;
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  await assert.rejects(verifyReceipts(fixture, receipts), /may not claim release eligibility/);
});

test("receipt paths use the same canonical grammar as the published schema", () => {
  assert.equal(normalizeReceiptEvidenceFile("raw/npm-linux-x64-node22.17.1/version.json", "fixture"), "raw/npm-linux-x64-node22.17.1/version.json");
  for (const rejected of [
    "raw/npm/version evidence.json",
    "raw\\npm\\version.json",
    "raw/../version.json",
    "/raw/npm/version.json",
    "raw/npm/version.txt",
  ]) {
    assert.throws(() => normalizeReceiptEvidenceFile(rejected, "fixture"), /canonical|path schema|relative/);
  }
});

test("every channel-platform pair requires its channel-bound Node receipt cells", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  await rm(path.join(receipts, "npm-linux-x64-node24.4.1.json"));
  await assert.rejects(verifyReceipts(fixture, receipts), /Distribution receipt set differs from policy/);
});

test("a textual policy-approved prefix cannot invent a real-host authority", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  const file = path.join(receipts, "npm-linux-x64-node22.17.1.json");
  const receipt = JSON.parse(await readFile(file, "utf8"));
  receipt.attestation.statement.hostPolicy.kind = "policy-approved-real-host";
  receipt.attestation.statement.hostPolicy.runnerImage = "policy-approved:attacker-controlled-host";
  await rebindReceiptAndSigningEvidence(receipts, receipt);
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  await assert.rejects(verifyReceipts(fixture, receipts), /not an exact member of the approved support-policy host set/);
});

test("runtime protocol claims must equal the support-policy protocol range", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  const file = path.join(receipts, "npm-linux-x64-node22.17.1.json");
  const receipt = JSON.parse(await readFile(file, "utf8"));
  receipt.attestation.statement.runtimeIdentity.protocolRange = { minimum: "999", maximum: "999" };
  rebindReceipt(receipt);
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  await assert.rejects(verifyReceipts(fixture, receipts), /protocol range differs from the bound support policy/);
});

test("receipts from different workflow runs cannot be mixed into one cohort", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  const file = path.join(receipts, "npm-linux-x64-node22.17.1.json");
  const receipt = JSON.parse(await readFile(file, "utf8"));
  receipt.attestation.statement.issuer.runId = "123456789";
  receipt.attestation.statement.issuer.runAttempt = 2;
  await rebindReceiptAndSigningEvidence(receipts, receipt);
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  await assert.rejects(verifyReceipts(fixture, receipts), /one immutable workflow-run cohort/);
});

test("manual receipt validation rejects a path forbidden by the published schema", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  const file = path.join(receipts, "npm-linux-x64-node22.17.1.json");
  const receipt = JSON.parse(await readFile(file, "utf8"));
  receipt.attestation.statement.observations.version.file = "raw/npm-linux-x64-node22.17.1/version evidence.json";
  rebindReceipt(receipt);
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  await assert.rejects(verifyReceipts(fixture, receipts), /violates the distribution-receipt path schema/);
});

test("evidence directories cannot be junctions or symlinks outside the receipt root", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  const id = "npm-linux-x64-node22.17.1";
  const inside = path.join(receipts, "raw", id);
  const outside = path.join(fixture.root, "outside-receipt-evidence");
  await cp(inside, outside, { recursive: true });
  await rm(inside, { recursive: true });
  await symlink(outside, inside, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(verifyReceipts(fixture, receipts), /contains a symbolic link or junction/);
});

test("case-insensitive aliases cannot reuse one evidence file for two claims", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  const file = path.join(receipts, "npm-linux-x64-node22.17.1.json");
  const receipt = JSON.parse(await readFile(file, "utf8"));
  const versionReference = receipt.attestation.statement.observations.version;
  receipt.attestation.statement.observations.provenance.file = versionReference.file.replace("raw/", "RAW/");
  receipt.attestation.statement.observations.provenance.sha256 = versionReference.sha256;
  rebindReceipt(receipt);
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  await assert.rejects(verifyReceipts(fixture, receipts), /reused case-insensitively/);
});

test("execution claims must bind package manager, candidate invocation, environment, and public shim", async () => {
  const mutations = [
    [(execution) => { delete execution.packageManager.version; }, /receipt package manager keys differ/],
    [(execution) => { execution.candidateInvocation = "npm install -g attacker"; }, /candidate invocation differs/],
    [(execution) => { execution.environmentPolicy.environmentId = "npm-linux-x64-node24.4.1"; }, /environment identity differs/],
    [(execution) => { execution.publicShimResolution.internalModuleBypass = true; }, /internal-module bypass/],
    [(execution) => { execution.publicShimResolution.resolvedPath = "/tmp/runa/dist/bin/runa.js"; }, /did not resolve the public runa shim/],
  ];
  for (const [mutate, expected] of mutations) {
    const fixture = await createFixture();
    await project(fixture);
    const receipts = await createReceiptSet(fixture);
    const file = path.join(receipts, "npm-linux-x64-node22.17.1.json");
    const receipt = JSON.parse(await readFile(file, "utf8"));
    mutate(receipt.attestation.statement.execution);
    rebindReceipt(receipt);
    await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
    await assert.rejects(verifyReceipts(fixture, receipts), expected);
  }
});

test("every typed observation binds the complete execution-context digest", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  await mutateRawObservation(receipts, "npm-linux-x64-node22.17.1", "install", (observation) => {
    observation.executionContextSha256 = "f".repeat(64);
  });
  await assert.rejects(verifyReceipts(fixture, receipts), /does not bind the attested execution context/);
});

test("receipt verification rejects evidence beyond the bounded future skew", async () => {
  const fixture = await createFixture();
  await project(fixture);
  const receipts = await createReceiptSet(fixture);
  const file = path.join(receipts, "npm-linux-x64-node22.17.1.json");
  const receipt = JSON.parse(await readFile(file, "utf8"));
  receipt.attestation.statement.observedAt = new Date(Date.now() + 6 * 60 * 1000).toISOString();
  rebindReceipt(receipt);
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  await assert.rejects(verifyReceipts(fixture, receipts), /implausibly future-dated/);
});

test("TC-053-04/08/12 actual local artifact uses its public shim, cleans up, and cannot authorize release", async () => {
  const root = await resources.createTempDirectory("runa-local-evidence-test-");
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
