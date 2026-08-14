import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  CredentialBoundaryError,
  createProductionNativeAuthBridges,
} from "../dist/credentials/index.js";

const root = path.resolve(import.meta.dirname, "..");

test("TC-048-02/05 production native composition fails closed without an admitted signed release entry", async () => {
  await assert.rejects(
    createProductionNativeAuthBridges({ runtimePlatform: "win32", runtimeArchitecture: "x64" }),
    (error) => error instanceof CredentialBoundaryError &&
      error.code === "credential_backend_unverified" && !String(error).includes("@cuna_labs"),
  );
  await assert.rejects(
    createProductionNativeAuthBridges({ runtimePlatform: "darwin", runtimeArchitecture: "arm64" }),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_backend_unverified",
  );
});

test("Linux does not load a foreign native package", async () => {
  assert.equal(
    await createProductionNativeAuthBridges({ runtimePlatform: "linux", runtimeArchitecture: "x64" }),
    undefined,
  );
});

test("platform packages are exact, script-free, and contain only their own executable name", async () => {
  const fixtures = [
    ["cli-native-win32-x64", "win32", "x64", "cuna-native-bridge.exe"],
    ["cli-native-darwin-x64", "darwin", "x64", "cuna-native-bridge"],
    ["cli-native-darwin-arm64", "darwin", "arm64", "cuna-native-bridge"],
  ];
  for (const [directory, platform, architecture, executable] of fixtures) {
    const manifest = JSON.parse(await readFile(
      path.join(root, "native", "packages", directory, "package.json"),
      "utf8",
    ));
    assert.deepEqual(manifest.os, [platform]);
    assert.deepEqual(manifest.cpu, [architecture]);
    assert.equal(manifest.private, true, "source-only native package must reject accidental publication");
    assert.equal(Object.hasOwn(manifest, "scripts"), false);
    assert.equal(manifest.files.includes(executable), true);
    assert.equal(manifest.files.includes(platform === "win32" ? "cuna-native-bridge" : "cuna-native-bridge.exe"), false);
    assert.deepEqual(manifest.exports, { "./package.json": "./package.json" });
  }
});

test("source-only native package manifests cannot be mistaken for release artifacts", async () => {
  for (const directory of [
    "cli-native-win32-x64",
    "cli-native-darwin-x64",
    "cli-native-darwin-arm64",
  ]) {
    const packageRoot = path.join(root, "native", "packages", directory);
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    for (const file of manifest.files) {
      await assert.rejects(
        access(path.join(packageRoot, file)),
        (error) => error?.code === "ENOENT",
        `${directory}/${file} must be absent until a release builder creates admitted bytes`,
      );
    }
  }
});

test("the public package neither selects nor ships the dormant native platform path", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(Object.hasOwn(manifest, "optionalDependencies"), false);
  assert.deepEqual(manifest.files, [
    "dist",
    "!dist/credentials/index.*",
    "!dist/credentials/native-*",
    "!dist/credentials/platform.*",
    "README.md",
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_NOTICES.md",
  ]);
  assert.deepEqual(manifest.bin, { cuna: "./dist/bin/cuna.js" });
});

test("the lock file resolves every declared dependency so a clean install cannot fail", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const declared = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ];
  for (const name of declared) {
    assert.equal(
      Object.hasOwn(lock.packages, `node_modules/${name}`),
      true,
      `${name} is declared but absent from package-lock.json`,
    );
  }
  assert.deepEqual(lock.packages[""].optionalDependencies, undefined);
});
