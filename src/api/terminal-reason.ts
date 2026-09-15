/** Public terminal reasons are reviewed codes, never provider output. */
export const TERMINAL_REASONS = [
  "process_exited", "process_not_observed", "owner_unrecoverable",
  "opencode_server_exited", "terminal_model_terminated_unobserved",
  "session_executable_allowlist", "session_executable_unavailable",
  "session_executable_permissions", "session_executable_owner",
  "session_executable_location", "canonical_launch_interrupted", "machine_restarted",
] as const;

export type TerminalReason = typeof TERMINAL_REASONS[number];

export function isTerminalReason(value: unknown): value is TerminalReason {
  return typeof value === "string" && TERMINAL_REASONS.some(reason => reason === value);
}
