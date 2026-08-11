import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contract = JSON.parse(await readFile(
  new URL("../packaging/windows-native-system-component.json", import.meta.url),
  "utf8",
));

test("Windows native authentication requires a separate fail-closed system component", () => {
  assert.equal(contract.schema, "cuna.windows-native-system-component.v1");
  assert.equal(contract.status, "UNCONFIGURED_BLOCKING");
  assert.equal(contract.installer.kind, "signed-msi");
  assert.equal(contract.installer.installRootAuthority, "FOLDERID_ProgramFiles");
  assert.equal(contract.installer.relativeRoot, "Cuna\\Native\\<version>\\<architecture>");
  assert.equal(contract.installer.npmGlobalLayoutAdmitted, false);
  assert.equal(contract.installer.npmLifecycleInstallationAllowed, false);
  assert.equal(contract.bootstrap.publicExecutable, "cuna");
  assert.equal(contract.bootstrap.mustResolveKnownFolderWithoutEnvironment, true);
  assert.equal(contract.bootstrap.mustOwnEveryAncestorAndLeafHandle, true);
  assert.deepEqual(contract.bootstrap.deniedShareModes, ["write", "delete"]);
  assert.deepEqual(contract.bootstrap.mustVerifyBeforeSecretHandoff, [
    "owner",
    "effective-dacl",
    "no-reparse-point",
    "single-hard-link",
    "volume-id",
    "file-id",
    "sha256",
    "authenticode",
    "loaded-module-identity",
  ]);
  assert.equal(contract.activation.interactiveAuthentication, "UNAVAILABLE");
  assert.equal(contract.activation.unsignedOrUserWritableFallback, false);
});
