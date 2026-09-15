import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { TestResourceLedger } from "./support/test-resource-ledger.mjs";

// `scripts/verify-contract-authority.mjs` is the only step in the release
// review that can observe whether the contract producer approved the bytes this
// candidate vendors, and as of this commit no such approval exists to observe.
// That makes its refusal the release outcome rather than a transient state, so
// the refusal itself needs tests: a later change that made the script succeed
// on absent or mismatched evidence would publish an unapproved contract and
// nothing else in the pipeline would notice.
//
// Every case here reaches its verdict before the first network read, so the
// suite runs offline and its failures cannot be blamed on GitHub.

const execute = promisify(execFile);
const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const resources = new TestResourceLedger();
// A non-secret literal: these cases must refuse before the value is ever sent.
const OFFLINE_TOKEN = "not-a-credential-0000000000";
const BLOCKER = "CANONICAL_CONTRACT_AUTHORITY_ARTIFACT_NOT_AVAILABLE";

test.after(() => resources.cleanup());

async function fixture({ declaration } = {}) {
  const root = await resources.createTempDirectory("cuna-contract-authority-");
  await mkdir(path.join(root, "packaging"), { recursive: true });
  await mkdir(path.join(root, "contracts", "infra"), { recursive: true });
  await cp(
    path.join(repositoryRoot, "contracts", "infra", "cuna-api.openapi.sha256"),
    path.join(root, "contracts", "infra", "cuna-api.openapi.sha256"),
  );
  if (declaration !== undefined) {
    await writeFile(path.join(root, "packaging", "contract-authority.json"), `${JSON.stringify(declaration, null, 2)}\n`, "utf8");
  }
  return root;
}

async function refusal(root, environment = { GITHUB_TOKEN: OFFLINE_TOKEN }) {
  const failure = await execute(process.execPath, ["scripts/verify-contract-authority.mjs", "--root", root], {
    cwd: repositoryRoot,
    env: { ...process.env, GITHUB_TOKEN: "", ...environment },
  }).then(
    (result) => new Error(`The verifier approved the candidate instead of refusing it: ${result.stdout}`),
    (error) => error,
  );
  assert.notEqual(failure.code, 0, "the verifier must exit nonzero when it cannot confirm the producer's approval");
  return failure.stderr;
}

function approvedDeclaration(overrides = {}) {
  return {
    schemaVersion: 1,
    authority: "CUNA_CANONICAL_PUBLIC_API_CONTRACT",
    status: "APPROVED",
    producerRepository: "Cuna-Labs/infra",
    sourceCommit: "7b1b3e425ed273986a909a68395b5272bd6a01ba",
    contractSha256: "43213c2adac602676437b612b7d4153707e09155bdc4fa3029cca15a0b207ecc",
    approvalAttestationSha256: "0".repeat(64),
    ...overrides,
  };
}

test("an absent approval artifact refuses under the release blocker instead of defaulting to approved", async () => {
  const stderr = await refusal(await fixture());
  assert.match(stderr, new RegExp(BLOCKER));
  assert.match(stderr, /packaging\/contract-authority\.json does not exist/);
});

test("an approval for another revision of the contract cannot approve the bytes this candidate vendors", async () => {
  // The only varied field is the digest; everything else is the declaration the
  // producer would have to sign, so a pass here would mean the check reads the
  // shape and not the subject.
  const stderr = await refusal(await fixture({ declaration: approvedDeclaration({ contractSha256: "a".repeat(64) }) }));
  assert.match(stderr, new RegExp(BLOCKER));
  assert.match(stderr, /the approved contract digest is not the digest this candidate vendors/);
});

test("a declaration that renames its own producer cannot redirect the approval lookup", async () => {
  const stderr = await refusal(await fixture({ declaration: approvedDeclaration({ producerRepository: "Cuna-Labs/infra-proxy-mvp" }) }));
  assert.match(stderr, /Contract producer repository is invalid/);
});

test("a missing token is an unobserved approval, not an approved contract", async () => {
  const stderr = await refusal(await fixture({ declaration: approvedDeclaration() }), { GITHUB_TOKEN: "" });
  assert.match(stderr, /A read-only GitHub token is required/);
});
