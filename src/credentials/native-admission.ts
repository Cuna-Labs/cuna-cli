import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";

import type { NativeCredentialBridge } from "./contracts.js";
import { credentialFailure } from "./errors.js";
import {
  createNativeBrowserProcessBridge,
  createNativeBrowserOwnedProcessBridge,
  createNativeCredentialProcessBridge,
  createNativeCredentialOwnedProcessBridge,
  type NativeBridgeDescriptor,
  type NativeBridgeInvocationVerifier,
  type NativeBrowserProcessBridge,
  type NativeChildIdentityAuthority,
  type NativeOwnedBridgeExchangeAuthority,
} from "./native-process-bridge.js";
import type { SecureProcessRunner } from "./process-runner.js";

const MANIFEST_FILE = "cuna-native-bridge.manifest.json";
const MANIFEST_SCHEMA = "cuna.native-bridge-manifest.v1";
const PROVENANCE_SCHEMA = "cuna.native-bridge-provenance.v1";
const TRUST_SCHEMA = "cuna.native-bridge-trust.v1";
const MAXIMUM_MANIFEST_BYTES = 64 * 1024;
const MAXIMUM_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAXIMUM_BINARY_BYTES = 32 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const FINGERPRINT = /^[0-9A-F]{40,128}$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const FILE_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

type SupportedPlatform = "win32" | "darwin";
type SupportedArchitecture = "x64" | "arm64";
type SignatureKind = "authenticode" | "developer_id_notarized";

export interface NativeBridgeTrustPolicy {
  readonly schema: typeof TRUST_SCHEMA;
  readonly installRoot: string;
  readonly manifestSha256: string;
  readonly platform: SupportedPlatform;
  readonly architecture: SupportedArchitecture;
  readonly protocol: "cuna.native-bridge.v1";
  readonly packageVersion: string;
  readonly nativeVersion: string;
  readonly fileVersion: string;
  readonly signature: {
    readonly kind: SignatureKind;
    readonly publisherCertificateFingerprint: string;
  };
}

export interface NativeBridgeSignatureObservation {
  readonly valid: boolean;
  readonly locationProtected: boolean;
  readonly binarySha256: string;
  readonly fileVersion: string;
  readonly kind: SignatureKind;
  readonly publisherCertificateFingerprint: string;
}

export interface NativeBridgeSignatureAuthority {
  /** Verify the OS-native signature, version resource, and install-root ACL for this exact file. */
  verify(input: {
    readonly executable: string;
    readonly platform: SupportedPlatform;
    readonly architecture: SupportedArchitecture;
  }): Promise<NativeBridgeSignatureObservation>;
}

export interface AdmittedNativeBridge {
  readonly descriptor: NativeBridgeDescriptor;
  readonly verifier: NativeBridgeInvocationVerifier;
}

interface NativeBridgeManifest {
  readonly schema: typeof MANIFEST_SCHEMA;
  readonly releaseStatus: "production-signed";
  readonly protocol: "cuna.native-bridge.v1";
  readonly platform: SupportedPlatform;
  readonly architecture: SupportedArchitecture;
  readonly packageVersion: string;
  readonly nativeVersion: string;
  readonly fileVersion: string;
  readonly executableFile: string;
  readonly maximumCredentialBytes: number;
  readonly binarySha256: string;
  readonly sbom: { readonly file: string; readonly sha256: string };
  readonly provenance: { readonly file: string; readonly sha256: string };
  readonly signature: {
    readonly kind: SignatureKind;
    readonly publisherCertificateFingerprint: string;
  };
}

export async function discoverAdmittedNativeBridge(input: {
  readonly trust: NativeBridgeTrustPolicy;
  readonly signatureAuthority?: NativeBridgeSignatureAuthority;
  readonly runtimePlatform?: NodeJS.Platform;
  readonly runtimeArchitecture?: NodeJS.Architecture;
}): Promise<AdmittedNativeBridge> {
  const runtimePlatform = input.runtimePlatform ?? process.platform;
  const runtimeArchitecture = input.runtimeArchitecture ?? process.arch;
  validateTrust(input.trust, runtimePlatform, runtimeArchitecture);
  const signatureAuthority = input.signatureAuthority;
  if (signatureAuthority === undefined) throw unverified();

  const descriptor = await verifyInstalledSnapshot(input.trust, signatureAuthority);
  const verifier: NativeBridgeInvocationVerifier = Object.freeze({
    verify: async (expected: NativeBridgeDescriptor) => {
      const observed = await verifyInstalledSnapshot(input.trust, signatureAuthority);
      if (!sameDescriptor(expected, observed)) throw unverified();
    },
  });
  return Object.freeze({ descriptor, verifier });
}

export async function createAdmittedNativeCredentialBridge(input: {
  readonly trust: NativeBridgeTrustPolicy;
  readonly signatureAuthority?: NativeBridgeSignatureAuthority;
  readonly childIdentityAuthority: NativeChildIdentityAuthority;
  readonly runner?: SecureProcessRunner;
  readonly runtimePlatform?: NodeJS.Platform;
  readonly runtimeArchitecture?: NodeJS.Architecture;
}): Promise<NativeCredentialBridge> {
  const admitted = await discoverAdmittedNativeBridge(input);
  return createNativeCredentialProcessBridge({
    descriptor: admitted.descriptor,
    verifier: admitted.verifier,
    childIdentityAuthority: input.childIdentityAuthority,
    ...(input.runner === undefined ? {} : { runner: input.runner }),
    ...(input.runtimePlatform === undefined ? {} : { runtimePlatform: input.runtimePlatform }),
    ...(input.runtimeArchitecture === undefined
      ? {}
      : { runtimeArchitecture: input.runtimeArchitecture }),
  });
}

export async function createAdmittedNativeBrowserBridge(input: {
  readonly trust: NativeBridgeTrustPolicy;
  readonly signatureAuthority?: NativeBridgeSignatureAuthority;
  readonly childIdentityAuthority: NativeChildIdentityAuthority;
  readonly runner?: SecureProcessRunner;
  readonly runtimePlatform?: NodeJS.Platform;
  readonly runtimeArchitecture?: NodeJS.Architecture;
}): Promise<NativeBrowserProcessBridge> {
  const admitted = await discoverAdmittedNativeBridge(input);
  return createNativeBrowserProcessBridge({
    descriptor: admitted.descriptor,
    verifier: admitted.verifier,
    childIdentityAuthority: input.childIdentityAuthority,
    ...(input.runner === undefined ? {} : { runner: input.runner }),
    ...(input.runtimePlatform === undefined ? {} : { runtimePlatform: input.runtimePlatform }),
    ...(input.runtimeArchitecture === undefined
      ? {}
      : { runtimeArchitecture: input.runtimeArchitecture }),
  });
}

export async function createAdmittedNativeCredentialOwnedBridge(input: {
  readonly trust: NativeBridgeTrustPolicy;
  readonly signatureAuthority?: NativeBridgeSignatureAuthority;
  readonly authority: NativeOwnedBridgeExchangeAuthority;
  readonly runtimePlatform?: NodeJS.Platform;
  readonly runtimeArchitecture?: NodeJS.Architecture;
}): Promise<NativeCredentialBridge> {
  const admitted = await discoverAdmittedNativeBridge(input);
  return createNativeCredentialOwnedProcessBridge({
    descriptor: admitted.descriptor,
    verifier: admitted.verifier,
    authority: input.authority,
    ...(input.runtimePlatform === undefined ? {} : { runtimePlatform: input.runtimePlatform }),
    ...(input.runtimeArchitecture === undefined
      ? {}
      : { runtimeArchitecture: input.runtimeArchitecture }),
  });
}

export async function createAdmittedNativeBrowserOwnedBridge(input: {
  readonly trust: NativeBridgeTrustPolicy;
  readonly signatureAuthority?: NativeBridgeSignatureAuthority;
  readonly authority: NativeOwnedBridgeExchangeAuthority;
  readonly runtimePlatform?: NodeJS.Platform;
  readonly runtimeArchitecture?: NodeJS.Architecture;
}): Promise<NativeBrowserProcessBridge> {
  const admitted = await discoverAdmittedNativeBridge(input);
  return createNativeBrowserOwnedProcessBridge({
    descriptor: admitted.descriptor,
    verifier: admitted.verifier,
    authority: input.authority,
    ...(input.runtimePlatform === undefined ? {} : { runtimePlatform: input.runtimePlatform }),
    ...(input.runtimeArchitecture === undefined
      ? {}
      : { runtimeArchitecture: input.runtimeArchitecture }),
  });
}

async function verifyInstalledSnapshot(
  trust: NativeBridgeTrustPolicy,
  signatureAuthority: NativeBridgeSignatureAuthority,
): Promise<NativeBridgeDescriptor> {
  const pathAuthority = trust.platform === "win32" ? win32 : posix;
  const manifestPath = pathAuthority.join(trust.installRoot, MANIFEST_FILE);
  const manifestBytes = await readBoundedRegularFile(manifestPath, MAXIMUM_MANIFEST_BYTES, trust.platform);
  try {
    if (sha256(manifestBytes) !== trust.manifestSha256) throw unverified();
    const manifest = parseManifest(manifestBytes, trust);
    const executable = pathAuthority.join(trust.installRoot, manifest.executableFile);
    const sbomPath = pathAuthority.join(trust.installRoot, manifest.sbom.file);
    const provenancePath = pathAuthority.join(trust.installRoot, manifest.provenance.file);
    const [binarySha256, sbomBytes, provenanceBytes, signature] = await Promise.all([
      sha256RegularFile(executable, MAXIMUM_BINARY_BYTES, trust.platform),
      readBoundedRegularFile(sbomPath, MAXIMUM_EVIDENCE_BYTES, trust.platform),
      readBoundedRegularFile(provenancePath, MAXIMUM_EVIDENCE_BYTES, trust.platform),
      signatureAuthority.verify({
        executable,
        platform: trust.platform,
        architecture: trust.architecture,
      }),
    ]);
    try {
      if (
        binarySha256 !== manifest.binarySha256 ||
        sha256(sbomBytes) !== manifest.sbom.sha256 ||
        sha256(provenanceBytes) !== manifest.provenance.sha256
      ) {
        throw unverified();
      }
      verifySbom(sbomBytes, manifest);
      verifyProvenance(provenanceBytes, manifest);
      verifySignatureObservation(signature, manifest);
      return Object.freeze({
        protocol: manifest.protocol,
        platform: manifest.platform,
        architecture: manifest.architecture,
        packageVersion: manifest.packageVersion,
        nativeVersion: manifest.nativeVersion,
        fileVersion: manifest.fileVersion,
        executable,
        workingDirectory: pathAuthority.normalize(trust.installRoot),
        manifestPath,
        maximumCredentialBytes: manifest.maximumCredentialBytes,
        binarySha256,
        manifestSha256: trust.manifestSha256,
        sbomSha256: manifest.sbom.sha256,
        provenanceSha256: manifest.provenance.sha256,
        signature: manifest.signature,
      });
    } finally {
      sbomBytes.fill(0);
      provenanceBytes.fill(0);
    }
  } finally {
    manifestBytes.fill(0);
  }
}

function validateTrust(
  trust: NativeBridgeTrustPolicy,
  runtimePlatform: NodeJS.Platform,
  runtimeArchitecture: NodeJS.Architecture,
): void {
  const pathAuthority = trust.platform === "win32" ? win32 : posix;
  if (
    trust.schema !== TRUST_SCHEMA ||
    trust.platform !== runtimePlatform ||
    trust.architecture !== runtimeArchitecture ||
    !pathAuthority.isAbsolute(trust.installRoot) ||
    pathAuthority.normalize(trust.installRoot) !== trust.installRoot ||
    trust.installRoot.includes("\0") ||
    trust.protocol !== "cuna.native-bridge.v1" ||
    !VERSION.test(trust.packageVersion) ||
    !VERSION.test(trust.nativeVersion) ||
    !FILE_VERSION.test(trust.fileVersion) ||
    !SHA256.test(trust.manifestSha256) ||
    !FINGERPRINT.test(trust.signature.publisherCertificateFingerprint) ||
    expectedSignatureKind(trust.platform) !== trust.signature.kind
  ) {
    throw unverified();
  }
}

function parseManifest(bytes: Uint8Array, trust: NativeBridgeTrustPolicy): NativeBridgeManifest {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw unverified();
  }
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "schema", "releaseStatus", "protocol", "platform", "architecture", "packageVersion",
    "nativeVersion", "fileVersion", "executableFile", "maximumCredentialBytes", "binarySha256",
    "sbom", "provenance", "signature",
  ])) throw unverified();
  const sbom = value.sbom;
  const provenance = value.provenance;
  const signature = value.signature;
  if (
    !isRecord(sbom) || !hasOnlyKeys(sbom, ["file", "sha256"]) ||
    !isRecord(provenance) || !hasOnlyKeys(provenance, ["file", "sha256"]) ||
    !isRecord(signature) || !hasOnlyKeys(signature, ["kind", "publisherCertificateFingerprint"]) ||
    value.schema !== MANIFEST_SCHEMA ||
    value.releaseStatus !== "production-signed" ||
    value.protocol !== trust.protocol ||
    value.platform !== trust.platform ||
    value.architecture !== trust.architecture ||
    value.packageVersion !== trust.packageVersion ||
    value.nativeVersion !== trust.nativeVersion ||
    value.fileVersion !== trust.fileVersion ||
    typeof value.executableFile !== "string" || !SAFE_FILE.test(value.executableFile) ||
    value.executableFile !== expectedExecutableFile(trust.platform) ||
    value.maximumCredentialBytes !== 2_560 ||
    typeof value.binarySha256 !== "string" || !SHA256.test(value.binarySha256) ||
    typeof sbom.file !== "string" || !SAFE_FILE.test(sbom.file) ||
    sbom.file !== "cuna-native-bridge.spdx.json" ||
    typeof sbom.sha256 !== "string" || !SHA256.test(sbom.sha256) ||
    typeof provenance.file !== "string" || !SAFE_FILE.test(provenance.file) ||
    provenance.file !== "cuna-native-bridge.provenance.json" ||
    typeof provenance.sha256 !== "string" || !SHA256.test(provenance.sha256) ||
    signature.kind !== trust.signature.kind ||
    signature.publisherCertificateFingerprint !== trust.signature.publisherCertificateFingerprint
  ) throw unverified();
  return value as unknown as NativeBridgeManifest;
}

function verifySbom(bytes: Uint8Array, manifest: NativeBridgeManifest): void {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw unverified();
  }
  if (!isRecord(value) || value.spdxVersion !== "SPDX-2.3" || value.dataLicense !== "CC0-1.0") {
    throw unverified();
  }
  if (!Array.isArray(value.packages) || !value.packages.some((entry) =>
    isRecord(entry) && entry.name === "cuna-native-bridge" && entry.versionInfo === manifest.nativeVersion
  )) throw unverified();
}

function verifyProvenance(bytes: Uint8Array, manifest: NativeBridgeManifest): void {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw unverified();
  }
  if (
    !isRecord(value) || value.schema !== PROVENANCE_SCHEMA || value.releaseEligible !== true ||
    !isRecord(value.subject) || value.subject.file !== manifest.executableFile ||
    value.subject.sha256 !== manifest.binarySha256 ||
    !isRecord(value.build) || value.build.packageVersion !== manifest.packageVersion ||
    value.build.nativeVersion !== manifest.nativeVersion || value.build.platform !== manifest.platform ||
    value.build.architecture !== manifest.architecture ||
    !isRecord(value.sbom) || value.sbom.file !== manifest.sbom.file ||
    value.sbom.sha256 !== manifest.sbom.sha256 ||
    !isRecord(value.signature) || value.signature.status !== "verified" ||
    value.signature.kind !== manifest.signature.kind ||
    value.signature.publisherCertificateFingerprint !== manifest.signature.publisherCertificateFingerprint
  ) throw unverified();
}

function verifySignatureObservation(
  observed: NativeBridgeSignatureObservation,
  manifest: NativeBridgeManifest,
): void {
  if (
    observed.valid !== true ||
    observed.locationProtected !== true ||
    observed.binarySha256 !== manifest.binarySha256 ||
    observed.fileVersion !== manifest.fileVersion ||
    observed.kind !== manifest.signature.kind ||
    observed.publisherCertificateFingerprint !== manifest.signature.publisherCertificateFingerprint
  ) throw unverified();
}

async function readBoundedRegularFile(
  file: string,
  maximumBytes: number,
  platform: SupportedPlatform,
): Promise<Buffer> {
  const before = await lstat(file).catch(() => undefined);
  if (before === undefined || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximumBytes) {
    throw unverified();
  }
  await assertCanonicalPath(file, platform);
  const handle = await open(file, "r");
  const bytes = Buffer.alloc(before.size);
  let offset = 0;
  try {
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || offset !== before.size
    ) {
      bytes.fill(0);
      throw unverified();
    }
    return bytes;
  } catch (error) {
    bytes.fill(0);
    throw error;
  } finally {
    await handle.close();
  }
}

async function sha256RegularFile(
  file: string,
  maximumBytes: number,
  platform: SupportedPlatform,
): Promise<string> {
  const before = await lstat(file).catch(() => undefined);
  if (before === undefined || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximumBytes) {
    throw unverified();
  }
  await assertCanonicalPath(file, platform);
  const handle = await open(file, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const digest = createHash("sha256");
  let offset = 0;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
      if (offset > maximumBytes) throw unverified();
    }
    const after = await handle.stat();
    if (
      after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || offset !== before.size
    ) throw unverified();
    return digest.digest("hex");
  } finally {
    buffer.fill(0);
    await handle.close();
  }
}

async function assertCanonicalPath(file: string, platform: SupportedPlatform): Promise<void> {
  const observed = await realpath(file).catch(() => undefined);
  if (observed === undefined || canonical(observed, platform) !== canonical(file, platform)) throw unverified();
}

function canonical(file: string, platform: SupportedPlatform): string {
  const normalized = platform === "win32" ? win32.normalize(file) : posix.normalize(file);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameDescriptor(left: NativeBridgeDescriptor, right: NativeBridgeDescriptor): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function expectedExecutableFile(platform: SupportedPlatform): string {
  return platform === "win32" ? "cuna-native-bridge.exe" : "cuna-native-bridge";
}

function expectedSignatureKind(platform: SupportedPlatform): SignatureKind {
  return platform === "win32" ? "authenticode" : "developer_id_notarized";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const observed = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return observed.length === allowed.length && observed.every((entry, index) => entry === allowed[index]);
}

function unverified() {
  return credentialFailure(
    "credential_backend_unverified",
    "The installed native bridge is not an admitted signed release artifact.",
  );
}
