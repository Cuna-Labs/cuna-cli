import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  CREDENTIAL_BACKEND_PROTOCOL,
  type CredentialBinding,
  type CredentialBackendEvidence,
  type CredentialRefreshResult,
  type CredentialSnapshot,
  type CredentialStatus,
  type SecureCredentialBackend,
} from "./contracts.js";
import { CredentialBoundaryError, credentialFailure } from "./errors.js";
import { SecretMaterial } from "./secret-material.js";

const ENVELOPE_MAGIC = new TextEncoder().encode("CUNACRED");
const ENVELOPE_VERSION = 1;
const MAXIMUM_ENVELOPE_BYTES = 96 * 1024;
const MAXIMUM_HEADER_BYTES = 8 * 1024;

interface EnvelopeHeader {
  readonly version: 1;
  readonly bindingDigest: string;
  readonly revision: number;
  readonly storedAt: number;
  readonly expiresAt: number | null;
  readonly payloadLength: number;
  readonly payloadSha256: string;
}

interface RefreshPayload {
  readonly bytes: Uint8Array;
  readonly revision: number;
  readonly expiresAt: number | undefined;
}

/**
 * A process-local hint for one exact encrypted envelope observed by
 * `refresh`. It is deliberately not an authority: deletion still issues the
 * backend's physical compare-and-delete with this digest, so a second process
 * can only turn the fast path into a safe conflict.
 */
interface ObservedRevisionFence {
  readonly revision: number;
  readonly storageSha256: string;
}

interface RefreshFlight {
  readonly promise: Promise<RefreshPayload>;
  waiters: number;
}

interface DecodedEnvelope {
  readonly header: EnvelopeHeader;
  readonly payload: Uint8Array;
  readonly storageSha256: string;
}

export class CredentialVault {
  readonly #backend: SecureCredentialBackend;
  readonly #clock: () => number;
  readonly #platform: NodeJS.Platform;
  readonly #allowPreviewBackend: boolean;
  readonly #queues = new Map<string, Promise<void>>();
  readonly #refreshes = new Map<string, RefreshFlight>();
  readonly #revoked = new Set<string>();
  readonly #observedRevisionFences = new Map<string, ObservedRevisionFence>();
  // This is process-local liveness evidence only. It never replaces the
  // backend's own lock, ACL, metadata, or CAS checks performed by every read
  // and write. Avoiding redundant probes matters on Windows, where a probe
  // itself requires an owner/DACL inspection through the OS boundary.
  #backendEvidence: CredentialBackendEvidence | undefined;
  #lastObservedNow: number | undefined;

  constructor(input: {
    readonly backend: SecureCredentialBackend;
    readonly clock?: () => number;
    readonly platform?: NodeJS.Platform;
    readonly allowPreviewBackend?: boolean;
  }) {
    this.#backend = input.backend;
    this.#clock = input.clock ?? Date.now;
    this.#platform = input.platform ?? process.platform;
    this.#allowPreviewBackend = input.allowPreviewBackend ?? false;
  }

  async load(binding: CredentialBinding): Promise<CredentialSnapshot | undefined> {
    const normalized = normalizeBinding(binding);
    const target = credentialTarget(normalized);
    return await this.#exclusive(target, async () => {
      await this.#requireBackend();
      const encoded = await this.#backend.read(target);
      if (encoded === undefined) return undefined;
      try {
        const decoded = decodeEnvelope(encoded, bindingDigest(normalized));
        if (decoded.header.expiresAt !== null && decoded.header.expiresAt <= this.#now()) {
          decoded.payload.fill(0);
          // Expired renewable material has no future use. Remove it while the
          // target is exclusively locked so a concurrent rotation cannot be
          // mistaken for the stale envelope we just decoded.
          if (this.#backend.compareAndDelete !== undefined) {
            // The digest belongs to the exact ciphertext decoded above. If a
            // different process rotated it, expiry cleanup loses the compare
            // and must not erase the newer session.
            await this.#backend.compareAndDelete(target, decoded.storageSha256);
          }
          return undefined;
        }
        const material = SecretMaterial.fromBytes(decoded.payload);
        decoded.payload.fill(0);
        return {
          material,
          revision: decoded.header.revision,
          expiresAt: decoded.header.expiresAt ?? undefined,
        };
      } finally {
        encoded.fill(0);
      }
    });
  }

  async rotate(input: {
    readonly binding: CredentialBinding;
    readonly material: SecretMaterial;
    readonly expectedRevision?: number;
    readonly expiresAt?: number;
  }): Promise<CredentialStatus> {
    const normalized = normalizeBinding(input.binding);
    const target = credentialTarget(normalized);
    return await this.#exclusive(target, async () => {
      await this.#requireBackend();
      // A rotation attempt makes any prior read fence unsuitable for a later
      // fast deletion. Even an ambiguous write must fall back to a fresh
      // observation rather than treating a process-local hint as authority.
      this.#observedRevisionFences.delete(target);
      const current = await this.#readEnvelope(target, normalized);
      try {
        if (input.expectedRevision !== undefined && current?.header.revision !== input.expectedRevision) {
          throw credentialFailure(
            "credential_revision_conflict",
            "The credential changed before rotation could be applied.",
            { retryable: true },
          );
        }
        const nextRevision = safeRevisionIncrement(current?.header.revision ?? 0);
        const encoded = input.material.withBytes((bytes) => encodeEnvelope({
          binding: normalized,
          revision: nextRevision,
          storedAt: this.#now(),
          ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
          payload: bytes,
        }));
        try {
          await this.#replaceWithReconciliation(target, encoded, normalized, current);
        } finally {
          encoded.fill(0);
        }
        this.#revoked.delete(target);
        return this.#presentStatus(normalized, nextRevision, input.expiresAt);
      } finally {
        current?.payload.fill(0);
      }
    });
  }

  async refresh(
    binding: CredentialBinding,
    refresher: (current: CredentialSnapshot | undefined) => Promise<CredentialRefreshResult>,
  ): Promise<CredentialSnapshot> {
    const normalized = normalizeBinding(binding);
    const target = credentialTarget(normalized);
    let flight = this.#refreshes.get(target);
    if (flight === undefined) {
      const created: RefreshFlight = {
        waiters: 0,
        promise: this.#exclusive(target, async () => this.#performRefresh(normalized, target, refresher)),
      };
      this.#refreshes.set(target, created);
      flight = created;
    }
    flight.waiters += 1;
    try {
      const result = await flight.promise;
      return {
        material: SecretMaterial.fromBytes(result.bytes),
        revision: result.revision,
        expiresAt: result.expiresAt,
      };
    } finally {
      flight.waiters -= 1;
      if (flight.waiters === 0 && this.#refreshes.get(target) === flight) {
        this.#refreshes.delete(target);
        void flight.promise.then(
          (result) => result.bytes.fill(0),
          () => undefined,
        );
      }
    }
  }

  async delete(binding: CredentialBinding): Promise<CredentialStatus> {
    const normalized = normalizeBinding(binding);
    const target = credentialTarget(normalized);
    return await this.#exclusive(target, async () => {
      await this.#requireBackend();
      this.#observedRevisionFences.delete(target);
      await this.#backend.delete(target);
      this.#revoked.add(target);
      return {
        backendId: this.#backend.backendId,
        backendStatus: this.#allowPreviewBackend ? "preview" : "verified",
        state: "revoked",
        bindingDigest: bindingDigest(normalized),
      };
    });
  }

  /**
   * Remove a session only when the exact revision written by this operation is
   * still current.  A conflict is a successful safety outcome: a concurrent
   * process owns the newer session and must not be erased as compensation for
   * this caller.
   */
  async deleteIfRevision(input: {
    readonly binding: CredentialBinding;
    readonly expectedRevision: number;
  }): Promise<"deleted" | "absent" | "conflict"> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw credentialFailure("credential_binding_invalid", "The credential revision is invalid.");
    }
    const normalized = normalizeBinding(input.binding);
    const target = credentialTarget(normalized);
    return await this.#exclusive(target, async () => {
      await this.#requireBackend();
      if (this.#backend.compareAndDelete === undefined) {
        throw credentialFailure(
          "credential_backend_unverified",
          "The secure credential store cannot safely remove a revision-fenced session.",
        );
      }
      // `refresh` has already parsed this exact envelope while it was read
      // through the backend boundary. Avoid a second identical read only when
      // that private observation matches the requested revision. The backend
      // still atomically reads and compares the digest under its physical
      // lock; a changed session is a conflict, never a deletion.
      const fence = this.#observedRevisionFences.get(target);
      if (fence !== undefined && fence.revision === input.expectedRevision) {
        this.#observedRevisionFences.delete(target);
        const outcome = await this.#backend.compareAndDelete(target, fence.storageSha256);
        if (outcome === "deleted" || outcome === "absent") {
          this.#revoked.add(target);
          return outcome;
        }
        if (outcome === "conflict") return outcome;
        throw credentialFailure(
          "credential_backend_failure",
          "The secure credential store returned an invalid revision-fenced deletion result.",
        );
      }
      const current = await this.#readEnvelope(target, normalized);
      if (current === undefined) {
        this.#revoked.add(target);
        return "absent";
      }
      try {
        if (current.header.revision !== input.expectedRevision) return "conflict";
        const outcome = await this.#backend.compareAndDelete(target, current.storageSha256);
        if (outcome === "deleted" || outcome === "absent") {
          this.#revoked.add(target);
          return outcome;
        }
        if (outcome === "conflict") return outcome;
        throw credentialFailure(
          "credential_backend_failure",
          "The secure credential store returned an invalid revision-fenced deletion result.",
        );
      } finally {
        current.payload.fill(0);
      }
    });
  }

  async status(binding: CredentialBinding): Promise<CredentialStatus> {
    const normalized = normalizeBinding(binding);
    const target = credentialTarget(normalized);
    let evidence: CredentialBackendEvidence;
    try {
      evidence = await this.#requireBackend();
    } catch {
      return this.#unavailableStatus(normalized);
    }
    if (this.#revoked.has(target)) {
      return {
        backendId: this.#backend.backendId,
        backendStatus: evidence.status,
        state: "revoked",
        bindingDigest: bindingDigest(normalized),
      };
    }
    const encoded = await this.#backend.read(target);
    if (encoded === undefined) {
      return {
        backendId: this.#backend.backendId,
        backendStatus: evidence.status,
        state: "absent",
        bindingDigest: bindingDigest(normalized),
      };
    }
    try {
      const decoded = decodeEnvelope(encoded, bindingDigest(normalized));
      decoded.payload.fill(0);
      return this.#presentStatus(
        normalized,
        decoded.header.revision,
        decoded.header.expiresAt ?? undefined,
        evidence.status === "preview" ? "preview" : "verified",
      );
    } catch (error) {
      if (error instanceof CredentialBoundaryError && error.code === "credential_corrupt") {
        return {
          backendId: this.#backend.backendId,
          backendStatus: evidence.status === "preview" ? "preview" : "verified",
          state: "corrupt",
          bindingDigest: bindingDigest(normalized),
        };
      }
      throw error;
    } finally {
      encoded.fill(0);
    }
  }

  async #performRefresh(
    binding: CredentialBinding,
    target: string,
    refresher: (current: CredentialSnapshot | undefined) => Promise<CredentialRefreshResult>,
  ): Promise<RefreshPayload> {
    await this.#requireBackend();
    // A new refresh is a fresh durability observation. Any fence from an
    // earlier refresh must not be reused if this invocation rejects, rotates,
    // or encounters an uncertain backend outcome.
    this.#observedRevisionFences.delete(target);
    const currentEnvelope = await this.#readEnvelope(target, binding);
    const currentSnapshot = currentEnvelope === undefined ? undefined : {
      material: SecretMaterial.fromBytes(currentEnvelope.payload),
      revision: currentEnvelope.header.revision,
      expiresAt: currentEnvelope.header.expiresAt ?? undefined,
    };
    try {
      let refreshed: CredentialRefreshResult;
      try {
        refreshed = await refresher(currentSnapshot);
      } catch {
        throw credentialFailure(
          "credential_refresh_failed",
          "Credential refresh failed without changing the stored credential.",
          { retryable: true },
        );
      }
      if (refreshed.status === "missing") {
        if (currentEnvelope !== undefined) {
          throw credentialFailure(
            "credential_refresh_failed",
            "Credential refresh reported an absent credential after reading one.",
          );
        }
        throw credentialFailure(
          "credential_missing",
          "Credential refresh requires a stored credential.",
        );
      }
      if (refreshed.status === "rejected") {
        if (currentEnvelope === undefined) {
          throw credentialFailure(
            "credential_refresh_failed",
            "Credential refresh rejected an absent credential.",
          );
        }
        if (this.#backend.compareAndDelete === undefined) {
          throw credentialFailure(
            "credential_backend_unverified",
            "The secure credential store cannot safely reconcile a rejected session.",
          );
        }
        let outcome: "deleted" | "absent" | "conflict";
        try {
          outcome = await this.#backend.compareAndDelete(target, currentEnvelope.storageSha256);
        } catch (cause) {
          throw credentialFailure(
            "credential_backend_failure",
            "The secure credential store could not reconcile a rejected session.",
            { retryable: true, cause },
          );
        }
        if (outcome === "conflict") {
          throw credentialFailure(
            "credential_revision_conflict",
            "The credential changed while a rejected session was being reconciled.",
            { retryable: true },
          );
        }
        if (outcome !== "deleted" && outcome !== "absent") {
          throw credentialFailure(
            "credential_backend_failure",
            "The secure credential store returned an invalid rejected-session reconciliation result.",
          );
        }
        this.#revoked.add(target);
        throw credentialFailure(
          "credential_revoked",
          "The renewable credential was rejected and has been removed.",
          { safeDetails: { refreshRejection: refreshed.reason } },
        );
      }
      if (refreshed.status === "retained") {
        if (currentEnvelope === undefined) {
          throw credentialFailure(
            "credential_refresh_failed",
            "Credential refresh cannot retain an absent credential.",
          );
        }
        // This is only an optimization token for a subsequent exact
        // revision-fenced cleanup in this vault instance. It is not returned
        // to callers and never bypasses the backend's physical CAS.
        this.#observedRevisionFences.set(target, {
          revision: currentEnvelope.header.revision,
          storageSha256: currentEnvelope.storageSha256,
        });
        return {
          bytes: currentEnvelope.payload.slice(),
          revision: currentEnvelope.header.revision,
          expiresAt: currentEnvelope.header.expiresAt ?? undefined,
        };
      }
      const nextRevision = safeRevisionIncrement(currentEnvelope?.header.revision ?? 0);
      let nextBytes: Uint8Array | undefined;
      let encoded: Uint8Array | undefined;
      let replaced = false;
      try {
        nextBytes = refreshed.material.copyBytes();
        encoded = encodeEnvelope({
          binding,
          revision: nextRevision,
          storedAt: this.#now(),
          ...(refreshed.expiresAt !== undefined && { expiresAt: refreshed.expiresAt }),
          payload: nextBytes,
        });
        await this.#replaceWithReconciliation(target, encoded, binding, currentEnvelope);
        replaced = true;
      } finally {
        encoded?.fill(0);
        if (!replaced) nextBytes?.fill(0);
        refreshed.material.dispose();
      }
      if (nextBytes === undefined) throw credentialFailure("credential_refresh_failed", "Credential refresh did not produce protected material.");
      this.#revoked.delete(target);
      return {
        bytes: nextBytes,
        revision: nextRevision,
        expiresAt: refreshed.expiresAt,
      };
    } finally {
      currentSnapshot?.material.dispose();
      currentEnvelope?.payload.fill(0);
    }
  }

  async #readEnvelope(target: string, binding: CredentialBinding): Promise<DecodedEnvelope | undefined> {
    const encoded = await this.#backend.read(target);
    if (encoded === undefined) return undefined;
    try {
      return decodeEnvelope(encoded, bindingDigest(binding));
    } finally {
      encoded.fill(0);
    }
  }

  async #requireBackend(): Promise<CredentialBackendEvidence> {
    const now = this.#now();
    const cached = this.#backendEvidence;
    if (cached !== undefined && validEvidence(cached, this.#backend, this.#platform, now, this.#allowPreviewBackend)) {
      return cached;
    }
    let evidence;
    try {
      evidence = await this.#backend.probe();
    } catch (cause) {
      throw credentialFailure(
        "credential_backend_unavailable",
        "The secure credential store could not be verified.",
        { cause },
      );
    }
    if (!validEvidence(evidence, this.#backend, this.#platform, this.#now(), this.#allowPreviewBackend)) {
      throw credentialFailure(
        evidence.status === "unavailable" ? "credential_backend_unavailable" : "credential_backend_unverified",
        "The secure credential store lacks current platform-bound evidence.",
        {
          safeDetails: {
            backendId: this.#backend.backendId,
            status: evidence.status,
            // The backend states WHY it is unavailable and this frame used to
            // drop it, so every cause printed the same unactionable sentence.
            ...(evidence.reason === undefined ? {} : { reason: evidence.reason }),
          },
        },
      );
    }
    this.#backendEvidence = evidence;
    return evidence;
  }

  async #replaceWithReconciliation(
    target: string,
    encoded: Uint8Array,
    binding: CredentialBinding,
    previous: DecodedEnvelope | undefined,
  ): Promise<void> {
    try {
      if (this.#backend.compareAndSwap !== undefined) {
        const result = await this.#backend.compareAndSwap(target, previous?.storageSha256 ?? null, encoded);
        if (result === "conflict") {
          throw credentialFailure(
            "credential_revision_conflict",
            "The credential changed before rotation could be applied.",
            { retryable: true },
          );
        }
      } else {
        await this.#backend.replace(target, encoded);
      }
      return;
    } catch (error) {
      if (error instanceof CredentialBoundaryError && error.code === "credential_revision_conflict") throw error;
      // A durable backend can commit and still lose its acknowledgement. Retrying
      // an unknown replacement would rotate the same logical credential twice.
      // Read back by stable target and adjudicate the effect before returning.
    }
    let observed: Uint8Array | undefined;
    try {
      observed = await this.#backend.read(target);
      if (observed !== undefined && bytesEqual(observed, encoded)) return;
      if (observed === undefined && previous === undefined) {
        throw credentialFailure(
          "credential_backend_failure",
          "The secure credential replacement was not committed.",
          { retryable: true, safeDetails: { replacementOutcome: "not_committed" } },
        );
      }
      if (observed !== undefined && previous !== undefined) {
        let decoded: DecodedEnvelope | undefined;
        try {
          decoded = decodeEnvelope(observed, bindingDigest(binding));
          if (sameEnvelope(decoded, previous)) {
            throw credentialFailure(
              "credential_backend_failure",
              "The secure credential replacement was not committed.",
              { retryable: true, safeDetails: { replacementOutcome: "not_committed" } },
            );
          }
        } catch (error) {
          if (error instanceof CredentialBoundaryError && error.code === "credential_backend_failure") throw error;
        } finally {
          decoded?.payload.fill(0);
        }
      }
    } catch (error) {
      if (error instanceof CredentialBoundaryError && error.code === "credential_backend_failure") throw error;
    } finally {
      observed?.fill(0);
    }
    throw credentialFailure(
      "credential_backend_failure",
      "The secure credential replacement outcome is unknown and requires reconciliation.",
      { safeDetails: { replacementOutcome: "ambiguous" } },
    );
  }

  async #exclusive<T>(target: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#queues.get(target) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = predecessor.catch(() => undefined).then(async () => gate);
    this.#queues.set(target, queued);
    await predecessor.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#queues.get(target) === queued) this.#queues.delete(target);
    }
  }

  #presentStatus(
    binding: CredentialBinding,
    revision: number,
    expiresAt: number | undefined,
    backendStatus: "verified" | "preview" = this.#allowPreviewBackend ? "preview" : "verified",
  ): CredentialStatus {
    return {
      backendId: this.#backend.backendId,
      backendStatus,
      state: expiresAt !== undefined && expiresAt <= this.#now() ? "expired" : "present",
      bindingDigest: bindingDigest(binding),
      revision,
      ...(expiresAt !== undefined && { expiresAt }),
    };
  }

  #unavailableStatus(binding: CredentialBinding): CredentialStatus {
    return {
      backendId: this.#backend.backendId,
      backendStatus: "unavailable",
      state: "unavailable",
      bindingDigest: bindingDigest(binding),
    };
  }

  #now(): number {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0 || (this.#lastObservedNow !== undefined && now < this.#lastObservedNow)) {
      throw credentialFailure(
        "credential_backend_unverified",
        "The credential boundary clock is not trustworthy.",
        { safeDetails: { clockTrusted: false } },
      );
    }
    this.#lastObservedNow = now;
    return now;
  }
}

/**
 * The single mint for the credential namespace. Every target this product hands
 * to its encrypted local store -- real or probe -- is produced here. Callers
 * must not concatenate target strings: a target outside this grammar is not a
 * credential target and must fail before it reaches storage.
 */
export function credentialTarget(binding: CredentialBinding): string {
  return `cuna-cli:v1:${bindingDigest(normalizeBinding(binding))}`;
}

/**
 * The reserved binding a backend liveness probe writes, reads back and deletes.
 *
 * The probe must be indistinguishable from a real target to an *acceptor* and
 * distinguishable from a real credential to the *store*. Both hold because the
 * target is a SHA-256 over the length-prefixed 4-tuple, which is injective: two
 * targets are equal only if the tuples are equal or SHA-256 collides. The
 * probe's `workspaceId` carries 256 bits of fresh CSPRNG entropy, so colliding
 * with a genuine binding requires a caller to supply the exact nonce drawn
 * microseconds earlier. The probe therefore cannot read, overwrite or delete a
 * stored credential, and every probe uses a target no probe has used before.
 */
const PROBE_BINDING_NAMESPACE = "cuna.credential-backend-probe.v1";
const PROBE_BINDING_KIND = "credential-backend-liveness-probe";
const PROBE_NONCE_BYTES = 32;

export function probeCredentialTarget(nonce: Uint8Array = randomBytes(PROBE_NONCE_BYTES)): string {
  if (nonce.byteLength !== PROBE_NONCE_BYTES) {
    throw credentialFailure(
      "credential_binding_invalid",
      "A credential probe target is bound to exactly 256 bits of fresh entropy.",
    );
  }
  return credentialTarget({
    profileId: PROBE_BINDING_NAMESPACE,
    accountId: PROBE_BINDING_NAMESPACE,
    workspaceId: `${PROBE_BINDING_NAMESPACE}:${hexadecimal(nonce)}`,
    kind: PROBE_BINDING_KIND,
  });
}

function hexadecimal(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

export function bindingDigest(binding: CredentialBinding): string {
  const canonical = [binding.profileId, binding.accountId, binding.workspaceId, binding.kind]
    .map((value) => `${new TextEncoder().encode(value).byteLength}:${value}`)
    .join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function normalizeBinding(binding: CredentialBinding): CredentialBinding {
  return Object.freeze({
    profileId: normalizeIdentifier("profile", binding.profileId, 256),
    accountId: normalizeIdentifier("account", binding.accountId, 256),
    workspaceId: normalizeIdentifier("workspace", binding.workspaceId, 256),
    kind: normalizeIdentifier("kind", binding.kind, 64),
  });
}

function normalizeIdentifier(label: string, value: string, maximumBytes: number): string {
  if (typeof value !== "string") {
    throw credentialFailure("credential_binding_invalid", `The credential ${label} binding is invalid.`);
  }
  const normalized = value.normalize("NFC");
  const bytes = new TextEncoder().encode(normalized).byteLength;
  if (bytes < 1 || bytes > maximumBytes || hasForbiddenControl(normalized)) {
    throw credentialFailure("credential_binding_invalid", `The credential ${label} binding is invalid.`);
  }
  return normalized;
}

function hasForbiddenControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function encodeEnvelope(input: {
  readonly binding: CredentialBinding;
  readonly revision: number;
  readonly storedAt: number;
  readonly expiresAt?: number;
  readonly payload: Uint8Array;
}): Uint8Array {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw credentialFailure("credential_corrupt", "Credential revision is invalid.");
  }
  if (input.payload.byteLength < 1 || input.payload.byteLength > 32_768) {
    throw credentialFailure("credential_corrupt", "Credential material has an invalid size.");
  }
  if (
    !Number.isSafeInteger(input.storedAt) ||
    (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.storedAt))
  ) {
    throw credentialFailure("credential_corrupt", "Credential timestamps are invalid.");
  }
  const header: EnvelopeHeader = {
    version: ENVELOPE_VERSION,
    bindingDigest: bindingDigest(input.binding),
    revision: input.revision,
    storedAt: input.storedAt,
    expiresAt: input.expiresAt ?? null,
    payloadLength: input.payload.byteLength,
    payloadSha256: createHash("sha256").update(input.payload).digest("hex"),
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  if (headerBytes.byteLength > MAXIMUM_HEADER_BYTES) {
    throw credentialFailure("credential_corrupt", "Credential metadata is oversized.");
  }
  const encoded = new Uint8Array(ENVELOPE_MAGIC.byteLength + 4 + headerBytes.byteLength + input.payload.byteLength);
  encoded.set(ENVELOPE_MAGIC, 0);
  new DataView(encoded.buffer).setUint32(ENVELOPE_MAGIC.byteLength, headerBytes.byteLength, false);
  encoded.set(headerBytes, ENVELOPE_MAGIC.byteLength + 4);
  encoded.set(input.payload, ENVELOPE_MAGIC.byteLength + 4 + headerBytes.byteLength);
  return encoded;
}

function decodeEnvelope(encoded: Uint8Array, expectedBindingDigest: string): {
  readonly header: EnvelopeHeader;
  readonly payload: Uint8Array;
  readonly storageSha256: string;
} {
  if (encoded.byteLength < ENVELOPE_MAGIC.byteLength + 5 || encoded.byteLength > MAXIMUM_ENVELOPE_BYTES) {
    throw credentialFailure("credential_corrupt", "The protected credential envelope is invalid.");
  }
  for (let index = 0; index < ENVELOPE_MAGIC.byteLength; index += 1) {
    if (encoded[index] !== ENVELOPE_MAGIC[index]) {
      throw credentialFailure("credential_corrupt", "The protected credential envelope is invalid.");
    }
  }
  const headerLength = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    .getUint32(ENVELOPE_MAGIC.byteLength, false);
  if (headerLength < 2 || headerLength > MAXIMUM_HEADER_BYTES) {
    throw credentialFailure("credential_corrupt", "The protected credential metadata is invalid.");
  }
  const payloadOffset = ENVELOPE_MAGIC.byteLength + 4 + headerLength;
  if (payloadOffset >= encoded.byteLength) {
    throw credentialFailure("credential_corrupt", "The protected credential payload is missing.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded.slice(ENVELOPE_MAGIC.byteLength + 4, payloadOffset)));
  } catch (cause) {
    throw credentialFailure("credential_corrupt", "The protected credential metadata is malformed.", { cause });
  }
  const header = parseHeader(parsed);
  const payload = encoded.slice(payloadOffset);
  const actualDigest = createHash("sha256").update(payload).digest();
  const declaredDigest = Buffer.from(header.payloadSha256, "hex");
  const bindingMatches = safeHexEqual(header.bindingDigest, expectedBindingDigest);
  const payloadMatches = declaredDigest.byteLength === actualDigest.byteLength && timingSafeEqual(declaredDigest, actualDigest);
  if (!bindingMatches || header.payloadLength !== payload.byteLength || !payloadMatches) {
    payload.fill(0);
    throw credentialFailure("credential_corrupt", "The protected credential failed binding or integrity validation.");
  }
  return { header, payload, storageSha256: createHash("sha256").update(encoded).digest("hex") };
}

function parseHeader(value: unknown): EnvelopeHeader {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw credentialFailure("credential_corrupt", "The protected credential metadata is invalid.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = ["bindingDigest", "expiresAt", "payloadLength", "payloadSha256", "revision", "storedAt", "version"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw credentialFailure("credential_corrupt", "The protected credential metadata shape is invalid.");
  }
  if (
    record.version !== ENVELOPE_VERSION ||
    typeof record.bindingDigest !== "string" || !/^[a-f0-9]{64}$/u.test(record.bindingDigest) ||
    !Number.isSafeInteger(record.revision) || (record.revision as number) < 1 ||
    !Number.isSafeInteger(record.storedAt) || (record.storedAt as number) < 0 ||
    !(record.expiresAt === null || (Number.isSafeInteger(record.expiresAt) && (record.expiresAt as number) > (record.storedAt as number))) ||
    !Number.isSafeInteger(record.payloadLength) || (record.payloadLength as number) < 1 || (record.payloadLength as number) > 32_768 ||
    typeof record.payloadSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.payloadSha256)
  ) {
    throw credentialFailure("credential_corrupt", "The protected credential metadata values are invalid.");
  }
  return record as unknown as EnvelopeHeader;
}

function safeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function sameEnvelope(left: DecodedEnvelope, right: DecodedEnvelope): boolean {
  return left.header.version === right.header.version &&
    left.header.bindingDigest === right.header.bindingDigest &&
    left.header.revision === right.header.revision &&
    left.header.storedAt === right.header.storedAt &&
    left.header.expiresAt === right.header.expiresAt &&
    left.header.payloadLength === right.header.payloadLength &&
    left.header.payloadSha256 === right.header.payloadSha256 &&
    bytesEqual(left.payload, right.payload);
}

function safeRevisionIncrement(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
    throw credentialFailure("credential_corrupt", "Credential revision cannot be advanced safely.");
  }
  return revision + 1;
}

function validEvidence(
  evidence: Awaited<ReturnType<SecureCredentialBackend["probe"]>>,
  backend: SecureCredentialBackend,
  platform: NodeJS.Platform,
  now: number,
  allowPreviewBackend: boolean,
): boolean {
  const verifiedEvidence = evidence.status === "verified" &&
    (evidence.source === "live_round_trip" || evidence.source === "encrypted_local_file");
  const previewEvidence = allowPreviewBackend && evidence.status === "preview" &&
    evidence.source === "local_file_preview" && evidence.reason === undefined;
  return evidence.protocol === CREDENTIAL_BACKEND_PROTOCOL &&
    (verifiedEvidence || previewEvidence) &&
    evidence.backendId === backend.backendId &&
    evidence.platform === backend.platform &&
    evidence.platform === platform &&
    Number.isSafeInteger(evidence.observedAt) &&
    Number.isSafeInteger(evidence.expiresAt) &&
    evidence.observedAt <= now &&
    evidence.expiresAt > now &&
    evidence.expiresAt - evidence.observedAt <= 5 * 60_000;
}
