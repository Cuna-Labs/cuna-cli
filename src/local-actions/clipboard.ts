import { spawn } from "node:child_process";

/** Explicit local action; the URL is stdin data, never shell source or terminal output. */
export async function copyLocalText(text: string): Promise<void> {
  const command = process.platform === "win32" ? "powershell.exe" : process.platform === "darwin" ? "pbcopy" : "wl-copy";
  const args = process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new(); Set-Clipboard -Value ([Console]::In.ReadToEnd())"] : [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "ignore", "ignore"], shell: false });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Clipboard timeout")); }, 5000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("Clipboard unavailable")); });
    child.once("close", code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error("Clipboard failed")); });
    child.stdin.on("error", () => { /* close/error settles the operation */ });
    child.stdin.end(text, "utf8");
  });
}
