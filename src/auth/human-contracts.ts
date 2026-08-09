import { EXIT_CODES, RunaError } from "../core/errors.js";
import { isObject } from "../core/validation.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE_43 = /^[A-Za-z0-9_-]{43}$/u;
const STATE = /^[A-Za-z0-9_-]{32,128}$/u;
const PROFILE = /^[^\p{Cc}\p{Cf}]{1,80}$/u;

export type CliIntentClass =
  | "login"
  | "account.read"
  | "machines.read"
  | "machines.create"
  | "agent_sessions.read"
  | "agent_sessions.create";

export interface CliIdentityContext {
  readonly requiredTermsVersion: string;
  readonly identity: "unknown" | "verification_required" | "active" | "disabled";
  readonly admission: "not_requested" | "waitlisted" | "admitted";
  readonly workspace: { readonly state: "assigned" | "unavailable"; readonly id?: string };
  readonly waitlistPosition?: number;
}

export interface CliAuthBootstrap {
  readonly enabled: boolean;
  readonly completionMode: "poll";
  readonly pkceMethod: "S256";
  readonly continuationTtlSeconds: 600;
  readonly pollAfterMs: 2000;
  readonly pollLimit: number;
  readonly accessTokenTtlSeconds: 600;
  readonly refreshFamilyTtlSeconds: 2592000;
  readonly browserOrigin: string | null;
}

export interface CliContinuationIssued {
  readonly id: string;
  readonly continuationSecret: string;
  readonly browserUrl: string;
  readonly browserNonce: string;
  readonly expiresAt: string;
  readonly pollAfterMs: number;
  readonly completionMode: "poll";
}

export interface CliContinuationStatus {
  readonly id: string;
  readonly phase: "issued" | "completed" | "cancelled" | "consumed" | "expired";
  readonly expiresAt: string;
  readonly pollAfterMs?: number;
  readonly context?: CliIdentityContext;
  readonly requiredTermsVersion: string;
}

export interface CliTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: "Bearer";
  readonly expiresIn: 600;
  readonly accessExpiresAt: string;
  readonly refreshExpiresAt: string;
  readonly sessionId: string;
  readonly context: CliIdentityContext;
}

function malformed(reason: string): never {
  throw new RunaError({
    code: "runa.remote.malformed_response",
    message: "Runa returned a response that does not match the CLI authentication contract.",
    exitCode: EXIT_CODES.remote,
    details: { reason },
  });
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isObject(value)) return malformed("invalid_object");
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    return malformed("invalid_shape");
  }
  return value;
}

function string(value: unknown, pattern: RegExp, reason: string): string {
  if (typeof value !== "string" || !pattern.test(value)) return malformed(reason);
  return value;
}

function date(value: unknown, reason: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    return malformed(reason);
  }
  return value;
}

function uuid(value: unknown, reason: string): string {
  return string(value, UUID, reason);
}

function boundedInteger(value: unknown, minimum: number, maximum: number, reason: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return malformed(reason);
  }
  return value as number;
}

export function decodeCliIdentityContext(value: unknown): CliIdentityContext {
  const record = exact(
    value,
    ["required_terms_version", "identity", "admission", "workspace"],
    ["waitlist_position"],
  );
  const identity = record.identity;
  if (!new Set(["unknown", "verification_required", "active", "disabled"]).has(identity as string)) {
    return malformed("invalid_identity");
  }
  const admission = record.admission;
  if (!new Set(["not_requested", "waitlisted", "admitted"]).has(admission as string)) {
    return malformed("invalid_admission");
  }
  const workspace = exact(record.workspace, ["state"], ["id"]);
  if (workspace.state !== "assigned" && workspace.state !== "unavailable") return malformed("invalid_workspace_state");
  const workspaceId = workspace.id === undefined ? undefined : uuid(workspace.id, "invalid_workspace_id");
  if (workspace.state === "assigned" && workspaceId === undefined) return malformed("assigned_workspace_missing_id");
  if (workspace.state === "unavailable" && workspaceId !== undefined) return malformed("unavailable_workspace_has_id");
  const waitlistPosition = record.waitlist_position === undefined
    ? undefined
    : boundedInteger(record.waitlist_position, 0, Number.MAX_SAFE_INTEGER, "invalid_waitlist_position");
  return Object.freeze({
    requiredTermsVersion: string(record.required_terms_version, PROFILE, "invalid_terms_version"),
    identity: identity as CliIdentityContext["identity"],
    admission: admission as CliIdentityContext["admission"],
    workspace: Object.freeze({ state: workspace.state, ...(workspaceId === undefined ? {} : { id: workspaceId }) }),
    ...(waitlistPosition === undefined ? {} : { waitlistPosition }),
  });
}

export function decodeCliAuthBootstrap(value: unknown): CliAuthBootstrap {
  const record = exact(value, [
    "enabled", "completion_mode", "pkce_method", "continuation_ttl_seconds", "poll_after_ms",
    "poll_limit", "access_token_ttl_seconds", "refresh_family_ttl_seconds", "browser_origin",
  ]);
  if (
    typeof record.enabled !== "boolean" || record.completion_mode !== "poll" || record.pkce_method !== "S256" ||
    record.continuation_ttl_seconds !== 600 || record.poll_after_ms !== 2000 ||
    record.access_token_ttl_seconds !== 600 || record.refresh_family_ttl_seconds !== 2592000
  ) return malformed("unsupported_bootstrap");
  const pollLimit = boundedInteger(record.poll_limit, 1, 120, "invalid_poll_limit");
  let browserOrigin: string | null = null;
  if (record.browser_origin !== null) {
    if (typeof record.browser_origin !== "string") return malformed("invalid_browser_origin");
    let parsed: URL;
    try { parsed = new URL(record.browser_origin); } catch { return malformed("invalid_browser_origin"); }
    if (parsed.protocol !== "https:" || parsed.origin !== record.browser_origin || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return malformed("invalid_browser_origin");
    }
    browserOrigin = parsed.origin;
  }
  if (record.enabled !== (browserOrigin !== null)) return malformed("bootstrap_authority_inconsistent");
  return Object.freeze({
    enabled: record.enabled,
    completionMode: "poll",
    pkceMethod: "S256",
    continuationTtlSeconds: 600,
    pollAfterMs: 2000,
    pollLimit,
    accessTokenTtlSeconds: 600,
    refreshFamilyTtlSeconds: 2592000,
    browserOrigin,
  });
}

export function decodeCliContinuationIssued(
  value: unknown,
  expected: { readonly browserOrigin: string; readonly state: string },
): CliContinuationIssued {
  const record = exact(value, [
    "id", "continuation_secret", "browser_url", "expires_at", "poll_after_ms", "completion_mode",
  ]);
  if (record.completion_mode !== "poll") return malformed("invalid_completion_mode");
  const id = uuid(record.id, "invalid_continuation_id");
  const continuationSecret = `runa_ct_${string(
    typeof record.continuation_secret === "string" ? record.continuation_secret.slice(8) : record.continuation_secret,
    OPAQUE_43,
    "invalid_continuation_secret",
  )}`;
  if (record.continuation_secret !== continuationSecret) return malformed("invalid_continuation_secret");
  const browserUrl = typeof record.browser_url === "string" ? record.browser_url : malformed("invalid_browser_url");
  let parsed: URL;
  try { parsed = new URL(browserUrl); } catch { return malformed("invalid_browser_url"); }
  if (parsed.origin !== expected.browserOrigin || parsed.pathname !== "/cli/continue" || parsed.search !== "" || parsed.hash.length < 2) {
    return malformed("invalid_browser_url");
  }
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  const fragmentKeys = [...fragment.keys()].sort();
  if (fragmentKeys.join(",") !== "continuation,nonce,state" || fragment.get("continuation") !== id || fragment.get("state") !== expected.state) {
    return malformed("browser_binding_mismatch");
  }
  const browserNonce = fragment.get("nonce");
  if (browserNonce === null || !/^runa_cb_[A-Za-z0-9_-]{43}$/u.test(browserNonce)) {
    return malformed("invalid_browser_nonce");
  }
  return Object.freeze({
    id,
    continuationSecret,
    browserUrl,
    browserNonce,
    expiresAt: date(record.expires_at, "invalid_continuation_expiry"),
    pollAfterMs: boundedInteger(record.poll_after_ms, 2000, 120_000, "invalid_poll_interval"),
    completionMode: "poll",
  });
}

export function decodeCliContinuationStatus(value: unknown, expectedId: string): CliContinuationStatus {
  const record = exact(value, ["id", "phase", "expires_at", "required_terms_version"], ["poll_after_ms", "context"]);
  const id = uuid(record.id, "invalid_continuation_id");
  if (id !== expectedId) return malformed("continuation_id_mismatch");
  if (!new Set(["issued", "completed", "cancelled", "consumed", "expired"]).has(record.phase as string)) {
    return malformed("invalid_continuation_phase");
  }
  const pollAfterMs = record.poll_after_ms === undefined
    ? undefined
    : boundedInteger(record.poll_after_ms, 2000, 120_000, "invalid_poll_interval");
  return Object.freeze({
    id,
    phase: record.phase as CliContinuationStatus["phase"],
    expiresAt: date(record.expires_at, "invalid_continuation_expiry"),
    ...(pollAfterMs === undefined ? {} : { pollAfterMs }),
    ...(record.context === undefined ? {} : { context: decodeCliIdentityContext(record.context) }),
    requiredTermsVersion: string(record.required_terms_version, PROFILE, "invalid_terms_version"),
  });
}

export function decodeCliTokenSet(value: unknown): CliTokenSet {
  const record = exact(value, [
    "access_token", "refresh_token", "token_type", "expires_in", "access_expires_at",
    "refresh_expires_at", "session_id", "context",
  ]);
  if (record.token_type !== "Bearer" || record.expires_in !== 600) return malformed("invalid_token_type_or_ttl");
  const accessToken = typeof record.access_token === "string" && /^runa_at_[A-Za-z0-9_-]{43}$/u.test(record.access_token)
    ? record.access_token : malformed("invalid_access_token");
  const refreshToken = typeof record.refresh_token === "string" && /^runa_rt_[A-Za-z0-9_-]{43}$/u.test(record.refresh_token)
    ? record.refresh_token : malformed("invalid_refresh_token");
  const accessExpiresAt = date(record.access_expires_at, "invalid_access_expiry");
  const refreshExpiresAt = date(record.refresh_expires_at, "invalid_refresh_expiry");
  if (Date.parse(refreshExpiresAt) <= Date.parse(accessExpiresAt)) return malformed("invalid_token_expiry_order");
  return Object.freeze({
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    expiresIn: 600,
    accessExpiresAt,
    refreshExpiresAt,
    sessionId: uuid(record.session_id, "invalid_session_id"),
    context: decodeCliIdentityContext(record.context),
  });
}

export function decodeRevocation(value: unknown): true {
  const record = exact(value, ["revoked"]);
  if (record.revoked !== true) return malformed("invalid_revocation_receipt");
  return true;
}

export function assertUuid(value: string, label: string): string {
  if (!UUID.test(value)) throw new TypeError(`Invalid ${label}.`);
  return value;
}

export function assertProfile(value: string): string {
  if (!PROFILE.test(value) || value.trim() !== value) throw new TypeError("Invalid profile.");
  return value;
}
