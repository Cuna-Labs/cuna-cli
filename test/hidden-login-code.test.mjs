import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * Releasing the stream, and why asserting the returned code cannot prove it.
 *
 * The reader calls `input.resume()` to start reading. Its cleanup removed the
 * listeners, restored raw mode, wrote a newline and zeroed the buffer -- and
 * left the stream flowing. Detaching a listener does not unreference a stream,
 * so `cuna login` printed its success line and then hung with a referenced
 * stdin handle holding the event loop open; the operator's only exit was
 * Ctrl+C (0xC000013A).
 *
 * Every assertion already in this file passes in that state, because the code
 * IS returned and the mask IS correct -- the process simply never ends
 * afterwards. So these two assert the separate property: the reader gives the
 * stream back in the state it borrowed it.
 */
/**
 * One turn of the event loop.
 *
 * The reader releases the flow from a deferred tick, because releasing it from
 * inside the `data` emit does not work: `Readable.pause()` only emits the
 * `"pause"` event that stops the underlying handle while `flowing !== false`,
 * so a pause issued inside the emit flips the flag, gets its handle re-armed by
 * the same `read()` call, and turns every later pause into a no-op. "Released"
 * is therefore a property of the next turn, not of the same one, and these wait
 * for that turn rather than pretending the release is synchronous.
 */
const settled = () => new Promise((resolve) => { setImmediate(resolve); });

test("the reader stops the flow it started, and leaves an already-flowing stream alone", async () => {
  const { input } = terminalInput();
  const output = capturedOutput();
  // A fresh stream: `readableFlowing` is null, and `isPaused()` reports false
  // even though nothing is flowing. Pinned here because a fix written against
  // `isPaused()` would read this exact state as "already flowing" and skip the
  // restoration entirely.
  assert.equal(input.readableFlowing, null);
  assert.equal(input.isPaused(), false);

  const reading = readHiddenLoginCode(input, output.output);
  assert.equal(input.readableFlowing, true, "the reader must start the flow it needs");
  input.write(`${LOGIN_CODE}\r`);
  assert.equal(await reading, LOGIN_CODE);
  await settled();
  assert.notEqual(input.readableFlowing, true, "the reader must not leave the stream flowing");
  assert.equal(input.isPaused(), true);

  // The other direction, so the fix cannot be "always pause": a caller that
  // handed over a stream it was already reading gets it back still flowing.
  const borrowed = terminalInput();
  borrowed.input.resume();
  assert.equal(borrowed.input.readableFlowing, true);
  const borrowedOutput = capturedOutput();
  const borrowedRead = readHiddenLoginCode(borrowed.input, borrowedOutput.output);
  borrowed.input.write(`${LOGIN_CODE}\r`);
  assert.equal(await borrowedRead, LOGIN_CODE);
  await settled();
  assert.equal(borrowed.input.readableFlowing, true, "a stream that arrived flowing must stay flowing");
});

test("the reader releases the flow on cancellation too, not only on success", async () => {
  const { input } = terminalInput();
  const output = capturedOutput();
  const controller = new AbortController();
  const cancelled = readHiddenLoginCode(input, output.output, controller.signal);
  input.write(LOGIN_CODE.slice(0, 12));
  controller.abort();
  await assert.rejects(cancelled, (error) => error?.code === "cuna.auth.login_code_input_cancelled");
  await settled();
  assert.equal(input.isPaused(), true);
  assert.notEqual(input.readableFlowing, true);
});

/**
 * The end-to-end control for the same defect: a real OS process, a real pipe
 * handle, and no `process.exit()` anywhere.
 *
 * The in-process assertions above read a flag. This one reads the consequence
 * the owner actually reported. `process.stdin` over a pipe owns a libuv handle
 * that `resume()` references and `pause()` releases, so a child that has
 * finished reading either drains its event loop and exits on its own or does
 * not exit at all. The parent deliberately keeps the pipe OPEN: closing stdin
 * would end the stream and let even the unfixed reader exit, which would make
 * this test pass for the wrong reason.
 *
 * Failure mode without the fix: the child never exits, the timeout below kills
 * it, and the assertion reports a signal instead of a clean exit.
 */
test("a process that finished reading a login code exits by itself", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cuna-hidden-reader-exit-"));
  const script = join(directory, "read-once.mjs");
  const runUrl = new URL("../dist/cli/run.js", import.meta.url).href;
  await writeFile(
    script,
    [
      `import { Writable } from "node:stream";`,
      `import { readHiddenLoginCode } from ${JSON.stringify(runUrl)};`,
      `const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });`,
      // Present the pipe as the TTY the reader requires. The handle underneath
      // is a real one; only the two capability flags are supplied.
      `process.stdin.isTTY = true;`,
      `process.stdin.setRawMode = () => process.stdin;`,
      `const code = await readHiddenLoginCode(process.stdin, sink);`,
      `process.stdout.write(code);`,
      // No process.exit(). Exiting on purpose is precisely the behaviour under
      // test, so forcing it here would erase the defect.
      "",
    ].join("\n"),
    "utf8",
  );
  try {
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.resume();
    child.stdin.write(`${LOGIN_CODE}\r`);

    let timer;
    const exited = new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const outcome = await Promise.race([
      exited,
      new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), 10_000); }),
    ]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      child.kill("SIGKILL");
      await exited;
    }
    // stdin is still open here, and stays open: the child must have exited
    // without needing EOF.
    child.stdin.destroy();

    assert.notEqual(outcome, "timeout", "the CLI process must exit after reading the login code, not wait for Ctrl+C");
    assert.equal(outcome.signal, null, "the process must end on its own, never on a signal");
    assert.equal(outcome.code, 0);
    assert.equal(stdout, LOGIN_CODE, "the code must still be delivered; exiting early would be the wrong fix");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
