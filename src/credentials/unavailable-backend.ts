import { CREDENTIAL_BACKEND_PROTOCOL, type CredentialBackendEvidence, type SecureCredentialBackend } from "./contracts.js";
import { credentialFailure } from "./errors.js";

export function createUnavailableCredentialBackend(input: {
  readonly backendId: string;
  readonly platform: NodeJS.Platform;
  readonly reason: string;
  readonly clock?: () => number;
}): SecureCredentialBackend {
  const clock = input.clock ?? Date.now;
  const fail = (): never => {
    throw credentialFailure(
      "credential_backend_unavailable",
      "No verified secure credential store is available on this platform.",
      { safeDetails: { backendId: input.backendId, reason: input.reason } },
    );
  };
  return {
    backendId: input.backendId,
    platform: input.platform,
    probe: async (): Promise<CredentialBackendEvidence> => {
      const observedAt = clock();
      return {
        protocol: CREDENTIAL_BACKEND_PROTOCOL,
        backendId: input.backendId,
        platform: input.platform,
        status: "unavailable",
        observedAt,
        expiresAt: observedAt + 5_000,
        source: "backend_absent",
        reason: input.reason,
      };
    },
    read: async () => fail(),
    replace: async () => fail(),
    delete: async () => fail(),
  };
}
