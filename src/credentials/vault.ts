import { createHash, timingSafeEqual } from "node:crypto";

import {
  CREDENTIAL_BACKEND_PROTOCOL,
  type CredentialBinding,
  type CredentialRefreshResult,
  type CredentialSnapshot,
  type CredentialStatus,
  type SecureCredentialBackend,
} from "./contracts.js";
import { CredentialBoundaryError, credentialFailure } from "./errors.js";
import { SecretMaterial } from "./secret-material.js";

const ENVELOPE_MAGIC = new TextEncoder().encode("RUNACRED");
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

interface RefreshFlight {
  readonly promise: Promise<RefreshPayload>;
  waiters: number;
}

export class CredentialVault {
  readonly #backend: SecureCredentialBackend;
  readonly #clock: () => number;
  readonly #platform: NodeJS.Platform;
  readonly #queues = new Map<string, Promise<void>>();
  readonly #refreshes = new Map<string, RefreshFlight>();
  readonly #revoked = new Set<string>();

  constructor(input: {
    readonly backend: SecureCredentialBackend;
    readonly clock?: () => number;
    readonly platform?: NodeJS.Platform;
  }) {
    this.#backend = input.backend;
    this.#clock = input.clock ?? Date.now;
    this.#platform = input.platform ?? process.platform;
  }

  async load(binding: CredentialBinding): Promise<CredentialSnapshot | undefined> {
    const normalized = normalizeBinding(binding);
    const target = credentialTarget(normalized);
    await this.#requireBackend();
    const encoded = await this.#backend.read(target);
    if (encoded === undefined) return undefined;
    try {
      const decoded = decodeEnvelope(encoded, bindingDigest(normalized));
      if (decoded.header.expiresAt !== null && decoded.header.expiresAt <= this.#clock()) {
        decoded.payload.fill(0);
        return undefined;
      }
      return {
        material: SecretMaterial.fromBytes(decoded.payload),
        revision: decoded.header.revision,
        expiresAt: decoded.header.expiresAt ?? undefined,
      };
    } finally {
      encoded.fill(0);
    }
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
      const current = await this.#readEnvelope(target, normalized);
      try {
        if (input.expectedRevision !== undefined && current?.header.revision !== input.expectedRevision) {
          throw credentialFailure(
            "credential_revision_conflict",
            "The credential changed before rotation could be applied.",
            { retryable: true },
          );
        }
        const nextRevision = (current?.header.revision ?? 0) + 1;
        const encoded = input.material.withBytes((bytes) => encodeEnvelope({
          binding: normalized,
          revision: nextRevision,
          storedAt: this.#clock(),
          ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
          payload: bytes,
        }));
        try {
          await this.#backend.replace(target, encoded);
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
      await this.#backend.delete(target);
      this.#revoked.add(target);
      return {
        backendId: this.#backend.backendId,
        backendStatus: "verified",
        state: "revoked",
        bindingDigest: bindingDigest(normalized),
      };
    });
  }

  async status(binding: CredentialBinding): Promise<CredentialStatus> {
    const normalized = normalizeBinding(binding);
    const target = credentialTarget(normalized);
    let evidence;
    try {
      evidence = await this.#backend.probe();
    } catch {
      return this.#unavailableStatus(normalized);
    }
    if (!validEvidence(evidence, this.#backend, this.#platform, this.#clock())) {
      return this.#unavailableStatus(normalized);
    }
    if (this.#revoked.has(target)) {
      return {
        backendId: this.#backend.backendId,
        backendStatus: "verified",
        state: "revoked",
        bindingDigest: bindingDigest(normalized),
      };
    }
    const encoded = await this.#backend.read(target);
    if (encoded === undefined) {
      return {
        backendId: this.#backend.backendId,
        backendStatus: "verified",
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
      );
    } catch (error) {
      if (error instanceof CredentialBoundaryError && error.code === "credential_corrupt") {
        return {
          backendId: this.#backend.backendId,
          backendStatus: "verified",
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
      if (refreshed.status === "rejected") {
        await this.#backend.delete(target);
        this.#revoked.add(target);
        throw credentialFailure(
          "credential_revoked",
          "The renewable credential was rejected and has been removed.",
        );
      }
      const nextRevision = (currentEnvelope?.header.revision ?? 0) + 1;
      const nextBytes = refreshed.material.copyBytes();
      const encoded = encodeEnvelope({
        binding,
        revision: nextRevision,
        storedAt: this.#clock(),
        ...(refreshed.expiresAt !== undefined && { expiresAt: refreshed.expiresAt }),
        payload: nextBytes,
      });
      try {
        await this.#backend.replace(target, encoded);
      } finally {
        encoded.fill(0);
        refreshed.material.dispose();
      }
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

  async #readEnvelope(target: string, binding: CredentialBinding): Promise<{
    readonly header: EnvelopeHeader;
    readonly payload: Uint8Array;
  } | undefined> {
    const encoded = await this.#backend.read(target);
    if (encoded === undefined) return undefined;
    try {
      return decodeEnvelope(encoded, bindingDigest(binding));
    } finally {
      encoded.fill(0);
    }
  }

  async #requireBackend(): Promise<void> {
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
    if (!validEvidence(evidence, this.#backend, this.#platform, this.#clock())) {
      throw credentialFailure(
        evidence.status === "unavailable" ? "credential_backend_unavailable" : "credential_backend_unverified",
        "The secure credential store lacks current platform-bound evidence.",
        { safeDetails: { backendId: this.#backend.backendId, status: evidence.status } },
      );
    }
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

  #presentStatus(binding: CredentialBinding, revision: number, expiresAt: number | undefined): CredentialStatus {
    return {
      backendId: this.#backend.backendId,
      backendStatus: "verified",
      state: expiresAt !== undefined && expiresAt <= this.#clock() ? "expired" : "present",
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
}

export function credentialTarget(binding: CredentialBinding): string {
  return `runa-cli:v1:${bindingDigest(normalizeBinding(binding))}`;
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
  return { header, payload };
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

function validEvidence(
  evidence: Awaited<ReturnType<SecureCredentialBackend["probe"]>>,
  backend: SecureCredentialBackend,
  platform: NodeJS.Platform,
  now: number,
): boolean {
  return evidence.protocol === CREDENTIAL_BACKEND_PROTOCOL &&
    evidence.status === "verified" &&
    evidence.backendId === backend.backendId &&
    evidence.platform === backend.platform &&
    evidence.platform === platform &&
    (evidence.source === "live_round_trip" || evidence.source === "native_bridge_round_trip") &&
    Number.isSafeInteger(evidence.observedAt) &&
    Number.isSafeInteger(evidence.expiresAt) &&
    evidence.observedAt <= now &&
    evidence.expiresAt > now &&
    evidence.expiresAt - evidence.observedAt <= 5 * 60_000;
}
