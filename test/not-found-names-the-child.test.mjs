// D9: a missing execution is the execution, not its Machine.
//
// Measured on the installed 0.1.3 on 2026-09-28: `cuna executions get
// <unknown> --machine M`, with M running and owned, said "Machine M is not
// available to this account." while the server's reason beside it was
// `managed_exec_not_found`.
import test from "node:test";
import assert from "node:assert/strict";

import { EXIT_CODES, memoryStreams, runCli } from "../dist/index.js";

const PLATFORM = Object.freeze({
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
});
const MACHINE_ID = "11111111-1111-4111-8111-111111111111";
const EXECUTION_ID = "22222222-2222-4222-8222-222222222222";

/** A typed 404 the API itself answered, carrying `code` as its reason. */
function problem404(code) {
  return async () => new Response(JSON.stringify({
    type: `https://api.getcuna.com/problems/${code}`,
    title: "Not found",
    status: 404,
    code,
    request_id: "99999999-9999-4999-8999-999999999999",
    retryable: false,
  }), { status: 404, headers: { "content-type": "application/problem+json" } });
}

async function refusal(argv, fetch) {
  const streams = memoryStreams();
  const exit = await runCli([...argv, "--json"], {
    streams: streams.streams,
    platform: PLATFORM,
    env: {},
    humanAuth: { async acquireAccessToken() { return `cuna_at_${"a".repeat(43)}`; } },
    fetch,
  });
  return { exit, error: JSON.parse(streams.stderr().trim().split("\n").at(-1)).error };
}

test("executions get for an unknown id names the execution, not an available Machine", async () => {
  const { exit, error } = await refusal(
    ["executions", "get", EXECUTION_ID, "--machine", MACHINE_ID],
    problem404("managed_exec_not_found"),
  );
  assert.equal(error.code, "cuna.remote.not_found");
  assert.equal(error.details.reason, "managed_exec_not_found");
  assert.equal(error.message, `Execution ${EXECUTION_ID} on Machine ${MACHINE_ID} is not available to this account.`);
  assert.match(error.hint, new RegExp(`cuna executions list --machine ${MACHINE_ID}`, "u"));
  // Deliberately unchanged: the published exit-code contract files a typed 404
  // under `remote` (7), and this build has no not-found code to move it to.
  assert.equal(exit, EXIT_CODES.remote);
});

test("control: a 404 on the Machine itself still names the Machine", async () => {
  const { error } = await refusal(["agent-sessions", "list", "--machine", MACHINE_ID], problem404("resource_not_found"));
  assert.equal(error.message, `Machine ${MACHINE_ID} is not available to this account.`);
});
