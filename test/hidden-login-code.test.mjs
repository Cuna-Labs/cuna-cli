import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  input.pause();
  const output = capturedOutput();
  const reading = readHiddenLoginCode(input, output.output);
  assert.equal(input.isPaused(), false, "reading the code must temporarily resume stdin");
  input.write(`\u001b[200~${LOGIN_CODE}\u001b[201~\r`);

  assert.equal(await reading, LOGIN_CODE);
  assert.deepEqual(rawModes, [true, false]);
  assert.equal(input.isPaused(), true, "completed input must release the stdin handle so login can exit");
  assert.match(output.text(), /input hidden/u);
  assert.doesNotMatch(output.text(), new RegExp(LOGIN_CODE, "u"));
});

test("successful hidden login releases real process stdin and returns the shell prompt", async () => {
  const runModuleUrl = new URL("../dist/cli/run.js", import.meta.url).href;
  const processModuleUrl = new URL("../dist/cli/process-entrypoint.js", import.meta.url).href;
  const script = `
    import { readHiddenLoginCode } from ${JSON.stringify(runModuleUrl)};
    import { runProcessCli } from ${JSON.stringify(processModuleUrl)};
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "isRaw", { configurable: true, writable: true, value: false });
    process.stdin.setRawMode = (mode) => { process.stdin.isRaw = mode; return process.stdin; };
    process.exitCode = await runProcessCli(["login"], {
      stdin: process.stdin,
      run: async () => {
        const code = await readHiddenLoginCode(process.stdin, process.stderr);
        if (code !== ${JSON.stringify(LOGIN_CODE)}) throw new Error("login code mismatch");
        return 0;
      },
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
  child.stdin.write(`${LOGIN_CODE}\r`);

  let timer;
  const outcome = await Promise.race([
    new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
    new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), 2_000); }),
  ]);
  clearTimeout(timer);
  if (outcome === "timeout") child.kill();

  assert.notEqual(outcome, "timeout", "login must exit without waiting for Ctrl-C or stdin EOF");
  assert.deepEqual(outcome, { code: 0, signal: null });
});

/**
 * The masked echo, and why it is tested separately from the suppression above.
 *
 * Suppression and feedback are two different properties and only one of them
 * had a test. "The code never appears in the output" is satisfied by writing
 * NOTHING, which is what the reader used to do and what the owner reported as
 * unusable: with no echo at all, an empty clipboard, a successful paste and a
 * double paste are the same screen. So these assert the second property — that
 * the screen is a truthful count of the bytes that will be submitted — and they
 * assert it with exact lengths, because a mask that renders a fixed number of
 * stars, or that counts the terminal's paste framing as credential bytes, would
 * satisfy every "does not contain the code" assertion in this file.
 */
const MASK = "*";
const PROMPT = "Paste the login code (input hidden): ";
/** The destructive erase: back up, overwrite with a space, back up again. */
const ERASE = "\b \b";

function countOf(text, needle) {
  return text.split(needle).length - 1;
}

function masksIn(text) {
  return countOf(text, MASK);
}

test("masked echo shows one character per accepted byte and never the byte", async () => {
  const { input } = terminalInput();
  const output = capturedOutput();
  const reading = readHiddenLoginCode(input, output.output);
  input.write(`\u001b[200~${LOGIN_CODE}\u001b[201~\r`);

  assert.equal(await reading, LOGIN_CODE);
  const text = output.text();

  // Literal oracle on the prompt. Trimming the copy is half of this change, so
  // the exact bytes are pinned rather than pattern-matched.
  assert.ok(text.startsWith(PROMPT), JSON.stringify(text));

  // Literal oracle on the mask. 54 = "cuna_login_" (11) + 43. Not
  // `LOGIN_CODE.length` computed from the same constant the reader sees, and
  // not "more than zero": an off-by-N mask passes both of those.
  assert.equal(LOGIN_CODE.length, 54);
  assert.equal(masksIn(text), 54);
  assert.equal(text, `${PROMPT}${MASK.repeat(54)}\n`);

  // The control this file already held, unchanged: the bytes are still absent.
  // It passes here for the right reason — the payload is masked, not the whole
  // stream discarded, which the exact-equality above is what proves.
  assert.doesNotMatch(text, new RegExp(LOGIN_CODE, "u"));
  assert.doesNotMatch(text, /cuna_login_/u);
});

test("the bracketed-paste framing is not counted as credential bytes", async () => {
  // The terminal wraps a paste in 6 bytes on each side. Echoing a star for
  // those would put 66 stars on screen for a 54-character code, so the count a
  // person reads would not be the count that gets submitted. Same value, both
  // framings, same mask.
  const framed = capturedOutput();
  const bare = capturedOutput();
  const a = terminalInput();
  const b = terminalInput();

  const framedRead = readHiddenLoginCode(a.input, framed.output);
  a.input.write(`\u001b[200~${LOGIN_CODE}\u001b[201~\r`);
  const bareRead = readHiddenLoginCode(b.input, bare.output);
  b.input.write(`${LOGIN_CODE}\r`);

  assert.equal(await framedRead, await bareRead);
  assert.equal(masksIn(framed.text()), 54);
  assert.equal(masksIn(bare.text()), 54);
  assert.equal(framed.text(), bare.text());
});

test("backspace erases exactly one mask, so the screen keeps matching the buffer", async () => {
  const { input } = terminalInput();
  const output = capturedOutput();
  const reading = readHiddenLoginCode(input, output.output);
  input.write("abcde");
  input.write("\u007f"); // DEL
  input.write("\b"); // BS
  input.write("\r");

  assert.equal(await reading, "abc");
  const text = output.text();
  // Erase is the three-byte destructive sequence, twice, and no more.
  assert.equal(text, `${PROMPT}${MASK.repeat(5)}\b \b\b \b\n`);
  // Five drawn minus two erased is three, which is what was submitted.
  assert.equal(masksIn(text) - countOf(text, ERASE), 3);
});

test("backspace on an empty buffer draws and erases nothing", async () => {
  // Erasing past column zero would eat the prompt itself and leave a screen
  // that no longer describes the buffer.
  const { input } = terminalInput();
  const output = capturedOutput();
  const reading = readHiddenLoginCode(input, output.output);
  input.write("\u007f\u007f\u007f");
  input.write("\r");

  assert.equal(await reading, "");
  assert.equal(output.text(), `${PROMPT}\n`);
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
