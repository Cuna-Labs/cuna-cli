import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { decodeAgentSessionItem } from "../dist/index.js";

/*
 * The control this repository did not have.
 *
 * Twice on 2026-09-07 a strict consumer broke against a producer that had moved.
 * The Edge added `terminal_reason` on 2026-09-06 and `project_id` on 2026-09-07;
 * `decodeAgentSession` refuses unknown fields, so each addition turned every
 * AgentSession read into `cuna.remote.malformed_response`, predicate
 * `no_unknown_fields`. A page decodes item by item, so ONE session carrying the
 * new field made the whole list unreadable. Every unit test stayed green,
 * because every fixture was written by the same hand as the decoder.
 *
 * A test that invents its own row can only ever confirm the decoder agrees with
 * itself. This one takes its field list from the vendored contract — the
 * producer's own artifact, synchronised by `npm run contract:sync:infra` and
 * pinned by its canonical digest — so the producer, not the fixture author,
 * decides what must decode.
 *
 * The second assertion is what makes it bite. If the contract declares a
 * property this file has no value for, the test FAILS rather than skipping it.
 * The next person to sync a contract that adds a field is stopped here and has
 * to state what a valid value looks like, which is exactly the moment to notice
 * the decoder needs teaching.
 */

const CONTRACT = fileURLToPath(
  new URL("../contracts/infra/cuna-api.openapi.json", import.meta.url),
);

/*
 * One valid value per declared property.
 *
 * These are deliberately literal. Deriving them from the schema would make the
 * fixture drift with the contract in lockstep and reintroduce the blind spot:
 * a decoder and a fixture generated from the same source always agree.
 */
const VALUE = Object.freeze({
  id: "11111111-1111-4111-8111-111111111111",
  machine_id: "22222222-2222-4222-8222-222222222222",
  workspace_binding_id: "33333333-3333-4333-8333-333333333333",
  workspace_generation: 1,
  project_id: "44444444-4444-4444-8444-444444444444",
  workspace_failure_code: undefined, // only valid when request_state is "failed"
  terminal_reason: undefined, // only valid on a terminal process_state
  name: "opencode",
  agent: "opencode",
  cwd: "/workspace/workspaces/55555555-5555-4555-8555-555555555555",
  auth_mode: "interactive_login",
  desired_state: "running",
  request_state: "launched",
  process_state: "running",
  process_epoch: "66666666-6666-4666-8666-666666666666",
  runtime_observed_at: "2026-09-07T22:00:00.000+00:00",
  runtime_expires_at: "2026-09-07T22:00:30.000+00:00",
  termination_requested_at: "2026-09-07T22:00:10.000+00:00",
  row_version: 7,
  created_at: "2026-09-07T20:25:41.348866+00:00",
  updated_at: "2026-09-07T22:00:00.000000+00:00",
});

/* Properties whose presence is conditional on another field's value, so they
 * cannot appear on the same row as the one above. Each is exercised by its own
 * case below rather than being waved through. */
const CONDITIONAL = Object.freeze(["workspace_failure_code", "terminal_reason"]);

async function declaredProperties() {
  const document = JSON.parse(await readFile(CONTRACT, "utf8"));
  const schema = document.components?.schemas?.AgentSession;
  assert.ok(schema?.properties, "the vendored contract declares an AgentSession schema");
  return Object.keys(schema.properties);
}

test("this file states a value for every property the contract declares", async () => {
  const declared = await declaredProperties();
  const uncovered = declared.filter((key) => !(key in VALUE));
  assert.deepEqual(
    uncovered,
    [],
    `The contract declares ${uncovered.join(", ")} and this file has no value for it. `
      + "Add one, and check whether decodeAgentSession accepts it — that is the "
      + "question this test exists to force.",
  );
  // And the reverse: a value for something the contract no longer declares is a
  // fixture that has outlived its subject.
  const orphaned = Object.keys(VALUE).filter((key) => !declared.includes(key));
  assert.deepEqual(orphaned, [], `this file names ${orphaned.join(", ")}, which the contract does not declare`);
});

test("the decoder accepts a row carrying every unconditional field the contract declares", async () => {
  const declared = await declaredProperties();
  const row = Object.fromEntries(
    declared.filter((key) => !CONDITIONAL.includes(key)).map((key) => [key, VALUE[key]]),
  );
  // The precondition: this really is the whole declared surface, not a subset
  // that happens to decode.
  assert.equal(Object.keys(row).length, declared.length - CONDITIONAL.length);

  const decoded = decodeAgentSessionItem(row);
  assert.equal(decoded.id, VALUE.id);
  assert.equal(decoded.projectId, VALUE.project_id);
  assert.equal(decoded.workspaceBindingId, VALUE.workspace_binding_id);
});

test("each conditional field decodes on the row shape that makes it valid", () => {
  const base = Object.fromEntries(
    Object.entries(VALUE).filter(([key, value]) => value !== undefined && !CONDITIONAL.includes(key)),
  );

  const failed = decodeAgentSessionItem({
    ...base,
    request_state: "failed",
    workspace_failure_code: "workspace_binding_unavailable",
  });
  assert.equal(failed.workspaceFailureCode, "workspace_binding_unavailable");

  const exited = decodeAgentSessionItem({
    ...base,
    process_state: "exited",
    terminal_reason: "process_exited",
  });
  assert.equal(exited.terminalReason, "process_exited");
});

test("an undeclared field is still refused, so the acceptance above is not blanket tolerance", async () => {
  const declared = await declaredProperties();
  const row = Object.fromEntries(
    declared.filter((key) => !CONDITIONAL.includes(key)).map((key) => [key, VALUE[key]]),
  );
  assert.throws(
    () => decodeAgentSessionItem({ ...row, invented_field: "x" }),
    /no_unknown_fields/u,
    "the decoder must still refuse a field no contract declares",
  );
});
