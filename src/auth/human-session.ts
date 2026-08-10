import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { EffectiveConfig } from "../config/config.js";
import { EXIT_CODES, RunaError } from "../core/errors.js";
import type { CredentialBinding } from "../credentials/contracts.js";
import { CredentialBoundaryError } from "../credentials/errors.js";
import { SecretMaterial } from "../credentials/secret-material.js";
import { CredentialVault } from "../credentials/vault.js";
import type { BrowserOpener } from "./browser.js";
import type { HumanAuthClient } from "./human-client.js";
import {
  assertProfile,
  assertUuid,
  decodeCliIdentityContext,
  type CliIdentityContext,
  type CliIntentClass,
  type CliTokenSet,
} from "./human-contracts.js";
import { createPkceAuthorization } from "./pkce.js";

interface StoredHumanSession {
  readonly version: 2;
  readonly baseUrl: string;
  readonly profile: string;
  readonly clientInstanceId: string;
  readonly sessionId: string;
  readonly refreshToken: string;
  readonly refreshExpiresAt: string;
  readonly context: CliIdentityContext;
  readonly intentClass: CliIntentClass;
}

// Managed-runtime boundary: HumanAuthClient and HTTP Authorization currently
// require JavaScript strings, which cannot be deterministically zeroized. This
// service therefore converts the only long-lived access-token copy to
// SecretMaterial immediately and creates a string only at the call boundary.
// End-to-end zeroization requires a future opaque/byte-backed HTTP client
// contract; claiming it under the current string contract would be false.

export interface HumanAuthResult {
  readonly profile: string;
  readonly sessionId: string;
  readonly context: CliIdentityContext;
}

export interface HumanAuthService {
  login(input?: { readonly intentClass?: CliIntentClass; readonly signal?: AbortSignal }): Promise<HumanAuthResult>;
  signup(input?: { readonly signal?: AbortSignal }): Promise<HumanAuthResult>;
  acquireAccessToken(signal?: AbortSignal): Promise<string>;
  whoami(signal?: AbortSignal): Promise<HumanAuthResult>;
  logout(signal?: AbortSignal): Promise<{ readonly revoked: true }>;
}

type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
type RandomSource = (size: number) => Uint8Array;

function authError(code: string, message: string, options: {
  readonly retryable?: boolean;
  readonly hint?: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
} = {}): RunaError {
  return new RunaError({ code, message, exitCode: EXIT_CODES.auth, ...options });
}

function binding(config: EffectiveConfig): CredentialBinding {
  return Object.freeze({
    profileId: config.profile,
    accountId: config.baseUrl,
    workspaceId: "cli-human-auth",
    kind: "refresh-session-v1",
  });
}

function contextWire(context: CliIdentityContext): unknown {
  return {
    required_terms_version: context.requiredTermsVersion,
    identity: context.identity,
    admission: context.admission,
    workspace: { state: context.workspace.state, ...(context.workspace.id === undefined ? {} : { id: context.workspace.id }) },
    ...(context.waitlistPosition === undefined ? {} : { waitlist_position: context.waitlistPosition }),
  };
}

function encodeStored(session: StoredHumanSession): SecretMaterial {
  return SecretMaterial.fromUtf8(JSON.stringify({
    version: session.version,
    base_url: session.baseUrl,
    profile: session.profile,
    client_instance_id: session.clientInstanceId,
    session_id: session.sessionId,
    refresh_token: session.refreshToken,
    refresh_expires_at: session.refreshExpiresAt,
    context: contextWire(session.context),
    intent_class: session.intentClass,
  }));
}

function decodeStored(bytes: Uint8Array, config: EffectiveConfig): StoredHumanSession {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch {
    throw authError("runa.auth.session_corrupt", "The protected Cuna sign-in session is malformed.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw authError("runa.auth.session_corrupt", "The protected Cuna sign-in session is malformed.");
  }
  const record = parsed as Record<string, unknown>;
  const legacy = record.version === 1;
  const expected = legacy
    ? [
        "base_url", "client_instance_id", "context", "profile",
        "refresh_expires_at", "refresh_token", "session_id", "version",
      ]
    : [
        "base_url", "client_instance_id", "context", "intent_class", "profile",
        "refresh_expires_at", "refresh_token", "session_id", "version",
      ];
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw authError("runa.auth.session_corrupt", "The protected Cuna sign-in session has an invalid shape.");
  }
  if (
    (!legacy && record.version !== 2) ||
    record.base_url !== config.baseUrl || record.profile !== config.profile ||
    typeof record.refresh_token !== "string" || !/^(?:cuna|runa)_rt_[A-Za-z0-9_-]{43}$/u.test(record.refresh_token) ||
    typeof record.refresh_expires_at !== "string" || Number.isNaN(Date.parse(record.refresh_expires_at)) ||
    new Date(record.refresh_expires_at).toISOString() !== record.refresh_expires_at ||
    typeof record.client_instance_id !== "string" || typeof record.session_id !== "string" ||
    (!legacy && !new Set<CliIntentClass>([
        "signup", "login", "account.read", "machines.read", "machines.create",
        "agent_sessions.read", "agent_sessions.create",
      ]).has(record.intent_class as CliIntentClass))
  ) {
    throw authError("runa.auth.session_corrupt", "The protected Cuna sign-in session failed validation.");
  }
  return Object.freeze({
    version: 2,
    baseUrl: config.baseUrl,
    profile: assertProfile(config.profile),
    clientInstanceId: assertUuid(record.client_instance_id, "client instance ID"),
    sessionId: assertUuid(record.session_id, "session ID"),
    refreshToken: record.refresh_token,
    refreshExpiresAt: record.refresh_expires_at,
    context: decodeCliIdentityContext(record.context),
    intentClass: legacy ? "login" : record.intent_class as CliIntentClass,
  });
}

function storedFromTokens(
  config: EffectiveConfig,
  clientInstanceId: string,
  tokens: CliTokenSet,
  intentClass: CliIntentClass,
): StoredHumanSession {
  return Object.freeze({
    version: 2,
    baseUrl: config.baseUrl,
    profile: config.profile,
    clientInstanceId,
    sessionId: tokens.sessionId,
    refreshToken: tokens.refreshToken,
    refreshExpiresAt: tokens.refreshExpiresAt,
    context: tokens.context,
    intentClass,
  });
}

function stableRefreshIdempotency(session: StoredHumanSession): string {
  const digest = createHash("sha256")
    .update("runa-cli-refresh-v1\0", "utf8")
    .update(session.refreshToken, "utf8")
    .update("\0", "utf8")
    .update(session.clientInstanceId, "ascii")
    .update("\0", "utf8")
    .update(session.profile, "utf8")
    .digest("base64url");
  return `refresh-${digest}`;
}

function isAuthoritativeRefreshRejection(error: unknown): boolean {
  if (!(error instanceof RunaError)) return false;
  const reason = error.details?.reason;
  return error.code === "runa.auth.rejected" ||
    reason === "cli_auth_rejected" || reason === "cli_refresh_reuse" ||
    reason === "cli_session_revoked" || reason === "terms_version_mismatch";
}

function ensureOnboardingReady(context: CliIdentityContext): void {
  if (context.identity === "active" && context.admission === "admitted" && context.workspace.state === "assigned") return;
  throw authError(
    "runa.auth.onboarding_incomplete",
    "Cuna sign-in completed, but the account is not ready for CLI work.",
    { hint: "Finish identity verification, admission, terms, and workspace assignment in the browser." },
  );
}

function ensureSignupContext(
  context: CliIdentityContext,
  allowAdmitted: boolean,
): void {
  const waitlisted =
    context.identity === "active" &&
    context.admission === "waitlisted" &&
    context.workspace.state === "unavailable";
  const admitted =
    allowAdmitted &&
    context.identity === "active" &&
    context.admission === "admitted" &&
    context.workspace.state === "assigned" &&
    context.workspace.id !== undefined;
  if (waitlisted || admitted) return;
  throw authError(
    "runa.auth.signup_state_invalid",
    "Cuna could not prove a valid waitlist-only signup state.",
  );
}

function signupContextTransitionAllowed(
  previous: CliIdentityContext,
  next: CliIdentityContext,
): boolean {
  if (
    previous.requiredTermsVersion !== next.requiredTermsVersion ||
    previous.identity !== "active" ||
    next.identity !== "active"
  ) {
    return false;
  }
  if (previous.admission === "waitlisted") {
    return (
      next.admission === "waitlisted" &&
      previous.workspace.state === "unavailable" &&
      next.workspace.state === "unavailable"
    ) || (
      next.admission === "admitted" &&
      previous.workspace.state === "unavailable" &&
      next.workspace.state === "assigned" &&
      next.workspace.id !== undefined
    );
  }
  return previous.admission === "admitted" &&
    next.admission === "admitted" &&
    previous.workspace.state === "assigned" &&
    next.workspace.state === "assigned" &&
    previous.workspace.id !== undefined &&
    previous.workspace.id === next.workspace.id;
}

function randomLoopbackUri(random: RandomSource): string {
  const bytes = random(2);
  if (bytes.byteLength !== 2) throw new Error("Invalid cryptographic random source.");
  const port = 49152 + (((bytes[0] ?? 0) << 8 | (bytes[1] ?? 0)) % 16384);
  return `http://127.0.0.1:${port}/callback`;
}

export function createHumanAuthService(input: {
  readonly config: EffectiveConfig;
  readonly client: HumanAuthClient;
  readonly vault: CredentialVault;
  readonly browser: BrowserOpener;
  readonly clock?: () => number;
  readonly sleep?: Sleep;
  readonly random?: RandomSource;
  readonly uuid?: () => string;
}): HumanAuthService {
  const clock = input.clock ?? Date.now;
  const random = input.random ?? randomBytes;
  const sleep: Sleep = input.sleep ?? (async (milliseconds, signal) => {
    await delay(milliseconds, undefined, { signal });
  });
  const credentialBinding = binding(input.config);
  let lastObservedNow: number | undefined;
  let access: { readonly material: SecretMaterial; readonly expiresAt: number } | undefined;
  let refreshFlight: Promise<void> | undefined;

  function now(): number {
    const observed = clock();
    if (!Number.isSafeInteger(observed) || observed < 0 || (lastObservedNow !== undefined && observed < lastObservedNow)) {
      throw authError("runa.auth.clock_untrusted", "The local authentication clock is not trustworthy.");
    }
    lastObservedNow = observed;
    return observed;
  }

  function cacheAccessToken(token: string, expiresAt: number): boolean {
    if (!Number.isSafeInteger(expiresAt) || expiresAt - now() <= 30_000) return false;
    const material = SecretMaterial.fromUtf8(token);
    access?.material.dispose();
    access = { material, expiresAt };
    return true;
  }

  function cachedAccessToken(): string {
    if (access === undefined || access.expiresAt - now() <= 30_000) {
      throw authError("runa.auth.refresh_unknown", "Cuna could not establish a fresh in-memory access token.", { retryable: true });
    }
    return access.material.withBytes((bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }

  async function cancelBestEffort(id: string, secret: string): Promise<void> {
    try { await input.client.cancel({ id, secret }); } catch { /* unknown cancellation remains server-expiring */ }
  }

  function assertNotCancelled(signal?: AbortSignal): void {
    if (signal?.aborted === true) {
      throw authError("runa.auth.cancelled", "Cuna sign-in was cancelled.");
    }
  }

  async function waitForRefresh(flight: Promise<void>, signal?: AbortSignal): Promise<void> {
    assertNotCancelled(signal);
    if (signal === undefined) return await flight;
    return await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        signal.removeEventListener("abort", abort);
        reject(authError("runa.auth.cancelled", "Cuna sign-in was cancelled."));
      };
      signal.addEventListener("abort", abort, { once: true });
      void flight.then(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  }

  async function login(request: { readonly intentClass?: CliIntentClass; readonly signal?: AbortSignal } = {}): Promise<HumanAuthResult> {
    const intentClass = request.intentClass ?? "login";
    assertNotCancelled(request.signal);
    const vaultStatus = await input.vault.status(credentialBinding);
    if (vaultStatus.backendStatus !== "verified") {
      throw authError(
        "runa.auth.vault_unavailable",
        "Interactive sign-in requires the verified operating-system credential vault.",
      );
    }
    if (vaultStatus.state === "present") {
      throw authError(
        "runa.auth.already_signed_in",
        "This Cuna profile already has an interactive session.",
        { hint: "Run `cuna logout` before signing in again." },
      );
    }
    if (vaultStatus.state === "corrupt") {
      throw authError(
        "runa.auth.session_corrupt",
        "The protected Cuna session is corrupt and cannot be replaced implicitly.",
        { hint: "Remove the damaged credential through the operating-system credential manager." },
      );
    }
    const bootstrap = await input.client.bootstrap(request.signal);
    if (!bootstrap.enabled || bootstrap.browserOrigin === null) {
      throw authError("runa.auth.unavailable", "Interactive Cuna sign-in is not enabled for this environment.");
    }
    if (intentClass === "signup") {
      const signup = await input.client.signupCapability(request.signal);
      if (!signup.enabled || signup.enrollment !== "waitlist_only") {
        throw authError(
          "runa.auth.signup_unavailable",
          "Waitlist-only self-service signup is not enabled for this environment.",
        );
      }
    }
    const pkce = createPkceAuthorization(random);
    const clientInstanceId = assertUuid((input.uuid ?? randomUUID)(), "client instance ID");
    const redirectUri = randomLoopbackUri(random);
    const issued = await input.client.createContinuation({
      state: pkce.state,
      codeChallenge: pkce.challenge,
      redirectUri,
      clientInstanceId,
      profile: input.config.profile,
      intentClass,
      browserOrigin: bootstrap.browserOrigin,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    try {
      if (Date.parse(issued.expiresAt) <= now()) {
        throw authError("runa.auth.continuation_expired", "Cuna issued an already-expired sign-in continuation.");
      }
      await input.browser.open(issued.browserUrl);
      let interval = Math.max(bootstrap.pollAfterMs, issued.pollAfterMs);
      for (let attempt = 0; attempt < bootstrap.pollLimit; attempt += 1) {
        if (request.signal?.aborted) throw authError("runa.auth.cancelled", "Cuna sign-in was cancelled.");
        const remaining = Date.parse(issued.expiresAt) - now();
        if (remaining <= 0) break;
        try { await sleep(Math.min(interval, remaining), request.signal); } catch {
          if (request.signal?.aborted) throw authError("runa.auth.cancelled", "Cuna sign-in was cancelled.");
          throw authError("runa.auth.poll_failed", "Cuna could not continue sign-in polling.", { retryable: true });
        }
        const status = await input.client.continuation({
          id: issued.id,
          secret: issued.continuationSecret,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        if (Date.parse(status.expiresAt) !== Date.parse(issued.expiresAt)) {
          throw authError("runa.auth.continuation_mismatch", "Cuna returned contradictory continuation authority.");
        }
        if (status.phase === "issued") {
          interval = Math.max(bootstrap.pollAfterMs, status.pollAfterMs ?? interval);
          continue;
        }
        if (status.phase === "cancelled") throw authError("runa.auth.cancelled", "Cuna sign-in was cancelled.");
        if (status.phase === "expired") throw authError("runa.auth.continuation_expired", "Cuna sign-in expired.");
        if (status.phase === "consumed") throw authError("runa.auth.continuation_consumed", "This Cuna sign-in was already exchanged.");
        const tokens = await input.client.exchange({
          id: issued.id,
          continuationSecret: issued.continuationSecret,
          state: pkce.state,
          codeVerifier: pkce.verifier,
          redirectUri,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        try {
          const exchangedAt = now();
          if (Date.parse(tokens.refreshExpiresAt) <= exchangedAt || Date.parse(tokens.accessExpiresAt) <= exchangedAt) {
            throw authError("runa.auth.token_expired", "Cuna returned an already-expired sign-in session.");
          }
          if (
            tokens.context.requiredTermsVersion !== status.requiredTermsVersion ||
            (status.context !== undefined &&
              JSON.stringify(contextWire(status.context)) !== JSON.stringify(contextWire(tokens.context)))
          ) {
            throw authError("runa.auth.context_mismatch", "Cuna returned contradictory sign-in context authority.");
          }
          if (intentClass === "signup") {
            ensureSignupContext(tokens.context, false);
          } else {
            ensureOnboardingReady(tokens.context);
          }
          const stored = storedFromTokens(
            input.config,
            clientInstanceId,
            tokens,
            intentClass,
          );
          const material = encodeStored(stored);
          try {
            await input.vault.rotate({
              binding: credentialBinding,
              material,
              expiresAt: Date.parse(stored.refreshExpiresAt),
            });
          } finally { material.dispose(); }
          cacheAccessToken(tokens.accessToken, Date.parse(tokens.accessExpiresAt));
          return Object.freeze({ profile: stored.profile, sessionId: stored.sessionId, context: stored.context });
        } catch (error) {
          try { await input.client.logout(tokens.accessToken); } catch { /* family remains server-expiring */ }
          throw error;
        }
      }
      throw authError("runa.auth.timeout", "Cuna sign-in did not complete within its bounded polling window.", { retryable: true });
    } catch (error) {
      await cancelBestEffort(issued.id, issued.continuationSecret);
      throw error;
    }
  }

  async function refreshAccess(signal?: AbortSignal): Promise<void> {
    assertNotCancelled(signal);
    let captured: { readonly material: SecretMaterial; readonly expiresAt: number } | undefined;
    const existing = await input.vault.load(credentialBinding);
    if (existing === undefined) {
      throw authError("runa.auth.required", "No interactive Cuna session is stored.", { hint: "Run `cuna login`." });
    }
    existing.material.dispose();
    try {
      const snapshot = await input.vault.refresh(credentialBinding, async (current) => {
        if (current === undefined) {
          throw authError("runa.auth.required", "No interactive Cuna session is stored.", { hint: "Run `cuna login`." });
        }
        const stored = current.material.withBytes((bytes) => decodeStored(bytes, input.config));
        if (Date.parse(stored.refreshExpiresAt) <= now()) {
          return { status: "rejected" } as const;
        }
        try {
          const tokens = await input.client.refresh({
            refreshToken: stored.refreshToken,
            clientInstanceId: stored.clientInstanceId,
            profile: stored.profile,
            idempotencyKey: stableRefreshIdempotency(stored),
            ...(signal === undefined ? {} : { signal }),
          });
          const refreshedAt = now();
          if (
            tokens.sessionId !== stored.sessionId ||
            tokens.refreshToken === stored.refreshToken ||
            (stored.intentClass === "signup"
              ? !signupContextTransitionAllowed(stored.context, tokens.context)
              : JSON.stringify(contextWire(tokens.context)) !== JSON.stringify(contextWire(stored.context))) ||
            Date.parse(tokens.refreshExpiresAt) <= refreshedAt ||
            Date.parse(tokens.accessExpiresAt) <= refreshedAt
          ) {
            try { await input.client.logout(tokens.accessToken, signal); } catch { /* best-effort family cleanup */ }
            return { status: "rejected" } as const;
          }
          try {
            if (stored.intentClass === "signup") {
              ensureSignupContext(tokens.context, true);
            } else {
              ensureOnboardingReady(tokens.context);
            }
          } catch {
            try { await input.client.logout(tokens.accessToken, signal); } catch { /* best-effort family cleanup */ }
            return { status: "rejected" } as const;
          }
          captured?.material.dispose();
          captured = { material: SecretMaterial.fromUtf8(tokens.accessToken), expiresAt: Date.parse(tokens.accessExpiresAt) };
          return {
            status: "rotated",
            material: encodeStored(storedFromTokens(
              input.config,
              stored.clientInstanceId,
              tokens,
              stored.intentClass,
            )),
            expiresAt: Date.parse(tokens.refreshExpiresAt),
          } as const;
        } catch (error) {
          if (isAuthoritativeRefreshRejection(error)) return { status: "rejected" } as const;
          throw error;
        }
      });
      snapshot.material.dispose();
    } catch (error) {
      captured?.material.dispose();
      if (error instanceof CredentialBoundaryError && error.code === "credential_revoked") {
        throw authError("runa.auth.reauthentication_required", "The Cuna session was rejected and removed.", { hint: "Run `cuna login`." });
      }
      throw error;
    }
    if (captured === undefined) {
      throw authError("runa.auth.refresh_unknown", "Cuna could not establish a new in-memory access token.", { retryable: true });
    }
    access?.material.dispose();
    access = captured;
  }

  async function acquireAccessToken(signal?: AbortSignal): Promise<string> {
    assertNotCancelled(signal);
    if (access !== undefined && access.expiresAt - now() > 30_000) return cachedAccessToken();
    if (refreshFlight === undefined) {
      const created = refreshAccess();
      refreshFlight = created;
      void created.then(
        () => { if (refreshFlight === created) refreshFlight = undefined; },
        () => { if (refreshFlight === created) refreshFlight = undefined; },
      );
    }
    await waitForRefresh(refreshFlight, signal);
    return cachedAccessToken();
  }

  async function whoami(signal?: AbortSignal): Promise<HumanAuthResult> {
    const token = await acquireAccessToken(signal);
    const context = await input.client.context(token, signal);
    const snapshot = await input.vault.load(credentialBinding);
    if (snapshot === undefined) throw authError("runa.auth.required", "No interactive Cuna session is stored.");
    try {
      const stored = snapshot.material.withBytes((bytes) => decodeStored(bytes, input.config));
      return Object.freeze({ profile: stored.profile, sessionId: stored.sessionId, context });
    } finally { snapshot.material.dispose(); }
  }

  async function logout(signal?: AbortSignal): Promise<{ readonly revoked: true }> {
    const token = await acquireAccessToken(signal);
    const revoked = await input.client.logout(token, signal);
    if (revoked !== true) throw authError("runa.auth.logout_unknown", "Cuna could not confirm server-side logout.", { retryable: true });
    await input.vault.delete(credentialBinding);
    access?.material.dispose();
    access = undefined;
    return Object.freeze({ revoked: true });
  }

  return Object.freeze({
    login,
    signup: (request: { readonly signal?: AbortSignal } = {}) =>
      login({ intentClass: "signup", ...request }),
    acquireAccessToken,
    whoami,
    logout,
  });
}
