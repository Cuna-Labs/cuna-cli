import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, normalize } from "node:path";
import { lstat, open, realpath } from "node:fs/promises";

import { credentialFailure } from "./errors.js";
import type { NativeBrowserProcessBridge } from "./native-process-bridge.js";
import {
  NATIVE_PLATFORM_RELEASE_INDEX,
  type NativePlatformReleaseEntry,
} from "./native-platform-release-index.js";
import type { NativeCredentialBridge } from "./contracts.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const MAXIMUM_PACKAGE_JSON_BYTES = 16 * 1024;
const MAXIMUM_AUTHORITY_ADDON_BYTES = 32 * 1024 * 1024;
const PACKAGE_KEYS = ["name", "version", "description", "license", "os", "cpu", "files", "exports"] as const;

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

  // A hash followed by `require(addonPath)` is not one atomic authority decision on Windows or
  // macOS: a writable package root can substitute the addon between admission and LoadLibrary,
  // and a malicious addon cannot be trusted to attest itself. Keep production unavailable until
  // an admitted signed loader owns the file handle and proves the loaded module identity (or the
  // process authority is embedded in the already admitted native bridge).
  throw unavailable(
    "The signed native module loader authority is not admitted for this release.",
  );
}

function resolvePlatformPackage(packageName: NativePlatformReleaseEntry["packageName"]): string {
  try {
    return createRequire(import.meta.url).resolve(`${packageName}/package.json`);
  } catch {
    throw unavailable("The required signed native authentication package is not installed.");
  }
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
  const handle = await open(file, "r").catch(() => {
    throw unavailable("A native package file is not a bounded regular file.");
  });
  let bytes: Buffer | undefined;
  try {
    const before = await handle.stat();
    const linked = await lstat(file).catch(() => undefined);
    if (!before.isFile() || before.nlink !== 1 || before.size > maximumBytes ||
        linked === undefined || !linked.isFile() || linked.isSymbolicLink() ||
        linked.dev !== before.dev || linked.ino !== before.ino) {
      throw unavailable("A native package file is not a bounded regular file.");
    }
    if (normalize(await realpath(file)) !== normalize(file)) {
      throw unavailable("A native package file does not have a canonical path.");
    }
    bytes = Buffer.alloc(before.size);
    let offset = 0;
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
    bytes?.fill(0);
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
