// D5: once the command has returned, the shell prompt comes back.
//
// Measured on the installed 0.1.3 on 2026-09-28: after `Ctrl+] d` printed
// `Detached · …`, the process stayed alive a further 5.2-10.6 s with nothing on
// screen (6 of 6 attaches). The reproduced mechanism is Node's WebSocket: after
// `close()` its socket keeps the process alive until the server answers the
// close frame, and a server that never answers holds it forever.
//
// The subject is the real executable. A preload opens exactly that handle -- a
// WebSocket to a local server that never answers its close -- and the command
// is an offline one, so the only thing that can keep the process alive after
// the command has printed is the handle it does not own.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXECUTABLE = fileURLToPath(new URL("../dist/bin/cuna.js", import.meta.url));
/** Far above the grace, far below "never": what a person would call prompt. */
const PROMPT_EXIT_MS = 2_500;
/** How long the control waits before calling the process stuck. */
const STUCK_AFTER_MS = 8_000;

/** Completes the WebSocket handshake and never answers anything, a close frame included. */
async function silentWebSocketServer() {
  const sockets = new Set();
  const server = createServer((_request, response) => { response.statusCode = 404; response.end(); });
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}/stream`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Run the executable with the lingering handle preloaded. Resolves with the
 * exit code, the output, and how long the process lived after its output
 * ended; `stuck` when it was still alive `STUCK_AFTER_MS` later.
 */
async function runWithLingeringSocket(directory, url, args, stuckAfterMs = STUCK_AFTER_MS) {
  const preload = join(directory, "linger.mjs");
  writeFileSync(preload, [
    `const socket = new WebSocket(${JSON.stringify(url)});`,
    "socket.addEventListener(\"open\", () => socket.close(1000, \"cuna_shutdown\"));",
    "",
  ].join("\n"));
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1" },
  });
  let stdout = "";
  let stderr = "";
  let lastOutputAt = Date.now();
  child.stdout.on("data", (chunk) => { stdout += chunk; lastOutputAt = Date.now(); });
  child.stderr.on("data", (chunk) => { stderr += chunk; lastOutputAt = Date.now(); });
  return await new Promise((resolve) => {
    let stuck = false;
    const watchdog = setInterval(() => {
      if (stdout.length + stderr.length > 0 && Date.now() - lastOutputAt > stuckAfterMs) {
        stuck = true;
        child.kill();
      }
    }, 100);
    child.once("close", (code) => {
      clearInterval(watchdog);
      resolve({ code, stdout, stderr, stuck, tailMs: Date.now() - lastOutputAt });
    });
  });
}

test("D5: a handle the command does not own cannot keep the process alive after it returned", async () => {
  const server = await silentWebSocketServer();
  const directory = mkdtempSync(join(tmpdir(), "cuna-exit-"));
  try {
    // Control: the preloaded socket really holds a process that has finished
    // its work. Without this, a WebSocket that failed to open would let the
    // assertions below pass against nothing.
    const plain = await runWithLingeringSocket(directory, server.url, ["-e", "console.log('done')"], 2_000);
    assert.equal(plain.stuck, true, "the preloaded socket did not keep a plain Node process alive");

    const run = await runWithLingeringSocket(directory, server.url, [EXECUTABLE, "version", "--json"]);
    assert.equal(run.stuck, false, `the process was still alive ${STUCK_AFTER_MS} ms after its output: ${run.stderr}`);
    assert.ok(run.tailMs < PROMPT_EXIT_MS, `the process lived ${run.tailMs} ms after its output`);
    // The answer is complete and the exit code is the command's own.
    assert.equal(run.code, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).command, "version");

    // A failing command keeps its own exit code through the same bound.
    const refused = await runWithLingeringSocket(directory, server.url, [EXECUTABLE, "nonsense", "--json"]);
    assert.equal(refused.stuck, false, refused.stderr);
    assert.equal(refused.code, 2, refused.stderr);
    assert.match(refused.stderr, /cuna\.usage\./u);
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
