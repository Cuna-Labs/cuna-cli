import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { PACKAGE_NAME, invariant, readJson, sha256File } from "./release-evidence.mjs";

const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const EXACT_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const EXACT_TOOL_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;

const CONTRACT_FILES = Object.freeze([
  "src/api/contracts.ts",
  "src/core/errors.ts",
  "src/pty/contracts.ts",
  "src/runtime/contracts.ts",
  "src/terminal/codec.ts",
  "src/version.ts",
]);

const BUILD_RECIPE_FILES = Object.freeze([
  ".github/workflows/ci.yml",
  "package.json",
  "package-lock.json",
  "packaging/admission-policy.json",
  "packaging/support-policy.json",
  "scripts/build-release-envelope.mjs",
  "scripts/build-release-inputs.mjs",
  "scripts/lib/release-evidence.mjs",
  "scripts/lib/exclusive-build-lock.mjs",
  "scripts/lib/release-inputs.mjs",
  "scripts/run-build-operation.mjs",
  "scripts/verify-dependency-policy.mjs",
  "scripts/verify-installed-candidate.mjs",
  "scripts/verify-package-contents.mjs",
  "src/build-identity.ts",
  "tsconfig.json",
]);

function exactKeys(value, expected, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(JSON.stringify(actual) === JSON.stringify(wanted), `${label} keys differ: ${actual.join(", ")}`);
}

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
    ["schemaVersion", "packageName", "version", "sourceCommit", "packageLock", "dependencyClosure", "contractSet", "buildRecipe", "toolchain", "payload"],
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

  exactKeys(inputs.contractSet, ["algorithm", "authority", "releaseAuthority", "files", "aggregateSha256"], "contractSet");
  invariant(inputs.contractSet.authority === "RUNA_CLI_LOCAL_CONSUMER_SNAPSHOT", "Contract-set authority differs");
  invariant(inputs.contractSet.releaseAuthority === "UNRESOLVED_BLOCKING", "Local contract set may not claim canonical release authority");
  exactKeys(inputs.buildRecipe, ["algorithm", "commands", "files", "aggregateSha256"], "buildRecipe");
  invariant(Array.isArray(inputs.buildRecipe.commands) && inputs.buildRecipe.commands.length > 0, "Build-recipe commands are missing");
  for (const command of inputs.buildRecipe.commands) invariant(typeof command === "string" && command.length > 0, "Build-recipe command is invalid");
  for (const [label, value, algorithm, files] of [
    ["contractSet", inputs.contractSet, "runa-cli-public-contract-files-v1", CONTRACT_FILES],
    ["buildRecipe", inputs.buildRecipe, "runa-cli-build-recipe-files-v1", BUILD_RECIPE_FILES],
  ]) {
    invariant(value.algorithm === algorithm, `${label} algorithm differs`);
    validateDigestEntries(value.files, files, label);
    invariant(aggregateDigest(value.files) === value.aggregateSha256, `${label} aggregate digest mismatch`);
  }

  exactKeys(inputs.toolchain, ["node", "npm", "typescript", "runner"], "toolchain");
  for (const tool of ["node", "npm", "typescript"]) invariant(EXACT_TOOL_VERSION.test(inputs.toolchain[tool]), `toolchain.${tool} is invalid`);
  invariant(typeof inputs.toolchain.runner === "string" && inputs.toolchain.runner.length > 0, "toolchain.runner is missing");

  exactKeys(inputs.payload, ["schemaVersion", "algorithm", "fileCount", "files", "sha256"], "payload");
  invariant(inputs.payload.schemaVersion === 1 && inputs.payload.algorithm === "runa-package-payload-v1", "Payload manifest identity is invalid");
  invariant(Number.isSafeInteger(inputs.payload.fileCount) && inputs.payload.fileCount > 0, "Payload file count is invalid");
  invariant(Array.isArray(inputs.payload.files) && inputs.payload.files.length === inputs.payload.fileCount, "Payload file set differs from fileCount");
  invariant(JSON.stringify(inputs.payload.files.map((entry) => entry.file)) === JSON.stringify([...inputs.payload.files.map((entry) => entry.file)].sort()), "Payload files are not sorted");
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
    contractSet: {
      algorithm: "runa-cli-public-contract-files-v1",
      authority: "RUNA_CLI_LOCAL_CONSUMER_SNAPSHOT",
      releaseAuthority: "UNRESOLVED_BLOCKING",
      files: contractFiles,
      aggregateSha256: aggregateDigest(contractFiles),
    },
    buildRecipe: {
      algorithm: "runa-cli-build-recipe-files-v1",
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
