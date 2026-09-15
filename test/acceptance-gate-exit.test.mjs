import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

// These controls execute the actual entrypoints. Only host discovery and the
// external Linux launcher are replaced; no provider, WSL or credential is used.
function runGate(script, { platform, arch = "x64", launcher = "forbidden" }) {
  const preload = `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    Object.defineProperty(process, 'arch', { value: ${JSON.stringify(arch)} });
    cp.execFileSync = () => {
      ${launcher === "smoke"
        ? "return 'CUNA_LINUX_NATIVE_PTY exec=/tmp/cuna-node-v24.4.1-linux-x64/bin/node platform=linux tty=1 elf=1 proc=Linux\\n0.1.0\\nCUNA_LINUX_NATIVE_CLI_EXIT=0\\n';"
        : `throw new Error(${JSON.stringify(launcher === "failure" ? "CONTROLLED_LAUNCH_FAILURE" : "UNEXPECTED_EXTERNAL_LAUNCH")});`}
    };
    syncBuiltinESMExports();
  `;
  return spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, path.join(root, "scripts", script)], {
    cwd: root, encoding: "utf8", timeout: 20_000, windowsHide: true,
  });
}

for (const scenario of [
  { script: "test-windows-conpty.mjs", platform: "linux", reason: /requires Windows/u },
  { script: "test-windows-conpty.mjs", platform: "win32", arch: "arm64", reason: /outside the declared/u },
  { script: "test-linux-pty.mjs", platform: "darwin", reason: /Requires a real Linux/u },
  { script: "test-linux-pty.mjs", platform: "linux", launcher: "failure", reason: /CONTROLLED_LAUNCH_FAILURE/u },
  { script: "test-linux-pty.mjs", platform: "win32", launcher: "failure", reason: /CONTROLLED_LAUNCH_FAILURE/u },
  { script: "test-macos-pty.mjs", platform: "darwin", reason: /not implemented/u },
  { script: "test-macos-pty.mjs", platform: "win32", reason: /Requires a real macOS/u },
]) {
  test(`${scenario.script}: ${scenario.platform}/${scenario.arch ?? "x64"} ${scenario.launcher ?? "unsupported"} cannot pass`, () => {
    const result = runGate(scenario.script, scenario);
    assert.equal(result.error, undefined);
    assert.match(result.stdout, /"result":"UNVERIFIED"/u);
    assert.match(result.stdout, scenario.reason);
    assert.equal(result.status, 2, result.stdout + result.stderr);
  });
}

test("a successful Linux smoke cannot stand in for the unexecuted interaction matrix", () => {
  const result = runGate("test-linux-pty.mjs", { platform: "linux", launcher: "smoke" });
  assert.equal(result.error, undefined);
  assert.match(result.stdout, /"testId":"T14.2-LINUX-NATIVE-PTY-SMOKE","result":"PASS"/u);
  assert.match(result.stdout, /"testId":"T14.2-LINUX","result":"UNVERIFIED"/u);
  assert.equal(result.status, 2, result.stdout + result.stderr);
});

test("the documented npm macOS acceptance entrypoint propagates UNVERIFIED", () => {
  const result = process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm run acceptance:macos-pty"], { cwd: root, encoding: "utf8", timeout: 30_000, windowsHide: true })
    : spawnSync("npm", ["run", "acceptance:macos-pty"], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.match(result.stdout, /"result":"UNVERIFIED"/u);
  assert.equal(result.status, 2, result.stdout + result.stderr);
});
