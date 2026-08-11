import { readFile } from "node:fs/promises";
import path from "node:path";

import { invariant, parseArgs } from "./lib/release-evidence.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const declaration = JSON.parse(await readFile(path.join(root, "packaging", "release-review-authority.json"), "utf8"));
const token = process.env.GITHUB_TOKEN;
invariant(typeof token === "string" && token.length >= 20 && !/\s/u.test(token), "A read-only GitHub token is required");
invariant(
  declaration.schemaVersion === 1 && declaration.status === "UNCONFIGURED_BLOCKING" &&
    declaration.repository === "Cuna-Labs/cuna-cli" && declaration.environment === "release-review-npm-preview" &&
    declaration.protectedRef === "main" && declaration.requiredReviewer?.type === "User" &&
    declaration.requiredReviewer?.id === 312749809 && declaration.requiredReviewer?.login === "cunitacodeitor" &&
    declaration.requirePreventSelfReview === true && declaration.requireAdminBypassDisabled === true &&
    declaration.observedAdminBypass === true &&
    declaration.requiredApprovalEvidence === "EXACT_APPROVER_ID_LOGIN_EVENT_AND_RUN_BINDING",
  "Release-review authority declaration differs",
);

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

const repository = encodeURI(declaration.repository);
const environment = await getJson(`https://api.github.com/repos/${repository}/environments/${declaration.environment}`, "release-review environment lookup");
const policies = await getJson(`https://api.github.com/repos/${repository}/environments/${declaration.environment}/deployment-branch-policies`, "release-review branch-policy lookup");
const reviewerRule = environment.protection_rules?.find((rule) => rule?.type === "required_reviewers");
invariant(environment.name === declaration.environment, "Release-review environment identity differs");
invariant(environment.can_admins_bypass === true, "Observed release-review admin-bypass state changed; declaration and review decision require re-audit");
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
invariant(
  JSON.stringify(declaration.blockers) === JSON.stringify([
    "RELEASE_REVIEW_ENVIRONMENT_ADMIN_BYPASS_ENABLED",
    "ACTUAL_ENVIRONMENT_APPROVAL_EVENT_NOT_OBSERVABLE_BY_WORKFLOW_TOKEN",
    "CANONICAL_CONTRACT_AUTHORITY_ARTIFACT_NOT_AVAILABLE",
    "CANDIDATE_BOUND_OBSERVATION_COHORT_NOT_AVAILABLE",
    "CANDIDATE_RELEASE_CONTRACT_AUTHORITY_UNRESOLVED",
  ]),
  "Release-review blocker set differs",
);
process.stdout.write(`${JSON.stringify({ status: "UNCONFIGURED_BLOCKING", environment: declaration.environment, reviewerId: declaration.requiredReviewer.id, observedAdminBypass: environment.can_admins_bypass, blockers: declaration.blockers })}\n`);
