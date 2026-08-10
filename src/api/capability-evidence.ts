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
