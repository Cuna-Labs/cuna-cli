/**
 * The single authority on every namespace this CLI accepts.
 *
 * A namespace is minted by the service and accepted by the client. When the two
 * are written independently, a rename lands on one side only and the client
 * starts rejecting values the service still issues — with no compile error and
 * no test failure. That is exactly how the CLI came to reject every issued
 * `runa_sk_` API key, throw on every stored key row, and silently discard every
 * Problem document minted at `api.runacode.io`.
 *
 * Every accepted brand, credential family and service origin is therefore
 * enumerated here exactly once, and every call site tests through a predicate
 * exported from this module. Widening the product's acceptance is a one-line
 * edit in this file; a one-sided edit somewhere else is no longer expressible.
 *
 * These lists may only ever GROW. Removing a brand, a family infix, or an
 * origin silently rejects credentials and documents that are still live in
 * production, and for the secret detector it silently starts uploading material
 * that is blocked today.
 */

/**
 * Every brand the product has minted credentials under. `cuna` is the current
 * mint; `runa` predates the rename and remains valid indefinitely because keys
 * issued under it were never revoked.
 */
export const CREDENTIAL_BRANDS = Object.freeze(["cuna", "runa"] as const);

export type CredentialBrand = (typeof CREDENTIAL_BRANDS)[number];

/**
 * Every credential family infix the product has ever issued. Families without a
 * wire validator below still belong here: the workspace secret detector is a
 * denylist and must recognize all of them.
 */
export const CREDENTIAL_FAMILY_INFIXES = Object.freeze([
  // sk secret key · at access token · rt refresh token · ct continuation
  // tc terminal connect · se/sc session credentials · cb browser callback nonce
  //
  // `cb` was absent while the service minted `cuna_cb_…` for every human
  // sign-in, so the workspace secret detector uploaded it instead of blocking
  // it — exactly the failure this module's header warns about.
  "sk", "at", "rt", "ct", "tc", "se", "sc", "cb",
] as const);

export type CredentialFamilyInfix = (typeof CREDENTIAL_FAMILY_INFIXES)[number];

/**
 * Every origin the service has minted absolute URLs under. `api.runacode.io` is
 * what production mints today; `api.getcuna.com` is the renamed origin the
 * contract declares. Both must decode.
 */
export const API_ORIGINS = Object.freeze([
  "https://api.getcuna.com",
  "https://api.runacode.io",
] as const);

export type ApiOrigin = (typeof API_ORIGINS)[number];

/** The same origins as WebSocket authorities, for stream URLs. */
export const API_WEBSOCKET_ORIGINS = Object.freeze(
  API_ORIGINS.map((origin) => `wss://${new URL(origin).host}`),
);

/** Opaque suffix of every 32-byte base64url secret the service mints. */
const OPAQUE_SECRET = "[A-Za-z0-9_-]{43}";

/**
 * Wire grammar per validated family. The infix is drawn from
 * `CREDENTIAL_FAMILY_INFIXES` so a family can never be validated under a
 * spelling the detector does not also recognize.
 */
const CREDENTIAL_GRAMMAR = Object.freeze({
  secretKey: Object.freeze({ infix: "sk", suffix: "[A-Za-z0-9_-]{16,256}" }),
  accessToken: Object.freeze({ infix: "at", suffix: OPAQUE_SECRET }),
  refreshToken: Object.freeze({ infix: "rt", suffix: OPAQUE_SECRET }),
  continuation: Object.freeze({ infix: "ct", suffix: OPAQUE_SECRET }),
  terminalConnect: Object.freeze({ infix: "tc", suffix: OPAQUE_SECRET }),
  browserCallbackNonce: Object.freeze({ infix: "cb", suffix: OPAQUE_SECRET }),
}) satisfies Readonly<Record<string, { readonly infix: CredentialFamilyInfix; readonly suffix: string }>>;

export type CredentialFamily = keyof typeof CREDENTIAL_GRAMMAR;

const BRAND_GROUP = `(?:${CREDENTIAL_BRANDS.join("|")})`;

/**
 * Unanchored source matching the brand and family opening of any credential the
 * product issues. Exported for the workspace secret detector, which needs its
 * own boundary guard around this fragment.
 */
export const CREDENTIAL_OPENING_SOURCE =
  `${BRAND_GROUP}_(?:${CREDENTIAL_FAMILY_INFIXES.join("|")})`;

function credentialPattern(...families: readonly CredentialFamily[]): RegExp {
  const alternatives = families
    .map((family) => `${CREDENTIAL_GRAMMAR[family].infix}_${CREDENTIAL_GRAMMAR[family].suffix}`)
    .join("|");
  return new RegExp(`^${BRAND_GROUP}_(?:${alternatives})$`, "u");
}

const SECRET_API_KEY = credentialPattern("secretKey");
const TRANSPORT_CREDENTIAL = credentialPattern("secretKey", "accessToken");
const ACCESS_TOKEN = credentialPattern("accessToken");
const REFRESH_TOKEN = credentialPattern("refreshToken");
const CONTINUATION_SECRET = credentialPattern("continuation");
const TERMINAL_CONNECT_TOKEN = credentialPattern("terminalConnect");
const BROWSER_CALLBACK_NONCE = credentialPattern("browserCallbackNonce");

/**
 * The non-secret display prefix stored on an API key row and returned by
 * `key list`. Pre-rename rows carry `runa_sk_`; both spellings are live.
 */
const API_KEY_DISPLAY_PREFIX = new RegExp(
  `^${BRAND_GROUP}_${CREDENTIAL_GRAMMAR.secretKey.infix}_[A-Za-z0-9_-]{0,12}$`,
  "u",
);

/** A programmatic API key as the service mints it, in any brand. */
export function isSecretApiKey(value: string): boolean {
  return SECRET_API_KEY.test(value);
}

/** The non-secret `*_sk_` display prefix carried by a stored API key row. */
export function isApiKeyDisplayPrefix(value: string): boolean {
  return API_KEY_DISPLAY_PREFIX.test(value);
}

/** Any credential the HTTP transport may present as a bearer. */
export function isTransportCredential(value: string): boolean {
  return TRANSPORT_CREDENTIAL.test(value);
}

/** An interactive CLI access token. */
export function isAccessToken(value: string): boolean {
  return ACCESS_TOKEN.test(value);
}

/** An interactive CLI refresh token. */
export function isRefreshToken(value: string): boolean {
  return REFRESH_TOKEN.test(value);
}

/** A browser-continuation secret for the human login exchange. */
export function isContinuationSecret(value: string): boolean {
  return CONTINUATION_SECRET.test(value);
}

/** A one-use terminal connection token. */
export function isTerminalConnectToken(value: string): boolean {
  return TERMINAL_CONNECT_TOKEN.test(value);
}

/** The nonce the browser carries back from a human sign-in handoff. */
export function isBrowserCallbackNonce(value: string): boolean {
  return BROWSER_CALLBACK_NONCE.test(value);
}

/**
 * Unanchored source matching a complete credential value of ANY brand and ANY
 * family, with the shortest suffix a leaked secret could plausibly carry.
 *
 * This is the denylist half of the authority. It exists because the public
 * response decoder previously carried its own hand-written copy of the family
 * list that had gone stale at five of eight families — it did not know `se`,
 * `sc` or `cb`, so an audit summary containing a live `runa_sc_…` supervisor
 * bearer decoded cleanly and was printed to the operator's terminal and, under
 * `--json`, into CI logs. A denylist assembled anywhere but here is the same
 * bug waiting for the next family.
 */
export const CREDENTIAL_VALUE_SOURCE = `${CREDENTIAL_OPENING_SOURCE}_[A-Za-z0-9_-]{8,}`;

const CREDENTIAL_VALUE = new RegExp(CREDENTIAL_VALUE_SOURCE, "u");

/**
 * Whether `value` contains a credential of any brand and any family, anywhere
 * inside it. Use this — never a local regex — before printing, forwarding or
 * persisting a string the service controls.
 */
export function containsCredentialValue(value: string): boolean {
  return CREDENTIAL_VALUE.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const ORIGIN_GROUP = `(?:${API_ORIGINS.map(escapeRegExp).join("|")})`;
const PROBLEM_CODE_SOURCE = "[a-z][a-z0-9_]{2,63}";
const PROBLEM_TYPE = new RegExp(`^${ORIGIN_GROUP}/problems/${PROBLEM_CODE_SOURCE}$`, "u");

/**
 * A canonical Problem `type` URI under any origin the service mints. A miss
 * here discards `code`, `request_id` and `retryable` from a server error, so
 * retry and backoff degrade with no signal — never narrow it.
 */
export function isProblemType(value: string): boolean {
  return PROBLEM_TYPE.test(value);
}

/** The Problem `type` URI that exactly names `code`, under any minted origin. */
export function isProblemTypeForCode(value: string, code: string): boolean {
  return API_ORIGINS.some((origin) => value === `${origin}/problems/${code}`);
}

/** The terminal stream URL for `terminalSessionId`, under any minted origin. */
export function isTerminalStreamUrl(value: string, terminalSessionId: string): boolean {
  return API_WEBSOCKET_ORIGINS.some(
    (origin) => value === `${origin}/v1/terminal-connections/${terminalSessionId}/stream`,
  );
}
