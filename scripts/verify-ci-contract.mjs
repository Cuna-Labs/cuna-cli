import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { invariant, parseArgs, readJson } from "./lib/release-evidence.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const packageJson = await readJson(path.join(root, "package.json"));
const supportPolicy = await readJson(path.join(root, "packaging", "support-policy.json"));

invariant(packageJson.name === "@runa_laboratories/cli", "Unexpected package name");
invariant(packageJson.license === "Apache-2.0", "package.json license must be Apache-2.0");
invariant(packageJson.private !== true, "Release package is marked private");
invariant(packageJson.publishConfig?.registry === "https://registry.npmjs.org", "Registry is not canonical npm");
invariant(packageJson.publishConfig?.access === "public", "npm access must be public");
invariant(packageJson.bin?.runa && typeof packageJson.bin.runa === "string", "package.json must expose exactly the runa binary");
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
const workflow = parseYaml(ci, { prettyErrors: true, uniqueKeys: true });
invariant(workflow && typeof workflow === "object" && !Array.isArray(workflow), "CI workflow must parse as a YAML object");
const jobs = workflow.jobs;
invariant(jobs && typeof jobs === "object" && !Array.isArray(jobs), "CI workflow jobs are missing");
for (const job of ["public-controls", "source-gates", "candidate", "installed-artifact", "observed-artifact", "observation-summary", "admission", "handoff"]) {
  invariant(jobs[job] && typeof jobs[job] === "object", `CI workflow job is missing: ${job}`);
  invariant(Array.isArray(jobs[job].steps), `CI workflow job has no executable steps: ${job}`);
}
const allSteps = Object.values(jobs).flatMap((job) => Array.isArray(job?.steps) ? job.steps : []);
const runCommands = allSteps.map((step) => step?.run).filter((run) => typeof run === "string");
const executableWorkflow = runCommands.join("\n");
const countExecutable = (command) => runCommands.reduce((total, run) => total + run.split(command).length - 1, 0);
const needsList = (job) => Array.isArray(job.needs) ? job.needs : typeof job.needs === "string" ? [job.needs] : [];
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
  "ruby -c release-artifacts/distributions/homebrew/runa.rb",
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

process.stdout.write(`${JSON.stringify({ status: "verified", package: packageJson.name, version: packageJson.version })}\n`);
