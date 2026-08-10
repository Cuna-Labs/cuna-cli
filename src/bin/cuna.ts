#!/usr/bin/env node
import { runProcessCli } from "../cli/process-entrypoint.js";

process.exitCode = await runProcessCli(process.argv.slice(2));
