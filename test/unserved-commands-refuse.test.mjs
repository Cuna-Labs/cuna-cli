// D1: help must not advertise, and the CLI must not send, what the API version
// it speaks does not serve.
//
// Measured 2026-09-28: `cuna help --all` listed `machines live-update-supervisor`
// and `machines live-update-status` under "Available now", and the deployed
// Edge (`d3d3d3c`) answered their route with 404 `operation_not_served`. The
// vendored contract is now that producer's, which also has no sharing-state
// reading, the question `cuna share` asks.
import test from "node:test";
import assert from "node:assert/strict";

import { EXIT_CODES, memoryStreams, runCli } from "../dist/index.js";
import { FULL_HELP } from "../dist/cli/help.js";

const PLATFORM = Object.freeze({
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
});
const MACHINE_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "00000000-0000-4000-8000-000000000000";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const UNSERVED = Object.freeze([
  ["machines", "live-update-supervisor", MACHINE_ID, "--yes"],
  ["machines", "live-update-status", MACHINE_ID, "--operation", OPERATION_ID],
  ["share", "--project", PROJECT_ID],
]);

function availableNow() {
  const start = FULL_HELP.indexOf("Available now:");
  return FULL_HELP.slice(start, FULL_HELP.indexOf("\n\n", start));
}

test("help --all lists no command the vendored API contract cannot serve under Available now", () => {
  const section = availableNow();
  for (const command of ["machines live-update-supervisor", "machines live-update-status", "share --project"]) {
    assert.doesNotMatch(section, new RegExp(`^ {2}${command}`, "mu"), `${command} is listed as available`);
  }
  assert.match(FULL_HELP, /^Not served by this Cuna API version/mu);
  for (const key of ["machines live-update-supervisor", "machines live-update-status", "share"]) {
    assert.match(FULL_HELP, new RegExp(`^ {2}\\[unserved\\] ${key} :: `, "mu"), key);
  }
  // Control: a served command stays where it was.
  assert.match(section, /^ {2}machines update-supervisor ID/mu);
});

test("an unserved command refuses before any configuration, credential or request", async () => {
  for (const argv of UNSERVED) {
    let requests = 0;
    const streams = memoryStreams();
    const exit = await runCli([...argv, "--json"], {
      streams: streams.streams,
      platform: PLATFORM,
      env: { CUNA_API_KEY: "cuna_sk_abcdefghijklmnop" },
      fetch: async () => { requests += 1; return new Response("{}", { status: 200 }); },
    });
    const { error } = JSON.parse(streams.stderr().trim().split("\n").at(-1));
    assert.equal(requests, 0, `${argv.join(" ")} sent a request`);
    assert.equal(exit, EXIT_CODES.unsupported, argv.join(" "));
    assert.equal(error.code, "cuna.contract.operation_not_served", argv.join(" "));
    assert.match(error.message, /is not served by this Cuna API version\./u);
    assert.match(error.hint, /Nothing was sent\./u);
  }
});
