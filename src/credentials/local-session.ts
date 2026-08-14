import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

import { CREDENTIAL_BACKEND_PROTOCOL, type CredentialBackendEvidence, type SecureCredentialBackend } from "./contracts.js";
import { credentialFailure } from "./errors.js";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_SESSION_BYTES = 96 * 1024;
const execFileAsync = promisify(execFile);
const WINDOWS_SYSTEM32 = "C:\\Windows\\System32";

interface EncryptedRecord {
  readonly version: 1;
  readonly algorithm: "aes-256-gcm";
  readonly nonce: string;
  readonly tag: string;
  readonly ciphertext: string;
}

/**
 * Pure-JavaScript session persistence for the durable browser login code.
 * The random AES key and ciphertext are separate user-only files. This protects
 * against accidental disclosure, backups and other users; compromise of the
 * same OS account can read both files and defeats this layer.
 */
export class LocalEncryptedSessionBackend implements SecureCredentialBackend {
  readonly backendId = "cuna-local-aes256gcm-v1";
  readonly platform: NodeJS.Platform;
  readonly #sessionFile: string;
  readonly #keyFile: string;
  readonly #clock: () => number;

  constructor(input: { readonly sessionFile: string; readonly keyFile: string; readonly platform: NodeJS.Platform; readonly clock?: () => number }) {
    this.#sessionFile = exactJsonPath(input.sessionFile, "session");
    this.#keyFile = exactKeyPath(input.keyFile);
    if (this.#sessionFile === this.#keyFile || dirname(this.#sessionFile) !== dirname(this.#keyFile)) {
      throw credentialFailure("credential_backend_unverified", "The encrypted session paths are invalid.");
    }
    this.platform = input.platform;
    this.#clock = input.clock ?? Date.now;
  }

  async probe(): Promise<CredentialBackendEvidence> {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) throw credentialFailure("credential_backend_unverified", "The session clock is not trustworthy.");
    try {
      await this.#ensureDirectory();
      const key = await this.#loadOrCreateKey();
      key.fill(0);
      try { await this.#assertSafeIfPresent(this.#sessionFile, MAX_SESSION_BYTES); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      return evidence(this, now, "verified");
    } catch {
      return evidence(this, now, "unavailable", "encrypted_session_permissions_unverified");
    }
  }

  async read(_target: string): Promise<Uint8Array | undefined> {
    const key = await this.#loadOrCreateKey();
    let encoded: Buffer;
    try {
      await this.#assertSafeIfPresent(this.#sessionFile, MAX_SESSION_BYTES);
      encoded = await readFile(this.#sessionFile);
    } catch (error) {
      key.fill(0);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw credentialFailure("credential_corrupt", "The encrypted local session cannot be read.", { cause: error });
    }
    try {
      return decrypt(encoded, key);
    } finally {
      key.fill(0);
      encoded.fill(0);
    }
  }

  async replace(_target: string, protectedValue: Uint8Array): Promise<void> {
    if (protectedValue.byteLength < 1 || protectedValue.byteLength > 32 * 1024) {
      throw credentialFailure("credential_corrupt", "The encrypted session payload is invalid.");
    }
    const key = await this.#loadOrCreateKey();
    const record = encrypt(protectedValue, key);
    key.fill(0);
    await this.#writeRestricted(this.#sessionFile, Buffer.from(JSON.stringify(record), "utf8"));
  }

  async delete(_target: string): Promise<"deleted" | "absent"> {
    let deleted = false;
    for (const file of [this.#sessionFile, this.#keyFile]) {
      try {
        await unlink(file);
        deleted = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw credentialFailure("credential_backend_failure", "The encrypted local session could not be removed.", { retryable: true, cause: error });
        }
      }
    }
    return deleted ? "deleted" : "absent";
  }

  async #ensureDirectory(): Promise<void> {
    const directory = dirname(this.#sessionFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    if (this.platform === "win32") await hardenWindowsAcl(directory, true);
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (this.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw new Error("encrypted session directory is unsafe");
    }
  }

  async #loadOrCreateKey(): Promise<Buffer> {
    await this.#ensureDirectory();
    try {
      const handle = await open(this.#keyFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      const generated = randomBytes(KEY_BYTES);
      try { await handle.writeFile(generated); await handle.sync(); } finally { generated.fill(0); await handle.close(); }
      await chmod(this.#keyFile, 0o600);
      if (this.platform === "win32") await hardenWindowsAcl(this.#keyFile, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await this.#assertSafeIfPresent(this.#keyFile, KEY_BYTES);
    const key = await readFile(this.#keyFile);
    if (key.byteLength !== KEY_BYTES) { key.fill(0); throw credentialFailure("credential_corrupt", "The encrypted session key file is invalid."); }
    return key;
  }

  async #assertSafeIfPresent(file: string, maximum: number): Promise<void> {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximum ||
        (this.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw new Error("encrypted session file is unsafe");
    }
    if (this.platform === "win32") await verifyWindowsAcl(file, false);
  }

  async #writeRestricted(file: string, bytes: Uint8Array): Promise<void> {
    await this.#ensureDirectory();
    const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporary, 0o600);
      await rename(temporary, file);
      await chmod(file, 0o600);
      if (this.platform === "win32") await hardenWindowsAcl(file, false);
    } catch (error) {
      try { await handle?.close(); } catch {}
      try { await unlink(temporary); } catch {}
      throw credentialFailure("credential_backend_failure", "The encrypted local session could not be replaced.", { retryable: true, cause: error });
    }
  }
}

export function localEncryptedSessionPaths(configDirectory: string, profile = "default"): { readonly sessionFile: string; readonly keyFile: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile)) throw credentialFailure("credential_backend_unverified", "The session profile is invalid.");
  const digest = createHash("sha256").update(profile, "utf8").digest("hex").slice(0, 32);
  return Object.freeze({
    sessionFile: resolve(configDirectory, "sessions", `session-${digest}.json`),
    keyFile: resolve(configDirectory, "sessions", `session-${digest}.key`),
  });
}

function encrypt(plain: Uint8Array, key: Uint8Array): EncryptedRecord {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { version: 1, algorithm: "aes-256-gcm", nonce: nonce.toString("base64url"), tag: tag.toString("base64url"), ciphertext: ciphertext.toString("base64url") };
}

function decrypt(bytes: Uint8Array, key: Uint8Array): Uint8Array {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch (error) { throw credentialFailure("credential_corrupt", "The encrypted local session is malformed.", { cause: error }); }
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "algorithm,ciphertext,nonce,tag,version" || value.version !== 1 || value.algorithm !== "aes-256-gcm" ||
      typeof value.nonce !== "string" || typeof value.tag !== "string" || typeof value.ciphertext !== "string") {
    throw credentialFailure("credential_corrupt", "The encrypted local session shape is invalid.");
  }
  const nonce = Buffer.from(value.nonce, "base64url");
  const tag = Buffer.from(value.tag, "base64url");
  const ciphertext = Buffer.from(value.ciphertext, "base64url");
  if (nonce.byteLength !== NONCE_BYTES || tag.byteLength !== TAG_BYTES || ciphertext.byteLength < 1 || ciphertext.byteLength > 40 * 1024) throw credentialFailure("credential_corrupt", "The encrypted local session bytes are invalid.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch (error) {
    throw credentialFailure("credential_corrupt", "The encrypted local session authentication tag is invalid.", { cause: error });
  } finally { nonce.fill(0); tag.fill(0); ciphertext.fill(0); }
}

function evidence(backend: LocalEncryptedSessionBackend, now: number, status: "verified" | "unavailable", reason?: string): CredentialBackendEvidence {
  return { protocol: CREDENTIAL_BACKEND_PROTOCOL, backendId: backend.backendId, platform: backend.platform, status, observedAt: now, expiresAt: now + 60_000, source: status === "verified" ? "encrypted_local_file" : "probe_failed", ...(reason === undefined ? {} : { reason }) };
}
function exactJsonPath(value: string, label: string): string { const path = resolve(value); if (!path.endsWith(".json")) throw credentialFailure("credential_backend_unverified", `The encrypted ${label} path is invalid.`); return path; }
function exactKeyPath(value: string): string { const path = resolve(value); if (!path.endsWith(".key")) throw credentialFailure("credential_backend_unverified", "The encrypted session key path is invalid."); return path; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

async function windowsIdentity(): Promise<{ readonly sid: string }> {
  const { stdout } = await execFileAsync(resolve(WINDOWS_SYSTEM32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 16 * 1024,
    encoding: "utf8",
  });
  const match = /,"(S-1-[0-9-]+)"\s*$/u.exec(stdout.trim());
  if (match?.[1] === undefined) throw new Error("current Windows SID is unavailable");
  return { sid: match[1] };
}

async function hardenWindowsAcl(path: string, directory: boolean): Promise<void> {
  const { sid } = await windowsIdentity();
  const grant = directory ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
  await execFileAsync(resolve(WINDOWS_SYSTEM32, "icacls.exe"), [path, "/inheritance:r", "/grant:r", grant], {
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 32 * 1024,
    encoding: "utf8",
  });
  await verifyWindowsAcl(path, directory, sid);
}

async function verifyWindowsAcl(path: string, directory: boolean, knownSid?: string): Promise<void> {
  const sid = knownSid ?? (await windowsIdentity()).sid;
  const output = resolve(tmpdir(), `cuna-acl-${process.pid}-${randomBytes(8).toString("hex")}.txt`);
  try {
    await execFileAsync(resolve(WINDOWS_SYSTEM32, "icacls.exe"), [path, "/save", output, "/c"], {
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 32 * 1024,
      encoding: "utf8",
    });
    const descriptor = (await readFile(output)).toString("utf16le").split(String.fromCharCode(0)).join("");
    const expectedAce = directory ? `(A;OICI;FA;;;${sid})` : `(A;;FA;;;${sid})`;
    const dacl = /(?:^|\r?\n)(D:[^\r\n]+)/u.exec(descriptor)?.[1];
    if (dacl !== `D:PAI${expectedAce}` && dacl !== `D:P${expectedAce}`) {
      throw new Error("encrypted session ACL is not current-user-only");
    }
  } finally {
    try { await unlink(output); } catch {}
  }
}
