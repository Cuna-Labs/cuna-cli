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
  Object.freeze({ feature: "daemon", implementation: "unsupported", reason: "prd_035_runtime_not_implemented" }),
  Object.freeze({
    feature: "terminal_workspace",
    implementation: "unsupported",
    reason: "prd_038_vte_and_attachment_not_implemented",
  }),
  Object.freeze({
    feature: "workspace_sync",
    implementation: "unsupported",
    reason: "prd_032_039_040_protocol_not_implemented",
  }),
  Object.freeze({
    feature: "browser_auth",
    implementation: "unsupported",
    reason: "prd_005_036_server_continuation_not_implemented",
  }),
  Object.freeze({
    feature: "local_companion",
    implementation: "unsupported",
    reason: "prd_041_capability_bridge_not_implemented",
  }),
]);
