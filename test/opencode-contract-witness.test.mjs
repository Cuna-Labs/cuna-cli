import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { INFRA_OPENAPI_CONTRACT_IDENTITY } from "../dist/config/infra-contract-witness.js";
import {
  hasCommittedOpenCodeContractWitness,
  resolveOpenCodeFeatureGate,
} from "../dist/config/opencode-feature-gate.js";
import { renderInfraContractWitness } from "../scripts/lib/infra-contract-witness.mjs";

const committedWitness = Object.freeze({
  schemaVersion: 2,
  artifact_file: "contracts/infra/cuna-api.openapi.json",
  canonical_digest_file: "contracts/infra/cuna-api.openapi.sha256",
  infra_openapi_raw_sha256: "a".repeat(64),
  infra_openapi_canonical_sha256: "b".repeat(64),
  producer_repository: "Cuna-Labs/infra",
  producer_content_state: "committed",
  producer_revision: "c".repeat(40),
  producer_full_tree: Object.freeze({
    object_format: "sha1",
    commit: "c".repeat(40),
    tree: "d".repeat(40),
    contract_blob: "e".repeat(40),
  }),
  producer_contract_verifier: "contracts/tools/verify-contract.mjs",
  producer_projection_sha256: "f".repeat(64),
  producer_runtime_manifest_sha256: "0".repeat(64),
  feature_contracts: Object.freeze({
    opencode_interactive_only: Object.freeze({
      openapi_raw_sha256: "a".repeat(64),
      openapi_canonical_sha256: "b".repeat(64),
      producer_commit: "c".repeat(40),
      producer_tree: "d".repeat(40),
      producer_contract_blob: "e".repeat(40),
    }),
  }),
});

test("compiled OpenCode witness is mechanically generated from the vendored identity", async () => {
  const identityText = await readFile(new URL("../contracts/infra/cuna-api.openapi.identity.json", import.meta.url), "utf8");
  const sourceText = await readFile(new URL("../src/config/infra-contract-witness.ts", import.meta.url), "utf8");
  assert.equal(sourceText, renderInfraContractWitness(JSON.parse(identityText)));
  assert.equal(INFRA_OPENAPI_CONTRACT_IDENTITY.producer_content_state, "committed");
  assert.equal(hasCommittedOpenCodeContractWitness(INFRA_OPENAPI_CONTRACT_IDENTITY), true);
});

test("OpenCode gate requires a tree-bound committed strict-contract witness and ignores local env claims", () => {
  for (const value of [undefined, "", "false", "TRUE", "1", " true", "true "]) {
    assert.equal(resolveOpenCodeFeatureGate({ CUNA_OPENCODE_ENABLED: value }, committedWitness).state, "enabled");
  }

  for (const invalid of [
    {},
    { ...committedWitness, producer_content_state: "working_tree_product_delta" },
    { ...committedWitness, producer_full_tree: null },
    { ...committedWitness, producer_revision: "f".repeat(40) },
    {
      ...committedWitness,
      feature_contracts: {
        opencode_interactive_only: {
          ...committedWitness.feature_contracts.opencode_interactive_only,
          producer_tree: "f".repeat(40),
        },
      },
    },
  ]) {
    assert.equal(hasCommittedOpenCodeContractWitness(invalid), false);
    assert.equal(resolveOpenCodeFeatureGate({ CUNA_OPENCODE_ENABLED: "true" }, invalid).state, "disabled");
  }

  assert.equal(hasCommittedOpenCodeContractWitness(committedWitness), true);
  assert.deepEqual(resolveOpenCodeFeatureGate({ CUNA_OPENCODE_ENABLED: "true" }, committedWitness), {
    state: "enabled",
    source: "compiled_contract",
    reason: "enabled",
  });
});

test("the current committed producer identity enables OpenCode without a mutable override", () => {
  assert.equal(hasCommittedOpenCodeContractWitness(INFRA_OPENAPI_CONTRACT_IDENTITY), true);
  assert.deepEqual(resolveOpenCodeFeatureGate({ CUNA_OPENCODE_ENABLED: "true" }), {
    state: "enabled",
    source: "compiled_contract",
    reason: "enabled",
  });
});
