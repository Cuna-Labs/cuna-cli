import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const credentialDirectory = path.join(root, "src", "credentials");
const retiredCredentialModules = Object.freeze([
  "linux-secret-service.ts",
  "native-admission.ts",
  "native-bridge-backend.ts",
  "native-platform-release-index.ts",
  "native-process-bridge.ts",
  "native-production.ts",
  "platform.ts",
  "process-runner.ts",
  "unavailable-backend.ts",
]);
const publicCredentialModules = Object.freeze([
  "contracts",
  "errors",
  "local-session",
  "secret-material",
  "vault",
]);
const forbiddenProductCredentialReference = /(?:Credential Manager|Keychain|Secret Service|NativeCredentialBridge|native-(?:admission|bridge|platform|process)|linux-secret-service|process-runner|unavailable-backend|\.\/platform\.js)/iu;
const retiredNativeReleaseFiles = Object.freeze([
  "native/Cargo.toml",
  "native/cuna-native-authority/Cargo.toml",
  "native/cuna-native-bridge/Cargo.toml",
  "native/packages/cli-native-win32-x64/package.json",
  "scripts/capture-native-windows-identity.ps1",
  "scripts/generate-native-release-evidence.mjs",
  "scripts/verify-native-release-evidence.mjs",
]);

test("public credential surface is AES-GCM only and has no native-store loader", async () => {
  const credentialFiles = await readdir(credentialDirectory);
  for (const retired of retiredCredentialModules) {
    assert.equal(credentialFiles.includes(retired), false, `${retired} must not remain in the product credential source`);
  }

  const index = await readFile(path.join(credentialDirectory, "index.ts"), "utf8");
  const exports = [...index.matchAll(/^export \* from "\.\/([a-z-]+)\.js";$/gmu)].map((match) => match[1]);
  assert.deepEqual(exports, publicCredentialModules, "credential index must expose only the public AES-GCM modules");

  for (const module of publicCredentialModules) {
    const source = await readFile(path.join(credentialDirectory, `${module}.ts`), "utf8");
    assert.doesNotMatch(source, forbiddenProductCredentialReference, `${module} retains a forbidden credential-store reference`);
  }

  const cli = await readFile(path.join(root, "src", "cli", "run.ts"), "utf8");
  assert.doesNotMatch(cli, forbiddenProductCredentialReference, "CLI must not select a retired platform credential backend");
});

test("package policy admits only the public AES-GCM credential artifacts", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.optionalDependencies, undefined, "public package must not select a native optional dependency");
  assert.deepEqual(
    manifest.files.filter((entry) => entry.startsWith("!dist/credentials/")),
    ["!dist/credentials/local-session-preview.*"],
    "the non-product preview is the sole excluded credential artifact",
  );

  const verifier = await readFile(path.join(root, "scripts", "verify-package-contents.mjs"), "utf8");
  assert.match(verifier, /PRODUCT_CREDENTIAL_ARTIFACT/u);
  assert.match(verifier, /Only the AES-GCM credential surface may ship/u);
});

test("native credential, signing, and browser-release gates are absent from source, CI, and public packaging", async () => {
  for (const retired of retiredNativeReleaseFiles) {
    await assert.rejects(access(path.join(root, retired)), { code: "ENOENT" }, `${retired} must be removed, not merely unreachable`);
  }

  const ci = await readFile(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.doesNotMatch(
    ci,
    /native-source-gates|native-evidence-gates|capture-native-windows-identity|generate-native-release-evidence|verify-native-release-evidence|cargo \+1\.97\.1|Authenticode/iu,
    "CI must not retain a native credential or signing release path",
  );

  const packagingReadme = await readFile(path.join(root, "packaging", "README.md"), "utf8");
  const supportPolicy = await readFile(path.join(root, "packaging", "support-policy.json"), "utf8");
  const releaseSurface = `${packagingReadme}\n${supportPolicy}`;
  assert.match(releaseSurface, /AES-256-GCM/u);
  assert.match(releaseSurface, /owner-only/u);
  assert.doesNotMatch(
    releaseSurface,
    /native credential|platform browser bridge|code-signing|Credential Manager|Keychain|CreateProcessW/iu,
    "public release material must describe the AES-GCM profile path only",
  );
});
