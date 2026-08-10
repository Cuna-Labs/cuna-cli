import { exec, execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { invariant } from "./release-evidence.mjs";

const execute = promisify(execFile);
const executeShellCommand = promisify(exec);

export async function runNpm(npmArgs, options = {}) {
  if (process.platform !== "win32") return execute("npm", npmArgs, options);
  const where = await execute("where.exe", ["npm.cmd"], { windowsHide: true, timeout: 10_000 });
  const npmCommand = where.stdout.split(/\r?\n/u).map((value) => value.trim()).find(Boolean);
  invariant(npmCommand, "npm.cmd could not be resolved from PATH");
  const npmCli = path.join(path.dirname(npmCommand), "node_modules", "npm", "bin", "npm-cli.js");
  await stat(npmCli);
  return execute(process.execPath, [npmCli, ...npmArgs], options);
}

export async function invokeInstalledCuna(prefix, args, options = {}) {
  const executable = process.platform === "win32"
    ? path.join(prefix, "cuna.cmd")
    : path.join(prefix, "bin", "cuna");
  await stat(executable);
  if (process.platform !== "win32") return execute(executable, args, { ...options, windowsHide: true });
  invariant(args.every((value) => /^[A-Za-z0-9._-]+$/u.test(value)), "Installed-product probe received an unsafe Windows argument");
  invariant(!/["&|<>^%!\r\n]/u.test(executable), "Installed-product probe path contains a Windows command metacharacter");
  const command = `"${executable}" ${args.join(" ")}`;
  return executeShellCommand(command, { ...options, windowsHide: true });
}

export function installedProductPaths(prefix) {
  if (process.platform === "win32") {
    return [
      path.join(prefix, "cuna"),
      path.join(prefix, "cuna.cmd"),
      path.join(prefix, "cuna.ps1"),
      path.join(prefix, "node_modules", "@cuna_labs", "cli"),
    ];
  }
  return [
    path.join(prefix, "bin", "cuna"),
    path.join(prefix, "lib", "node_modules", "@cuna_labs", "cli"),
  ];
}

export async function assertInstalledProductAbsent(prefix) {
  for (const candidate of installedProductPaths(prefix)) {
    try {
      await stat(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`Installed candidate artifact remains after uninstall: ${candidate}`);
  }
}
