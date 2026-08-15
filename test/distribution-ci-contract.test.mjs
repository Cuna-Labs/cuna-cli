import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { TestResourceLedger } from "./support/test-resource-ledger.mjs";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const resources = new TestResourceLedger();
test.after(() => resources.cleanup());

async function fixture() {
  const root = await resources.createTempDirectory("cuna-ci-contract-");
  await mkdir(path.join(root, "packaging"), { recursive: true });
  await mkdir(path.join(root, "scripts", "lib"), { recursive: true });
  await cp(path.join(repositoryRoot, "package.json"), path.join(root, "package.json"));
  await cp(path.join(repositoryRoot, "package-lock.json"), path.join(root, "package-lock.json"));
  await cp(path.join(repositoryRoot, "packaging", "support-policy.json"), path.join(root, "packaging", "support-policy.json"));
  await cp(path.join(repositoryRoot, "packaging", "release-approval-consumption-authority.json"), path.join(root, "packaging", "release-approval-consumption-authority.json"));
  await cp(path.join(repositoryRoot, "packaging", "release-review-authority.json"), path.join(root, "packaging", "release-review-authority.json"));
  await cp(path.join(repositoryRoot, "scripts", "lib", "release-approval-consumption.mjs"), path.join(root, "scripts", "lib", "release-approval-consumption.mjs"));
  await cp(path.join(repositoryRoot, "scripts", "lib", "npm-preview-publication.mjs"), path.join(root, "scripts", "lib", "npm-preview-publication.mjs"));
  await cp(path.join(repositoryRoot, "scripts", "publish-npm-preview.mjs"), path.join(root, "scripts", "publish-npm-preview.mjs"));
  // The whole of `.github`, not a hand-listed pair of workflows: the required
  // status checks are spread across ci.yml and dependency-review.yml, so a
  // fixture that copies only some workflows cannot tell "this check has no
  // emitter" from "this fixture omitted the emitter".
  await cp(path.join(repositoryRoot, ".github"), path.join(root, ".github"), { recursive: true });
  return root;
}

function verify(root) {
  return execute(process.execPath, ["scripts/verify-ci-contract.mjs", "--root", root], {
    cwd: repositoryRoot,
    maxBuffer: 4 * 1024 * 1024,
  });
}

test("authoritative CI generates once and verifies the distribution bundle at every custody boundary", async () => {
  const result = JSON.parse((await verify(await fixture())).stdout);
  assert.equal(result.status, "verified");
});

test("CI contract rejects resurrection of the legacy generator", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "ci.yml");
  const content = (await readFile(workflow, "utf8"))
    .replace("node scripts/release-project-distributions.mjs", "node scripts/project-distributions.mjs");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /legacy distribution generator/);
});

test("CI contract rejects a missing admission or handoff distribution verification", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "ci.yml");
  const content = await readFile(workflow, "utf8");
  const verifier = "node scripts/verify-release-distributions.mjs";
  const last = content.lastIndexOf(verifier);
  await writeFile(workflow, `${content.slice(0, last)}node scripts/verify-release-envelope.mjs${content.slice(last + verifier.length)}`);
  await assert.rejects(verify(root), /Candidate, admission, and handoff/);
});

test("CI contract rejects publication authority inside candidate CI", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "ci.yml");
  const content = (await readFile(workflow, "utf8"))
    .replace("      - run: npm run build\n", "      - run: npm run build\n      - run: npm publish\n");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /may not publish npm packages/);
});

test("CI contract rejects a candidate envelope not bound to release inputs", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "ci.yml");
  const content = (await readFile(workflow, "utf8"))
    .replace("--release-inputs evidence/release-inputs.json", "--support-policy packaging/support-policy.json");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /missing --release-inputs/);
});

test("CI contract rejects duplicate release-input generation", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "ci.yml");
  const content = (await readFile(workflow, "utf8"))
    .replace("      - run: npm run build\n", "      - run: npm run build\n      - run: node scripts/build-release-inputs.mjs\n");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /release inputs exactly once/);
});

test("CI contract rejects an observation-only job in the admission dependency path", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "ci.yml");
  const content = (await readFile(workflow, "utf8"))
    .replace("needs: [candidate, installed-artifact]", "needs: [candidate, installed-artifact, observed-artifact]");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /Admission must not depend on the observation-only job/);
});

test("CI contract rejects an observation-only job that is not explicitly non-blocking", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "ci.yml");
  const content = (await readFile(workflow, "utf8")).replace("    continue-on-error: true\n", "");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /Observation-only job must remain explicitly non-blocking/);
});

test("CI contract rejects a shell-split support-matrix export", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "ci.yml");
  const content = (await readFile(workflow, "utf8"))
    .replace('p.ciMatrix.filter((entry)=>entry.claim!=="observation-only")', "p.ciMatrix");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /Support-matrix export must split/);
});

test("CI contract ignores comments that impersonate a missing executable verifier", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "ci.yml");
  const original = await readFile(workflow, "utf8");
  const verifier = "node scripts/verify-release-distributions.mjs";
  const last = original.lastIndexOf(verifier);
  const content = `${original.slice(0, last)}node scripts/verify-release-envelope.mjs${original.slice(last + verifier.length)}\n# ${verifier}\n`;
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /Candidate, admission, and handoff/);
});

test("CI contract rejects a declared Node line omitted from the full behavioral suite", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "ci.yml");
  const content = (await readFile(workflow, "utf8"))
    .replace("node: [22.17.1, 24.4.1]", "node: [22.17.1]");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /Every declared tested Node line/);
});

test("CI contract rejects candidate generation that waits on experimental native gates", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "ci.yml");
  const original = await readFile(workflow, "utf8");
  const content = original.replace(
    "  candidate:\n    name: immutable-candidate\n    needs: source-gates",
    "  candidate:\n    name: immutable-candidate\n    needs: [source-gates, native-source-gates]",
  );
  assert.notEqual(content, original, "negative control must mutate the candidate dependency edge");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /Candidate generation must depend only on the product source gate/);
});

test("CI contract rejects an observation summary that can block the release DAG", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "ci.yml");
  const content = (await readFile(workflow, "utf8"))
    .replace(
      "  observation-summary:\n    name: non-authorizing-observation-summary\n    if: always()\n    needs: [candidate, observed-artifact]\n    continue-on-error: true",
      "  observation-summary:\n    name: non-authorizing-observation-summary\n    if: success()\n    needs: [candidate, observed-artifact]\n    continue-on-error: false",
    );
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /Observation summary must run after both successful and failed observation attempts/);
});

test("CI contract rejects observation summary authority in admission", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "ci.yml");
  const content = (await readFile(workflow, "utf8"))
    .replace("needs: [candidate, installed-artifact]", "needs: [candidate, installed-artifact, observation-summary]");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /Admission must not depend on the observation-only job/);
});

test("CI contract rejects semantic validation before its locked dependencies are installed", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "ci.yml");
  const content = (await readFile(workflow, "utf8"))
    .replace(
      "      - run: npm ci --ignore-scripts\n      - run: node scripts/verify-ci-contract.mjs",
      "      - run: node scripts/verify-ci-contract.mjs\n      - run: npm ci --ignore-scripts",
    );
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /dependencies must be installed before semantic workflow validation/);
});

test("CI contract rejects a release dispatch bound only to commit and event", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "release.yml");
  const content = (await readFile(workflow, "utf8"))
    .replace(",.head_branch,.path", "")
    .replace(" push main .github/workflows/ci.yml", " push");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /bind the selected run to protected-main CI/u);
});

test("CI contract rejects repository-only attestation verification", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "release.yml");
  const content = (await readFile(workflow, "utf8"))
    .replace('\n          --signer-workflow "${GITHUB_REPOSITORY}/.github/workflows/ci.yml"', "");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /bind the exact signer workflow/u);
});

test("CI contract rejects an unsigned or semantically unbound release approval lease", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "release.yml");
  const content = (await readFile(workflow, "utf8"))
    .replace("node scripts/verify-release-approval-lease.mjs", "node scripts/verify-release-envelope.mjs")
    .replace('--signer-workflow "${GITHUB_REPOSITORY}/.github/workflows/release-review.yml"', "--repo-only");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /semantically bind the approval lease|atomically consume the reviewed one-use nonce/u);
});

test("CI contract rejects removal of the one-use nonce consumption boundary", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "release.yml");
  const content = (await readFile(workflow, "utf8"))
    .replace("node scripts/consume-release-approval-nonce.mjs", "node scripts/verify-release-approval-lease.mjs");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /atomically consume the reviewed one-use nonce/u);
});

test("CI contract rejects a nonce consumer with broader or unprotected write authority", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "release.yml");
  const content = (await readFile(workflow, "utf8"))
    .replace("    environment: npm\n    permissions:\n      actions: read\n      attestations: read\n      contents: write", "    permissions:\n      actions: write\n      contents: write");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /nonce-writing preflight/u);
});

test("CI contract rejects substituted external ruleset identity", async () => {
  const root = await fixture();
  const authority = path.join(root, "packaging", "release-approval-consumption-authority.json");
  const value = JSON.parse(await readFile(authority, "utf8"));
  value.rulesetId += 1;
  await writeFile(authority, `${JSON.stringify(value, null, 2)}\n`);
  await assert.rejects(verify(root), /exact externally observed ruleset and reviewer/u);
});

test("CI contract rejects a consumption ruleset declaration that permits ordinary updates", async () => {
  const root = await fixture();
  const authority = path.join(root, "packaging", "release-approval-consumption-authority.json");
  const value = JSON.parse(await readFile(authority, "utf8"));
  value.requiredRules = value.requiredRules.filter((rule) => rule !== "update");
  await writeFile(authority, `${JSON.stringify(value, null, 2)}\n`);
  await assert.rejects(verify(root), /exact externally observed ruleset and reviewer/u);
});

test("CI contract rejects removal of external authority revalidation", async () => {
  const root = await fixture();
  const consumer = path.join(root, "scripts", "lib", "release-approval-consumption.mjs");
  const content = await readFile(consumer, "utf8");
  const last = content.lastIndexOf("  await observeAuthority();");
  await writeFile(consumer, `${content.slice(0, last)}${content.slice(last + "  await observeAuthority();".length)}`);
  await assert.rejects(verify(root), /revalidate external controls/u);
});

test("CI contract rejects conflation of release review with the publication environment", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "release-review.yml");
  const content = (await readFile(workflow, "utf8")).replace("    environment: release-review-npm-preview\n", "    environment: npm\n");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /preserve its separate protected environment/u);
});

test("CI contract rejects caller-supplied contract authority in blocked review", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "release-review.yml");
  const content = (await readFile(workflow, "utf8")).replace(
    "      candidate_run_id:\n",
    "      contract_sha256:\n        description: Caller claim\n        required: true\n        type: string\n      candidate_run_id:\n",
  );
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /only candidate identity inputs|caller-supplied/u);
});

test("CI contract rejects apparent lease minting without exact approval-event authority", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "release-review.yml");
  const content = (await readFile(workflow, "utf8")).replace(
    "      - name: Block lease minting until independent authorities exist",
    "      - run: node scripts/build-release-approval-lease.mjs\n      - name: Block lease minting until independent authorities exist",
  );
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /apparent minting authority/u);
});

test("CI contract rejects omission of unresolved contract and semantic observation blockers", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "release-review.yml");
  const content = (await readFile(workflow, "utf8"))
    .replace("CANDIDATE_BOUND_OBSERVATION_COHORT_NOT_AVAILABLE", "observation hashes supplied")
    .replace("CANDIDATE_RELEASE_CONTRACT_AUTHORITY_UNRESOLVED", "contract supplied");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /missing fail-closed blocker/u);
});

test("CI contract rejects fabricated approver class without an exact approval event", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "release-review.yml");
  const content = `${await readFile(workflow, "utf8")}\n# approverIdentityClass: PROTECTED_ENVIRONMENT_REVIEWER\n`;
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /apparent minting authority/u);
});

test("CI contract rejects publication without fresh nonce and lease validation in the npm publish step", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "release.yml");
  const content = (await readFile(workflow, "utf8")).replace(
    "run: node scripts/publish-npm-preview.mjs",
    "run: true || node scripts/publish-npm-preview.mjs",
  );
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /executable step sequence differs/u);
});

test("CI contract rejects a commented-out publication orchestrator", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "release.yml");
  const content = (await readFile(workflow, "utf8")).replace(
    "run: node scripts/publish-npm-preview.mjs",
    "run: '# node scripts/publish-npm-preview.mjs'",
  );
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /executable step sequence differs/u);
});

test("CI contract rejects a second publication effect outside the reviewed orchestrator", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "release.yml");
  const content = (await readFile(workflow, "utf8")).replace(
    "      - name: Revalidate fresh approval and publish exact admitted bytes",
    "      - run: npm publish admitted/release-artifacts/substituted.tgz --provenance --access public --registry https://registry.npmjs.org/ --tag preview\n      - name: Revalidate fresh approval and publish exact admitted bytes",
  );
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /executable step sequence differs/u);
});

/**
 * The branch ruleset requires five status checks and nothing in the tree could
 * read that list, so `source-quality-gates` was required while only the matrix
 * name `source-quality-node-${{ matrix.node }}` existed. A required check that
 * is never reported does not fail a pull request -- it never arrives -- so with
 * no bypass actors every pull request blocked forever, invisibly to lint,
 * typecheck and this suite.
 */
test("CI contract rejects a required status check that no job emits", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "ci.yml");
  const content = (await readFile(workflow, "utf8"))
    .replace("    name: source-quality-gates\n", "    name: source-quality-node-summary\n");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /"source-quality-gates" is emitted by no pull_request workflow job/);
});

test("CI contract rejects a required check emitted only by a matrix-expanded name", async () => {
  const root = await fixture();
  const contract = path.join(root, ".github", "required-status-checks.json");
  const parsed = JSON.parse(await readFile(contract, "utf8"));
  // `native-source-${{ matrix.id }}` can never equal a fixed check name.
  parsed.requiredStatusChecks = [...parsed.requiredStatusChecks, "native-source-linux-x64"];
  await writeFile(contract, JSON.stringify(parsed, null, 2));
  await assert.rejects(verify(root), /"native-source-linux-x64" is emitted by no pull_request workflow job/);
});

test("CI contract rejects a required check whose workflow never runs on a pull request", async () => {
  const root = await fixture();
  const contract = path.join(root, ".github", "required-status-checks.json");
  const parsed = JSON.parse(await readFile(contract, "utf8"));
  // distribution-projection-proof.yml is workflow_dispatch only, so this job
  // reports on no pull request and a ruleset requiring it would never be
  // satisfied. (codeql.yml is NOT such a case -- it does declare pull_request.)
  parsed.requiredStatusChecks = [...parsed.requiredStatusChecks, "deterministic-projections-not-publication"];
  await writeFile(contract, JSON.stringify(parsed, null, 2));
  await assert.rejects(
    verify(root),
    /"deterministic-projections-not-publication" is emitted by no pull_request workflow job/,
  );
});

test("CI contract rejects a summary gate that cannot observe a failed matrix", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "ci.yml");
  const content = (await readFile(workflow, "utf8"))
    .replace("    name: source-quality-gates\n    if: always()\n", "    name: source-quality-gates\n    if: success()\n");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /must report even when a gate lane fails/);
});
