import { randomBytes } from "node:crypto";

import {
  CREDENTIAL_BACKEND_PROTOCOL,
  type CredentialBackendEvidence,
  type NativeCredentialBridge,
  type SecureCredentialBackend,
} from "./contracts.js";
import { createUnavailableCredentialBackend } from "./unavailable-backend.js";
import { probeCredentialTarget } from "./vault.js";

export function createNativeBridgeBackend(input: {
  readonly platform: "win32" | "darwin";
  readonly bridge?: NativeCredentialBridge;
  readonly clock?: () => number;
}): SecureCredentialBackend {
  const clock = input.clock ?? Date.now;
  if (input.bridge === undefined) {
    return createUnavailableCredentialBackend({
      backendId: input.platform === "win32" ? "windows-native-vault-required" : "macos-keychain",
      platform: input.platform,
      reason: "An admitted signed native credential bridge is not installed.",
      clock,
    });
  }
  const bridge = input.bridge;
  if (bridge.platform !== input.platform) {
    return createUnavailableCredentialBackend({
      backendId: bridge.backendId,
      platform: input.platform,
      reason: "The native credential bridge platform binding does not match this runtime.",
      clock,
    });
  }
  let cachedEvidence: CredentialBackendEvidence | undefined;
  const backend: SecureCredentialBackend = {
    backendId: bridge.backendId,
    platform: input.platform,
    probe: async () => {
      const now = clock();
      if (cachedEvidence !== undefined && cachedEvidence.expiresAt > now) return cachedEvidence;
      // Minted by the credential namespace's own authority, never spelled here.
      const target = probeCredentialTarget();
      const sentinel = randomBytes(32);
      let cleanupProven = false;
      let observed: Uint8Array | undefined;
      try {
        await bridge.replace(target, sentinel);
        observed = await bridge.read(target);
        const verified = observed !== undefined && equalBytes(observed, sentinel);
        observed?.fill(0);
        observed = undefined;
        await bridge.delete(target);
        cleanupProven = true;
        cachedEvidence = {
          protocol: CREDENTIAL_BACKEND_PROTOCOL,
          backendId: bridge.backendId,
          platform: input.platform,
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
          platform: input.platform,
          status: "unavailable",
          observedAt: now,
          expiresAt: now + 5_000,
          source: "probe_failed",
          reason: "The native Keychain bridge failed its live round trip.",
        };
      } finally {
        observed?.fill(0);
        sentinel.fill(0);
        if (!cleanupProven) {
          try {
            await bridge.delete(target);
            cleanupProven = true;
          } catch {
            cleanupProven = false;
          }
        }
      }
      if (!cleanupProven) {
        cachedEvidence = {
          protocol: CREDENTIAL_BACKEND_PROTOCOL,
          backendId: bridge.backendId,
          platform: input.platform,
          status: "unavailable",
          observedAt: now,
          expiresAt: now + 5_000,
          source: "probe_failed",
          reason: "The native credential bridge could not prove probe cleanup.",
        };
      }
      return cachedEvidence;
    },
    read: async (target) => bridge.read(target),
    replace: async (target, value) => bridge.replace(target, value),
    delete: async (target) => bridge.delete(target),
  };
  return backend;
}

export function createMacOsKeychainBackend(input: {
  readonly bridge?: NativeCredentialBridge;
  readonly clock?: () => number;
} = {}): SecureCredentialBackend {
  return createNativeBridgeBackend({ platform: "darwin", ...input });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
