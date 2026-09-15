import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  loginFixture,
  SYNTHETIC_LOGIN_CODE,
} from "./fixtures/login-progress.mjs";

const root = path.resolve(import.meta.dirname, "..");
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("accepted hidden code starts progress through held exchange and persistence, then stops", async () => {
  const exchange = deferred(),
    persist = deferred(),
    entered = deferred(),
    writing = deferred(),
    code = deferred();
  const fixture = await loginFixture(root, {
    phase(name) {
      if (name === "exchange_started") entered.resolve();
      if (name === "persistence_started") writing.resolve();
    },
    hold: (stage) =>
      stage === "exchange" ? exchange.promise : persist.promise,
  });
  const streams = fixture.memoryStreams({
    stdoutIsTTY: true,
    stdinIsTTY: true,
    stderrIsTTY: true,
  });
  const run = fixture.runCli(["login", "--no-color"], {
    ...fixture.dependencies,
    streams: streams.streams,
    readLoginCode: () => code.promise,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.doesNotMatch(streams.stderr(), /Completing Cuna sign-in/);
  code.resolve(SYNTHETIC_LOGIN_CODE);
  await entered.promise;
  try {
    assert.match(streams.stderr(), /Completing Cuna sign-in/);
    assert.equal(fixture.values.size, 0);
    exchange.resolve();
    await writing.promise;
    assert.match(streams.stderr(), /Completing Cuna sign-in/);
    persist.resolve();
    assert.equal(await run, 0);
    const stopped = streams.stderr();
    await new Promise((resolve) => setTimeout(resolve, 130));
    assert.equal(streams.stderr(), stopped);
    assert.doesNotMatch(streams.stdout(), /Completing/);
    assert.ok(!streams.stderr().includes(SYNTHETIC_LOGIN_CODE));
  } finally {
    exchange.resolve();
    persist.resolve();
    await run;
  }
});

test("invalid code never starts completion progress or exchanges", async () => {
  const phases = [];
  const fixture = await loginFixture(root, {
    phase: (name) => phases.push(name),
  });
  const streams = fixture.memoryStreams({
    stdoutIsTTY: true,
    stdinIsTTY: true,
    stderrIsTTY: true,
  });
  assert.notEqual(
    await fixture.runCli(["login"], {
      ...fixture.dependencies,
      streams: streams.streams,
      readLoginCode: async () => "invalid",
    }),
    0,
  );
  assert.doesNotMatch(streams.stderr(), /Completing Cuna sign-in/);
  assert.equal(phases.includes("exchange_started"), false);
  assert.equal(fixture.values.size, 0);
});

test("cancellation during exchange stops progress without persistence", async () => {
  const controller = new AbortController(),
    entered = deferred();
  const fixture = await loginFixture(root, {
    phase: (name) => {
      if (name === "exchange_started") entered.resolve();
    },
    hold: async (stage, signal) => {
      if (stage !== "exchange") return;
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });
  const streams = fixture.memoryStreams({
    stdoutIsTTY: true,
    stdinIsTTY: true,
    stderrIsTTY: true,
  });
  const run = fixture.runCli(["login"], {
    ...fixture.dependencies,
    streams: streams.streams,
    signal: controller.signal,
    readLoginCode: async () => SYNTHETIC_LOGIN_CODE,
  });
  await entered.promise;
  controller.abort();
  assert.match(streams.stderr(), /Stopping Cuna sign-in/);
  assert.notEqual(await run, 0);
  assert.equal(fixture.values.size, 0);
  assert.doesNotMatch(streams.stdout(), /Signed in/);
  const stopped = streams.stderr();
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(streams.stderr(), stopped);
});
