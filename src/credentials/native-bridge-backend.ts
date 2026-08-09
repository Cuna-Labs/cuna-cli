import { randomBytes } from "node:crypto";

import {
  CREDENTIAL_BACKEND_PROTOCOL,
  type CredentialBackendEvidence,
  type NativeCredentialBridge,
  type SecureCredentialBackend,
} from "./contracts.js";
import { createUnavailableCredentialBackend } from "./unavailable-backend.js";

export function createMacOsKeychainBackend(input: {
  readonly bridge?: NativeCredentialBridge;
  readonly clock?: () => number;
} = {}): SecureCredentialBackend {
  const clock = input.clock ?? Date.now;
  if (input.bridge === undefined) {
    return createUnavailableCredentialBackend({
      backendId: "macos-keychain",
      platform: "darwin",
      reason: "A native memory-only Keychain bridge is not installed; argv-based password writes are prohibited.",
      clock,
    });
  }
  const bridge = input.bridge;
  let cachedEvidence: CredentialBackendEvidence | undefined;
  const backend: SecureCredentialBackend = {
    backendId: bridge.backendId,
    platform: "darwin",
    probe: async () => {
      const now = clock();
      if (cachedEvidence !== undefined && cachedEvidence.expiresAt > now) return cachedEvidence;
      const target = `runa-cli:probe:${randomBytes(16).toString("hex")}`;
      const sentinel = randomBytes(32);
      try {
        await bridge.replace(target, sentinel);
        const observed = await bridge.read(target);
        await bridge.delete(target);
        const verified = observed !== undefined && equalBytes(observed, sentinel);
        observed?.fill(0);
        cachedEvidence = {
          protocol: CREDENTIAL_BACKEND_PROTOCOL,
          backendId: bridge.backendId,
          platform: "darwin",
          status: verified ? "verified" : "unknown",
          observedAt: now,
          expiresAt: now + 60_000,
          source: verified ? "native_bridge_round_trip" : "probe_failed",
          ...(!verified && { reason: "The native Keychain round trip did not preserve the sentinel." }),
        };
      } catch {
        cachedEvidence = {
          protocol: CREDENTIAL_BACKEND_PROTOCOL,
          backendId: bridge.backendId,
          platform: "darwin",
          status: "unavailable",
          observedAt: now,
          expiresAt: now + 5_000,
          source: "probe_failed",
          reason: "The native Keychain bridge failed its live round trip.",
        };
      } finally {
        sentinel.fill(0);
        try { await bridge.delete(target); } catch { /* best-effort probe cleanup */ }
      }
      return cachedEvidence;
    },
    read: async (target) => bridge.read(target),
    replace: async (target, value) => bridge.replace(target, value),
    delete: async (target) => bridge.delete(target),
  };
  return backend;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
