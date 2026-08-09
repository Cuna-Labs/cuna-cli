import { spawn } from "node:child_process";

export interface BrowserOpener {
  open(url: string): Promise<void>;
}

function commandFor(platform: NodeJS.Platform, url: string): { readonly executable: string; readonly args: readonly string[] } {
  if (platform === "win32") return { executable: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "darwin") return { executable: "open", args: [url] };
  if (platform === "linux") return { executable: "xdg-open", args: [url] };
  throw new Error("No browser opener is available for this platform.");
}

export function createBrowserOpener(platform: NodeJS.Platform = process.platform): BrowserOpener {
  return Object.freeze({
    open(url: string): Promise<void> {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") throw new TypeError("Browser continuation URL must use HTTPS.");
      const command = commandFor(platform, url);
      return new Promise((resolve, reject) => {
        const child = spawn(command.executable, [...command.args], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          shell: false,
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
