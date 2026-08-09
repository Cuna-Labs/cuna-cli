export type CredentialErrorCode =
  | "credential_backend_unavailable"
  | "credential_backend_unverified"
  | "credential_backend_failure"
  | "credential_binding_invalid"
  | "credential_corrupt"
  | "credential_missing"
  | "credential_revision_conflict"
  | "credential_refresh_failed"
  | "credential_revoked"
  | "credential_process_failed"
  | "credential_process_timeout"
  | "credential_output_oversized";

export class CredentialBoundaryError extends Error {
  readonly code: CredentialErrorCode;
  readonly retryable: boolean;
  readonly safeDetails: Readonly<Record<string, string | number | boolean | null>> | undefined;

  constructor(input: {
    readonly code: CredentialErrorCode;
    readonly message: string;
    readonly retryable?: boolean;
    readonly safeDetails?: Readonly<Record<string, string | number | boolean | null>>;
    readonly cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "CredentialBoundaryError";
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    this.safeDetails = input.safeDetails;
  }
}

export function credentialFailure(
  code: CredentialErrorCode,
  message: string,
  options: {
    readonly retryable?: boolean;
    readonly safeDetails?: Readonly<Record<string, string | number | boolean | null>>;
    readonly cause?: unknown;
  } = {},
): CredentialBoundaryError {
  return new CredentialBoundaryError({ code, message, ...options });
}
