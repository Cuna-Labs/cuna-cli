import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
    ["cli-native-win32-x64", "win32", "x64", "runa-native-bridge.exe"],
    ["cli-native-darwin-x64", "darwin", "x64", "runa-native-bridge"],
    ["cli-native-darwin-arm64", "darwin", "arm64", "runa-native-bridge"],
  ];
  for (const [directory, platform, architecture, executable] of fixtures) {
    const manifest = JSON.parse(await readFile(
      path.join(root, "native", "packages", directory, "package.json"),
      "utf8",
    ));
    assert.deepEqual(manifest.os, [platform]);
    assert.deepEqual(manifest.cpu, [architecture]);
    assert.equal(Object.hasOwn(manifest, "scripts"), false);
    assert.equal(manifest.files.includes(executable), true);
    assert.equal(manifest.files.includes(platform === "win32" ? "runa-native-bridge" : "runa-native-bridge.exe"), false);
    assert.deepEqual(manifest.exports, { "./package.json": "./package.json" });
  }
});

test("the public package selects every platform package as an exact optional dependency", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(manifest.optionalDependencies, {
    "@cuna_labs/cli-native-darwin-arm64": "0.1.0",
    "@cuna_labs/cli-native-darwin-x64": "0.1.0",
    "@cuna_labs/cli-native-win32-x64": "0.1.0",
  });
  assert.deepEqual(manifest.files, ["dist", "README.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]);
  assert.deepEqual(manifest.bin, { cuna: "./dist/bin/cuna.js" });
});
