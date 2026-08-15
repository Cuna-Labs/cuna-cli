import { spawn } from "node:child_process";

import { isBoundedHttpsBrowserUrl } from "../core/browser-url.js";

export interface BrowserOpener {
  open(url: string): Promise<void>;
}

export interface BrowserCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export function resolveBrowserCommand(
  platform: NodeJS.Platform,
  url: string,
  _environment: NodeJS.ProcessEnv = process.env,
): BrowserCommand {
  assertHttpsBrowserUrl(url);
  if (platform === "win32") {
    const systemRoot = _environment.SystemRoot ?? _environment.WINDIR ?? "C:\\Windows";
    return {
      executable: `${systemRoot}\\explorer.exe`,
      args: [url],
      cwd: systemRoot,
    };
  }
  if (platform === "darwin") {
    return { executable: "/usr/bin/open", args: [url], cwd: "/" };
  }
  if (platform === "linux") return { executable: "/usr/bin/xdg-open", args: [url], cwd: "/" };
  throw new Error("No browser opener is available for this platform.");
}

export function createBrowserOpener(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): BrowserOpener {
  return Object.freeze({
    open(url: string): Promise<void> {
      assertHttpsBrowserUrl(url);
      const command = resolveBrowserCommand(platform, url, environment);
      return new Promise((resolve, reject) => {
        const child = spawn(command.executable, [...command.args], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          shell: false,
          cwd: command.cwd,
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
    },
  });
}

function assertHttpsBrowserUrl(url: string): void {
  if (!isBoundedHttpsBrowserUrl(url)) {
    throw new TypeError("Browser continuation URL must be bounded HTTPS without control characters.");
  }
}
