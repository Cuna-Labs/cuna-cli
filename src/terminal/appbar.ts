export type ProjectionStatus = "verified" | "unknown" | "unavailable" | "stale" | "contradictory";

export interface StatusEvidence<T> {
  readonly value: T;
  readonly source: string;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly correlationId: string;
}

export type TruthProjection<T> =
  | {
      readonly status: "verified";
      readonly value: T;
      readonly source: string;
      readonly observedAt: number;
      readonly expiresAt: number;
      readonly correlationId: string;
    }
  | { readonly status: Exclude<ProjectionStatus, "verified">; readonly reason: string };

export interface AppbarModel {
  readonly machineLifecycle: TruthProjection<string>;
  readonly agentSessionLifecycle: TruthProjection<string>;
  readonly attachment: TruthProjection<string>;
  readonly providerAuthentication: TruthProjection<string>;
  readonly workspaceSync: TruthProjection<string>;
  readonly cost?: TruthProjection<number>;
  readonly tokensSaved?: TruthProjection<number>;
}

export function projectTruth<T>(evidence: readonly StatusEvidence<T>[], now: number): TruthProjection<T> {
  if (evidence.length === 0) return Object.freeze({ status: "unknown", reason: "no_authoritative_evidence" });
  const wellFormed = evidence.filter(
    (item) =>
      item.source.length > 0 &&
      item.correlationId.length > 0 &&
      Number.isFinite(item.observedAt) &&
      Number.isFinite(item.expiresAt) &&
      item.expiresAt >= item.observedAt,
  );
  if (wellFormed.length !== evidence.length) {
    return Object.freeze({ status: "unavailable", reason: "malformed_evidence" });
  }
  const fresh = wellFormed.filter((item) => item.expiresAt >= now);
  if (fresh.length === 0) return Object.freeze({ status: "stale", reason: "evidence_expired" });
  const newestTimestamp = Math.max(...fresh.map((item) => item.observedAt));
  const newest = fresh.filter((item) => item.observedAt === newestTimestamp);
  if (new Set(newest.map((item) => stableValue(item.value))).size !== 1) {
    return Object.freeze({ status: "contradictory", reason: "equally_fresh_authorities_disagree" });
  }
  const selected = newest[0];
  if (selected === undefined) return Object.freeze({ status: "unknown", reason: "no_authoritative_evidence" });
  return Object.freeze({
    status: "verified",
    value: selected.value,
    source: selected.source,
    observedAt: selected.observedAt,
    expiresAt: selected.expiresAt,
    correlationId: selected.correlationId,
  });
}

export function buildAppbarModel(input: {
  readonly now: number;
  readonly machineLifecycle: readonly StatusEvidence<string>[];
  readonly agentSessionLifecycle: readonly StatusEvidence<string>[];
  readonly attachment: readonly StatusEvidence<string>[];
  readonly providerAuthentication: readonly StatusEvidence<string>[];
  readonly workspaceSync: readonly StatusEvidence<string>[];
  readonly cost?: readonly StatusEvidence<number>[];
  readonly tokensSaved?: readonly StatusEvidence<number>[];
}): AppbarModel {
  const cost = input.cost === undefined ? undefined : projectMetric(input.cost, input.now);
  const tokensSaved = input.tokensSaved === undefined ? undefined : projectMetric(input.tokensSaved, input.now);
  return Object.freeze({
    machineLifecycle: projectTruth(input.machineLifecycle, input.now),
    agentSessionLifecycle: projectTruth(input.agentSessionLifecycle, input.now),
    attachment: projectTruth(input.attachment, input.now),
    providerAuthentication: projectTruth(input.providerAuthentication, input.now),
    workspaceSync: projectTruth(input.workspaceSync, input.now),
    ...(cost === undefined ? {} : { cost }),
    ...(tokensSaved === undefined ? {} : { tokensSaved }),
  });
}

function projectMetric(evidence: readonly StatusEvidence<number>[], now: number): TruthProjection<number> {
  const projection = projectTruth(evidence, now);
  if (projection.status === "verified" && (!Number.isFinite(projection.value) || projection.value < 0)) {
    return Object.freeze({ status: "unavailable", reason: "invalid_metric" });
  }
  return projection;
}

function stableValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
