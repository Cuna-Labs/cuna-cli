// A spend figure this build does not recognise stops one command, not the
// product.
//
// `/v1/me` carries identity and usage in one payload. Validating them together
// meant an unknown usage key threw the whole response away, so every command
// that needs to know who you are — including the one that opens a terminal —
// died on a number none of them read. Strictness belongs where the figure is
// consumed.
import test from "node:test";
import assert from "node:assert/strict";

import { decodeCunaIdentity } from "../dist/api/contracts.js";
import { EXIT_CODES, memoryStreams, runCli } from "../dist/index.js";

const ID = "c6b17f6e-4439-4d04-94e3-22f2fac63ab5";
const WORKSPACE_ID = "ee63f9f1-8e39-4ec8-80fc-fbc2678a0388";

const GOOD_USAGE = Object.freeze({
  est_spend_usd: 1.25,
  est_spend_is_lower_bound: true,
  balance_status: "unavailable",
  balance_usd: null,
  balance_unavailable_reason: "no balance endpoint",
  note: "estimate",
});

function identity(usage) {
  return { id: ID, email: "someone@example.test", workspace: { assigned: true, id: WORKSPACE_ID, usage } };
}

// Every way the usage half can be off contract. Each must leave identity intact.
const OFF_CONTRACT = [
  ["an extra key the build does not know", { ...GOOD_USAGE, est_remaining_usd: 22.12 }],
  ["a missing required key", { est_spend_usd: 1, note: "estimate" }],
  ["a balance vocabulary this build does not know", { ...GOOD_USAGE, balance_status: "pending" }],
  ["a balance that is zero instead of null", { ...GOOD_USAGE, balance_usd: 0 }],
  ["a spend that is not a number", { ...GOOD_USAGE, est_spend_usd: "1.25" }],
];

for (const [what, usage] of OFF_CONTRACT) {
  test(`identity survives ${what}`, () => {
    const decoded = decodeCunaIdentity(identity(usage));
    assert.equal(decoded.id, ID);
    assert.equal(decoded.workspaceId, WORKSPACE_ID);
    assert.equal(decoded.workspaceAssigned, true);
    // The figure is withheld and the reason is kept for the one command that
    // reads it.
    assert.equal(decoded.workspaceUsage, undefined);
    assert.equal(typeof decoded.workspaceUsageProblem, "string");
  });
}

test("a usage payload on contract still decodes", () => {
  const decoded = decodeCunaIdentity(identity(GOOD_USAGE));
  assert.equal(decoded.workspaceUsageProblem, undefined);
  assert.equal(decoded.workspaceUsage?.estimatedSpendUsd, 1.25);
  assert.equal(decoded.workspaceUsage?.balanceStatus, "unavailable");
});

test("NEGATIVE CONTROL: a broken IDENTITY still fails the whole decode", () => {
  // The scope of the tolerance is exactly `workspace.usage`. If a missing
  // workspace id or an unknown top-level key were also tolerated, this change
  // would have replaced a strict decoder with no decoder.
  assert.throws(() => decodeCunaIdentity({
    id: ID,
    email: "someone@example.test",
    workspace: { assigned: true, usage: GOOD_USAGE },
  }));
  assert.throws(() => decodeCunaIdentity({
    ...identity(GOOD_USAGE),
    surprise: true,
  }));
  assert.throws(() => decodeCunaIdentity({
    id: ID,
    email: "someone@example.test",
    workspace: { assigned: true, id: WORKSPACE_ID, usage: GOOD_USAGE, surprise: true },
  }));
});

async function run(argv, usage) {
  const streams = memoryStreams({ stdoutIsTTY: false, stderrIsTTY: false });
  const exit = await runCli([...argv, "--json"], {
    streams: streams.streams,
    platform: {
      kind: "linux",
      paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
      async readSafeConfig() { return { exists: false }; },
    },
    env: {},
    humanAuth: { async acquireAccessToken() { return `cuna_at_${"a".repeat(43)}`; } },
    clientFactory: () => ({
      async getIdentity() { return decodeCunaIdentity(identity(usage)); },
    }),
  });
  const out = streams.stdout().trim() || streams.stderr().trim();
  return { exit, record: out === "" ? undefined : JSON.parse(out.split("\n").at(-1)) };
}

test("the commands that only need identity keep working while usage is off contract", async () => {
  const broken = { ...GOOD_USAGE, est_remaining_usd: 22.12 };
  for (const argv of [["account", "show"], ["workspace", "show"]]) {
    const run_ = await run(argv, broken);
    assert.equal(run_.exit, EXIT_CODES.success, `${argv.join(" ")}: ${JSON.stringify(run_.record)}`);
  }
});

test("usage show is the one command that refuses, and it says why", async () => {
  const run_ = await run(["usage", "show"], { ...GOOD_USAGE, est_remaining_usd: 22.12 });
  assert.equal(run_.exit, EXIT_CODES.remote);
  assert.equal(run_.record.error.code, "cuna.remote.malformed_response");
  assert.equal(run_.record.error.details.reason, "workspace_usage_off_contract");
  assert.match(run_.record.error.hint, /Every other command is unaffected/u);
});
