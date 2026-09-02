import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { promisify } from "node:util";

import {
  CredentialVault,
  inspectWindowsAclMany,
  isolateWindowsAclBatchChildEnvironment,
  isolateWindowsAclChildEnvironment,
  LocalEncryptedSessionBackend,
  localEncryptedSessionPaths,
  parseWindowsAclBatchInspection,
  SecretMaterial,
  WINDOWS_ACL_COMMAND_PROGRAMS,
} from "../dist/credentials/index.js";

const execFileAsync = promisify(execFile);

test("Windows ACL commands are static and isolate case-insensitive child environment inputs", () => {
  assert.equal(Object.isFrozen(WINDOWS_ACL_COMMAND_PROGRAMS), true);
  const programs = Object.values(WINDOWS_ACL_COMMAND_PROGRAMS);
  assert.equal(programs.length, 4);
  for (const [name, program] of Object.entries(WINDOWS_ACL_COMMAND_PROGRAMS)) {
    if (name === "inspectMany") {
      assert.match(program, /\$env:CUNA_SESSION_ACL_PATHS_V1/u);
      assert.doesNotMatch(program, /\$env:CUNA_SESSION_ACL_PATH_V1\b/u);
    } else {
      assert.match(program, /\$env:CUNA_SESSION_ACL_PATH_V1/u);
      assert.doesNotMatch(program, /CUNA_SESSION_ACL_PATHS_V1/u);
    }
    assert.match(program, /Import-Module 'C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\Modules\\Microsoft\.PowerShell\.Security\\Microsoft\.PowerShell\.Security\.psd1'/u);
    assert.doesNotMatch(program, /(?:FromBase64String|EncodedCommand|Invoke-Expression|\bIEX\b|ExecutionPolicy)/iu);
    assert.doesNotMatch(program, /(?:^|\s)-File(?:\s|$)/u);
  }
  assert.doesNotMatch(WINDOWS_ACL_COMMAND_PROGRAMS.inspect, /CUNA_SESSION_ACL_SID_V1/u);
  assert.doesNotMatch(WINDOWS_ACL_COMMAND_PROGRAMS.inspectMany, /CUNA_SESSION_ACL_SID_V1/u);
  assert.match(WINDOWS_ACL_COMMAND_PROGRAMS.inspectMany, /CUNA_SDDL:' \+ \$i \+ '='/u, "batched output is indexed per path");
  assert.doesNotMatch(WINDOWS_ACL_COMMAND_PROGRAMS.inspectMany, /Set-Acl/u, "inspection never mutates");
  for (const program of [WINDOWS_ACL_COMMAND_PROGRAMS.reconcileFile, WINDOWS_ACL_COMMAND_PROGRAMS.reconcileDirectory]) {
    assert.doesNotMatch(program, /CUNA_SESSION_ACL_SID_V1/u);
    assert.match(program, /WindowsIdentity\]::GetCurrent\(\)\.User\.Value/u);
    assert.match(program, /\$currentBeforeWrite -ne \$beforeCurrent/u);
    assert.match(program, /\.SetOwner\(\$sid\)/u);
    assert.match(program, /\.SetAccessRuleProtection\(\$true, \$false\)/u);
    assert.match(program, /FileSystemRights\]::FullControl/u);
    assert.match(program, /Set-Acl -LiteralPath \$path/u);
    assert.match(program, /CUNA_BEFORE_SDDL/u);
    assert.match(program, /CUNA_AFTER_SDDL/u);
  }

  const inherited = Object.freeze({
    KEEP_ME: "preserved",
    CUNA_SESSION_ACL_PATH_V1: "hostile-uppercase-path",
    cuna_session_acl_path_v1: "hostile-lowercase-path",
    CUNA_SESSION_ACL_PATHS_V1: "hostile-uppercase-list",
    cuna_session_acl_paths_v1: "hostile-lowercase-list",
    CUNA_SESSION_ACL_SID_V1: "S-1-5-21-111-222-333-444",
    cuna_session_acl_sid_v1: "S-1-5-21-555-666-777-888",
  });
  const inspectionEnvironment = isolateWindowsAclChildEnvironment(
    inherited,
    "C:\\safe\\session.json",
  );
  const reconciliationEnvironment = isolateWindowsAclChildEnvironment(inherited, "C:\\safe\\session.key");
  const namesFor = (environment, canonicalName) => Object.entries(environment)
    .filter(([name]) => name.toLocaleUpperCase("en-US") === canonicalName)
    .map(([name, value]) => [name, value]);

  assert.equal(Object.getPrototypeOf(inspectionEnvironment), null);
  assert.deepEqual(namesFor(inspectionEnvironment, "CUNA_SESSION_ACL_PATH_V1"), [["CUNA_SESSION_ACL_PATH_V1", "C:\\safe\\session.json"]]);
  assert.deepEqual(namesFor(inspectionEnvironment, "CUNA_SESSION_ACL_SID_V1"), []);
  assert.deepEqual(namesFor(inspectionEnvironment, "CUNA_SESSION_ACL_PATHS_V1"), [], "a single-path child never sees a list");
  assert.equal(inspectionEnvironment.KEEP_ME, "preserved");
  assert.deepEqual(namesFor(reconciliationEnvironment, "CUNA_SESSION_ACL_PATH_V1"), [["CUNA_SESSION_ACL_PATH_V1", "C:\\safe\\session.key"]]);
  assert.deepEqual(namesFor(reconciliationEnvironment, "CUNA_SESSION_ACL_SID_V1"), []);
  assert.equal(inherited.cuna_session_acl_path_v1, "hostile-lowercase-path", "the parent environment is never mutated");
  assert.equal(inherited.cuna_session_acl_sid_v1, "S-1-5-21-555-666-777-888", "the parent environment is never mutated");

  const batchEnvironment = isolateWindowsAclBatchChildEnvironment(inherited, ["C:\\safe\\sessions-v1", "C:\\safe\\session.key", "C:\\safe\\session.json"]);
  assert.equal(Object.getPrototypeOf(batchEnvironment), null);
  assert.deepEqual(namesFor(batchEnvironment, "CUNA_SESSION_ACL_PATHS_V1"), [["CUNA_SESSION_ACL_PATHS_V1", "C:\\safe\\sessions-v1\nC:\\safe\\session.key\nC:\\safe\\session.json"]]);
  assert.deepEqual(namesFor(batchEnvironment, "CUNA_SESSION_ACL_PATH_V1"), [], "a batched child never sees a single path");
  assert.deepEqual(namesFor(batchEnvironment, "CUNA_SESSION_ACL_SID_V1"), []);
  assert.equal(batchEnvironment.KEEP_ME, "preserved");
  assert.throws(() => isolateWindowsAclBatchChildEnvironment(inherited, ["C:\\safe\\a.json\nC:\\evil\\b.json"]), /batch path is invalid/u, "a separator inside a path cannot forge a second entry");
  assert.throws(() => isolateWindowsAclBatchChildEnvironment(inherited, []), /batch size is invalid/u);
  assert.throws(() => isolateWindowsAclBatchChildEnvironment(inherited, ["C:\\safe\\a.json", ""]), /batch path is invalid/u);
});

test("batched Windows ACL output parses per index and rejects malformed observations", () => {
  const sid = "S-1-5-21-123-456-789-1001";
  const ownerOnlyFile = `O:${sid}G:${sid}D:PAI(A;;FA;;;${sid})`;
  const ownerOnlyDirectory = `O:${sid}G:${sid}D:PAI(A;OICI;FA;;;${sid})`;
  const everyoneRead = `O:${sid}G:${sid}D:PAI(A;;FA;;;${sid})(A;;FR;;;WD)`;
  const foreignOwner = `O:S-1-5-21-999-888-777-2002G:${sid}D:PAI(A;;FA;;;${sid})`;
  const parsed = parseWindowsAclBatchInspection(
    [`CUNA_CURRENT_SID=${sid}`, `CUNA_SDDL:0=${ownerOnlyDirectory}`, `CUNA_SDDL:2=${everyoneRead}`, `CUNA_SDDL:3=${foreignOwner}`, ""].join("\r\n"),
    [true, false, false, false],
  );
  assert.deepEqual(parsed, [
    { currentSid: sid, ownerSid: sid, daclOwnerOnly: true },
    undefined,
    { currentSid: sid, ownerSid: sid, daclOwnerOnly: false },
    { currentSid: sid, ownerSid: "S-1-5-21-999-888-777-2002", daclOwnerOnly: true },
  ]);
  assert.deepEqual(
    parseWindowsAclBatchInspection(`CUNA_CURRENT_SID=${sid}\n`, [true, false]),
    [undefined, undefined],
    "a batch that inspected nothing reports nothing as inspected",
  );
  assert.equal(parseWindowsAclBatchInspection(`CUNA_CURRENT_SID=${sid}\nCUNA_SDDL:0=${ownerOnlyDirectory}\n`, [false])[0].daclOwnerOnly, false, "a directory ACE is not owner-only for a file");
  assert.equal(parseWindowsAclBatchInspection(`CUNA_CURRENT_SID=${sid}\nCUNA_SDDL:0=${ownerOnlyFile}\n`, [false])[0].daclOwnerOnly, true);
  assert.throws(() => parseWindowsAclBatchInspection(`CUNA_SDDL:0=${ownerOnlyFile}\n`, [false]), /unavailable/u, "the current SID is mandatory");
  assert.throws(() => parseWindowsAclBatchInspection(`CUNA_CURRENT_SID=${sid}\nCUNA_CURRENT_SID=S-1-5-21-1-2-3-4\nCUNA_SDDL:0=${ownerOnlyFile}\n`, [false]), /unavailable/u, "two SIDs are one too many");
  assert.throws(() => parseWindowsAclBatchInspection(`CUNA_CURRENT_SID=${sid}\nCUNA_SDDL:1=${ownerOnlyFile}\n`, [false]), /malformed/u, "an out-of-range index is rejected");
  assert.throws(() => parseWindowsAclBatchInspection(`CUNA_CURRENT_SID=${sid}\nCUNA_SDDL:0=${ownerOnlyFile}\nCUNA_SDDL:0=${everyoneRead}\n`, [false]), /malformed/u, "a duplicated index is rejected");
  assert.throws(() => parseWindowsAclBatchInspection(`CUNA_CURRENT_SID=${sid}\nCUNA_SDDL:0=garbage\n`, [false]), /unavailable/u, "an SDDL without an owner is rejected");
});

test("the real batched inspection observes several paths in one spawn and skips absent ones", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cuna-local-session-batch-real-"));
  try {
    const present = path.join(root, "present.key");
    await writeFile(present, Buffer.alloc(32));
    const absent = path.join(root, "absent.json");
    const results = await inspectWindowsAclMany([
      { path: root, directory: true },
      { path: present, directory: false },
      { path: absent, directory: false },
    ]);
    assert.equal(results.length, 3);
    assert.match(results[0].currentSid, /^S-1-/u);
    assert.equal(results[0].ownerSid, results[0].currentSid, "a fresh temp directory is owned by the current user");
    assert.equal(results[1].currentSid, results[0].currentSid);
    assert.equal(results[1].daclOwnerOnly, false, "an inherited default ACL is not owner-only");
    assert.equal(results[2], undefined, "an absent path is reported as not inspected, never as safe");
  } finally { await rm(root, { recursive: true, force: true }); }
});

function countingAcl(compliant, counters) {
  const entry = (target, directoryEntry) => `${directoryEntry ? "directory" : "file"}:${target}`;
  const observe = (target, directoryEntry) => {
    counters.sid += 1;
    const currentSid = `S-1-5-21-123-456-789-${counters.sid}`;
    return { currentSid, ownerSid: currentSid, daclOwnerOnly: compliant.has(entry(target, directoryEntry)) };
  };
  return {
    inspectOwnerOnly: async (target, directoryEntry) => {
      counters.single += 1;
      return observe(target, directoryEntry);
    },
    inspectManyOwnerOnly: async (requests) => {
      counters.batch += 1;
      counters.batchSizes.push(requests.length);
      // Emulate the OS program: an absent path is not inspected; one SID per spawn.
      counters.sid += 1;
      const currentSid = `S-1-5-21-123-456-789-${counters.sid}`;
      return Promise.all(requests.map(async ({ path: target, directory: directoryEntry }) => {
        try { await stat(target); } catch { return undefined; }
        return { currentSid, ownerSid: currentSid, daclOwnerOnly: compliant.has(entry(target, directoryEntry)) };
      }));
    },
    reconcileNewOwnerOnly: async (target, directoryEntry) => {
      counters.reconcile += 1;
      const before = observe(target, directoryEntry);
      compliant.add(entry(target, directoryEntry));
      return { before, after: { ...before, daclOwnerOnly: true }, repaired: !before.daclOwnerOnly };
    },
  };
}

test("Windows ACL inspection is at most one spawn per store operation and never outlives it", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cuna-local-session-batch-scope-"));
  const paths = localEncryptedSessionPaths(directory, "batch-scope");
  const sessionDirectory = path.dirname(paths.sessionFile);
  const compliant = new Set();
  const counters = { single: 0, batch: 0, reconcile: 0, sid: 0, batchSizes: [] };
  const snapshot = () => ({ single: counters.single, batch: counters.batch, reconcile: counters.reconcile });
  const delta = (before) => ({ single: counters.single - before.single, batch: counters.batch - before.batch, reconcile: counters.reconcile - before.reconcile });
  try {
    const backend = new LocalEncryptedSessionBackend({ ...paths, platform: process.platform, windowsAcl: countingAcl(compliant, counters) });
    const secret = Buffer.from(`cuna_login_${"b".repeat(43)}`);

    let before = snapshot();
    await backend.replace("ignored", secret);
    assert.deepEqual(delta(before), { single: 0, batch: 1, reconcile: 3 }, "a first write reconciles all three artifacts and re-inspects the new directory once after locking");

    before = snapshot();
    assert.equal((await backend.probe()).status, "verified");
    assert.deepEqual(delta(before), { single: 0, batch: 1, reconcile: 0 }, "probe: directory, key and ciphertext in one spawn");

    before = snapshot();
    assert.deepEqual(Buffer.from(await backend.read("ignored")), secret);
    assert.deepEqual(delta(before), { single: 0, batch: 1, reconcile: 0 }, "read: one spawn");

    before = snapshot();
    const expected = createHash("sha256").update(secret).digest("hex");
    assert.equal(await backend.compareAndSwap("ignored", expected, Buffer.from(`cuna_login_${"c".repeat(43)}`)), "replaced");
    assert.deepEqual(delta(before), { single: 0, batch: 1, reconcile: 1 }, "CAS: one inspection spawn plus the ciphertext reconciliation");

    before = snapshot();
    await backend.replace("ignored", secret);
    assert.deepEqual(delta(before), { single: 0, batch: 1, reconcile: 1 }, "replace over an existing key: one inspection spawn plus the ciphertext reconciliation");

    before = snapshot();
    await backend.withRefreshLock("ignored", async () => {
      assert.deepEqual(Buffer.from(await backend.read("ignored")), secret);
    });
    assert.deepEqual(delta(before), { single: 0, batch: 2, reconcile: 0 }, "a nested storage operation owns its own scope; the refresh lock does not lend it a stale one");

    assert.equal(counters.batchSizes.every((size) => size === 3), true, "every batch covers the directory, the key and the ciphertext");
    assert.equal(new Set(counters.batchSizes).size, 1);

    // Negative control: a permission change between two operations is read.
    const entry = `file:${paths.keyFile}`;
    assert.equal(compliant.delete(entry), true);
    before = snapshot();
    assert.equal((await backend.probe()).status, "unavailable", "the next operation observes the changed key ACL");
    assert.deepEqual(delta(before), { single: 0, batch: 1, reconcile: 0 }, "the change was seen by a fresh spawn, not repaired");
    await assert.rejects(
      backend.read("ignored"),
      (error) => error?.code === "credential_backend_unverified" && error?.retryable === false,
      "read fails closed on the same change",
    );
    compliant.add(entry);
    before = snapshot();
    assert.equal((await backend.probe()).status, "verified");
    assert.deepEqual(delta(before), { single: 0, batch: 1, reconcile: 0 });

    // Negative control: a restored directory ACL is re-read too.
    assert.equal(compliant.delete(`directory:${sessionDirectory}`), true);
    assert.equal((await backend.probe()).status, "unavailable", "the next operation observes the changed directory ACL");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a batched inspection failure is raised at the enforcement site without a silent retry", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cuna-local-session-batch-failure-"));
  const paths = localEncryptedSessionPaths(directory, "batch-failure");
  const compliant = new Set();
  const counters = { single: 0, batch: 0, reconcile: 0, sid: 0, batchSizes: [] };
  const healthy = countingAcl(compliant, counters);
  let failBatch = false;
  const windowsAcl = {
    ...healthy,
    inspectManyOwnerOnly: async (requests) => {
      if (!failBatch) return healthy.inspectManyOwnerOnly(requests);
      counters.batch += 1;
      throw Object.assign(new Error("simulated batched ACL timeout"), { code: "ETIMEDOUT" });
    },
  };
  try {
    const backend = new LocalEncryptedSessionBackend({ ...paths, platform: process.platform, windowsAcl });
    const secret = Buffer.from(`cuna_login_${"f".repeat(43)}`);
    await backend.replace("ignored", secret);
    failBatch = true;
    const before = { single: counters.single, batch: counters.batch };
    // The first enforcement site in any operation is the directory check that
    // follows lock acquisition; its error surfaces unchanged, as it did for a
    // single-path directory inspection before batching.
    await assert.rejects(backend.read("ignored"), (error) => error?.code === "ETIMEDOUT" && /simulated batched ACL timeout/u.test(error.message));
    assert.equal(counters.batch - before.batch, 1);
    assert.equal(counters.single - before.single, 0, "a failed batch is not retried path by path");
    assert.equal((await backend.probe()).status, "unavailable");
    failBatch = false;
    assert.deepEqual(Buffer.from(await backend.read("ignored")), secret, "the failure did not outlive its operation");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an authority without batching is inspected path by path within one operation and afresh across operations", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cuna-local-session-single-fallback-"));
  const paths = localEncryptedSessionPaths(directory, "single-fallback");
  const compliant = new Set();
  const counters = { single: 0, batch: 0, reconcile: 0, sid: 0, batchSizes: [] };
  const windowsAcl = countingAcl(compliant, counters);
  delete windowsAcl.inspectManyOwnerOnly;
  try {
    const backend = new LocalEncryptedSessionBackend({ ...paths, platform: process.platform, windowsAcl });
    const secret = Buffer.from(`cuna_login_${"s".repeat(43)}`);
    await backend.replace("ignored", secret);
    let before = counters.single;
    assert.deepEqual(Buffer.from(await backend.read("ignored")), secret);
    assert.equal(counters.single - before, 3, "directory, ciphertext and key once each");
    before = counters.single;
    const expected = createHash("sha256").update(secret).digest("hex");
    assert.equal(await backend.compareAndSwap("ignored", expected, secret), "replaced");
    assert.equal(counters.single - before, 3, "the key is read for the digest and again for the write from one observation");
    assert.equal(compliant.delete(`file:${paths.sessionFile}`), true);
    await assert.rejects(backend.read("ignored"), (error) => error?.code === "credential_backend_unverified");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function waitForChild(child, phase) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.phase === "error") {
        cleanup();
        reject(new Error(`CAS child failed: ${message.code ?? "unknown"}: ${message.message ?? "unknown"}`));
        return;
      }
      if (message?.phase !== phase) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code) => { cleanup(); reject(new Error(`CAS child exited before ${phase}: ${code}`)); };
    const cleanup = () => { child.off("message", onMessage); child.off("exit", onExit); };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function casChild(directory, profile, mode, candidate = Buffer.alloc(0)) {
  return fork(path.resolve("test/fixtures/local-session-cas-child.mjs"), [directory, profile, mode, candidate.toString("base64url")], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
}

async function lockAuthority(sessionFile) {
  const physicalDirectory = await realpath(path.dirname(sessionFile));
  const physicalSession = path.resolve(physicalDirectory, path.basename(sessionFile));
  const canonical = process.platform === "win32" ? physicalSession.toLocaleLowerCase("en-US") : physicalSession;
  const digest = createHash("sha256").update(`storage\0${canonical}`, "utf8").digest();
  return process.platform === "win32"
    ? `\\\\.\\pipe\\cuna-session-storage-${digest.toString("hex").slice(0, 40)}`
    : { host: "127.0.0.1", port: 49_152 + digest.readUInt16BE(0) % 8_192 };
}

async function listen(server, authority) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(authority, resolve);
  });
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("AES-256-GCM session uses separate restricted key/ciphertext files and deletes both", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cuna-local-session-"));
  try {
    const paths = localEncryptedSessionPaths(directory, "default");
    assert.match(paths.sessionFile, /[\\/]sessions-v1[\\/]/u);
    assert.match(paths.keyFile, /[\\/]sessions-v1[\\/]/u);
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

test("Windows ACL work uses a fresh SID, verifies first, and never repairs a tampered session file", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cuna-local-session-acl-sequencing-"));
  const paths = localEncryptedSessionPaths(directory, "acl-sequencing");
  const sessionDirectory = path.dirname(paths.sessionFile);
  const compliant = new Set();
  const calls = { inspect: [], reconcile: [] };
  const entry = (target, directoryEntry) => `${directoryEntry ? "directory" : "file"}:${target}`;
  const windowsAcl = {
    inspectOwnerOnly: async (target, directoryEntry) => {
      const currentSid = `S-1-5-21-123-456-789-${calls.inspect.length + 1}`;
      calls.inspect.push({ target, directoryEntry, currentSid });
      return { currentSid, ownerSid: currentSid, daclOwnerOnly: compliant.has(entry(target, directoryEntry)) };
    },
    reconcileNewOwnerOnly: async (target, directoryEntry) => {
      const currentSid = `S-1-5-21-123-456-789-${calls.reconcile.length + 1}`;
      const before = { currentSid, ownerSid: currentSid, daclOwnerOnly: compliant.has(entry(target, directoryEntry)) };
      calls.reconcile.push({ target, directoryEntry, currentSid });
      compliant.add(entry(target, directoryEntry));
      return { before, after: { ...before, daclOwnerOnly: true }, repaired: !before.daclOwnerOnly };
    },
  };
  try {
    const backend = new LocalEncryptedSessionBackend({ ...paths, platform: process.platform, windowsAcl });
    await backend.replace("ignored", Buffer.from(`cuna_login_${"p".repeat(43)}`));
    assert.equal(new Set(calls.reconcile.map(({ currentSid }) => currentSid)).size, calls.reconcile.length, "each new artifact observes a fresh SID instead of using a cache");
    assert.deepEqual(
      calls.reconcile.map(({ target, directoryEntry }) => ({ target, directoryEntry })),
      [
        { target: sessionDirectory, directoryEntry: true },
        { target: paths.keyFile, directoryEntry: false },
        { target: paths.sessionFile, directoryEntry: false },
      ],
      "only newly-created artifacts are reconciled",
    );

    calls.reconcile.length = 0;
    calls.inspect.length = 0;
    const secondBackend = new LocalEncryptedSessionBackend({ ...paths, platform: process.platform, windowsAcl });
    assert.deepEqual(Buffer.from(await secondBackend.read("ignored")), Buffer.from(`cuna_login_${"p".repeat(43)}`));
    assert.equal(new Set(calls.inspect.map(({ currentSid }) => currentSid)).size, calls.inspect.length, "a second backend repeats fresh owner inspection");
    assert.equal(calls.reconcile.length, 0, "an existing compliant path does not mutate ACLs");
    assert.equal(
      calls.inspect.filter(({ target, directoryEntry }) => target === sessionDirectory && directoryEntry).length,
      1,
      "the existing directory receives its full owner/DACL inspection after physical lock acquisition",
    );

    compliant.delete(entry(paths.sessionFile, false));
    calls.reconcile.length = 0;
    await assert.rejects(
      backend.read("ignored"),
      (error) => error?.code === "credential_backend_unverified" && error?.retryable === false,
      "an existing ACL change is security-unverified, not corruption or a retryable repair",
    );
    assert.equal(calls.reconcile.length, 0, "a tampered existing session file fails closed instead of being repaired");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Windows never repairs an existing noncompliant session directory", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cuna-local-session-existing-directory-"));
  const paths = localEncryptedSessionPaths(directory, "existing-unsafe-directory");
  const calls = { inspect: 0, reconcile: 0 };
  const windowsAcl = {
    inspectOwnerOnly: async () => { calls.inspect += 1; return { currentSid: "S-1-5-21-123-456-789-1001", ownerSid: "S-1-5-21-123-456-789-1001", daclOwnerOnly: false }; },
    reconcileNewOwnerOnly: async () => { calls.reconcile += 1; throw new Error("unexpected reconciliation"); },
  };
  try {
    await mkdir(path.dirname(paths.sessionFile), { recursive: true });
    const backend = new LocalEncryptedSessionBackend({ ...paths, platform: process.platform, windowsAcl });
    assert.equal((await backend.probe()).status, "unavailable");
    assert.deepEqual(calls, { inspect: 1, reconcile: 0 }, "existing unsafe storage is a fail-closed boundary, not a repair target");
    await assert.rejects(stat(paths.keyFile), (error) => error?.code === "ENOENT");
    await assert.rejects(stat(paths.sessionFile), (error) => error?.code === "ENOENT");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Windows rejects an existing object owned by a different principal even when its DACL looks current-user-only", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cuna-local-session-owner-mismatch-"));
  const paths = localEncryptedSessionPaths(directory, "foreign-owner");
  const calls = { inspect: 0, reconcile: 0 };
  const windowsAcl = {
    inspectOwnerOnly: async () => {
      calls.inspect += 1;
      return { currentSid: "S-1-5-21-123-456-789-1001", ownerSid: "S-1-5-21-999-888-777-2002", daclOwnerOnly: true };
    },
    reconcileNewOwnerOnly: async () => { calls.reconcile += 1; throw new Error("unexpected reconciliation"); },
  };
  try {
    await mkdir(path.dirname(paths.sessionFile), { recursive: true });
    const backend = new LocalEncryptedSessionBackend({ ...paths, platform: process.platform, windowsAcl });
    assert.equal((await backend.probe()).status, "unavailable");
    assert.deepEqual(calls, { inspect: 1, reconcile: 0 }, "owner mismatch fails before DACL acceptance or repair");
    await assert.rejects(stat(paths.keyFile), (error) => error?.code === "ENOENT");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Windows rejects a directory junction before ACL work and revalidates after reconciliation", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cuna-local-session-junction-"));
  const paths = localEncryptedSessionPaths(root, "junction-boundary");
  const sessionDirectory = path.dirname(paths.sessionFile);
  const physical = path.join(root, "physical");
  const beforeCalls = { inspect: 0, reconcile: 0 };
  const beforeAcl = {
    inspectOwnerOnly: async () => { beforeCalls.inspect += 1; return { currentSid: "S-1-5-21-123-456-789-1", ownerSid: "S-1-5-21-123-456-789-1", daclOwnerOnly: false }; },
    reconcileNewOwnerOnly: async () => { beforeCalls.reconcile += 1; throw new Error("unexpected reconciliation"); },
  };
  try {
    await mkdir(physical, { recursive: true });
    await symlink(physical, sessionDirectory, "junction");
    const existingJunctionBackend = new LocalEncryptedSessionBackend({ ...paths, platform: process.platform, windowsAcl: beforeAcl });
    assert.equal((await existingJunctionBackend.probe()).status, "unavailable");
    assert.deepEqual(beforeCalls, { inspect: 0, reconcile: 0 }, "a reparse point is rejected before ACL verification or mutation");

    await rm(sessionDirectory, { recursive: true, force: true });
    const afterCalls = { inspect: 0, reconcile: 0 };
    const afterAcl = {
      inspectOwnerOnly: async () => { throw new Error("unexpected inspection"); },
      reconcileNewOwnerOnly: async () => {
        afterCalls.reconcile += 1;
        const currentSid = `S-1-5-21-123-456-789-${afterCalls.reconcile}`;
        await rm(sessionDirectory, { recursive: true, force: true });
        await symlink(physical, sessionDirectory, "junction");
        const before = { currentSid, ownerSid: currentSid, daclOwnerOnly: false };
        return { before, after: { ...before, daclOwnerOnly: true }, repaired: true };
      },
    };
    const newlyCreatedBackend = new LocalEncryptedSessionBackend({ ...paths, platform: process.platform, windowsAcl: afterAcl });
    assert.equal((await newlyCreatedBackend.probe()).status, "unavailable");
    assert.deepEqual(afterCalls, { inspect: 0, reconcile: 1 }, "a newly-created directory is revalidated immediately after reconciliation");
    await assert.rejects(stat(paths.keyFile), (error) => error?.code === "ENOENT");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows SID lookup failures and changes are never cached", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cuna-local-session-sid-freshness-"));
  const paths = localEncryptedSessionPaths(directory, "sid-freshness");
  const observedSids = [];
  let attempts = 0;
  const windowsAcl = {
    inspectOwnerOnly: async () => {
      attempts += 1;
      const currentSid = `S-1-5-21-123-456-789-${attempts}`;
      observedSids.push(currentSid);
      return { currentSid, ownerSid: currentSid, daclOwnerOnly: true };
    },
    reconcileNewOwnerOnly: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient SID lookup failure");
      const currentSid = `S-1-5-21-123-456-789-${attempts}`;
      observedSids.push(currentSid);
      const before = { currentSid, ownerSid: currentSid, daclOwnerOnly: true };
      return { before, after: before, repaired: false };
    },
  };
  try {
    const backend = new LocalEncryptedSessionBackend({ ...paths, platform: process.platform, windowsAcl });
    assert.equal((await backend.probe()).status, "unavailable", "a SID lookup failure fails closed for that operation");
    assert.equal((await backend.probe()).status, "verified", "the next operation retries SID lookup rather than reusing its failure");
    assert.equal((await backend.probe()).status, "verified", "each later operation performs a new SID lookup");
    assert.equal(observedSids.includes("S-1-5-21-123-456-789-2"), true);
    assert.equal(observedSids.includes("S-1-5-21-123-456-789-3"), true, "later checks observe a new SID");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Windows ACL reconciliation timeout fails closed before any encrypted session bytes are written", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cuna-local-session-acl-timeout-"));
  const paths = localEncryptedSessionPaths(directory, "acl-timeout");
  const calls = { reconcile: 0 };
  const windowsAcl = {
    inspectOwnerOnly: async () => { throw new Error("unexpected inspection"); },
    reconcileNewOwnerOnly: async () => {
      calls.reconcile += 1;
      throw new Error("simulated ACL reconciliation timeout");
    },
  };
  try {
    const backend = new LocalEncryptedSessionBackend({ ...paths, platform: process.platform, windowsAcl });
    await assert.rejects(
      backend.replace("ignored", Buffer.from(`cuna_login_${"t".repeat(43)}`)),
      /simulated ACL reconciliation timeout/iu,
    );
    assert.deepEqual(calls, { reconcile: 1 });
    await assert.rejects(stat(paths.keyFile), (error) => error?.code === "ENOENT");
    await assert.rejects(stat(paths.sessionFile), (error) => error?.code === "ENOENT");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Windows ACL verification timeout is a retryable backend failure and preserves an existing encrypted session", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cuna-local-session-acl-read-failure-"));
  const paths = localEncryptedSessionPaths(directory, "acl-read-failure");
  const currentSid = "S-1-5-21-123-456-789-1001";
  const safeAcl = {
    inspectOwnerOnly: async () => ({ currentSid, ownerSid: currentSid, daclOwnerOnly: true }),
    reconcileNewOwnerOnly: async () => {
      const before = { currentSid, ownerSid: currentSid, daclOwnerOnly: false };
      return { before, after: { ...before, daclOwnerOnly: true }, repaired: true };
    },
  };
  const failingAcl = {
    inspectOwnerOnly: async (target) => {
      if (target === paths.keyFile) throw Object.assign(new Error("simulated ACL verification timeout"), { code: "ETIMEDOUT" });
      return { currentSid, ownerSid: currentSid, daclOwnerOnly: true };
    },
    reconcileNewOwnerOnly: async () => { throw new Error("unexpected reconciliation"); },
  };
  try {
    const writer = new LocalEncryptedSessionBackend({ ...paths, platform: process.platform, windowsAcl: safeAcl });
    await writer.replace("ignored", Buffer.from(`cuna_login_${"v".repeat(43)}`));
    const [beforeSession, beforeKey] = await Promise.all([readFile(paths.sessionFile), readFile(paths.keyFile)]);
    const reader = new LocalEncryptedSessionBackend({ ...paths, platform: process.platform, windowsAcl: failingAcl });
    await assert.rejects(
      reader.read("ignored"),
      (error) => error?.code === "credential_backend_failure" &&
        error.retryable === true &&
        error.safeDetails?.reason === "windows_acl_inspection_timeout",
    );
    assert.deepEqual(await readFile(paths.sessionFile), beforeSession, "a failed ACL observation must not erase ciphertext");
    assert.deepEqual(await readFile(paths.keyFile), beforeKey, "a failed ACL observation must not erase the key");
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
    await assert.rejects(
      backend.read("ignored"),
      (error) => error?.code === "credential_corrupt" && /key file is invalid/iu.test(error.message),
    );
    await writeFile(paths.keyFile, Buffer.alloc(32));
    if (process.platform === "win32") {
      await execFileAsync("C:\\Windows\\System32\\icacls.exe", [paths.keyFile, "/grant", "*S-1-1-0:R"]);
    } else {
      await chmod(paths.keyFile, 0o644);
    }
    assert.equal((await backend.probe()).status, "unavailable");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the next backend access completes cleanup after either half of a local delete is interrupted", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cuna-local-session-"));
  try {
    const paths = localEncryptedSessionPaths(directory, "partial-delete");
    const backend = new LocalEncryptedSessionBackend({ ...paths, platform: process.platform });

    await backend.replace("ignored", Buffer.from(`cuna_login_${"z".repeat(43)}`));
    await unlink(paths.sessionFile);
    assert.equal(await backend.read("ignored"), undefined);
    await assert.rejects(stat(paths.sessionFile), (error) => error?.code === "ENOENT");
    await assert.rejects(stat(paths.keyFile), (error) => error?.code === "ENOENT");

    await backend.replace("ignored", Buffer.from(`cuna_login_${"w".repeat(43)}`));
    await unlink(paths.keyFile);
    await assert.rejects(backend.read("ignored"), /key is unavailable/iu);
    await assert.rejects(stat(paths.sessionFile), (error) => error?.code === "ENOENT");
    await assert.rejects(stat(paths.keyFile), (error) => error?.code === "ENOENT");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("two independent processes produce exactly one encrypted-session CAS winner", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cuna-local-session-cas-"));
  const profile = "multiprocess-winner";
  const children = [];
  try {
    const backend = new LocalEncryptedSessionBackend({ ...localEncryptedSessionPaths(directory, profile), platform: process.platform });
    await backend.replace("ignored", Buffer.from("revision-one"));
    const candidates = [Buffer.from("revision-two-a"), Buffer.from("revision-two-b")];
    children.push(...candidates.map((candidate) => casChild(directory, profile, "swap", candidate)));
    await Promise.all(children.map((child) => waitForChild(child, "ready")));
    const results = children.map((child) => waitForChild(child, "result"));
    for (const child of children) child.send("go");
    const settled = await Promise.all(results);
    assert.deepEqual(settled.map(({ result }) => result).sort(), ["conflict", "replaced"]);
    const final = Buffer.from(await backend.read("ignored"));
    assert.equal(candidates.some((candidate) => candidate.equals(final)), true);
    final.fill(0);
  } finally {
    for (const child of children) child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

test("seven independent processes serialize encrypted-local refresh across the remote callback", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cuna-local-session-refresh-"));
  const profile = "multiprocess-refresh";
  const binding = Object.freeze({ profileId: profile, accountId: "https://api.getcuna.com", workspaceId: "cli-human-auth", kind: "login-code-session-v1" });
  const children = [];
  try {
    const backend = new LocalEncryptedSessionBackend({ ...localEncryptedSessionPaths(directory, profile), platform: process.platform });
    const vault = new CredentialVault({ backend, platform: process.platform });
    const material = SecretMaterial.fromUtf8("renewable-session-fixture");
    try { await vault.rotate({ binding, material }); } finally { material.dispose(); }
    const fixture = path.resolve("test/fixtures/local-session-refresh-child.mjs");
    children.push(...["a", "b", "c", "d", "e", "f", "g"].map((label) => fork(fixture, [directory, profile, label], {
      cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe", "ipc"],
    })));
    await Promise.all(children.map((child) => waitForChild(child, "ready")));
    const entered = [];
    const enteredWaiters = [];
    for (const child of children) child.on("message", (message) => {
      if (message?.phase !== "entered") return;
      const waiter = enteredWaiters.shift();
      if (waiter === undefined) entered.push({ child, message });
      else waiter({ child, message });
    });
    const nextEntered = () => entered.shift() ?? new Promise((resolve) => enteredWaiters.push(resolve));
    for (const child of children) child.send("go");
    const observed = new Set();
    for (let index = 0; index < children.length; index += 1) {
      const current = await nextEntered();
      assert.equal(observed.has(current.child.pid), false);
      observed.add(current.child.pid);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(entered.length, 0, "no sibling process may enter while the current refresh owns its authority");
      const result = waitForChild(current.child, "result");
      current.child.send("release");
      await result;
    }
    assert.equal(observed.size, 7);
  } finally {
    for (const child of children) child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

test("physical directory aliases share one CAS authority", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cuna-local-session-alias-"));
  const physical = path.join(root, "physical");
  const alias = path.join(root, "alias");
  const profile = "physical-alias";
  try {
    const physicalPaths = localEncryptedSessionPaths(physical, profile);
    const physicalBackend = new LocalEncryptedSessionBackend({ ...physicalPaths, platform: process.platform });
    const initial = Buffer.from("alias-revision-one");
    await physicalBackend.replace("ignored", initial);
    await symlink(physical, alias, process.platform === "win32" ? "junction" : "dir");
    const aliasBackend = new LocalEncryptedSessionBackend({ ...localEncryptedSessionPaths(alias, profile), platform: process.platform });
    const expected = createHash("sha256").update(initial).digest("hex");
    const results = await Promise.all([
      physicalBackend.compareAndSwap("ignored", expected, Buffer.from("alias-revision-two-a")),
      aliasBackend.compareAndSwap("ignored", expected, Buffer.from("alias-revision-two-b")),
    ]);
    assert.deepEqual(results.sort(), ["conflict", "replaced"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale expiry compare-delete cannot erase a newer process rotation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cuna-local-session-expiry-"));
  const profile = "multiprocess-expiry";
  let child;
  try {
    const backend = new LocalEncryptedSessionBackend({ ...localEncryptedSessionPaths(directory, profile), platform: process.platform });
    const expired = Buffer.from("expired-revision");
    const rotated = Buffer.from("rotated-revision");
    await backend.replace("ignored", expired);
    child = casChild(directory, profile, "delete");
    await waitForChild(child, "ready");
    const expected = createHash("sha256").update(expired).digest("hex");
    assert.equal(await backend.compareAndSwap("ignored", expected, rotated), "replaced");
    const result = waitForChild(child, "result");
    child.send("go");
    assert.equal((await result).result, "conflict");
    const final = Buffer.from(await backend.read("ignored"));
    assert.deepEqual(final, rotated);
    final.fill(0);
  } finally {
    child?.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

test("kernel lock collision reaches a bounded fail-closed timeout without mutation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cuna-local-session-lock-"));
  const profile = "lock-timeout";
  const paths = localEncryptedSessionPaths(directory, profile);
  const holder = createServer((socket) => socket.destroy());
  try {
    const backend = new LocalEncryptedSessionBackend({ ...paths, platform: process.platform, lockTimeoutMs: 50 });
    const original = Buffer.from("original-value");
    await backend.replace("ignored", original);
    const expected = createHash("sha256").update(original).digest("hex");
    await listen(holder, await lockAuthority(paths.sessionFile));
    await assert.rejects(
      backend.compareAndSwap("ignored", expected, Buffer.from("must-not-commit")),
      (error) => error?.code === "credential_backend_failure" &&
        error.retryable === true &&
        error.safeDetails?.reason === "process_lock_unavailable",
    );
    await close(holder);
    assert.deepEqual(Buffer.from(await backend.read("ignored")), original);
  } finally {
    if (holder.listening) await close(holder);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a contender waits for a legitimate encrypted-session lock holder and then observes its CAS boundary", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cuna-local-session-lock-release-"));
  const profile = "lock-release";
  const paths = localEncryptedSessionPaths(directory, profile);
  const holder = createServer((socket) => socket.destroy());
  let releaseTimer;
  try {
    const backend = new LocalEncryptedSessionBackend({ ...paths, platform: process.platform, lockTimeoutMs: 500 });
    const original = Buffer.from("holder-original-value");
    await backend.replace("ignored", original);
    const expected = createHash("sha256").update(original).digest("hex");
    await listen(holder, await lockAuthority(paths.sessionFile));
    releaseTimer = setTimeout(() => { void close(holder); }, 80);
    assert.equal(
      await backend.compareAndSwap("ignored", expected, Buffer.from("contender-committed-value")),
      "replaced",
      "a healthy lock holder releases before the caller deadline instead of causing a false busy failure",
    );
    assert.deepEqual(Buffer.from(await backend.read("ignored")), Buffer.from("contender-committed-value"));
  } finally {
    if (releaseTimer !== undefined) clearTimeout(releaseTimer);
    if (holder.listening) await close(holder);
    await rm(directory, { recursive: true, force: true });
  }
});
