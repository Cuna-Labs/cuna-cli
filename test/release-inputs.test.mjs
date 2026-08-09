import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildReleaseInputs,
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
  assert.ok(inputs.buildRecipe.files.some((entry) => entry.file === "scripts/lib/release-inputs.mjs"));
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
