import { createHash } from "node:crypto";

import { invariant } from "./release-evidence.mjs";
import { validateReleaseApprovalLease } from "./release-approval-lease.mjs";

const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/u;
const TAG_OBJECT = /^[0-9a-f]{40}$/u;
const REQUIRED_RULES = Object.freeze(["deletion", "non_fast_forward", "update"]);
const TAG_REF_PREFIX = "refs/tags/cuna-release-approval-consumption/";
const TAG_NAME_PREFIX = "cuna-release-approval-consumption/";
const MAXIMUM_RESPONSE_BYTES = 1_048_576;

function exactKeys(value, expected, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  invariant(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
    `${label} keys differ`,
  );
}

function digest(value, label) {
  invariant(typeof value === "string" && SHA256.test(value), `${label} must be a lowercase SHA-256 digest`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(canonical(value))}\n`, "utf8");
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateReleaseContext(context) {
  exactKeys(context, ["repository", "workflow", "ref", "event", "sourceCommit", "runId", "runAttempt", "actorId", "actorLogin", "environment"], "release workflow context");
  invariant(context.repository === "Cuna-Labs/cuna-cli", "Release workflow repository differs");
  invariant(context.workflow === ".github/workflows/release.yml", "Release workflow identity differs");
  invariant(context.ref === "refs/heads/main" && context.event === "workflow_dispatch", "Release workflow is not a protected-main dispatch");
  invariant(COMMIT.test(context.sourceCommit), "Release workflow source commit is invalid");
  invariant(POSITIVE_INTEGER.test(context.runId) && Number.isSafeInteger(context.runAttempt) && context.runAttempt > 0, "Release workflow run identity is invalid");
  invariant(POSITIVE_INTEGER.test(context.actorId) && LOGIN.test(context.actorLogin), "Release workflow controller is invalid");
  invariant(context.environment === "npm", "Release workflow environment differs");
  return context;
}

export function buildReleaseApprovalConsumption({ lease, expectation, leaseBytes, expectationBytes, context, now = Date.now() }) {
  invariant(Buffer.isBuffer(leaseBytes) && Buffer.isBuffer(expectationBytes), "Approval evidence must be exact byte buffers");
  validateReleaseApprovalLease(lease, expectation, now);
  validateReleaseContext(context);
  invariant(lease.source.commit === context.sourceCommit, "Release consumption source differs from the lease");
  invariant(lease.promotion.environment === context.environment, "Release consumption environment differs from the lease");
  invariant(lease.controller.actorId === context.actorId && lease.controller.actorLogin === context.actorLogin, "Release consumption controller differs from the lease");
  const nonceSha256 = sha256(Buffer.from(lease.nonce, "utf8"));
  const reservation = {
    schemaVersion: 1,
    kind: "CUNA_RELEASE_APPROVAL_CONSUMPTION",
    nonceSha256,
    leaseSha256: sha256(leaseBytes),
    expectationSha256: sha256(expectationBytes),
    sourceCommit: lease.source.commit,
    package: { ...lease.package },
    candidate: { ...lease.candidate },
    promotion: { ...lease.promotion },
    controller: { ...lease.controller },
    approvalReview: {
      runId: lease.review.runId,
      runAttempt: lease.review.runAttempt,
      environment: lease.review.environment,
      approverIdentityClass: lease.review.approverIdentityClass,
    },
    releaseRun: {
      id: context.runId,
      attempt: context.runAttempt,
      workflow: context.workflow,
    },
    reservedAt: new Date(now).toISOString(),
    expiresAt: lease.expiresAt,
  };
  return {
    reservation,
    reservationBytes: canonicalJsonBytes(reservation),
    tagName: `${TAG_NAME_PREFIX}${nonceSha256}`,
    ref: `${TAG_REF_PREFIX}${nonceSha256}`,
  };
}

function requiredReviewerRule(environment) {
  return environment.protection_rules?.find((rule) => rule?.type === "required_reviewers");
}

export function validateConsumptionAuthority({ declaration, environment, branchPolicies, ruleset, context }) {
  exactKeys(declaration, ["schemaVersion", "status", "repository", "environment", "protectedRef", "requiredReviewer", "rulesetName", "rulesetId", "tagRefPrefix", "requiredRules", "requireNoBypassActors", "requireAdminBypassDisabled", "requirePreventSelfReview"], "release consumption authority declaration");
  invariant(declaration.schemaVersion === 1, "Unsupported release consumption authority declaration");
  invariant(declaration.status === "CONFIGURED", "Release approval consumption authority remains unconfigured");
  invariant(declaration.repository === context.repository && declaration.environment === context.environment, "Release consumption declaration scope differs");
  invariant(declaration.protectedRef === "main" && declaration.rulesetName === "Protect Cuna release approval consumptions", "Release consumption declaration identity differs");
  invariant(Number.isSafeInteger(declaration.rulesetId) && declaration.rulesetId > 0, "Release consumption ruleset ID is invalid");
  exactKeys(declaration.requiredReviewer, ["type", "id", "login"], "required release reviewer");
  invariant(
    declaration.requiredReviewer.type === "User" &&
      Number.isSafeInteger(declaration.requiredReviewer.id) && declaration.requiredReviewer.id > 0 &&
      LOGIN.test(declaration.requiredReviewer.login),
    "Required release reviewer identity is invalid",
  );
  invariant(declaration.tagRefPrefix === TAG_REF_PREFIX, "Release consumption tag namespace differs");
  invariant(JSON.stringify(declaration.requiredRules) === JSON.stringify(REQUIRED_RULES), "Release consumption rule contract differs");
  invariant(declaration.requireNoBypassActors === true && declaration.requireAdminBypassDisabled === true && declaration.requirePreventSelfReview === true, "Release consumption authority weakens mandatory controls");

  invariant(environment.name === declaration.environment && environment.can_admins_bypass === false, "Release environment permits administrator bypass");
  const reviewerRule = requiredReviewerRule(environment);
  invariant(reviewerRule?.prevent_self_review === true, "Release environment does not prevent self-review");
  const reviewers = reviewerRule?.reviewers ?? [];
  invariant(reviewers.length === 1, "Release environment reviewer set differs");
  const reviewer = reviewers[0];
  invariant(
    reviewer?.type === declaration.requiredReviewer.type &&
      reviewer?.reviewer?.id === declaration.requiredReviewer.id &&
      reviewer?.reviewer?.login === declaration.requiredReviewer.login &&
      String(reviewer.reviewer.id) !== context.actorId,
    "Release environment required reviewer differs or is not independent",
  );
  invariant(
    environment.deployment_branch_policy?.protected_branches === false &&
      environment.deployment_branch_policy?.custom_branch_policies === true,
    "Release environment branch-policy mode differs",
  );
  invariant(
    Array.isArray(branchPolicies) && branchPolicies.length === 1 &&
      branchPolicies[0]?.type === "branch" && branchPolicies[0]?.name === declaration.protectedRef,
    "Release environment is not restricted exactly to protected main",
  );

  invariant(ruleset.id === declaration.rulesetId && ruleset.name === declaration.rulesetName && ruleset.target === "tag" && ruleset.enforcement === "active", "Release consumption ruleset is not active or has a different identity");
  invariant(ruleset.source_type === "Repository" && ruleset.source === context.repository, "Release consumption ruleset authority differs");
  invariant(Array.isArray(ruleset.bypass_actors) && ruleset.bypass_actors.length === 0 && ruleset.current_user_can_bypass === "never", "Release consumption ruleset permits bypass");
  invariant(JSON.stringify(ruleset.conditions?.ref_name?.exclude ?? []) === "[]", "Release consumption ruleset excludes protected tags");
  invariant(JSON.stringify(ruleset.conditions?.ref_name?.include ?? []) === JSON.stringify([`${TAG_REF_PREFIX}*`]), "Release consumption ruleset scope differs");
  const ruleTypes = (ruleset.rules ?? []).map((rule) => rule?.type).filter(Boolean).sort();
  invariant(JSON.stringify(ruleTypes) === JSON.stringify([...REQUIRED_RULES].sort()), "Release consumption ruleset does not exactly prevent deletion and rewrite");
  return { reviewerIds: [String(reviewer.reviewer.id)] };
}

async function responseJson(response, label) {
  const length = response.headers?.get?.("content-length");
  if (length !== null && length !== undefined) {
    invariant(/^\d+$/u.test(length) && Number(length) <= MAXIMUM_RESPONSE_BYTES, `${label} response is too large`);
  }
  const text = await response.text();
  invariant(Buffer.byteLength(text) <= MAXIMUM_RESPONSE_BYTES, `${label} response is too large`);
  return text.length === 0 ? {} : JSON.parse(text);
}

async function request(fetchImpl, url, token, options, expected, label) {
  const response = await fetchImpl(url, {
    ...options,
    redirect: "error",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "cuna-cli-release-approval-consumer",
      "x-github-api-version": "2022-11-28",
      ...(options.headers ?? {}),
    },
  });
  if (expected === "created-or-replay" && response.status === 422) {
    throw new Error("Release approval nonce is already consumed");
  }
  const expectedStatus = expected === "created-or-replay" ? 201 : expected;
  invariant(response.status === expectedStatus, `${label} failed with HTTP ${response.status}`);
  return responseJson(response, label);
}

export async function verifyReleaseApprovalConsumptionAuthority({ declaration, context, token, fetchImpl = fetch, apiRoot = "https://api.github.com" }) {
  invariant(typeof token === "string" && token.length >= 20 && !/\s/u.test(token), "A non-empty GitHub authority token is required");
  invariant(declaration?.status === "CONFIGURED", "Release approval consumption authority remains unconfigured");
  validateReleaseContext(context);
  const repositoryPath = encodeURI(context.repository);
  const environment = await request(fetchImpl, `${apiRoot}/repos/${repositoryPath}/environments/${context.environment}`, token, { method: "GET" }, 200, "release environment lookup");
  const policyPage = await request(fetchImpl, `${apiRoot}/repos/${repositoryPath}/environments/${context.environment}/deployment-branch-policies`, token, { method: "GET" }, 200, "release branch-policy lookup");
  const rulesetSummaries = await request(fetchImpl, `${apiRoot}/repos/${repositoryPath}/rulesets`, token, { method: "GET" }, 200, "release ruleset lookup");
  invariant(Array.isArray(rulesetSummaries), "Release ruleset response is invalid");
  const summary = rulesetSummaries.find((value) => value?.id === declaration.rulesetId && value?.name === declaration.rulesetName && value?.target === "tag" && value?.enforcement === "active");
  invariant(summary?.id === declaration.rulesetId, "Release consumption ruleset is absent or substituted");
  const ruleset = await request(fetchImpl, `${apiRoot}/repos/${repositoryPath}/rulesets/${declaration.rulesetId}`, token, { method: "GET" }, 200, "release ruleset detail lookup");
  return validateConsumptionAuthority({ declaration, environment, branchPolicies: policyPage.branch_policies, ruleset, context });
}

export async function reserveReleaseApprovalConsumption({ declaration, consumption, token, fetchImpl = fetch, apiRoot = "https://api.github.com" }) {
  const context = validateReleaseContext(consumption.context);
  const repositoryPath = encodeURI(context.repository);
  const observeAuthority = () => verifyReleaseApprovalConsumptionAuthority({ declaration, context, token, fetchImpl, apiRoot });
  await observeAuthority();

  const taggerDate = consumption.reservation.reservedAt;
  const tagObject = await request(fetchImpl, `${apiRoot}/repos/${repositoryPath}/git/tags`, token, {
    method: "POST",
    body: JSON.stringify({
      tag: consumption.tagName,
      message: consumption.reservationBytes.toString("utf8"),
      object: context.sourceCommit,
      type: "commit",
      tagger: { name: "Cuna Release Authority", email: "release-authority@getcuna.com", date: taggerDate },
    }),
  }, 201, "release consumption tag creation");
  invariant(TAG_OBJECT.test(tagObject.sha ?? ""), "Release consumption tag object identity is invalid");
  // Re-read the external controls immediately before the only globally visible
  // state transition. The first read proves intent; this read closes the window
  // in which a reviewer, environment policy, or ruleset could be weakened.
  await observeAuthority();
  const created = await request(fetchImpl, `${apiRoot}/repos/${repositoryPath}/git/refs`, token, {
    method: "POST",
    body: JSON.stringify({ ref: consumption.ref, sha: tagObject.sha }),
  }, "created-or-replay", "release consumption reservation");
  invariant(created.ref === consumption.ref && created.object?.sha === tagObject.sha, "Release consumption reservation readback differs");
  const encodedRef = consumption.ref.replace(/^refs\//u, "").split("/").map(encodeURIComponent).join("/");
  const observed = await request(fetchImpl, `${apiRoot}/repos/${repositoryPath}/git/ref/${encodedRef}`, token, { method: "GET" }, 200, "release consumption readback");
  invariant(observed.ref === consumption.ref && observed.object?.sha === tagObject.sha, "Release consumption durable state differs");
  const observedTag = await request(fetchImpl, `${apiRoot}/repos/${repositoryPath}/git/tags/${tagObject.sha}`, token, { method: "GET" }, 200, "release consumption tag readback");
  invariant(
    observedTag.sha === tagObject.sha && observedTag.tag === consumption.tagName &&
      observedTag.object?.type === "commit" && observedTag.object?.sha === context.sourceCommit &&
      observedTag.message === consumption.reservationBytes.toString("utf8") &&
      observedTag.tagger?.name === "Cuna Release Authority" &&
      observedTag.tagger?.email === "release-authority@getcuna.com" &&
      observedTag.tagger?.date === taggerDate,
    "Release consumption annotated-tag evidence differs",
  );
  await observeAuthority();
  return {
    schemaVersion: 1,
    status: "CONSUMED",
    ref: consumption.ref,
    tagObjectSha: tagObject.sha,
    nonceSha256: consumption.reservation.nonceSha256,
    leaseSha256: consumption.reservation.leaseSha256,
    expectationSha256: consumption.reservation.expectationSha256,
    releaseRun: consumption.reservation.releaseRun,
  };
}

export async function verifyReservedReleaseApprovalConsumption({
  declaration,
  lease,
  expectation,
  leaseBytes,
  expectationBytes,
  context,
  token,
  now = Date.now(),
  fetchImpl = fetch,
  apiRoot = "https://api.github.com",
}) {
  const current = buildReleaseApprovalConsumption({ lease, expectation, leaseBytes, expectationBytes, context, now });
  await verifyReleaseApprovalConsumptionAuthority({ declaration, context, token, fetchImpl, apiRoot });
  const repositoryPath = encodeURI(context.repository);
  const encodedRef = current.ref.replace(/^refs\//u, "").split("/").map(encodeURIComponent).join("/");
  const observedRef = await request(fetchImpl, `${apiRoot}/repos/${repositoryPath}/git/ref/${encodedRef}`, token, { method: "GET" }, 200, "release consumption readback");
  invariant(observedRef.ref === current.ref && TAG_OBJECT.test(observedRef.object?.sha ?? ""), "Release consumption ref identity differs");
  const observedTag = await request(fetchImpl, `${apiRoot}/repos/${repositoryPath}/git/tags/${observedRef.object.sha}`, token, { method: "GET" }, 200, "release consumption tag readback");
  let observedReservation;
  try {
    observedReservation = JSON.parse(observedTag.message);
  } catch {
    throw new Error("Release consumption annotated-tag evidence is not JSON");
  }
  const reservedAt = Date.parse(observedReservation?.reservedAt);
  invariant(Number.isSafeInteger(reservedAt) && new Date(reservedAt).toISOString() === observedReservation.reservedAt, "Release consumption reservation time is invalid");
  const exact = buildReleaseApprovalConsumption({ lease, expectation, leaseBytes, expectationBytes, context, now: reservedAt });
  invariant(
    exact.ref === current.ref && exact.tagName === current.tagName &&
      observedTag.sha === observedRef.object.sha && observedTag.tag === exact.tagName &&
      observedTag.object?.type === "commit" && observedTag.object?.sha === context.sourceCommit &&
      observedTag.message === exact.reservationBytes.toString("utf8") &&
      observedTag.tagger?.name === "Cuna Release Authority" &&
      observedTag.tagger?.email === "release-authority@getcuna.com" &&
      observedTag.tagger?.date === exact.reservation.reservedAt,
    "Release consumption annotated-tag evidence differs",
  );
  await verifyReleaseApprovalConsumptionAuthority({ declaration, context, token, fetchImpl, apiRoot });
  return {
    schemaVersion: 1,
    status: "CONSUMPTION_STILL_VALID",
    ref: exact.ref,
    tagObjectSha: observedTag.sha,
    nonceSha256: exact.reservation.nonceSha256,
    leaseSha256: exact.reservation.leaseSha256,
    expectationSha256: exact.reservation.expectationSha256,
    releaseRun: exact.reservation.releaseRun,
    verifiedAt: new Date(now).toISOString(),
  };
}

export const RELEASE_APPROVAL_CONSUMPTION_TAG_REF_PREFIX = TAG_REF_PREFIX;
