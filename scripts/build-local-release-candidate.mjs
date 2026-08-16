import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { invariant, parseArgs, sha256File } from "./lib/release-evidence.mjs";

const execute = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const output = path.resolve(root, args.get("output") ?? "local-release-candidate");
const staging = await mkdtemp(path.join(tmpdir(), "cuna-local-candidate-"));

try {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  await assertCleanSource(root);
  const sourceCommit = (await run("git", ["rev-parse", "HEAD"], root, 10_000)).stdout.trim();
  const npmVersion = (await runNpm(["--version"], root, 10_000)).stdout.trim();
  const runner = `local-${process.platform}-${process.arch}`;

  await run(process.execPath, ["scripts/run-build-operation.mjs", "build"], root, 180_000);
  const packed = JSON.parse((await runNpm([
    "pack", root, "--ignore-scripts", "--json", "--pack-destination", staging,
  ], root, 180_000)).stdout);
  invariant(Array.isArray(packed) && packed.length === 1, "npm pack did not produce exactly one CLI tarball");
  invariant(packed[0].name === packageJson.name && packed[0].version === packageJson.version, "Packed CLI identity differs from package.json");
  const tarball = path.join(staging, path.basename(packed[0].filename));
  await stat(tarball);
  await run(process.execPath, ["scripts/verify-package-contents.mjs", "--tarball", tarball], root, 30_000);

  const sbom = path.join(staging, "sbom.cdx.json");
  const sbomResult = await runNpm(["sbom", "--sbom-format", "cyclonedx", "--omit=dev"], root, 120_000);
  JSON.parse(sbomResult.stdout);
  await writeFile(sbom, sbomResult.stdout, { flag: "wx" });

  const releaseInputs = path.join(staging, "release-inputs.json");
  await run(process.execPath, [
    "scripts/build-release-inputs.mjs", "--root", root, "--output", releaseInputs,
    "--source-commit", sourceCommit, "--npm-version", npmVersion, "--runner", runner,
  ], root, 120_000);

  await run(process.execPath, [
    "scripts/build-release-envelope.mjs", "--root", root, "--tarball", tarball,
    "--sbom", sbom, "--release-inputs", releaseInputs, "--output", output,
    "--version", packageJson.version, "--source-commit", sourceCommit,
    "--run-id", "1", "--run-attempt", "1", "--npm-version", npmVersion, "--runner", runner,
  ], root, 120_000);
  await run(process.execPath, ["scripts/verify-release-envelope.mjs", "--root", output], root, 30_000);

  const envelopeFile = path.join(output, "release-envelope.json");
  const envelope = JSON.parse(await readFile(envelopeFile, "utf8"));
  invariant(envelope.authority.releaseEligible === false, "A local candidate cannot become release eligible");
  process.stdout.write(`${JSON.stringify({
    status: "LOCAL_BUILD_ONCE_CANDIDATE",
    releaseEligible: false,
    envelope: envelopeFile,
    envelopeSha256: await sha256File(envelopeFile),
    tarballSha256: envelope.tarball.sha256,
    payloadSha256: envelope.identities.payloadSha256,
  })}\n`);
} finally {
  await rm(staging, { recursive: true, force: true });
}

async function assertCleanSource(root) {
  const status = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], root, 10_000);
  invariant(
    status.stdout.trim() === "",
    "Refusing to build a local release candidate from a dirty source tree. Commit or stash the source changes, then build the exact candidate again.",
  );
}

async function runNpm(npmArgs, cwd, timeout) {
  if (process.platform !== "win32") return run("npm", npmArgs, cwd, timeout);
  const where = await run("where.exe", ["npm.cmd"], cwd, 10_000);
  const npmCommand = where.stdout.split(/\r?\n/u).map((value) => value.trim()).find(Boolean);
  invariant(npmCommand, "npm.cmd could not be resolved from PATH");
  const npmCli = path.join(path.dirname(npmCommand), "node_modules", "npm", "bin", "npm-cli.js");
  return run(process.execPath, [npmCli, ...npmArgs], cwd, timeout);
}

function run(command, commandArgs, cwd, timeout) {
  return execute(command, commandArgs, { cwd, windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024 });
}
