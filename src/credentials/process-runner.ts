import { spawn } from "node:child_process";

import { credentialFailure } from "./errors.js";

export interface SecureProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly stdin?: Uint8Array;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maximumOutputBytes?: number;
}

export interface SecureProcessResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Uint8Array;
  readonly stderrPresent: boolean;
}

export interface SecureProcessRunner {
  run(request: SecureProcessRequest): Promise<SecureProcessResult>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAXIMUM_OUTPUT_BYTES = 128 * 1024;
const MAXIMUM_STDIN_BYTES = 128 * 1024;

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
    const stdoutChunks: Uint8Array[] = [];

    const child = spawn(request.executable, [...request.args], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: request.environment === undefined ? {} : { ...request.environment },
    });

    const finishReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      wipeChunks(stdoutChunks);
      reject(error);
    };

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finishReject(credentialFailure(
        "credential_process_timeout",
        "The secure credential backend did not respond within the bounded time.",
        { retryable: true },
      ));
    }, timeoutMs);

    child.once("error", (cause) => {
      finishReject(credentialFailure(
        "credential_process_failed",
        "The secure credential backend process could not be started.",
        { cause },
      ));
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maximumOutputBytes) {
        oversized = true;
        child.kill("SIGKILL");
        return;
      }
      stdoutChunks.push(Uint8Array.from(chunk));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maximumOutputBytes) child.kill("SIGKILL");
    });

    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
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
      });
    });

    if (request.stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(Buffer.from(request.stdin));
    }
  });
}

function validateRequest(request: SecureProcessRequest): void {
  if (request.executable.length < 1 || request.executable.includes("\0")) {
    throw credentialFailure("credential_process_failed", "The secure backend executable is invalid.");
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
