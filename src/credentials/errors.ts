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

const MAXIMUM_CAUSE_DEPTH = 16;

/**
 * Recover the process failure carried anywhere in a bounded `Error.cause`
 * chain. Adapters may add context, but they must not rename a killed or timed
 * out credential helper as missing credentials merely because it crossed a
 * second boundary.
 */
export function credentialProcessFailure(error: unknown): CredentialBoundaryError | undefined {
  const seen = new Set<Error>();
  let current = error;
  for (let depth = 0; depth < MAXIMUM_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    if (
      current instanceof CredentialBoundaryError &&
      (current.code === "credential_process_timeout" || current.code === "credential_process_failed")
    ) {
      return current;
    }
    const process = current as Error & {
      readonly cmd?: unknown;
      readonly code?: unknown;
      readonly killed?: unknown;
      readonly signal?: unknown;
      readonly syscall?: unknown;
    };
    const timedOut = process.code === "ETIMEDOUT" ||
      (process.killed === true && typeof process.signal === "string" && process.signal.length > 0);
    if (timedOut) {
      return credentialFailure(
        "credential_process_timeout",
        "The credential security helper exceeded its bounded deadline.",
        { retryable: true, safeDetails: { reason: "credential_process_timeout" }, cause: current },
      );
    }
    if (typeof process.cmd === "string" || process.syscall === "spawn") {
      return credentialFailure(
        "credential_process_failed",
        "The credential security helper failed before completing its check.",
        { safeDetails: { reason: "credential_process_failed" }, cause: current },
      );
    }
    current = current.cause;
  }
  return undefined;
}
