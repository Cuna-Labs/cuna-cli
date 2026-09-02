import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:net";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";

import { CREDENTIAL_BACKEND_PROTOCOL, type CredentialBackendEvidence, type SecureCredentialBackend } from "./contracts.js";
import { CredentialBoundaryError, credentialFailure } from "./errors.js";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_SESSION_BYTES = 96 * 1024;
const execFileAsync = promisify(execFile);
const WINDOWS_SYSTEM32 = "C:\\Windows\\System32";
const WINDOWS_ACL_PATH_ENVIRONMENT = "CUNA_SESSION_ACL_PATH_V1";
const WINDOWS_ACL_PATHS_ENVIRONMENT = "CUNA_SESSION_ACL_PATHS_V1";
const WINDOWS_ACL_CHILD_ENVIRONMENT_NAMES = new Set([
  WINDOWS_ACL_PATH_ENVIRONMENT,
  WINDOWS_ACL_PATHS_ENVIRONMENT,
  // This name is intentionally stripped even though no current command uses
  // it: a stale inherited value must not travel into the constrained child.
  "CUNA_SESSION_ACL_SID_V1",
]);
// The batched inspection reads a newline-separated path list. Win32 paths
// cannot legally contain control characters; refuse rather than misparse.
const WINDOWS_ACL_BATCH_PATH_SEPARATOR = "\n";
const WINDOWS_ACL_BATCH_MAX_PATHS = 8;
// Windows ACL verification may invoke several bounded OS helpers while an
// operation owns the physical lock. Keep a finite deadline, but make it longer
// than that legitimate critical section so a second Cuna process can observe a
// committed revision instead of failing spuriously while the first is healthy.
const LOCK_TIMEOUT_MS = 90_000;
const LOCK_RETRY_MS = 20;

/**
 * These programs are deliberately static. Dynamic values are supplied through
 * a child-only environment instead of being interpolated into `-Command`.
 * This keeps the Restricted-policy-compatible invocation while avoiding
 * encoded/dynamically generated PowerShell source.
 */
export const WINDOWS_ACL_COMMAND_PROGRAMS = Object.freeze({
  inspect: [
    "$ErrorActionPreference = 'Stop'",
    "Import-Module 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1' -ErrorAction Stop",
    "$path = $env:CUNA_SESSION_ACL_PATH_V1",
    "if ([string]::IsNullOrWhiteSpace($path)) { throw 'Cuna session ACL path is unavailable.' }",
    "$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$sddl = (Get-Acl -LiteralPath $path).Sddl",
    "[Console]::WriteLine('CUNA_CURRENT_SID=' + $current)",
    "[Console]::WriteLine('CUNA_SDDL=' + $sddl)",
  ].join("; "),
  // One spawn inspects several paths. A path that cannot be inspected (most
  // often: it does not exist yet) emits no line; the caller treats a missing
  // index as "not inspected", never as "safe", and falls back to `inspect`.
  inspectMany: [
    "$ErrorActionPreference = 'Stop'",
    "Import-Module 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1' -ErrorAction Stop",
    "$list = $env:CUNA_SESSION_ACL_PATHS_V1",
    "if ([string]::IsNullOrWhiteSpace($list)) { throw 'Cuna session ACL paths are unavailable.' }",
    "$paths = $list.Split([char]10)",
    "$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "[Console]::WriteLine('CUNA_CURRENT_SID=' + $current)",
    "for ($i = 0; $i -lt $paths.Length; $i++) {",
    "  $path = $paths[$i]",
    "  if ([string]::IsNullOrWhiteSpace($path)) { continue }",
    "  try { $sddl = (Get-Acl -LiteralPath $path).Sddl } catch { continue }",
    "  [Console]::WriteLine('CUNA_SDDL:' + $i + '=' + $sddl)",
    "}",
    // A caught per-path error leaves `$?` false, which `-Command` would report
    // as exit code 1 and the parent would read as a failed batch.
    "exit 0",
  ].join("; "),
  reconcileFile: [
    "$ErrorActionPreference = 'Stop'",
    "Import-Module 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1' -ErrorAction Stop",
    "$path = $env:CUNA_SESSION_ACL_PATH_V1",
    "if ([string]::IsNullOrWhiteSpace($path)) { throw 'Cuna session ACL path is unavailable.' }",
    "$beforeCurrent = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$beforeSddl = (Get-Acl -LiteralPath $path).Sddl",
    "$beforeOwner = [regex]::Match($beforeSddl, '^O:(S-1-[0-9-]+)(?:G:|D:|S:)').Groups[1].Value",
    "if ([string]::IsNullOrWhiteSpace($beforeOwner) -or $beforeOwner -ne $beforeCurrent) { throw 'Cuna session ACL owner is not the current user.' }",
    "$daclStart = $beforeSddl.IndexOf('D:')",
    "$saclStart = if ($daclStart -lt 0) { -1 } else { $beforeSddl.IndexOf('S:', $daclStart + 2) }",
    "$beforeDacl = if ($daclStart -lt 0) { '' } elseif ($saclStart -lt 0) { $beforeSddl.Substring($daclStart) } else { $beforeSddl.Substring($daclStart, $saclStart - $daclStart) }",
    "$expectedAce = '(A;;FA;;;' + $beforeCurrent + ')'",
    "$exact = $beforeDacl -ceq ('D:PAI' + $expectedAce) -or $beforeDacl -ceq ('D:P' + $expectedAce)",
    "$repaired = 0",
    "if (-not $exact) {",
    "  $currentBeforeWrite = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "  if ($currentBeforeWrite -ne $beforeCurrent) { throw 'Cuna session ACL SID changed.' }",
    "  $sid = [System.Security.Principal.SecurityIdentifier]::new($beforeCurrent)",
    "  $acl = [System.Security.AccessControl.FileSecurity]::new()",
    "  $acl.SetOwner($sid)",
    "  $acl.SetAccessRuleProtection($true, $false)",
    "  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]::None, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)",
    "  $acl.AddAccessRule($rule)",
    "  Set-Acl -LiteralPath $path -AclObject $acl",
    "  $repaired = 1",
    "}",
    "$afterCurrent = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$afterSddl = (Get-Acl -LiteralPath $path).Sddl",
    "[Console]::WriteLine('CUNA_BEFORE_CURRENT_SID=' + $beforeCurrent)",
    "[Console]::WriteLine('CUNA_BEFORE_SDDL=' + $beforeSddl)",
    "[Console]::WriteLine('CUNA_AFTER_CURRENT_SID=' + $afterCurrent)",
    "[Console]::WriteLine('CUNA_AFTER_SDDL=' + $afterSddl)",
    "[Console]::WriteLine('CUNA_REPAIRED=' + $repaired)",
  ].join("; "),
  reconcileDirectory: [
    "$ErrorActionPreference = 'Stop'",
    "Import-Module 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1' -ErrorAction Stop",
    "$path = $env:CUNA_SESSION_ACL_PATH_V1",
    "if ([string]::IsNullOrWhiteSpace($path)) { throw 'Cuna session ACL path is unavailable.' }",
    "$beforeCurrent = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$beforeSddl = (Get-Acl -LiteralPath $path).Sddl",
    "$beforeOwner = [regex]::Match($beforeSddl, '^O:(S-1-[0-9-]+)(?:G:|D:|S:)').Groups[1].Value",
    "if ([string]::IsNullOrWhiteSpace($beforeOwner) -or $beforeOwner -ne $beforeCurrent) { throw 'Cuna session ACL owner is not the current user.' }",
    "$daclStart = $beforeSddl.IndexOf('D:')",
    "$saclStart = if ($daclStart -lt 0) { -1 } else { $beforeSddl.IndexOf('S:', $daclStart + 2) }",
    "$beforeDacl = if ($daclStart -lt 0) { '' } elseif ($saclStart -lt 0) { $beforeSddl.Substring($daclStart) } else { $beforeSddl.Substring($daclStart, $saclStart - $daclStart) }",
    "$expectedAce = '(A;OICI;FA;;;' + $beforeCurrent + ')'",
    "$exact = $beforeDacl -ceq ('D:PAI' + $expectedAce) -or $beforeDacl -ceq ('D:P' + $expectedAce)",
    "$repaired = 0",
    "if (-not $exact) {",
    "  $currentBeforeWrite = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "  if ($currentBeforeWrite -ne $beforeCurrent) { throw 'Cuna session ACL SID changed.' }",
    "  $sid = [System.Security.Principal.SecurityIdentifier]::new($beforeCurrent)",
    "  $acl = [System.Security.AccessControl.DirectorySecurity]::new()",
    "  $acl.SetOwner($sid)",
    "  $acl.SetAccessRuleProtection($true, $false)",
    "  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]::ObjectInherit -bor [System.Security.AccessControl.InheritanceFlags]::ContainerInherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)",
    "  $acl.AddAccessRule($rule)",
    "  Set-Acl -LiteralPath $path -AclObject $acl",
    "  $repaired = 1",
    "}",
    "$afterCurrent = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$afterSddl = (Get-Acl -LiteralPath $path).Sddl",
    "[Console]::WriteLine('CUNA_BEFORE_CURRENT_SID=' + $beforeCurrent)",
    "[Console]::WriteLine('CUNA_BEFORE_SDDL=' + $beforeSddl)",
    "[Console]::WriteLine('CUNA_AFTER_CURRENT_SID=' + $afterCurrent)",
    "[Console]::WriteLine('CUNA_AFTER_SDDL=' + $afterSddl)",
    "[Console]::WriteLine('CUNA_REPAIRED=' + $repaired)",
  ].join("; "),
});

interface EncryptedRecord {
  readonly version: 1;
  readonly algorithm: "aes-256-gcm";
  readonly nonce: string;
  readonly tag: string;
  readonly ciphertext: string;
}

/**
 * The production authority is the operating-system ACL implementation below.
 * The override exists only so the sequencing and fail-closed behaviour can be
 * tested deterministically; product wiring must not provide one.
 */
interface WindowsAclInspection {
  readonly currentSid: string;
  readonly ownerSid: string;
  readonly daclOwnerOnly: boolean;
}

interface WindowsAclReconciliation {
  readonly before: WindowsAclInspection;
  readonly after: WindowsAclInspection;
  readonly repaired: boolean;
}

interface WindowsAclInspectionRequest {
  readonly path: string;
  readonly directory: boolean;
}

interface WindowsAclAuthority {
  inspectOwnerOnly(path: string, directory: boolean): Promise<WindowsAclInspection>;
  /**
   * Optional: inspect several paths in one OS invocation. The result is
   * index-aligned with the request; `undefined` means "not inspected" (for
   * example, the path does not exist yet) and the caller must fall back to
   * `inspectOwnerOnly` before trusting anything about that path.
   */
  inspectManyOwnerOnly?(requests: readonly WindowsAclInspectionRequest[]): Promise<readonly (WindowsAclInspection | undefined)[]>;
  reconcileNewOwnerOnly(path: string, directory: boolean): Promise<WindowsAclReconciliation>;
}

/**
 * ACL observations cached for exactly one locked store operation. The scope is
 * created after the physical lock is acquired and discarded when the operation
 * ends, so a permission change between two operations is always re-read. A
 * process-lifetime memo was tried first and rejected: it hid a permission
 * change made between a write and the next probe, which is the property the
 * ACL check exists to enforce.
 */
interface WindowsAclOperationScope {
  batched: boolean;
  failure: unknown;
  readonly entries: Map<string, WindowsAclInspection>;
}

function windowsAclScopeKey(path: string, directory: boolean): string {
  return `${directory ? "d" : "f"}:${path}`;
}

/**
 * Pure-JavaScript session persistence for the durable browser login code.
 * The random AES key and ciphertext are separate current-user-only files.
 * Their separation is not a backup boundary: a copied profile containing both
 * files, or compromise of the same OS account, can decrypt the session.
 */
export class LocalEncryptedSessionBackend implements SecureCredentialBackend {
  readonly backendId = "cuna-local-aes256gcm-v1";
  readonly platform: NodeJS.Platform;
  readonly #sessionFile: string;
  readonly #keyFile: string;
  readonly #clock: () => number;
  readonly #lockTimeoutMs: number;
  readonly #windowsAcl: WindowsAclAuthority;
  #aclScope: WindowsAclOperationScope | undefined;

  constructor(input: {
    readonly sessionFile: string;
    readonly keyFile: string;
    readonly platform: NodeJS.Platform;
    readonly clock?: () => number;
    readonly lockTimeoutMs?: number;
    readonly windowsAcl?: WindowsAclAuthority;
  }) {
    this.#sessionFile = exactJsonPath(input.sessionFile, "session");
    this.#keyFile = exactKeyPath(input.keyFile);
    if (this.#sessionFile === this.#keyFile || dirname(this.#sessionFile) !== dirname(this.#keyFile)) {
      throw credentialFailure("credential_backend_unverified", "The encrypted session paths are invalid.");
    }
    this.platform = input.platform;
    this.#clock = input.clock ?? Date.now;
    this.#lockTimeoutMs = input.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
    this.#windowsAcl = input.windowsAcl ?? WINDOWS_ACL_AUTHORITY;
    if (!Number.isSafeInteger(this.#lockTimeoutMs) || this.#lockTimeoutMs < 10 || this.#lockTimeoutMs > 120_000) {
      throw credentialFailure("credential_backend_unverified", "The encrypted session lock timeout is invalid.");
    }
  }

  async probe(): Promise<CredentialBackendEvidence> {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) throw credentialFailure("credential_backend_unverified", "The session clock is not trustworthy.");
    try {
      await this.#withProcessLock(async () => {
        for (const [file, maximum] of [[this.#keyFile, KEY_BYTES], [this.#sessionFile, MAX_SESSION_BYTES]] as const) {
          try { await this.#assertSafeIfPresent(file, maximum); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
      });
      return evidence(this, now, "verified");
    } catch {
      return evidence(this, now, "unavailable", "encrypted_session_permissions_unverified");
    }
  }

  async read(_target: string): Promise<Uint8Array | undefined> {
    return await this.#withProcessLock(async () => this.#readUnlocked());
  }

  async #readUnlocked(): Promise<Uint8Array | undefined> {
    let encoded: Buffer;
    try {
      await this.#assertSafeIfPresent(this.#sessionFile, MAX_SESSION_BYTES);
      encoded = await readFile(this.#sessionFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // A prior delete may have stopped after removing the ciphertext. Retry
        // the other half so a new process converges to zero local residue.
        await this.#deleteFiles([this.#keyFile]);
        return undefined;
      }
      throw localSessionReadFailure("ciphertext", error);
    }
    let key: Buffer;
    try {
      await this.#assertSafeIfPresent(this.#keyFile, KEY_BYTES);
      key = await readFile(this.#keyFile);
      if (key.byteLength !== KEY_BYTES) {
        key.fill(0);
        throw credentialFailure("credential_corrupt", "The encrypted local session key file is invalid.");
      }
    } catch (error) {
      encoded.fill(0);
      // Only an observed absence proves the key can never decrypt this
      // ciphertext. An ACL, metadata, or transient OS failure is not evidence
      // that either file is corrupt; deleting a valid durable login code in
      // that case would turn a fail-closed read into destructive data loss.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.#deleteFiles([this.#sessionFile, this.#keyFile]);
        throw credentialFailure("credential_corrupt", "The encrypted local session key is unavailable.", { cause: error });
      }
      throw localSessionReadFailure("key", error);
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
    await this.#withProcessLock(async () => this.#replaceUnlocked(protectedValue));
  }

  async #replaceUnlocked(protectedValue: Uint8Array): Promise<void> {
    const key = await this.#loadOrCreateKey();
    const record = encrypt(protectedValue, key);
    key.fill(0);
    await this.#writeRestricted(this.#sessionFile, Buffer.from(JSON.stringify(record), "utf8"));
  }

  async compareAndSwap(_target: string, expectedSha256: string | null, protectedValue: Uint8Array): Promise<"replaced" | "conflict"> {
    validateExpectedDigest(expectedSha256);
    if (protectedValue.byteLength < 1 || protectedValue.byteLength > 32 * 1024) {
      throw credentialFailure("credential_corrupt", "The encrypted session payload is invalid.");
    }
    return await this.#withProcessLock(async () => {
      const observed = await this.#protectedValueDigest(_target);
      if (observed !== expectedSha256) return "conflict";
      await this.#replaceUnlocked(protectedValue);
      return "replaced";
    });
  }

  async compareAndDelete(_target: string, expectedSha256: string): Promise<"deleted" | "absent" | "conflict"> {
    validateExpectedDigest(expectedSha256);
    return await this.#withProcessLock(async () => {
      const observed = await this.#protectedValueDigest(_target);
      if (observed === null) return "absent";
      if (observed !== expectedSha256) return "conflict";
      return await this.#deleteFiles([this.#sessionFile, this.#keyFile]);
    });
  }

  async delete(_target: string): Promise<"deleted" | "absent"> {
    return await this.#withProcessLock(async () => this.#deleteFiles([this.#sessionFile, this.#keyFile]));
  }

  async withRefreshLock<T>(_target: string, operation: () => Promise<T>): Promise<T> {
    return await this.#withNamedProcessLock("refresh", operation);
  }

  async #deleteFiles(files: readonly string[]): Promise<"deleted" | "absent"> {
    let deleted = false;
    let failure: unknown;
    for (const file of files) {
      try {
        await unlink(file);
        deleted = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && failure === undefined) failure = error;
      }
    }
    if (failure !== undefined) {
      throw credentialFailure("credential_backend_failure", "The encrypted local session could not be removed.", { retryable: true, cause: failure });
    }
    return deleted ? "deleted" : "absent";
  }

  async #protectedValueDigest(target: string): Promise<string | null> {
    void target;
    const bytes = await this.#readUnlocked();
    if (bytes === undefined) return null;
    try { return createHash("sha256").update(bytes).digest("hex"); }
    finally { bytes.fill(0); }
  }

  async #withProcessLock<T>(operation: () => Promise<T>): Promise<T> {
    return await this.#withNamedProcessLock("storage", operation);
  }

  async #withNamedProcessLock<T>(namespace: "storage" | "refresh", operation: () => Promise<T>): Promise<T> {
    // Canonicalize only after the directory exists and its no-reparse/ACL
    // boundary has been checked. Lexical aliases (junctions, symlinks, 8.3
    // names) must never create a second lock namespace for the same bytes.
    await this.#ensureDirectory({ verifyExistingWindowsAcl: false });
    const authority = await processLockAuthority(this.#sessionFile, this.platform, namespace);
    const deadline = performance.now() + this.#lockTimeoutMs;
    let server: Server | undefined;
    for (;;) {
      try {
        server = await listenForLock(authority);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || performance.now() >= deadline) {
          throw credentialFailure(
            "credential_backend_failure",
            "The encrypted local session is busy and could not be locked safely.",
            { retryable: true, safeDetails: { reason: "process_lock_unavailable" } },
          );
        }
        await delay(LOCK_RETRY_MS);
      }
    }
    // Nested locks (refresh around storage) each get their own scope; the
    // innermost operation is the unit of ACL freshness.
    const previousScope = this.#aclScope;
    this.#aclScope = { batched: false, failure: undefined, entries: new Map() };
    try {
      // The initial check is required before resolving the physical lock
      // authority. Re-check once after acquiring it: this keeps the prior
      // boundary against a directory replacement between those steps. Key
      // loading follows immediately, while atomic replacement retains its
      // own final boundary check before changing ciphertext.
      await this.#ensureDirectory();
      if (!sameProcessLockAuthority(authority, await processLockAuthority(this.#sessionFile, this.platform, namespace))) {
        throw credentialFailure(
          "credential_backend_failure",
          "The encrypted local session path changed while acquiring its lock.",
          { retryable: true, safeDetails: { reason: "process_lock_authority_changed" } },
        );
      }
      return await operation();
    } finally {
      this.#aclScope = previousScope;
      await closeServer(server);
    }
  }

  /**
   * One ACL observation per path per store operation. The first request in an
   * operation inspects the directory, the key and the ciphertext in a single
   * OS invocation when the authority supports it; every later request in the
   * same operation is served from that observation. A path the batch could
   * not inspect is inspected on its own, and a batch failure is raised at the
   * first enforcement site rather than silently retried.
   */
  async #inspectWindowsAcl(path: string, directory: boolean): Promise<WindowsAclInspection> {
    const scope = this.#aclScope;
    if (scope === undefined) return await this.#windowsAcl.inspectOwnerOnly(path, directory);
    const key = windowsAclScopeKey(path, directory);
    const cached = scope.entries.get(key);
    if (cached !== undefined) return cached;
    const inspectMany = this.#windowsAcl.inspectManyOwnerOnly;
    if (!scope.batched && inspectMany !== undefined) {
      scope.batched = true;
      const requests: readonly WindowsAclInspectionRequest[] = [
        { path: dirname(this.#sessionFile), directory: true },
        { path: this.#keyFile, directory: false },
        { path: this.#sessionFile, directory: false },
      ];
      try {
        const results = await inspectMany.call(this.#windowsAcl, requests);
        if (results.length !== requests.length) throw new Error("Windows ACL batch inspection is misaligned");
        requests.forEach((request, index) => {
          const result = results[index];
          if (result !== undefined) scope.entries.set(windowsAclScopeKey(request.path, request.directory), result);
        });
      } catch (error) {
        scope.failure = error;
      }
      const batched = scope.entries.get(key);
      if (batched !== undefined) return batched;
    }
    if (scope.failure !== undefined) throw scope.failure;
    const inspection = await this.#windowsAcl.inspectOwnerOnly(path, directory);
    scope.entries.set(key, inspection);
    return inspection;
  }

  async #assertWindowsOwnerOnlyAcl(path: string, directory: boolean): Promise<void> {
    assertWindowsOwnerOnlyInspection(await this.#inspectWindowsAcl(path, directory));
  }

  async #ensureNewWindowsOwnerOnlyAcl(path: string, directory: boolean, assertSafeMetadata: () => Promise<void>): Promise<void> {
    // A reconciliation rewrites the ACL; any observation of this path taken
    // earlier in the same operation is stale from here on.
    this.#aclScope?.entries.delete(windowsAclScopeKey(path, directory));
    await ensureNewWindowsOwnerOnlyAcl(this.#windowsAcl, path, directory, assertSafeMetadata);
  }

  async #ensureDirectory(input: { readonly verifyExistingWindowsAcl?: boolean } = {}): Promise<void> {
    const directory = dirname(this.#sessionFile);
    const created = await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.#assertSafeDirectoryMetadata(directory);
    if (this.platform === "win32") {
      if (created === undefined) {
        // An already-present directory can contain an attacker-controlled
        // junction or material. It is a verification boundary, never a repair
        // target. Before acquiring the physical lock we only need the metadata
        // boundary to derive its authority; immediately after acquisition the
        // full owner/DACL inspection below is mandatory before any operation.
        if (input.verifyExistingWindowsAcl ?? true) {
          // The directory check is the first enforcement site of every
          // operation. A bounded helper timeout here used to escape as a raw
          // child-process error and render as an internal defect (exit 70);
          // it is the same retryable, fail-closed condition as at the key
          // and ciphertext sites.
          try {
            await this.#assertWindowsOwnerOnlyAcl(directory, true);
          } catch (error) {
            throw localSessionReadFailure("directory", error);
          }
        }
      } else {
        await this.#ensureNewWindowsOwnerOnlyAcl(
          directory,
          true,
          async () => await this.#assertSafeDirectoryMetadata(directory),
        );
      }
    } else {
      await chmod(directory, 0o700);
    }
    // Re-check after chmod or any Windows ACL mutation. This does not claim
    // to close arbitrary filesystem races; it rejects a reparse observed at
    // either checked boundary.
    await this.#assertSafeDirectoryMetadata(directory);
  }

  async #assertSafeDirectoryMetadata(directory: string): Promise<void> {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (this.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw new Error("encrypted session directory is unsafe");
    }
  }

  async #loadOrCreateKey(): Promise<Buffer> {
    let created = false;
    try {
      const handle = await open(this.#keyFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      created = true;
      const generated = randomBytes(KEY_BYTES);
      try { await handle.writeFile(generated); await handle.sync(); } finally { generated.fill(0); await handle.close(); }
      await chmod(this.#keyFile, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (created) {
      await this.#assertSafeFileMetadata(this.#keyFile, KEY_BYTES);
      if (this.platform === "win32") {
        await this.#ensureNewWindowsOwnerOnlyAcl(
          this.#keyFile,
          false,
          async () => await this.#assertSafeFileMetadata(this.#keyFile, KEY_BYTES),
        );
      }
    } else {
      await this.#assertSafeIfPresent(this.#keyFile, KEY_BYTES);
    }
    const key = await readFile(this.#keyFile);
    if (key.byteLength !== KEY_BYTES) { key.fill(0); throw credentialFailure("credential_corrupt", "The encrypted session key file is invalid."); }
    return key;
  }

  async #assertSafeIfPresent(file: string, maximum: number): Promise<void> {
    await this.#assertSafeFileMetadata(file, maximum);
    if (this.platform === "win32") await this.#assertWindowsOwnerOnlyAcl(file, false);
  }

  async #assertSafeFileMetadata(file: string, maximum: number): Promise<void> {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximum ||
        (this.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw new Error("encrypted session file is unsafe");
    }
  }

  async #writeRestricted(file: string, bytes: Uint8Array): Promise<void> {
    // The lock wrapper has already completed a full owner/DACL inspection
    // after acquiring the physical authority. Keep a final reparse/metadata
    // boundary immediately before the atomic replacement without repeating a
    // second expensive ACL subprocess in the same locked operation.
    await this.#assertSafeDirectoryMetadata(dirname(file));
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
      if (this.platform === "win32") {
        await this.#assertSafeFileMetadata(file, MAX_SESSION_BYTES);
        await this.#ensureNewWindowsOwnerOnlyAcl(
          file,
          false,
          async () => await this.#assertSafeFileMetadata(file, MAX_SESSION_BYTES),
        );
      }
    } catch (error) {
      try { await handle?.close(); } catch {}
      try { await unlink(temporary); } catch {}
      throw credentialFailure("credential_backend_failure", "The encrypted local session could not be replaced.", { retryable: true, cause: error });
    }
  }
}

function validateExpectedDigest(value: string | null): void {
  if (value !== null && !/^[a-f0-9]{64}$/u.test(value)) {
    throw credentialFailure("credential_backend_unverified", "The encrypted session comparison digest is invalid.");
  }
}

/**
 * An unreadable file and an invalid encrypted value are different claims. In
 * particular, a bounded Windows ACL helper timeout proves neither that the
 * key changed nor that its AEAD tag is invalid. Keep that condition
 * retryable/fail-closed and leave the durable pair untouched; only a parsed
 * invalid key or ciphertext is reported as credential corruption.
 */
function localSessionReadFailure(subject: "ciphertext" | "key" | "directory", error: unknown): CredentialBoundaryError {
  if (error instanceof CredentialBoundaryError) return error;
  if (isBoundedWindowsAclTimeout(error)) {
    return credentialFailure(
      "credential_backend_failure",
      `The encrypted local session ${subject} could not be verified before the bounded ACL check expired.`,
      { retryable: true, safeDetails: { reason: "windows_acl_inspection_timeout" }, cause: error },
    );
  }
  if (isTransientFilesystemFailure(error)) {
    return credentialFailure(
      "credential_backend_failure",
      `The encrypted local session ${subject} could not be read from the local store.`,
      { retryable: true, safeDetails: { reason: `encrypted_session_${subject}_read_failed` }, cause: error },
    );
  }
  return credentialFailure(
    "credential_backend_unverified",
    `The encrypted local session ${subject} could not be verified safely.`,
    { safeDetails: { reason: `encrypted_session_${subject}_security_unverified` }, cause: error },
  );
}

function isBoundedWindowsAclTimeout(error: unknown): boolean {
  const record = error as { readonly code?: unknown; readonly killed?: unknown; readonly signal?: unknown } | undefined;
  return record?.code === "ETIMEDOUT" || (record?.killed === true && typeof record.signal === "string" && record.signal.length > 0);
}

function isTransientFilesystemFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EAGAIN" || code === "EBUSY" || code === "EINTR" || code === "EIO" ||
    code === "EMFILE" || code === "ENFILE" || code === "ENODEV" || code === "ENXIO" || code === "ESTALE";
}

async function processLockAuthority(
  sessionFile: string,
  platform: NodeJS.Platform,
  namespace: "storage" | "refresh" = "storage",
): Promise<string | { readonly host: "127.0.0.1"; readonly port: number }> {
  const physicalDirectory = await realpath(dirname(sessionFile));
  const physicalSession = resolve(physicalDirectory, basename(sessionFile));
  const canonical = platform === "win32" ? physicalSession.toLocaleLowerCase("en-US") : physicalSession;
  const digest = createHash("sha256").update(`${namespace}\0${canonical}`, "utf8").digest();
  if (platform === "win32") return `\\\\.\\pipe\\cuna-session-${namespace}-${digest.toString("hex").slice(0, 40)}`;
  // A loopback listener is kernel-owned and disappears on process death. A
  // hash collision or unrelated listener only causes a bounded fail-closed
  // refusal; it can never permit two writers.
  const namespaceBase = namespace === "storage" ? 49_152 : 57_344;
  return { host: "127.0.0.1", port: namespaceBase + digest.readUInt16BE(0) % 8_192 };
}

function sameProcessLockAuthority(
  left: string | { readonly host: "127.0.0.1"; readonly port: number },
  right: string | { readonly host: "127.0.0.1"; readonly port: number },
): boolean {
  return typeof left === "string" || typeof right === "string"
    ? left === right
    : left.host === right.host && left.port === right.port;
}

async function listenForLock(authority: string | { readonly host: "127.0.0.1"; readonly port: number }): Promise<Server> {
  const server = createServer((socket) => socket.destroy());
  return await new Promise<Server>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => { server.close(); rejectListen(error); };
    server.once("error", onError);
    server.listen(authority, () => {
      server.off("error", onError);
      server.unref();
      resolveListen(server);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

export function localEncryptedSessionPaths(configDirectory: string, profile = "default"): { readonly sessionFile: string; readonly keyFile: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile)) throw credentialFailure("credential_backend_unverified", "The session profile is invalid.");
  const digest = createHash("sha256").update(profile, "utf8").digest("hex").slice(0, 32);
  return Object.freeze({
    // `sessions` existed before this AES-GCM format. It may have inherited an
    // unsafe ACL, which Cuna must never repair or trust. A new format root is
    // created and verified independently; older bytes remain untouched.
    sessionFile: resolve(configDirectory, "sessions-v1", `session-${digest}.json`),
    keyFile: resolve(configDirectory, "sessions-v1", `session-${digest}.key`),
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

/**
 * Isolates the two ACL inputs from inherited Windows environment variables.
 * Windows environment-variable names are case-insensitive, so simply adding
 * canonical uppercase keys would leave an attacker-controlled differently
 * cased duplicate ambiguous to the child process.
 */
export function isolateWindowsAclChildEnvironment(
  inherited: NodeJS.ProcessEnv,
  path: string,
): NodeJS.ProcessEnv {
  const environment = stripWindowsAclChildEnvironment(inherited);
  environment[WINDOWS_ACL_PATH_ENVIRONMENT] = path;
  return environment;
}

/**
 * The batched variant carries a newline-separated list under its own name.
 * Both isolated environments strip every ACL input name, so a single-path
 * child never sees a list and a batched child never sees a single path.
 */
export function isolateWindowsAclBatchChildEnvironment(
  inherited: NodeJS.ProcessEnv,
  paths: readonly string[],
): NodeJS.ProcessEnv {
  if (paths.length < 1 || paths.length > WINDOWS_ACL_BATCH_MAX_PATHS) throw new Error("Windows ACL batch size is invalid");
  for (const path of paths) {
    if (path.length < 1 || [...path].some((character) => character.codePointAt(0)! < 0x20)) throw new Error("Windows ACL batch path is invalid");
  }
  const environment = stripWindowsAclChildEnvironment(inherited);
  environment[WINDOWS_ACL_PATHS_ENVIRONMENT] = paths.join(WINDOWS_ACL_BATCH_PATH_SEPARATOR);
  return environment;
}

function stripWindowsAclChildEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = Object.create(null) as NodeJS.ProcessEnv;
  for (const [name, value] of Object.entries(inherited)) {
    if (WINDOWS_ACL_CHILD_ENVIRONMENT_NAMES.has(name.toLocaleUpperCase("en-US"))) continue;
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

const WINDOWS_ACL_AUTHORITY: WindowsAclAuthority = Object.freeze({
  inspectOwnerOnly: async (path: string, directory: boolean) => await inspectWindowsAcl(path, directory),
  inspectManyOwnerOnly: async (requests: readonly WindowsAclInspectionRequest[]) => await inspectWindowsAclMany(requests),
  reconcileNewOwnerOnly: async (path: string, directory: boolean) => await reconcileNewWindowsAcl(path, directory),
});

function assertWindowsOwnerOnlyInspection(inspection: WindowsAclInspection): void {
  assertWindowsCurrentUserOwner(inspection);
  if (!inspection.daclOwnerOnly) {
    throw new Error("encrypted session ACL is not current-user-only");
  }
}

function assertWindowsCurrentUserOwner(inspection: WindowsAclInspection): void {
  if (inspection.ownerSid !== inspection.currentSid) {
    throw new Error("encrypted session owner is not the current user");
  }
}

async function ensureNewWindowsOwnerOnlyAcl(
  authority: WindowsAclAuthority,
  path: string,
  directory: boolean,
  assertSafeMetadata: () => Promise<void>,
): Promise<void> {
  // The ACL authority returns a before/after pair from a single static OS
  // invocation. That avoids a slow and racy inspect -> separate-process
  // repair -> inspect sequence while retaining the boundary checks on both
  // sides of a possible ACL mutation.
  await assertSafeMetadata();
  const reconciliation = await authority.reconcileNewOwnerOnly(path, directory);
  await assertSafeMetadata();
  assertWindowsCurrentUserOwner(reconciliation.before);
  if (reconciliation.before.currentSid !== reconciliation.after.currentSid) {
    throw new Error("encrypted session current user changed during ACL reconciliation");
  }
  if (reconciliation.repaired !== !reconciliation.before.daclOwnerOnly) {
    throw new Error("encrypted session ACL reconciliation result is inconsistent");
  }
  assertWindowsOwnerOnlyInspection(reconciliation.after);
}

async function inspectWindowsAcl(path: string, directory: boolean): Promise<WindowsAclInspection> {
  // The program is a constant and `path` is data in a child-only environment;
  // never interpolate paths into PowerShell source or encode them as commands.
  const { stdout } = await execFileAsync(
    resolve(WINDOWS_SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_COMMAND_PROGRAMS.inspect],
    {
      windowsHide: true,
      // PowerShell 5.1 start-up alone is 1–3 s on a loaded host and single
      // spawns of 4.9–5.2 s were measured under a CPU hog; the bound must
      // outlast that without becoming an effective hang.
      timeout: 15_000,
      maxBuffer: 16 * 1024,
      encoding: "utf8",
      env: isolateWindowsAclChildEnvironment(process.env, path),
    },
  );
  return parseWindowsAclInspection(stdout, "CUNA_CURRENT_SID", "CUNA_SDDL", directory);
}

/**
 * Batched form of `inspectWindowsAcl`: one `powershell.exe` spawn for every
 * requested path. Exported so the real program and its parser can be
 * exercised against real files on Windows.
 */
export async function inspectWindowsAclMany(
  requests: readonly WindowsAclInspectionRequest[],
): Promise<readonly (WindowsAclInspection | undefined)[]> {
  const { stdout } = await execFileAsync(
    resolve(WINDOWS_SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_COMMAND_PROGRAMS.inspectMany],
    {
      windowsHide: true,
      // PowerShell 5.1 start-up alone is 1–3 s on a loaded host and single
      // spawns of 4.9–5.2 s were measured under a CPU hog; the bound must
      // outlast that without becoming an effective hang.
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
      env: isolateWindowsAclBatchChildEnvironment(process.env, requests.map((request) => request.path)),
    },
  );
  return parseWindowsAclBatchInspection(stdout, requests.map((request) => request.directory));
}

/**
 * Parses `inspectMany` output. Exactly one `CUNA_CURRENT_SID=` line is
 * required; each `CUNA_SDDL:<index>=` line yields an inspection at that index
 * and an index without a line stays `undefined`. A duplicated or out-of-range
 * index is a malformed observation and rejects the whole batch.
 */
export function parseWindowsAclBatchInspection(
  stdout: string,
  directories: readonly boolean[],
): readonly (WindowsAclInspection | undefined)[] {
  const sidLines = stdout.match(/^CUNA_CURRENT_SID=.*$/gmu) ?? [];
  const currentSid = sidLines.length === 1 ? /^CUNA_CURRENT_SID=(S-1-[0-9-]+)$/u.exec(sidLines[0]!)?.[1] : undefined;
  if (currentSid === undefined) throw new Error("Windows ACL inspection is unavailable");
  const results: (WindowsAclInspection | undefined)[] = directories.map(() => undefined);
  for (const line of stdout.match(/^CUNA_SDDL:.*$/gmu) ?? []) {
    const match = /^CUNA_SDDL:(0|[1-9][0-9]*)=(.+)$/u.exec(line);
    const index = match === null ? Number.NaN : Number(match[1]);
    if (match === null || !(index < directories.length) || results[index] !== undefined) {
      throw new Error("Windows ACL batch inspection is malformed");
    }
    results[index] = windowsAclInspectionFromSddl(currentSid, match[2]!, directories[index]!);
  }
  return results;
}

async function reconcileNewWindowsAcl(path: string, directory: boolean): Promise<WindowsAclReconciliation> {
  const program = directory
    ? WINDOWS_ACL_COMMAND_PROGRAMS.reconcileDirectory
    : WINDOWS_ACL_COMMAND_PROGRAMS.reconcileFile;
  const { stdout } = await execFileAsync(
    resolve(WINDOWS_SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", program],
    {
      windowsHide: true,
      // PowerShell 5.1 start-up alone is 1–3 s on a loaded host and single
      // spawns of 4.9–5.2 s were measured under a CPU hog; the bound must
      // outlast that without becoming an effective hang.
      timeout: 15_000,
      maxBuffer: 32 * 1024,
      encoding: "utf8",
      env: isolateWindowsAclChildEnvironment(process.env, path),
    },
  );
  const repaired = /^CUNA_REPAIRED=([01])$/mu.exec(stdout)?.[1];
  if (repaired === undefined) throw new Error("Windows ACL reconciliation is unavailable");
  return Object.freeze({
    before: parseWindowsAclInspection(stdout, "CUNA_BEFORE_CURRENT_SID", "CUNA_BEFORE_SDDL", directory),
    after: parseWindowsAclInspection(stdout, "CUNA_AFTER_CURRENT_SID", "CUNA_AFTER_SDDL", directory),
    repaired: repaired === "1",
  });
}

function parseWindowsAclInspection(
  stdout: string,
  currentSidLabel: string,
  sddlLabel: string,
  directory: boolean,
): WindowsAclInspection {
  const currentSid = new RegExp(`^${currentSidLabel}=(S-1-[0-9-]+)$`, "mu").exec(stdout)?.[1];
  const sddl = new RegExp(`^${sddlLabel}=(.+)$`, "mu").exec(stdout)?.[1];
  if (currentSid === undefined || sddl === undefined) {
    throw new Error("Windows ACL inspection is unavailable");
  }
  return windowsAclInspectionFromSddl(currentSid, sddl, directory);
}

function windowsAclInspectionFromSddl(currentSid: string, sddl: string, directory: boolean): WindowsAclInspection {
  const ownerSid = /^O:(S-1-[0-9-]+)(?:G:|D:|S:)/u.exec(sddl)?.[1];
  if (ownerSid === undefined) {
    throw new Error("Windows ACL inspection is unavailable");
  }
  const daclStart = sddl.indexOf("D:");
  const saclStart = daclStart < 0 ? -1 : sddl.indexOf("S:", daclStart + 2);
  const dacl = daclStart < 0 ? undefined : sddl.slice(daclStart, saclStart < 0 ? undefined : saclStart);
  const expectedAce = directory ? `(A;OICI;FA;;;${currentSid})` : `(A;;FA;;;${currentSid})`;
  return {
    currentSid,
    ownerSid,
    daclOwnerOnly: dacl === `D:PAI${expectedAce}` || dacl === `D:P${expectedAce}`,
  };
}
