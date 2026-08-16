import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildReleaseInputs,
  INFRA_OPENAPI_CONTRACT_IDENTITY,
  verifyReleaseInputsAgainstRoot,
} from "../scripts/lib/release-inputs.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const expected = Object.freeze({ npmVersion: "11.4.2", runner: "fixture-runner" });

async function fixture() {
  return buildReleaseInputs({
    root: repositoryRoot,
    sourceCommit: "a".repeat(40),
    npmVersion: expected.npmVersion,
    runner: expected.runner,
  });
}

test("release inputs are reproducible from the checked-out source and payload", async () => {
  const inputs = await fixture();
  await verifyReleaseInputsAgainstRoot(inputs, repositoryRoot, expected);
  assert.ok(inputs.payload.files.some((entry) => entry.file === "THIRD_PARTY_NOTICES.md"));
  const boundRecipeFiles = new Set(inputs.buildRecipe.files.map((entry) => entry.file));
  for (const releaseAuthority of [
    ".github/workflows/ci.yml",
    ".github/workflows/distribution-projection-proof.yml",
    ".github/workflows/release.yml",
    "packaging/release-approval-consumption-authority.json",
    "packaging/templates/aur/PKGBUILD.template",
    "packaging/templates/homebrew/cuna.rb.template",
    "packaging/templates/install.sh.template",
    "scripts/emit-infra-contract-witness.mjs",
    "scripts/lib/infra-contract-witness.mjs",
    "scripts/lib/release-inputs.mjs",
    "scripts/lib/release-approval-lease.mjs",
    "scripts/lib/release-approval-consumption.mjs",
    "scripts/consume-release-approval-nonce.mjs",
    "scripts/release-distribution-lib.mjs",
    "scripts/release-project-distributions.mjs",
    "scripts/sync-infra-openapi.mjs",
    "scripts/summarize-observation-receipts.mjs",
    "scripts/verify-distribution-receipts.mjs",
    "scripts/verify-release-admission.mjs",
    "scripts/verify-release-approval-lease.mjs",
    "scripts/verify-release-distributions.mjs",
  ]) {
    assert.ok(boundRecipeFiles.has(releaseAuthority), `release recipe must bind ${releaseAuthority}`);
  }
  for (const contract of [
    "contracts/infra/cuna-api.openapi.json",
    "contracts/infra/cuna-api.openapi.sha256",
    "contracts/infra/cuna-api.openapi.identity.json",
    "src/config/infra-contract-witness.ts",
    "packaging/contract-authority.schema.json",
    "packaging/observation-summary.schema.json",
    "packaging/release-approval-lease.schema.json",
  ]) assert.ok(inputs.contractSet.files.some((entry) => entry.file === contract));
  assert.deepEqual(inputs.producerContract, INFRA_OPENAPI_CONTRACT_IDENTITY);
  assert.ok(inputs.dependencyClosure.components.some((entry) => entry.name === "@xterm/headless"));
});

test("release inputs reject substituted lockfile and toolchain identities", async () => {
  const lockSubstitution = structuredClone(await fixture());
  lockSubstitution.packageLock.sha256 = "f".repeat(64);
  await assert.rejects(
    verifyReleaseInputsAgainstRoot(lockSubstitution, repositoryRoot, expected),
    /do not match the checked-out source/,
  );

  const toolchainSubstitution = structuredClone(await fixture());
  toolchainSubstitution.toolchain.runner = "different-runner";
  await assert.rejects(
    verifyReleaseInputsAgainstRoot(toolchainSubstitution, repositoryRoot, expected),
    /do not match the checked-out source/,
  );
});
