export type LeaseState = "unheld" | "active" | "expired" | "released";

export interface FenceToken {
  readonly resourceId: string;
  readonly ownerId: string;
  readonly generation: number;
}

export interface LeaseSnapshot extends FenceToken {
  readonly state: LeaseState;
  readonly acquiredAt: number;
  readonly expiresAt: number;
}

export class LeaseError extends Error {
  readonly code: "lease_conflict" | "stale_fence" | "invalid_lease" | "lease_expired";

  constructor(code: LeaseError["code"], message: string) {
    super(message);
    this.name = "LeaseError";
    this.code = code;
  }
}

interface LeaseRecord {
  ownerId: string;
  generation: number;
  acquiredAt: number;
  expiresAt: number;
  released: boolean;
}

export class FencedLeaseStore {
  readonly #clock: () => number;
  readonly #records = new Map<string, LeaseRecord>();
  readonly #lastGeneration = new Map<string, number>();

  constructor(clock: () => number = Date.now) {
    this.#clock = clock;
  }

  acquire(resourceId: string, ownerId: string, ttlMs: number): LeaseSnapshot {
    assertIdentifier(resourceId, "resourceId");
    assertIdentifier(ownerId, "ownerId");
    assertTtl(ttlMs);
    const now = this.#clock();
    const current = this.#records.get(resourceId);
    if (current !== undefined && !current.released && current.expiresAt > now) {
      if (current.ownerId === ownerId) return snapshot(resourceId, current, now);
      throw new LeaseError("lease_conflict", "Another writer holds the active lease.");
    }
    const generation = (this.#lastGeneration.get(resourceId) ?? 0) + 1;
    const next: LeaseRecord = { ownerId, generation, acquiredAt: now, expiresAt: now + ttlMs, released: false };
    this.#records.set(resourceId, next);
    this.#lastGeneration.set(resourceId, generation);
    return snapshot(resourceId, next, now);
  }

  renew(token: FenceToken, ttlMs: number): LeaseSnapshot {
    assertTtl(ttlMs);
    const current = this.#assertCurrent(token);
    const now = this.#clock();
    if (current.expiresAt <= now) {
      throw new LeaseError("lease_expired", "The writer lease has expired and must be reacquired.");
    }
    current.expiresAt = now + ttlMs;
    return snapshot(token.resourceId, current, now);
  }

  release(token: FenceToken): LeaseSnapshot {
    const current = this.#assertCurrent(token);
    const now = this.#clock();
    if (current.expiresAt <= now) {
      throw new LeaseError("lease_expired", "The writer lease expired before release.");
    }
    current.released = true;
    return snapshot(token.resourceId, current, now);
  }

  assertWriter(token: FenceToken): void {
    const current = this.#assertCurrent(token);
    if (current.expiresAt <= this.#clock()) {
      throw new LeaseError("lease_expired", "The writer lease is no longer active.");
    }
  }

  inspect(resourceId: string): LeaseSnapshot | undefined {
    const record = this.#records.get(resourceId);
    return record === undefined ? undefined : snapshot(resourceId, record, this.#clock());
  }

  #assertCurrent(token: FenceToken): LeaseRecord {
    const current = this.#records.get(token.resourceId);
    if (
      current === undefined ||
      current.released ||
      current.ownerId !== token.ownerId ||
      current.generation !== token.generation
    ) {
      throw new LeaseError("stale_fence", "The writer fence is stale or no longer owns the resource.");
    }
    return current;
  }
}

function snapshot(resourceId: string, record: LeaseRecord, now: number): LeaseSnapshot {
  const state: LeaseState = record.released ? "released" : record.expiresAt <= now ? "expired" : "active";
  return Object.freeze({
    resourceId,
    ownerId: record.ownerId,
    generation: record.generation,
    state,
    acquiredAt: record.acquiredAt,
    expiresAt: record.expiresAt,
  });
}

function assertIdentifier(value: string, name: string): void {
  if (value.length === 0 || value.length > 256 || value.includes("\0")) {
    throw new LeaseError("invalid_lease", `${name} is invalid.`);
  }
}

function assertTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 100 || ttlMs > 5 * 60_000) {
    throw new LeaseError("invalid_lease", "The lease TTL is outside the supported bounds.");
  }
}
