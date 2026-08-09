import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PACKAGE_NAME,
  REGISTRY,
  REPOSITORY,
  invariant,
  parseArgs,
  readJson,
  sha256File,
  validateEnvelope,
} from "./lib/release-evidence.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const tarballInput = path.resolve(root, args.get("tarball") ?? "");
const sbomInput = path.resolve(root, args.get("sbom") ?? "");
const supportInput = path.resolve(root, args.get("support-policy") ?? "packaging/support-policy.json");
const outputRoot = path.resolve(root, args.get("output") ?? "release-artifacts");
const packageJson = await readJson(path.join(root, "package.json"));

invariant(packageJson.name === PACKAGE_NAME, `package.json name must be ${PACKAGE_NAME}`);
invariant(typeof packageJson.version === "string", "package.json version is missing");
invariant(args.get("version") === packageJson.version, "Requested version differs from package.json");
invariant(args.get("source-commit") === (process.env.GITHUB_SHA ?? args.get("source-commit")), "Source commit differs from GITHUB_SHA");
invariant(process.env.GITHUB_REPOSITORY === undefined || process.env.GITHUB_REPOSITORY === REPOSITORY, "Workflow repository is not release authority");

await mkdir(outputRoot, { recursive: true });
const tarballFile = path.basename(tarballInput);
const sbomFile = "sbom.cdx.json";
const supportFile = "support-policy.json";
await copyFile(tarballInput, path.join(outputRoot, tarballFile));
await copyFile(sbomInput, path.join(outputRoot, sbomFile));
await copyFile(supportInput, path.join(outputRoot, supportFile));

const envelope = {
  schemaVersion: 1,
  packageName: PACKAGE_NAME,
  version: packageJson.version,
  sourceCommit: args.get("source-commit"),
  repository: REPOSITORY,
  registry: REGISTRY,
  tarball: {
    file: tarballFile,
    url: `${REGISTRY}/${PACKAGE_NAME}/-/cli-${packageJson.version}.tgz`,
    sha256: await sha256File(path.join(outputRoot, tarballFile)),
    size: (await stat(path.join(outputRoot, tarballFile))).size,
  },
  sbom: { file: sbomFile, sha256: await sha256File(path.join(outputRoot, sbomFile)) },
  supportPolicy: { file: supportFile, sha256: await sha256File(path.join(outputRoot, supportFile)) },
  builder: {
    workflow: ".github/workflows/ci.yml",
    runId: args.get("run-id"),
    runAttempt: args.get("run-attempt"),
  },
};

validateEnvelope(envelope);
await writeFile(path.join(outputRoot, "release-envelope.json"), `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify({ status: "candidate-bound", version: envelope.version, sha256: envelope.tarball.sha256 })}\n`);
