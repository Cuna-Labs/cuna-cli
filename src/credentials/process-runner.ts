import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import { CredentialBoundaryError, credentialFailure } from "./errors.js";

export interface SecureProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin?: Uint8Array;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maximumOutputBytes?: number;
  /**
   * Runs after the OS reports process creation and before any stdin bytes are released.
   * The PID comes from the ChildProcess created by this runner. Callers protecting
   * secrets must use an OS authority to bind that PID to its loaded image; a path
   * re-check alone is not an identity proof for the already-created process.
   */
  readonly beforeStdin?: (
    child: SecureSpawnedProcessIdentity,
  ) => Promise<SecureStdinAdmissionLease>;
}

export interface SecureSpawnedProcessIdentity {
  readonly pid: number;
  readonly platform: NodeJS.Platform;
}

export interface SecureStdinAdmissionLease {
  /**
   * Release the OS process-instance authority only after protected stdin has
   * been accepted by the target pipe, or after target termination is observed.
   */
  release(): void;
}

export interface SecureProcessResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Uint8Array;
  readonly stderrPresent: boolean;
  readonly stdinAdmissionConfirmed?: boolean;
}

export interface SecureProcessRunner {
  run(request: SecureProcessRequest): Promise<SecureProcessResult>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAXIMUM_OUTPUT_BYTES = 128 * 1024;
const MAXIMUM_STDIN_BYTES = 128 * 1024;
const TERMINATION_DEADLINE_MS = 2_000;

export function createSecureProcessRunner(): SecureProcessRunner {
  return {
    run: async (request) => runSecureProcess(request),
  };
}

async function runSecureProcess(request: SecureProcessRequest): Promise<SecureProcessResult> {
  validateRequest(request);
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maximumOutputBytes = request.maximumOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES;

  return await new Promise<SecureProcessResult>((resolve, reject) => {
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let oversized = false;
    let terminationFailure: CredentialBoundaryError | undefined;
    let terminationDeadline: NodeJS.Timeout | undefined;
    let stdinCopy: Uint8Array | undefined;
    let admissionLease: SecureStdinAdmissionLease | undefined;
    let stdinAdmissionConfirmed = request.beforeStdin === undefined;
    const stdoutChunks: Uint8Array[] = [];

    const child = spawn(request.executable, [...request.args], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: request.environment === undefined ? {} : { ...request.environment },
      cwd: request.cwd,
    });

    const releaseAdmissionLease = (): CredentialBoundaryError | undefined => {
      const lease = admissionLease;
      admissionLease = undefined;
      if (lease === undefined) return undefined;
      try {
        lease.release();
        return undefined;
      } catch {
        return credentialFailure(
          "credential_backend_unverified",
          "The secure backend process-instance authority could not be released safely.",
        );
      }
    };

    const finishReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (terminationDeadline !== undefined) clearTimeout(terminationDeadline);
      stdinCopy?.fill(0);
      stdinCopy = undefined;
      wipeChunks(stdoutChunks);
      reject(releaseAdmissionLease() ?? error);
    };

    const quiesceStreams = (): void => {
      child.stdin.removeAllListeners();
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };

    const requestTermination = (failure: CredentialBoundaryError): void => {
      if (terminationFailure !== undefined || settled) return;
      terminationFailure = failure;
      child.kill("SIGKILL");
      terminationDeadline = setTimeout(() => {
        child.kill("SIGKILL");
        quiesceStreams();
        child.unref();
        finishReject(credentialFailure(
          "credential_process_failed",
          "The secure credential backend process did not confirm termination; its outcome is unknown.",
          { safeDetails: { terminationConfirmed: false } },
        ));
      }, TERMINATION_DEADLINE_MS);
    };

    const timeout = setTimeout(() => {
      requestTermination(credentialFailure(
        "credential_process_timeout",
        "The secure credential backend did not respond within the bounded time.",
        { retryable: true },
      ));
    }, timeoutMs);

    child.once("error", (cause) => {
      quiesceStreams();
      finishReject(credentialFailure(
        "credential_process_failed",
        "The secure credential backend process could not be started.",
        { cause },
      ));
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maximumOutputBytes) {
        chunk.fill(0);
        oversized = true;
        requestTermination(credentialFailure(
          "credential_output_oversized",
          "The secure credential backend returned an oversized response.",
        ));
        return;
      }
      stdoutChunks.push(Uint8Array.from(chunk));
      chunk.fill(0);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      chunk.fill(0);
      if (stderrBytes > maximumOutputBytes) {
        requestTermination(credentialFailure(
          "credential_output_oversized",
          "The secure credential backend returned an oversized response.",
        ));
      }
    });

    child.stdout.once("error", (cause) => {
      requestTermination(credentialFailure(
        "credential_process_failed",
        "The secure credential backend output stream failed.",
        { cause },
      ));
    });
    child.stderr.once("error", (cause) => {
      requestTermination(credentialFailure(
        "credential_process_failed",
        "The secure credential backend error stream failed.",
        { cause },
      ));
    });

    child.once("close", (exitCode, signal) => {
      if (settled) return;
      const leaseFailure = releaseAdmissionLease();
      settled = true;
      clearTimeout(timeout);
      if (terminationDeadline !== undefined) clearTimeout(terminationDeadline);
      stdinCopy?.fill(0);
      stdinCopy = undefined;
      if (leaseFailure !== undefined) {
        wipeChunks(stdoutChunks);
        reject(leaseFailure);
        return;
      }
      if (terminationFailure !== undefined) {
        wipeChunks(stdoutChunks);
        reject(terminationFailure);
        return;
      }
      if (request.beforeStdin !== undefined && !stdinAdmissionConfirmed) {
        wipeChunks(stdoutChunks);
        reject(credentialFailure(
          "credential_backend_unverified",
          "The secure backend closed before its post-spawn identity was admitted.",
        ));
        return;
      }
      if (oversized || stderrBytes > maximumOutputBytes) {
        wipeChunks(stdoutChunks);
        reject(credentialFailure(
          "credential_output_oversized",
          "The secure credential backend returned an oversized response.",
        ));
        return;
      }
      const stdout = concatenate(stdoutChunks, stdoutBytes);
      wipeChunks(stdoutChunks);
      resolve({
        exitCode: exitCode ?? -1,
        signal,
        stdout,
        stderrPresent: stderrBytes > 0,
        stdinAdmissionConfirmed,
      });
    });

    child.stdin.once("error", (cause) => {
      if (terminationFailure !== undefined) return;
      requestTermination(credentialFailure(
        "credential_process_failed",
        "The secure credential backend could not receive protected input.",
        { cause },
      ));
    });
    const completeProtectedWrite = (): void => {
      stdinCopy?.fill(0);
      stdinCopy = undefined;
      const leaseFailure = releaseAdmissionLease();
      if (leaseFailure !== undefined) requestTermination(leaseFailure);
    };
    const releaseStdin = (): void => {
      if (settled || terminationFailure !== undefined) return;
      try {
        if (request.stdin === undefined) {
          child.stdin.end(completeProtectedWrite);
        } else {
          stdinCopy = Uint8Array.from(request.stdin);
          child.stdin.end(stdinCopy, completeProtectedWrite);
        }
      } catch (cause) {
        requestTermination(credentialFailure(
          "credential_process_failed",
          "The secure credential backend could not receive protected input.",
          { cause },
        ));
      }
    };

    child.once("spawn", () => {
      const pid = child.pid;
      if (!Number.isSafeInteger(pid) || pid === undefined || pid < 1) {
        requestTermination(credentialFailure(
          "credential_backend_unverified",
          "The secure backend did not expose a valid spawned-process identity.",
        ));
        return;
      }
      if (request.beforeStdin === undefined) {
        releaseStdin();
        return;
      }
      void request.beforeStdin(Object.freeze({ pid, platform: process.platform })).then((lease) => {
        if (lease === undefined || typeof lease.release !== "function") {
          requestTermination(credentialFailure(
            "credential_backend_unverified",
            "The secure backend identity authority did not retain a process-instance lease.",
          ));
          return;
        }
        admissionLease = lease;
        if (settled || terminationFailure !== undefined) {
          const leaseFailure = releaseAdmissionLease();
          if (leaseFailure !== undefined && !settled) requestTermination(leaseFailure);
          return;
        }
        stdinAdmissionConfirmed = true;
        releaseStdin();
      }, (cause: unknown) => {
        requestTermination(cause instanceof CredentialBoundaryError
          ? cause
          : credentialFailure(
            "credential_backend_unverified",
            "The secure backend identity changed during process creation.",
          ));
      });
    });
  });
}

function validateRequest(request: SecureProcessRequest): void {
  if (
    request.executable.length < 1 ||
    request.executable.includes("\0") ||
    !isAbsolute(request.executable)
  ) {
    throw credentialFailure("credential_process_failed", "The secure backend executable is invalid.");
  }
  if (request.cwd.length < 1 || request.cwd.includes("\0") || !isAbsolute(request.cwd)) {
    throw credentialFailure("credential_process_failed", "The secure backend working directory is invalid.");
  }
  if (request.args.some((argument) => argument.includes("\0"))) {
    throw credentialFailure("credential_process_failed", "A secure backend argument is invalid.");
  }
  if ((request.stdin?.byteLength ?? 0) > MAXIMUM_STDIN_BYTES) {
    throw credentialFailure("credential_corrupt", "Credential payload exceeds the secure backend limit.");
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maximumOutputBytes = request.maximumOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw credentialFailure("credential_process_failed", "The secure backend timeout is invalid.");
  }
  if (
    !Number.isSafeInteger(maximumOutputBytes) ||
    maximumOutputBytes < 1 ||
    maximumOutputBytes > DEFAULT_MAXIMUM_OUTPUT_BYTES
  ) {
    throw credentialFailure("credential_process_failed", "The secure backend output bound is invalid.");
  }
}

function concatenate(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function wipeChunks(chunks: readonly Uint8Array[]): void {
  for (const chunk of chunks) chunk.fill(0);
}

export function credentialProcessEnvironment(
  platform: NodeJS.Platform,
  source: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const allowed = platform === "win32"
    ? ["SystemRoot", "WINDIR", "TEMP", "TMP", "LANG"]
    : ["HOME", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
  const result: Record<string, string> = {};
  for (const name of allowed) {
    const value = source[name];
    if (value !== undefined && !value.includes("\0")) result[name] = value;
  }
  return Object.freeze(result);
}
