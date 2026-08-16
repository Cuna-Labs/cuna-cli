import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { PACKAGE_NAME, invariant, readJson, sha256File } from "./release-evidence.mjs";

const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const GIT_OBJECT_FORMATS = new Set(["sha1", "sha256"]);
const EXACT_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const EXACT_TOOL_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const INFRA_OPENAPI_FILE = "contracts/infra/cuna-api.openapi.json";
const INFRA_OPENAPI_DIGEST_FILE = "contracts/infra/cuna-api.openapi.sha256";
const INFRA_OPENAPI_IDENTITY_FILE = "contracts/infra/cuna-api.openapi.identity.json";

const CONTRACT_FILES = Object.freeze([
  INFRA_OPENAPI_FILE,
  INFRA_OPENAPI_DIGEST_FILE,
  INFRA_OPENAPI_IDENTITY_FILE,
  "packaging/contract-authority.schema.json",
  "packaging/distribution-manifest.schema.json",
  "packaging/distribution-receipt.schema.json",
  "packaging/observation-summary.schema.json",
  "packaging/release-approval-lease.schema.json",
  "packaging/release-envelope.schema.json",
  "packaging/runtime-identity.schema.json",
  "packaging/support-policy.schema.json",
  "src/api/contracts.ts",
  "src/cli/output.ts",
  "src/cli/run.ts",
  "src/commands/commands.ts",
  "src/config/infra-contract-witness.ts",
  "src/core/errors.ts",
  "src/pty/contracts.ts",
  "src/runtime/contracts.ts",
  "src/terminal/codec.ts",
  "src/version.ts",
]);

const BUILD_RECIPE_FILES = Object.freeze([
  ".github/workflows/ci.yml",
  ".github/workflows/distribution-projection-proof.yml",
  ".github/workflows/release-review.yml",
  ".github/workflows/release.yml",
  "package.json",
  "package-lock.json",
  "packaging/admission-policy.json",
  "packaging/release-approval-consumption-authority.json",
  "packaging/release-review-authority.json",
  "packaging/support-policy.json",
  "packaging/templates/aur/PKGBUILD.template",
  "packaging/templates/homebrew/cuna.rb.template",
  "packaging/templates/install.sh.template",
  "scripts/build-release-envelope.mjs",
  "scripts/build-release-inputs.mjs",
  "scripts/emit-infra-contract-witness.mjs",
  "scripts/lib/release-evidence.mjs",
  "scripts/lib/infra-contract-witness.mjs",
  "scripts/lib/npm-preview-publication.mjs",
  "scripts/lib/release-approval-lease.mjs",
  "scripts/lib/release-approval-consumption.mjs",
  "scripts/lib/exclusive-build-lock.mjs",
  "scripts/lib/release-inputs.mjs",
  "scripts/release-distribution-lib.mjs",
  "scripts/release-project-distributions.mjs",
  "scripts/publish-npm-preview.mjs",
  "scripts/run-build-operation.mjs",
  "scripts/sync-infra-openapi.mjs",
  "scripts/summarize-observation-receipts.mjs",
  "scripts/consume-release-approval-nonce.mjs",
  "scripts/verify-ci-contract.mjs",
  "scripts/verify-dependency-policy.mjs",
  "scripts/verify-distribution-receipts.mjs",
  "scripts/verify-installed-candidate.mjs",
  "scripts/verify-package-contents.mjs",
  "scripts/verify-release-admission.mjs",
  "scripts/verify-release-approval-lease.mjs",
  "scripts/verify-release-approval-consumption-authority.mjs",
  "scripts/verify-release-approval-nonce.mjs",
  "scripts/verify-release-review-authority.mjs",
  "scripts/verify-release-distributions.mjs",
  "scripts/verify-release-envelope.mjs",
  "src/build-identity.ts",
  "tsconfig.json",
]);

function exactKeys(value, expected, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(JSON.stringify(actual) === JSON.stringify(wanted), `${label} keys differ: ${actual.join(", ")}`);
}

function isGitObjectId(value, objectFormat) {
  const length = objectFormat === "sha1" ? 40 : 64;
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value);
}

function validateCommittedOpenCodeWitness(identity) {
  const tree = identity.producer_full_tree;
  invariant(tree && typeof tree === "object" && !Array.isArray(tree), "Committed Infra tree witness is invalid");
  exactKeys(tree, ["object_format", "commit", "tree", "contract_blob"], "Committed Infra tree witness");
  invariant(GIT_OBJECT_FORMATS.has(tree.object_format), "Committed Infra tree object format is invalid");
  invariant(tree.commit === identity.producer_revision, "Committed Infra tree revision differs");
  invariant(isGitObjectId(tree.commit, tree.object_format), "Committed Infra tree commit is invalid");
  invariant(isGitObjectId(tree.tree, tree.object_format), "Committed Infra tree object is invalid");
  invariant(isGitObjectId(tree.contract_blob, tree.object_format), "Committed Infra contract blob is invalid");
  const featureContracts = identity.feature_contracts;
  invariant(featureContracts && typeof featureContracts === "object" && !Array.isArray(featureContracts), "Committed Infra feature witness is invalid");
  exactKeys(featureContracts, ["opencode_interactive_only"], "Committed Infra feature witness");
  const witness = featureContracts.opencode_interactive_only;
  invariant(witness && typeof witness === "object" && !Array.isArray(witness), "Committed OpenCode witness is missing");
  exactKeys(witness, ["openapi_raw_sha256", "openapi_canonical_sha256", "producer_commit", "producer_tree", "producer_contract_blob"], "Committed OpenCode witness");
  invariant(witness.openapi_raw_sha256 === identity.infra_openapi_raw_sha256, "Committed OpenCode raw digest differs");
  invariant(witness.openapi_canonical_sha256 === identity.infra_openapi_canonical_sha256, "Committed OpenCode canonical digest differs");
  invariant(witness.producer_commit === tree.commit, "Committed OpenCode revision differs");
  invariant(witness.producer_tree === tree.tree, "Committed OpenCode tree differs");
  invariant(witness.producer_contract_blob === tree.contract_blob, "Committed OpenCode contract blob differs");
}

function loadInfraOpenapiIdentity() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(new URL("../../contracts/infra/cuna-api.openapi.identity.json", import.meta.url), "utf8"));
  } catch (error) {
    throw new Error(`Vendored Infra OpenAPI identity is unreadable: ${error instanceof Error ? error.message : "unknown failure"}`);
  }
  invariant(parsed && typeof parsed === "object" && !Array.isArray(parsed), "Vendored Infra OpenAPI identity is invalid");
  if (parsed.schemaVersion === 1) {
    exactKeys(parsed, [
      "schemaVersion",
      "artifact_file",
      "canonical_digest_file",
      "infra_openapi_raw_sha256",
      "infra_openapi_canonical_sha256",
      "producer_repository",
      "producer_content_state",
      "producer_base_revision",
      "producer_contract_verifier",
      "producer_projection_sha256",
      "producer_runtime_manifest_sha256",
    ], "vendored legacy mutable Infra OpenAPI identity");
    invariant(parsed.producer_content_state === "working_tree_product_delta", "Legacy Infra identity cannot claim immutable producer state");
    invariant(COMMIT.test(parsed.producer_base_revision), "Vendored Infra producer revision is invalid");
  } else if (parsed.schemaVersion === 2) {
    const shared = [
      "schemaVersion",
      "artifact_file",
      "canonical_digest_file",
      "infra_openapi_raw_sha256",
      "infra_openapi_canonical_sha256",
      "producer_repository",
      "producer_content_state",
      "producer_full_tree",
      "producer_contract_verifier",
      "producer_projection_sha256",
      "producer_runtime_manifest_sha256",
      "feature_contracts",
    ];
    if (parsed.producer_content_state === "committed") {
      exactKeys(parsed, [...shared, "producer_revision"], "vendored committed Infra OpenAPI identity");
      invariant(COMMIT.test(parsed.producer_revision), "Vendored committed Infra revision is invalid");
      validateCommittedOpenCodeWitness(parsed);
    } else if (parsed.producer_content_state === "working_tree_product_delta") {
      exactKeys(parsed, [...shared, "producer_base_revision"], "vendored mutable Infra OpenAPI identity");
      invariant(COMMIT.test(parsed.producer_base_revision), "Vendored mutable Infra revision is invalid");
      invariant(parsed.producer_full_tree === null, "Mutable Infra identity must not claim a Git tree");
      exactKeys(parsed.feature_contracts, ["opencode_interactive_only"], "Mutable Infra feature witness");
      invariant(parsed.feature_contracts.opencode_interactive_only === null, "Mutable Infra identity must not enable OpenCode");
    } else {
      invariant(false, "Vendored Infra producer state differs");
    }
  } else {
    invariant(false, "Vendored Infra OpenAPI identity schema differs");
  }
  invariant(parsed.artifact_file === INFRA_OPENAPI_FILE, "Vendored Infra OpenAPI identity artifact differs");
  invariant(parsed.canonical_digest_file === INFRA_OPENAPI_DIGEST_FILE, "Vendored Infra OpenAPI identity digest artifact differs");
  invariant(SHA256.test(parsed.infra_openapi_raw_sha256), "Vendored Infra OpenAPI identity raw digest is invalid");
  invariant(SHA256.test(parsed.infra_openapi_canonical_sha256), "Vendored Infra OpenAPI identity canonical digest is invalid");
  invariant(parsed.producer_repository === "Cuna-Labs/infra", "Vendored Infra producer repository differs");
  invariant(parsed.producer_contract_verifier === "contracts/tools/verify-contract.mjs", "Vendored Infra verifier identity differs");
  invariant(SHA256.test(parsed.producer_projection_sha256), "Vendored Infra projection digest is invalid");
  invariant(SHA256.test(parsed.producer_runtime_manifest_sha256), "Vendored Infra runtime digest is invalid");
  return Object.freeze(parsed);
}

export const INFRA_OPENAPI_CONTRACT_IDENTITY = loadInfraOpenapiIdentity();
const INFRA_OPENAPI_RAW_SHA256 = INFRA_OPENAPI_CONTRACT_IDENTITY.infra_openapi_raw_sha256;
const INFRA_OPENAPI_CANONICAL_SHA256 = INFRA_OPENAPI_CONTRACT_IDENTITY.infra_openapi_canonical_sha256;

function validateDigestEntries(entries, expectedFiles, label) {
  invariant(Array.isArray(entries), `${label}.files must be an array`);
  invariant(entries.length === expectedFiles.length, `${label}.files length differs`);
  for (const [index, expectedFile] of expectedFiles.entries()) {
    const entry = entries[index];
    exactKeys(entry, ["file", "sha256"], `${label}.files[${index}]`);
    invariant(entry.file === expectedFile, `${label}.files order or identity differs at ${expectedFile}`);
    invariant(SHA256.test(entry.sha256), `${label}.files digest is invalid: ${entry.file}`);
  }
}

export function aggregateDigest(entries) {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.file, "utf8");
    hash.update("\0");
    hash.update(entry.sha256, "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function validateReleaseInputs(inputs) {
  exactKeys(
    inputs,
    ["schemaVersion", "packageName", "version", "sourceCommit", "packageLock", "dependencyClosure", "producerContract", "contractSet", "buildRecipe", "toolchain", "payload"],
    "release inputs",
  );
  invariant(inputs.schemaVersion === 1, "Unsupported release-inputs schema");
  invariant(inputs.packageName === PACKAGE_NAME, "Release-input package mismatch");
  invariant(EXACT_VERSION.test(inputs.version), "Release-input version is invalid");
  invariant(COMMIT.test(inputs.sourceCommit), "Release-input source commit is invalid");

  exactKeys(inputs.packageLock, ["file", "sha256", "lockfileVersion"], "packageLock");
  invariant(inputs.packageLock.file === "package-lock.json", "Unexpected package-lock filename");
  invariant(SHA256.test(inputs.packageLock.sha256), "Package-lock digest is invalid");
  invariant(inputs.packageLock.lockfileVersion === 3, "Only npm lockfile v3 is supported");

  exactKeys(inputs.dependencyClosure, ["algorithm", "scope", "components", "aggregateSha256"], "dependencyClosure");
  invariant(inputs.dependencyClosure.algorithm === "npm-lockfile-v3-production-bundled-v1", "Unexpected dependency-closure algorithm");
  invariant(inputs.dependencyClosure.scope === "production", "Dependency closure must be production-only");
  invariant(Array.isArray(inputs.dependencyClosure.components) && inputs.dependencyClosure.components.length > 0, "Runtime dependency closure is empty");
  const componentKeys = [];
  for (const component of inputs.dependencyClosure.components) {
    exactKeys(component, ["name", "version", "resolved", "integrity", "license", "bundled"], "dependency component");
    invariant(typeof component.name === "string" && component.name.length > 0, "Dependency name is missing");
    invariant(EXACT_VERSION.test(component.version), `Dependency version is invalid: ${component.name}`);
    invariant(typeof component.resolved === "string" && component.resolved.startsWith("https://registry.npmjs.org/"), `Dependency source is not canonical npm: ${component.name}`);
    invariant(/^sha512-[A-Za-z0-9+/]+=*$/u.test(component.integrity), `Dependency integrity is invalid: ${component.name}`);
    invariant(typeof component.license === "string" && component.license.length > 0, `Dependency license is missing: ${component.name}`);
    invariant(component.bundled === true, `Runtime dependency is not bundled: ${component.name}`);
    componentKeys.push(`${component.name}\0${component.version}\0${component.resolved}\0${component.integrity}\0`);
  }
  invariant(JSON.stringify(componentKeys) === JSON.stringify([...componentKeys].sort()), "Dependency closure is not sorted");
  invariant(createHash("sha256").update(componentKeys.join(""), "utf8").digest("hex") === inputs.dependencyClosure.aggregateSha256, "Dependency-closure aggregate digest mismatch");

  invariant(
    JSON.stringify(inputs.producerContract) === JSON.stringify(INFRA_OPENAPI_CONTRACT_IDENTITY),
    "Producer contract identity differs from the vendored Infra witness",
  );

  exactKeys(inputs.contractSet, ["algorithm", "authority", "releaseAuthority", "files", "aggregateSha256"], "contractSet");
  invariant(inputs.contractSet.authority === "CUNA_INFRA_OPENAPI_VENDORED_EXACT", "Contract-set authority differs");
  invariant(inputs.contractSet.releaseAuthority === "UNRESOLVED_BLOCKING", "Working-tree producer delta must not claim canonical release authority");
  exactKeys(inputs.buildRecipe, ["algorithm", "commands", "files", "aggregateSha256"], "buildRecipe");
  invariant(Array.isArray(inputs.buildRecipe.commands) && inputs.buildRecipe.commands.length > 0, "Build-recipe commands are missing");
  for (const command of inputs.buildRecipe.commands) invariant(typeof command === "string" && command.length > 0, "Build-recipe command is invalid");
  for (const [label, value, algorithm, files] of [
    ["contractSet", inputs.contractSet, "cuna-cli-public-contract-files-v1", CONTRACT_FILES],
    ["buildRecipe", inputs.buildRecipe, "cuna-cli-build-recipe-files-v1", BUILD_RECIPE_FILES],
  ]) {
    invariant(value.algorithm === algorithm, `${label} algorithm differs`);
    validateDigestEntries(value.files, files, label);
    invariant(aggregateDigest(value.files) === value.aggregateSha256, `${label} aggregate digest mismatch`);
  }

  exactKeys(inputs.toolchain, ["node", "npm", "typescript", "runner"], "toolchain");
  for (const tool of ["node", "npm", "typescript"]) invariant(EXACT_TOOL_VERSION.test(inputs.toolchain[tool]), `toolchain.${tool} is invalid`);
  invariant(typeof inputs.toolchain.runner === "string" && inputs.toolchain.runner.length > 0, "toolchain.runner is missing");

  exactKeys(inputs.payload, ["schemaVersion", "algorithm", "fileCount", "files", "sha256"], "payload");
  invariant(inputs.payload.schemaVersion === 1 && inputs.payload.algorithm === "cuna-package-payload-v1", "Payload manifest identity is invalid");
  invariant(Number.isSafeInteger(inputs.payload.fileCount) && inputs.payload.fileCount > 0, "Payload file count is invalid");
  invariant(Array.isArray(inputs.payload.files) && inputs.payload.files.length === inputs.payload.fileCount, "Payload file set differs from fileCount");
  const payloadFiles = inputs.payload.files.map((entry) => entry.file);
  invariant(JSON.stringify(payloadFiles) === JSON.stringify([...payloadFiles].sort()), "Payload files are not sorted");
  for (const entry of inputs.payload.files) {
    exactKeys(entry, ["file", "size", "sha256"], "payload file");
    invariant(typeof entry.file === "string" && entry.file.length > 0 && !path.isAbsolute(entry.file), "Payload file path is invalid");
    invariant(Number.isSafeInteger(entry.size) && entry.size >= 0, `Payload file size is invalid: ${entry.file}`);
    invariant(SHA256.test(entry.sha256), `Payload file digest is invalid: ${entry.file}`);
  }
  invariant(SHA256.test(inputs.payload.sha256), "Payload build digest is invalid");
}

async function digestEntries(root, files) {
  const entries = [];
  for (const file of files) entries.push({ file, sha256: await sha256File(path.join(root, file)) });
  return entries;
}

export async function buildReleaseInputs({ root, sourceCommit, npmVersion, runner }) {
  const packageJson = await readJson(path.join(root, "package.json"));
  const packageLock = await readJson(path.join(root, "package-lock.json"));
  invariant(packageJson.name === PACKAGE_NAME, "Unexpected package identity while building release inputs");
  invariant(packageLock.lockfileVersion === 3, "Only npm lockfile v3 is supported");

  const rootLock = packageLock.packages?.[""];
  const runtimeNames = Object.keys(rootLock?.dependencies ?? {}).sort();
  invariant(JSON.stringify(runtimeNames) === JSON.stringify([...(packageJson.bundleDependencies ?? [])].sort()), "Runtime dependencies differ from bundleDependencies");
  const bundledEntries = Object.entries(packageLock.packages ?? {})
    .filter(([installPath, entry]) => installPath.includes("node_modules/") && entry?.inBundle === true)
    .map(([installPath, entry]) => {
      const suffix = installPath.slice(installPath.lastIndexOf("node_modules/") + "node_modules/".length);
      const segments = suffix.split("/");
      const name = suffix.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
      return {
        name,
        version: entry.version,
        resolved: entry.resolved,
        integrity: entry.integrity,
        license: entry.license,
        bundled: true,
      };
    })
    .sort((left, right) => `${left.name}\0${left.version}\0${left.resolved}`.localeCompare(`${right.name}\0${right.version}\0${right.resolved}`));
  for (const name of runtimeNames) {
    invariant(bundledEntries.some((entry) => entry.name === name), `Bundled lock entry is missing: ${name}`);
  }
  const components = bundledEntries.map((entry) => {
    return {
      name: entry.name,
      version: entry.version,
      resolved: entry.resolved,
      integrity: entry.integrity,
      license: entry.license,
      bundled: true,
    };
  });
  const componentKeys = components.map((component) => `${component.name}\0${component.version}\0${component.resolved}\0${component.integrity}\0`);
  const contractFiles = await digestEntries(root, CONTRACT_FILES);
  const infraOpenapiRawSha256 = await sha256File(path.join(root, INFRA_OPENAPI_FILE));
  invariant(infraOpenapiRawSha256 === INFRA_OPENAPI_RAW_SHA256, "Vendored infra OpenAPI raw bytes differ from the frozen producer contract");
  const canonicalDigestDeclaration = (await readFile(path.join(root, INFRA_OPENAPI_DIGEST_FILE), "utf8")).trim().split(/\s+/u);
  invariant(
    canonicalDigestDeclaration.length === 2 && canonicalDigestDeclaration[0] === INFRA_OPENAPI_CANONICAL_SHA256 &&
      canonicalDigestDeclaration[1]?.endsWith("-api.openapi.json") === true,
    "Vendored infra OpenAPI canonical digest declaration differs from the frozen producer contract",
  );
  const buildRecipeFiles = await digestEntries(root, BUILD_RECIPE_FILES);
  const buildIdentityModule = await import(`${pathToFileURL(path.join(root, "dist", "build-identity.js")).href}?release-inputs=${Date.now()}`);

  const inputs = {
    schemaVersion: 1,
    packageName: PACKAGE_NAME,
    version: packageJson.version,
    sourceCommit,
    packageLock: {
      file: "package-lock.json",
      sha256: await sha256File(path.join(root, "package-lock.json")),
      lockfileVersion: packageLock.lockfileVersion,
    },
    dependencyClosure: {
      algorithm: "npm-lockfile-v3-production-bundled-v1",
      scope: "production",
      components,
      aggregateSha256: createHash("sha256").update(componentKeys.join(""), "utf8").digest("hex"),
    },
    producerContract: INFRA_OPENAPI_CONTRACT_IDENTITY,
    contractSet: {
      algorithm: "cuna-cli-public-contract-files-v1",
      authority: "CUNA_INFRA_OPENAPI_VENDORED_EXACT",
      releaseAuthority: "UNRESOLVED_BLOCKING",
      files: contractFiles,
      aggregateSha256: aggregateDigest(contractFiles),
    },
    buildRecipe: {
      algorithm: "cuna-cli-build-recipe-files-v1",
      commands: [
        "npm ci --ignore-scripts",
        "npm run build",
        "npm pack --ignore-scripts --json",
        "npm sbom --sbom-format cyclonedx --omit=dev",
      ],
      files: buildRecipeFiles,
      aggregateSha256: aggregateDigest(buildRecipeFiles),
    },
    toolchain: {
      node: process.version.slice(1),
      npm: npmVersion,
      typescript: packageLock.packages["node_modules/typescript"]?.version,
      runner,
    },
    payload: await buildIdentityModule.packageBuildManifest(),
  };
  validateReleaseInputs(inputs);
  return inputs;
}

export async function verifyReleaseInputsFile(file, expected) {
  const inputs = JSON.parse(await readFile(file, "utf8"));
  validateReleaseInputs(inputs);
  invariant(inputs.packageName === expected.packageName, "Release-input package differs from envelope");
  invariant(inputs.version === expected.version, "Release-input version differs from envelope");
  invariant(inputs.sourceCommit === expected.sourceCommit, "Release-input source differs from envelope");
  invariant(inputs.payload.sha256 === expected.payloadBuildDigest, "Release-input payload differs from envelope");
  return inputs;
}

export async function verifyReleaseInputsAgainstRoot(inputs, root, { npmVersion, runner }) {
  const rebuilt = await buildReleaseInputs({
    root,
    sourceCommit: inputs.sourceCommit,
    npmVersion,
    runner,
  });
  invariant(
    JSON.stringify(rebuilt) === JSON.stringify(inputs),
    "Release inputs do not match the checked-out source, dependency closure, toolchain, or package payload",
  );
  return inputs;
}

export function releaseInputIdentities(inputs) {
  validateReleaseInputs(inputs);
  return Object.freeze({
    lockfileSha256: inputs.packageLock.sha256,
    dependencyClosureSha256: inputs.dependencyClosure.aggregateSha256,
    contractSha256: inputs.contractSet.aggregateSha256,
    buildRecipeSha256: inputs.buildRecipe.aggregateSha256,
    toolchainSha256: createHash("sha256").update(JSON.stringify(inputs.toolchain), "utf8").digest("hex"),
    payloadSha256: inputs.payload.sha256,
    payloadFileCount: inputs.payload.fileCount,
  });
}

export const RELEASE_INPUT_CONTRACT_FILES = CONTRACT_FILES;
export const RELEASE_INPUT_BUILD_RECIPE_FILES = BUILD_RECIPE_FILES;
