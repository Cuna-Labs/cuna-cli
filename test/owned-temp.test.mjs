import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

import { withOwnedTempDirectory } from "../scripts/lib/owned-temp.mjs";

async function isAbsent(candidate) {
  try {
    await access(candidate);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

test("owned temp scope is removed after successful work", async () => {
  let observedRoot;
  const result = await withOwnedTempDirectory("runa-owned-temp-test-", async (root) => {
    observedRoot = root;
    return "complete";
  });
  assert.equal(result, "complete");
  assert.equal(await isAbsent(observedRoot), true);
});

test("owned temp scope is removed after primary and cleanup-hook failures", async () => {
  let observedRoot;
  await assert.rejects(
    withOwnedTempDirectory("runa-owned-temp-test-", async (root) => {
      observedRoot = root;
      throw new Error("primary failure");
    }, {
      beforeRemove: async () => { throw new Error("cleanup hook failure"); },
    }),
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
  assert.equal(await isAbsent(observedRoot), true);
});

test("owned temp scope rejects ambiguous ownership prefixes", async () => {
  await assert.rejects(withOwnedTempDirectory("generic-", async () => undefined), /Cuna-owned/u);
});
