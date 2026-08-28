import type { SecretMaterial } from "./secret-material.js";

export const CREDENTIAL_BACKEND_PROTOCOL = "cuna.secure-vault.v1" as const;

export interface CredentialBinding {
  readonly profileId: string;
  readonly accountId: string;
  readonly workspaceId: string;
  readonly kind: string;
}

/**
 * `preview` is deliberately not a production security claim. It is only
 * accepted by an explicitly constructed preview vault and therefore cannot
 * satisfy the public encrypted-session readiness gate.
 */
export type CredentialBackendStatus = "verified" | "preview" | "unavailable" | "unknown";

export interface CredentialBackendEvidence {
  readonly protocol: typeof CREDENTIAL_BACKEND_PROTOCOL;
  readonly backendId: string;
  readonly platform: NodeJS.Platform;
  readonly status: CredentialBackendStatus;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly source: "live_round_trip" | "encrypted_local_file" | "local_file_preview" | "probe_failed";
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
  /**
   * Optional durable compare-and-swap operations. File-backed implementations
   * use these to fence independent CLI processes; an in-memory queue is not an
   * inter-process authority.
   */
  compareAndSwap?(
    target: string,
    expectedSha256: string | null,
    protectedValue: Uint8Array,
  ): Promise<"replaced" | "conflict">;
  compareAndDelete?(
    target: string,
    expectedSha256: string,
  ): Promise<"deleted" | "absent" | "conflict">;
  /**
   * Optional cross-process refresh authority. It is deliberately separate
   * from the backend's storage lock: the callback reads and CAS-writes through
   * that storage lock while this outer authority prevents sibling CLI
   * processes from re-exchanging the same renewable session concurrently.
   */
  withRefreshLock?<T>(target: string, operation: () => Promise<T>): Promise<T>;
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
  | { readonly status: "retained" }
  // The refresher observed no durable record. This is intentionally distinct
  // from a server rejection: it must not manufacture a revocation or mutate
  // the backend merely to report that the user has not signed in yet.
  | { readonly status: "missing" }
  | {
      readonly status: "rejected";
      /**
       * The vault always revision-fences removal, but the caller must still
       * distinguish a remote terminal fact from local expiry or validation.
       * Only `authoritative_remote` permits a later logout to report that the
       * remote family was already revoked.
       */
      readonly reason: "authoritative_remote" | "local_expired" | "local_integrity";
    };
