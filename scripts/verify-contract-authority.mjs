import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { validateContractAuthority } from "./lib/release-approval-lease.mjs";
import { invariant, parseArgs, strictHex } from "./lib/release-evidence.mjs";

// The CLI vendors the Cuna public API contract. Vendored bytes prove only what
// this repository chose to copy; they do not prove the producer approved that
// shape for release. `packaging/contract-authority.json` is the artifact that
// carries the producer's approval, and this script refuses unless it exists AND
// the producer repository actually confirms it.
//
// Every destination below is built from fixed strings plus digests the
// declaration supplies under a strict pattern, so a modified declaration can
// point this read-only token at a different commit but never at a different
// host or an arbitrary path.

const BLOCKER = "CANONICAL_CONTRACT_AUTHORITY_ARTIFACT_NOT_AVAILABLE";
const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const authorityFile = path.join(root, "packaging", "contract-authority.json");
const canonicalDigestFile = path.join(root, "contracts", "infra", "cuna-api.openapi.sha256");

const token = process.env.GITHUB_TOKEN;
invariant(typeof token === "string" && token.length >= 20 && !/\s/u.test(token), "A read-only GitHub token is required");

let declarationText;
try {
  declarationText = await readFile(authorityFile, "utf8");
} catch (error) {
  if (error?.code === "ENOENT") {
    throw new Error(`${BLOCKER}: packaging/contract-authority.json does not exist, so no producer has approved this contract for release`);
  }
  throw error;
}
const declaration = validateContractAuthority(JSON.parse(declarationText));
// The declaration is repository content. `validateContractAuthority` proves the
// shape; these rebuild the two values that reach the network out of a local
// alphabet, so the request path cannot carry anything the file chose.
const sourceCommit = strictHex(declaration.sourceCommit, 40, "Contract source commit");
const contractSha256 = strictHex(declaration.contractSha256, 64, "Contract digest");

// The approval must describe the contract this candidate actually ships, not
// some other revision of it.
const canonicalDeclaration = (await readFile(canonicalDigestFile, "utf8")).trim().split(/\s+/u);
invariant(canonicalDeclaration.length === 2, "Vendored canonical digest declaration is malformed");
invariant(
  contractSha256 === canonicalDeclaration[0],
  `${BLOCKER}: the approved contract digest is not the digest this candidate vendors`,
);

async function producerRead(url, label) {
  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "cuna-cli-contract-authority-verifier",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });
  invariant(
    response.status === 200,
    `${BLOCKER}: ${label} returned HTTP ${response.status} for ${PRODUCER_PATH}; the workflow token cannot confirm the producer's approval`,
  );
  const text = await response.text();
  invariant(Buffer.byteLength(text) <= 4_194_304, `${label} response is too large`);
  return JSON.parse(text);
}

// `validateContractAuthority` already pins producerRepository to one literal, so
// the host and the owner/name segments are constants in this file rather than
// anything the declaration can choose.
const PRODUCER_PATH = "Cuna-Labs/infra";
invariant(declaration.producerRepository === PRODUCER_PATH, "Contract producer repository identity is malformed");

const commit = await producerRead(
  `https://api.github.com/repos/${PRODUCER_PATH}/commits/${sourceCommit}`,
  "producer commit lookup",
);
invariant(commit.sha === sourceCommit, `${BLOCKER}: the producer returned a different commit than the one declared`);

// The approval attestation path is a convention fixed here rather than a field
// the declaration supplies, so an edited declaration cannot nominate an
// arbitrary file in the producer repository as its own approval.
const approvalPath = `contracts/approval/cuna-api.openapi.${contractSha256}.approval.json`;
const approval = await producerRead(
  `https://api.github.com/repos/${PRODUCER_PATH}/contents/${approvalPath}?ref=${sourceCommit}`,
  "producer approval attestation lookup",
);
invariant(approval.type === "file" && approval.encoding === "base64" && typeof approval.content === "string", `${BLOCKER}: the producer approval attestation is not a readable file`);
const approvalBytes = Buffer.from(approval.content, "base64");
const approvalSha256 = createHash("sha256").update(approvalBytes).digest("hex");
invariant(
  approvalSha256 === declaration.approvalAttestationSha256,
  `${BLOCKER}: the producer approval attestation digest differs from the declared one`,
);

process.stdout.write(`${JSON.stringify({
  status: "CANONICAL_CONTRACT_AUTHORITY_VERIFIED",
  authority: declaration.authority,
  producerRepository: declaration.producerRepository,
  sourceCommit: declaration.sourceCommit,
  contractSha256: declaration.contractSha256,
  approvalAttestationSha256: declaration.approvalAttestationSha256,
})}\n`);
