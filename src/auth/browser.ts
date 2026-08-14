import { spawn } from "node:child_process";

import type { NativeBrowserProcessBridge } from "../credentials/native-process-bridge.js";
import { isBoundedHttpsBrowserUrl } from "../core/browser-url.js";

export interface BrowserOpener {
  open(url: string): Promise<void>;
}

export interface BrowserCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/**
 * Preview-only opener: print the one-time browser link instead of invoking an
 * unadmitted native launcher. The fragment is short-lived and PKCE-bound; it
 * is intentionally never emitted in structured JSON or automation output.
 */
export function createManualBrowserOpener(write: (message: string) => void): BrowserOpener {
  return Object.freeze({
    open(url: string): Promise<void> {
      assertHttpsBrowserUrl(url);
      write(`Open this one-time Cuna sign-in link in your browser:\n${url}\n`);
      return Promise.resolve();
    },
  });
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
  nativeBridge?: NativeBrowserProcessBridge,
): BrowserOpener {
  return Object.freeze({
    open(url: string): Promise<void> {
      assertHttpsBrowserUrl(url);
      if ((platform === "win32" || platform === "darwin") && nativeBridge !== undefined) {
        if (nativeBridge.platform !== platform) {
          throw new Error("The native browser bridge platform binding does not match this runtime.");
        }
        return nativeBridge.open(url);
      }
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
