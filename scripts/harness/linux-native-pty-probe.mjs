import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";

const entrypoint = process.argv[2];
assert.ok(entrypoint, "built CLI entrypoint is required");
assert.equal(process.platform, "linux", "probe is not running in a Linux Node process");
assert.equal(process.stdin.isTTY, true, "stdin is not an OS-native PTY");
assert.equal(process.stdout.isTTY, true, "stdout is not an OS-native PTY");
assert.deepEqual([...readFileSync(process.execPath).subarray(0, 4)], [0x7f, 0x45, 0x4c, 0x46], "process.execPath is not an ELF binary");
assert.match(readFileSync("/proc/sys/kernel/ostype", "utf8"), /^Linux\s*$/u, "/proc does not identify Linux");

process.stdout.write(`CUNA_LINUX_NATIVE_PTY exec=${process.execPath} platform=${process.platform} tty=1 elf=1 proc=Linux\n`);
const cli = spawnSync(process.execPath, [entrypoint, "--version"], { stdio: "inherit", env: process.env });
assert.equal(cli.error, undefined, "built CLI could not start under the native PTY");
assert.equal(cli.status, 0, `built CLI exited ${cli.status}`);
process.stdout.write("CUNA_LINUX_NATIVE_CLI_EXIT=0\n");
