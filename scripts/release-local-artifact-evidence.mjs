import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { PACKAGE_NAME, REPOSITORY, invariant, parseArgs, readJson, sha256File } from "./lib/release-evidence.mjs";
import { assertInstalledProductAbsent, invokeInstalledCuna, runNpm } from "./lib/installed-candidate-probe.mjs";
import { validateCycloneDxSbom, validateSupportPolicy } from "./release-distribution-lib.mjs";
import { ARTIFACT_CHANNEL } from "../dist/build-identity.js";

const execute = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const repositoryRoot = path.resolve(args.get("root") ?? process.cwd());
const outputRoot = path.resolve(repositoryRoot, args.get("output") ?? "evidence/local-distribution");
const packageJson = await readJson(path.join(repositoryRoot, "package.json"));
invariant(packageJson.name === PACKAGE_NAME, "Unexpected package identity");

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "cuna-local-artifact-"));
try {
  const sourceCommit = (await execute("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, windowsHide: true, timeout: 10_000 })).stdout.trim();
  invariant(/^[0-9a-f]{40}$/.test(sourceCommit), "Local source commit is not immutable");
  const sourceStatus = (await execute("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: repositoryRoot,
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  })).stdout;
  const npmVersion = (await runNpm(["--version"], { windowsHide: true, timeout: 10_000 })).stdout.trim();

  const pack = await runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot], {
    cwd: repositoryRoot,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const packResult = JSON.parse(pack.stdout);
  invariant(Array.isArray(packResult) && packResult.length === 1, "npm pack did not produce exactly one artifact");
  const tarballSource = path.join(temporaryRoot, packResult[0].filename);
  const packageContentsResult = await execute(process.execPath, [
    path.join(repositoryRoot, "scripts", "verify-package-contents.mjs"),
    "--tarball", tarballSource,
  ], {
    cwd: repositoryRoot,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });

  const sbomResult = await runNpm(["sbom", "--sbom-format", "cyclonedx", "--omit=dev"], {
    cwd: repositoryRoot,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const sbomSource = path.join(temporaryRoot, "sbom.cdx.json");
  await writeFile(sbomSource, `${JSON.stringify(JSON.parse(sbomResult.stdout), null, 2)}\n`, { flag: "wx" });

  const syntheticEnvelopeView = { version: packageJson.version };
  await validateCycloneDxSbom(sbomSource, syntheticEnvelopeView);
  const supportSource = path.join(repositoryRoot, "packaging", "support-policy.json");
  validateSupportPolicy(await readJson(supportSource));

  const installPrefix = path.join(temporaryRoot, "installed prefix (x86) á");
  await mkdir(installPrefix, { recursive: false });
  const emptyCache = path.join(temporaryRoot, "empty-cache");
  await mkdir(emptyCache, { recursive: false });
  await runNpm(["install", "--global", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--cache", emptyCache, "--prefix", installPrefix, tarballSource], {
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const selfTestResult = await invokeInstalledCuna(installPrefix, ["self-test", "--offline", "--json"], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const versionResult = await invokeInstalledCuna(installPrefix, ["version", "--json"], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const selfTest = JSON.parse(selfTestResult.stdout);
  const version = JSON.parse(versionResult.stdout);
  invariant(selfTest?.data?.ok === true, "Local installed-artifact self-test failed");
  invariant(version?.data?.version === packageJson.version, "Local installed version differs from package.json");
  invariant(/^[0-9a-f]{64}$/.test(version?.data?.buildDigest), "Local installed build digest is invalid");
  invariant(version?.data?.platform === process.platform && version?.data?.architecture === process.arch, "Local runtime platform identity differs");
  // Bound to the declared constant, not to a literal. This script installs a
  // LOCAL tarball and then checks that the installed CLI reports the channel
  // the build actually declares — which is the whole point of the check, and
  // the reason a hardcoded "npm" went stale the moment the build began
  // declaring "local". The installation path is a local tarball; npm
  // publication is a separate, parked lane with its own verifiers.
  invariant(
    version?.data?.artifactChannel === ARTIFACT_CHANNEL,
    `Installed artifact channel ${String(version?.data?.artifactChannel)} does not match the declared ${ARTIFACT_CHANNEL}`,
  );

  const cleanupCache = path.join(temporaryRoot, "cleanup-cache");
  await mkdir(cleanupCache, { recursive: false });
  await runNpm(["uninstall", "--global", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--cache", cleanupCache, "--prefix", installPrefix, packageJson.name], {
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  await assertInstalledProductAbsent(installPrefix);

  await mkdir(outputRoot, { recursive: true });
  const tarballFile = path.basename(tarballSource);
  await copyFile(tarballSource, path.join(outputRoot, tarballFile));
  await copyFile(sbomSource, path.join(outputRoot, "sbom.cdx.json"));
  await copyFile(supportSource, path.join(outputRoot, "support-policy.json"));
  await writeFile(path.join(outputRoot, "self-test.json"), `${JSON.stringify(selfTest, null, 2)}\n`, { flag: "wx" });
  await writeFile(path.join(outputRoot, "version.json"), `${JSON.stringify(version, null, 2)}\n`, { flag: "wx" });
  await writeFile(path.join(outputRoot, "package-contents.json"), `${JSON.stringify(JSON.parse(packageContentsResult.stdout), null, 2)}\n`, { flag: "wx" });

  const evidence = {
    schemaVersion: 2,
    authority: "LOCAL_NON_RELEASE_EVIDENCE",
    releaseEligible: false,
    limitations: [
      "NO_TRUSTED_PUBLISHER_OR_REGISTRY_PROVENANCE",
      "NO_EXTERNAL_CHANNEL_INSTALL_RECEIPTS",
      "NO_CROSS_PLATFORM_RECEIPTS",
      "NO_ROLLBACK_OR_FIXED_FORWARD_REHEARSAL",
      "NO_COHORT_OBSERVATION_OR_RELEASE_APPROVAL_LEASE",
    ],
    repository: REPOSITORY,
    sourceCommit,
    sourceTreeStatus: sourceStatus.length === 0 ? "CLEAN" : "DIRTY",
    sourceStatusSha256: await digestText(sourceStatus),
    package: { name: packageJson.name, version: packageJson.version },
    artifact: {
      file: tarballFile,
      sha256: await sha256File(path.join(outputRoot, tarballFile)),
      size: (await stat(path.join(outputRoot, tarballFile))).size,
    },
    sbom: { file: "sbom.cdx.json", sha256: await sha256File(path.join(outputRoot, "sbom.cdx.json")) },
    supportPolicy: { file: "support-policy.json", sha256: await sha256File(path.join(outputRoot, "support-policy.json")) },
    runtimeIdentity: version.data,
    observations: {
      packageContents: { file: "package-contents.json", sha256: await sha256File(path.join(outputRoot, "package-contents.json")) },
      selfTest: { file: "self-test.json", sha256: await sha256File(path.join(outputRoot, "self-test.json")) },
      version: { file: "version.json", sha256: await sha256File(path.join(outputRoot, "version.json")) },
      uninstallCleanup: "PASS",
    },
    environment: { platform: process.platform, architecture: process.arch, node: process.version, npm: npmVersion },
    generatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(outputRoot, "local-artifact-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({
    status: "LOCAL_CANDIDATE_VERIFIED_NOT_RELEASE_ELIGIBLE",
    artifactSha256: evidence.artifact.sha256,
    buildDigest: evidence.runtimeIdentity.buildDigest,
    sourceTreeStatus: evidence.sourceTreeStatus,
    limitations: evidence.limitations,
  })}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function digestText(value) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}
