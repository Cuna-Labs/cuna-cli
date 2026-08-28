import { EXIT_CODES, CunaError } from "../core/errors.js";
import { INFRA_OPENAPI_CONTRACT_IDENTITY } from "./infra-contract-witness.js";

/**
 * Local consumer admission for a deliberately unreleased provider surface.
 *
 * This is not a release authority: the Edge producer and the release manifest
 * remain authoritative for whether OpenCode can create durable resources. The
 * CLI gate adds a fail-closed local boundary while that cross-repository
 * rollout is incomplete. It reads no credential and is never propagated to a
 * remote request, provider process, or terminal child.
 */
export type OpenCodeFeatureState = "enabled" | "disabled";
export type OpenCodeFeatureGateReason = "immutable_contract_witness_required" | "enabled";

export interface OpenCodeFeatureGate {
  readonly state: OpenCodeFeatureState;
  readonly source: "compiled_contract";
  readonly reason: OpenCodeFeatureGateReason;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_OBJECT_FORMATS = new Set(["sha1", "sha256"]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isGitObjectId(value: unknown, objectFormat: unknown): value is string {
  if (objectFormat !== "sha1" && objectFormat !== "sha256" || typeof value !== "string") return false;
  return new RegExp(`^[0-9a-f]{${objectFormat === "sha1" ? 40 : 64}}$`, "u").test(value);
}

function hasImmutableProducerTree(value: unknown, producerRevision: unknown): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value) || !GIT_OBJECT_FORMATS.has(String(value.object_format))) return false;
  const objectFormat = value.object_format;
  return value.commit === producerRevision &&
    isGitObjectId(value.commit, objectFormat) &&
    isGitObjectId(value.tree, objectFormat) &&
    isGitObjectId(value.contract_blob, objectFormat);
}

/**
 * Validates the build-time evidence required to expose any OpenCode execution
 * path. A raw OpenAPI file from a mutable producer worktree is deliberately
 * not enough: the strict contract must be bound to one committed Git tree and
 * to the exact contract blob within it.
 */
export function hasCommittedOpenCodeContractWitness(value: unknown): boolean {
  if (!isRecord(value) || value.schemaVersion !== 2 ||
    value.producer_repository !== "Cuna-Labs/infra" ||
    value.producer_content_state !== "committed" ||
    value.artifact_file !== "contracts/infra/cuna-api.openapi.json" ||
    value.canonical_digest_file !== "contracts/infra/cuna-api.openapi.sha256" ||
    value.producer_contract_verifier !== "contracts/tools/verify-contract.mjs" ||
    typeof value.producer_revision !== "string" ||
    !SHA256.test(String(value.infra_openapi_raw_sha256)) ||
    !SHA256.test(String(value.infra_openapi_canonical_sha256)) ||
    !SHA256.test(String(value.producer_projection_sha256)) ||
    !SHA256.test(String(value.producer_runtime_manifest_sha256))) {
    return false;
  }
  const fullTree = hasImmutableProducerTree(value.producer_full_tree, value.producer_revision)
    ? value.producer_full_tree
    : undefined;
  const featureContracts = isRecord(value.feature_contracts) ? value.feature_contracts : undefined;
  const witness = featureContracts !== undefined && isRecord(featureContracts.opencode_interactive_only)
    ? featureContracts.opencode_interactive_only
    : undefined;
  return fullTree !== undefined && witness !== undefined &&
    witness.openapi_raw_sha256 === value.infra_openapi_raw_sha256 &&
    witness.openapi_canonical_sha256 === value.infra_openapi_canonical_sha256 &&
    witness.producer_commit === fullTree.commit &&
    witness.producer_tree === fullTree.tree &&
    witness.producer_contract_blob === fullTree.contract_blob;
}

/**
 * Resolve the local consumer gate from the compiled producer contract witness.
 *
 * OpenCode is a normal public provider once the vendored producer contract is
 * bound to one committed tree. Runtime capability discovery remains the
 * authority for each concrete create/attach operation; no local environment
 * variable can invent producer support or unnecessarily hide current support.
 */
export function resolveOpenCodeFeatureGate(
  _environment: Readonly<Record<string, string | undefined>> = process.env,
  contractIdentity: unknown = INFRA_OPENAPI_CONTRACT_IDENTITY,
): OpenCodeFeatureGate {
  const committedWitness = hasCommittedOpenCodeContractWitness(contractIdentity);
  return Object.freeze({
    state: committedWitness ? "enabled" : "disabled",
    source: "compiled_contract",
    reason: committedWitness ? "enabled" : "immutable_contract_witness_required",
  });
}

/** Fail before a protected OpenCode network, host, or terminal-child effect. */
export function assertOpenCodeExecutionEnabled(gate: OpenCodeFeatureGate): void {
  if (gate.state === "enabled") return;
  throw new CunaError({
    code: "cuna.feature.opencode_disabled",
    message: "OpenCode is disabled in this Cuna CLI until its strict producer contract is immutable.",
    exitCode: EXIT_CODES.policy,
    hint: "Install a local CLI package built from the current committed Infra OpenCode contract. Runtime capability discovery must also advertise the requested operation.",
    details: {
      feature: "opencode",
      gate: gate.state,
      source: gate.source,
      reason: gate.reason,
    },
  });
}
