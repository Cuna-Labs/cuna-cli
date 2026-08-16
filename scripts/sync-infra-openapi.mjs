import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { writeInfraContractWitness } from "./lib/infra-contract-witness.mjs";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetArtifact = path.join(root, "contracts", "infra", "cuna-api.openapi.json");
const targetDigest = path.join(root, "contracts", "infra", "cuna-api.openapi.sha256");
const targetIdentity = path.join(root, "contracts", "infra", "cuna-api.openapi.identity.json");
const producerRepository = "Cuna-Labs/infra";
const expectedSourceName = "runa-api.openapi.json";
const sha256 = /^[0-9a-f]{64}$/u;

function fail(message) {
  throw new Error(`infra OpenAPI synchronization refused: ${message}`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactObject(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} keys differ`);
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactEnum(value, expected) {
  return Array.isArray(value) && value.length === expected.length && expected.every((item) => value.includes(item));
}

function strictHumanAuthContract(contract) {
  const paths = contract?.paths;
  const components = contract?.components;
  const schemas = components?.schemas;
  const parameters = components?.parameters;
  const cliIntents = [
    "signup", "login", "account.read", "machines.read", "machines.create",
    "agent_sessions.read", "agent_sessions.create",
  ];
  if (paths === null || typeof paths !== "object" || schemas === null || typeof schemas !== "object") {
    fail("producer document has no OpenAPI path/schema authority");
  }
  for (const retired of [
    "/v1/cli-auth/refresh",
    "/v1/cli-auth/continuations/{id}",
    "/v1/cli-auth/continuations/{id}/cancel",
  ]) {
    if (Object.hasOwn(paths, retired)) fail(`retired continuation route remains: ${retired}`);
  }
  for (const retired of ["CliContinuationSecret", "CliContinuationStatus", "CliRefreshRequest", "CliRefreshResult", "CliTokenSet"]) {
    if (Object.hasOwn(schemas, retired) || Object.hasOwn(parameters ?? {}, retired)) {
      fail(`retired continuation schema or parameter remains: ${retired}`);
    }
  }
  const issued = schemas.CliContinuationIssued;
  if (
    issued?.additionalProperties !== false ||
    JSON.stringify(issued?.required) !== JSON.stringify(["id", "browser_url", "expires_at", "completion_mode"]) ||
    JSON.stringify(Object.keys(issued?.properties ?? {})) !==
      JSON.stringify(["id", "browser_url", "expires_at", "completion_mode"]) ||
    issued?.properties?.completion_mode?.const !== "paste_login_code" ||
    issued?.properties?.browser_url?.pattern !== "^https://[^/?#@]+/cli/continue#[^?#]+$"
  ) {
    fail("CliContinuationIssued is not the strict paste-code DTO");
  }
  const created = schemas.CliContinuationCreate;
  const completed = schemas.CliContinuationCompleted;
  const completedRequest = completed?.properties?.request_context;
  if (
    created?.additionalProperties !== false ||
    !hasExactEnum(created?.properties?.intent_class?.enum, cliIntents) ||
    completed?.additionalProperties !== false ||
    completed?.properties?.phase?.const !== "completed" ||
    completedRequest?.additionalProperties !== false ||
    !hasExactEnum(completedRequest?.required, ["client_instance_id", "client_name", "intent", "scopes"]) ||
    !hasExactEnum(completedRequest?.properties?.intent?.enum, cliIntents) ||
    completedRequest?.properties?.client_name?.const !== "Cuna CLI" ||
    JSON.stringify(completedRequest?.properties?.scopes?.const) !== JSON.stringify(["cli:session"])
  ) {
    fail("Cli continuation intent authority is incomplete or mismatched");
  }
  const bootstrap = schemas.CliAuthBootstrap;
  if (
    bootstrap?.additionalProperties !== false ||
    JSON.stringify(bootstrap?.required) !== JSON.stringify([
      "enabled", "completion_mode", "pkce_method", "continuation_ttl_seconds", "access_token_ttl_seconds", "browser_origin",
    ]) ||
    JSON.stringify(Object.keys(bootstrap?.properties ?? {})) !== JSON.stringify([
      "enabled", "completion_mode", "pkce_method", "continuation_ttl_seconds", "access_token_ttl_seconds", "browser_origin",
    ]) ||
    bootstrap?.properties?.completion_mode?.const !== "paste_login_code" ||
    bootstrap?.properties?.pkce_method?.const !== "S256" ||
    bootstrap?.properties?.continuation_ttl_seconds?.const !== 600 ||
    bootstrap?.properties?.access_token_ttl_seconds?.const !== 600
  ) {
    fail("CliAuthBootstrap is not the strict paste-code bootstrap DTO");
  }
  const exchange = schemas.CliLoginCodeExchangeResult;
  if (
    exchange?.additionalProperties !== false ||
    JSON.stringify(exchange?.required) !== JSON.stringify([
      "access_token", "token_type", "expires_in", "access_expires_at", "login_code_expires_at", "session_id", "context",
    ]) ||
    JSON.stringify(Object.keys(exchange?.properties ?? {})) !== JSON.stringify([
      "access_token", "token_type", "expires_in", "access_expires_at", "login_code_expires_at", "session_id", "context",
    ]) ||
    exchange?.properties?.token_type?.const !== "Bearer" ||
    exchange?.properties?.expires_in?.const !== 600
  ) {
    fail("CliLoginCodeExchangeResult is not the strict durable-login-code DTO");
  }
  const callbackPattern = "^cuna_cb_[A-Za-z0-9_-]{43}$";
  const complete = schemas.CliContinuationComplete;
  const browserCancel = schemas.CliContinuationBrowserCancel;
  if (
    complete?.properties?.browser_nonce?.pattern !== callbackPattern ||
    JSON.stringify(complete?.required) !== JSON.stringify(["browser_nonce", "state", "accepted_terms_version"]) ||
    browserCancel?.properties?.browser_nonce?.pattern !== callbackPattern ||
    JSON.stringify(browserCancel?.required) !== JSON.stringify(["browser_nonce", "state"])
  ) {
    fail("browser callback proof is not cuna_cb_-bound");
  }
  const browserCancelOperation = paths["/v1/cli-auth/continuations/{id}/browser-cancel"]?.post;
  if (
    JSON.stringify(browserCancelOperation?.security) !== JSON.stringify([{ SupabaseJwt: [] }]) ||
    browserCancelOperation?.requestBody?.content?.["application/json; charset=utf-8"]?.schema?.$ref !==
      "#/components/schemas/CliContinuationBrowserCancel"
  ) {
    fail("browser cancel is not separately JWT-bound");
  }
  const serialized = JSON.stringify(contract);
  for (const forbidden of [
    "continuation_secret", "poll_after_ms", "poll_limit", "refresh_token", "refresh_family_ttl_seconds",
    "cuna_rt_", "runa_ct_", "runa_cb_", "runa_at_", "runa_rt_",
  ]) {
    if (serialized.includes(forbidden)) fail(`retired human-auth field remains: ${forbidden}`);
  }
}

/**
 * The OpenCode gate is permitted to turn on only for this exact strict
 * producer contract.  Checking the artifact digest alone is insufficient:
 * a mutable producer checkout could make a consumer appear enabled without
 * an immutable producer tree to which the contract can be attributed.
 */
function strictOpenCodeContract(contract) {
  const schemas = contract?.components?.schemas;
  if (!isRecord(schemas)) fail("producer document has no OpenCode schema authority");
  const sessionCreate = schemas.AgentSessionCreate;
  const session = schemas.AgentSession;
  const sessionAuth = schemas.AgentSessionAuth;
  const machineAuth = schemas.AgentAuth;
  if (![sessionCreate, session, sessionAuth, machineAuth].every(isRecord)) {
    fail("producer OpenCode schemas are incomplete");
  }

  const branchesFor = (schema) => Array.isArray(schema.oneOf) ? schema.oneOf : [];
  const propertiesOf = (branch) => isRecord(branch) && isRecord(branch.properties) ? branch.properties : undefined;
  const isOpenCodeBranch = (branch) => propertiesOf(branch)?.agent?.const === "opencode";
  const allowsValue = (schema, value) => {
    if (!isRecord(schema)) return true;
    if (Object.hasOwn(schema, "const")) return schema.const === value;
    return !Array.isArray(schema.enum) || schema.enum.includes(value);
  };
  const explicitlyForbidsPair = (branch, firstKey, firstValue, secondKey, secondValue) =>
    isRecord(branch) && isRecord(branch.not) && isRecord(branch.not.properties) &&
    branch.not.properties[firstKey]?.const === firstValue &&
    branch.not.properties[secondKey]?.const === secondValue &&
    hasExactEnum(branch.not.required, [firstKey, secondKey]);
  const explicitlyForbidsValue = (branch, key, value) =>
    isRecord(branch) && isRecord(branch.not) && isRecord(branch.not.properties) &&
    branch.not.properties[key]?.const === value &&
    Array.isArray(branch.not.required) && branch.not.required.includes(key);
  const allowsOpenCodeCredentialBinding = (branch) => {
    const properties = propertiesOf(branch);
    return !explicitlyForbidsValue(branch, "agent", "opencode") &&
      !explicitlyForbidsPair(branch, "agent", "opencode", "auth_mode", "credential_binding") &&
      allowsValue(properties?.agent, "opencode") &&
      allowsValue(properties?.auth_mode, "credential_binding");
  };
  const allowsOpenCodeApiKey = (branch) => {
    const properties = propertiesOf(branch);
    return !explicitlyForbidsPair(branch, "agent", "opencode", "method", "api_key") &&
      allowsValue(properties?.agent, "opencode") &&
      allowsValue(properties?.method, "api_key");
  };
  const allowsOpenCodeState = (branch, state) => {
    const properties = propertiesOf(branch);
    return !explicitlyForbidsValue(branch, "agent", "opencode") &&
      allowsValue(properties?.agent, "opencode") && allowsValue(properties?.state, state);
  };
  const isStrictOpenCodeUnavailable = (branch) => {
    if (!allowsOpenCodeState(branch, "unavailable")) return true;
    const properties = propertiesOf(branch);
    const interactiveOnly = properties?.auth_mode?.const === "interactive_login" ||
      (allowsValue(properties?.auth_mode, "interactive_login") &&
        explicitlyForbidsPair(branch, "agent", "opencode", "auth_mode", "credential_binding"));
    return properties?.evidence_class?.const === "insufficient" &&
      properties?.state?.const === "unavailable" && interactiveOnly;
  };

  const createOpenCode = branchesFor(sessionCreate).filter(isOpenCodeBranch);
  const sessionOpenCode = branchesFor(session).filter(isOpenCodeBranch);
  const authOpenCode = branchesFor(sessionAuth).filter(isOpenCodeBranch);
  const machineOpenCode = branchesFor(machineAuth).filter(isOpenCodeBranch);
  const createBranch = createOpenCode[0];
  const sessionBranch = sessionOpenCode[0];
  const authBranch = authOpenCode[0];
  const machineBranch = machineOpenCode[0];
  const strict =
    createOpenCode.length === 1 && isRecord(createBranch) &&
    createBranch.properties?.auth_mode?.const === "interactive_login" &&
    hasExactEnum(createBranch.required, ["agent", "auth_mode"]) &&
    hasExactEnum(createBranch.not?.required, ["credential_binding_id"]) &&
    sessionOpenCode.length === 1 && isRecord(sessionBranch) &&
    sessionBranch.properties?.auth_mode?.const === "interactive_login" &&
    hasExactEnum(sessionBranch.required, ["agent", "auth_mode"]) &&
    authOpenCode.length === 1 && isRecord(authBranch) &&
    authBranch.properties?.auth_mode?.const === "interactive_login" &&
    hasExactEnum(authBranch.properties?.state?.enum, ["login_required", "configured"]) &&
    authBranch.properties?.evidence_class?.const === "provider_cli_credential_presence" &&
    !branchesFor(sessionAuth).some(allowsOpenCodeCredentialBinding) &&
    !branchesFor(sessionAuth).some((branch) => allowsOpenCodeState(branch, "authenticated")) &&
    branchesFor(sessionAuth).every(isStrictOpenCodeUnavailable) &&
    machineOpenCode.length === 1 && isRecord(machineBranch) &&
    machineBranch.properties?.method?.const === "interactive_login" &&
    hasExactEnum(machineBranch.properties?.state?.enum, ["installing", "login_required", "configured", "unavailable"]) &&
    !branchesFor(machineAuth).some(allowsOpenCodeApiKey);
  if (!strict) fail("producer OpenCode contract is not interactive-login-only");
}

async function git(producerRoot, ...args) {
  const result = await execFile("git", ["-C", producerRoot, ...args], { windowsHide: true });
  return result.stdout.trim();
}

function verifierReceipt(stdout) {
  const line = stdout.trim().split(/\r?\n/u).at(-1);
  let receipt;
  try { receipt = JSON.parse(line); } catch { fail("producer verifier did not emit a JSON receipt"); }
  exactObject(receipt, [
    "canonical_artifact_sha256",
    "contract_digest_semantics",
    "operations",
    "sdk_operations",
    "projection_sha256",
    "runtime_manifest_sha256",
  ], "producer verifier receipt");
  if (
    receipt.contract_digest_semantics !== "sha256(canonical-json:utf8;recursive-object-key-sort;array-order-preserved)" ||
    !sha256.test(receipt.canonical_artifact_sha256) ||
    !sha256.test(receipt.projection_sha256) ||
    !sha256.test(receipt.runtime_manifest_sha256)
  ) fail("producer verifier receipt is malformed");
  return receipt;
}

const sourceArgument = process.env.CUNA_INFRA_OPENAPI_PATH;
if (typeof sourceArgument !== "string" || sourceArgument.length === 0) {
  fail("CUNA_INFRA_OPENAPI_PATH must name the Infra contracts/runa-api.openapi.json artifact");
}

const sourceArtifact = await realpath(path.resolve(sourceArgument));
const sourceContracts = path.dirname(sourceArtifact);
const producerRoot = path.dirname(sourceContracts);
if (
  path.basename(sourceArtifact) !== expectedSourceName ||
  path.normalize(sourceContracts) !== path.join(producerRoot, "contracts")
) fail("source must be the exact Infra contracts/runa-api.openapi.json artifact");

const gitRoot = path.resolve(await git(producerRoot, "rev-parse", "--show-toplevel"));
if (path.normalize(gitRoot) !== path.normalize(producerRoot)) fail("source is not rooted at an isolated Infra Git worktree");
const producerRelativePath = path.relative(producerRoot, sourceArtifact).replaceAll("\\", "/");
if (producerRelativePath !== `contracts/${expectedSourceName}`) fail("source is not the canonical Infra contract path");
const producerRevision = await git(producerRoot, "rev-parse", "HEAD");
const objectFormat = await git(producerRoot, "rev-parse", "--show-object-format");
if (objectFormat !== "sha1" && objectFormat !== "sha256") fail("producer Git object format is unsupported");
const objectId = objectFormat === "sha1" ? /^[0-9a-f]{40}$/u : /^[0-9a-f]{64}$/u;
if (!objectId.test(producerRevision)) fail("producer revision is invalid");
const producerStatus = await git(producerRoot, "status", "--porcelain=v1", "--untracked-files=all");
const producerWorktreeIsClean = producerStatus.length === 0;
if (!producerWorktreeIsClean && process.env.CUNA_INFRA_OPENAPI_ALLOW_WORKTREE !== "1") {
  fail("producer is mutable; set CUNA_INFRA_OPENAPI_ALLOW_WORKTREE=1 only for a non-release working-tree delta");
}
const producerFullTree = producerWorktreeIsClean
  ? Object.freeze({
      object_format: objectFormat,
      commit: producerRevision,
      tree: await git(producerRoot, "rev-parse", `${producerRevision}^{tree}`),
      contract_blob: await git(producerRoot, "rev-parse", `${producerRevision}:${producerRelativePath}`),
    })
  : null;
if (producerFullTree !== null &&
  (!objectId.test(producerFullTree.tree) || !objectId.test(producerFullTree.contract_blob))) {
  fail("producer immutable tree witness is invalid");
}

const verifier = path.join(sourceContracts, "tools", "verify-contract.mjs");
const verification = await execFile(process.execPath, [verifier], {
  cwd: producerRoot,
  windowsHide: true,
  env: { ...process.env, RUNA_CONTRACT_ARTIFACT: sourceArtifact },
});
const receipt = verifierReceipt(verification.stdout);
const sourceBytes = await readFile(sourceArtifact);
let contract;
try { contract = JSON.parse(sourceBytes.toString("utf8")); } catch { fail("source artifact is not JSON"); }
strictHumanAuthContract(contract);
strictOpenCodeContract(contract);

const rawSha256 = digest(sourceBytes);
const canonicalSha256 = digest(Buffer.from(JSON.stringify(canonical(contract)), "utf8"));
if (canonicalSha256 !== receipt.canonical_artifact_sha256) fail("consumer canonical digest differs from the verified producer receipt");
const sourceDigest = (await readFile(path.join(sourceContracts, "runa-api.openapi.sha256"), "utf8")).trim().split(/\s+/u);
if (sourceDigest.length !== 2 || sourceDigest[0] !== canonicalSha256 || sourceDigest[1] !== expectedSourceName) {
  fail("producer canonical digest declaration differs from the verified artifact");
}

const immutableOpenCodeWitness = producerFullTree === null
  ? null
  : Object.freeze({
      openapi_raw_sha256: rawSha256,
      openapi_canonical_sha256: canonicalSha256,
      producer_commit: producerFullTree.commit,
      producer_tree: producerFullTree.tree,
      producer_contract_blob: producerFullTree.contract_blob,
    });
const identity = Object.freeze({
  schemaVersion: 2,
  artifact_file: "contracts/infra/cuna-api.openapi.json",
  canonical_digest_file: "contracts/infra/cuna-api.openapi.sha256",
  infra_openapi_raw_sha256: rawSha256,
  infra_openapi_canonical_sha256: canonicalSha256,
  producer_repository: producerRepository,
  producer_content_state: producerWorktreeIsClean ? "committed" : "working_tree_product_delta",
  ...(producerWorktreeIsClean
    ? {
        producer_revision: producerRevision,
        producer_full_tree: producerFullTree,
      }
    : {
        producer_base_revision: producerRevision,
        producer_full_tree: null,
      }),
  producer_contract_verifier: "contracts/tools/verify-contract.mjs",
  producer_projection_sha256: receipt.projection_sha256,
  producer_runtime_manifest_sha256: receipt.runtime_manifest_sha256,
  feature_contracts: Object.freeze({ opencode_interactive_only: immutableOpenCodeWitness }),
});

await writeFile(targetArtifact, sourceBytes);
await writeFile(targetDigest, `${canonicalSha256} cuna-api.openapi.json\n`, "utf8");
await writeFile(targetIdentity, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
await writeInfraContractWitness(root, identity);
process.stdout.write(`${JSON.stringify({
  status: producerWorktreeIsClean ? "synchronized_committed" : "synchronized_working_tree_product_delta",
  ...identity,
})}\n`);
