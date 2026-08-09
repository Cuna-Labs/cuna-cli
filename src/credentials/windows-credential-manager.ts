import { randomBytes } from "node:crypto";
import { win32 } from "node:path";

import { CREDENTIAL_BACKEND_PROTOCOL, type CredentialBackendEvidence, type SecureCredentialBackend } from "./contracts.js";
import { credentialFailure } from "./errors.js";
import {
  createSecureProcessRunner,
  credentialProcessEnvironment,
  type SecureProcessRunner,
} from "./process-runner.js";

interface WindowsResponse {
  readonly ok?: boolean;
  readonly status?: string;
  readonly valueBase64?: string;
}

const WINDOWS_CREDENTIAL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$stage = 'initialize'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RunaCredentialNative {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr credential);
}
'@
  $stage = 'request'
  $requestText = [Console]::In.ReadToEnd()
  $request = $requestText | ConvertFrom-Json
  if ($request.operation -eq 'replace') {
    $stage = 'replace_prepare'
    $blob = [Convert]::FromBase64String([string]$request.valueBase64)
    $pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($blob.Length)
    try {
      $stage = 'replace_write'
      [Runtime.InteropServices.Marshal]::Copy($blob, 0, $pointer, $blob.Length)
      $credential = New-Object RunaCredentialNative+CREDENTIAL
      $credential.Type = 1
      $credential.TargetName = [string]$request.target
      $credential.Comment = 'Runa CLI protected credential'
      $credential.CredentialBlobSize = $blob.Length
      $credential.CredentialBlob = $pointer
      $credential.Persist = 2
      $credential.UserName = 'runa-cli'
      if (-not [RunaCredentialNative]::CredWrite([ref]$credential, 0)) { throw 'write_failed' }
      @{ ok = $true; status = 'replaced' } | ConvertTo-Json -Compress
    } finally {
      $stage = 'replace_cleanup'
      if ($blob) { [Array]::Clear($blob, 0, $blob.Length) }
      if ($pointer -ne [IntPtr]::Zero) {
        if ($blob) { [Runtime.InteropServices.Marshal]::Copy($blob, 0, $pointer, $blob.Length) }
        [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer)
      }
    }
  } elseif ($request.operation -eq 'read') {
    $stage = 'read'
    $credentialPointer = [IntPtr]::Zero
    if (-not [RunaCredentialNative]::CredRead([string]$request.target, 1, 0, [ref]$credentialPointer)) {
      if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) {
        @{ ok = $true; status = 'absent' } | ConvertTo-Json -Compress
      } else { throw 'read_failed' }
    } else {
      try {
        $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($credentialPointer, [type][RunaCredentialNative+CREDENTIAL])
        $blob = New-Object byte[] $credential.CredentialBlobSize
        [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $blob, 0, $blob.Length)
        try { @{ ok = $true; status = 'present'; valueBase64 = [Convert]::ToBase64String($blob) } | ConvertTo-Json -Compress }
        finally { [Array]::Clear($blob, 0, $blob.Length) }
      } finally { [RunaCredentialNative]::CredFree($credentialPointer) }
    }
  } elseif ($request.operation -eq 'delete') {
    $stage = 'delete'
    if ([RunaCredentialNative]::CredDelete([string]$request.target, 1, 0)) {
      @{ ok = $true; status = 'deleted' } | ConvertTo-Json -Compress
    } elseif ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) {
      @{ ok = $true; status = 'absent' } | ConvertTo-Json -Compress
    } else { throw 'delete_failed' }
  } else { throw 'operation_invalid' }
} catch {
  $known = @('write_failed', 'read_failed', 'delete_failed', 'operation_invalid')
  $status = if ($known -contains $_.Exception.Message) { $_.Exception.Message } else { 'failed_' + $stage }
  @{ ok = $false; status = $status } | ConvertTo-Json -Compress
  exit 1
}
`;
const WINDOWS_CREDENTIAL_ENCODED_COMMAND = Buffer.from(WINDOWS_CREDENTIAL_SCRIPT, "utf16le").toString("base64");

export function createWindowsCredentialManagerBackend(input: {
  readonly runner?: SecureProcessRunner;
  readonly executable?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly clock?: () => number;
} = {}): SecureCredentialBackend {
  const runner = input.runner ?? createSecureProcessRunner();
  const environment = input.environment ?? credentialProcessEnvironment("win32");
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  const executable = input.executable ?? (
    systemRoot === undefined
      ? ""
      : win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  );
  const cwd = systemRoot === undefined ? "" : win32.join(systemRoot, "System32");
  const clock = input.clock ?? Date.now;
  let cachedEvidence: CredentialBackendEvidence | undefined;

  const invoke = async (request: Readonly<Record<string, string>>): Promise<WindowsResponse> => {
    const stdin = new TextEncoder().encode(JSON.stringify(request));
    try {
      const result = await runner.run({
        executable,
        cwd,
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_CREDENTIAL_ENCODED_COMMAND],
        stdin,
        environment,
        timeoutMs: 30_000,
        maximumOutputBytes: 96 * 1024,
      });
      const output = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
      result.stdout.fill(0);
      let response: WindowsResponse;
      try {
        response = JSON.parse(output) as WindowsResponse;
      } catch {
        throw credentialFailure(
          "credential_backend_failure",
          "Windows Credential Manager returned an invalid response.",
        );
      }
      if (result.exitCode !== 0 || response.ok !== true) {
        throw credentialFailure(
          "credential_backend_failure",
          "Windows Credential Manager rejected the credential operation.",
          { retryable: true, safeDetails: { backendId: "windows-credential-manager" } },
        );
      }
      return response;
    } finally {
      stdin.fill(0);
    }
  };

  const read = async (target: string): Promise<Uint8Array | undefined> => {
    const response = await invoke({ operation: "read", target });
    if (response.status === "absent") return undefined;
    if (response.status !== "present" || response.valueBase64 === undefined) {
      throw credentialFailure("credential_backend_failure", "Windows Credential Manager returned an invalid read state.");
    }
    try {
      return Uint8Array.from(Buffer.from(response.valueBase64, "base64"));
    } catch {
      throw credentialFailure("credential_backend_failure", "Windows Credential Manager returned an invalid protected value.");
    }
  };

  const replace = async (target: string, protectedValue: Uint8Array): Promise<void> => {
    if (protectedValue.byteLength < 1 || protectedValue.byteLength > 64 * 1024) {
      throw credentialFailure("credential_corrupt", "Credential payload exceeds the Credential Manager limit.");
    }
    const response = await invoke({
      operation: "replace",
      target,
      valueBase64: Buffer.from(protectedValue).toString("base64"),
    });
    if (response.status !== "replaced") {
      throw credentialFailure("credential_backend_failure", "Windows Credential Manager did not confirm replacement.");
    }
  };

  const remove = async (target: string): Promise<"deleted" | "absent"> => {
    const response = await invoke({ operation: "delete", target });
    if (response.status === "deleted" || response.status === "absent") return response.status;
    throw credentialFailure("credential_backend_failure", "Windows Credential Manager returned an invalid delete state.");
  };

  return {
    backendId: "windows-credential-manager",
    platform: "win32",
    probe: async () => {
      const now = clock();
      if (cachedEvidence !== undefined && cachedEvidence.expiresAt > now) return cachedEvidence;
      const target = `runa-cli:probe:${randomBytes(16).toString("hex")}`;
      const sentinel = randomBytes(32);
      try {
        await replace(target, sentinel);
        const observed = await read(target);
        const verified = observed !== undefined && equalBytes(observed, sentinel);
        observed?.fill(0);
        await remove(target);
        cachedEvidence = {
          protocol: CREDENTIAL_BACKEND_PROTOCOL,
          backendId: "windows-credential-manager",
          platform: "win32",
          status: verified ? "verified" : "unknown",
          observedAt: now,
          expiresAt: now + 60_000,
          source: verified ? "live_round_trip" : "probe_failed",
          ...(!verified && { reason: "Credential Manager did not preserve the probe sentinel." }),
        };
      } catch {
        cachedEvidence = {
          protocol: CREDENTIAL_BACKEND_PROTOCOL,
          backendId: "windows-credential-manager",
          platform: "win32",
          status: "unavailable",
          observedAt: now,
          expiresAt: now + 5_000,
          source: "probe_failed",
          reason: "Credential Manager failed its live write/read/delete probe.",
        };
        try { await remove(target); } catch { /* best-effort probe cleanup */ }
      } finally {
        sentinel.fill(0);
      }
      return cachedEvidence;
    },
    read,
    replace,
    delete: remove,
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
