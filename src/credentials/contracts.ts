import type { SecretMaterial } from "./secret-material.js";

export const CREDENTIAL_BACKEND_PROTOCOL = "cuna.secure-vault.v1" as const;

export interface CredentialBinding {
  readonly profileId: string;
  readonly accountId: string;
  readonly workspaceId: string;
  readonly kind: string;
}

/**
 * `preview` is deliberately not a native security claim. It is only accepted
 * by an explicitly constructed preview vault and therefore cannot satisfy the
 * GA native-auth readiness gate.
 */
export type CredentialBackendStatus = "verified" | "preview" | "unavailable" | "unknown";

export interface CredentialBackendEvidence {
  readonly protocol: typeof CREDENTIAL_BACKEND_PROTOCOL;
  readonly backendId: string;
  readonly platform: NodeJS.Platform;
  readonly status: CredentialBackendStatus;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly source: "live_round_trip" | "native_bridge_round_trip" | "local_file_preview" | "backend_absent" | "probe_failed";
  readonly reason?: string;
}

/**
 * An implementation MUST replace one target atomically and MUST NOT expose the
 * protected value through argv, environment variables, errors, or diagnostics.
 */
export interface SecureCredentialBackend {
  readonly backendId: string;
  readonly platform: NodeJS.Platform;
  probe(): Promise<CredentialBackendEvidence>;
  read(target: string): Promise<Uint8Array | undefined>;
  replace(target: string, protectedValue: Uint8Array): Promise<void>;
  delete(target: string): Promise<"deleted" | "absent">;
}

export interface CredentialSnapshot {
  readonly material: SecretMaterial;
  readonly revision: number;
  readonly expiresAt: number | undefined;
}

export interface CredentialStatus {
  readonly backendId: string;
  readonly backendStatus: CredentialBackendStatus;
  readonly state: "present" | "expired" | "absent" | "corrupt" | "revoked" | "unavailable";
  readonly bindingDigest: string;
  readonly revision?: number;
  readonly expiresAt?: number;
}

export type CredentialRefreshResult =
  | {
      readonly status: "rotated";
      readonly material: SecretMaterial;
      readonly expiresAt?: number;
    }
  | { readonly status: "rejected" };

export interface NativeCredentialBridge {
  readonly platform: "win32" | "darwin";
  readonly backendId: string;
  readonly transportSecurity: "native_memory_only";
  read(target: string): Promise<Uint8Array | undefined>;
  replace(target: string, protectedValue: Uint8Array): Promise<void>;
  delete(target: string): Promise<"deleted" | "absent">;
}
