import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const verifier = path.resolve("scripts/verify-dependency-policy.mjs");

test("dependency policy rejects ranged runtime dependencies that can drift for global installs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runa-dependency-policy-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      dependencies: { example: "^1.2.3" },
    }));
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/example": {
          version: "1.2.3",
          resolved: "https://registry.npmjs.org/example/-/example-1.2.3.tgz",
          integrity: "sha512-test",
        },
      },
    }));

    const result = spawnSync(process.execPath, [verifier, "--root", root], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /runtime dependencies must use an exact version/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
