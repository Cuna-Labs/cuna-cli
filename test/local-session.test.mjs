import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { LocalEncryptedSessionBackend, localEncryptedSessionPaths } from "../dist/credentials/index.js";

const execFileAsync = promisify(execFile);

test("AES-256-GCM session uses separate restricted key/ciphertext files and deletes both", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cuna-local-session-"));
  try {
    const paths = localEncryptedSessionPaths(directory, "default");
    const backend = new LocalEncryptedSessionBackend({ ...paths, platform: process.platform });
    assert.equal((await backend.probe()).status, "verified");
    const loginCode = Buffer.from(`cuna_login_${"x".repeat(43)}`);
    await backend.replace("ignored", loginCode);
    const [ciphertext, key] = await Promise.all([readFile(paths.sessionFile), readFile(paths.keyFile)]);
    assert.equal(ciphertext.includes(loginCode), false);
    assert.equal(key.includes(loginCode), false);
    assert.equal(key.byteLength, 32);
    if (process.platform === "win32") {
      const [{ stdout: sessionAcl }, { stdout: keyAcl }] = await Promise.all([
        execFileAsync("C:\\Windows\\System32\\icacls.exe", [paths.sessionFile]),
        execFileAsync("C:\\Windows\\System32\\icacls.exe", [paths.keyFile]),
      ]);
      assert.equal(sessionAcl.includes("(I)"), false);
      assert.equal(keyAcl.includes("(I)"), false);
    } else {
      assert.equal((await stat(paths.sessionFile)).mode & 0o077, 0);
      assert.equal((await stat(paths.keyFile)).mode & 0o077, 0);
    }
    assert.deepEqual(Buffer.from(await backend.read("ignored")), loginCode);
    assert.equal(await backend.delete("ignored"), "deleted");
    await assert.rejects(stat(paths.sessionFile), (error) => error?.code === "ENOENT");
    await assert.rejects(stat(paths.keyFile), (error) => error?.code === "ENOENT");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("encrypted session fails closed on ciphertext, key, and permission corruption", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cuna-local-session-"));
  try {
    const paths = localEncryptedSessionPaths(directory, "profile-a");
    const backend = new LocalEncryptedSessionBackend({ ...paths, platform: process.platform });
    await backend.replace("ignored", Buffer.from(`cuna_login_${"y".repeat(43)}`));
    await writeFile(paths.sessionFile, '{"corrupt":true}\n');
    await assert.rejects(backend.read("ignored"), /malformed|shape|authentication/iu);
    await writeFile(paths.keyFile, Buffer.alloc(31));
    await assert.rejects(backend.read("ignored"), /key file is invalid/iu);
    await writeFile(paths.keyFile, Buffer.alloc(32));
    if (process.platform === "win32") {
      await execFileAsync("C:\\Windows\\System32\\icacls.exe", [paths.keyFile, "/grant", "*S-1-1-0:R"]);
    } else {
      await chmod(paths.keyFile, 0o644);
    }
    assert.equal((await backend.probe()).status, "unavailable");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
