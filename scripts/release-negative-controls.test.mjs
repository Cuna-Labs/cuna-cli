import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { sha256File, validateEnvelope } from "./lib/release-evidence.mjs";
import { syntheticReleaseInputs } from "./lib/release-test-fixture.mjs";
import { releaseInputIdentities } from "./lib/release-inputs.mjs";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)));

const valid = {
  schemaVersion: 2,
  packageName: "@runa_laboratories/cli",
  version: "1.2.3-preview.1",
  sourceCommit: "b".repeat(40),
  repository: "Runa-Laboratories/runa-cli",
  registry: "https://registry.npmjs.org",
  tarball: {
    file: "runa.tgz",
    url: "https://registry.npmjs.org/@runa_laboratories/cli/-/cli-1.2.3-preview.1.tgz",
    sha256: "a".repeat(64),
    size: 1,
  },
  sbom: { file: "sbom.json", sha256: "b".repeat(64) },
  supportPolicy: { file: "support.json", sha256: "c".repeat(64) },
  releaseInputs: { file: "release-inputs.json", sha256: "d".repeat(64) },
  identities: {
    lockfileSha256: "e".repeat(64),
    dependencyClosureSha256: "f".repeat(64),
    contractSha256: "a".repeat(64),
    buildRecipeSha256: "b".repeat(64),
    toolchainSha256: "c".repeat(64),
    payloadSha256: "d".repeat(64),
    payloadFileCount: 1,
  },
  authority: {
    phase: "CANDIDATE_BUILT",
    releaseEligible: false,
    approval: { state: "REQUIRED_NOT_PRESENT", environment: "npm", receiptSha256: null },
    provenance: { state: "REQUIRED_NOT_PRESENT", workflow: ".github/workflows/ci.yml", receiptSha256: null },
  },
  builder: { workflow: ".github/workflows/ci.yml", runId: "123", runAttempt: "1" },
};

test("release envelope rejects a mutable source URL", () => {
  const candidate = structuredClone(valid);
  candidate.tarball.url = "https://github.com/Runa-Laboratories/runa-cli/archive/refs/heads/main.tar.gz";
  assert.throws(() => validateEnvelope(candidate), /canonical exact-version npm URL/);
});

test("release envelope rejects an unknown field", () => {
  const candidate = { ...structuredClone(valid), approved: true };
  assert.throws(() => validateEnvelope(candidate), /keys differ/);
});

test("release envelope rejects fabricated approval and provenance", () => {
  const approved = structuredClone(valid);
  approved.authority.approval = { state: "VERIFIED", environment: "npm", receiptSha256: "f".repeat(64) };
  assert.throws(() => validateEnvelope(approved), /fabricated approval state/);

  const proven = structuredClone(valid);
  proven.authority.provenance = { state: "VERIFIED", workflow: ".github/workflows/ci.yml", receiptSha256: "f".repeat(64) };
  assert.throws(() => validateEnvelope(proven), /fabricated provenance state/);
});

test("release envelope v1 is never admissible", () => {
  const legacy = structuredClone(valid);
  legacy.schemaVersion = 1;
  assert.throws(() => validateEnvelope(legacy), /Unsupported release-envelope schema/);
});

test("digest changes when projection bytes are substituted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runa-digest-test-"));
  const file = path.join(root, "projection");
  await writeFile(file, "approved");
  const before = await sha256File(file);
  await writeFile(file, "substituted");
  const after = await sha256File(file);
  assert.notEqual(before, after);
});

test("curl template verifies before installing and suppresses lifecycle scripts", async () => {
  const template = await readFile(new URL("../packaging/templates/install.sh.template", import.meta.url), "utf8");
  assert.ok(template.indexOf("sha256sum") < template.indexOf("npm install"));
  assert.match(template, /--ignore-scripts/);
  assert.doesNotMatch(template, /eval\s/);
});

test("all projections bind the envelope and reject later byte substitution", async () => {
  const evidence = await mkdtemp(path.join(tmpdir(), "runa-projection-evidence-"));
  const legacyOutput = await mkdtemp(path.join(tmpdir(), "runa-projection-legacy-"));
  const authoritativeOutput = await mkdtemp(path.join(tmpdir(), "runa-projection-authoritative-"));
  await writeFile(path.join(evidence, "runa.tgz"), "candidate");
  await writeFile(path.join(evidence, "sbom.json"), `${JSON.stringify({
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: { component: { type: "application", name: "@runa_laboratories/cli", version: valid.version } },
  })}\n`);
  await writeFile(path.join(evidence, "support.json"), await readFile(path.join(repositoryRoot, "packaging", "support-policy.json")));
  const envelope = structuredClone(valid);
  const releaseInputs = syntheticReleaseInputs({ version: valid.version, sourceCommit: valid.sourceCommit });
  await writeFile(path.join(evidence, "release-inputs.json"), `${JSON.stringify(releaseInputs)}\n`);
  envelope.tarball.sha256 = await sha256File(path.join(evidence, "runa.tgz"));
  envelope.tarball.size = 9;
  envelope.sbom.sha256 = await sha256File(path.join(evidence, "sbom.json"));
  envelope.supportPolicy.sha256 = await sha256File(path.join(evidence, "support.json"));
  envelope.releaseInputs.sha256 = await sha256File(path.join(evidence, "release-inputs.json"));
  envelope.identities = releaseInputIdentities(releaseInputs);
  await writeFile(path.join(evidence, "release-envelope.json"), `${JSON.stringify(envelope)}\n`);

  await execute(process.execPath, [
    "scripts/project-distributions.mjs",
    "--root", repositoryRoot,
    "--evidence", evidence,
    "--output", legacyOutput,
  ], { cwd: repositoryRoot });
  await execute(process.execPath, [
    "scripts/verify-distribution-projections.mjs",
    "--root", repositoryRoot,
    "--evidence", evidence,
    "--projections", legacyOutput,
  ], { cwd: repositoryRoot });
  await execute(process.execPath, [
    "scripts/release-project-distributions.mjs",
    "--root", repositoryRoot,
    "--evidence", evidence,
    "--output", authoritativeOutput,
  ], { cwd: repositoryRoot });
  await execute(process.execPath, [
    "scripts/verify-release-distributions.mjs",
    "--root", repositoryRoot,
    "--evidence", evidence,
    "--distributions", authoritativeOutput,
  ], { cwd: repositoryRoot });

  for (const relative of [
    "distribution-manifest.json",
    "npm/install-command.txt",
    "bun/install-command.txt",
    "curl/install.sh",
    "homebrew/runa.rb",
    "aur/PKGBUILD",
  ]) {
    assert.equal(
      await sha256File(path.join(legacyOutput, relative)),
      await sha256File(path.join(authoritativeOutput, relative)),
      `legacy compatibility entry point diverged for ${relative}`,
    );
  }

  await chmod(path.join(legacyOutput, "curl", "install.sh"), 0o644);
  await writeFile(path.join(legacyOutput, "curl", "install.sh"), "substituted\n");
  await assert.rejects(
    execute(process.execPath, [
      "scripts/verify-distribution-projections.mjs",
      "--root", repositoryRoot,
      "--evidence", evidence,
      "--projections", legacyOutput,
    ], { cwd: repositoryRoot }),
  );
});
