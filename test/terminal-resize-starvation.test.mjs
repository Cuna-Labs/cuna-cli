import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ForegroundTerminalCoordinator } from "../dist/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function exercise({ mismatch, interval, latestGeometry = false }) {
  const paints = [];
  const resizes = [];
  let resizeListener;
  const host = {
    columns: 80, rows: 24,
    dimensions() { return { columns: this.columns, rows: this.rows }; },
    async acquire() { return { async restore() {} }; },
    async write(bytes) { paints.push({ time: performance.now(), text: decoder.decode(bytes) }); },
    onInput() { return () => {}; },
    onResize(listener) { resizeListener = listener; return () => { resizeListener = undefined; }; },
  };
  // Exercise the production default 50ms coalescing interval and real VTE.
  const coordinator = new ForegroundTerminalCoordinator({ host });
  const callbacks = coordinator.runtimeCallbacks();
  const intent = { tabId: "resize-test", agentSessionId: "11111111-1111-4111-8111-111111111111", label: "synthetic", agent: "claude-code" };
  const ready = {
    ...intent, viewId: "resize-attachment", userId: "synthetic-user", machineId: "synthetic-machine",
    workspaceBindingId: null, workspaceBindingGeneration: null,
    processEpoch: "synthetic-epoch", state: "active", fencingGeneration: 1,
    inputSequence: 0n, outputSequence: 0n, outputContinuity: "complete",
    resizeCapability: "live", accessMode: "writer", writerEpoch: 1,
    writerTransferCapability: { supported: true, reasonCode: null, expiresAt: Date.now() + 60_000 },
    heartbeatObservedAt: Date.now(), heartbeatExpiresAt: Date.now() + 60_000,
  };
  const binding = Object.fromEntries(["userId", "machineId", "agentSessionId", "processEpoch", "fencingGeneration"].map(key => [key, ready[key]]));
  coordinator.bindRuntime({
    async attach() { await callbacks.onTerminalReady(ready); return ready; },
    async detach() {}, async sendInput() {}, async sendTerminalResponse() {},
    async resize(columns, rows) { resizes.push({ time: performance.now(), columns, rows }); },
    switchActive() { return ready; },
  });
  try {
    await coordinator.start([intent]);
    paints.length = 0;
    resizes.length = 0;
    const started = performance.now();
    if (mismatch) { host.columns = 100; host.rows = 30; resizeListener(); }
    const samples = [];
    for (let sequence = 1; sequence <= (interval === 10 ? 40 : 5); sequence += 1) {
      if (latestGeometry && sequence === 2) { host.columns = 110; host.rows = 33; resizeListener(); }
      await callbacks.onTerminalOutput({
        provenance: "live", tabId: intent.tabId, agentSessionId: intent.agentSessionId,
        binding, sequence: BigInt(sequence), signal: new AbortController().signal,
        bytes: encoder.encode(`\u001b[HAPPROVAL_SENTINEL ${sequence}`),
      });
      samples.push({ elapsed: Math.round(performance.now() - started), sequence, paints: paints.length, resizes: resizes.length });
      await delay(interval);
    }
    const during = { paints: paints.length, resizes: resizes.length, prompt: paints.some(p => p.text.includes("APPROVAL_SENTINEL")) };
    await delay(100);
    return {
      mismatch, interval, samples, during,
      after: { paints: paints.length, resizes: resizes.length, prompt: paints.some(p => p.text.includes("APPROVAL_SENTINEL")) },
      firstPaintMs: paints[0] ? Math.round(paints[0].time - started) : null,
      firstResizeMs: resizes[0] ? Math.round(resizes[0].time - started) : null,
      lastResize: resizes.at(-1) ? { columns: resizes.at(-1).columns, rows: resizes.at(-1).rows } : null,
    };
  } finally { await coordinator.stop(); }
}

for (const scenario of [
  { mismatch: false, interval: 10 },
  { mismatch: true, interval: 100 },
  { mismatch: true, interval: 10 },
  { mismatch: true, interval: 10, latestGeometry: true },
]) {
  test(`approval output remains visible during ${scenario.interval}ms frames; geometry mismatch=${scenario.mismatch}; latest geometry=${scenario.latestGeometry ?? false}`, async t => {
    const result = await exercise(scenario);
    t.diagnostic(JSON.stringify(result));
    assert.equal(result.after.prompt, true, "the prompt reaches the real VTE and eventually paints");
    assert.equal(result.during.prompt, true, "continuous output must not defer all prompt paints until traffic stops");
    if (scenario.mismatch) assert.ok(result.during.resizes > 0, "one geometry change must settle while output continues");
    if (scenario.latestGeometry) assert.deepEqual(result.lastResize, { columns: 110, rows: 31 }, "reconciliation reads the latest host size, excluding the two trusted rows");
  });
}
