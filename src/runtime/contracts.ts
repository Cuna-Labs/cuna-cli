export type TruthState = "unknown" | "unavailable" | "reconciling" | "verified";

export type DaemonState =
  | "unsupported"
  | "absent"
  | "starting"
  | "ready"
  | "degraded"
  | "reconciling"
  | "recovery_required"
  | "stopped";

export type TerminalWorkspaceState =
  | "unsupported"
  | "starting"
  | "empty"
  | "attaching"
  | "active"
  | "navigation"
  | "reconnecting"
  | "degraded"
  | "restoring";

export type SyncSupervisorState =
  | "unsupported"
  | "starting"
  | "recovering"
  | "reconciling"
  | "catching_up"
  | "live_unverified"
  | "converged"
  | "conflicted"
  | "paused"
  | "recovery_required"
  | "unknown";

export interface RuntimeFeatureGate {
  readonly feature:
    | "daemon"
    | "terminal_workspace"
    | "workspace_sync"
    | "browser_auth"
    | "browser_login_remote"
    | "local_companion"
    | "encrypted_local_session_store";
  readonly implementation: "unsupported" | "available";
  readonly reason: string;
}

export function runtimeFeatureGates(input: {
  readonly platform: "windows" | "macos" | "linux";
  readonly credentialBackendStatus: "verified" | "unavailable" | "unknown";
  readonly credentialBackendId?: string;
  readonly credentialBackendReason?: string;
  /**
   * The anonymous `/v1/cli-auth/bootstrap` observation. It is intentionally
   * absent from the default `doctor` invocation: proving a local AES store
   * must never imply that the configured deployment currently serves browser
   * login.
   */
  readonly browserLoginRemoteStatus?: "verified" | "unavailable" | "unknown" | "not_checked";
  readonly browserLoginRemoteReason?: string;
}): readonly RuntimeFeatureGate[] {
  const remoteStatus = input.browserLoginRemoteStatus ?? "not_checked";
  const remoteReason = remoteStatus === "verified"
    ? "remote_browser_login_bootstrap_verified"
    : input.browserLoginRemoteReason ?? `remote_browser_login_${remoteStatus}`;
  const browserAuthAvailable = input.credentialBackendStatus === "verified" && remoteStatus === "verified";
  const browserReason = input.credentialBackendStatus !== "verified"
    ? input.credentialBackendReason ?? `encrypted_local_session_${input.credentialBackendStatus}`
    : remoteStatus !== "verified"
      ? remoteReason
      : "browser_login_remote_and_encrypted_local_verified";
  return Object.freeze([
    Object.freeze({ feature: "daemon", implementation: "unsupported", reason: "daemon_runtime_unavailable" }),
    Object.freeze({
      feature: "terminal_workspace",
      implementation: "available",
      // This is deliberately a local-build claim. Every attach still requires
      // fresh producer capability, AgentSession identity, runtime-state and
      // one-use grant evidence before the terminal takes ownership.
      reason: "foreground_exact_session_composed_live_producer_required",
    }),
    Object.freeze({
      feature: "workspace_sync",
      implementation: "available",
      // The shipped journey composes the authoritative initial commit and the
      // sole-writer continuous supervisor. A producer that does not serve the
      // protocol still fails the invocation closed; doctor does not pretend to
      // have probed a remote deployment.
      reason: "initial_and_continuous_sync_composed_live_producer_required",
    }),
    Object.freeze({
      feature: "browser_auth",
      implementation: browserAuthAvailable ? "available" : "unsupported",
      reason: browserReason,
    }),
    // This is deliberately separate from `encrypted_local_session_store`.
    // The former is an explicit anonymous deployment observation; the latter
    // is a local filesystem/cryptography probe. Neither one implies the other.
    Object.freeze({
      feature: "browser_login_remote",
      implementation: remoteStatus === "verified" ? "available" : "unsupported",
      reason: remoteReason,
    }),
    Object.freeze({
      feature: "local_companion",
      implementation: "unsupported",
      reason: "local_companion_unavailable",
    }),
    // Browser login persists only the reusable login-code envelope in the
    // pure-JavaScript AES-256-GCM store. Its local availability is a filesystem
    // and cryptography fact, not an operating-system credential-store claim.
    Object.freeze({
      feature: "encrypted_local_session_store",
      implementation: input.credentialBackendStatus === "verified" ? "available" : "unsupported",
      reason: input.credentialBackendStatus === "verified"
        ? "encrypted_local_aes256gcm_verified"
        : input.credentialBackendReason ??
          `encrypted_local_session_${input.credentialBackendStatus}${input.credentialBackendId === undefined ? "" : ` (${input.credentialBackendId})`}`,
    }),
  ]);
}

export const INITIAL_RUNTIME_GATES: readonly RuntimeFeatureGate[] = runtimeFeatureGates({
  platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
  credentialBackendStatus: "unknown",
});
