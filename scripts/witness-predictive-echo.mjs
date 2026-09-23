// Local witness for predictive echo (PRD cuna-cli-feel R9/R10).
//
// Drives the real built ForegroundTerminalCoordinator against a fake runtime
// whose remote echoes each input byte after a delay, feeds every host write
// into @xterm/headless in arrival order, and times each typed glyph:
//   perceived: key -> first host frame that shows the glyph at its cell, any style
//   real:      key -> first host frame that shows it neither dim nor underlined
//   stale:     dim+underlined cells on the host screen 1 s after the last key
// Two remote renderers: `shell` (visible cursor, raw echo) and `ink` (hidden
// cursor, the line repainted with a one-cell inverse block after the text).
//
// This proves the local painting path only. The network, Edge, Machine and
// agent are replaced by a timer; a live number needs a live Machine.
//
// usage: npm run build && node scripts/witness-predictive-echo.mjs [--out FILE] [--quick]

import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import xterm from "@xterm/headless";

import { ForegroundTerminalCoordinator } from "../dist/index.js";

const encoder = new TextEncoder();
const COLUMNS = 120;
const ROWS = 40;
const APPBAR_ROWS = 2;
const PROMPT = "> ";
const WARMUP_KEYS = "abc";
const KEYS = "abcdefghijklmnopqrstuvwxyz0123456789";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A seeded generator so a jittered run is reproducible. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** The remote application: owns its line, answers each byte with output bytes. */
function remoteRenderer(kind) {
  let row = 0;
  let text = "";
  const inkLine = () => `\u001b[?25l\u001b[${row + 1};1H\u001b[2K${PROMPT}${text}\u001b[7m \u001b[27m`;
  return {
    get row() { return row; },
    get column() { return PROMPT.length + text.length; },
    start() { return kind === "shell" ? `\u001b[H\u001b[2J${PROMPT}` : `\u001b[H\u001b[2J${inkLine()}`; },
    byte(byte) {
      if (byte === 0x0c) return kind === "ink" ? inkLine() : "";
      if (byte === 0x0d) {
        if (kind === "shell") { row += 1; text = ""; return `\r\n${PROMPT}`; }
        // Ink redraws the submitted line without its cursor block.
        const submitted = `\u001b[${row + 1};1H\u001b[2K${PROMPT}${text}`;
        row += 1; text = "";
        return `${submitted}${inkLine()}`;
      }
      if (byte < 0x20 || byte > 0x7e) return "";
      text += String.fromCharCode(byte);
      return kind === "shell" ? String.fromCharCode(byte) : inkLine();
    },
  };
}

class WitnessHost {
  columns = COLUMNS;
  rows = ROWS;
  input;
  #terminal = new xterm.Terminal({ cols: COLUMNS, rows: ROWS, allowProposedApi: true });
  #tail = Promise.resolve();
  #watchers = [];
  dimensions() { return { columns: this.columns, rows: this.rows }; }
  async acquire() { return { restore: async () => undefined }; }
  onInput(listener) { this.input = listener; return () => { this.input = undefined; }; }
  onResize() { return () => undefined; }
  async write(bytes) {
    const at = performance.now();
    const copy = bytes.slice();
    this.#tail = this.#tail.then(() => new Promise((resolve) => this.#terminal.write(copy, resolve))).then(() => {
      for (const watcher of this.#watchers.slice()) watcher(at);
    });
  }
  settled() { return this.#tail; }
  cell(hostRow, column) {
    const cell = this.#terminal.buffer.active.getLine(hostRow)?.getCell(column);
    if (cell === undefined) return undefined;
    return { chars: cell.getChars(), dim: cell.isDim() !== 0, underline: cell.isUnderline() !== 0 };
  }
  predictedCells() {
    let count = 0;
    for (let row = 0; row < ROWS; row += 1) {
      const line = this.#terminal.buffer.active.getLine(row);
      for (let column = 0; column < COLUMNS; column += 1) {
        const cell = line?.getCell(column);
        if (cell !== undefined && cell.isDim() !== 0 && cell.isUnderline() !== 0 && cell.getChars().trim() !== "") count += 1;
      }
    }
    return count;
  }
  watch(listener) { this.#watchers.push(listener); return () => { this.#watchers = this.#watchers.filter((item) => item !== listener); }; }
  dispose() { this.#terminal.dispose(); }
}

function quantile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))].toFixed(1));
}

function summary(samples, field) {
  const values = samples.map((sample) => sample[field]).filter((value) => value !== null);
  return { n: values.length, missing: samples.length - values.length, p50: quantile(values, 0.5), p95: quantile(values, 0.95), max: quantile(values, 1) };
}

/** One coordinator, one remote, one mode: isolated keys then bursts. */
export async function runScenario({ renderer, mode, delay, isolatedKeys = 30, bursts = 10, burstSize = 10, burstGapMs = 25, seed = 1 }) {
  const host = new WitnessHost();
  const remote = remoteRenderer(renderer);
  const coordinator = new ForegroundTerminalCoordinator({ host, resizeCoalesceMs: 5, predictiveEcho: mode });
  const callbacks = coordinator.runtimeCallbacks();
  const intent = { tabId: "tab-a", agentSessionId: "11111111-1111-4111-8111-111111111111", label: "witness", agent: "claude-code" };
  const snapshot = {
    tabId: intent.tabId, viewId: "tab-a:attachment:1", userId: "user-1", machineId: "machine-1",
    workspaceBindingId: null, workspaceBindingGeneration: null, agentSessionId: intent.agentSessionId,
    processEpoch: `epoch-${intent.agentSessionId}`, state: "active", fencingGeneration: 1, inputSequence: 0n,
    outputSequence: 0n, outputContinuity: "complete", resizeCapability: "live", accessMode: "writer", writerEpoch: 1,
    writerTransferCapability: { supported: true, reasonCode: null, expiresAt: Date.now() + 600_000 },
    heartbeatObservedAt: 100, heartbeatExpiresAt: 200,
  };
  const binding = { userId: "user-1", machineId: "machine-1", agentSessionId: intent.agentSessionId, processEpoch: snapshot.processEpoch, fencingGeneration: 1 };
  let sequence = 0n;
  let remoteTail = Promise.resolve();
  const emit = (text) => {
    if (text === "") return;
    sequence += 1n;
    const bytes = encoder.encode(text);
    const current = sequence;
    remoteTail = remoteTail.then(() => callbacks.onTerminalOutput({
      provenance: "live", tabId: intent.tabId, agentSessionId: intent.agentSessionId, binding,
      sequence: current, bytes, signal: new AbortController().signal,
    })).catch(() => undefined);
  };
  // In-order delivery, like one TCP stream: a byte is never echoed before an
  // earlier one. One queue and one pump; separate timers with equal due times
  // are not guaranteed to fire in creation order.
  const next = random(seed);
  let lastDue = 0;
  const delayOf = () => typeof delay === "number" ? delay : delay.min + next() * (delay.max - delay.min);
  const queue = [];
  let pump;
  const schedule = () => {
    if (pump !== undefined || queue.length === 0) return;
    pump = setTimeout(() => {
      pump = undefined;
      while (queue.length > 0 && queue[0].due <= performance.now()) emit(remote.byte(queue.shift().byte));
      schedule();
    }, Math.max(0, queue[0].due - performance.now()));
  };
  coordinator.bindRuntime({
    async attach() { await callbacks.onTerminalReady(snapshot); return snapshot; },
    async detach() {}, async takeWriter() { return snapshot; }, async reconnect() { return snapshot; },
    async sendInput(bytes) {
      for (const byte of bytes) {
        const due = Math.max(lastDue, performance.now() + delayOf());
        lastDue = due;
        queue.push({ due, byte });
      }
      schedule();
    },
    async resize() {}, switchActive() { return snapshot; }, async sendTerminalResponse() {}, async sendLocalActionControl() {},
  });

  const samples = [];
  const pending = new Set();
  const stopWatching = host.watch((at) => {
    for (const sample of Array.from(pending)) {
      const cell = host.cell(APPBAR_ROWS + sample.row, sample.column);
      if (cell === undefined || cell.chars !== sample.glyph) continue;
      sample.perceived ??= at - sample.sentAt;
      if (!cell.dim && !cell.underline) { sample.real = at - sample.sentAt; pending.delete(sample); }
    }
  });
  const expected = { row: 0, column: PROMPT.length };
  const type = (glyph, phase) => {
    const sample = { phase, glyph, row: expected.row, column: expected.column, sentAt: performance.now(), perceived: null, real: null };
    expected.column += 1;
    if (phase !== "warmup") { samples.push(sample); pending.add(sample); }
    host.input(encoder.encode(glyph));
    return sample;
  };
  const waitFor = async (predicate, timeoutMs) => {
    const deadline = performance.now() + timeoutMs;
    while (!predicate() && performance.now() < deadline) await sleep(5);
  };
  const newline = async () => {
    host.input(Uint8Array.of(0x0d));
    expected.row += 1; expected.column = PROMPT.length;
    // Enter is a barrier: let its echo land and the barrier lapse before the next key.
    await sleep(maxDelay(delay) + 400);
  };

  let staleAfterLastKey = null;
  try {
    await coordinator.start([intent]);
    emit(remote.start());
    await sleep(100);
    for (const glyph of WARMUP_KEYS) { type(glyph, "warmup"); await sleep(maxDelay(delay) + 150); }
    for (let index = 0; index < isolatedKeys; index += 1) {
      const sample = type(KEYS[index % KEYS.length], "isolated");
      await waitFor(() => sample.real !== null, 3_000);
      await sleep(50);
    }
    for (let burst = 0; burst < bursts; burst += 1) {
      await newline();
      let last;
      for (let index = 0; index < burstSize; index += 1) {
        last = type(KEYS[(burst * burstSize + index) % KEYS.length], `burst-${burst}-key-${index}`);
        if (index < burstSize - 1) await sleep(burstGapMs);
      }
      await waitFor(() => last.real !== null, 5_000);
      await sleep(100);
    }
    const lastSent = Math.max(...samples.map((sample) => sample.sentAt));
    await sleep(Math.max(0, lastSent + 1_000 - performance.now()));
    await host.settled();
    staleAfterLastKey = host.predictedCells();
  } finally {
    if (pump !== undefined) clearTimeout(pump);
    stopWatching();
    await coordinator.stop().catch(() => undefined);
    host.dispose();
  }
  const isolated = samples.filter((sample) => sample.phase === "isolated");
  const burst = samples.filter((sample) => sample.phase.startsWith("burst"));
  const byIndex = Array.from({ length: burstSize }, (_, index) => {
    const at = burst.filter((sample) => sample.phase.endsWith(`-key-${index}`));
    return { key: index, perceivedP50: summary(at, "perceived").p50, realP50: summary(at, "real").p50 };
  });
  return {
    renderer, mode, delay,
    isolated: { perceived: summary(isolated, "perceived"), real: summary(isolated, "real") },
    burst: { perceived: summary(burst, "perceived"), real: summary(burst, "real"), byKeyIndex: byIndex },
    staleDimUnderlinedCellsOneSecondAfterLastKey: staleAfterLastKey,
    notes: `first ${WARMUP_KEYS.length} keys typed unmeasured: predictions are shown only after 3 exact echoes`,
  };
}

function maxDelay(delay) { return typeof delay === "number" ? delay : delay.max; }

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args[outIndex + 1] : "predictive-echo-witness.json";
  const quick = args.includes("--quick");
  const shape = quick ? { isolatedKeys: 5, bursts: 2 } : {};
  const scenarios = [];
  for (const renderer of ["shell", "ink"]) {
    for (const delay of [200, { min: 150, max: 450 }]) {
      for (const mode of ["on", "off"]) {
        const result = await runScenario({ renderer, mode, delay, ...shape });
        scenarios.push(result);
        console.log(JSON.stringify({ renderer, mode, delay, isolated: result.isolated, burstPerceived: result.burst.perceived, burstReal: result.burst.real, stale: result.staleDimUnderlinedCellsOneSecondAfterLastKey }));
      }
    }
  }
  const report = {
    witness: "scripts/witness-predictive-echo.mjs",
    class: "LOCAL_EXECUTION (real coordinator, timer-simulated remote)",
    host: { platform: process.platform, node: process.version },
    at: new Date().toISOString(),
    scenarios,
  };
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
  process.exit(0);
}
