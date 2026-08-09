import { createHash } from "node:crypto";

import {
  aggregateDigest,
  RELEASE_INPUT_BUILD_RECIPE_FILES,
  RELEASE_INPUT_CONTRACT_FILES,
  validateReleaseInputs,
} from "./release-inputs.mjs";

export function syntheticReleaseInputs({ version = "1.2.3-preview.1", sourceCommit = "a".repeat(40) } = {}) {
  const digest = "d".repeat(64);
  const contractFiles = RELEASE_INPUT_CONTRACT_FILES.map((file) => ({ file, sha256: digest }));
  const recipeFiles = RELEASE_INPUT_BUILD_RECIPE_FILES.map((file) => ({ file, sha256: digest }));
  const componentKey = `@xterm/headless\06.0.0\0sha512-dGVzdA==\0`;
  const inputs = {
    schemaVersion: 1,
    packageName: "@runa_laboratories/cli",
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
    contractSet: {
      algorithm: "runa-cli-public-contract-files-v1",
      authority: "RUNA_CLI_LOCAL_CONSUMER_SNAPSHOT",
      releaseAuthority: "UNRESOLVED_BLOCKING",
      files: contractFiles,
      aggregateSha256: aggregateDigest(contractFiles),
    },
    buildRecipe: {
      algorithm: "runa-cli-build-recipe-files-v1",
      commands: ["npm ci --ignore-scripts"],
      files: recipeFiles,
      aggregateSha256: aggregateDigest(recipeFiles),
    },
    toolchain: { node: "22.17.1", npm: "11.4.2", typescript: "5.9.3", runner: "ubuntu-24.04" },
    payload: {
      schemaVersion: 1,
      algorithm: "runa-package-payload-v1",
      fileCount: 1,
      files: [{ file: "package.json", size: 2, sha256: digest }],
      sha256: "e".repeat(64),
    },
  };
  validateReleaseInputs(inputs);
  return inputs;
}
