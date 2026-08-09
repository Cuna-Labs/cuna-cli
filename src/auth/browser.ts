import { spawn } from "node:child_process";
import { win32 } from "node:path";

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
  environment: NodeJS.ProcessEnv = process.env,
): BrowserCommand {
  if (platform === "win32") {
    const systemRoot = environment.SystemRoot ?? environment.WINDIR;
    if (systemRoot === undefined || !win32.isAbsolute(systemRoot)) {
      throw new Error("Windows browser opener requires an absolute SystemRoot.");
    }
    return {
      executable: win32.join(systemRoot, "System32", "rundll32.exe"),
      args: ["url.dll,FileProtocolHandler", url],
      cwd: win32.join(systemRoot, "System32"),
    };
  }
  if (platform === "darwin") return { executable: "/usr/bin/open", args: [url], cwd: "/" };
  if (platform === "linux") return { executable: "/usr/bin/xdg-open", args: [url], cwd: "/" };
  throw new Error("No browser opener is available for this platform.");
}

export function createBrowserOpener(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): BrowserOpener {
  return Object.freeze({
    open(url: string): Promise<void> {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") throw new TypeError("Browser continuation URL must use HTTPS.");
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
