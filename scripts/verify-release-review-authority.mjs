import { readFile } from "node:fs/promises";
import path from "node:path";

import { invariant, parseArgs } from "./lib/release-evidence.mjs";

// This runs inside the protected release-review job, so the environment's
// gating has already happened by the time it executes. What it establishes is
// that the gate the run passed through is the gate this repository declares --
// the right reviewer, self-review refused, no admin able to walk past it, and
// no branch other than main able to enter it.
//
// It reads the remote state rather than trusting the declaration, and the
// declaration exists so that a silent change to the remote environment fails
// the release instead of quietly relaxing it.

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const repository = "Cuna-Labs/cuna-cli";
const releaseReviewEnvironment = "release-review-npm-preview";
const declaration = JSON.parse(await readFile(path.join(root, "packaging", "release-review-authority.json"), "utf8"));
const token = process.env.GITHUB_TOKEN;
invariant(typeof token === "string" && token.length >= 20 && !/\s/u.test(token), "A read-only GitHub token is required");
// One conjunct per line, each with its own reason. Written as a single boolean
// this refused every alteration with the same sentence -- a reviewer reading
// "declaration differs" could not tell a renamed reviewer from a relaxed
// requirement, and the two are not the same incident.
for (const [ok, reason] of [
  [declaration.schemaVersion === 2, "Release-review authority declaration is not schemaVersion 2"],
  [declaration.status === "CONFIGURED", `Release-review authority declares status ${JSON.stringify(declaration.status)} rather than CONFIGURED`],
  [declaration.repository === repository, "Release-review authority declares a different repository"],
  [declaration.environment === releaseReviewEnvironment, "Release-review authority declares a different environment"],
  [declaration.protectedRef === "main", `Release-review authority declares protected ref ${JSON.stringify(declaration.protectedRef)} rather than main`],
  [declaration.requiredReviewer?.type === "User", "Release-review required reviewer is not a User"],
  [declaration.requiredReviewer?.id === 312749809, `Release-review authority declares reviewer id ${JSON.stringify(declaration.requiredReviewer?.id)} rather than 312749809`],
  [declaration.requiredReviewer?.login === "cunitacodeitor", `Release-review authority declares reviewer login ${JSON.stringify(declaration.requiredReviewer?.login)} rather than cunitacodeitor`],
  [declaration.requirePreventSelfReview === true, "Release-review authority no longer requires prevent_self_review"],
  [declaration.requireAdminBypassDisabled === true, "Release-review authority no longer requires the admin bypass to be disabled"],
  [
    declaration.requiredApprovalEvidence === "EXACT_APPROVER_ID_LOGIN_EVENT_AND_RUN_BINDING",
    "Release-review authority no longer requires an exact approver identity bound to the run",
  ],
]) invariant(ok, reason);

async function getJson(url, label) {
  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "cuna-cli-release-review-authority-verifier",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });
  invariant(response.status === 200, `${label} failed with HTTP ${response.status}`);
  const length = response.headers.get("content-length");
  invariant(length === null || (/^\d+$/u.test(length) && Number(length) <= 1_048_576), `${label} response is too large`);
  const text = await response.text();
  invariant(Buffer.byteLength(text) <= 1_048_576, `${label} response is too large`);
  return JSON.parse(text);
}

// The authority file is validated above, but it is still repository content.
// Network destinations remain fixed in code so a modified declaration cannot
// redirect this read-only token to an arbitrary endpoint.
const environment = await getJson(`https://api.github.com/repos/${repository}/environments/${releaseReviewEnvironment}`, "release-review environment lookup");
const policies = await getJson(`https://api.github.com/repos/${repository}/environments/${releaseReviewEnvironment}/deployment-branch-policies`, "release-review branch-policy lookup");
const reviewerRule = environment.protection_rules?.find((rule) => rule?.type === "required_reviewers");
invariant(environment.name === declaration.environment, "Release-review environment identity differs");
invariant(
  environment.can_admins_bypass === false,
  "RELEASE_REVIEW_ENVIRONMENT_ADMIN_BYPASS_ENABLED: a repository administrator can approve this environment's own gate",
);
invariant(reviewerRule?.prevent_self_review === true, "Release-review environment does not prevent self-review");
invariant(
  reviewerRule.reviewers?.length === 1 && reviewerRule.reviewers[0]?.type === declaration.requiredReviewer.type &&
    reviewerRule.reviewers[0]?.reviewer?.id === declaration.requiredReviewer.id &&
    reviewerRule.reviewers[0]?.reviewer?.login === declaration.requiredReviewer.login,
  "Release-review required reviewer differs",
);
invariant(
  environment.deployment_branch_policy?.protected_branches === false &&
    environment.deployment_branch_policy?.custom_branch_policies === true &&
    policies.total_count === 1 && policies.branch_policies?.length === 1 &&
    policies.branch_policies[0]?.type === "branch" && policies.branch_policies[0]?.name === declaration.protectedRef,
  "Release-review environment is not restricted exactly to main",
);
process.stdout.write(`${JSON.stringify({
  status: "RELEASE_REVIEW_AUTHORITY_VERIFIED",
  environment: declaration.environment,
  reviewerId: declaration.requiredReviewer.id,
  reviewerLogin: declaration.requiredReviewer.login,
  adminBypass: environment.can_admins_bypass,
  preventSelfReview: reviewerRule.prevent_self_review,
})}\n`);
