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
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await mkdir(path.join(root, "packaging"), { recursive: true });
  await cp(path.join(repositoryRoot, "package.json"), path.join(root, "package.json"));
  await cp(path.join(repositoryRoot, "package-lock.json"), path.join(root, "package-lock.json"));
  await cp(path.join(repositoryRoot, "packaging", "support-policy.json"), path.join(root, "packaging", "support-policy.json"));
  await cp(path.join(repositoryRoot, ".github", "workflows", "ci.yml"), path.join(root, ".github", "workflows", "ci.yml"));
  await cp(path.join(repositoryRoot, ".github", "workflows", "release.yml"), path.join(root, ".github", "workflows", "release.yml"));
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

test("CI contract rejects candidate generation that bypasses every mandatory native gate", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "ci.yml");
  const original = await readFile(workflow, "utf8");
  const content = original.replace(
    "needs: [source-gates, native-source-gates, native-evidence-gates]",
    "needs: source-gates",
  );
  assert.notEqual(content, original, "negative control must mutate the candidate dependency edge");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /Node, native source, and native evidence gates/);
});

test("CI contract rejects candidate generation that bypasses native admission evidence", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "ci.yml");
  const original = await readFile(workflow, "utf8");
  const content = original.replace(
    "needs: [source-gates, native-source-gates, native-evidence-gates]",
    "needs: [source-gates, native-source-gates]",
  );
  assert.notEqual(content, original, "negative control must remove only native evidence authority");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /Node, native source, and native evidence gates/);
});

test("CI contract rejects an incomplete native quality gate", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "ci.yml");
  const content = (await readFile(workflow, "utf8"))
    .replace(
      "cargo +1.97.1 clippy --workspace --all-targets --locked -- -D warnings",
      "cargo +1.97.1 check --workspace --locked",
    );
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /Native source gate is missing/);
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
  await assert.rejects(verify(root), /semantically bind the approval lease/u);
});

test("CI contract rejects removal of the one-use nonce publication fence", async () => {
  const root = await fixture();
  const workflow = path.join(root, ".github", "workflows", "release.yml");
  const content = (await readFile(workflow, "utf8"))
    .replace("RELEASE_APPROVAL_NONCE_CONSUMPTION_AUTHORITY_NOT_CONFIGURED", "release approval reviewed");
  await writeFile(workflow, content);
  await assert.rejects(verify(root), /remain fail-closed before npm publish/u);
});
