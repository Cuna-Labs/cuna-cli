import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { instantOrNull, sameInstant } from "../dist/core/instant.js";
import { assertReadyPayloadMatches, assertRemoteAgentSessionEvidence } from "../dist/runtime/terminal-transport.js";
import {
  loadWorkspaceBinding,
  persistWorkspaceBinding,
} from "../dist/workspace/index.js";

/**
 * The exact bytes production sends.
 *
 * Not a shape, not a generated sample, not a value derived from the code under
 * test: this string was read off `api.getcuna.com` on 2026-08-18. PostgREST
 * renders `timestamptz` with up to six fractional digits and an explicit
 * `+00:00`, and `infra edge/src/agent-sessions.ts:235-240` forwards the row
 * verbatim, so this is what `runtime_observed_at` looks like on the wire.
 *
 * Every assertion below is anchored on this literal. A test parametrized over
 * the validator's own accepted set narrows with the validator — that is the
 * exact failure this repo already recorded, where reverting a dual-accept fix
 * left the suite green because the parametrization reverted with it.
 */
const PRODUCTION_INSTANT = "2026-08-18T20:49:24.458909+00:00";

/**
 * The literal oracle: `2026-08-18T20:49:24.458` UTC in epoch milliseconds,
 * written out rather than computed. A test that says
 * `Date.parse(x) === Date.parse(x)` passes against any parser, including a
 * broken one.
 */
const PRODUCTION_EPOCH_MS = 1_787_086_164_458;

/** The same moment as `PRODUCTION_INSTANT`, rendered by `toISOString()`. */
const JAVASCRIPT_INSTANT = "2026-08-18T20:49:24.458Z";

test("the exact production string is an instant, and it is the instant it says", () => {
  assert.equal(instantOrNull(PRODUCTION_INSTANT), PRODUCTION_EPOCH_MS);
  assert.equal(new Date(PRODUCTION_EPOCH_MS).toISOString(), JAVASCRIPT_INSTANT);
});

test("the two renderers in this system agree on the moment and never on the bytes", () => {
  assert.notEqual(PRODUCTION_INSTANT, JAVASCRIPT_INSTANT);
  assert.equal(sameInstant(PRODUCTION_INSTANT, JAVASCRIPT_INSTANT), true);
});

test("every encoding RFC 3339 admits for this moment is accepted", () => {
  // Spelled out, not generated. Each is the same instant under a different
  // legal rendering: zero, three, five, six and nine fractional digits; `Z`,
  // an explicit zero offset, and a non-zero offset.
  for (const encoding of [
    "2026-08-18T20:49:24.458909+00:00",
    "2026-08-18T20:49:24.458909-00:00",
    "2026-08-18T20:49:24.458Z",
    "2026-08-18T20:49:24.45890+00:00",
    "2026-08-18T20:49:24.458909123Z",
    "2026-08-18T22:49:24.458+02:00",
    "2026-08-18T14:49:24.458909-06:00",
  ]) {
    assert.equal(instantOrNull(encoding), PRODUCTION_EPOCH_MS, encoding);
    assert.equal(sameInstant(encoding, PRODUCTION_INSTANT), true, encoding);
  }
});

test("a value with no offset is refused, because guessing one is worse than failing", () => {
  // This is the case that must never be relaxed for convenience. `Date.parse`
  // applies the host's local zone to a naive string, so the digits below name a
  // different moment on every machine — and on a host at UTC-6 they are six
  // hours away from the value they were copied from. Two agreeing services in
  // two regions would silently disagree, with no error anywhere.
  const naive = "2026-08-18T20:49:24.458909";
  assert.equal(instantOrNull(naive), null);
  assert.equal(sameInstant(naive, PRODUCTION_INSTANT), false);

  // The refusal comes from the ENCODING gate, never from unparseability: the
  // host parses this string perfectly well, and we decline to use the answer.
  // That is the whole property, and it is the only form of it that holds
  // everywhere — the previous line here asserted `Date.parse(naive) !==
  // PRODUCTION_EPOCH_MS`, which is TRUE on this author's UTC-6 host and FALSE on
  // a CI runner at UTC, where the two encodings name the same instant. It failed
  // in CI and passed locally, which is the shape this repository already records
  // for test counts: a result that needs its host stated is not a property.
  assert.equal(Number.isFinite(Date.parse(naive)), true, "the host can parse it");
  assert.equal(instantOrNull(naive), null, "and we refuse it anyway");
});

test("non-instants are refused, and never equal themselves", () => {
  for (const value of [
    "",
    "2026-08-18",
    "2026-08-18T20:49:24",
    "2026-08-18 20:49:24.458909+00:00",
    "2026-08-18T20:49:24.+00:00",
    "2026-13-18T20:49:24.458Z",
    "not a timestamp",
    1_787_086_164_458,
    null,
    undefined,
    { toString: () => PRODUCTION_INSTANT },
  ]) {
    assert.equal(instantOrNull(value), null, String(value));
    assert.equal(sameInstant(value, value), false, String(value));
  }
});

/**
 * A regex that admits the production encoding is not the same claim as a
 * terminal attach that admits it. `CANONICAL_TIMESTAMP` sat in front of this
 * function and required `\.[0-9]{3}Z$`, which no value the service has ever
 * sent can satisfy, so the assertion below is the one that binds the repair to
 * the subsystem it unblocks.
 */
function evidence(overrides = {}) {
  return Object.freeze({
    authority: "cuna_agent_session_supervisor",
    userId: "user_1",
    machineId: "machine_1",
    agentSessionId: "agent_session_1",
    processEpoch: "b6a1f0d2-4c3e-4a1b-9f77-0c2d5e8a4b13",
    state: "ready",
    observedAt: PRODUCTION_INSTANT,
    expiresAt: "2026-08-18T20:49:54.458909+00:00",
    evidenceRevision: "agent-session-row:7",
    ...overrides,
  });
}

test("terminal attach admits the encoding the service actually sends", () => {
  const admitted = assertRemoteAgentSessionEvidence({
    evidence: evidence(),
    expectedAgentSessionId: "agent_session_1",
    now: PRODUCTION_EPOCH_MS + 1_000,
  });
  // Returned unchanged: the repair widens what is ACCEPTED and rewrites
  // nothing, so the bytes the service sent are the bytes downstream sees.
  assert.equal(admitted.observedAt, PRODUCTION_INSTANT);
  assert.equal(admitted.expiresAt, "2026-08-18T20:49:54.458909+00:00");
});

test("terminal attach still admits a canonical JavaScript rendering", () => {
  const admitted = assertRemoteAgentSessionEvidence({
    evidence: evidence({
      observedAt: JAVASCRIPT_INSTANT,
      expiresAt: "2026-08-18T20:49:54.458Z",
    }),
    expectedAgentSessionId: "agent_session_1",
    now: PRODUCTION_EPOCH_MS + 1_000,
  });
  assert.equal(admitted.observedAt, JAVASCRIPT_INSTANT);
});

test("local-action READY must match the exact AgentSession WorkspaceBinding", () => {
  const workspaceBindingId = "00000000-0000-4000-8000-000000000777";
  const admitted = assertRemoteAgentSessionEvidence({
    evidence: evidence({ workspaceBindingId, workspaceBindingGeneration: 3 }),
    expectedAgentSessionId: "agent_session_1",
    now: PRODUCTION_EPOCH_MS + 1_000,
  });
  const ready = {
    protocol: "runa.terminal.v1",
    machineId: admitted.machineId,
    machineGeneration: "42",
    workspaceBindingId,
    workspaceBindingGeneration: 3,
    agentSessionId: admitted.agentSessionId,
    processEpoch: admitted.processEpoch,
    fencingGeneration: 7,
    resizeCapability: "live",
    accessMode: "writer",
    writerEpoch: 1,
    localActionProtocol: {
      name: "cuna.local-actions.v1",
      maxRequestBytes: 65_536,
      maxResultBytes: 65_536,
      streamWindowBytes: 1_048_576,
      kinds: ["browser.open"],
    },
  };
  assert.doesNotThrow(() => assertReadyPayloadMatches(ready, admitted));
  assert.throws(
    () => assertReadyPayloadMatches({ ...ready, workspaceBindingGeneration: 4 }, admitted),
    (error) => error.code === "grant_scope_mismatch",
  );
  const { machineGeneration: _omitted, ...partialReady } = ready;
  assert.throws(
    () => assertReadyPayloadMatches(partialReady, admitted),
    (error) => error.code === "grant_scope_mismatch",
  );
});

test("terminal attach refuses evidence whose timestamps carry no offset", () => {
  assert.throws(
    () =>
      assertRemoteAgentSessionEvidence({
        evidence: evidence({ observedAt: "2026-08-18T20:49:24.458909" }),
        expectedAgentSessionId: "agent_session_1",
        now: PRODUCTION_EPOCH_MS + 1_000,
      }),
    (error) => error.code === "remote_state_unproven",
  );
});

test("widening the encoding preserves identity, ordering, and attribution rules", () => {
  const cases = [
    // Expiry before observation is malformed even though expiry-at-now is now
    // decided by POST terminal-connections rather than this cached snapshot.
    [{ expiresAt: "2026-08-18T20:49:23.000000+00:00" }, PRODUCTION_EPOCH_MS + 1_000],
    // Observed too far in the future.
    [{ observedAt: "2026-08-18T20:59:24.458909+00:00" }, PRODUCTION_EPOCH_MS],
    // Wrong authority.
    [{ authority: "somebody_else" }, PRODUCTION_EPOCH_MS + 1_000],
    // The evidence is not attributable to a process generation or a row. These
    // two are here because a mutation deleting either check survived the suite
    // as it stood: the timestamp widening must not be the reason the rest of
    // the admission goes unexercised.
    [{ processEpoch: "" }, PRODUCTION_EPOCH_MS + 1_000],
    [{ evidenceRevision: "" }, PRODUCTION_EPOCH_MS + 1_000],
    [{ userId: "" }, PRODUCTION_EPOCH_MS + 1_000],
    [{ machineId: "" }, PRODUCTION_EPOCH_MS + 1_000],
  ];
  for (const [overrides, now] of cases) {
    assert.throws(
      () =>
        assertRemoteAgentSessionEvidence({
          evidence: evidence(overrides),
          expectedAgentSessionId: "agent_session_1",
          now,
        }),
      (error) => error.code === "remote_state_unproven",
      JSON.stringify(overrides),
    );
  }
});

/**
 * The workspace binding is the site that was actually failing for users:
 * `bindingCreatedAt` and `bindingUpdatedAt` come straight from the service, and
 * `timestamp()` demanded a `toISOString()` round-trip, so every `cuna claude`
 * ended in `binding_corrupt / draft_invalid`.
 */
const BINDING_CREATED_AT = "2026-08-18T19:55:47.437071+00:00";
const BINDING_UPDATED_AT = "2026-08-18T20:01:57.89766+00:00";

function bindingDraft(overrides = {}) {
  return Object.freeze({
    profileId: "default",
    userId: "user_1",
    workspaceId: "workspace_1",
    bindingId: "binding_1",
    projectId: "project_1",
    localInstanceId: "local_1",
    machineId: "machine_1",
    remoteRoot: "/workspace/projects/project_1",
    policyDigest: "a".repeat(64),
    generation: 0,
    bindingCreatedAt: BINDING_CREATED_AT,
    bindingUpdatedAt: BINDING_UPDATED_AT,
    ...overrides,
  });
}

function bindingExpectations(overrides = {}) {
  return Object.freeze({
    profileId: "default",
    userId: "user_1",
    workspaceId: "workspace_1",
    machineId: "machine_1",
    remoteRoot: "/workspace/projects/project_1",
    policyDigest: "a".repeat(64),
    generation: 0,
    bindingId: "binding_1",
    bindingCreatedAt: BINDING_CREATED_AT,
    bindingUpdatedAt: BINDING_UPDATED_AT,
    ...overrides,
  });
}

async function temporaryRoot(t) {
  const directory = await mkdtemp(join(tmpdir(), "cuna-instant-authority-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return directory;
}

test("a binding minted by the service round-trips through the local store", async (t) => {
  const root = await temporaryRoot(t);
  const record = await persistWorkspaceBinding({ root, binding: bindingDraft(), expected: null });

  // The service's exact bytes survive validation, the write and the read. Six
  // fractional digits on one field, five with the trailing zero trimmed on the
  // other — both read off production on 2026-08-18. Before the repair this
  // rejected on the draft, and `cuna claude` ended in
  // `binding_corrupt / draft_invalid` for every user.
  assert.equal(record.bindingCreatedAt, BINDING_CREATED_AT);
  assert.equal(record.bindingUpdatedAt, BINDING_UPDATED_AT);

  const loaded = await loadWorkspaceBinding({ startPath: root, expected: bindingExpectations() });
  assert.equal(loaded?.record.bindingCreatedAt, BINDING_CREATED_AT);
  assert.equal(loaded?.record.bindingUpdatedAt, BINDING_UPDATED_AT);
});

test("a binding timestamp with no offset is still refused", async (t) => {
  const root = await temporaryRoot(t);

  // Both cases are built so that the OFFSET GUARD is the only rule that can
  // reject them, and so that this holds on a host in any zone. The obvious
  // version of this test — make `bindingCreatedAt` naive and leave
  // `bindingUpdatedAt` as the service sent it — passes even against a validator
  // whose offset guard can never fire, because reading the naive value in a
  // western local zone pushes it past `bindingUpdatedAt` and the ORDER check
  // rejects instead. A mutation that neutered the guard survived that version.
  for (const overrides of [
    // Only `bindingUpdatedAt` is naive, and far enough ahead that it stays
    // later than `bindingCreatedAt` under any offset from -14:00 to +14:00.
    { bindingUpdatedAt: "2026-08-20T00:00:00.000" },
    // Both naive: one zone applies to both, so the order is preserved whatever
    // the host is set to.
    {
      bindingCreatedAt: "2026-08-18T19:55:47.437071",
      bindingUpdatedAt: "2026-08-18T20:01:57.89766",
    },
  ]) {
    await assert.rejects(
      persistWorkspaceBinding({ root, binding: bindingDraft(overrides), expected: null }),
      (error) => error.code === "cuna.workspace.binding_corrupt" &&
        error.details?.reason === "draft_invalid",
      JSON.stringify(overrides),
    );
  }
});

test("an owner check matches the same moment across two renderings", async (t) => {
  const root = await temporaryRoot(t);
  await persistWorkspaceBinding({ root, binding: bindingDraft(), expected: null });

  // The record on disk holds the service's `+00:00` bytes. The expectation
  // below holds the same two moments as `toISOString()` would render them —
  // which is what a caller would carry if any producing path ever normalized.
  // One moment rendered twice must not read as a different owner.
  const loaded = await loadWorkspaceBinding({
    startPath: root,
    expected: bindingExpectations({
      bindingCreatedAt: "2026-08-18T19:55:47.437Z",
      bindingUpdatedAt: "2026-08-18T20:01:57.897Z",
    }),
  });
  assert.equal(loaded?.record.bindingCreatedAt, BINDING_CREATED_AT);

  // And a genuinely different moment is still a mismatch, in either encoding.
  for (const mismatch of [
    { bindingCreatedAt: "2026-08-18T19:55:48.437Z" },
    { bindingCreatedAt: "2026-08-18T19:55:48.437071+00:00" },
    { bindingUpdatedAt: "2026-08-18T20:01:58.897Z" },
  ]) {
    await assert.rejects(
      loadWorkspaceBinding({ startPath: root, expected: bindingExpectations(mismatch) }),
      (error) => error.code === "cuna.workspace.identity_unproven" &&
        error.details?.reason === "binding_owner_mismatch",
      JSON.stringify(mismatch),
    );
  }
});
