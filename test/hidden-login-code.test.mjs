import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { readHiddenLoginCode } from "../dist/cli/run.js";

const LOGIN_CODE = `cuna_login_${"a".repeat(43)}`;

function terminalInput() {
  const input = new PassThrough();
  const rawModes = [];
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode) => {
    rawModes.push(mode);
    input.isRaw = mode;
    return input;
  };
  return { input, rawModes };
}

function capturedOutput() {
  let text = "";
  return {
    output: new Writable({
      write(chunk, _encoding, callback) {
        text += chunk.toString("utf8");
        callback();
      },
    }),
    text: () => text,
  };
}

test("hidden login-code input suppresses pasted bytes and restores terminal mode", async () => {
  const { input, rawModes } = terminalInput();
  const output = capturedOutput();
  const reading = readHiddenLoginCode(input, output.output);
  input.write(`\u001b[200~${LOGIN_CODE}\u001b[201~\r`);

  assert.equal(await reading, LOGIN_CODE);
  assert.deepEqual(rawModes, [true, false]);
  assert.match(output.text(), /input hidden/u);
  assert.doesNotMatch(output.text(), new RegExp(LOGIN_CODE, "u"));
});

test("hidden login-code input rejects non-TTY and cancellation without echoing a credential", async () => {
  const output = capturedOutput();
  const nonTty = new PassThrough();
  await assert.rejects(
    readHiddenLoginCode(nonTty, output.output),
    (error) => error?.code === "cuna.auth.login_code_input_unavailable",
  );

  const { input, rawModes } = terminalInput();
  const controller = new AbortController();
  const cancelled = readHiddenLoginCode(input, output.output, controller.signal);
  input.write(LOGIN_CODE.slice(0, 12));
  controller.abort();
  await assert.rejects(cancelled, (error) => error?.code === "cuna.auth.login_code_input_cancelled");
  assert.deepEqual(rawModes, [true, false]);
  assert.doesNotMatch(output.text(), new RegExp(LOGIN_CODE.slice(0, 12), "u"));
});

test("hidden login-code input observes cancellation that races with raw-mode setup", async () => {
  const { input, rawModes } = terminalInput();
  const output = capturedOutput();
  const controller = new AbortController();
  const originalSetRawMode = input.setRawMode;
  input.setRawMode = (mode) => {
    const result = originalSetRawMode(mode);
    if (mode) controller.abort(new Error("operator interrupted during raw-mode setup"));
    return result;
  };
  const timeout = Symbol("hidden-reader-timeout");
  let timer;
  const pending = readHiddenLoginCode(input, output.output, controller.signal);
  const outcome = await Promise.race([
    pending.then(
      () => new Error("cancelled hidden input unexpectedly succeeded"),
      (error) => error,
    ),
    new Promise((resolve) => { timer = setTimeout(() => resolve(timeout), 100); }),
  ]);
  clearTimeout(timer);
  input.end();

  assert.notEqual(outcome, timeout, "raw-mode cancellation must not leave hidden input pending");
  assert.equal(outcome?.code, "cuna.auth.login_code_input_cancelled");
  assert.deepEqual(rawModes, [true, false]);
  assert.doesNotMatch(output.text(), new RegExp(LOGIN_CODE, "u"));
});
