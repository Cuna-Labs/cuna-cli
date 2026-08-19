import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import { createOutputWriter } from "../dist/cli/output.js";
import { createJourneyPresentation, TERMINAL_CURSOR_SEQUENCES } from "../dist/cli/presentation.js";

function capture() {
  let value = "";
  return Object.freeze({
    stream: new Writable({ write(chunk, _encoding, callback) { value += chunk.toString(); callback(); } }),
    value: () => value,
  });
}

function phase(renderer, type, name = "create-machine") {
  renderer.onPhase({ type, phase: name });
}

test("renderer has failure-capable JSON and non-TTY guards", () => {
  const emit = ({ json, stderrIsTTY }) => {
    const stderr = capture();
    const renderer = createJourneyPresentation({ stderr: stderr.stream, json, stderrIsTTY, color: false });
    phase(renderer, "started");
    renderer.close();
    return stderr.value();
  };

  // Negative controls: deleting either half of the guard makes the matching
  // empty assertion below fail, while the TTY control proves the instrument can
  // observe escape bytes rather than merely asserting an always-empty sink.
  assert.equal(emit({ json: true, stderrIsTTY: true }), "");
  assert.equal(emit({ json: false, stderrIsTTY: false }), "");
  assert.ok(emit({ json: false, stderrIsTTY: true }).includes(TERMINAL_CURSOR_SEQUENCES.show));
});

test("renderer leaves timed progress and a durable result, then restores the cursor", () => {
  const stderr = capture();
  let now = 0;
  let tick;
  const renderer = createJourneyPresentation({
    stderr: stderr.stream,
    stderrIsTTY: true,
    json: false,
    color: false,
    now: () => now,
    schedule(callback) { tick = callback; return 1; },
    cancel() {},
  });
  phase(renderer, "started", "synchronize-workspace");
  now = 1_000;
  renderer.onPhase({
    type: "progress",
    phase: "synchronize-workspace",
    progress: { completedBytes: 512, totalBytes: 1_024, completedFiles: 1, totalFiles: 2 },
  });
  tick();
  now = 1_500;
  phase(renderer, "completed", "synchronize-workspace");
  renderer.close();

  assert.match(stderr.value(), /50% 512 B\/1\.0 KiB 1\/2 files/u);
  assert.match(stderr.value(), /\[completed\] synchronize workspace - completed in 1\.5s/u);
  assert.ok(stderr.value().includes(TERMINAL_CURSOR_SEQUENCES.show));
});

test("renderer restores the cursor on an error event and SIGINT abort", () => {
  const failed = capture();
  const errorRenderer = createJourneyPresentation({ stderr: failed.stream, stderrIsTTY: true, json: false, color: false });
  phase(errorRenderer, "started");
  phase(errorRenderer, "failed");
  errorRenderer.close();
  assert.match(failed.value(), /\[failed\] create machine/u);
  assert.ok(failed.value().includes(TERMINAL_CURSOR_SEQUENCES.show));

  const interrupted = capture();
  const controller = new AbortController();
  const interruptRenderer = createJourneyPresentation({
    stderr: interrupted.stream,
    stderrIsTTY: true,
    json: false,
    color: false,
    signal: controller.signal,
  });
  phase(interruptRenderer, "started");
  controller.abort(new Error("SIGINT"));
  assert.match(interrupted.value(), /\[cancelled\] create machine/u);
  assert.ok(interrupted.value().includes(TERMINAL_CURSOR_SEQUENCES.show));
});

test("TTY tables are stderr presentation and structured stdout remains byte-stable", () => {
  const stdout = capture();
  const stderr = capture();
  const human = createOutputWriter({
    streams: { stdout: stdout.stream, stderr: stderr.stream, stdoutIsTTY: true, stdinIsTTY: true, stderrIsTTY: true },
    json: false,
  });
  human.success("machines.list", { items: [{ id: "m-1", name: "dev", state: "running" }] }, "m-1\tdev\trunning");
  assert.equal(stdout.value(), "");
  assert.match(stderr.value(), /^ID   NAME  STATE/mu);

  const jsonOut = capture();
  const jsonErr = capture();
  const structured = createOutputWriter({
    streams: { stdout: jsonOut.stream, stderr: jsonErr.stream, stdoutIsTTY: true, stdinIsTTY: true, stderrIsTTY: true },
    json: true,
  });
  structured.success("machines.list", { items: [{ id: "m-1", name: "dev", state: "running" }] }, "ignored");
  assert.equal(jsonErr.value(), "");
  assert.equal(jsonOut.value(), '{"schema_version":"1","type":"result","command":"machines.list","data":{"items":[{"id":"m-1","name":"dev","state":"running"}]}}\n');
});
