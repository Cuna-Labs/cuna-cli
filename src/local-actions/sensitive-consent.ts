export type SensitiveLocalActionKind = "git.sign" | "local_service.request" | "device.select";

export interface SensitiveOperationContext {
  readonly requestId: string;
  readonly identityFingerprint: string;
  readonly isIdentityCurrent: () => boolean | Promise<boolean>;
  readonly isForegroundAlive: () => boolean;
}

export interface SensitiveConsentPrompt {
  readonly action: SensitiveLocalActionKind;
  readonly requestId: string;
  readonly identityFingerprint: string;
  readonly operationDigest: `sha256:${string}`;
  readonly summary: string;
  readonly persistentChoiceAllowed: false;
}

export interface PerOperationConsent {
  approveOnce(prompt: SensitiveConsentPrompt, signal?: AbortSignal): Promise<boolean>;
}

export function validateSensitiveContext(context: SensitiveOperationContext): void {
  if (!identifier(context.requestId) || !fingerprint(context.identityFingerprint) ||
    typeof context.isIdentityCurrent !== "function" || typeof context.isForegroundAlive !== "function") {
    throw new TypeError("Sensitive operation context is invalid.");
  }
}

export async function assertSensitiveAuthority(
  context: SensitiveOperationContext,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (!context.isForegroundAlive()) throw new SensitiveAuthorityError("foreground_inactive");
  if (!await context.isIdentityCurrent()) throw new SensitiveAuthorityError("identity_changed");
}

export async function requireConsentOnce(
  consent: PerOperationConsent,
  context: SensitiveOperationContext,
  input: {
    readonly action: SensitiveLocalActionKind;
    readonly operationDigest: `sha256:${string}`;
    readonly summary: string;
  },
  signal?: AbortSignal,
): Promise<void> {
  await assertSensitiveAuthority(context, signal);
  const approved = await consent.approveOnce(Object.freeze({
    action: input.action,
    requestId: context.requestId,
    identityFingerprint: context.identityFingerprint,
    operationDigest: input.operationDigest,
    summary: input.summary,
    persistentChoiceAllowed: false,
  }), signal);
  throwIfAborted(signal);
  if (!approved) throw new SensitiveAuthorityError("consent_denied");
  await assertSensitiveAuthority(context, signal);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new SensitiveAuthorityError("cancelled");
}

export function identifier(value: string): boolean {
  return /^[A-Za-z0-9._:@/-]{1,256}$/u.test(value);
}

function fingerprint(value: string): boolean {
  return /^[A-Za-z0-9._:@/-]{1,512}$/u.test(value);
}

export class SensitiveAuthorityError extends Error {
  constructor(readonly code: "cancelled" | "consent_denied" | "foreground_inactive" | "identity_changed") {
    super(`Cuna sensitive action rejected: ${code}.`);
    this.name = "SensitiveAuthorityError";
  }
}
