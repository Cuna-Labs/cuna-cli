// PRD cuna-truthful-machine-surfaces R3.1/R3.2 (BL-3): a Machine event reads
// "Machine ...", an AgentSession event reads "Session ...".
//
// Measured on the 0.1.7 drop c0dc53b (biotech-lab, 2026-10-02): `records list`
// printed record 875ad4c2 as `session.create  Session started` and the delete of
// Machine cd0696a7 as `session.delete  Session deleted`. Every `/v1/records` row
// names a Machine (its `session_id` is a Machine id); the `session.` prefix and
// the summary the database derives from it predate the Machine/AgentSession
// split. The kind is stored data and stays; the words a person reads come from
// one kind->label map, and the record's resource decides the noun.
import test from "node:test";
import assert from "node:assert/strict";

import { memoryStreams, runCli } from "../dist/index.js";

const PLATFORM = Object.freeze({
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
});
const API_KEY = "cuna_sk_abcdefghijklmnop";
const MACHINE_ID = "cd0696a7-fd94-4095-b3ed-05283de80469";

/**
 * Every kind the database keeps, with the summary it stores for it
 * (infra supabase/migrations/0021_credential_audit_intents.sql,
 * `audit_safe_summary`; any other kind is stored as `session.operation`).
 */
const SERVER_RECORDS = [
  ["session.reserve", "Session reservation accepted"],
  ["session.create", "Session started"],
  ["session.error", "Session provisioning failed"],
  ["session.pause", "Session paused"],
  ["session.resume", "Session resumed"],
  ["session.stop", "Session stopped"],
  ["session.start", "Session started"],
  ["session.delete", "Session deleted"],
  ["session.exec", "Command execution completed"],
  ["session.checkpoint", "Checkpoint created"],
  ["session.reconcile", "Session state reconciled"],
  ["session.reservation_recovered", "Abandoned reservation recovered"],
  ["session.operation", "Session operation recorded"],
  ["metering.close", "Usage span closed"],
  ["metering.reconcile", "Usage aggregate reconciled"],
  ["proxy.request", "Session route requested"],
  ["proxy.upgrade", "Session stream requested"],
  ["credential.set", "Credential write requested"],
  ["credential.delete", "Credential deletion requested"],
  ["credential_rule.create", "Credential rule creation requested"],
  ["credential_rule.delete", "Credential rule deletion requested"],
];

/** What a person reads for each kind on a Machine's record. */
const MACHINE_LABELS = {
  "session.reserve": "Machine reservation accepted",
  "session.create": "Machine created",
  "session.error": "Machine provisioning failed",
  "session.pause": "Machine paused",
  "session.resume": "Machine resumed",
  "session.stop": "Machine stopped",
  "session.start": "Machine started",
  "session.delete": "Machine deleted",
  "session.exec": "Machine command completed",
  "session.checkpoint": "Machine checkpoint created",
  "session.reconcile": "Machine state reconciled",
  "session.reservation_recovered": "Machine reservation recovered",
  "session.operation": "Machine operation recorded",
  "metering.close": "Machine usage span closed",
  "metering.reconcile": "Usage aggregate reconciled",
  "proxy.request": "Machine route requested",
  "proxy.upgrade": "Machine stream requested",
  "credential.set": "Credential write requested",
  "credential.delete": "Credential deletion requested",
  "credential_rule.create": "Credential rule creation requested",
  "credential_rule.delete": "Credential rule deletion requested",
};

function recordId(index) {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

function createdAt(index) {
  return new Date(Date.parse("2026-09-29T01:21:33Z") + index * 1000).toISOString();
}

/** The records route as the Edge serves it, through the real transport. */
function recordsApi(rows) {
  return async (url) => {
    const { pathname } = new URL(url);
    if (pathname === "/v1/capabilities") {
      const now = Date.now();
      return Response.json({
        schema_version: "1.0", subject_scope: "account",
        observed_at: new Date(now - 100).toISOString(), expires_at: new Date(now + 30_000).toISOString(), etag: "r3",
        capabilities: [{
          id: "records.list", availability: "supported", interaction: "read_only",
          mutation_class: "none", surfaces: ["cli"], required_permissions: [],
        }],
      });
    }
    if (pathname === "/v1/records") return Response.json(rows);
    throw new Error(`unexpected request ${pathname}`);
  };
}

const ROWS = SERVER_RECORDS.map(([kind, summary], index) => ({
  id: recordId(index), session_id: MACHINE_ID, kind, summary, detail: null, created_at: createdAt(index),
}));

async function recordsList(json) {
  const streams = memoryStreams({ stdoutIsTTY: !json, stderrIsTTY: false });
  const exit = await runCli(["records", "list", ...(json ? ["--json"] : [])], {
    streams: streams.streams,
    platform: PLATFORM,
    env: { CUNA_API_KEY: API_KEY },
    fetch: recordsApi(ROWS),
  });
  assert.equal(exit, 0, streams.stderr());
  return streams.stdout();
}

test("records list names every Machine event 'Machine ...' and never 'Session' (snapshot over every kind)", async () => {
  const lines = (await recordsList(false)).trimEnd().split("\n");
  assert.deepEqual(lines, SERVER_RECORDS.map(([kind], index) =>
    `${createdAt(index)}\t${MACHINE_ID}\t${MACHINE_LABELS[kind]}`));
  for (const line of lines) assert.doesNotMatch(line, /session/iu, line);
});

test("records list --json keeps the stored kind and summary and adds the label a person reads", async () => {
  const record = JSON.parse(await recordsList(true));
  assert.equal(record.command, "records.list");
  assert.equal(record.data.items.length, SERVER_RECORDS.length);
  for (const [index, [kind, summary]] of SERVER_RECORDS.entries()) {
    const item = record.data.items[index];
    assert.equal(item.kind, kind, "the stored kind is data and stays");
    assert.equal(item.summary, summary, "the stored summary is data and stays");
    assert.equal(item.label, MACHINE_LABELS[kind], kind);
  }
});

/** Loaded per test, so the rendering tests above run even where the map is absent. */
async function labels() {
  return (await import("../dist/cli/record-labels.js")).recordLabel;
}

test("create and start are different events and read differently", async () => {
  const recordLabel = await labels();
  // The database summarises both as "Session started".
  assert.equal(recordLabel("session.create", "machine"), "Machine created");
  assert.equal(recordLabel("session.start", "machine"), "Machine started");
});

test("the record's resource, not the kind's prefix, decides the noun (R3.2)", async () => {
  const recordLabel = await labels();
  // One kind, three resources: only the resource varies.
  assert.equal(recordLabel("session.create", "machine"), "Machine created");
  assert.equal(recordLabel("session.create", "agent_session"), "Session created");
  assert.equal(recordLabel("session.stop", "agent_session"), "Session stopped");
  assert.equal(recordLabel("session.stop", "machine"), "Machine stopped");
  // A kind this build does not know still gets the resource's noun, never the
  // wire prefix.
  assert.equal(recordLabel("session.hibernate", "machine"), "Machine activity");
  assert.equal(recordLabel("session.hibernate", "agent_session"), "Session activity");
  // The kind is the server's string; a prototype name is not a label.
  assert.equal(recordLabel("toString", "machine"), "Machine activity");
});
