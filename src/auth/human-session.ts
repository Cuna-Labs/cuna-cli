import { randomBytes, randomUUID } from "node:crypto";
import type { EffectiveConfig } from "../config/config.js";
import { EXIT_CODES, CunaError } from "../core/errors.js";
import { automationCredentialHint } from "../core/product-web.js";
import { isLoginCode } from "../core/namespace.js";
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
  type CliLoginCodeExchangeResult,
} from "./human-contracts.js";
import { createPkceAuthorization } from "./pkce.js";

interface StoredHumanSession {
  readonly version: 3;
  readonly baseUrl: string;
  readonly profile: string;
  readonly clientInstanceId: string;
  readonly sessionId: string;
  readonly loginCode: string;
  readonly loginCodeExpiresAt: string;
  readonly continuationId: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
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
  readonly storageMode?: "encrypted-local";
}

export interface HumanAuthService {
  login(input?: { readonly intentClass?: CliIntentClass; readonly signal?: AbortSignal }): Promise<HumanAuthResult>;
  signup(input?: { readonly signal?: AbortSignal }): Promise<HumanAuthResult>;
  acquireAccessToken(signal?: AbortSignal): Promise<string>;
  whoami(signal?: AbortSignal): Promise<HumanAuthResult>;
  logout(signal?: AbortSignal): Promise<{ readonly revoked: true }>;
}

type RandomSource = (size: number) => Uint8Array;

/**
 * The automation-only hint used when a command has no admitted interactive
 * session. Browser-link login uses the encrypted local session store; this
 * message must not imply that an API key is a login fallback.
 *
 * `CUNA_API_KEY` never touches the encrypted local session store:
 * `cli/run.ts` selects automation mode from it and hands the key straight to
 * the HTTP transport. Measured on this host — the vault reports an unverified
 * backend, so an explicit automation credential remains separate from the
 * browser-link preview session and never changes the user's login mode.
 *
 * The text promises COMMANDS, not sign-in, deliberately: `login`, `logout`,
 * `whoami`, `signup` and `access` reject with `cuna.auth.mode_conflict` while
 * `CUNA_API_KEY` is set, so a hint promising that this makes sign-in work would
 * be the same class of lie in the other direction.
 *
 * This lives in one place because it is one fact. Copying the sentence to each
 * mint site is how the two spellings of a namespace drift apart.
 */
const AUTOMATION_CREDENTIAL_HINT =
  `Sign-in is unavailable here, so use an automation credential instead. ${automationCredentialHint()}`;

function authError(code: string, message: string, options: {
  readonly retryable?: boolean;
  readonly hint?: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
} = {}): CunaError {
  return new CunaError({ code, message, exitCode: EXIT_CODES.auth, ...options });
}

function binding(config: EffectiveConfig): CredentialBinding {
  return Object.freeze({
    profileId: config.profile,
    accountId: config.baseUrl,
    workspaceId: "cli-human-auth",
    kind: "login-code-session-v1",
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
    login_code: session.loginCode,
    login_code_expires_at: session.loginCodeExpiresAt,
    continuation_id: session.continuationId,
    state: session.state,
    code_verifier: session.codeVerifier,
    redirect_uri: session.redirectUri,
    context: contextWire(session.context),
    intent_class: session.intentClass,
  }));
}

function decodeStored(bytes: Uint8Array, config: EffectiveConfig): StoredHumanSession {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch {
    throw authError("cuna.auth.session_corrupt", "The protected Cuna sign-in session is malformed.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw authError("cuna.auth.session_corrupt", "The protected Cuna sign-in session is malformed.");
  }
  const record = parsed as Record<string, unknown>;
  const expected = [
    "base_url", "client_instance_id", "code_verifier", "context", "continuation_id", "intent_class", "login_code",
    "login_code_expires_at", "profile", "redirect_uri", "session_id", "state", "version",
  ];
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw authError("cuna.auth.session_corrupt", "The protected Cuna sign-in session has an invalid shape.");
  }
  if (
    record.version !== 3 ||
    record.base_url !== config.baseUrl || record.profile !== config.profile ||
    typeof record.login_code !== "string" || !isLoginCode(record.login_code) ||
    typeof record.login_code_expires_at !== "string" || Number.isNaN(Date.parse(record.login_code_expires_at)) ||
    new Date(record.login_code_expires_at).toISOString() !== record.login_code_expires_at ||
    typeof record.client_instance_id !== "string" || typeof record.session_id !== "string" ||
    typeof record.continuation_id !== "string" || typeof record.state !== "string" ||
    typeof record.code_verifier !== "string" || typeof record.redirect_uri !== "string" ||
    (!new Set<CliIntentClass>([
        "signup", "login", "account.read", "machines.read", "machines.create",
        "agent_sessions.read", "agent_sessions.create",
      ]).has(record.intent_class as CliIntentClass))
  ) {
    throw authError("cuna.auth.session_corrupt", "The protected Cuna sign-in session failed validation.");
  }
  return Object.freeze({
    version: 3,
    baseUrl: config.baseUrl,
    profile: assertProfile(config.profile),
    clientInstanceId: assertUuid(record.client_instance_id, "client instance ID"),
    sessionId: assertUuid(record.session_id, "session ID"),
    loginCode: record.login_code,
    loginCodeExpiresAt: record.login_code_expires_at,
    continuationId: assertUuid(record.continuation_id, "continuation ID"),
    state: record.state,
    codeVerifier: record.code_verifier,
    redirectUri: record.redirect_uri,
    context: decodeCliIdentityContext(record.context),
    intentClass: record.intent_class as CliIntentClass,
  });
}

function storedFromExchange(
  config: EffectiveConfig,
  clientInstanceId: string,
  loginCode: string,
  exchange: CliLoginCodeExchangeResult,
  intentClass: CliIntentClass,
  continuation: { readonly id: string; readonly state: string; readonly codeVerifier: string; readonly redirectUri: string },
): StoredHumanSession {
  return Object.freeze({
    version: 3,
    baseUrl: config.baseUrl,
    profile: config.profile,
    clientInstanceId,
    sessionId: exchange.sessionId,
    loginCode,
    loginCodeExpiresAt: exchange.loginCodeExpiresAt,
    continuationId: continuation.id,
    state: continuation.state,
    codeVerifier: continuation.codeVerifier,
    redirectUri: continuation.redirectUri,
    context: exchange.context,
    intentClass,
  });
}

function isAuthoritativeReexchangeRejection(error: unknown): boolean {
  if (!(error instanceof CunaError)) return false;
  const status = error.details?.http_status;
  const reason = error.details?.reason;
  // A generic 4xx is not proof that this exact login-code family was revoked:
  // the current OpenAPI `Problem` response is intentionally extensible. Only
  // these server-defined terminal pairs may remove the durable code.
  return (status === 401 &&
    (reason === "cli_auth_rejected" || reason === "cli_session_revoked"));
}

/**
 * A second logout is allowed to finish local cleanup only after the server has
 * made an irreversible fact visible.  In particular, a lost response and a
 * later 401 are not equivalent: the former is indeterminate and preserves the
 * encrypted login code; the latter proves the family cannot be used again.
 */
function isDefinitiveLogoutTermination(error: unknown): boolean {
  if (!(error instanceof CunaError)) return false;
  const reason = error.details?.reason;
  return (
    // Re-exchange emits this marker only after CredentialVault used a
    // revision-fenced deletion (or observed the exact old record absent).
    error.code === "cuna.auth.reauthentication_required" && reason === "durable_session_removed"
  ) ||
    isAuthoritativeReexchangeRejection(error);
}

function ensureOnboardingReady(context: CliIdentityContext): void {
  if (context.identity === "active" && context.admission === "admitted" && context.workspace.state === "assigned") return;
  throw authError(
    "cuna.auth.onboarding_incomplete",
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
    "cuna.auth.signup_state_invalid",
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
  readonly readLoginCode: (signal?: AbortSignal) => Promise<string>;
  readonly clock?: () => number;
  readonly random?: RandomSource;
  readonly uuid?: () => string;
}): HumanAuthService {
  const clock = input.clock ?? Date.now;
  const random = input.random ?? randomBytes;
  const credentialBinding = binding(input.config);
  let lastObservedNow: number | undefined;
  // Profile and session ID are non-secret identity metadata decoded from the
  // same encrypted record that authorizes a re-exchange. Keeping that validated
  // metadata with the in-memory access token avoids a second durable-store
  // read merely to render `whoami`.
  let access: {
    readonly material: SecretMaterial;
    readonly expiresAt: number;
    readonly profile: string;
    readonly sessionId: string;
    readonly revision: number;
  } | undefined;
  let reexchangeFlight: Promise<void> | undefined;

  function now(): number {
    const observed = clock();
    if (!Number.isSafeInteger(observed) || observed < 0 || (lastObservedNow !== undefined && observed < lastObservedNow)) {
      throw authError("cuna.auth.clock_untrusted", "The local authentication clock is not trustworthy.");
    }
    lastObservedNow = observed;
    return observed;
  }

  function cacheAccessToken(
    token: string,
    expiresAt: number,
    session: Pick<StoredHumanSession, "profile" | "sessionId">,
    revision: number,
  ): boolean {
    if (!Number.isSafeInteger(expiresAt) || expiresAt - now() <= 30_000 || !Number.isSafeInteger(revision) || revision < 1) return false;
    const material = SecretMaterial.fromUtf8(token);
    access?.material.dispose();
    access = { material, expiresAt, profile: session.profile, sessionId: session.sessionId, revision };
    return true;
  }

  function cachedAccessToken(): string {
    if (access === undefined || access.expiresAt - now() <= 30_000) {
      throw authError("cuna.auth.reexchange_unknown", "Cuna could not establish a fresh in-memory access token.", { retryable: true });
    }
    return access.material.withBytes((bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }

  function assertNotCancelled(signal?: AbortSignal): void {
    if (signal?.aborted === true) {
      throw authError("cuna.auth.cancelled", "Cuna sign-in was cancelled.");
    }
  }

  async function readLoginCodeBeforeExpiry(expiresAt: string, signal?: AbortSignal): Promise<string> {
    const deadline = Date.parse(expiresAt);
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw authError("cuna.auth.continuation_expired", "Cuna sign-in expired before the browser code could be entered.");
    }
    const controller = new AbortController();
    let expired = false;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeCancellation: (() => void) | undefined;
    const deadlineReached = new Promise<{ readonly kind: "expired" }>((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        controller.abort();
        resolve(Object.freeze({ kind: "expired" as const }));
      }, remaining);
    });
    const callerCancelled = signal === undefined
      ? new Promise<never>(() => {})
      : new Promise<{ readonly kind: "cancelled" }>((resolve) => {
        const cancel = () => {
          cancelled = true;
          controller.abort();
          resolve(Object.freeze({ kind: "cancelled" as const }));
        };
        removeCancellation = () => signal.removeEventListener("abort", cancel);
        signal.addEventListener("abort", cancel, { once: true });
        // AbortSignal does not replay an event delivered just before listener
        // registration. Recheck the state so cancellation cannot leave the
        // hidden reader blocked until the continuation deadline.
        if (signal.aborted) cancel();
      });
    try {
      // Do not start a reader after the post-registration recheck found the
      // caller cancelled. If cancellation arrives immediately afterwards, the
      // registered handler aborts this controller and wins the race below.
      const codeRead = cancelled
        ? new Promise<never>(() => {})
        : input.readLoginCode(controller.signal).then((loginCode) => Object.freeze({ kind: "login_code" as const, loginCode }));
      const outcome = await Promise.race([
        codeRead,
        deadlineReached,
        callerCancelled,
      ]);
      if (outcome.kind === "expired") {
        throw authError("cuna.auth.continuation_expired", "Cuna sign-in expired before the browser code could be entered.");
      }
      if (outcome.kind === "cancelled") {
        throw authError("cuna.auth.cancelled", "Cuna sign-in was cancelled.");
      }
      const loginCode = outcome.loginCode;
      if (expired || Date.parse(expiresAt) <= now()) {
        throw authError("cuna.auth.continuation_expired", "Cuna sign-in expired before the browser code could be entered.");
      }
      assertNotCancelled(signal);
      return loginCode;
    } catch (error) {
      if (expired) {
        throw authError("cuna.auth.continuation_expired", "Cuna sign-in expired before the browser code could be entered.");
      }
      if (signal?.aborted === true) throw authError("cuna.auth.cancelled", "Cuna sign-in was cancelled.");
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeCancellation?.();
    }
  }

  async function waitForReexchange(flight: Promise<void>, signal?: AbortSignal): Promise<void> {
    assertNotCancelled(signal);
    if (signal === undefined) return await flight;
    return await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        signal.removeEventListener("abort", abort);
        reject(authError("cuna.auth.cancelled", "Cuna sign-in was cancelled."));
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
        "cuna.auth.session_store_unavailable",
        "The encrypted local session store is unavailable or cannot be verified.",
        {
          hint: "Run `cuna doctor` to verify encrypted local session storage, then retry `cuna login`.",
        },
      );
    }
    if (vaultStatus.state === "present") {
      throw authError(
        "cuna.auth.already_signed_in",
        "This Cuna profile already has an interactive session.",
        { hint: "Run `cuna logout` before signing in again." },
      );
    }
    if (vaultStatus.state === "corrupt") {
      throw authError(
        "cuna.auth.session_corrupt",
        "The protected Cuna session is corrupt and cannot be replaced implicitly.",
        { hint: "Remove the damaged encrypted local session files, then run `cuna login` again." },
      );
    }
    const bootstrap = await input.client.bootstrap(request.signal);
    if (!bootstrap.enabled || bootstrap.browserOrigin === null) {
      throw authError(
        "cuna.auth.unavailable",
        "Interactive Cuna sign-in is not enabled for this environment.",
        { hint: AUTOMATION_CREDENTIAL_HINT },
      );
    }
    if (intentClass === "signup") {
      const signup = await input.client.signupCapability(request.signal);
      if (!signup.enabled || signup.enrollment !== "waitlist_only") {
        throw authError(
          "cuna.auth.signup_unavailable",
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
    // Terminal cancellation is local. Browser cancellation is a separately
    // authenticated cuna_cb_ callback owned by the approved browser flow;
    // this CLI never has a continuation secret or a cancel endpoint.
    {
      if (Date.parse(issued.expiresAt) <= now()) {
        throw authError("cuna.auth.continuation_expired", "Cuna issued an already-expired sign-in continuation.");
      }
      await input.browser.open(issued.browserUrl);
      const loginCode = (await readLoginCodeBeforeExpiry(issued.expiresAt, request.signal)).trim();
      if (!isLoginCode(loginCode)) {
        throw authError("cuna.auth.login_code_invalid", "The pasted Cuna login code is invalid.", {
          hint: "Copy the complete cuna_login_ code shown by app.getcuna.com and paste it once.",
        });
      }
      const exchange = await input.client.exchange({
        id: issued.id,
        clientInstanceId,
        profile: input.config.profile,
        state: pkce.state,
        codeVerifier: pkce.verifier,
        redirectUri,
        loginCode,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      let persistedRevision: number | undefined;
      try {
        // The remote family now exists even if the caller interrupted the
        // exchange request. Never persist or cache it after that interruption.
        assertNotCancelled(request.signal);
        const exchangedAt = now();
        if (Date.parse(exchange.loginCodeExpiresAt) <= exchangedAt || Date.parse(exchange.accessExpiresAt) <= exchangedAt) {
          throw authError("cuna.auth.token_expired", "Cuna returned an already-expired sign-in session.");
        }
        if (intentClass === "signup") {
          ensureSignupContext(exchange.context, false);
        } else {
          ensureOnboardingReady(exchange.context);
        }
        const stored = storedFromExchange(
          input.config,
          clientInstanceId,
          loginCode,
          exchange,
          intentClass,
          { id: issued.id, state: pkce.state, codeVerifier: pkce.verifier, redirectUri },
        );
        const material = encodeStored(stored);
        try {
          const rotated = await input.vault.rotate({
            binding: credentialBinding,
            material,
            expiresAt: Date.parse(stored.loginCodeExpiresAt),
          });
          persistedRevision = rotated.revision;
          if (persistedRevision === undefined) {
            throw authError(
              "cuna.auth.session_cleanup_failed",
              "Cuna could not prove the encrypted session revision required for cancellation cleanup.",
              { retryable: true },
            );
          }
        } finally { material.dispose(); }
        // Rotation is an await boundary. If cancellation arrived while it was
        // committing, the catch below removes only this fenced revision before
        // returning the cancellation to the caller.
        assertNotCancelled(request.signal);
        cacheAccessToken(exchange.accessToken, Date.parse(exchange.accessExpiresAt), stored, persistedRevision);
        return Object.freeze({
          profile: stored.profile,
          sessionId: stored.sessionId,
          context: stored.context,
          storageMode: "encrypted-local",
        });
      } catch (error) {
        let localCleanupFailed = false;
        if (persistedRevision !== undefined) {
          try {
            await input.vault.deleteIfRevision({
              binding: credentialBinding,
              expectedRevision: persistedRevision,
            });
          } catch {
            // Do not expose a backend cause: it may include protected-path or
            // provider diagnostics. Still revoke the remote family below.
            localCleanupFailed = true;
          }
        }
        try { await input.client.logout(exchange.accessToken); } catch { /* family remains server-expiring */ }
        if (localCleanupFailed) {
          throw authError(
            "cuna.auth.session_cleanup_failed",
            "Cuna stopped sign-in but could not prove removal of its encrypted local session.",
            { retryable: true },
          );
        }
        throw error;
      }
    }
  }

  async function reexchangeAccess(signal?: AbortSignal): Promise<void> {
    assertNotCancelled(signal);
    // `vault.refresh` already reads, validates, and locks the exact encrypted
    // record before invoking this callback. An initial `vault.load` duplicated
    // that secure-store round trip in every fresh CLI process.
    let captured: {
      readonly material: SecretMaterial;
      readonly expiresAt: number;
      readonly profile: string;
      readonly sessionId: string;
    } | undefined;
    let capturedRevision: number | undefined;
    try {
      const snapshot = await input.vault.refresh(credentialBinding, async (current) => {
        if (current === undefined) {
          return { status: "missing" } as const;
        }
        const stored = current.material.withBytes((bytes) => decodeStored(bytes, input.config));
        if (Date.parse(stored.loginCodeExpiresAt) <= now()) {
          return { status: "rejected", reason: "local_expired" } as const;
        }
        try {
          const exchange = await input.client.exchange({
            id: stored.continuationId,
            loginCode: stored.loginCode,
            clientInstanceId: stored.clientInstanceId,
            profile: stored.profile,
            state: stored.state,
            codeVerifier: stored.codeVerifier,
            redirectUri: stored.redirectUri,
            expectedLoginCodeExpiresAt: stored.loginCodeExpiresAt,
            ...(signal === undefined ? {} : { signal }),
          });
          const exchangedAt = now();
          if (
            exchange.sessionId !== stored.sessionId ||
            exchange.loginCodeExpiresAt !== stored.loginCodeExpiresAt ||
            (stored.intentClass === "signup"
              ? !signupContextTransitionAllowed(stored.context, exchange.context)
              : JSON.stringify(contextWire(exchange.context)) !== JSON.stringify(contextWire(stored.context))) ||
            Date.parse(exchange.loginCodeExpiresAt) <= exchangedAt ||
            Date.parse(exchange.accessExpiresAt) <= exchangedAt
          ) {
            try { await input.client.logout(exchange.accessToken, signal); } catch { /* best-effort family cleanup */ }
            return { status: "rejected", reason: "local_integrity" } as const;
          }
          try {
            if (stored.intentClass === "signup") {
              ensureSignupContext(exchange.context, true);
            } else {
              ensureOnboardingReady(exchange.context);
            }
          } catch {
            try { await input.client.logout(exchange.accessToken, signal); } catch { /* best-effort family cleanup */ }
            return { status: "rejected", reason: "local_integrity" } as const;
          }
          captured?.material.dispose();
          captured = {
            material: SecretMaterial.fromUtf8(exchange.accessToken),
            expiresAt: Date.parse(exchange.accessExpiresAt),
            profile: stored.profile,
            sessionId: stored.sessionId,
          };
          // Re-exchange has no durable-token rotation.  The exact encrypted
          // browser code stays revision-fenced in place until logout or a
          // terminal server rejection proves it must be removed.
          return { status: "retained" } as const;
        } catch (error) {
          if (isAuthoritativeReexchangeRejection(error)) {
            return { status: "rejected", reason: "authoritative_remote" } as const;
          }
          throw error;
        }
      });
      try {
        capturedRevision = snapshot.revision;
      } finally {
        snapshot.material.dispose();
      }
    } catch (error) {
      captured?.material.dispose();
      if (error instanceof CredentialBoundaryError && error.code === "credential_missing") {
        throw authError("cuna.auth.required", "No interactive Cuna session is stored.", { hint: "Run `cuna login`." });
      }
      if (error instanceof CredentialBoundaryError && error.code === "credential_revoked") {
        throw authError(
          "cuna.auth.reauthentication_required",
          "The Cuna session was rejected and removed.",
          {
            hint: "Run `cuna login`.",
            ...(error.safeDetails?.refreshRejection === "authoritative_remote"
              ? { details: { reason: "durable_session_removed" } }
              : {}),
          },
        );
      }
      throw error;
    }
    if (captured === undefined || capturedRevision === undefined || !Number.isSafeInteger(capturedRevision) || capturedRevision < 1) {
      captured?.material.dispose();
      throw authError("cuna.auth.reexchange_unknown", "Cuna could not establish a new in-memory access token.", { retryable: true });
    }
    access?.material.dispose();
    access = { ...captured, revision: capturedRevision };
  }

  async function acquireAccessToken(signal?: AbortSignal): Promise<string> {
    assertNotCancelled(signal);
    if (access !== undefined && access.expiresAt - now() > 30_000) return cachedAccessToken();
    if (reexchangeFlight === undefined) {
      const created = reexchangeAccess();
      reexchangeFlight = created;
      void created.then(
        () => { if (reexchangeFlight === created) reexchangeFlight = undefined; },
        () => { if (reexchangeFlight === created) reexchangeFlight = undefined; },
      );
    }
    await waitForReexchange(reexchangeFlight, signal);
    return cachedAccessToken();
  }

  async function whoami(signal?: AbortSignal): Promise<HumanAuthResult> {
    const token = await acquireAccessToken(signal);
    const session = access;
    if (session === undefined) {
      throw authError("cuna.auth.reexchange_unknown", "Cuna could not establish a fresh in-memory access token.", { retryable: true });
    }
    const context = await input.client.context(token, signal);
    return Object.freeze({
      profile: session.profile,
      sessionId: session.sessionId,
      context,
      storageMode: "encrypted-local",
    });
  }

  function discardCachedAccess(): void {
    access?.material.dispose();
    access = undefined;
  }

  /**
   * A remote logout fact applies only to the durable revision that supplied
   * this command's bearer.  A different shell may have completed a new browser
   * sign-in while this request was in flight, so a plain delete would turn a
   * confirmed old-family logout into destruction of the new family locally.
   */
  async function removeConfirmedLocalSession(expectedRevision: number | undefined): Promise<void> {
    discardCachedAccess();
    // Re-exchange reached this state only after CredentialVault fenced the
    // exact rejected envelope. Do not issue a second unfenced delete.
    if (expectedRevision === undefined) return;
    let outcome: "deleted" | "absent" | "conflict";
    try {
      outcome = await input.vault.deleteIfRevision({
        binding: credentialBinding,
        expectedRevision,
      });
    } catch {
      throw authError(
        "cuna.auth.session_cleanup_failed",
        "Cuna confirmed sign-out but could not prove removal of its encrypted local session.",
        { retryable: true },
      );
    }
    if (outcome === "conflict") {
      throw authError(
        "cuna.auth.session_cleanup_conflict",
        "Cuna confirmed sign-out for the prior session, but a newer encrypted local session was preserved.",
        {
          hint: "Inspect the current session before deciding whether to sign out again.",
          details: { reason: "newer_local_session" },
        },
      );
    }
  }

  async function logout(signal?: AbortSignal): Promise<{ readonly revoked: true }> {
    let cleanupRevision: number | undefined;
    try {
      const token = await acquireAccessToken(signal);
      const session = access;
      if (session === undefined) {
        throw authError(
          "cuna.auth.session_cleanup_failed",
          "Cuna could not prove which encrypted local session authorized sign-out.",
          { retryable: true },
        );
      }
      cleanupRevision = session.revision;
      const revoked = await input.client.logout(token, signal);
      if (revoked !== true) {
        throw authError("cuna.auth.logout_unknown", "Cuna could not confirm server-side logout.", { retryable: true });
      }
    } catch (error) {
      if (!isDefinitiveLogoutTermination(error)) {
        // An ambiguous remote write must not leave a possibly-revoked bearer
        // usable in this process. The encrypted durable code remains for the
        // next, fresh acquisition and is never destroyed on this path.
        discardCachedAccess();
        throw error;
      }
      if (
        error instanceof CunaError &&
        error.code === "cuna.auth.reauthentication_required" &&
        error.details?.reason === "durable_session_removed"
      ) {
        // The re-exchange path proved a terminal server result and already
        // compare-deleted the exact envelope it read.
        cleanupRevision = undefined;
      } else {
        const session = access;
        if (session === undefined) {
          discardCachedAccess();
          throw authError(
            "cuna.auth.session_cleanup_failed",
            "Cuna received a terminal sign-out response but could not identify the encrypted local session to remove.",
            { retryable: true },
          );
        }
        cleanupRevision = session.revision;
      }
    }

    await removeConfirmedLocalSession(cleanupRevision);
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
