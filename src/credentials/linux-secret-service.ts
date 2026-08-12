import { randomBytes } from "node:crypto";

import { CREDENTIAL_BACKEND_PROTOCOL, type CredentialBackendEvidence, type SecureCredentialBackend } from "./contracts.js";
import { credentialFailure } from "./errors.js";
import {
  createSecureProcessRunner,
  credentialProcessEnvironment,
  type SecureProcessRunner,
} from "./process-runner.js";

const MAXIMUM_VALUE_BYTES = 64 * 1024;

export function createLinuxSecretServiceBackend(input: {
  readonly runner?: SecureProcessRunner;
  readonly executable?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly clock?: () => number;
} = {}): SecureCredentialBackend {
  const runner = input.runner ?? createSecureProcessRunner();
  const executable = input.executable ?? "/usr/bin/secret-tool";
  const environment = input.environment ?? credentialProcessEnvironment("linux");
  const clock = input.clock ?? Date.now;
  let cachedEvidence: CredentialBackendEvidence | undefined;

  const read = async (target: string): Promise<Uint8Array | undefined> => {
    const result = await runner.run({
      executable,
      cwd: "/",
      args: ["lookup", "application", "cuna-cli", "credential-key", target],
      environment,
      maximumOutputBytes: MAXIMUM_VALUE_BYTES,
    });
    if (result.exitCode === 1) {
      result.stdout.fill(0);
      return undefined;
    }
    if (result.exitCode !== 0) {
      result.stdout.fill(0);
      throw credentialFailure(
        "credential_backend_failure",
        "Linux Secret Service could not read the protected credential.",
        { retryable: true, safeDetails: { backendId: "linux-secret-service" } },
      );
    }
    return stripSingleLineEnding(result.stdout);
  };

  const replace = async (target: string, protectedValue: Uint8Array): Promise<void> => {
    if (protectedValue.byteLength < 1 || protectedValue.byteLength > MAXIMUM_VALUE_BYTES - 1) {
      throw credentialFailure("credential_corrupt", "Credential payload exceeds the Secret Service limit.");
    }
    const stdin = new Uint8Array(protectedValue.byteLength + 1);
    stdin.set(protectedValue);
    stdin[stdin.byteLength - 1] = 0x0a;
    try {
      const result = await runner.run({
        executable,
        cwd: "/",
        args: [
          "store",
          "--label=Cuna CLI credential",
          "application",
          "cuna-cli",
          "credential-key",
          target,
        ],
        stdin,
        environment,
        maximumOutputBytes: 4_096,
      });
      result.stdout.fill(0);
      if (result.exitCode !== 0) {
        throw credentialFailure(
          "credential_backend_failure",
          "Linux Secret Service could not atomically replace the protected credential.",
          { retryable: true, safeDetails: { backendId: "linux-secret-service" } },
        );
      }
    } finally {
      stdin.fill(0);
    }
  };

  const remove = async (target: string): Promise<"deleted" | "absent"> => {
    const existing = await read(target);
    if (existing === undefined) return "absent";
    existing.fill(0);
    const result = await runner.run({
      executable,
      cwd: "/",
      args: ["clear", "application", "cuna-cli", "credential-key", target],
      environment,
      maximumOutputBytes: 4_096,
    });
    result.stdout.fill(0);
    if (result.exitCode !== 0) {
      throw credentialFailure(
        "credential_backend_failure",
        "Linux Secret Service could not delete the protected credential.",
        { retryable: true, safeDetails: { backendId: "linux-secret-service" } },
      );
    }
    return "deleted";
  };

  return {
    backendId: "linux-secret-service",
    platform: "linux",
    probe: async () => {
      const now = clock();
      if (cachedEvidence !== undefined && cachedEvidence.expiresAt > now) return cachedEvidence;
      const target = `probe-${randomBytes(16).toString("hex")}`;
      const sentinel = new TextEncoder().encode(`cuna-probe-${randomBytes(24).toString("base64url")}`);
      try {
        await replace(target, sentinel);
        const observed = await read(target);
        const verified = observed !== undefined && equalBytes(observed, sentinel);
        observed?.fill(0);
        await remove(target);
        cachedEvidence = {
          protocol: CREDENTIAL_BACKEND_PROTOCOL,
          backendId: "linux-secret-service",
          platform: "linux",
          status: verified ? "verified" : "unknown",
          observedAt: now,
          expiresAt: now + 60_000,
          source: verified ? "live_round_trip" : "probe_failed",
          ...(!verified && { reason: "Secret Service did not preserve the probe sentinel." }),
        };
      } catch {
        cachedEvidence = {
          protocol: CREDENTIAL_BACKEND_PROTOCOL,
          backendId: "linux-secret-service",
          platform: "linux",
          status: "unavailable",
          observedAt: now,
          expiresAt: now + 5_000,
          source: "probe_failed",
          reason: "Secret Service failed its live write/read/delete probe.",
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

function stripSingleLineEnding(value: Uint8Array): Uint8Array {
  let length = value.byteLength;
  if (length > 0 && value[length - 1] === 0x0a) length -= 1;
  if (length > 0 && value[length - 1] === 0x0d) length -= 1;
  const result = value.slice(0, length);
  value.fill(0);
  return result;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
