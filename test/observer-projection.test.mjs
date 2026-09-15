import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { observerSchemas } from "../dist/api/observer-v2-schema.js";
import { decodeObserverPage, observerApi } from "../dist/api/observer-v2.js";

/**
 * The observer projection is the decoder for shared-session discovery and
 * read-only admission. It must be emitted from the contract this package
 * vendors, `contracts/infra/cuna-api.openapi.json`, not from a foreign checkout
 * at a hardcoded revision. The defect this pins: the generator's own `--check`
 * stayed green while the emitted schema lacked the producer's `revoking` grant
 * state, because it compared against the wrong input. A green `--check` proves
 * only that the output matches whatever the generator read; these assertions
 * bind the emitted schema and its provenance line to the vendored bytes.
 */
const ROOT = new URL("../", import.meta.url);
const CONTRACT_PATH = "contracts/infra/cuna-api.openapi.json";
const contractBytes = await readFile(new URL(CONTRACT_PATH, ROOT));
const contract = JSON.parse(contractBytes.toString("utf8"));
const contractSha256 = createHash("sha256").update(contractBytes).digest("hex");

test("observer projection is emitted from the vendored canonical contract", async () => {
  const source = await readFile(new URL("src/api/observer-v2-schema.ts", ROOT), "utf8");
  const provenance = source.split("\n")[1];
  assert.ok(provenance.includes(CONTRACT_PATH), `provenance must name the vendored input: ${provenance}`);
  assert.ok(provenance.endsWith(`SHA256 ${contractSha256}`), `provenance must name the vendored bytes: ${provenance}`);
  for (const [name, schema] of Object.entries(observerSchemas)) {
    assert.deepEqual(schema, contract.components.schemas[name], name);
  }
  assert.ok(observerSchemas.SessionObserveGrantV2Receipt.properties.state.enum.includes("revoking"));
});

test("observer generator reads its own package and its --check passes without git or a foreign checkout", async () => {
  const generator = new URL("scripts/project-observer-v2.mjs", ROOT);
  const source = await readFile(generator, "utf8");
  assert.ok(!source.includes("child_process"), "the generator must not shell out to git");
  assert.ok(!/\b[0-9a-f]{40}\b/u.test(source), "the generator must not pin a revision");
  assert.ok(source.includes(CONTRACT_PATH), "the generator must read the vendored contract");
  const result = spawnSync(process.execPath, [fileURLToPath(generator), "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

const id = (n) => `ba600000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const project = "20178adc-8ae4-515a-bb38-bd25042707db";
const principal = id(1);
const revoking = {
  version: "2",
  kind: "session_observe_grant",
  grant_id: id(3),
  revision: 2,
  owner_principal_id: id(4),
  subject_principal_id: principal,
  agent_session_id: id(5),
  session_incarnation: id(6),
  project_id: project,
  authority_epoch: 1,
  membership_revision: 1,
  state: "revoking",
  expires_at: Date.now() + 60_000,
  revocation_state: "effective_pending",
};
const page = { version: "2", kind: "observer_sessions", project_id: project, items: [revoking], next_after_grant_id: null };

test("a revoking grant decodes per the contract but is never usable authority", async () => {
  assert.throws(() => decodeObserverPage(page, principal, project, null), { code: "cuna.observer.unavailable" });
  let requests = 0;
  const api = observerApi({ request: async () => { requests += 1; return {}; } }, principal, project);
  await assert.rejects(api.issue(revoking, id(8), "client-B", new AbortController().signal), { code: "cuna.observer.unavailable" });
  assert.equal(requests, 0, "no attachment request may leave the client for a non-active grant");
});
