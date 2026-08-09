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
  readonly feature: "daemon" | "terminal_workspace" | "workspace_sync" | "browser_auth" | "local_companion";
  readonly implementation: "unsupported" | "available";
  readonly reason: string;
}

export const INITIAL_RUNTIME_GATES: readonly RuntimeFeatureGate[] = Object.freeze([
  Object.freeze({ feature: "daemon", implementation: "unsupported", reason: "daemon_runtime_unavailable" }),
  Object.freeze({
    feature: "terminal_workspace",
    implementation: "unsupported",
    reason: "terminal_workspace_unavailable",
  }),
  Object.freeze({
    feature: "workspace_sync",
    implementation: "unsupported",
    reason: "workspace_sync_protocol_unavailable",
  }),
  Object.freeze({
    feature: "browser_auth",
    implementation: "unsupported",
    reason: "browser_auth_contract_unavailable",
  }),
  Object.freeze({
    feature: "local_companion",
    implementation: "unsupported",
    reason: "local_companion_unavailable",
  }),
]);
