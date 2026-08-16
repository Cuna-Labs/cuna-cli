import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RELEASE_APPROVAL_MAXIMUM_LEASE_MS,
  validateReleaseApprovalLease,
  validateReleaseApprovalLeaseShape,
} from "../scripts/lib/release-approval-lease.mjs";
import { TestResourceLedger } from "./support/test-resource-ledger.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const resources = new TestResourceLedger();
test.after(() => resources.cleanup());

const now = Date.parse("2026-08-09T18:00:00.000Z");
const candidate = Object.freeze({
  tarballSha256: "1".repeat(64),
  payloadSha256: "2".repeat(64),
  sbomSha256: "3".repeat(64),
  releaseEnvelopeSha256: "4".repeat(64),
  releaseInputsSha256: "5".repeat(64),
  distributionManifestSha256: "6".repeat(64),
});

function lease() {
  return {
    schemaVersion: 1,
    predicateType: "https://getcuna.com/attestations/cuna-cli-release-approval/v1",
    decision: "READY",
    package: { name: "@cuna_labs/cli", version: "0.1.0" },
    source: { repository: "Cuna-Labs/cuna-cli", commit: "a".repeat(40), ref: "refs/heads/main" },
    candidate: { ...candidate },
    receiptCohort: {
      sha256: "7".repeat(64),
      verificationSha256: "8".repeat(64),
      workflow: ".github/workflows/distribution-observation.yml",
      runId: "101",
      runAttempt: 1,
    },
    contractAuthority: {
      producerRepository: "Cuna-Labs/infra",
      sourceCommit: "b".repeat(40),
      contractSha256: "9".repeat(64),
      approvalAttestationSha256: "c".repeat(64),
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
    recovery: { planSha256: "d".repeat(64), strategy: "halt-and-fixed-forward" },
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + RELEASE_APPROVAL_MAXIMUM_LEASE_MS - 1_000).toISOString(),
    nonce: `cuna_release_${"n".repeat(32)}`,
    conditions: [],
  };
}

function expectation(subject = lease()) {
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

test("release approval lease binds every release identity and remains non-authorizing without an attestation", () => {
  const subject = lease();
  assert.equal(validateReleaseApprovalLease(subject, expectation(subject), now), subject);
});

test("release approval lease rejects substitution, expiry, excessive duration, and future issuance", () => {
  const substitutions = [
    ["candidate", (subject) => { subject.candidate.tarballSha256 = "e".repeat(64); }, /candidate identity differs/u],
    ["receipt cohort", (subject) => { subject.receiptCohort.sha256 = "e".repeat(64); }, /receipt cohort differs/u],
    ["contract", (subject) => { subject.contractAuthority.contractSha256 = "e".repeat(64); }, /contract authority differs/u],
    ["controller", (subject) => { subject.controller.actorId = "404"; }, /controller differs/u],
    ["review attempt", (subject) => { subject.review.runAttempt = 2; }, /review identity differs/u],
    ["recovery", (subject) => { subject.recovery.planSha256 = "e".repeat(64); }, /recovery identity differs/u],
    ["nonce", (subject) => { subject.nonce = `cuna_release_${"x".repeat(32)}`; }, /nonce differs/u],
  ];
  for (const [label, mutate, pattern] of substitutions) {
    const subject = lease();
    const expected = expectation(subject);
    mutate(subject);
    assert.throws(() => validateReleaseApprovalLease(subject, expected, now), pattern, label);
  }

  const expired = lease();
  expired.expiresAt = new Date(now).toISOString();
  assert.throws(() => validateReleaseApprovalLeaseShape(expired, now), /expired/u);

  const long = lease();
  long.expiresAt = new Date(Date.parse(long.issuedAt) + RELEASE_APPROVAL_MAXIMUM_LEASE_MS + 1).toISOString();
  assert.throws(() => validateReleaseApprovalLeaseShape(long, now), /exceeds 60 minutes/u);

  const future = lease();
  future.issuedAt = new Date(now + 1).toISOString();
  future.expiresAt = new Date(now + 10 * 60_000).toISOString();
  assert.throws(() => validateReleaseApprovalLeaseShape(future, now), /issued in the future/u);

  const excessiveRemaining = lease();
  excessiveRemaining.issuedAt = new Date(now).toISOString();
  excessiveRemaining.expiresAt = new Date(now + RELEASE_APPROVAL_MAXIMUM_LEASE_MS + 1).toISOString();
  assert.throws(() => validateReleaseApprovalLeaseShape(excessiveRemaining, now), /exceeds 60 minutes/u);

  const dateOnly = lease();
  dateOnly.issuedAt = "2026-08-09";
  assert.throws(() => validateReleaseApprovalLeaseShape(dateOnly, now), /canonical UTC RFC3339/u);
});

test("release decision conditions and reviewer identity are internally consistent", () => {
  const readyWithNoConditions = lease();
  readyWithNoConditions.decision = "READY_WITH_CONDITIONS";
  assert.throws(() => validateReleaseApprovalLeaseShape(readyWithNoConditions, now), /requires the preview-only control/u);

  const readyWithConditions = lease();
  readyWithConditions.conditions = ["PREVIEW_TAG_ONLY"];
  assert.throws(() => validateReleaseApprovalLeaseShape(readyWithConditions, now), /READY cannot carry/u);

  const whitespace = lease();
  whitespace.decision = "READY_WITH_CONDITIONS";
  whitespace.conditions = ["publish preview only"];
  assert.throws(() => validateReleaseApprovalLeaseShape(whitespace, now), /not machine-enforceable/u);

  const nonPreview = lease();
  nonPreview.decision = "READY_WITH_CONDITIONS";
  nonPreview.conditions = ["PREVIEW_TAG_ONLY"];
  nonPreview.promotion.tag = "latest";
  assert.throws(() => validateReleaseApprovalLeaseShape(nonPreview, now), /promotion target is invalid/u);

  const solo = lease();
  solo.review.approverIdentityClass = "SOLO_OWNER_EXPLICIT_RISK_ACCEPTANCE";
  assert.throws(() => validateReleaseApprovalLeaseShape(solo, now), /explicit risk acceptance/u);
});

test("CLI semantic verifier never claims cryptographic release authorization", async () => {
  const root = await resources.createTempDirectory("cuna-release-lease-");
  await mkdir(root, { recursive: true });
  const actualNow = Date.now();
  const subject = lease();
  subject.issuedAt = new Date(actualNow - 1_000).toISOString();
  subject.expiresAt = new Date(actualNow + 60_000).toISOString();
  await writeFile(path.join(root, "lease.json"), JSON.stringify(subject));
  await writeFile(path.join(root, "expectation.json"), JSON.stringify(expectation(subject)));
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const result = await promisify(execFile)(process.execPath, [
    "scripts/verify-release-approval-lease.mjs",
    "--root", root,
    "--lease", "lease.json",
    "--expectation", "expectation.json",
  ], { cwd: repositoryRoot });
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "release-approval-lease-semantically-verified",
    releaseAuthorized: false,
    limitation: "Cryptographic workflow attestation, protected-environment approval, and single-use nonce consumption must be verified separately.",
  });
  const expired = lease();
  expired.issuedAt = new Date(actualNow - 120_000).toISOString();
  expired.expiresAt = new Date(actualNow - 60_000).toISOString();
  const spoofedExpectation = { ...expectation(expired), now: Date.parse(expired.issuedAt) };
  await writeFile(path.join(root, "expired.json"), JSON.stringify(expired));
  await writeFile(path.join(root, "spoofed-expectation.json"), JSON.stringify(spoofedExpectation));
  await assert.rejects(
    promisify(execFile)(process.execPath, [
      "scripts/verify-release-approval-lease.mjs",
      "--root", root,
      "--lease", "expired.json",
      "--expectation", "spoofed-expectation.json",
    ], { cwd: repositoryRoot }),
    /verification input keys differ/u,
  );
  await assert.rejects(
    promisify(execFile)(process.execPath, [
      "scripts/verify-release-approval-lease.mjs",
      "--root", root,
      "--lease", "../outside.json",
      "--expectation", "expectation.json",
    ], { cwd: repositoryRoot }),
    /must name a file below the evidence root/u,
  );
});
