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
  readonly version: 1;
  readonly baseUrl: string;
  readonly profile: string;
  readonly clientInstanceId: string;
  readonly sessionId: string;
  readonly refreshToken: string;
  readonly refreshExpiresAt: string;
  readonly context: CliIdentityContext;
}

export interface HumanAuthResult {
  readonly profile: string;
  readonly sessionId: string;
  readonly context: CliIdentityContext;
}

export interface HumanAuthService {
  login(input?: { readonly intentClass?: CliIntentClass; readonly signal?: AbortSignal }): Promise<HumanAuthResult>;
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
  }));
}

function decodeStored(bytes: Uint8Array, config: EffectiveConfig): StoredHumanSession {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch {
    throw authError("runa.auth.session_corrupt", "The protected Runa sign-in session is malformed.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw authError("runa.auth.session_corrupt", "The protected Runa sign-in session is malformed.");
  }
  const record = parsed as Record<string, unknown>;
  const expected = [
    "base_url", "client_instance_id", "context", "profile", "refresh_expires_at",
    "refresh_token", "session_id", "version",
  ];
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw authError("runa.auth.session_corrupt", "The protected Runa sign-in session has an invalid shape.");
  }
  if (
    record.version !== 1 || record.base_url !== config.baseUrl || record.profile !== config.profile ||
    typeof record.refresh_token !== "string" || !/^runa_rt_[A-Za-z0-9_-]{43}$/u.test(record.refresh_token) ||
    typeof record.refresh_expires_at !== "string" || Number.isNaN(Date.parse(record.refresh_expires_at)) ||
    new Date(record.refresh_expires_at).toISOString() !== record.refresh_expires_at ||
    typeof record.client_instance_id !== "string" || typeof record.session_id !== "string"
  ) {
    throw authError("runa.auth.session_corrupt", "The protected Runa sign-in session failed validation.");
  }
  return Object.freeze({
    version: 1,
    baseUrl: config.baseUrl,
    profile: assertProfile(config.profile),
    clientInstanceId: assertUuid(record.client_instance_id, "client instance ID"),
    sessionId: assertUuid(record.session_id, "session ID"),
    refreshToken: record.refresh_token,
    refreshExpiresAt: record.refresh_expires_at,
    context: decodeCliIdentityContext(record.context),
  });
}

function storedFromTokens(config: EffectiveConfig, clientInstanceId: string, tokens: CliTokenSet): StoredHumanSession {
  return Object.freeze({
    version: 1,
    baseUrl: config.baseUrl,
    profile: config.profile,
    clientInstanceId,
    sessionId: tokens.sessionId,
    refreshToken: tokens.refreshToken,
    refreshExpiresAt: tokens.refreshExpiresAt,
    context: tokens.context,
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
    "Runa sign-in completed, but the account is not ready for CLI work.",
    { hint: "Finish identity verification, admission, terms, and workspace assignment in the browser." },
  );
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
  let access: { readonly token: string; readonly expiresAt: number } | undefined;
  let refreshFlight: Promise<string> | undefined;

  async function cancelBestEffort(id: string, secret: string): Promise<void> {
    try { await input.client.cancel({ id, secret }); } catch { /* unknown cancellation remains server-expiring */ }
  }

  async function login(request: { readonly intentClass?: CliIntentClass; readonly signal?: AbortSignal } = {}): Promise<HumanAuthResult> {
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
        "This Runa profile already has an interactive session.",
        { hint: "Run `runa logout` before signing in again." },
      );
    }
    if (vaultStatus.state === "corrupt") {
      throw authError(
        "runa.auth.session_corrupt",
        "The protected Runa session is corrupt and cannot be replaced implicitly.",
        { hint: "Remove the damaged credential through the operating-system credential manager." },
      );
    }
    const bootstrap = await input.client.bootstrap(request.signal);
    if (!bootstrap.enabled || bootstrap.browserOrigin === null) {
      throw authError("runa.auth.unavailable", "Interactive Runa sign-in is not enabled for this environment.");
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
      intentClass: request.intentClass ?? "login",
      browserOrigin: bootstrap.browserOrigin,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    try {
      if (Date.parse(issued.expiresAt) <= clock()) {
        throw authError("runa.auth.continuation_expired", "Runa issued an already-expired sign-in continuation.");
      }
      await input.browser.open(issued.browserUrl);
      let interval = Math.max(bootstrap.pollAfterMs, issued.pollAfterMs);
      for (let attempt = 0; attempt < bootstrap.pollLimit; attempt += 1) {
        if (request.signal?.aborted) throw authError("runa.auth.cancelled", "Runa sign-in was cancelled.");
        const remaining = Date.parse(issued.expiresAt) - clock();
        if (remaining <= 0) break;
        try { await sleep(Math.min(interval, remaining), request.signal); } catch {
          if (request.signal?.aborted) throw authError("runa.auth.cancelled", "Runa sign-in was cancelled.");
          throw authError("runa.auth.poll_failed", "Runa could not continue sign-in polling.", { retryable: true });
        }
        const status = await input.client.continuation({
          id: issued.id,
          secret: issued.continuationSecret,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        if (Date.parse(status.expiresAt) !== Date.parse(issued.expiresAt)) {
          throw authError("runa.auth.continuation_mismatch", "Runa returned contradictory continuation authority.");
        }
        if (status.phase === "issued") {
          interval = Math.max(bootstrap.pollAfterMs, status.pollAfterMs ?? interval);
          continue;
        }
        if (status.phase === "cancelled") throw authError("runa.auth.cancelled", "Runa sign-in was cancelled.");
        if (status.phase === "expired") throw authError("runa.auth.continuation_expired", "Runa sign-in expired.");
        if (status.phase === "consumed") throw authError("runa.auth.continuation_consumed", "This Runa sign-in was already exchanged.");
        const tokens = await input.client.exchange({
          id: issued.id,
          continuationSecret: issued.continuationSecret,
          state: pkce.state,
          codeVerifier: pkce.verifier,
          redirectUri,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        try {
          if (
            tokens.context.requiredTermsVersion !== status.requiredTermsVersion ||
            (status.context !== undefined &&
              JSON.stringify(contextWire(status.context)) !== JSON.stringify(contextWire(tokens.context)))
          ) {
            throw authError("runa.auth.context_mismatch", "Runa returned contradictory sign-in context authority.");
          }
          ensureOnboardingReady(tokens.context);
          const stored = storedFromTokens(input.config, clientInstanceId, tokens);
          const material = encodeStored(stored);
          try {
            await input.vault.rotate({
              binding: credentialBinding,
              material,
              expiresAt: Date.parse(stored.refreshExpiresAt),
            });
          } finally { material.dispose(); }
          access = { token: tokens.accessToken, expiresAt: Date.parse(tokens.accessExpiresAt) };
          return Object.freeze({ profile: stored.profile, sessionId: stored.sessionId, context: stored.context });
        } catch (error) {
          try { await input.client.logout(tokens.accessToken); } catch { /* family remains server-expiring */ }
          throw error;
        }
      }
      throw authError("runa.auth.timeout", "Runa sign-in did not complete within its bounded polling window.", { retryable: true });
    } catch (error) {
      await cancelBestEffort(issued.id, issued.continuationSecret);
      throw error;
    }
  }

  async function refreshAccess(signal?: AbortSignal): Promise<string> {
    let captured: { readonly token: string; readonly expiresAt: number } | undefined;
    let postRotateError: RunaError | undefined;
    try {
      const snapshot = await input.vault.refresh(credentialBinding, async (current) => {
        if (current === undefined) {
          throw authError("runa.auth.required", "No interactive Runa session is stored.", { hint: "Run `runa login`." });
        }
        const stored = current.material.withBytes((bytes) => decodeStored(bytes, input.config));
        if (Date.parse(stored.refreshExpiresAt) <= clock()) {
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
          try {
            ensureOnboardingReady(tokens.context);
          } catch (error) {
            try {
              if (await input.client.logout(tokens.accessToken, signal)) return { status: "rejected" } as const;
            } catch {
              postRotateError = error as RunaError;
            }
          }
          captured = { token: tokens.accessToken, expiresAt: Date.parse(tokens.accessExpiresAt) };
          return {
            status: "rotated",
            material: encodeStored(storedFromTokens(input.config, stored.clientInstanceId, tokens)),
            expiresAt: Date.parse(tokens.refreshExpiresAt),
          } as const;
        } catch (error) {
          if (isAuthoritativeRefreshRejection(error)) return { status: "rejected" } as const;
          throw error;
        }
      });
      snapshot.material.dispose();
    } catch (error) {
      if (error instanceof CredentialBoundaryError && error.code === "credential_revoked") {
        throw authError("runa.auth.reauthentication_required", "The Runa session was rejected and removed.", { hint: "Run `runa login`." });
      }
      throw error;
    }
    if (postRotateError !== undefined) throw postRotateError;
    if (captured === undefined) {
      throw authError("runa.auth.refresh_unknown", "Runa could not establish a new in-memory access token.", { retryable: true });
    }
    access = captured;
    return captured.token;
  }

  async function acquireAccessToken(signal?: AbortSignal): Promise<string> {
    if (access !== undefined && access.expiresAt - clock() > 30_000) return access.token;
    if (refreshFlight === undefined) {
      refreshFlight = refreshAccess(signal).finally(() => { refreshFlight = undefined; });
    }
    return await refreshFlight;
  }

  async function whoami(signal?: AbortSignal): Promise<HumanAuthResult> {
    const token = await acquireAccessToken(signal);
    const context = await input.client.context(token, signal);
    const snapshot = await input.vault.load(credentialBinding);
    if (snapshot === undefined) throw authError("runa.auth.required", "No interactive Runa session is stored.");
    try {
      const stored = snapshot.material.withBytes((bytes) => decodeStored(bytes, input.config));
      return Object.freeze({ profile: stored.profile, sessionId: stored.sessionId, context });
    } finally { snapshot.material.dispose(); }
  }

  async function logout(signal?: AbortSignal): Promise<{ readonly revoked: true }> {
    const token = await acquireAccessToken(signal);
    const revoked = await input.client.logout(token, signal);
    if (revoked !== true) throw authError("runa.auth.logout_unknown", "Runa could not confirm server-side logout.", { retryable: true });
    await input.vault.delete(credentialBinding);
    access = undefined;
    return Object.freeze({ revoked: true });
  }

  return Object.freeze({ login, acquireAccessToken, whoami, logout });
}
