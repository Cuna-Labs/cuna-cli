import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateContractAuthority, validateReleaseApprovalLease } from "./lib/release-approval-lease.mjs";
import { invariant, parseArgs, readJson, sha256File } from "./lib/release-evidence.mjs";

// Minting is the last step of the review, not its first. Every value written
// here is read from evidence that an earlier step already verified against the
// candidate; nothing is taken from the dispatch inputs, and there is no
// argument by which a caller can name an approver, a cohort or a contract.
//
// The lease is then validated against the expectation it was built from, which
// is the same function `release.yml` runs at publication. A lease this script
// could produce but that verifier would reject cannot leave the workflow.

const LEASE_MINUTES = 30;
const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const evidenceRoot = path.resolve(root, args.get("evidence") ?? "admitted/release-artifacts");
const output = path.resolve(root, args.get("output") ?? "approval");

const approvalEvent = await readJson(path.resolve(root, args.get("approval-event") ?? "evidence/release-approval-event.json"));
const cohortVerification = await readJson(path.resolve(root, args.get("cohort-verification") ?? "evidence/observation-cohort-verification.json"));
const contractAuthority = validateContractAuthority(await readJson(path.join(root, "packaging", "contract-authority.json")));

invariant(approvalEvent.status === "PROTECTED_ENVIRONMENT_APPROVAL_OBSERVED", "Approval event evidence is not an observed protected-environment approval");
invariant(cohortVerification.status === "CANDIDATE_BOUND_OBSERVATION_COHORT_VERIFIED", "Observation cohort evidence is not verified");

const envelopeFile = path.join(evidenceRoot, "release-envelope.json");
const envelope = await readJson(envelopeFile);
const releaseEnvelopeSha256 = await sha256File(envelopeFile);
invariant(cohortVerification.releaseEnvelopeSha256 === releaseEnvelopeSha256, "Observation cohort verification describes a different candidate");

const runId = process.env.GITHUB_RUN_ID;
const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
const actorId = process.env.GITHUB_ACTOR_ID;
const actorLogin = process.env.GITHUB_ACTOR;
invariant(/^[1-9][0-9]*$/u.test(String(runId ?? "")), "GITHUB_RUN_ID is missing or invalid");
invariant(Number.isSafeInteger(runAttempt) && runAttempt > 0, "GITHUB_RUN_ATTEMPT is missing or invalid");
invariant(/^[1-9][0-9]*$/u.test(String(actorId ?? "")), "GITHUB_ACTOR_ID is missing or invalid");
// The approval already proved the approver is not the dispatcher. Re-assert it
// against the identity actually written into the lease, so a lease can never
// record a controller that is also its reviewer.
invariant(approvalEvent.runId === String(runId) && approvalEvent.runAttempt === runAttempt, "Approval event belongs to a different run");
invariant(approvalEvent.approverId !== String(actorId), "The dispatching actor cannot also be the approver");

const issued = new Date();
const issuedAt = new Date(Math.floor(issued.getTime() / 1000) * 1000).toISOString();
const expiresAt = new Date(Date.parse(issuedAt) + LEASE_MINUTES * 60_000).toISOString();

const candidate = {
  tarballSha256: envelope.tarball.sha256,
  payloadSha256: envelope.identities.payloadSha256,
  sbomSha256: envelope.sbom.sha256,
  releaseEnvelopeSha256,
  releaseInputsSha256: envelope.releaseInputs.sha256,
  distributionManifestSha256: await sha256File(path.join(evidenceRoot, "distributions", "distribution-manifest.json")),
};
const receiptCohort = {
  sha256: cohortVerification.cohortSha256,
  verificationSha256: await sha256File(path.resolve(root, args.get("cohort-verification") ?? "evidence/observation-cohort-verification.json")),
  workflow: ".github/workflows/distribution-observation.yml",
  runId: cohortVerification.observationRunId,
  runAttempt: cohortVerification.observationRunAttempt,
};
const controller = { actorId: String(actorId), actorLogin, identityClass: "RELEASE_WORKFLOW_INITIATOR" };
const review = {
  workflow: ".github/workflows/release-review.yml",
  runId: String(runId),
  runAttempt,
  environment: "release-review-npm-preview",
  approverIdentityClass: "PROTECTED_ENVIRONMENT_REVIEWER",
  soloOwnerRiskAccepted: false,
};
const recovery = {
  planSha256: await sha256File(path.join(root, "packaging", "release-recovery-plan.md")),
  strategy: "dist-tag-recovery-and-fixed-forward",
};
const lease = {
  schemaVersion: 1,
  predicateType: "https://getcuna.com/attestations/cuna-cli-release-approval/v1",
  decision: "READY_WITH_CONDITIONS",
  package: { name: envelope.packageName, version: envelope.version },
  source: { repository: envelope.repository, commit: envelope.sourceCommit, ref: "refs/heads/main" },
  candidate,
  receiptCohort,
  contractAuthority: {
    producerRepository: contractAuthority.producerRepository,
    sourceCommit: contractAuthority.sourceCommit,
    contractSha256: contractAuthority.contractSha256,
    approvalAttestationSha256: contractAuthority.approvalAttestationSha256,
  },
  promotion: { registry: "https://registry.npmjs.org", tag: "preview", environment: "npm" },
  controller,
  review,
  recovery,
  issuedAt,
  expiresAt,
  nonce: randomBytes(32).toString("base64url"),
  conditions: ["PREVIEW_TAG_ONLY"],
};
const expectation = {
  decision: lease.decision,
  version: lease.package.version,
  sourceCommit: lease.source.commit,
  candidate,
  tag: lease.promotion.tag,
  receiptCohort: {
    sha256: receiptCohort.sha256,
    verificationSha256: receiptCohort.verificationSha256,
    runId: receiptCohort.runId,
    runAttempt: receiptCohort.runAttempt,
  },
  contractAuthority: lease.contractAuthority,
  controller,
  review: {
    runId: review.runId,
    runAttempt: review.runAttempt,
    approverIdentityClass: review.approverIdentityClass,
    soloOwnerRiskAccepted: review.soloOwnerRiskAccepted,
  },
  recovery,
  nonce: lease.nonce,
  conditions: lease.conditions,
};

validateReleaseApprovalLease(lease, expectation, Date.now());

await mkdir(output, { recursive: true });
await writeFile(path.join(output, "release-approval-lease.json"), `${JSON.stringify(lease, null, 2)}\n`, { flag: "wx" });
await writeFile(path.join(output, "release-approval-expectation.json"), `${JSON.stringify(expectation, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify({
  status: "RELEASE_APPROVAL_LEASE_MINTED",
  version: lease.package.version,
  sourceCommit: lease.source.commit,
  approverLogin: approvalEvent.approverLogin,
  expiresAt,
})}\n`);
