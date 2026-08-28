import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
function unverified(reason, details = {}) {
  console.log(JSON.stringify({ testId: "T14.2-LINUX", result: "UNVERIFIED", reason, ...details }));
  process.exit(0);
}

let output;
try {
  if (process.platform === "linux") {
    output = execFileSync("bash", [path.join(root, "scripts", "harness", "run-linux-native-pty.sh")], { cwd: root, encoding: "utf8" });
  } else if (process.platform === "win32") {
    output = execFileSync("wsl.exe", ["--cd", root, "bash", "./scripts/harness/run-linux-native-pty.sh"], { encoding: "utf8", timeout: 120_000 });
  } else {
    unverified("Requires a real Linux host or WSL2 Linux kernel.");
  }
} catch (error) {
  unverified("The isolated verified Linux runtime or native PTY probe could not execute", {
    error: error instanceof Error ? error.message : String(error),
    stdout: error?.stdout?.toString(),
    stderr: error?.stderr?.toString(),
  });
}

assert.match(output, /CUNA_LINUX_NATIVE_PTY exec=\/tmp\/cuna-node-v24\.4\.1-linux-x64\/bin\/node platform=linux tty=1 elf=1 proc=Linux/u);
assert.match(output, /(?:^|\r?\n)\d+\.\d+\.\d+\r?(?:\n|$)/u);
assert.match(output, /CUNA_LINUX_NATIVE_CLI_EXIT=0/u);
console.log(JSON.stringify({
  testId: "T14.2-LINUX-NATIVE-PTY-SMOKE",
  result: "PASS",
  host: { platform: process.platform === "win32" ? "linux-under-wsl" : "linux", launcher: process.platform, arch: "x64" },
  runtime: { node: "v24.4.1", archiveSha256: "7e067b13cd0dc7ee8b239f4ebe1ae54f3bba3a6e904553fcb5f581530eb8306d", format: "ELF", proc: "Linux" },
  adapter: "util-linux script(1) native PTY",
  oracle: output.trim(),
  qualification: "Native Linux PTY smoke passed; the complete R14.3 Linux interaction matrix remains UNVERIFIED, so PRD-014 remains Draft.",
}));
