// D4: a read whose answer never arrived is not a mutation.
//
// Measured on the installed 0.1.3 on 2026-09-28: `cuna machines list` exited 5
// after 22.1 s with `cuna.client.response_budget_elapsed`, and its hint said
// "Re-read the resource with a read-only `cuna` command before re-issuing this
// mutation". The command only reads.
import test from "node:test";
import assert from "node:assert/strict";

import { EXIT_CODES, createHttpTransport, memoryStreams, runCli } from "../dist/index.js";

const PLATFORM = Object.freeze({
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
});
const MACHINE_ID = "11111111-1111-4111-8111-111111111111";

const neverAnswers = async (_url, init) => new Promise((_resolve, reject) => {
  init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
});

test("a read that runs out of budget says it changed nothing and never mentions a mutation", async () => {
  const streams = memoryStreams();
  const exit = await runCli(["machines", "list", "--timeout-ms", "100", "--json"], {
    streams: streams.streams,
    platform: PLATFORM,
    env: {},
    humanAuth: { async acquireAccessToken() { return `cuna_at_${"a".repeat(43)}`; } },
    fetch: neverAnswers,
  });
  assert.equal(exit, EXIT_CODES.network, streams.stderr());
  const { error } = JSON.parse(streams.stderr().trim().split("\n").at(-1));
  assert.equal(error.code, "cuna.client.response_budget_elapsed");
  assert.match(error.message, /GET \/v1\/sessions/u);
  assert.doesNotMatch(error.hint, /mutation/iu, error.hint);
  assert.doesNotMatch(error.hint, /may have completed/iu, error.hint);
  assert.match(error.hint, /only reads, so nothing was changed; run the same command again\./u, error.hint);
});

test("control: a mutation that runs out of budget still says it may have applied", async () => {
  const transport = createHttpTransport({ baseUrl: "https://api.getcuna.com", timeoutMs: 5, fetch: neverAnswers });
  await assert.rejects(
    transport.request({ method: "DELETE", path: `/v1/sessions/${MACHINE_ID}` }),
    (error) => {
      assert.equal(error.code, "cuna.client.response_budget_elapsed");
      assert.match(error.hint, /may have completed/u);
      assert.match(error.hint, /before re-issuing this mutation/u);
      return true;
    },
  );
});
