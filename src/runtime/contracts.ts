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
    | "local_companion"
    | "credential_vault";
  readonly implementation: "unsupported" | "available";
  readonly reason: string;
}

export function runtimeFeatureGates(input: {
  readonly platform: "windows" | "macos" | "linux";
  readonly credentialBackendStatus: "verified" | "unavailable" | "unknown";
  readonly credentialBackendId?: string;
  readonly credentialBackendReason?: string;
}): readonly RuntimeFeatureGate[] {
  const browserCommandAvailable = input.platform !== "windows";
  const browserAuthAvailable = browserCommandAvailable && input.credentialBackendStatus === "verified";
  const browserReason = !browserCommandAvailable
    ? "signed_windows_browser_adapter_unavailable"
    : input.credentialBackendStatus !== "verified"
      ? `secure_vault_${input.credentialBackendStatus}`
      : "polling_continuation_v1_3";
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
    Object.freeze({
      feature: "local_companion",
      implementation: "unsupported",
      reason: "local_companion_unavailable",
    }),
    // The credential vault is the precondition for every authenticated command,
    // and it was the one subsystem `doctor` did not report. Its failure surfaced
    // only as `secure_vault_unavailable` on browser_auth, which reads as a
    // browser problem. The backend's own reason is carried through verbatim so
    // the operator can tell "not installed" from "identity does not match".
    Object.freeze({
      feature: "credential_vault",
      implementation: input.credentialBackendStatus === "verified" ? "available" : "unsupported",
      reason: input.credentialBackendReason ??
        `secure_vault_${input.credentialBackendStatus}${input.credentialBackendId === undefined ? "" : ` (${input.credentialBackendId})`}`,
    }),
  ]);
}

export const INITIAL_RUNTIME_GATES: readonly RuntimeFeatureGate[] = runtimeFeatureGates({
  platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
  credentialBackendStatus: "unknown",
});
