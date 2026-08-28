import { createHash, timingSafeEqual } from "node:crypto";

import {
  SensitiveAuthorityError,
  assertSensitiveAuthority,
  identifier,
  requireConsentOnce,
  throwIfAborted,
  validateSensitiveContext,
  type PerOperationConsent,
  type SensitiveOperationContext,
} from "./sensitive-consent.js";

const MAX_GIT_PAYLOAD_BYTES = 65_536;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SAFE_LABEL = /^[\x21-\x7e]{1,256}$/u;

export interface GitSignArgs {
  readonly objectType: "commit" | "tag";
  readonly canonicalPayloadBase64url: string;
  readonly decodedLength: number;
  readonly payloadSha256: `sha256:${string}`;
  readonly keySelectorId: string;
}

export interface GitSignResult {
  readonly signatureBase64url: string;
  readonly decodedLength: number;
  readonly signatureSha256: `sha256:${string}`;
  readonly algorithm: string;
  readonly publicKeyFingerprint: string;
}

export interface GitSigningKey {
  readonly selectorId: string;
  readonly algorithm: string;
  readonly publicKeyFingerprint: string;
  signCanonicalPayload(payload: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>;
  verifyCanonicalPayload(payload: Uint8Array, signature: Uint8Array, signal?: AbortSignal): Promise<boolean>;
}

export interface GitSigningKeyRegistry {
  resolve(selectorId: string, signal?: AbortSignal): Promise<GitSigningKey | null>;
}

export interface GitSigningActionsOptions {
  readonly keys: GitSigningKeyRegistry;
  readonly consent: PerOperationConsent;
}

export class GitSigningActions {
  readonly #options: GitSigningActionsOptions;
  readonly #busySelectors = new Set<string>();

  constructor(options: GitSigningActionsOptions) {
    this.#options = options;
  }

  async sign(
    args: GitSignArgs,
    context: SensitiveOperationContext,
    signal?: AbortSignal,
  ): Promise<GitSignResult> {
    validateSensitiveContext(context);
    const payload = decodeGitPayload(args);
    assertCanonicalGitPayload(args.objectType, payload);
    await assertSensitiveAuthority(context, signal);
    const key = await this.#options.keys.resolve(args.keySelectorId, signal);
    if (key === null || key.selectorId !== args.keySelectorId) throw new GitSigningError("key_selector_unknown");
    validateKeyDescriptor(key);
    if (this.#busySelectors.has(key.selectorId)) throw new GitSigningError("signer_busy");

    this.#busySelectors.add(key.selectorId);
    try {
      await requireConsentOnce(this.#options.consent, context, {
        action: "git.sign",
        operationDigest: args.payloadSha256,
        summary: `Sign ${args.objectType} ${args.payloadSha256.slice(0, 23)} with ${key.selectorId}`,
      }, signal).catch(normalizeAuthorityError);

      // Decode and validate again after the consent boundary. The signer never
      // sees bytes that differ from the digest shown to the user.
      const revalidated = decodeGitPayload(args);
      assertCanonicalGitPayload(args.objectType, revalidated);
      if (payload.byteLength !== revalidated.byteLength || !timingSafeEqual(payload, revalidated)) {
        throw new GitSigningError("payload_changed");
      }
      await assertSensitiveAuthority(context, signal).catch(normalizeAuthorityError);
      throwIfAborted(signal);
      const signature = Buffer.from(await key.signCanonicalPayload(Buffer.from(revalidated), signal));
      if (signature.byteLength < 1 || signature.byteLength > MAX_GIT_PAYLOAD_BYTES) {
        throw new GitSigningError("signature_invalid");
      }
      await assertSensitiveAuthority(context, signal).catch(normalizeAuthorityError);
      if (!await key.verifyCanonicalPayload(Buffer.from(revalidated), Buffer.from(signature), signal)) {
        throw new GitSigningError("signature_verification_failed");
      }
      const encoded = signature.toString("base64url");
      return Object.freeze({
        signatureBase64url: encoded,
        decodedLength: signature.byteLength,
        signatureSha256: digest(signature),
        algorithm: key.algorithm,
        publicKeyFingerprint: key.publicKeyFingerprint,
      });
    } finally {
      this.#busySelectors.delete(key.selectorId);
    }
  }
}

export class GitSigningError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(`Cuna Git signing failed: ${code}.`, options);
    this.name = "GitSigningError";
  }
}

function decodeGitPayload(args: GitSignArgs): Buffer {
  if ((args.objectType !== "commit" && args.objectType !== "tag") || !identifier(args.keySelectorId) ||
    !Number.isSafeInteger(args.decodedLength) || args.decodedLength < 1 || args.decodedLength > MAX_GIT_PAYLOAD_BYTES ||
    !SHA256.test(args.payloadSha256) || !/^[A-Za-z0-9_-]+$/u.test(args.canonicalPayloadBase64url) ||
    args.canonicalPayloadBase64url.length > Math.ceil(MAX_GIT_PAYLOAD_BYTES * 4 / 3) + 2) {
    throw new GitSigningError("payload_invalid");
  }
  const payload = Buffer.from(args.canonicalPayloadBase64url, "base64url");
  if (payload.byteLength !== args.decodedLength || payload.toString("base64url") !== args.canonicalPayloadBase64url ||
    digest(payload) !== args.payloadSha256) throw new GitSigningError("payload_integrity_mismatch");
  return payload;
}

function assertCanonicalGitPayload(objectType: GitSignArgs["objectType"], payload: Uint8Array): void {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(payload); } catch {
    throw new GitSigningError("payload_not_utf8");
  }
  if (text.includes("\0") || text.includes("\r") || !text.endsWith("\n")) throw new GitSigningError("payload_not_canonical");
  const separator = text.indexOf("\n\n");
  if (separator <= 0) throw new GitSigningError("payload_not_canonical");
  const headers = text.slice(0, separator).split("\n");
  if (headers.some((line) => line.startsWith(" ") || !/^[a-z][a-z0-9-]* [^\n]+$/u.test(line))) {
    throw new GitSigningError("payload_not_canonical");
  }
  const names = headers.map((line) => line.slice(0, line.indexOf(" ")));
  if (names.includes("gpgsig") || names.includes("gpgsig-sha256")) throw new GitSigningError("payload_already_signed");
  if (objectType === "commit") {
    const tree = headers[0];
    const authorIndex = names.indexOf("author");
    const committerIndex = names.indexOf("committer");
    if (tree === undefined || !/^tree [0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(tree) ||
      names.filter((name) => name === "tree").length !== 1 || names.filter((name) => name === "author").length !== 1 ||
      names.filter((name) => name === "committer").length !== 1 || authorIndex < 1 || committerIndex !== authorIndex + 1 ||
      names.slice(1, authorIndex).some((name) => name !== "parent") || names.slice(committerIndex + 1).some((name) => name !== "encoding")) {
      throw new GitSigningError("payload_not_canonical_commit");
    }
    return;
  }
  const required = ["object", "type", "tag", "tagger"];
  if (headers.length !== required.length || names.some((name, index) => name !== required[index]) ||
    !/^object [0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(headers[0]!) ||
    !/^type (?:blob|tree|commit|tag)$/u.test(headers[1]!)) {
    throw new GitSigningError("payload_not_canonical_tag");
  }
}

function validateKeyDescriptor(key: GitSigningKey): void {
  if (!identifier(key.selectorId) || !SAFE_LABEL.test(key.algorithm) || !SAFE_LABEL.test(key.publicKeyFingerprint) ||
    typeof key.signCanonicalPayload !== "function" || typeof key.verifyCanonicalPayload !== "function") {
    throw new GitSigningError("key_descriptor_invalid");
  }
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function normalizeAuthorityError(error: unknown): never {
  if (error instanceof SensitiveAuthorityError) throw new GitSigningError(error.code, { cause: error });
  throw error;
}
