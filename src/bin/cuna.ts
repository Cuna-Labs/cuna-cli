#!/usr/bin/env node
import { paintFirstLine } from "../cli/first-line.js";

// The first line is painted before the rest of the CLI is imported: loading
// that graph is most of the time before anything appears (cli/first-line.ts).
const argv = process.argv.slice(2);
const firstLine = paintFirstLine(argv, {
  env: process.env,
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
  stderr: process.stderr,
});
const { runProcessCli } = await import("../cli/process-entrypoint.js");
process.exitCode = await runProcessCli(argv, {
  stdin: process.stdin,
  ...(firstLine === undefined ? {} : { firstLine }),
});
