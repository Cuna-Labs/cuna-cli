import { createHash } from "node:crypto";

import {
  aggregateDigest,
  INFRA_OPENAPI_CONTRACT_IDENTITY,
  releaseInputIdentities,
  RELEASE_INPUT_BUILD_RECIPE_FILES,
  RELEASE_INPUT_CONTRACT_FILES,
  validateReleaseInputs,
} from "./release-inputs.mjs";

export function syntheticReleaseInputs({ version = "1.2.3-preview.1", sourceCommit = "a".repeat(40) } = {}) {
  const digest = "d".repeat(64);
  const contractFiles = RELEASE_INPUT_CONTRACT_FILES.map((file) => ({ file, sha256: digest }));
  const recipeFiles = RELEASE_INPUT_BUILD_RECIPE_FILES.map((file) => ({ file, sha256: digest }));
  const componentKey = [
    "@xterm/headless",
    "6.0.0",
    "https://registry.npmjs.org/@xterm/headless/-/headless-6.0.0.tgz",
    "sha512-dGVzdA==",
    "",
  ].join("\0");
  const inputs = {
    schemaVersion: 1,
    packageName: "@cuna_labs/cli",
    version,
    sourceCommit,
    packageLock: { file: "package-lock.json", sha256: digest, lockfileVersion: 3 },
    dependencyClosure: {
      algorithm: "npm-lockfile-v3-production-bundled-v1",
      scope: "production",
      components: [{
        name: "@xterm/headless",
        version: "6.0.0",
        resolved: "https://registry.npmjs.org/@xterm/headless/-/headless-6.0.0.tgz",
        integrity: "sha512-dGVzdA==",
        license: "MIT",
        bundled: true,
      }],
      aggregateSha256: createHash("sha256").update(componentKey, "utf8").digest("hex"),
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
      commands: ["npm ci --ignore-scripts"],
      files: recipeFiles,
      aggregateSha256: aggregateDigest(recipeFiles),
    },
    toolchain: { node: "22.17.1", npm: "11.4.2", typescript: "5.9.3", runner: "ubuntu-24.04" },
    payload: {
      schemaVersion: 1,
      algorithm: "cuna-package-payload-v1",
      fileCount: 1,
      files: [{ file: "package.json", size: 2, sha256: digest }],
      sha256: "e".repeat(64),
    },
  };
  validateReleaseInputs(inputs);
  return inputs;
}

export function syntheticReleaseEnvelope({
  version = "1.2.3-preview.1",
  sourceCommit = "a".repeat(40),
  tarball,
  sbom,
  supportPolicy,
  releaseInputs,
  releaseInputsSha256,
  runId = "42",
} = {}) {
  return {
    schemaVersion: 2,
    packageName: "@cuna_labs/cli",
    version,
    sourceCommit,
    repository: "Cuna-Labs/cuna-cli",
    registry: "https://registry.npmjs.org",
    tarball,
    sbom,
    supportPolicy,
    releaseInputs: { file: "release-inputs.json", sha256: releaseInputsSha256 },
    identities: releaseInputIdentities(releaseInputs),
    authority: {
      phase: "CANDIDATE_BUILT",
      releaseEligible: false,
      approval: { state: "REQUIRED_NOT_PRESENT", environment: "npm", receiptSha256: null },
      provenance: { state: "REQUIRED_NOT_PRESENT", workflow: ".github/workflows/ci.yml", receiptSha256: null },
    },
    builder: { workflow: ".github/workflows/ci.yml", runId, runAttempt: "1" },
  };
}
