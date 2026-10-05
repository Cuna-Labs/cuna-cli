/** Public terminal reasons are reviewed codes, never provider output. */
export const TERMINAL_REASONS = [
  "process_exited", "process_not_observed", "owner_unrecoverable",
  "opencode_server_exited", "terminal_model_terminated_unobserved",
  "session_executable_allowlist", "session_executable_unavailable",
  "session_executable_permissions", "session_executable_owner",
  "session_executable_location",
  // Producer 2e4e1a2 (migration 0233) publishes this one; the vendored
  // 7b1b3e42 contract predates it. Without it a memory refusal, the clearest
  // failure the server can name, decoded as a malformed response.
  "session_capacity_memory",
  "canonical_launch_interrupted", "machine_restarted",
] as const;

export type TerminalReason = typeof TERMINAL_REASONS[number];

export function isTerminalReason(value: unknown): value is TerminalReason {
  return typeof value === "string" && TERMINAL_REASONS.some(reason => reason === value);
}
