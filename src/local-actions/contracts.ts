export const LOCAL_ACTION_PROTOCOL_VERSION = 1 as const;
export const MAX_LOCAL_ACTION_QUEUE = 16;
export const MAX_LOCAL_ACTION_ARGUMENT_BYTES = 64 * 1024;
export const MAX_LOCAL_ACTION_TTL_MS = 5 * 60 * 1_000;
export const MAX_LOCAL_ACTION_FUTURE_SKEW_MS = 30_000;
export const MAX_LOCAL_ACTION_HISTORY = 128;
export const MAX_LOCAL_ACTION_REPLAY_ENTRIES = 4_096;

export type LocalActionProvider = "claude-code" | "codex" | "opencode";

export type LocalActionKind =
  | "browser.open"
  | "auth.device.present"
  | "auth.callback.relay"
  | "auth.result.observe"
  | "clipboard.write"
  | "port.forward"
  | "file.select"
  | "attachment.import"
  | "artifact.save"
  | "preview.open"
  | "diff.open"
  | "editor.open"
  | "notification.show"
  | "git.sign"
  | "local_service.request"
  | "device.select";

export type LocalActionState =
  | "detected"
  | "validated"
  | "pending_user"
  | "executing"
  | "awaiting_remote_completion"
  | "succeeded"
  | "failed"
  | "denied"
  | "expired"
  | "cancelled";

export type LocalActionSafeReason =
  | "unsupported"
  | "denied_by_policy"
  | "denied_by_user"
  | "stale_identity"
  | "cancelled_by_foreground"
  | "foreground_stopped"
  | "terminal_detached"
  | "terminal_binding_changed"
  | "user_interrupt"
  | "execution_timeout"
  | "request_expired"
  | "adapter_failed"
  | "browser_open_failed"
  | "rate_limited"
  | "local_client_unavailable"
  | "outcome_unknown_nonretryable";

export interface LocalActionSessionIdentity {
  readonly userId: string;
  readonly deviceId: string;
  readonly machineId: string;
  readonly workspaceBindingId: string | null;
  readonly workspaceBindingGeneration: number | null;
  readonly agentSessionId: string;
  readonly processEpoch: string;
  readonly fencingGeneration: number;
}

export type LocalActionArgument = string | number | boolean | null |
  readonly LocalActionArgument[] | { readonly [key: string]: LocalActionArgument };

export interface LocalActionRequest<K extends LocalActionKind = LocalActionKind> {
  readonly version: typeof LOCAL_ACTION_PROTOCOL_VERSION;
  readonly id: string;
  readonly identity: LocalActionSessionIdentity;
  readonly provider: LocalActionProvider;
  readonly kind: K;
  readonly arguments: Readonly<Record<string, LocalActionArgument>>;
  readonly argumentsDigest: `sha256:${string}`;
  readonly requestedScope: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
}

export type LocalActionPolicySource =
  | "project_request_ceiling"
  | "local_device_policy"
  | "interactive_user"
  | "default_deny";

export interface PolicyDecision {
  readonly requestId: string;
  readonly decision: "deny" | "ask" | "allow_once" | "allow_scoped";
  readonly grantedScope: string | null;
  readonly policySource: LocalActionPolicySource;
  readonly decidedAt: number;
}

export interface LocalActionResult<K extends LocalActionKind = LocalActionKind> {
  readonly version: typeof LOCAL_ACTION_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly kind: K;
  readonly identity: LocalActionSessionIdentity;
  readonly status: "succeeded" | "failed" | "denied" | "expired" | "cancelled";
  readonly safeData?: Readonly<Record<string, LocalActionArgument>>;
  readonly safeReason?: LocalActionSafeReason;
  readonly completedAt: number;
}

export interface LocalActionSnapshot<K extends LocalActionKind = LocalActionKind> {
  readonly request: LocalActionRequest<K>;
  readonly state: LocalActionState;
  readonly decision?: PolicyDecision;
  readonly result?: LocalActionResult<K>;
}

export function sameLocalActionIdentity(
  left: LocalActionSessionIdentity,
  right: LocalActionSessionIdentity,
): boolean {
  return left.userId === right.userId &&
    left.deviceId === right.deviceId &&
    left.machineId === right.machineId &&
    left.workspaceBindingId === right.workspaceBindingId &&
    left.workspaceBindingGeneration === right.workspaceBindingGeneration &&
    left.agentSessionId === right.agentSessionId &&
    left.processEpoch === right.processEpoch &&
    left.fencingGeneration === right.fencingGeneration;
}
