import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CredentialBoundaryError,
  createAdmittedNativeCredentialBridge,
  discoverAdmittedNativeBridge,
} from "../dist/credentials/index.js";

const fingerprint = "C".repeat(64);

test("TC-048-14 discovery binds manifest, binary, SBOM, provenance, version, platform, architecture, and signature", async (context) => {
  const fixture = await createFixture();
  context.after(async () => rm(fixture.root, { recursive: true, force: true }));
  const signatureAuthority = {
    verify: async () => ({
      valid: true,
      locationProtected: true,
      binarySha256: fixture.binarySha256,
      fileVersion: "0.1.0.0",
      kind: "authenticode",
      publisherCertificateFingerprint: fingerprint,
    }),
  };
  const admitted = await discoverAdmittedNativeBridge({
    trust: fixture.trust,
    signatureAuthority,
    runtimePlatform: "win32",
    runtimeArchitecture: "x64",
  });
  assert.equal(admitted.descriptor.binarySha256, fixture.binarySha256);
  assert.equal(admitted.descriptor.fileVersion, "0.1.0.0");
  await admitted.verifier.verify(admitted.descriptor);
});

test("TC-048-05 unsigned discovery fails closed before producing a descriptor", async (context) => {
  const fixture = await createFixture();
  context.after(async () => rm(fixture.root, { recursive: true, force: true }));
  await assert.rejects(
    discoverAdmittedNativeBridge({
      trust: fixture.trust,
      runtimePlatform: "win32",
      runtimeArchitecture: "x64",
    }),
    isUnverified,
  );
});

test("TC-048-14 a signed path without an OS child-image authority remains unavailable", async (context) => {
  const fixture = await createFixture();
  context.after(async () => rm(fixture.root, { recursive: true, force: true }));
  let runnerCalls = 0;
  await assert.rejects(
    createAdmittedNativeCredentialBridge({
      trust: fixture.trust,
      signatureAuthority: {
        verify: async () => ({
          valid: true,
          locationProtected: true,
          binarySha256: fixture.binarySha256,
          fileVersion: "0.1.0.0",
          kind: "authenticode",
          publisherCertificateFingerprint: fingerprint,
        }),
      },
      runner: { run: async () => {
        runnerCalls += 1;
        return { exitCode: 0, signal: null, stdout: new Uint8Array(), stderrPresent: false };
      } },
      runtimePlatform: "win32",
      runtimeArchitecture: "x64",
    }),
    isUnverified,
  );
  assert.equal(runnerCalls, 0);
});

test("TC-048-14 fresh verification rejects post-discovery substitution", async (context) => {
  const fixture = await createFixture();
  context.after(async () => rm(fixture.root, { recursive: true, force: true }));
  const signatureAuthority = {
    verify: async () => ({
      valid: true,
      locationProtected: true,
      binarySha256: fixture.binarySha256,
      fileVersion: "0.1.0.0",
      kind: "authenticode",
      publisherCertificateFingerprint: fingerprint,
    }),
  };
  const admitted = await discoverAdmittedNativeBridge({
    trust: fixture.trust,
    signatureAuthority,
    runtimePlatform: "win32",
    runtimeArchitecture: "x64",
  });
  await writeFile(path.join(fixture.root, "runa-native-bridge.exe"), "substituted");
  await assert.rejects(admitted.verifier.verify(admitted.descriptor), isUnverified);
});

test("TC-048-15 signer and protected-location observations are mandatory", async (context) => {
  const fixture = await createFixture();
  context.after(async () => rm(fixture.root, { recursive: true, force: true }));
  for (const observation of [
    { valid: false, locationProtected: true },
    { valid: true, locationProtected: false },
  ]) {
    await assert.rejects(
      discoverAdmittedNativeBridge({
        trust: fixture.trust,
        signatureAuthority: {
          verify: async () => ({
            ...observation,
            binarySha256: fixture.binarySha256,
            fileVersion: "0.1.0.0",
            kind: "authenticode",
            publisherCertificateFingerprint: fingerprint,
          }),
        },
        runtimePlatform: "win32",
        runtimeArchitecture: "x64",
      }),
      isUnverified,
    );
  }
});

async function createFixture() {
  const root = path.normalize(await mkdtemp(path.join(tmpdir(), "runa-native-admission-")));
  const binary = Buffer.from("unit-test-only-native-binary", "utf8");
  const binarySha256 = sha256(binary);
  const sbom = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    packages: [{ name: "runa-native-bridge", versionInfo: "0.1.0" }],
  };
  const sbomBytes = jsonBytes(sbom);
  const sbomSha256 = sha256(sbomBytes);
  const provenance = {
    schema: "runa.native-bridge-provenance.v1",
    releaseEligible: true,
    subject: { file: "runa-native-bridge.exe", sha256: binarySha256 },
    build: {
      packageVersion: "0.1.0",
      nativeVersion: "0.1.0",
      platform: "win32",
      architecture: "x64",
    },
    sbom: { file: "runa-native-bridge.spdx.json", sha256: sbomSha256 },
    signature: {
      status: "verified",
      kind: "authenticode",
      publisherCertificateFingerprint: fingerprint,
    },
  };
  const provenanceBytes = jsonBytes(provenance);
  const manifest = {
    schema: "runa.native-bridge-manifest.v1",
    releaseStatus: "production-signed",
    protocol: "runa.native-bridge.v1",
    platform: "win32",
    architecture: "x64",
    packageVersion: "0.1.0",
    nativeVersion: "0.1.0",
    fileVersion: "0.1.0.0",
    executableFile: "runa-native-bridge.exe",
    maximumCredentialBytes: 2_560,
    binarySha256,
    sbom: { file: "runa-native-bridge.spdx.json", sha256: sbomSha256 },
    provenance: { file: "runa-native-bridge.provenance.json", sha256: sha256(provenanceBytes) },
    signature: { kind: "authenticode", publisherCertificateFingerprint: fingerprint },
  };
  const manifestBytes = jsonBytes(manifest);
  await Promise.all([
    writeFile(path.join(root, "runa-native-bridge.exe"), binary),
    writeFile(path.join(root, "runa-native-bridge.spdx.json"), sbomBytes),
    writeFile(path.join(root, "runa-native-bridge.provenance.json"), provenanceBytes),
    writeFile(path.join(root, "runa-native-bridge.manifest.json"), manifestBytes),
  ]);
  return {
    root,
    binarySha256,
    trust: {
      schema: "runa.native-bridge-trust.v1",
      installRoot: root,
      manifestSha256: sha256(manifestBytes),
      platform: "win32",
      architecture: "x64",
      protocol: "runa.native-bridge.v1",
      packageVersion: "0.1.0",
      nativeVersion: "0.1.0",
      fileVersion: "0.1.0.0",
      signature: { kind: "authenticode", publisherCertificateFingerprint: fingerprint },
    },
  };
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isUnverified(error) {
  return error instanceof CredentialBoundaryError && error.code === "credential_backend_unverified";
}
