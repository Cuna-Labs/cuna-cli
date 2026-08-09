export type RuntimeErrorCode =
  | "capability_unknown"
  | "capability_unsupported"
  | "capability_unavailable"
  | "capability_scope_mismatch"
  | "capability_snapshot_expired"
  | "control_plane_unavailable"
  | "remote_state_unproven"
  | "grant_invalid"
  | "grant_expired"
  | "grant_scope_mismatch"
  | "terminal_protocol_error"
  | "terminal_not_ready"
  | "terminal_disconnected"
  | "terminal_timeout"
  | "session_conflict"
  | "session_unknown"
  | "session_discontinuous"
  | "stale_fence"
  | "runtime_closed"
  | "process_invalid"
  | "process_failed"
  | "pty_unavailable"
  | "pty_evidence_invalid";

export class RuntimeBoundaryError extends Error {
  readonly code: RuntimeErrorCode;
  readonly retryable: boolean;
  readonly safeDetails: Readonly<Record<string, string | number | boolean | null>> | undefined;

  constructor(input: {
    readonly code: RuntimeErrorCode;
    readonly message: string;
    readonly retryable?: boolean;
    readonly safeDetails?: Readonly<Record<string, string | number | boolean | null>>;
    readonly cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "RuntimeBoundaryError";
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    this.safeDetails = input.safeDetails;
  }
}

export function runtimeFailure(
  code: RuntimeErrorCode,
  message: string,
  options: {
    readonly retryable?: boolean;
    readonly safeDetails?: Readonly<Record<string, string | number | boolean | null>>;
    readonly cause?: unknown;
  } = {},
): RuntimeBoundaryError {
  return new RuntimeBoundaryError({ code, message, ...options });
}
