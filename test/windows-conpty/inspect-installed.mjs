import { strict as assert } from "node:assert";
import path from "node:path";
import process from "node:process";

import xtermHeadless from "@xterm/headless";
import { spawn } from "node-pty";

const sessionId = process.argv[2];
assert.match(sessionId ?? "", /^[0-9a-f-]{36}$/u);
const entrypoint = path.join(process.env.APPDATA, "npm", "node_modules", "@cuna_labs", "cli", "dist", "bin", "cuna.js");
const terminal = new xtermHeadless.Terminal({
  allowProposedApi: true,
  cols: 100,
  rows: 30,
  scrollback: 1000,
});
const child = spawn("node.exe", [entrypoint, "codex", "--agent-session", sessionId], {
  cols: 100,
  rows: 30,
  cwd: process.cwd(),
  name: "xterm-256color",
  useConpty: true,
  useConptyDll: false,
  env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
});
let transcript = "";
let exited = false;
child.onData((data) => { transcript += data; terminal.write(data); });
const exit = new Promise((resolve) => child.onExit((result) => {
  exited = true;
  resolve(result);
}));
const screen = () => {
  const lines = [];
  for (let row = 0; row < terminal.rows; row += 1) {
    lines.push(terminal.buffer.active.getLine(row)?.translateToString(true) ?? "");
  }
  return lines.join("\n").trimEnd();
};
const waitUntil = async (predicate, label, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => terminal.write("", resolve));
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label}: ${screen()}`);
};
try {
  await waitUntil(() => screen().includes("Welcome to Codex"), "Codex UI did not render");
  child.write("\u001b[B");
  await waitUntil(() => screen().includes("> 2. Sign in with Device Code"), "Down arrow did not move selection", 5_000);
  terminal.resize(46, 14);
  child.resize(46, 14);
  const transcriptBeforeResize = transcript.length;
  await waitUntil(
    () => transcript.length > transcriptBeforeResize && screen().includes("Sign in with Device Code"),
    "Codex UI did not redraw after ConPTY resize",
    5_000,
  );
  const resizedScreen = screen();
  child.write("\u0003");
  const result = await Promise.race([
    exit,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Ctrl-C timeout")), 8_000)),
  ]);
  process.stdout.write(`${JSON.stringify({ resizedScreen, columns: terminal.cols, rows: terminal.rows, exitCode: result.exitCode, ansiBytes: transcript.length })}\n`);
} finally {
  if (!exited) child.kill();
  terminal.dispose();
}
process.exit(0);
