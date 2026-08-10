import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, normalize } from "node:path";
import { lstat, open, realpath } from "node:fs/promises";

import { credentialFailure } from "./errors.js";
import {
  createAdmittedNativeBrowserOwnedBridge,
  createAdmittedNativeCredentialOwnedBridge,
  type NativeBridgeSignatureAuthority,
  type NativeBridgeSignatureObservation,
  type NativeBridgeTrustPolicy,
} from "./native-admission.js";
import {
  type NativeBridgeDescriptor,
  type NativeBrowserProcessBridge,
  type NativeOwnedBridgeExchangeAuthority,
  type NativeOwnedBridgeExchangeResult,
} from "./native-process-bridge.js";
import {
  NATIVE_PLATFORM_RELEASE_INDEX,
  type NativePlatformReleaseEntry,
} from "./native-platform-release-index.js";
import type { NativeCredentialBridge } from "./contracts.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const MAXIMUM_PACKAGE_JSON_BYTES = 16 * 1024;
const MAXIMUM_AUTHORITY_ADDON_BYTES = 32 * 1024 * 1024;
const PACKAGE_KEYS = ["name", "version", "description", "license", "os", "cpu", "files", "exports"] as const;

interface NativeAuthorityAddon {
  verifySignature(input: {
    readonly executable: string;
    readonly platform: "win32" | "darwin";
    readonly architecture: "x64" | "arm64";
  }): NativeBridgeSignatureObservation;
  exchange(input: {
    readonly expected: NativeBridgeDescriptor;
    readonly request: Uint8Array;
    readonly timeoutMs: number;
    readonly maximumOutputBytes: number;
  }): NativeOwnedBridgeExchangeResult;
}

export interface ProductionNativeAuthBridges {
  readonly platform: "win32" | "darwin";
  readonly architecture: "x64" | "arm64";
  readonly packageName: NativePlatformReleaseEntry["packageName"];
  readonly packageVersion: string;
  readonly credentialBridge: NativeCredentialBridge;
  readonly browserBridge: NativeBrowserProcessBridge;
}

/**
 * Resolve the exact admitted platform package for production authentication.
 * Linux intentionally returns undefined because Secret Service and xdg-open
 * are owned by their separate adapters. Windows/macOS never fall back.
 */
export async function createProductionNativeAuthBridges(input: {
  readonly runtimePlatform?: NodeJS.Platform;
  readonly runtimeArchitecture?: NodeJS.Architecture;
} = {}): Promise<ProductionNativeAuthBridges | undefined> {
  const platform = input.runtimePlatform ?? process.platform;
  const architecture = input.runtimeArchitecture ?? process.arch;
  if (platform === "linux") return undefined;
  if ((platform !== "win32" && platform !== "darwin") ||
      (architecture !== "x64" && architecture !== "arm64")) {
    throw unavailable("This platform has no admitted native authentication package.");
  }

  const entry = NATIVE_PLATFORM_RELEASE_INDEX.find((candidate) =>
    candidate.platform === platform && candidate.architecture === architecture
  );
  if (entry === undefined) {
    throw unavailable("The signed native authentication package is not admitted for this release.");
  }
  validateReleaseEntry(entry, platform, architecture);

  const packageJsonPath = resolvePlatformPackage(entry.packageName);
  const packageRoot = dirname(packageJsonPath);
  const addonPath = join(packageRoot, entry.authorityAddonFile);
  const [packageJsonBytes, addonSha256] = await Promise.all([
    readBoundedCanonicalRegularFile(packageJsonPath, MAXIMUM_PACKAGE_JSON_BYTES),
    sha256CanonicalRegularFile(addonPath, MAXIMUM_AUTHORITY_ADDON_BYTES),
  ]);
  try {
    if (sha256(packageJsonBytes) !== entry.packageJsonSha256 || addonSha256 !== entry.authorityAddonSha256) {
      throw unavailable("The installed native authentication package identity does not match this release.");
    }
    validatePackageJson(packageJsonBytes, entry);
  } finally {
    packageJsonBytes.fill(0);
  }

  // Loading occurs only after the main package's immutable release index has
  // independently bound the addon's exact bytes. The addon is not allowed to
  // choose or self-describe its own identity.
  const addon = loadAuthorityAddon(addonPath);
  const signatureAuthority = createSignatureAuthority(addon);
  const authority = createOwnedExchangeAuthority(addon, platform);
  const trust: NativeBridgeTrustPolicy = Object.freeze({
    schema: "cuna.native-bridge-trust.v1",
    installRoot: normalize(packageRoot),
    manifestSha256: entry.manifestSha256,
    platform,
    architecture,
    protocol: "cuna.native-bridge.v1",
    packageVersion: entry.packageVersion,
    nativeVersion: entry.nativeVersion,
    fileVersion: entry.fileVersion,
    signature: entry.signature,
  });
  const common = {
    trust,
    signatureAuthority,
    authority,
    runtimePlatform: platform,
    runtimeArchitecture: architecture,
  } as const;
  const [credentialBridge, browserBridge] = await Promise.all([
    createAdmittedNativeCredentialOwnedBridge(common),
    createAdmittedNativeBrowserOwnedBridge(common),
  ]);
  return Object.freeze({
    platform,
    architecture,
    packageName: entry.packageName,
    packageVersion: entry.packageVersion,
    credentialBridge,
    browserBridge,
  });
}

function resolvePlatformPackage(packageName: NativePlatformReleaseEntry["packageName"]): string {
  try {
    return createRequire(import.meta.url).resolve(`${packageName}/package.json`);
  } catch {
    throw unavailable("The required signed native authentication package is not installed.");
  }
}

function loadAuthorityAddon(file: string): NativeAuthorityAddon {
  let value: unknown;
  try {
    value = createRequire(import.meta.url)(file);
  } catch {
    throw unavailable("The admitted native authentication authority could not be loaded.");
  }
  if (!isRecord(value) || typeof value.verifySignature !== "function" ||
      typeof value.exchange !== "function") {
    throw unavailable("The native authentication authority protocol is incompatible.");
  }
  return value as unknown as NativeAuthorityAddon;
}

function createSignatureAuthority(addon: NativeAuthorityAddon): NativeBridgeSignatureAuthority {
  return Object.freeze({
    verify: async (input: Parameters<NativeBridgeSignatureAuthority["verify"]>[0]) => {
      let observation: NativeBridgeSignatureObservation;
      try {
        observation = addon.verifySignature(input);
      } catch {
        throw unavailable("The operating system could not verify the native bridge signature.");
      }
      return observation;
    },
  });
}

function createOwnedExchangeAuthority(
  addon: NativeAuthorityAddon,
  platform: "win32" | "darwin",
): NativeOwnedBridgeExchangeAuthority {
  return Object.freeze({
    platform,
    authorityKind: platform === "win32" ? "windows-owned-process-spawn" : "darwin-owned-process-spawn",
    exchange: async (
      input: Parameters<NativeOwnedBridgeExchangeAuthority["exchange"]>[0],
    ): Promise<NativeOwnedBridgeExchangeResult> => {
      let result: NativeOwnedBridgeExchangeResult;
      try {
        result = addon.exchange(input);
      } catch {
        throw unavailable("The native authority could not complete an owned-process exchange.");
      }
      return result;
    },
  });
}

function validateReleaseEntry(
  entry: NativePlatformReleaseEntry,
  platform: "win32" | "darwin",
  architecture: "x64" | "arm64",
): void {
  const expectedPackage = platform === "win32"
    ? "@cuna_labs/cli-native-win32-x64"
    : architecture === "x64"
      ? "@cuna_labs/cli-native-darwin-x64"
      : "@cuna_labs/cli-native-darwin-arm64";
  if (entry.packageName !== expectedPackage || entry.platform !== platform ||
      entry.architecture !== architecture || !SHA256.test(entry.packageJsonSha256) ||
      !SHA256.test(entry.authorityAddonSha256) || !SHA256.test(entry.manifestSha256)) {
    throw unavailable("The native authentication release index is invalid.");
  }
}

function validatePackageJson(bytes: Uint8Array, entry: NativePlatformReleaseEntry): void {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw unavailable("The native authentication package manifest is invalid.");
  }
  if (!isRecord(value) || !hasOnlyKeys(value, PACKAGE_KEYS) || value.name !== entry.packageName ||
      value.version !== entry.packageVersion || value.license !== "Apache-2.0" ||
      !Array.isArray(value.os) || value.os.length !== 1 || value.os[0] !== entry.platform ||
      !Array.isArray(value.cpu) || value.cpu.length !== 1 || value.cpu[0] !== entry.architecture ||
      !Array.isArray(value.files) || !sameStrings(value.files, platformPackageFiles(entry.platform)) ||
      !isRecord(value.exports) || value.exports["./package.json"] !== "./package.json") {
    throw unavailable("The native authentication package manifest is not admitted.");
  }
}

function platformPackageFiles(platform: "win32" | "darwin"): readonly string[] {
  return [
    "cuna-native-authority.node",
    platform === "win32" ? "cuna-native-bridge.exe" : "cuna-native-bridge",
    "cuna-native-bridge.manifest.json",
    "cuna-native-bridge.spdx.json",
    "cuna-native-bridge.provenance.json",
  ];
}

async function readBoundedCanonicalRegularFile(file: string, maximumBytes: number): Promise<Buffer> {
  const before = await lstat(file).catch(() => undefined);
  if (before === undefined || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      before.size > maximumBytes) throw unavailable("A native package file is not a bounded regular file.");
  if (normalize(await realpath(file)) !== normalize(file)) {
    throw unavailable("A native package file does not have a canonical path.");
  }
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
    if (offset !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      bytes.fill(0);
      throw unavailable("A native package file changed while it was being admitted.");
    }
    return bytes;
  } catch (error) {
    bytes.fill(0);
    throw error;
  } finally {
    await handle.close();
  }
}

async function sha256CanonicalRegularFile(file: string, maximumBytes: number): Promise<string> {
  const bytes = await readBoundedCanonicalRegularFile(file, maximumBytes);
  try {
    return sha256(bytes);
  } finally {
    bytes.fill(0);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return actual.length === allowed.length && actual.every((key, index) => key === allowed[index]);
}

function sameStrings(value: unknown[], expected: readonly string[]): boolean {
  return value.length === expected.length &&
    value.every((item, index) => typeof item === "string" && item === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable(message: string) {
  return credentialFailure("credential_backend_unverified", message);
}
