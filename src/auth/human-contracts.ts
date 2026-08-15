import { EXIT_CODES, CunaError } from "../core/errors.js";
import { OFF_CONTRACT_RESPONSE_HINT } from "../core/product-web.js";
import {
  isAccessToken,
  isBrowserCallbackNonce,
  isLoginCode,
} from "../core/namespace.js";
import { isObject } from "../core/validation.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PROFILE = /^[^\p{Cc}\p{Cf}]{1,80}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

export type CliIntentClass =
  | "signup"
  | "login"
  | "account.read"
  | "machines.read"
  | "machines.create"
  | "agent_sessions.read"
  | "agent_sessions.create";

export interface CliIdentityContext {
  readonly requiredTermsVersion: string;
  readonly identity: "unknown" | "signup_required" | "verification_required" | "active" | "disabled";
  readonly admission: "not_requested" | "waitlisted" | "admitted";
  readonly workspace: { readonly state: "assigned" | "unavailable"; readonly id?: string };
  readonly waitlistPosition?: number;
}

export interface CliAuthBootstrap {
  readonly enabled: boolean;
  readonly completionMode: "paste_login_code";
  readonly pkceMethod: "S256";
  readonly continuationTtlSeconds: 600;
  readonly accessTokenTtlSeconds: 600;
  readonly browserOrigin: string | null;
}

export interface CliSignupCapability {
  readonly enabled: boolean;
  readonly enrollment: "waitlist_only";
  readonly identityMethods: readonly [] | readonly ["email_password", "oauth"];
  readonly reasonCode?: "remote_signup_abuse_controls_unverified";
}

export interface CliContinuationIssued {
  readonly id: string;
  readonly browserUrl: string;
  readonly expiresAt: string;
  readonly completionMode: "paste_login_code";
}

export interface CliLoginCodeExchangeResult {
  readonly accessToken: string;
  readonly tokenType: "Bearer";
  readonly expiresIn: 600;
  readonly accessExpiresAt: string;
  readonly loginCodeExpiresAt: string;
  readonly sessionId: string;
  readonly context: CliIdentityContext;
}

function malformed(reason: string): never {
  throw new CunaError({
    code: "cuna.remote.malformed_response",
    message: "Cuna returned a response that does not match the CLI authentication contract.",
    exitCode: EXIT_CODES.remote,
    hint: OFF_CONTRACT_RESPONSE_HINT,
    // `operation` is absent on purpose: this decoder is reached from several
    // sign-in exchanges and does not receive the request, so naming one would
    // be a guess. `reason` is the predicate under the same key the API path
    // uses, so both halves of this error class read alike.
    details: { predicate: reason },
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
  if (typeof value !== "string" || !RFC3339.test(value) || Number.isNaN(Date.parse(value))) {
    return malformed(reason);
  }
  return new Date(value).toISOString();
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
  if (!new Set(["unknown", "signup_required", "verification_required", "active", "disabled"]).has(identity as string)) {
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
    "enabled", "completion_mode", "pkce_method", "continuation_ttl_seconds",
    "access_token_ttl_seconds", "browser_origin",
  ]);
  if (
    typeof record.enabled !== "boolean" || record.completion_mode !== "paste_login_code" || record.pkce_method !== "S256" ||
    record.continuation_ttl_seconds !== 600 ||
    record.access_token_ttl_seconds !== 600
  ) return malformed("unsupported_bootstrap");
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
    completionMode: "paste_login_code",
    pkceMethod: "S256",
    continuationTtlSeconds: 600,
    accessTokenTtlSeconds: 600,
    browserOrigin,
  });
}

export function decodeCliSignupCapability(value: unknown): CliSignupCapability {
  const record = exact(value, ["enabled", "enrollment", "identity_methods"], ["reason_code"]);
  const methods = record.identity_methods;
  if (
    typeof record.enabled !== "boolean" ||
    record.enrollment !== "waitlist_only" ||
    !Array.isArray(methods) ||
    !(methods.length === 0 ||
      (methods.length === 2 &&
        methods[0] === "email_password" &&
        methods[1] === "oauth")) ||
    (record.reason_code !== undefined &&
      record.reason_code !== "remote_signup_abuse_controls_unverified") ||
    (record.enabled &&
      (record.reason_code !== undefined || methods.length !== 2)) ||
    (!record.enabled && methods.length !== 0) ||
    (!record.enabled && record.reason_code === undefined)
  ) {
    return malformed("invalid_signup_capability");
  }
  return Object.freeze({
    enabled: record.enabled,
    enrollment: "waitlist_only",
    identityMethods: record.enabled
      ? (["email_password", "oauth"] as const)
      : ([] as const),
    ...(record.reason_code === undefined
      ? {}
      : { reasonCode: record.reason_code }),
  });
}

export function decodeCliContinuationIssued(
  value: unknown,
  expected: { readonly browserOrigin: string; readonly state: string },
): CliContinuationIssued {
  const record = exact(value, [
    "id", "browser_url", "expires_at", "completion_mode",
  ]);
  if (record.completion_mode !== "paste_login_code") return malformed("invalid_completion_mode");
  const id = uuid(record.id, "invalid_continuation_id");
  const browserUrl = typeof record.browser_url === "string" ? record.browser_url : malformed("invalid_browser_url");
  let parsed: URL;
  try { parsed = new URL(browserUrl); } catch { return malformed("invalid_browser_url"); }
  if (
    parsed.origin !== expected.browserOrigin ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/cli/continue" ||
    parsed.search !== "" ||
    parsed.hash.length < 2 ||
    parsed.hash.slice(1).includes("?")
  ) {
    return malformed("invalid_browser_url");
  }
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  const fragmentKeys = [...fragment.keys()].sort();
  if (fragmentKeys.join(",") !== "continuation,nonce,state" || fragment.get("continuation") !== id || fragment.get("state") !== expected.state) {
    return malformed("browser_binding_mismatch");
  }
  const browserNonce = fragment.get("nonce");
  if (browserNonce === null || !isBrowserCallbackNonce(browserNonce) || !browserNonce.startsWith("cuna_cb_")) {
    return malformed("invalid_browser_nonce");
  }
  return Object.freeze({
    id,
    browserUrl,
    expiresAt: date(record.expires_at, "invalid_continuation_expiry"),
    completionMode: "paste_login_code",
  });
}

export function decodeCliLoginCodeExchangeResult(
  value: unknown,
  loginCode: string,
  expectedLoginCodeExpiresAt?: string,
): CliLoginCodeExchangeResult {
  const record = exact(value, [
    "access_token", "token_type", "expires_in", "access_expires_at", "login_code_expires_at", "session_id", "context",
  ]);
  if (record.token_type !== "Bearer" || record.expires_in !== 600) return malformed("invalid_token_type_or_ttl");
  const accessToken = typeof record.access_token === "string" && isAccessToken(record.access_token)
    ? record.access_token : malformed("invalid_access_token");
  if (!isLoginCode(loginCode)) return malformed("invalid_login_code");
  const accessExpiresAt = date(record.access_expires_at, "invalid_access_expiry");
  const loginCodeExpiresAt = date(record.login_code_expires_at, "invalid_login_code_expiry");
  if (expectedLoginCodeExpiresAt !== undefined &&
      Date.parse(loginCodeExpiresAt) !== Date.parse(date(expectedLoginCodeExpiresAt, "invalid_expected_login_code_expiry"))) {
    return malformed("login_code_expiry_mismatch");
  }
  if (Date.parse(loginCodeExpiresAt) <= Date.parse(accessExpiresAt)) return malformed("invalid_login_code_expiry_order");
  return Object.freeze({
    accessToken,
    tokenType: "Bearer",
    expiresIn: 600,
    accessExpiresAt,
    loginCodeExpiresAt,
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
