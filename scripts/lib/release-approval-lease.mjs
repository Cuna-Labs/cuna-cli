import { invariant } from "./release-evidence.mjs";

const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/u;
const MAXIMUM_LEASE_MS = 60 * 60 * 1_000;
const CANONICAL_TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const CANDIDATE_FIELDS = Object.freeze([
  "tarballSha256",
  "payloadSha256",
  "sbomSha256",
  "releaseEnvelopeSha256",
  "releaseInputsSha256",
  "distributionManifestSha256",
]);

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

function sameFields(left, right, fields) {
  return fields.every((field) => left[field] === right[field]);
}

export function validateContractAuthority(authority) {
  exactKeys(authority, ["schemaVersion", "authority", "status", "producerRepository", "sourceCommit", "contractSha256", "approvalAttestationSha256"], "contract authority");
  invariant(authority.schemaVersion === 1, "Unsupported contract-authority schema");
  invariant(authority.authority === "CUNA_CANONICAL_PUBLIC_API_CONTRACT", "Contract authority is not canonical");
  invariant(authority.status === "APPROVED", "Contract authority is not approved");
  invariant(authority.producerRepository === "Cuna-Labs/infra", "Contract producer repository is invalid");
  invariant(COMMIT.test(authority.sourceCommit), "Contract source commit is invalid");
  digest(authority.contractSha256, "Contract digest");
  digest(authority.approvalAttestationSha256, "Contract approval attestation digest");
  return authority;
}

function validateConditions(lease) {
  invariant(Array.isArray(lease.conditions) && lease.conditions.length <= 1 && new Set(lease.conditions).size === lease.conditions.length, "Release conditions are invalid");
  for (const condition of lease.conditions) invariant(condition === "PREVIEW_TAG_ONLY", "Release condition is not machine-enforceable");
  if (lease.decision === "READY") invariant(lease.conditions.length === 0, "READY cannot carry unresolved conditions");
  if (lease.decision === "READY_WITH_CONDITIONS") {
    invariant(JSON.stringify(lease.conditions) === JSON.stringify(["PREVIEW_TAG_ONLY"]), "READY_WITH_CONDITIONS requires the preview-only control");
    invariant(lease.promotion.tag === "preview", "The preview-only condition cannot authorize another dist-tag");
  }
}

export function validateReleaseApprovalLeaseShape(lease, now = Date.now()) {
  exactKeys(lease, ["schemaVersion", "predicateType", "decision", "package", "source", "candidate", "receiptCohort", "contractAuthority", "promotion", "controller", "review", "recovery", "issuedAt", "expiresAt", "nonce", "conditions"], "release approval lease");
  invariant(lease.schemaVersion === 1, "Unsupported release-approval lease schema");
  invariant(lease.predicateType === "https://getcuna.com/attestations/cuna-cli-release-approval/v1", "Release-approval predicate type differs");
  invariant(lease.decision === "READY" || lease.decision === "READY_WITH_CONDITIONS", "Release decision is not authorizing");
  exactKeys(lease.package, ["name", "version"], "lease package");
  invariant(lease.package.name === "@cuna_labs/cli" && VERSION.test(lease.package.version), "Lease package identity is invalid");
  exactKeys(lease.source, ["repository", "commit", "ref"], "lease source");
  invariant(lease.source.repository === "Cuna-Labs/cuna-cli", "Lease repository differs");
  invariant(COMMIT.test(lease.source.commit) && lease.source.ref === "refs/heads/main", "Lease source identity is invalid");
  exactKeys(lease.candidate, CANDIDATE_FIELDS, "lease candidate");
  for (const [name, value] of Object.entries(lease.candidate)) digest(value, `Candidate ${name}`);
  exactKeys(lease.receiptCohort, ["sha256", "verificationSha256", "workflow", "runId", "runAttempt"], "receipt cohort");
  digest(lease.receiptCohort.sha256, "Receipt cohort digest");
  digest(lease.receiptCohort.verificationSha256, "Receipt verification digest");
  invariant(lease.receiptCohort.workflow === ".github/workflows/distribution-observation.yml", "Receipt observer workflow differs");
  invariant(/^[1-9][0-9]*$/u.test(lease.receiptCohort.runId) && Number.isSafeInteger(lease.receiptCohort.runAttempt) && lease.receiptCohort.runAttempt > 0, "Receipt workflow identity is invalid");
  validateContractAuthority({ schemaVersion: 1, authority: "CUNA_CANONICAL_PUBLIC_API_CONTRACT", status: "APPROVED", ...lease.contractAuthority });
  exactKeys(lease.contractAuthority, ["producerRepository", "sourceCommit", "contractSha256", "approvalAttestationSha256"], "lease contract authority");
  exactKeys(lease.promotion, ["registry", "tag", "environment"], "lease promotion");
  invariant(lease.promotion.registry === "https://registry.npmjs.org" && lease.promotion.tag === "preview" && lease.promotion.environment === "npm", "Lease promotion target is invalid");
  exactKeys(lease.controller, ["actorId", "actorLogin", "identityClass"], "lease controller");
  invariant(/^[1-9][0-9]*$/u.test(lease.controller.actorId), "Lease controller actor ID is invalid");
  invariant(/^[A-Za-z0-9-]{1,39}$/u.test(lease.controller.actorLogin), "Lease controller login is invalid");
  invariant(lease.controller.identityClass === "RELEASE_WORKFLOW_INITIATOR", "Lease controller identity class is invalid");
  exactKeys(lease.review, ["workflow", "runId", "runAttempt", "environment", "approverIdentityClass", "soloOwnerRiskAccepted"], "lease review");
  invariant(lease.review.workflow === ".github/workflows/release-review.yml" && lease.review.environment === "release-review-npm-preview", "Lease review authority differs");
  invariant(/^[1-9][0-9]*$/u.test(lease.review.runId) && Number.isSafeInteger(lease.review.runAttempt) && lease.review.runAttempt > 0, "Lease review workflow identity is invalid");
  if (lease.review.approverIdentityClass === "SOLO_OWNER_EXPLICIT_RISK_ACCEPTANCE") {
    invariant(lease.review.soloOwnerRiskAccepted === true, "Solo-owner review requires explicit risk acceptance");
  } else {
    invariant(lease.review.approverIdentityClass === "PROTECTED_ENVIRONMENT_REVIEWER", "Approver identity class is invalid");
    invariant(lease.review.soloOwnerRiskAccepted === false, "Protected reviewer mode cannot claim solo-owner risk acceptance");
  }
  exactKeys(lease.recovery, ["planSha256", "strategy"], "lease recovery");
  digest(lease.recovery.planSha256, "Recovery-plan digest");
  invariant(lease.recovery.strategy === "halt-and-fixed-forward" || lease.recovery.strategy === "dist-tag-recovery-and-fixed-forward", "Recovery strategy is invalid");
  invariant(typeof lease.issuedAt === "string" && CANONICAL_TIMESTAMP.test(lease.issuedAt), "Lease issuedAt must be canonical UTC RFC3339");
  invariant(typeof lease.expiresAt === "string" && CANONICAL_TIMESTAMP.test(lease.expiresAt), "Lease expiresAt must be canonical UTC RFC3339");
  const issuedAt = Date.parse(lease.issuedAt);
  const expiresAt = Date.parse(lease.expiresAt);
  invariant(
    Number.isFinite(issuedAt) && Number.isFinite(expiresAt) &&
      new Date(issuedAt).toISOString() === lease.issuedAt && new Date(expiresAt).toISOString() === lease.expiresAt &&
      expiresAt > issuedAt,
    "Lease time bounds are invalid",
  );
  invariant(expiresAt - issuedAt <= MAXIMUM_LEASE_MS, "Release approval lease exceeds 60 minutes");
  invariant(NONCE.test(lease.nonce), "Release approval nonce is invalid");
  validateConditions(lease);
  invariant(Number.isSafeInteger(now) && now >= 0, "Release approval verification time is invalid");
  invariant(issuedAt <= now, "Release approval lease is issued in the future");
  invariant(expiresAt > now, "Release approval lease is expired");
  invariant(expiresAt <= now + MAXIMUM_LEASE_MS, "Release approval lease has more than 60 minutes remaining");
  return lease;
}

export function validateReleaseApprovalLease(lease, input, now = Date.now()) {
  exactKeys(
    input,
    ["decision", "version", "sourceCommit", "candidate", "tag", "receiptCohort", "contractAuthority", "controller", "review", "recovery", "nonce", "conditions"],
    "release approval verification input",
  );
  validateReleaseApprovalLeaseShape(lease, now);
  exactKeys(input.candidate, CANDIDATE_FIELDS, "expected candidate");
  for (const [name, value] of Object.entries(input.candidate)) digest(value, `Expected candidate ${name}`);
  exactKeys(input.receiptCohort, ["sha256", "verificationSha256", "runId", "runAttempt"], "expected receipt cohort");
  exactKeys(input.contractAuthority, ["producerRepository", "sourceCommit", "contractSha256", "approvalAttestationSha256"], "expected contract authority");
  validateContractAuthority({ schemaVersion: 1, authority: "CUNA_CANONICAL_PUBLIC_API_CONTRACT", status: "APPROVED", ...input.contractAuthority });
  exactKeys(input.controller, ["actorId", "actorLogin", "identityClass"], "expected release controller");
  exactKeys(input.review, ["runId", "runAttempt", "approverIdentityClass", "soloOwnerRiskAccepted"], "expected release review");
  exactKeys(input.recovery, ["planSha256", "strategy"], "expected recovery");
  invariant(lease.decision === input.decision, "Release approval decision differs");
  invariant(lease.package.version === input.version, "Release approval version differs");
  invariant(lease.source.commit === input.sourceCommit, "Release approval source commit differs");
  invariant(sameFields(lease.candidate, input.candidate, CANDIDATE_FIELDS), "Release approval candidate identity differs");
  invariant(lease.promotion.tag === input.tag, "Release approval promotion tag differs");
  invariant(sameFields(lease.receiptCohort, input.receiptCohort, ["sha256", "verificationSha256", "runId", "runAttempt"]), "Release approval receipt cohort differs");
  invariant(sameFields(lease.contractAuthority, input.contractAuthority, ["producerRepository", "sourceCommit", "contractSha256", "approvalAttestationSha256"]), "Release approval contract authority differs");
  invariant(sameFields(lease.controller, input.controller, ["actorId", "actorLogin", "identityClass"]), "Release approval controller differs");
  invariant(sameFields(lease.review, input.review, ["runId", "runAttempt", "approverIdentityClass", "soloOwnerRiskAccepted"]), "Release approval review identity differs");
  invariant(sameFields(lease.recovery, input.recovery, ["planSha256", "strategy"]), "Release approval recovery identity differs");
  invariant(lease.nonce === input.nonce, "Release approval nonce differs");
  invariant(JSON.stringify(lease.conditions) === JSON.stringify(input.conditions), "Release approval conditions differ");
  return lease;
}

export const RELEASE_APPROVAL_MAXIMUM_LEASE_MS = MAXIMUM_LEASE_MS;
