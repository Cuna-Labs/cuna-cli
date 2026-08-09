import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { runProcessCli } from "../dist/cli/process-entrypoint.js";

test("installed process entrypoint translates SIGINT into one abort and removes listeners", async () => {
  const host = new EventEmitter();
  let observedSignal;
  const exit = await runProcessCli(["login"], {
    host,
    run: async (_argv, dependencies) => {
      observedSignal = dependencies.signal;
      assert.equal(observedSignal.aborted, false);
      host.emit("SIGINT");
      assert.equal(observedSignal.aborted, true);
      return 3;
    },
  });
  assert.equal(exit, 3);
  assert.equal(observedSignal.aborted, true);
  assert.equal(host.listenerCount("SIGINT"), 0);
  assert.equal(host.listenerCount("SIGTERM"), 0);
});

test("installed process entrypoint translates SIGTERM and also cleans up after failure", async () => {
  const host = new EventEmitter();
  await assert.rejects(runProcessCli([], {
    host,
    run: async (_argv, dependencies) => {
      host.emit("SIGTERM");
      assert.equal(dependencies.signal.aborted, true);
      throw new Error("expected test failure");
    },
  }), /expected test failure/u);
  assert.equal(host.listenerCount("SIGINT"), 0);
  assert.equal(host.listenerCount("SIGTERM"), 0);
});
