import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReleaseApprovalEventReceipt,
  validateReleaseApprovalEvent,
} from "../scripts/lib/release-approval-event.mjs";
import {
  OBSERVATION_COHORT_STATUS,
  OBSERVATION_COHORT_WORKFLOW,
  buildObservationCohort,
  validateObservationCohort,
  validateObservationCohortAgainstCandidate,
} from "../scripts/lib/observation-cohort.mjs";

const ENVIRONMENT = "release-review-npm-preview";
const REVIEWER = Object.freeze({ id: 312749809, login: "cunitacodeitor" });
const DISPATCHER = "67605416";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function approval({ state = "approved", id = REVIEWER.id, login = REVIEWER.login, environment = ENVIRONMENT } = {}) {
  return { environments: [{ name: environment }], state, user: { id, login }, comment: "" };
}

function refuses(fn, fragment) {
  assert.throws(fn, (error) => {
    assert.ok(
      error instanceof Error && error.message.includes(fragment),
      `expected a refusal mentioning ${JSON.stringify(fragment)}, got ${JSON.stringify(error?.message)}`,
    );
    return true;
  });
}

test("a protected-environment approval by the required reviewer is accepted", () => {
  const decision = validateReleaseApprovalEvent({
    approvals: [approval()],
    environment: ENVIRONMENT,
    requiredReviewer: REVIEWER,
    runActorId: DISPATCHER,
  });
  assert.deepEqual({ id: decision.id, login: decision.login }, { id: REVIEWER.id, login: REVIEWER.login });
});

// prevent_self_review lives in remote environment configuration that this
// repository does not own. If it were ever turned off, the gate would still
// exist but would stop meaning anything, and nothing in the tree would notice.
test("the dispatching actor cannot approve its own release review", () => {
  refuses(
    () => validateReleaseApprovalEvent({
      approvals: [approval()],
      environment: ENVIRONMENT,
      requiredReviewer: REVIEWER,
      runActorId: String(REVIEWER.id),
    }),
    "self-review cannot authorize a release",
  );
});

test("an approval by anyone other than the required reviewer is refused", () => {
  refuses(
    () => validateReleaseApprovalEvent({
      approvals: [approval({ id: 67605416, login: "superjava1" })],
      environment: ENVIRONMENT,
      requiredReviewer: REVIEWER,
      runActorId: DISPATCHER,
    }),
    "is not the required reviewer",
  );
});

// A later approval must not paper over an explicit rejection of the same
// environment: the release would otherwise be authorized by a reversed decision.
test("a rejection for this environment is fatal even when an approval follows", () => {
  refuses(
    () => validateReleaseApprovalEvent({
      approvals: [approval({ state: "rejected" }), approval()],
      environment: ENVIRONMENT,
      requiredReviewer: REVIEWER,
      runActorId: DISPATCHER,
    }),
    "Release review was rejected",
  );
});

test("an approval naming a different environment does not authorize this one", () => {
  refuses(
    () => validateReleaseApprovalEvent({
      approvals: [approval({ environment: "npm" })],
      environment: ENVIRONMENT,
      requiredReviewer: REVIEWER,
      runActorId: DISPATCHER,
    }),
    `No approval event names the ${ENVIRONMENT} environment`,
  );
});

test("an empty approval list is refused rather than read as consent", () => {
  refuses(
    () => validateReleaseApprovalEvent({
      approvals: [],
      environment: ENVIRONMENT,
      requiredReviewer: REVIEWER,
      runActorId: DISPATCHER,
    }),
    "No approval event was recorded",
  );
});

test("an approval event without an approver identity is refused", () => {
  refuses(
    () => validateReleaseApprovalEvent({
      approvals: [{ environments: [{ name: ENVIRONMENT }], state: "approved" }],
      environment: ENVIRONMENT,
      requiredReviewer: REVIEWER,
      runActorId: DISPATCHER,
    }),
    "Approver identity is missing",
  );
});

test("the approval receipt records both identities and never claims self-approval", () => {
  const receipt = buildReleaseApprovalEventReceipt({
    decision: { id: REVIEWER.id, login: REVIEWER.login, comment: "" },
    environment: ENVIRONMENT,
    repository: "Cuna-Labs/cuna-cli",
    runId: "42",
    runAttempt: 1,
    runActorId: DISPATCHER,
    runActorLogin: "superjava1",
    observedAt: "2026-09-15T06:00:00.000Z",
  });
  assert.equal(receipt.status, "PROTECTED_ENVIRONMENT_APPROVAL_OBSERVED");
  assert.equal(receipt.approverId, String(REVIEWER.id));
  assert.equal(receipt.dispatchActorId, DISPATCHER);
  assert.equal(receipt.approverIsDispatcher, false);
});

const COMPLETE_SUMMARY = Object.freeze({
  schemaVersion: 1,
  releaseEnvelopeSha256: DIGEST_A,
  supportPolicySha256: DIGEST_B,
  expectedObservationIds: ["macos-14-node22-arm64-observation", "windows-11-node22-arm64-observation"],
  receivedObservationIds: ["macos-14-node22-arm64-observation", "windows-11-node22-arm64-observation"],
  verifiedObservationIds: ["macos-14-node22-arm64-observation", "windows-11-node22-arm64-observation"],
  missingObservationIds: [],
  rejected: [],
  admissionImpact: "NONE",
  releaseEligible: false,
  generatedAt: "2026-09-15T06:00:00.000Z",
});

function cohortFrom(summary) {
  return buildObservationCohort({
    summary,
    candidateRunId: "34936979093",
    runId: "34937000000",
    runAttempt: 1,
    generatedAt: "2026-09-15T06:05:00.000Z",
  });
}

test("a complete summary is promoted to a candidate-bound cohort", () => {
  const cohort = cohortFrom(COMPLETE_SUMMARY);
  assert.equal(cohort.status, OBSERVATION_COHORT_STATUS);
  assert.equal(cohort.workflow, OBSERVATION_COHORT_WORKFLOW);
  assert.equal(cohort.candidateRunId, "34936979093");
  assert.deepEqual(cohort.observationIds, COMPLETE_SUMMARY.expectedObservationIds);
  validateObservationCohort(cohort);
});

// This is the whole reason the cohort exists. CI's observation lane tolerates a
// platform that never ran, so its summary can show nothing rejected and nothing
// verified at the same time. Promotion must refuse exactly that shape.
test("a summary missing an observation cannot become a cohort", () => {
  refuses(
    () => cohortFrom({
      ...COMPLETE_SUMMARY,
      verifiedObservationIds: ["macos-14-node22-arm64-observation"],
      receivedObservationIds: ["macos-14-node22-arm64-observation"],
      missingObservationIds: ["windows-11-node22-arm64-observation"],
    }),
    "Observation cohort is incomplete",
  );
});

test("a summary carrying a rejected receipt cannot become a cohort", () => {
  refuses(
    () => cohortFrom({
      ...COMPLETE_SUMMARY,
      rejected: [{ id: "macos-14-node22-arm64-observation", reasonCode: "RECEIPT_VALIDATION_FAILED", message: "digest mismatch" }],
    }),
    "contains rejected receipts",
  );
});

test("a summary that verified fewer lanes than it expected cannot become a cohort", () => {
  refuses(
    () => cohortFrom({ ...COMPLETE_SUMMARY, verifiedObservationIds: ["macos-14-node22-arm64-observation"] }),
    "verified set differs from the declared observation-only lanes",
  );
});

test("a cohort built for one candidate does not bind another", () => {
  const cohort = cohortFrom(COMPLETE_SUMMARY);
  const bind = (overrides) => validateObservationCohortAgainstCandidate(cohort, {
    releaseEnvelopeSha256: DIGEST_A,
    supportPolicySha256: DIGEST_B,
    candidateRunId: "34936979093",
    expectedObservationIds: COMPLETE_SUMMARY.expectedObservationIds,
    ...overrides,
  });
  assert.equal(bind({}).status, OBSERVATION_COHORT_STATUS);
  refuses(() => bind({ releaseEnvelopeSha256: "c".repeat(64) }), "different release envelope");
  refuses(() => bind({ supportPolicySha256: "d".repeat(64) }), "different support policy");
  refuses(() => bind({ candidateRunId: "34936979094" }), "different candidate run");
  refuses(
    () => bind({ expectedObservationIds: [...COMPLETE_SUMMARY.expectedObservationIds, "linux-ubuntu-24-node22-arm64-observation"] }),
    "does not cover exactly the declared observation-only lanes",
  );
});

test("a cohort that renames its producing workflow is not a cohort", () => {
  refuses(
    () => validateObservationCohort({ ...cohortFrom(COMPLETE_SUMMARY), workflow: ".github/workflows/ci.yml" }),
    "producer workflow differs",
  );
});

test("a cohort cannot downgrade its own status", () => {
  refuses(
    () => validateObservationCohort({ ...cohortFrom(COMPLETE_SUMMARY), status: "PARTIAL" }),
    "not a complete candidate-bound cohort",
  );
});
