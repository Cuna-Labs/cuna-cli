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
  const root = await resources.createTempDirectory("runa-ci-contract-");
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await cp(path.join(repositoryRoot, "package.json"), path.join(root, "package.json"));
  await cp(path.join(repositoryRoot, "package-lock.json"), path.join(root, "package-lock.json"));
  await cp(path.join(repositoryRoot, ".github", "workflows", "ci.yml"), path.join(root, ".github", "workflows", "ci.yml"));
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
  await writeFile(workflow, `${await readFile(workflow, "utf8")}\n# forbidden negative control\n# npm publish\n`);
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
  await writeFile(workflow, `${await readFile(workflow, "utf8")}\n# node scripts/build-release-inputs.mjs\n`);
  await assert.rejects(verify(root), /release inputs exactly once/);
});
