import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

test("local build-once composes the canonical release envelope and never introduces a second manifest authority", async () => {
  const source = await readFile(path.join(root, "scripts/build-local-release-candidate.mjs"), "utf8");
  const schema = JSON.parse(await readFile(path.join(root, "packaging/release-envelope.schema.json"), "utf8"));
  assert.match(source, /verify-package-contents\.mjs/u);
  assert.match(source, /build-release-inputs\.mjs/u);
  assert.match(source, /build-release-envelope\.mjs/u);
  assert.match(source, /verify-release-envelope\.mjs/u);
  assert.doesNotMatch(source, /native|component-release-manifest/iu);
  assert.equal(schema.properties.authority.properties.releaseEligible.const, false);
});
