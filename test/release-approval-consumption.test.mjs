import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReleaseApprovalConsumption,
  reserveReleaseApprovalConsumption,
  verifyReservedReleaseApprovalConsumption,
  verifyReleaseApprovalConsumptionAuthority,
} from "../scripts/lib/release-approval-consumption.mjs";

const now = Date.parse("2026-08-11T12:00:00.000Z");
const sha = (character) => character.repeat(64);

function lease() {
  return {
    schemaVersion: 1,
    predicateType: "https://getcuna.com/attestations/cuna-cli-release-approval/v1",
    decision: "READY_WITH_CONDITIONS",
    package: { name: "@cuna_labs/cli", version: "0.1.0-preview.1" },
    source: { repository: "Cuna-Labs/cuna-cli", commit: "a".repeat(40), ref: "refs/heads/main" },
    candidate: {
      tarballSha256: sha("1"),
      payloadSha256: sha("2"),
      sbomSha256: sha("3"),
      releaseEnvelopeSha256: sha("4"),
      releaseInputsSha256: sha("5"),
      distributionManifestSha256: sha("6"),
    },
    receiptCohort: {
      sha256: sha("7"),
      verificationSha256: sha("8"),
      workflow: ".github/workflows/distribution-observation.yml",
      runId: "101",
      runAttempt: 1,
    },
    contractAuthority: {
      producerRepository: "Cuna-Labs/infra",
      sourceCommit: "b".repeat(40),
      contractSha256: sha("9"),
      approvalAttestationSha256: sha("c"),
    },
    promotion: { registry: "https://registry.npmjs.org", tag: "preview", environment: "npm" },
    controller: {
      actorId: "303",
      actorLogin: "release-controller",
      identityClass: "RELEASE_WORKFLOW_INITIATOR",
    },
    review: {
      workflow: ".github/workflows/release-review.yml",
      runId: "202",
      runAttempt: 1,
      environment: "release-review-npm-preview",
      approverIdentityClass: "PROTECTED_ENVIRONMENT_REVIEWER",
      soloOwnerRiskAccepted: false,
    },
    recovery: { planSha256: sha("d"), strategy: "halt-and-fixed-forward" },
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 30 * 60_000).toISOString(),
    nonce: `cuna_release_${"n".repeat(32)}`,
    conditions: ["PREVIEW_TAG_ONLY"],
  };
}

function expectation(subject) {
  return {
    decision: subject.decision,
    version: subject.package.version,
    sourceCommit: subject.source.commit,
    candidate: { ...subject.candidate },
    tag: subject.promotion.tag,
    receiptCohort: {
      sha256: subject.receiptCohort.sha256,
      verificationSha256: subject.receiptCohort.verificationSha256,
      runId: subject.receiptCohort.runId,
      runAttempt: subject.receiptCohort.runAttempt,
    },
    contractAuthority: { ...subject.contractAuthority },
    controller: { ...subject.controller },
    review: {
      runId: subject.review.runId,
      runAttempt: subject.review.runAttempt,
      approverIdentityClass: subject.review.approverIdentityClass,
      soloOwnerRiskAccepted: subject.review.soloOwnerRiskAccepted,
    },
    recovery: { ...subject.recovery },
    nonce: subject.nonce,
    conditions: [...subject.conditions],
  };
}

function context(subject = lease()) {
  return {
    repository: "Cuna-Labs/cuna-cli",
    workflow: ".github/workflows/release.yml",
    ref: "refs/heads/main",
    event: "workflow_dispatch",
    sourceCommit: subject.source.commit,
    runId: "404",
    runAttempt: 1,
    actorId: subject.controller.actorId,
    actorLogin: subject.controller.actorLogin,
    environment: "npm",
  };
}

const configuredAuthority = Object.freeze({
  schemaVersion: 1,
  status: "CONFIGURED",
  repository: "Cuna-Labs/cuna-cli",
  environment: "npm",
  protectedRef: "main",
  requiredReviewer: { type: "User", id: 909, login: "independent-reviewer" },
  rulesetName: "Protect Cuna release approval consumptions",
  rulesetId: 20698394,
  tagRefPrefix: "refs/tags/cuna-release-approval-consumption/",
  requiredRules: ["deletion", "non_fast_forward", "update"],
  requireNoBypassActors: true,
  requireAdminBypassDisabled: true,
  requirePreventSelfReview: true,
});

function response(status, value) {
  const body = value === undefined ? "" : JSON.stringify(value);
  return {
    status,
    headers: { get: (name) => name.toLowerCase() === "content-length" ? String(Buffer.byteLength(body)) : null },
    text: async () => body,
  };
}

function authorityResponses({ replay = false, rulesetBypass = false, weakenBeforeReservation = false, missingUpdate = false } = {}) {
  let refCreated = false;
  let environmentReads = 0;
  let tagRequest;
  const tagSha = "e".repeat(40);
  return async (url, options) => {
    if (url.endsWith("/environments/npm") && options.method === "GET") {
      environmentReads += 1;
      return response(200, {
        name: "npm",
        can_admins_bypass: false,
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        protection_rules: [{
          type: "required_reviewers",
          prevent_self_review: !(weakenBeforeReservation && environmentReads > 1),
          reviewers: [{ type: "User", reviewer: { id: 909, login: "independent-reviewer" } }],
        }],
      });
    }
    if (url.endsWith("/deployment-branch-policies")) {
      return response(200, { branch_policies: [{ type: "branch", name: "main" }] });
    }
    if (url.endsWith("/rulesets") && options.method === "GET") {
      return response(200, [{ id: configuredAuthority.rulesetId, name: configuredAuthority.rulesetName, target: "tag", enforcement: "active" }]);
    }
    if (url.endsWith(`/rulesets/${configuredAuthority.rulesetId}`)) {
      return response(200, {
        id: configuredAuthority.rulesetId,
        name: configuredAuthority.rulesetName,
        target: "tag",
        enforcement: "active",
        source_type: "Repository",
        source: "Cuna-Labs/cuna-cli",
        bypass_actors: rulesetBypass ? [{ actor_type: "OrganizationAdmin" }] : [],
        current_user_can_bypass: rulesetBypass ? "always" : "never",
        conditions: { ref_name: { include: [`${configuredAuthority.tagRefPrefix}*`], exclude: [] } },
        rules: [{ type: "deletion" }, { type: "non_fast_forward" }, ...(!missingUpdate ? [{ type: "update" }] : [])],
      });
    }
    if (url.endsWith("/git/tags") && options.method === "POST") {
      tagRequest = JSON.parse(options.body);
      return response(201, { sha: tagSha });
    }
    if (url.endsWith("/git/refs") && options.method === "POST") {
      if (replay || refCreated) return response(422, { message: "Reference already exists" });
      refCreated = true;
      const request = JSON.parse(options.body);
      return response(201, { ref: request.ref, object: { sha: request.sha } });
    }
    if (url.includes("/git/ref/tags/")) {
      const ref = `refs/${decodeURIComponent(url.split("/git/ref/")[1]).replaceAll("%2F", "/")}`;
      return response(200, { ref, object: { sha: tagSha } });
    }
    if (url.endsWith(`/git/tags/${tagSha}`) && options.method === "GET") {
      return response(200, {
        sha: tagSha,
        tag: tagRequest.tag,
        message: tagRequest.message,
        object: { type: tagRequest.type, sha: tagRequest.object },
        tagger: tagRequest.tagger,
      });
    }
    throw new Error(`unexpected request: ${options.method} ${url}`);
  };
}

function consumption(subject = lease()) {
  const expected = expectation(subject);
  const leaseBytes = Buffer.from(JSON.stringify(subject));
  const expectationBytes = Buffer.from(JSON.stringify(expected));
  const releaseContext = context(subject);
  const built = buildReleaseApprovalConsumption({
    lease: subject,
    expectation: expected,
    leaseBytes,
    expectationBytes,
    context: releaseContext,
    now,
  });
  return { ...built, context: releaseContext };
}

test("one durable reservation binds candidate, controller, channel, lease, and workflow run", async () => {
  const value = consumption();
  const receipt = await reserveReleaseApprovalConsumption({
    declaration: configuredAuthority,
    consumption: value,
    token: "x".repeat(40),
    fetchImpl: authorityResponses(),
    apiRoot: "https://api.github.test",
  });
  assert.equal(receipt.status, "CONSUMED");
  assert.equal(receipt.ref, value.ref);
  assert.equal(receipt.releaseRun.id, "404");
});

test("standalone authority verification is read-only and proves the exact external controls", async () => {
  const responder = authorityResponses();
  const fetchImpl = async (url, options) => {
    assert.equal(options.method, "GET");
    return responder(url, options);
  };
  const result = await verifyReleaseApprovalConsumptionAuthority({
    declaration: configuredAuthority,
    context: context(),
    token: "x".repeat(40),
    fetchImpl,
    apiRoot: "https://api.github.test",
  });
  assert.deepEqual(result.reviewerIds, ["909"]);
});

test("fresh publication revalidation proves the exact immutable reservation without a write", async () => {
  const subject = lease();
  const expected = expectation(subject);
  const leaseBytes = Buffer.from(JSON.stringify(subject));
  const expectationBytes = Buffer.from(JSON.stringify(expected));
  const releaseContext = context(subject);
  const built = buildReleaseApprovalConsumption({ lease: subject, expectation: expected, leaseBytes, expectationBytes, context: releaseContext, now });
  const responder = authorityResponses();
  await reserveReleaseApprovalConsumption({
    declaration: configuredAuthority,
    consumption: { ...built, context: releaseContext },
    token: "x".repeat(40),
    fetchImpl: responder,
    apiRoot: "https://api.github.test",
  });
  const receipt = await verifyReservedReleaseApprovalConsumption({
    declaration: configuredAuthority,
    lease: subject,
    expectation: expected,
    leaseBytes,
    expectationBytes,
    context: releaseContext,
    token: "x".repeat(40),
    now: now + 1_000,
    fetchImpl: responder,
    apiRoot: "https://api.github.test",
  });
  assert.equal(receipt.status, "CONSUMPTION_STILL_VALID");
  assert.equal(receipt.ref, built.ref);

  await assert.rejects(
    verifyReservedReleaseApprovalConsumption({
      declaration: configuredAuthority,
      lease: subject,
      expectation: expected,
      leaseBytes,
      expectationBytes,
      context: releaseContext,
      token: "x".repeat(40),
      now: Date.parse(subject.expiresAt),
      fetchImpl: responder,
      apiRoot: "https://api.github.test",
    }),
    /expired/u,
  );
});

test("configured authority rejects a ruleset that permits ordinary tag updates", async () => {
  await assert.rejects(
    verifyReleaseApprovalConsumptionAuthority({
      declaration: configuredAuthority,
      context: context(),
      token: "x".repeat(40),
      fetchImpl: authorityResponses({ missingUpdate: true }),
      apiRoot: "https://api.github.test",
    }),
    /exactly prevent deletion and rewrite/u,
  );
});

test("replay and concurrent reservations cannot produce a second consumption", async () => {
  const value = consumption();
  await assert.rejects(
    reserveReleaseApprovalConsumption({
      declaration: configuredAuthority,
      consumption: value,
      token: "x".repeat(40),
      fetchImpl: authorityResponses({ replay: true }),
      apiRoot: "https://api.github.test",
    }),
    /already consumed/u,
  );

  const shared = authorityResponses();
  const attempts = await Promise.allSettled([1, 2].map(() => reserveReleaseApprovalConsumption({
    declaration: configuredAuthority,
    consumption: value,
    token: "x".repeat(40),
    fetchImpl: shared,
    apiRoot: "https://api.github.test",
  })));
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((result) => result.status === "rejected" && /already consumed/u.test(result.reason.message)).length, 1);
});

test("stale, substituted, wrong-controller, and bypassable authority states fail before effect", async () => {
  const stale = lease();
  stale.expiresAt = new Date(now).toISOString();
  assert.throws(() => consumption(stale), /expired/u);

  const substituted = lease();
  const expected = expectation(substituted);
  substituted.candidate.tarballSha256 = sha("f");
  assert.throws(() => buildReleaseApprovalConsumption({
    lease: substituted,
    expectation: expected,
    leaseBytes: Buffer.from(JSON.stringify(substituted)),
    expectationBytes: Buffer.from(JSON.stringify(expected)),
    context: context(substituted),
    now,
  }), /candidate identity differs/u);

  const wrongController = lease();
  const wrongContext = { ...context(wrongController), actorId: "999" };
  assert.throws(() => buildReleaseApprovalConsumption({
    lease: wrongController,
    expectation: expectation(wrongController),
    leaseBytes: Buffer.from(JSON.stringify(wrongController)),
    expectationBytes: Buffer.from(JSON.stringify(expectation(wrongController))),
    context: wrongContext,
    now,
  }), /controller differs/u);

  await assert.rejects(
    reserveReleaseApprovalConsumption({
      declaration: configuredAuthority,
      consumption: consumption(),
      token: "x".repeat(40),
      fetchImpl: authorityResponses({ rulesetBypass: true }),
      apiRoot: "https://api.github.test",
    }),
    /permits bypass/u,
  );
});

test("authority is re-read after tag-object construction and a weakened policy prevents reservation", async () => {
  const requests = authorityResponses({ weakenBeforeReservation: true });
  await assert.rejects(
    reserveReleaseApprovalConsumption({
      declaration: configuredAuthority,
      consumption: consumption(),
      token: "x".repeat(40),
      fetchImpl: requests,
      apiRoot: "https://api.github.test",
    }),
    /prevent self-review/u,
  );
});

test("a declaration cannot claim configured status without the exact external authority", async () => {
  const declaration = { ...configuredAuthority, status: "UNCONFIGURED_BLOCKING" };
  await assert.rejects(
    reserveReleaseApprovalConsumption({
      declaration,
      consumption: consumption(),
      token: "x".repeat(40),
      fetchImpl: authorityResponses(),
      apiRoot: "https://api.github.test",
    }),
    /remains unconfigured/u,
  );
});
