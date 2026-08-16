import type { CapabilitySnapshot } from "./contracts.js";

export const CAPABILITY_SCHEMA_VERSION = "1.0" as const;
export const MAX_CAPABILITY_TTL_MS = 60_000;
export const MAX_CAPABILITY_FUTURE_SKEW_MS = 5_000;

export type CapabilitySnapshotValidity =
  | "valid"
  | "unsupported_schema"
  | "malformed_freshness"
  | "future_observation"
  | "excessive_ttl"
  | "expired";

/**
 * The snapshot faults no amount of retrying can clear.
 *
 * A snapshot whose schema this build does not know, whose freshness fields are
 * inconsistent, or whose TTL exceeds the contract maximum is a server-contract
 * fault: the same request produces the same snapshot. `expired` and
 * `future_observation` are the two that a later attempt (or a corrected clock)
 * can resolve. Every one of the five used to be reported as `snapshot_expired`,
 * which told the user to retry three faults that can never succeed.
 */
export const PERMANENT_SNAPSHOT_FAULTS: readonly CapabilitySnapshotValidity[] = Object.freeze([
  "unsupported_schema",
  "malformed_freshness",
  "excessive_ttl",
]);

export function isPermanentSnapshotFault(reason: string | undefined): boolean {
  return reason !== undefined && (PERMANENT_SNAPSHOT_FAULTS as readonly string[]).includes(reason);
}

export function classifyCapabilitySnapshot(
  snapshot: CapabilitySnapshot,
  now = Date.now(),
): CapabilitySnapshotValidity {
  if (snapshot.schemaVersion !== CAPABILITY_SCHEMA_VERSION) return "unsupported_schema";
  const observedAt = Date.parse(snapshot.observedAt);
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt) || expiresAt < observedAt) {
    return "malformed_freshness";
  }
  if (observedAt > now + MAX_CAPABILITY_FUTURE_SKEW_MS) return "future_observation";
  if (expiresAt - observedAt > MAX_CAPABILITY_TTL_MS) return "excessive_ttl";
  if (expiresAt <= now) return "expired";
  return "valid";
}
