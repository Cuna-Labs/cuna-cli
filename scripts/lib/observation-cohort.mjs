import { invariant } from "./release-evidence.mjs";

// CI already produces observation receipts, but that lane is explicitly
// non-authorizing: `observed-artifact` carries `continue-on-error: true`, so a
// platform that fails to run at all leaves the same green CI as one that
// passed. A summary built from it can report "nothing was rejected" while every
// receipt is simply missing. That is why `observation-summary.json` hard-codes
// `releaseEligible: false`.
//
// A cohort is the authorizing form of the same evidence: it is bound to one
// exact candidate envelope, it is produced by its own workflow run whose lanes
// are allowed to fail the run, and it is complete -- every observation identity
// the support policy declares was verified, none missing and none rejected.
// Anything short of that is not a cohort and must not be representable.

const SHA256 = /^[0-9a-f]{64}$/u;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CANONICAL_TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;

export const OBSERVATION_COHORT_WORKFLOW = ".github/workflows/distribution-observation.yml";
export const OBSERVATION_COHORT_STATUS = "CANDIDATE_BOUND_OBSERVATION_COHORT_COMPLETE";

function exactKeys(value, expected, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  invariant(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
    `${label} keys differ`,
  );
}

function sortedIdSet(value, label) {
  invariant(Array.isArray(value) && value.length > 0, `${label} must be a non-empty list`);
  for (const id of value) invariant(typeof id === "string" && ID.test(id), `${label} contains an invalid identity`);
  invariant(new Set(value).size === value.length, `${label} contains duplicates`);
  invariant(JSON.stringify(value) === JSON.stringify([...value].sort()), `${label} is not sorted`);
  return value;
}

/**
 * Validate a cohort document in isolation. Completeness is a shape invariant
 * here, not a field: a document that admits a missing or rejected observation
 * cannot pass, so an incomplete cohort has no representation to attest.
 */
export function validateObservationCohort(cohort) {
  exactKeys(
    cohort,
    [
      "schemaVersion",
      "status",
      "releaseEnvelopeSha256",
      "supportPolicySha256",
      "candidateRunId",
      "workflow",
      "runId",
      "runAttempt",
      "observationIds",
      "generatedAt",
    ],
    "observation cohort",
  );
  invariant(cohort.schemaVersion === 1, "Unsupported observation-cohort schema");
  invariant(cohort.status === OBSERVATION_COHORT_STATUS, "Observation cohort is not a complete candidate-bound cohort");
  invariant(SHA256.test(cohort.releaseEnvelopeSha256), "Observation cohort envelope digest is invalid");
  invariant(SHA256.test(cohort.supportPolicySha256), "Observation cohort support-policy digest is invalid");
  invariant(/^[1-9][0-9]*$/u.test(cohort.candidateRunId), "Observation cohort candidate run identity is invalid");
  invariant(cohort.workflow === OBSERVATION_COHORT_WORKFLOW, "Observation cohort producer workflow differs");
  invariant(/^[1-9][0-9]*$/u.test(cohort.runId), "Observation cohort run identity is invalid");
  invariant(Number.isSafeInteger(cohort.runAttempt) && cohort.runAttempt > 0, "Observation cohort run attempt is invalid");
  sortedIdSet(cohort.observationIds, "Observation cohort identities");
  invariant(CANONICAL_TIMESTAMP.test(cohort.generatedAt ?? ""), "Observation cohort timestamp must be canonical UTC RFC3339");
  invariant(new Date(Date.parse(cohort.generatedAt)).toISOString() === cohort.generatedAt, "Observation cohort timestamp is not canonical");
  return cohort;
}

/**
 * Bind a cohort to the exact candidate and policy a reviewer is holding. The
 * summary is the reviewed, existing receipt validator's output; this only
 * decides whether it was COMPLETE and describes the same candidate.
 */
export function validateObservationCohortAgainstCandidate(cohort, { releaseEnvelopeSha256, supportPolicySha256, candidateRunId, expectedObservationIds }) {
  validateObservationCohort(cohort);
  invariant(cohort.releaseEnvelopeSha256 === releaseEnvelopeSha256, "Observation cohort describes a different release envelope");
  invariant(cohort.supportPolicySha256 === supportPolicySha256, "Observation cohort describes a different support policy");
  invariant(cohort.candidateRunId === String(candidateRunId), "Observation cohort describes a different candidate run");
  invariant(
    JSON.stringify(cohort.observationIds) === JSON.stringify(sortedIdSet([...expectedObservationIds].sort(), "Expected observation identities")),
    "Observation cohort does not cover exactly the declared observation-only lanes",
  );
  return cohort;
}

/**
 * Build a cohort from the non-authorizing summary the receipt validator emits.
 * This is the only place the summary is promoted, and it refuses unless the
 * summary shows a complete, candidate-bound result.
 */
export function buildObservationCohort({ summary, candidateRunId, runId, runAttempt, generatedAt }) {
  invariant(summary && typeof summary === "object" && !Array.isArray(summary), "Observation summary is missing");
  invariant(summary.schemaVersion === 1, "Unsupported observation-summary schema");
  invariant(Array.isArray(summary.missingObservationIds) && summary.missingObservationIds.length === 0, `Observation cohort is incomplete: ${JSON.stringify(summary.missingObservationIds ?? null)}`);
  invariant(Array.isArray(summary.rejected) && summary.rejected.length === 0, `Observation cohort contains rejected receipts: ${JSON.stringify((summary.rejected ?? []).map((entry) => entry?.id))}`);
  const expected = sortedIdSet([...(summary.expectedObservationIds ?? [])].sort(), "Summary expected identities");
  const verified = sortedIdSet([...(summary.verifiedObservationIds ?? [])].sort(), "Summary verified identities");
  invariant(JSON.stringify(expected) === JSON.stringify(verified), "Observation cohort verified set differs from the declared observation-only lanes");
  const cohort = {
    schemaVersion: 1,
    status: OBSERVATION_COHORT_STATUS,
    releaseEnvelopeSha256: summary.releaseEnvelopeSha256,
    supportPolicySha256: summary.supportPolicySha256,
    candidateRunId: String(candidateRunId),
    workflow: OBSERVATION_COHORT_WORKFLOW,
    runId: String(runId),
    runAttempt,
    observationIds: verified,
    generatedAt,
  };
  return validateObservationCohort(cohort);
}
