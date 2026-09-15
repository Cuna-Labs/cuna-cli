import { invariant, strictDecimalId, strictLogin } from "./release-evidence.mjs";

// A protected environment stops a job from starting until a required reviewer
// approves, but nothing inside the job can see WHO approved unless it reads the
// run's approval events back. Without that read the workflow can only assert
// "some approval happened", which is not an identity and cannot be written into
// a lease. This module turns the raw approval list into an exact, single,
// identified decision, or refuses.
//
// It is deliberately separate from any network call so the refusal branches can
// be exercised by the test suite against fabricated inputs.

const LOGIN = /^[A-Za-z0-9-]{1,39}$/u;

/**
 * Reduce the GitHub approval-event list for one run to the exact decision that
 * authorized it, or throw.
 *
 * `runActorId` is the identity that dispatched the run. The environment's own
 * `prevent_self_review` should already refuse a self-approval, but that setting
 * lives in remote configuration that this workflow does not own; re-checking it
 * here means a configuration drift cannot silently produce a self-approved
 * release.
 */
export function validateReleaseApprovalEvent({ approvals, environment, requiredReviewer, runActorId }) {
  invariant(typeof environment === "string" && environment.length > 0, "Approval environment is required");
  invariant(
    requiredReviewer && typeof requiredReviewer === "object" && !Array.isArray(requiredReviewer) &&
      Number.isSafeInteger(requiredReviewer.id) && requiredReviewer.id > 0 &&
      typeof requiredReviewer.login === "string" && LOGIN.test(requiredReviewer.login),
    "Required reviewer identity is invalid",
  );
  invariant(/^[1-9][0-9]*$/u.test(String(runActorId ?? "")), "Dispatching actor identity is required");
  invariant(Array.isArray(approvals), "Approval events are not a list");
  invariant(approvals.length > 0, "No approval event was recorded for this run");
  invariant(approvals.length <= 64, "Approval event list is implausibly long");

  const decisions = [];
  for (const entry of approvals) {
    invariant(entry && typeof entry === "object" && !Array.isArray(entry), "Approval event is malformed");
    invariant(typeof entry.state === "string", "Approval event state is missing");
    const environments = entry.environments;
    invariant(Array.isArray(environments), "Approval event environments are missing");
    const names = environments.map((value) => {
      invariant(value && typeof value === "object" && typeof value.name === "string", "Approval environment entry is malformed");
      return value.name;
    });
    if (!names.includes(environment)) continue;
    // A rejection anywhere in this environment's history is fatal even if a
    // later approval exists: the run would otherwise be authorized by a
    // decision that was explicitly reversed.
    invariant(entry.state !== "rejected", `Release review was rejected for ${environment}`);
    if (entry.state !== "approved") continue;
    const user = entry.user;
    invariant(
      user && typeof user === "object" && !Array.isArray(user) &&
        Number.isSafeInteger(user.id) && user.id > 0 && typeof user.login === "string" && LOGIN.test(user.login),
      "Approver identity is missing from the approval event",
    );
    decisions.push({ id: user.id, login: user.login, comment: typeof entry.comment === "string" ? entry.comment : "" });
  }

  invariant(decisions.length > 0, `No approval event names the ${environment} environment`);
  invariant(decisions.length === 1, `Exactly one approval decision is required, observed ${decisions.length}`);
  const [decision] = decisions;
  invariant(
    decision.id === requiredReviewer.id && decision.login === requiredReviewer.login,
    `Approver ${decision.login}#${decision.id} is not the required reviewer ${requiredReviewer.login}#${requiredReviewer.id}`,
  );
  invariant(
    String(decision.id) !== String(runActorId),
    `Approver ${decision.login}#${decision.id} also dispatched this run; self-review cannot authorize a release`,
  );
  return decision;
}

/** The evidence record written for the lease and for the run log. */
export function buildReleaseApprovalEventReceipt({ decision, environment, repository, runId, runAttempt, runActorId, runActorLogin, observedAt }) {
  invariant(/^[1-9][0-9]*$/u.test(String(runId ?? "")), "Approval run identity is invalid");
  invariant(Number.isSafeInteger(runAttempt) && runAttempt > 0, "Approval run attempt is invalid");
  invariant(typeof repository === "string" && repository.includes("/"), "Approval repository identity is invalid");
  invariant(typeof observedAt === "string" && observedAt.length > 0, "Approval observation time is required");
  // The approver identity arrives over the network and is about to be written
  // to disk as evidence. It was validated above; rebuilding it from a local
  // alphabet makes the bytes that land in the receipt constants this code
  // chose, of a length it bounds, rather than whatever the response contained.
  return {
    schemaVersion: 1,
    status: "PROTECTED_ENVIRONMENT_APPROVAL_OBSERVED",
    repository,
    environment,
    runId: strictDecimalId(runId, "Approval run identity"),
    runAttempt,
    approverId: strictDecimalId(decision.id, "Approver identity"),
    approverLogin: strictLogin(decision.login, "Approver login"),
    dispatchActorId: strictDecimalId(runActorId, "Dispatching actor identity"),
    dispatchActorLogin: strictLogin(runActorLogin, "Dispatching actor login"),
    approverIsDispatcher: false,
    observedAt,
  };
}
