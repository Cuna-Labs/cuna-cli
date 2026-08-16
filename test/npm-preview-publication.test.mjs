import assert from "node:assert/strict";
import test from "node:test";

import { executeNpmPreviewPublication } from "../scripts/lib/npm-preview-publication.mjs";

const order = ["verifyLease", "verifyAttestation", "verifyNonce", "verifyRegistryAbsent", "publish"];

function phases({ failAt } = {}) {
  const calls = [];
  const value = Object.fromEntries(order.map((name) => [name, async () => {
    calls.push(name);
    if (name === failAt) throw new Error(`failed:${name}`);
    return name === "publish" ? "published" : undefined;
  }]));
  return { calls, value };
}

test("npm preview publication executes every fresh authority in exact order", async () => {
  const fixture = phases();
  assert.equal(await executeNpmPreviewPublication(fixture.value), "published");
  assert.deepEqual(fixture.calls, order);
});

for (const [index, name] of order.entries()) {
  test(`npm preview publication fails closed when ${name} fails`, async () => {
    const fixture = phases({ failAt: name });
    await assert.rejects(executeNpmPreviewPublication(fixture.value), new RegExp(`failed:${name}`, "u"));
    assert.deepEqual(fixture.calls, order.slice(0, index + 1));
    if (name !== "publish") assert.ok(!fixture.calls.includes("publish"));
  });
}

test("npm preview publication rejects missing, extra, or non-executable phases", async () => {
  const fixture = phases();
  const { publish, ...missing } = fixture.value;
  await assert.rejects(executeNpmPreviewPublication(missing), /phase set differs/u);
  await assert.rejects(executeNpmPreviewPublication({ ...fixture.value, optional: async () => {} }), /phase set differs/u);
  await assert.rejects(executeNpmPreviewPublication({ ...fixture.value, publish: "npm publish" }), /not executable/u);
  assert.equal(typeof publish, "function");
});
