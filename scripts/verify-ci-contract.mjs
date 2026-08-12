import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { invariant, parseArgs, readJson } from "./lib/release-evidence.mjs";
import { validateSupportPolicy } from "./release-distribution-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const packageJson = await readJson(path.join(root, "package.json"));
const supportPolicy = await readJson(path.join(root, "packaging", "support-policy.json"));
validateSupportPolicy(supportPolicy);

invariant(packageJson.name === "@cuna_labs/cli", "Unexpected package name");
invariant(packageJson.license === "Apache-2.0", "package.json license must be Apache-2.0");
invariant(packageJson.private !== true, "Release package is marked private");
invariant(packageJson.publishConfig?.registry === "https://registry.npmjs.org", "Registry is not canonical npm");
invariant(packageJson.publishConfig?.access === "public", "npm access must be public");
invariant(Object.keys(packageJson.bin ?? {}).length === 1 && typeof packageJson.bin?.cuna === "string", "package.json must expose exactly the cuna binary");
invariant(Object.keys(packageJson.bin).length === 1, "package.json exposes unexpected binaries");
for (const requiredFile of ["dist", "README.md", "LICENSE", "NOTICE"]) {
  invariant(packageJson.files?.includes(requiredFile), `package.json files must include ${requiredFile}`);
}
invariant(packageJson.scripts && typeof packageJson.scripts === "object", "package.json scripts are missing");
for (const command of ["build", "lint", "typecheck", "test"]) {
  invariant(typeof packageJson.scripts[command] === "string" && packageJson.scripts[command].length > 0, `Required npm script is missing: ${command}`);
}
for (const [name, script] of Object.entries(packageJson.scripts)) {
  invariant(!/npm\s+publish/.test(script), `Local npm script may publish: ${name}`);
}
invariant(packageJson.scripts.preinstall === undefined && packageJson.scripts.install === undefined && packageJson.scripts.postinstall === undefined, "Install lifecycle scripts are prohibited");
invariant(packageJson.engines?.node, "Explicit Node engine range is required");
await access(path.join(root, "package-lock.json"));

const ci = await readFile(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
const release = await readFile(path.join(root, ".github", "workflows", "release.yml"), "utf8");
const releaseReview = await readFile(path.join(root, ".github", "workflows", "release-review.yml"), "utf8");
const approvalConsumption = await readFile(path.join(root, "scripts", "lib", "release-approval-consumption.mjs"), "utf8");
const npmPreviewPublication = await readFile(path.join(root, "scripts", "publish-npm-preview.mjs"), "utf8");
const npmPreviewPublicationLibrary = await readFile(path.join(root, "scripts", "lib", "npm-preview-publication.mjs"), "utf8");
const approvalConsumptionAuthority = await readJson(path.join(root, "packaging", "release-approval-consumption-authority.json"));
const releaseReviewAuthority = await readJson(path.join(root, "packaging", "release-review-authority.json"));
const workflow = parseYaml(ci, { prettyErrors: true, uniqueKeys: true });
const releaseWorkflow = parseYaml(release, { prettyErrors: true, uniqueKeys: true });
const releaseReviewWorkflow = parseYaml(releaseReview, { prettyErrors: true, uniqueKeys: true });
invariant(workflow && typeof workflow === "object" && !Array.isArray(workflow), "CI workflow must parse as a YAML object");
const jobs = workflow.jobs;
invariant(jobs && typeof jobs === "object" && !Array.isArray(jobs), "CI workflow jobs are missing");
for (const job of ["public-controls", "source-gates", "native-source-gates", "native-evidence-gates", "candidate", "installed-artifact", "observed-artifact", "observation-summary", "admission", "handoff"]) {
  invariant(jobs[job] && typeof jobs[job] === "object", `CI workflow job is missing: ${job}`);
  invariant(Array.isArray(jobs[job].steps), `CI workflow job has no executable steps: ${job}`);
}
const needsList = (job) => Array.isArray(job.needs) ? job.needs : typeof job.needs === "string" ? [job.needs] : [];

invariant(
  JSON.stringify(needsList(jobs.candidate).sort()) === JSON.stringify(["native-evidence-gates", "native-source-gates", "source-gates"]),
  "Candidate generation must depend on Node, native source, and native evidence gates",
);
const nativeMatrix = jobs["native-source-gates"].strategy?.matrix?.include;
invariant(
  Array.isArray(nativeMatrix) &&
    JSON.stringify(nativeMatrix.map((entry) => entry.id).sort()) === JSON.stringify(["linux-x64", "macos-x64", "windows-x64"]),
  "Native source gates must compile all three Tier-1 platform families",
);
const nativeRuns = jobs["native-source-gates"].steps
  .map((step) => step?.run)
  .filter((run) => typeof run === "string")
  .join("\n");
for (const command of [
  "cargo +1.97.1 fmt --all -- --check",
  "cargo +1.97.1 check --workspace --all-targets --locked",
  "cargo +1.97.1 test --workspace --locked",
  "cargo +1.97.1 clippy --workspace --all-targets --locked -- -D warnings",
]) invariant(nativeRuns.includes(command), `Native source gate is missing: ${command}`);
const nativeEvidenceRuns = jobs["native-evidence-gates"].steps
  .map((step) => step?.run)
  .filter((run) => typeof run === "string")
  .join("\n");
for (const command of [
  "cargo +1.97.1 build --workspace --release --locked",
  "scripts/capture-native-windows-identity.ps1",
  "node scripts/generate-native-release-evidence.mjs",
  "node scripts/verify-native-release-evidence.mjs --evidence evidence/native-local",
  "--require-production true",
  "Unsigned/local manifest is not production-admissible",
]) invariant(nativeEvidenceRuns.includes(command), `Native evidence gate is missing: ${command}`);
invariant(
  JSON.stringify(needsList(jobs["native-evidence-gates"])) === JSON.stringify(["native-source-gates"]),
  "Native evidence generation must follow all native source gates",
);
const allSteps = Object.values(jobs).flatMap((job) => Array.isArray(job?.steps) ? job.steps : []);
const runCommands = allSteps.map((step) => step?.run).filter((run) => typeof run === "string");
const executableWorkflow = runCommands.join("\n");
const countExecutable = (command) => runCommands.reduce((total, run) => total + run.split(command).length - 1, 0);
const generator = "node scripts/release-project-distributions.mjs";
const verifier = "node scripts/verify-release-distributions.mjs";
const releaseInputBuilder = "node scripts/build-release-inputs.mjs";
const envelopeBuilder = "node scripts/build-release-envelope.mjs";
invariant(!/(?:^|\s)node scripts\/project-distributions\.mjs(?:\s|$)/m.test(executableWorkflow), "Authoritative CI still invokes the legacy distribution generator");
invariant(!/(?:^|\s)node scripts\/verify-distribution-projections\.mjs(?:\s|$)/m.test(executableWorkflow), "Authoritative CI still invokes the legacy distribution verifier");
invariant(countExecutable(generator) === 1, "Authoritative CI must generate distributions exactly once");
invariant(countExecutable(verifier) === 3, "Candidate, admission, and handoff must each verify the distribution bundle");
invariant(countExecutable(releaseInputBuilder) === 1, "Authoritative CI must bind release inputs exactly once");
invariant(countExecutable(envelopeBuilder) === 1, "Authoritative CI must build one release envelope exactly once");
const candidateRuns = jobs.candidate.steps.map((step) => step?.run).filter((run) => typeof run === "string").join("\n");
const releaseInputsAt = candidateRuns.indexOf(releaseInputBuilder);
const envelopeAt = candidateRuns.indexOf(envelopeBuilder);
invariant(releaseInputsAt >= 0 && envelopeAt > releaseInputsAt, "Release inputs must be bound before the immutable envelope");
for (const argument of ["--release-inputs evidence/release-inputs.json", "--npm-version", "--runner"]) {
  invariant(candidateRuns.includes(argument), `Immutable envelope build is missing ${argument}`);
}
const generatedAt = candidateRuns.indexOf(generator);
const firstVerifiedAt = candidateRuns.indexOf(verifier);
const candidateVerifierStep = jobs.candidate.steps.findIndex((step) => typeof step?.run === "string" && step.run.includes(verifier));
const candidateUploadAt = jobs.candidate.steps.findIndex((step) =>
  typeof step?.uses === "string" && step.uses.startsWith("actions/upload-artifact@") && step.with?.name === "release-candidate"
);
invariant(generatedAt >= 0 && firstVerifiedAt > generatedAt, "Distribution verification must follow generation");
invariant(candidateVerifierStep >= 0 && candidateUploadAt > candidateVerifierStep, "Candidate upload must follow distribution verification");
for (const command of [
  "sh -n release-artifacts/distributions/curl/install.sh",
  "ruby -c release-artifacts/distributions/homebrew/cuna.rb",
  "bash -n release-artifacts/distributions/aur/PKGBUILD",
]) invariant(candidateRuns.includes(command), `Generated packaging syntax gate is missing: ${command}`);
invariant(!/npm\s+publish/.test(executableWorkflow), "Candidate CI may not publish npm packages");
invariant(candidateRuns.includes("--output release-artifacts/distributions"), "Distribution output is not inside the immutable candidate artifact");
invariant(runCommands.filter((run) => run.includes(verifier)).every((run) => run.includes("--distributions release-artifacts/distributions")), "Distribution verification does not bind the immutable candidate artifact");
for (const expression of [
  'p.ciMatrix.filter((entry)=>entry.claim!=="observation-only")',
  'p.ciMatrix.filter((entry)=>entry.claim==="observation-only")',
]) invariant(candidateRuns.includes(expression), "Support-matrix export must split required and observation-only lanes explicitly");
invariant(
  JSON.stringify(jobs["source-gates"].strategy?.matrix?.node) === JSON.stringify(supportPolicy.node?.tested),
  "Every declared tested Node line must execute the full source-quality suite",
);
invariant(jobs["source-gates"].steps.some((step) => step?.uses?.startsWith("actions/setup-node@") && step.with?.["node-version"] === "${{ matrix.node }}"), "Source gates must execute under each Node matrix entry");
const sourceInstallAt = jobs["source-gates"].steps.findIndex((step) => step?.run === "npm ci --ignore-scripts");
const sourceContractAt = jobs["source-gates"].steps.findIndex((step) => step?.run === "node scripts/verify-ci-contract.mjs");
invariant(sourceInstallAt >= 0 && sourceContractAt > sourceInstallAt, "CI contract dependencies must be installed before semantic workflow validation");
invariant(jobs["installed-artifact"].strategy?.matrix === "${{ fromJson(needs.candidate.outputs.required_matrix) }}", "Required installed-artifact job must consume only the release-admissible matrix");
invariant(jobs["observed-artifact"].strategy?.matrix === "${{ fromJson(needs.candidate.outputs.observation_matrix) }}", "Observation-only lanes require a separate non-authorizing job");
invariant(jobs["observed-artifact"]["continue-on-error"] === true, "Observation-only job must remain explicitly non-blocking");
invariant(jobs["observation-summary"].if === "always()", "Observation summary must run after both successful and failed observation attempts");
invariant(jobs["observation-summary"]["continue-on-error"] === true, "Observation summary must remain explicitly non-blocking");
invariant(JSON.stringify(needsList(jobs["observation-summary"]).sort()) === JSON.stringify(["candidate", "observed-artifact"]), "Observation summary must remain a lateral branch over candidate and observed-artifact");
invariant(
  jobs["observation-summary"].steps.some((step) => step?.run === "node scripts/summarize-observation-receipts.mjs"),
  "Observation summary must validate and summarize observation-only receipts",
);
invariant(JSON.stringify(needsList(jobs.admission).sort()) === JSON.stringify(["candidate", "installed-artifact"]), "Admission must not depend on the observation-only job");
invariant(JSON.stringify(needsList(jobs.handoff)) === JSON.stringify(["admission"]), "Handoff must depend exclusively on admission");
invariant(
  release.includes('[.status,.conclusion,.head_sha,.event,.head_branch,.path]') &&
    release.includes('completed success ${SOURCE_COMMIT} push main .github/workflows/ci.yml'),
  "Release dispatch must bind the selected run to protected-main CI by workflow path",
);
invariant(
  release.includes('--signer-workflow "${GITHUB_REPOSITORY}/.github/workflows/ci.yml"'),
  "Release attestation verification must bind the exact signer workflow",
);
const approvalSemanticAt = release.indexOf("node scripts/verify-release-approval-lease.mjs");
const approvalAttestationAt = release.indexOf('--signer-workflow "${GITHUB_REPOSITORY}/.github/workflows/release-review.yml"');
const approvalNonceConsumptionAt = release.indexOf("node scripts/consume-release-approval-nonce.mjs");
const npmPublishAt = release.indexOf("node scripts/publish-npm-preview.mjs");
invariant(
  release.includes("completed success ${SOURCE_COMMIT} workflow_dispatch main .github/workflows/release-review.yml"),
  "Release approval must bind the protected release-review workflow identity",
);
invariant(approvalSemanticAt >= 0, "Release publication DAG must semantically bind the approval lease");
invariant(approvalAttestationAt > approvalSemanticAt, "Release approval attestation must follow semantic lease verification");
invariant(
  approvalNonceConsumptionAt > approvalAttestationAt && npmPublishAt > approvalNonceConsumptionAt,
  "Publication must atomically consume the reviewed one-use nonce before npm publish",
);
invariant(
  approvalConsumptionAuthority.status === "CONFIGURED" &&
    approvalConsumptionAuthority.rulesetId === 20698394 &&
    approvalConsumptionAuthority.rulesetName === "Protect Cuna release approval consumptions" &&
    approvalConsumptionAuthority.requiredReviewer?.type === "User" &&
    approvalConsumptionAuthority.requiredReviewer?.id === 67605416 &&
    approvalConsumptionAuthority.requiredReviewer?.login === "superjava1" &&
    JSON.stringify(approvalConsumptionAuthority.requiredRules) === JSON.stringify(["deletion", "non_fast_forward", "update"]),
  "Configured release-approval authority must bind the exact externally observed ruleset and reviewer",
);
invariant(
  approvalConsumption.includes('method: "POST"') &&
    approvalConsumption.includes("Release approval nonce is already consumed") &&
    approvalConsumption.includes("current_user_can_bypass") &&
    approvalConsumption.includes("prevent_self_review") &&
    approvalConsumption.includes('"update"') &&
    approvalConsumption.split("await observeAuthority();").length - 1 >= 3 &&
    approvalConsumption.includes("git/tags/${tagObject.sha}"),
  "One-use release approval interface must reserve atomically, revalidate external controls, and read back exact annotated evidence",
);
const preflight = releaseWorkflow.jobs?.preflight;
invariant(preflight?.environment === "npm", "The nonce-writing preflight must be protected by the npm environment");
invariant(
  JSON.stringify(preflight.permissions) === JSON.stringify({ actions: "read", attestations: "read", contents: "write" }),
  "The nonce-writing preflight token must have only actions:read, attestations:read, and contents:write",
);
const reviewJob = releaseReviewWorkflow.jobs?.review;
invariant(reviewJob?.environment === "release-review-npm-preview", "Release review must preserve its separate protected environment identity");
invariant(
  JSON.stringify(reviewJob.permissions) === JSON.stringify({ actions: "read", contents: "read" }),
  "Blocked release review must retain a strictly read-only token",
);
const reviewRuns = (reviewJob.steps ?? []).map((step) => step?.run).filter((run) => typeof run === "string").join("\n");
invariant(
  reviewRuns.includes("completed success ${SOURCE_COMMIT} push main .github/workflows/ci.yml") &&
    reviewRuns.includes('gh attestation verify admitted/release-artifacts/*.tgz') &&
    reviewRuns.includes('--signer-workflow "${GITHUB_REPOSITORY}/.github/workflows/ci.yml"'),
  "Release review does not bind protected-main candidate and exact candidate provenance",
);
invariant(
  releaseReviewAuthority.status === "UNCONFIGURED_BLOCKING" &&
    releaseReviewAuthority.environment === "release-review-npm-preview" &&
    releaseReviewAuthority.requiredReviewer?.id === 312749809 &&
    releaseReviewAuthority.requiredReviewer?.login === "cunitacodeitor" &&
    releaseReviewAuthority.observedAdminBypass === true &&
    releaseReviewAuthority.requiredApprovalEvidence === "EXACT_APPROVER_ID_LOGIN_EVENT_AND_RUN_BINDING",
  "Release-review declaration must preserve its exact observed, separately blocked authority",
);
const reviewInputs = Object.keys(releaseReviewWorkflow.on?.workflow_dispatch?.inputs ?? {}).sort();
invariant(
  JSON.stringify(reviewInputs) === JSON.stringify(["candidate_envelope_sha256", "candidate_run_id", "candidate_sha256", "source_commit", "version"]),
  "Blocked release review may accept only candidate identity inputs",
);
for (const forbidden of [
  "build-release-approval-lease",
  "release-approval-expectation",
  "release-approval-lease",
  "approverIdentityClass",
  "contract_source_commit",
  "contract_sha256",
  "contract_approval_attestation_sha256",
  "receipt_cohort_sha256",
  "receipt_verification_sha256",
]) invariant(!releaseReview.includes(forbidden), `Blocked release review contains caller-supplied or apparent minting authority: ${forbidden}`);
for (const blocker of [
  "RELEASE_REVIEW_ENVIRONMENT_ADMIN_BYPASS_ENABLED",
  "ACTUAL_ENVIRONMENT_APPROVAL_EVENT_NOT_OBSERVABLE_BY_WORKFLOW_TOKEN",
  "CANONICAL_CONTRACT_AUTHORITY_ARTIFACT_NOT_AVAILABLE",
  "CANDIDATE_BOUND_OBSERVATION_COHORT_NOT_AVAILABLE",
  "CANDIDATE_RELEASE_CONTRACT_AUTHORITY_UNRESOLVED",
]) invariant(reviewRuns.includes(blocker), `Release review is missing fail-closed blocker: ${blocker}`);
invariant(
  reviewRuns.includes("inputs.contractSet?.releaseAuthority !== 'UNRESOLVED_BLOCKING'") &&
    reviewRuns.trimEnd().endsWith("exit 1"),
  "Release review must observe the unresolved candidate contract and terminate without minting",
);
const publishJob = releaseWorkflow.jobs?.["publish-preview"];
invariant(
  publishJob?.permissions?.actions === "read" && publishJob.permissions?.attestations === "read" &&
    publishJob.permissions?.contents === "read" && publishJob.permissions?.["id-token"] === "write",
  "Publish job permissions must support only evidence reads and short-lived npm OIDC",
);
const publishStepSequence = (publishJob.steps ?? []).map((step) => step?.uses ? `uses:${step.uses}` : `run:${step?.run ?? ""}`);
invariant(
  JSON.stringify(publishStepSequence) === JSON.stringify([
    "uses:actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
    "uses:actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
    "run:npm install --global npm@11.19.0",
    "uses:actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "run:node scripts/verify-release-envelope.mjs --root admitted/release-artifacts",
    "uses:actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "run:node scripts/publish-npm-preview.mjs",
    "run:node scripts/verify-postpublish.mjs --envelope admitted/release-artifacts/release-envelope.json --version \"$VERSION\" --tag preview --receipt admitted/evidence/npm-preview-receipt.json",
    "uses:actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  ]),
  "Publish job executable step sequence differs from the reviewed boundary",
);
const publishStep = (publishJob.steps ?? []).find((step) => step?.run === "node scripts/publish-npm-preview.mjs");
invariant(publishStep, "Publish job must invoke the reviewed npm publication orchestrator as one exact command");
invariant(
  (publishJob.steps ?? []).filter((step) => typeof step?.run === "string" && step.run.includes("publish-npm-preview.mjs")).length === 1,
  "Publish workflow must contain exactly one executable publication boundary",
);
invariant(
  publishStep.env?.APPROVAL_LEASE_SHA256 === "${{ inputs.approval_lease_sha256 }}" &&
    publishStep.env?.APPROVAL_EXPECTATION_SHA256 === "${{ inputs.approval_expectation_sha256 }}" &&
    publishStep.env?.RELEASE_SOURCE_COMMIT === "${{ inputs.source_commit }}" && publishStep.env?.VERSION === "${{ needs.preflight.outputs.version }}" &&
    publishStep.env?.GITHUB_TOKEN === "${{ github.token }}" && publishStep.env?.GH_TOKEN === "${{ github.token }}",
  "Fresh publication approval is not bound to exact dispatch digests, source, and read token",
);
invariant(
  !npmPreviewPublication.includes("shell: true") && !npmPreviewPublication.includes("exec(") &&
    npmPreviewPublication.includes("executeNpmPreviewPublication({") &&
    npmPreviewPublication.includes('execute("gh", [') && npmPreviewPublication.includes('execute("npm", [') &&
    npmPreviewPublication.includes("verifyReservedReleaseApprovalConsumption({") &&
    npmPreviewPublication.includes('"scripts/verify-registry-version-absent.mjs"'),
  "Npm publication entrypoint must use argv-only effects behind the reviewed fail-closed orchestrator",
);
for (const phase of ["verifyLease", "verifyAttestation", "verifyNonce", "verifyRegistryAbsent", "publish"]) {
  invariant(npmPreviewPublicationLibrary.includes(`await phases.${phase}()` ) || (phase === "publish" && npmPreviewPublicationLibrary.includes("return phases.publish()")), `Publication orchestrator is missing phase: ${phase}`);
}

// Every status check the branch ruleset requires must actually be emitted by a
// job, under exactly that name, in a workflow that runs on pull_request. A
// required check that nothing emits is never reported, so with no bypass actors
// the pull request waits forever -- the merge is blocked by a check that cannot
// arrive rather than by one that failed. That is invisible to lint, typecheck
// and the test suite, and it is how `source-quality-gates` came to be required
// while only `source-quality-node-${{ matrix.node }}` existed.
const checkContract = await readJson(path.join(root, ".github", "required-status-checks.json"));
invariant(
  Array.isArray(checkContract.requiredStatusChecks) && checkContract.requiredStatusChecks.length > 0,
  "Required status check contract is empty or malformed",
);
const workflowDirectory = path.join(root, ".github", "workflows");
const workflowFiles = (await readdir(workflowDirectory))
  .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
  .sort();
// A job name carrying a ${{ }} expression is expanded per matrix entry and can
// therefore never equal a fixed required-check name -- exactly the mistake this
// block exists to catch -- so such names are not counted as emitters.
const pullRequestCheckNames = new Map();
for (const file of workflowFiles) {
  const definition = parseYaml(await readFile(path.join(workflowDirectory, file), "utf8"), {
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) continue;
  const triggers = definition.on;
  const runsOnPullRequest = triggers === "pull_request" ||
    (Array.isArray(triggers) && triggers.includes("pull_request")) ||
    (triggers !== null && typeof triggers === "object" && !Array.isArray(triggers) &&
      Object.hasOwn(triggers, "pull_request"));
  if (!runsOnPullRequest) continue;
  for (const [jobId, job] of Object.entries(definition.jobs ?? {})) {
    if (!job || typeof job !== "object" || Array.isArray(job)) continue;
    const checkName = typeof job.name === "string" ? job.name : jobId;
    if (checkName.includes("${{")) continue;
    pullRequestCheckNames.set(checkName, [...(pullRequestCheckNames.get(checkName) ?? []), `${file}:${jobId}`]);
  }
}
for (const required of checkContract.requiredStatusChecks) {
  const emitters = pullRequestCheckNames.get(required) ?? [];
  invariant(
    emitters.length === 1,
    emitters.length === 0
      ? `Required status check "${required}" is emitted by no pull_request workflow job; every pull request would block forever waiting for it`
      : `Required status check "${required}" is emitted by ${emitters.length} jobs (${emitters.join(", ")}); the reported result would be ambiguous`,
  );
}
// The summary check must aggregate the matrix rather than pass independently of
// it: it has to observe the matrix result and it has to report even when the
// matrix fails, or it would report success while the gates were red.
const summary = jobs["source-quality-gates"];
invariant(summary && typeof summary === "object", "CI workflow job is missing: source-quality-gates");
invariant(summary.if === "always()", "The source-quality-gates summary must report even when a gate lane fails");
invariant(
  JSON.stringify(needsList(summary)) === JSON.stringify(["source-gates"]),
  "The source-quality-gates summary must aggregate exactly the source-gates matrix",
);
const summaryText = summary.steps
  .flatMap((step) => [step?.run, ...Object.values(step?.env ?? {})])
  .filter((value) => typeof value === "string")
  .join("\n");
invariant(
  summaryText.includes("needs.source-gates.result") && summaryText.includes('!= "success"'),
  "The source-quality-gates summary must fail on any source-gates result other than success",
);

process.stdout.write(`${JSON.stringify({ status: "verified", package: packageJson.name, version: packageJson.version })}\n`);
