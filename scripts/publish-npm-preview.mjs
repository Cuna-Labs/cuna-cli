import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { executeNpmPreviewPublication } from "./lib/npm-preview-publication.mjs";
import { verifyReservedReleaseApprovalConsumption } from "./lib/release-approval-consumption.mjs";
import { validateReleaseApprovalLease } from "./lib/release-approval-lease.mjs";
import { invariant, sha256File, validateEnvelope } from "./lib/release-evidence.mjs";

const execute = promisify(execFile);
const SHA256 = /^[0-9a-f]{64}$/u;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const repositoryRoot = process.cwd();
const admittedRoot = path.join(repositoryRoot, "admitted");
const approvalRoot = path.join(admittedRoot, "approval");
const releaseRoot = path.join(admittedRoot, "release-artifacts");
const leaseFile = path.join(approvalRoot, "release-approval-lease.json");
const expectationFile = path.join(approvalRoot, "release-approval-expectation.json");
const envelopeFile = path.join(releaseRoot, "release-envelope.json");
const authorityFile = path.join(repositoryRoot, "packaging", "release-approval-consumption-authority.json");

const version = process.env.VERSION;
const leaseSha256 = process.env.APPROVAL_LEASE_SHA256;
const expectationSha256 = process.env.APPROVAL_EXPECTATION_SHA256;
invariant(typeof version === "string" && VERSION.test(version), "Publication version is invalid");
invariant(typeof leaseSha256 === "string" && SHA256.test(leaseSha256), "Approval lease digest is invalid");
invariant(typeof expectationSha256 === "string" && SHA256.test(expectationSha256), "Approval expectation digest is invalid");

const leaseBytes = await readFile(leaseFile);
const expectationBytes = await readFile(expectationFile);
const lease = JSON.parse(leaseBytes);
const expectation = JSON.parse(expectationBytes);
const declaration = JSON.parse(await readFile(authorityFile, "utf8"));
const envelope = JSON.parse(await readFile(envelopeFile, "utf8"));
validateEnvelope(envelope);
invariant(envelope.version === version, "Candidate version differs from the publication request");
const tarballFile = path.join(releaseRoot, envelope.tarball.file);
invariant(path.dirname(tarballFile) === releaseRoot && /^[A-Za-z0-9._-]+\.tgz$/u.test(envelope.tarball.file), "Candidate tarball path is invalid");
const context = {
  repository: process.env.GITHUB_REPOSITORY,
  workflow: ".github/workflows/release.yml",
  ref: process.env.GITHUB_REF,
  event: process.env.GITHUB_EVENT_NAME,
  sourceCommit: process.env.RELEASE_SOURCE_COMMIT,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  actorId: process.env.GITHUB_ACTOR_ID,
  actorLogin: process.env.GITHUB_ACTOR,
  environment: "npm",
};

await executeNpmPreviewPublication({
  verifyLease: async () => {
    invariant(await sha256File(leaseFile) === leaseSha256, "Approval lease digest differs at publication");
    invariant(await sha256File(expectationFile) === expectationSha256, "Approval expectation digest differs at publication");
    invariant(await sha256File(tarballFile) === envelope.tarball.sha256, "Candidate tarball digest differs at publication");
    validateReleaseApprovalLease(lease, expectation, Date.now());
  },
  verifyAttestation: async () => {
    await execute("gh", [
      "attestation", "verify", leaseFile,
      "--repo", process.env.GITHUB_REPOSITORY,
      "--signer-workflow", `${process.env.GITHUB_REPOSITORY}/.github/workflows/release-review.yml`,
    ], { cwd: repositoryRoot, env: process.env });
  },
  verifyNonce: async () => {
    await verifyReservedReleaseApprovalConsumption({
      declaration,
      lease,
      expectation,
      leaseBytes,
      expectationBytes,
      context,
      token: process.env.GITHUB_TOKEN,
    });
  },
  verifyRegistryAbsent: async () => {
    await execute(process.execPath, [
      "scripts/verify-registry-version-absent.mjs",
      "--envelope", envelopeFile,
      "--version", version,
    ], { cwd: repositoryRoot, env: process.env });
  },
  publish: async () => execute("npm", [
    "publish", tarballFile,
    "--provenance",
    "--access", "public",
    "--registry", "https://registry.npmjs.org/",
    "--tag", "preview",
  ], { cwd: repositoryRoot, env: process.env }),
});
process.stdout.write(`${JSON.stringify({ status: "NPM_PREVIEW_PUBLISHED_AND_REVALIDATED", package: "@cuna_labs/cli", version })}\n`);
