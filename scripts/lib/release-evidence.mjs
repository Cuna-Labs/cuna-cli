import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const PACKAGE_NAME = "@cuna_labs/cli";
export const REPOSITORY = "Cuna-Labs/cuna-cli";
export const REGISTRY = "https://registry.npmjs.org";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;

export function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function parseArgs(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    invariant(token.startsWith("--"), `Unexpected positional argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    invariant(value !== undefined && !value.startsWith("--"), `Missing value for --${key}`);
    invariant(!result.has(key), `Duplicate argument: --${key}`);
    result.set(key, value);
    index += 1;
  }
  return result;
}

export async function sha256File(file) {
  const bytes = await readFile(file);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function exactKeys(value, expected, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(JSON.stringify(actual) === JSON.stringify(wanted), `${label} keys differ: ${actual.join(", ")}`);
}

function safeRelativeFile(value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} must be a non-empty string`);
  invariant(!path.isAbsolute(value), `${label} must be relative`);
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  invariant(normalized !== ".." && !normalized.startsWith("../"), `${label} escapes the evidence root`);
  return normalized;
}

export function validateEnvelope(envelope) {
  exactKeys(
    envelope,
    ["schemaVersion", "packageName", "version", "sourceCommit", "repository", "registry", "tarball", "sbom", "supportPolicy", "releaseInputs", "identities", "authority", "builder"],
    "release envelope",
  );
  invariant(envelope.schemaVersion === 2, "Unsupported release-envelope schema");
  invariant(envelope.packageName === PACKAGE_NAME, "Unexpected package name");
  invariant(SEMVER.test(envelope.version), "Version must be exact SemVer without build metadata");
  invariant(COMMIT.test(envelope.sourceCommit), "sourceCommit must be a lowercase 40-character SHA");
  invariant(envelope.repository === REPOSITORY, "Unexpected repository identity");
  invariant(envelope.registry === REGISTRY, "Unexpected registry identity");

  exactKeys(envelope.tarball, ["file", "url", "sha256", "size"], "tarball");
  invariant(/^[A-Za-z0-9._-]+\.tgz$/.test(envelope.tarball.file), "Tarball file must be a basename ending in .tgz");
  const expectedUrl = `${REGISTRY}/${PACKAGE_NAME}/-/cli-${envelope.version}.tgz`;
  invariant(envelope.tarball.url === expectedUrl, "Tarball URL is not the canonical exact-version npm URL");
  invariant(SHA256.test(envelope.tarball.sha256), "Tarball SHA-256 is invalid");
  invariant(Number.isSafeInteger(envelope.tarball.size) && envelope.tarball.size > 0, "Tarball size is invalid");

  for (const [label, value] of [["sbom", envelope.sbom], ["supportPolicy", envelope.supportPolicy], ["releaseInputs", envelope.releaseInputs]]) {
    exactKeys(value, ["file", "sha256"], label);
    safeRelativeFile(value.file, `${label}.file`);
    invariant(SHA256.test(value.sha256), `${label}.sha256 is invalid`);
  }

  exactKeys(
    envelope.identities,
    ["lockfileSha256", "dependencyClosureSha256", "contractSha256", "buildRecipeSha256", "toolchainSha256", "payloadSha256", "payloadFileCount"],
    "identities",
  );
  for (const field of ["lockfileSha256", "dependencyClosureSha256", "contractSha256", "buildRecipeSha256", "toolchainSha256", "payloadSha256"]) {
    invariant(SHA256.test(envelope.identities[field]), `identities.${field} is invalid`);
  }
  invariant(Number.isSafeInteger(envelope.identities.payloadFileCount) && envelope.identities.payloadFileCount > 0, "identities.payloadFileCount is invalid");

  exactKeys(envelope.authority, ["phase", "releaseEligible", "approval", "provenance"], "authority");
  invariant(envelope.authority.phase === "CANDIDATE_BUILT", "Candidate authority phase is invalid");
  invariant(envelope.authority.releaseEligible === false, "A candidate envelope may not claim release authority");
  exactKeys(envelope.authority.approval, ["state", "environment", "receiptSha256"], "authority.approval");
  invariant(envelope.authority.approval.state === "REQUIRED_NOT_PRESENT", "Candidate envelope contains fabricated approval state");
  invariant(envelope.authority.approval.environment === "npm", "Candidate approval environment is invalid");
  invariant(envelope.authority.approval.receiptSha256 === null, "Candidate envelope contains a fabricated approval receipt");
  exactKeys(envelope.authority.provenance, ["state", "workflow", "receiptSha256"], "authority.provenance");
  invariant(envelope.authority.provenance.state === "REQUIRED_NOT_PRESENT", "Candidate envelope contains fabricated provenance state");
  invariant(envelope.authority.provenance.workflow === ".github/workflows/ci.yml", "Candidate provenance workflow is invalid");
  invariant(envelope.authority.provenance.receiptSha256 === null, "Candidate envelope contains a fabricated provenance receipt");

  exactKeys(envelope.builder, ["workflow", "runId", "runAttempt"], "builder");
  invariant(envelope.builder.workflow === ".github/workflows/ci.yml", "Unexpected builder workflow");
  invariant(/^[1-9][0-9]*$/.test(envelope.builder.runId), "builder.runId is invalid");
  invariant(/^[1-9][0-9]*$/.test(envelope.builder.runAttempt), "builder.runAttempt is invalid");
}

export async function verifyEnvelopeFiles(envelope, root) {
  validateEnvelope(envelope);
  const tarball = path.resolve(root, envelope.tarball.file);
  const sbom = path.resolve(root, safeRelativeFile(envelope.sbom.file, "sbom.file"));
  const supportPolicy = path.resolve(root, safeRelativeFile(envelope.supportPolicy.file, "supportPolicy.file"));
  const releaseInputs = path.resolve(root, safeRelativeFile(envelope.releaseInputs.file, "releaseInputs.file"));
  invariant((await sha256File(tarball)) === envelope.tarball.sha256, "Tarball digest mismatch");
  invariant((await sha256File(sbom)) === envelope.sbom.sha256, "SBOM digest mismatch");
  invariant((await sha256File(supportPolicy)) === envelope.supportPolicy.sha256, "Support-policy digest mismatch");
  invariant((await sha256File(releaseInputs)) === envelope.releaseInputs.sha256, "Release-inputs digest mismatch");
  const { releaseInputIdentities, verifyReleaseInputsFile } = await import("./release-inputs.mjs");
  const inputs = await verifyReleaseInputsFile(releaseInputs, {
    packageName: envelope.packageName,
    version: envelope.version,
    sourceCommit: envelope.sourceCommit,
    payloadBuildDigest: envelope.identities.payloadSha256,
  });
  invariant(JSON.stringify(releaseInputIdentities(inputs)) === JSON.stringify(envelope.identities), "Release-input identities differ from envelope");
  return inputs;
}
