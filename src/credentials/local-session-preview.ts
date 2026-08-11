import { constants as fileConstants } from "node:fs";
import { mkdir, open, rename, unlink, lstat, realpath } from "node:fs/promises";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { dirname, resolve } from "node:path";

import {
  CREDENTIAL_BACKEND_PROTOCOL,
  type CredentialBackendEvidence,
  type SecureCredentialBackend,
} from "./contracts.js";
import { credentialFailure } from "./errors.js";

const FORMAT_VERSION = 1;
const MAX_FILE_BYTES = 96 * 1024;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MIN_PASSPHRASE_BYTES = 12;

interface PreviewRecord {
  readonly version: 1;
  readonly algorithm: "aes-256-gcm";
  readonly kdf: "scrypt";
  readonly salt: string;
  readonly nonce: string;
  readonly tag: string;
  readonly ciphertext: string;
}

/**
 * A deliberately non-native credential backend for preview validation.
 *
 * It encrypts the CredentialVault envelope with a passphrase, but it cannot
 * prove hardware/OS isolation. The `preview` evidence class is therefore
 * rejected by a normal CredentialVault and must be opted into explicitly.
 */
export class LocalSessionPreviewBackend implements SecureCredentialBackend {
  readonly backendId = "cuna-local-session-preview-v1";
  readonly platform: NodeJS.Platform;
  readonly #filePath: string;
  readonly #passphrase: string;
  readonly #clock: () => number;

  constructor(input: {
    readonly filePath: string;
    readonly passphrase: string;
    readonly platform: NodeJS.Platform;
    readonly clock?: () => number;
  }) {
    if (typeof input.passphrase !== "string") {
      throw credentialFailure(
        "credential_backend_unverified",
        "The preview session passphrase is invalid.",
      );
    }
    const passphraseBytes = Buffer.byteLength(input.passphrase, "utf8");
    if (
      Array.from(input.passphrase).length < MIN_PASSPHRASE_BYTES ||
      passphraseBytes > 512 ||
      hasForbiddenControl(input.passphrase) ||
      hasUnpairedSurrogate(input.passphrase)
    ) {
      throw credentialFailure(
        "credential_backend_unverified",
        "The preview session passphrase is invalid.",
      );
    }
    const filePath = resolve(input.filePath);
    if (!filePath.endsWith(".json")) {
      throw credentialFailure("credential_backend_unverified", "The preview session path is invalid.");
    }
    this.#filePath = filePath;
    this.#passphrase = input.passphrase;
    this.platform = input.platform;
    this.#clock = input.clock ?? Date.now;
  }

  async probe(): Promise<CredentialBackendEvidence> {
    const now = this.#trustedNow();
    try {
      await this.#ensureDirectory();
      await this.#assertSafeFile();
    } catch (error) {
      if (this.#isMissing(error)) {
        return this.#evidence(now);
      }
      return this.#evidence(now, "preview_file_unsafe");
    }
    return this.#evidence(now);
  }

  async read(_target: string): Promise<Uint8Array | undefined> {
    let encoded: Uint8Array;
    try {
      encoded = await this.#readSafeFile();
    } catch (error) {
      if (this.#isMissing(error)) return undefined;
      throw credentialFailure("credential_corrupt", "The encrypted preview session cannot be read.", { cause: error });
    }
    try {
      return this.#decrypt(encoded);
    } finally {
      encoded.fill(0);
    }
  }

  async replace(_target: string, protectedValue: Uint8Array): Promise<void> {
    if (protectedValue.byteLength < 1 || protectedValue.byteLength > 32 * 1024) {
      throw credentialFailure("credential_corrupt", "The preview session payload is invalid.");
    }
    const record = this.#encrypt(protectedValue);
    const directory = await this.#ensureDirectory();
    const directoryIdentity = await this.#directoryIdentity();
    const temporary = `${this.#filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, fileConstants.O_WRONLY | fileConstants.O_CREAT | fileConstants.O_EXCL, 0o600);
      await handle.writeFile(JSON.stringify(record), { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.#assertDirectoryIdentity(directoryIdentity);
      await rename(temporary, this.#filePath);
      await this.#assertDirectoryIdentity(directoryIdentity);
      try {
        const directoryHandle = await open(directory, fileConstants.O_RDONLY);
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      } catch { /* Windows does not expose directory fsync; preview remains non-GA. */ }
    } catch (error) {
      try { await handle?.close(); } catch { /* best effort cleanup */ }
      try { await unlink(temporary); } catch { /* best effort cleanup */ }
      throw credentialFailure("credential_backend_failure", "The encrypted preview session could not be replaced.", { retryable: true, cause: error });
    }
  }

  async delete(_target: string): Promise<"deleted" | "absent"> {
    try {
      const directoryIdentity = await this.#directoryIdentity();
      await this.#assertDirectoryIdentity(directoryIdentity);
      await unlink(this.#filePath);
      await this.#assertDirectoryIdentity(directoryIdentity);
      return "deleted";
    } catch (error) {
      if (this.#isMissing(error)) return "absent";
      throw credentialFailure("credential_backend_failure", "The encrypted preview session could not be removed.", { retryable: true, cause: error });
    }
  }

  #trustedNow(): number {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw credentialFailure("credential_backend_unverified", "The preview session clock is not trustworthy.");
    }
    return now;
  }

  #evidence(now: number, reason?: string): CredentialBackendEvidence {
    return {
      protocol: CREDENTIAL_BACKEND_PROTOCOL,
      backendId: this.backendId,
      platform: this.platform,
      status: "preview",
      observedAt: now,
      expiresAt: now + 60_000,
      source: "local_file_preview",
      ...(reason === undefined ? {} : { reason }),
    };
  }

  async #assertSafeFile(): Promise<void> {
    await this.#assertSafeDirectory();
    const metadata = await lstat(this.#filePath);
    if (!metadata.isFile()) throw new Error("preview session is not a regular file");
    if (metadata.size > MAX_FILE_BYTES) throw new Error("preview session is oversized");
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error("preview session permissions are too broad");
    }
  }

  async #readSafeFile(): Promise<Uint8Array> {
    await this.#assertSafeDirectory();
    const directoryIdentity = await this.#directoryIdentity();
    const flags = fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0);
    const handle = await open(this.#filePath, flags);
    try {
      const metadata = await handle.stat();
      const pathMetadata = await lstat(this.#filePath);
      if (
        !metadata.isFile() || metadata.size > MAX_FILE_BYTES ||
        (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) ||
        !pathMetadata.isFile() ||
        metadata.size !== pathMetadata.size || metadata.mtimeMs !== pathMetadata.mtimeMs ||
        (pathMetadata.ino !== 0 && metadata.ino !== 0 && pathMetadata.ino !== metadata.ino)
      ) throw new Error("preview session file changed while opening");
      const bytes = new Uint8Array(await handle.readFile());
      await this.#assertDirectoryIdentity(directoryIdentity);
      return bytes;
    } finally {
      await handle.close();
    }
  }

  #deriveKey(salt: Uint8Array): Buffer {
    return scryptSync(this.#passphrase, salt, KEY_BYTES, {
      N: 1 << 15,
      r: 8,
      p: 1,
      maxmem: 128 * 1024 * 1024,
    });
  }

  async #ensureDirectory(): Promise<string> {
    const directory = dirname(this.#filePath);
    const missing: string[] = [];
    let current = directory;
    while (true) {
      try {
        const metadata = await lstat(current);
        if (!metadata.isDirectory()) throw new Error("preview session parent is not a directory");
        if (metadata.isSymbolicLink()) throw new Error("preview session parent is a symlink");
        break;
      } catch (error) {
        if (!this.#isMissing(error)) throw error;
        missing.push(current);
        const parent = dirname(current);
        if (parent === current) throw new Error("preview session parent cannot be resolved");
        current = parent;
      }
    }
    for (const path of missing.reverse()) {
      await mkdir(path, { mode: 0o700 });
      const metadata = await lstat(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("preview session parent changed while creating");
    }
    await this.#assertSafeDirectory();
    return directory;
  }

  async #assertSafeDirectory(): Promise<void> {
    const directory = dirname(this.#filePath);
    const leaf = await lstat(directory);
    if (!leaf.isDirectory() || leaf.isSymbolicLink()) throw new Error("preview session parent is unsafe");
    if (process.platform !== "win32") {
      if ((leaf.mode & 0o022) !== 0) throw new Error("preview session parent permissions are too broad");
      if (typeof process.getuid === "function" && leaf.uid !== process.getuid()) {
        throw new Error("preview session parent has the wrong owner");
      }
    }
    let current = directory;
    while (true) {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("preview session ancestor is unsafe");
      const isStickyDirectory = (metadata.mode & 0o1000) !== 0;
      if (process.platform !== "win32" && (metadata.mode & 0o022) !== 0 && !isStickyDirectory) {
        throw new Error("preview session ancestor permissions are too broad");
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  async #directoryIdentity(): Promise<readonly DirectoryIdentity[]> {
    const result: DirectoryIdentity[] = [];
    let current = dirname(this.#filePath);
    while (true) {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("preview session directory is unsafe");
      result.push({
        path: current,
        canonical: await realpath(current),
        dev: metadata.dev,
        ino: metadata.ino,
      });
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return result;
  }

  async #assertDirectoryIdentity(expected: readonly DirectoryIdentity[]): Promise<void> {
    const actual = await this.#directoryIdentity();
    if (actual.length !== expected.length) throw new Error("preview session directory changed");
    for (let index = 0; index < expected.length; index += 1) {
      const before = expected[index]!;
      const after = actual[index]!;
      if (
        before.path !== after.path || before.canonical !== after.canonical ||
        (before.dev !== 0 && after.dev !== 0 && before.dev !== after.dev) ||
        (before.ino !== 0 && after.ino !== 0 && before.ino !== after.ino)
      ) throw new Error("preview session directory changed");
    }
  }

  #encrypt(plain: Uint8Array): PreviewRecord {
    const salt = randomBytes(SALT_BYTES);
    const nonce = randomBytes(NONCE_BYTES);
    const key = this.#deriveKey(salt);
    try {
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
      const tag = cipher.getAuthTag();
      return {
        version: FORMAT_VERSION,
        algorithm: "aes-256-gcm",
        kdf: "scrypt",
        salt: salt.toString("base64url"),
        nonce: nonce.toString("base64url"),
        tag: tag.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      };
    } finally {
      key.fill(0);
    }
  }

  #decrypt(encoded: Uint8Array): Uint8Array {
    if (encoded.byteLength > MAX_FILE_BYTES) throw new Error("preview session is oversized");
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)); } catch (error) {
      throw credentialFailure("credential_corrupt", "The encrypted preview session is malformed.", { cause: error });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw credentialFailure("credential_corrupt", "The encrypted preview session is malformed.");
    }
    const record = parsed as Record<string, unknown>;
    const expectedKeys = ["algorithm", "ciphertext", "kdf", "nonce", "salt", "tag", "version"];
    const keys = Object.keys(record).sort();
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
      throw credentialFailure("credential_corrupt", "The encrypted preview session shape is invalid.");
    }
    if (
      record.version !== FORMAT_VERSION || record.algorithm !== "aes-256-gcm" || record.kdf !== "scrypt" ||
      typeof record.salt !== "string" || typeof record.nonce !== "string" || typeof record.tag !== "string" ||
      typeof record.ciphertext !== "string"
    ) {
      throw credentialFailure("credential_corrupt", "The encrypted preview session metadata is invalid.");
    }
    const salt = Buffer.from(record.salt, "base64url");
    const nonce = Buffer.from(record.nonce, "base64url");
    const tag = Buffer.from(record.tag, "base64url");
    const ciphertext = Buffer.from(record.ciphertext, "base64url");
    if (salt.byteLength !== SALT_BYTES || nonce.byteLength !== NONCE_BYTES || tag.byteLength !== TAG_BYTES || ciphertext.byteLength < 1 || ciphertext.byteLength > 40 * 1024) {
      throw credentialFailure("credential_corrupt", "The encrypted preview session bytes are invalid.");
    }
    const key = this.#deriveKey(salt);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAuthTag(tag);
      return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
    } catch (error) {
      throw credentialFailure("credential_corrupt", "The preview session passphrase or authentication tag is invalid.", { cause: error });
    } finally {
      key.fill(0);
      salt.fill(0);
      nonce.fill(0);
      tag.fill(0);
      ciphertext.fill(0);
    }
  }

  #isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT";
  }
}

export function localSessionPreviewPath(configDirectory: string, profile = "default"): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile)) {
    throw credentialFailure("credential_backend_unverified", "The preview session profile is invalid.");
  }
  const profileDigest = createHash("sha256").update(profile, "utf8").digest("hex").slice(0, 32);
  return resolve(configDirectory, `session-preview-${profileDigest}.json`);
}

/**
 * Returns whether a preview record path is occupied.  This is only a mode
 * selector: the backend still re-checks the path, permissions, identity and
 * authenticated bytes before accepting anything.  In particular, an unsafe
 * existing path is reported as present so callers cannot silently fall back
 * to native credentials after a path attack or corruption.
 */
export async function previewSessionFileExists(filePath: string): Promise<boolean> {
  try {
    await lstat(resolve(filePath));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw credentialFailure(
      "credential_backend_unverified",
      "The encrypted preview session path cannot be inspected safely.",
      { cause: error },
    );
  }
}

function hasForbiddenControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

interface DirectoryIdentity {
  readonly path: string;
  readonly canonical: string;
  readonly dev: number;
  readonly ino: number;
}
