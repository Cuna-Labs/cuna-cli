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

test("dependency policy rejects a lock entry whose source bytes are not bound", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runa-dependency-policy-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      dependencies: { example: "1.2.3" },
    }));
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/example": { version: "1.2.3" },
      },
    }));

    const result = spawnSync(process.execPath, [verifier, "--root", root], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /missing canonical resolved source/u);
    assert.match(`${result.stdout}${result.stderr}`, /missing or non-SHA-512 integrity/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependency policy rejects an unbundled runtime dependency", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runa-dependency-policy-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      dependencies: { example: "1.2.3" },
      bundleDependencies: [],
    }));
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/example": {
          version: "1.2.3",
          resolved: "https://registry.npmjs.org/example/-/example-1.2.3.tgz",
          integrity: "sha512-dGVzdA==",
        },
      },
    }));

    const result = spawnSync(process.execPath, [verifier, "--root", root], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /bundleDependencies must equal/u);
    assert.match(`${result.stdout}${result.stderr}`, /runtime dependency is not marked as bundled/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependency policy rejects a partial native optional-dependency cohort", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cuna-native-cohort-policy-"));
  try {
    const name = "@cuna_labs/cli-native-win32-x64";
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "@cuna_labs/cli",
      version: "0.1.0",
      optionalDependencies: { [name]: "0.1.0" },
      bundleDependencies: [],
    }));
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { optionalDependencies: { [name]: "0.1.0" } },
        [`node_modules/${name}`]: {
          version: "0.1.0",
          resolved: "https://registry.npmjs.org/@cuna_labs/cli-native-win32-x64/-/cli-native-win32-x64-0.1.0.tgz",
          integrity: "sha512-dGVzdA==",
          optional: true,
          os: ["win32"],
          cpu: ["x64"],
        },
      },
    }));

    const result = spawnSync(process.execPath, [verifier, "--root", root], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /one complete platform cohort/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependency policy rejects bundled or platform-mismatched native packages", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cuna-native-binding-policy-"));
  try {
    const native = {
      "@cuna_labs/cli-native-darwin-arm64": ["darwin", "arm64"],
      "@cuna_labs/cli-native-darwin-x64": ["darwin", "x64"],
      "@cuna_labs/cli-native-win32-x64": ["win32", "x64"],
    };
    const optionalDependencies = Object.fromEntries(Object.keys(native).map((name) => [name, "0.1.0"]));
    const packages = { "": { optionalDependencies } };
    for (const [name, [os, cpu]] of Object.entries(native)) {
      packages[`node_modules/${name}`] = {
        version: "0.1.0",
        resolved: `https://registry.npmjs.org/${name}/-/artifact-0.1.0.tgz`,
        integrity: "sha512-dGVzdA==",
        optional: true,
        os: [os],
        cpu: [cpu],
      };
    }
    packages["node_modules/@cuna_labs/cli-native-win32-x64"].inBundle = true;
    packages["node_modules/@cuna_labs/cli-native-win32-x64"].cpu = ["arm64"];
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "@cuna_labs/cli",
      version: "0.1.0",
      optionalDependencies,
      bundleDependencies: [],
    }));
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));

    const result = spawnSync(process.execPath, [verifier, "--root", root], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /optional, unbundled, and bound to win32\/x64/u);
    assert.match(`${result.stdout}${result.stderr}`, /must not be bundled/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependency policy admits one exact unbundled native platform cohort", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cuna-native-cohort-positive-"));
  try {
    const native = {
      "@cuna_labs/cli-native-darwin-arm64": ["darwin", "arm64"],
      "@cuna_labs/cli-native-darwin-x64": ["darwin", "x64"],
      "@cuna_labs/cli-native-win32-x64": ["win32", "x64"],
    };
    const optionalDependencies = Object.fromEntries(Object.keys(native).map((name) => [name, "0.1.0"]));
    const packages = { "": { optionalDependencies } };
    for (const [name, [os, cpu]] of Object.entries(native)) {
      const artifact = name.slice("@cuna_labs/".length);
      packages[`node_modules/${name}`] = {
        version: "0.1.0",
        resolved: `https://registry.npmjs.org/${name}/-/${artifact}-0.1.0.tgz`,
        integrity: "sha512-dGVzdA==",
        optional: true,
        os: [os],
        cpu: [cpu],
      };
    }
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "@cuna_labs/cli",
      version: "0.1.0",
      optionalDependencies,
      bundleDependencies: [],
    }));
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));

    const result = spawnSync(process.execPath, [verifier, "--root", root], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /"status":"verified"/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
