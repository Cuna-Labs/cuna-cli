import assert from "node:assert/strict";
import test from "node:test";

import {
  CREDENTIAL_BACKEND_PROTOCOL,
  CredentialBoundaryError,
  CredentialVault,
  SecretMaterial,
  bindingDigest,
  createLinuxSecretServiceBackend,
  createMacOsKeychainBackend,
  createSecureProcessRunner,
  createUnavailableCredentialBackend,
  createWindowsCredentialManagerBackend,
  credentialTarget,
} from "../dist/credentials/index.js";

const NOW = 1_800_000_000_000;
const BINDING = Object.freeze({
  profileId: "développement",
  accountId: "account-1",
  workspaceId: "workspace-1",
  kind: "runa-refresh-token",
});

class MemorySecureBackend {
  constructor(platform = process.platform) {
    this.backendId = "test-secure-vault";
    this.platform = platform;
    this.values = new Map();
    this.replaceCalls = 0;
    this.readCalls = 0;
    this.failNextReplace = false;
  }

  async probe() {
    return {
      protocol: CREDENTIAL_BACKEND_PROTOCOL,
      backendId: this.backendId,
      platform: this.platform,
      status: "verified",
      observedAt: NOW - 1,
      expiresAt: NOW + 60_000,
      source: "live_round_trip",
    };
  }

  async read(target) {
    this.readCalls += 1;
    const value = this.values.get(target);
    return value === undefined ? undefined : Uint8Array.from(value);
  }

  async replace(target, value) {
    this.replaceCalls += 1;
    if (this.failNextReplace) {
      this.failNextReplace = false;
      throw new Error("simulated atomic replacement failure");
    }
    this.values.set(target, Uint8Array.from(value));
  }

  async delete(target) {
    return this.values.delete(target) ? "deleted" : "absent";
  }
}

function utf8(material) {
  return material.withBytes((bytes) => new TextDecoder().decode(bytes));
}

test("secret material is redacted from string, JSON, and inspection and zeroizes on disposal", () => {
  const secret = SecretMaterial.fromUtf8("sentinel-secret-never-print");
  assert.equal(String(secret), "[REDACTED]");
  assert.equal(JSON.stringify({ secret }), '{"secret":"[REDACTED]"}');
  assert.doesNotMatch(String(secret[Symbol.for("nodejs.util.inspect.custom")]()), /sentinel-secret/u);
  secret.dispose();
  assert.throws(() => secret.copyBytes(), (error) => error instanceof CredentialBoundaryError && error.code === "credential_missing");
});

test("credential binding is Unicode-stable, opaque, and collision resistant across account/workspace/profile", () => {
  const decomposed = { ...BINDING, profileId: "de\u0301veloppement" };
  assert.equal(credentialTarget(BINDING), credentialTarget(decomposed));
  assert.doesNotMatch(credentialTarget(BINDING), /account-1|workspace-1|développement/u);
  assert.notEqual(credentialTarget(BINDING), credentialTarget({ ...BINDING, accountId: "account-2" }));
  assert.notEqual(credentialTarget(BINDING), credentialTarget({ ...BINDING, workspaceId: "workspace-2" }));
  assert.notEqual(credentialTarget(BINDING), credentialTarget({ ...BINDING, profileId: "production" }));
  assert.match(bindingDigest(BINDING), /^[a-f0-9]{64}$/u);
});

test("vault rotates versioned credentials and rejects stale compare-and-swap revisions", async () => {
  const backend = new MemorySecureBackend();
  const vault = new CredentialVault({ backend, clock: () => NOW });
  const first = SecretMaterial.fromUtf8("refresh-v1");
  const firstStatus = await vault.rotate({ binding: BINDING, material: first, expiresAt: NOW + 10_000 });
  assert.equal(firstStatus.revision, 1);
  const second = SecretMaterial.fromUtf8("refresh-v2");
  await assert.rejects(
    vault.rotate({ binding: BINDING, material: second, expectedRevision: 0, expiresAt: NOW + 20_000 }),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_revision_conflict",
  );
  const loaded = await vault.load(BINDING);
  assert.equal(loaded.revision, 1);
  assert.equal(utf8(loaded.material), "refresh-v1");
  loaded.material.dispose();
  first.dispose();
  second.dispose();
});

test("expired credentials fail closed and status never reports them as present", async () => {
  const backend = new MemorySecureBackend();
  let now = NOW;
  const vault = new CredentialVault({ backend, clock: () => now });
  const material = SecretMaterial.fromUtf8("short-lived-refresh");
  await vault.rotate({ binding: BINDING, material, expiresAt: NOW + 1 });
  material.dispose();
  assert.equal((await vault.status(BINDING)).state, "present");
  now = NOW + 1;
  assert.equal(await vault.load(BINDING), undefined);
  const expired = await vault.status(BINDING);
  assert.equal(expired.state, "expired");
  assert.equal(expired.expiresAt, NOW + 1);
});

test("atomic backend failure preserves the previously valid credential", async () => {
  const backend = new MemorySecureBackend();
  const vault = new CredentialVault({ backend, clock: () => NOW });
  const original = SecretMaterial.fromUtf8("old-renewable-secret");
  await vault.rotate({ binding: BINDING, material: original });
  backend.failNextReplace = true;
  const replacement = SecretMaterial.fromUtf8("new-renewable-secret");
  await assert.rejects(vault.rotate({ binding: BINDING, material: replacement, expectedRevision: 1 }));
  const loaded = await vault.load(BINDING);
  assert.equal(loaded.revision, 1);
  assert.equal(utf8(loaded.material), "old-renewable-secret");
  loaded.material.dispose();
  original.dispose();
  replacement.dispose();
});

test("concurrent refreshes coalesce once and produce one atomic revision", async () => {
  const backend = new MemorySecureBackend();
  const vault = new CredentialVault({ backend, clock: () => NOW });
  const original = SecretMaterial.fromUtf8("refresh-old");
  await vault.rotate({ binding: BINDING, material: original });
  let refreshCalls = 0;
  const refresher = async (current) => {
    refreshCalls += 1;
    assert.equal(current.revision, 1);
    assert.equal(utf8(current.material), "refresh-old");
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { status: "rotated", material: SecretMaterial.fromUtf8("refresh-new"), expiresAt: NOW + 60_000 };
  };
  const snapshots = await Promise.all(Array.from({ length: 24 }, async () => vault.refresh(BINDING, refresher)));
  assert.equal(refreshCalls, 1);
  assert.equal(backend.replaceCalls, 2, "one initial write and one coalesced refresh write");
  for (const snapshot of snapshots) {
    assert.equal(snapshot.revision, 2);
    assert.equal(utf8(snapshot.material), "refresh-new");
    snapshot.material.dispose();
  }
  original.dispose();
});

test("server refresh rejection deletes renewable material and leaves redacted revoked status", async () => {
  const backend = new MemorySecureBackend();
  const vault = new CredentialVault({ backend, clock: () => NOW });
  const secret = SecretMaterial.fromUtf8("revoked-refresh-secret");
  await vault.rotate({ binding: BINDING, material: secret });
  await assert.rejects(
    vault.refresh(BINDING, async () => ({ status: "rejected" })),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_revoked",
  );
  assert.equal(await vault.load(BINDING), undefined);
  const status = await vault.status(BINDING);
  assert.equal(status.state, "revoked");
  assert.doesNotMatch(JSON.stringify(status), /revoked-refresh-secret/u);
  secret.dispose();
});

test("refresh exceptions preserve the old credential and do not retain untrusted secret-bearing causes", async () => {
  const backend = new MemorySecureBackend();
  const vault = new CredentialVault({ backend, clock: () => NOW });
  const secret = SecretMaterial.fromUtf8("stable-refresh-secret");
  await vault.rotate({ binding: BINDING, material: secret });
  let observedError;
  try {
    await vault.refresh(BINDING, async () => { throw new Error("provider leaked secret-token-in-cause"); });
  } catch (error) {
    observedError = error;
  }
  assert.ok(observedError instanceof CredentialBoundaryError);
  assert.equal(observedError.code, "credential_refresh_failed");
  assert.equal(observedError.cause, undefined);
  assert.doesNotMatch(String(observedError), /secret-token-in-cause/u);
  const loaded = await vault.load(BINDING);
  assert.equal(utf8(loaded.material), "stable-refresh-secret");
  loaded.material.dispose();
  secret.dispose();
});

test("tampering and cross-binding substitution are reported as corruption before secret release", async () => {
  const backend = new MemorySecureBackend();
  const vault = new CredentialVault({ backend, clock: () => NOW });
  const secret = SecretMaterial.fromUtf8("bound-secret");
  await vault.rotate({ binding: BINDING, material: secret });
  const originalTarget = credentialTarget(BINDING);
  const other = { ...BINDING, workspaceId: "workspace-other" };
  backend.values.set(credentialTarget(other), Uint8Array.from(backend.values.get(originalTarget)));
  await assert.rejects(
    vault.load(other),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_corrupt",
  );
  const tampered = backend.values.get(originalTarget);
  tampered[tampered.length - 1] ^= 0xff;
  const status = await vault.status(BINDING);
  assert.equal(status.state, "corrupt");
  secret.dispose();
});

test("absence of an approved secure backend fails closed before any plaintext fallback", async () => {
  const backend = createUnavailableCredentialBackend({
    backendId: "no-secure-store",
    platform: process.platform,
    reason: "test negative control",
    clock: () => NOW,
  });
  const vault = new CredentialVault({ backend, clock: () => NOW });
  const secret = SecretMaterial.fromUtf8("must-never-hit-disk");
  await assert.rejects(
    vault.rotate({ binding: BINDING, material: secret }),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_backend_unavailable",
  );
  assert.equal((await vault.status(BINDING)).state, "unavailable");
  secret.dispose();
});

test("self-reported or cross-platform vault evidence cannot authorize credential access", async () => {
  const backend = new MemorySecureBackend("linux");
  backend.probe = async () => ({
    protocol: CREDENTIAL_BACKEND_PROTOCOL,
    backendId: backend.backendId,
    platform: "linux",
    status: "verified",
    observedAt: NOW - 1,
    expiresAt: NOW + 60_000,
    source: "backend_absent",
  });
  const vault = new CredentialVault({ backend, clock: () => NOW, platform: "win32" });
  const secret = SecretMaterial.fromUtf8("must-not-be-admitted");
  await assert.rejects(
    vault.rotate({ binding: BINDING, material: secret }),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_backend_unverified",
  );
  assert.equal(backend.replaceCalls, 0);
  secret.dispose();
});

test("secure process runner kills oversized output without returning it", async () => {
  const runner = createSecureProcessRunner();
  await assert.rejects(
    runner.run({
      executable: process.execPath,
      cwd: process.cwd(),
      args: ["-e", "process.stdout.write('x'.repeat(4096))"],
      maximumOutputBytes: 32,
    }),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_output_oversized",
  );
});

test("Linux Secret Service adapter transports protected values only through stdin", async () => {
  const calls = [];
  const values = new Map();
  const runner = {
    run: async (request) => {
      const captured = {
        ...request,
        args: [...request.args],
        environment: { ...request.environment },
        stdin: request.stdin === undefined ? undefined : Uint8Array.from(request.stdin),
      };
      calls.push(captured);
      const operation = request.args[0];
      const target = request.args.at(-1);
      if (operation === "store") {
        const value = request.stdin.slice(0, -1);
        values.set(target, Uint8Array.from(value));
        return { exitCode: 0, signal: null, stdout: new Uint8Array(), stderrPresent: false };
      }
      if (operation === "lookup") {
        const value = values.get(target);
        if (value === undefined) return { exitCode: 1, signal: null, stdout: new Uint8Array(), stderrPresent: false };
        const stdout = new Uint8Array(value.length + 1);
        stdout.set(value);
        stdout[stdout.length - 1] = 0x0a;
        return { exitCode: 0, signal: null, stdout, stderrPresent: false };
      }
      values.delete(target);
      return { exitCode: 0, signal: null, stdout: new Uint8Array(), stderrPresent: false };
    },
  };
  const backend = createLinuxSecretServiceBackend({ runner, environment: { XDG_RUNTIME_DIR: "/run/user/1000" } });
  const sentinel = new TextEncoder().encode("linux-secret-sentinel");
  await backend.replace("opaque-target", sentinel);
  const observed = await backend.read("opaque-target");
  assert.equal(new TextDecoder().decode(observed), "linux-secret-sentinel");
  for (const call of calls) {
    const publicTransport = JSON.stringify({ args: call.args, environment: call.environment });
    assert.doesNotMatch(publicTransport, /linux-secret-sentinel/u);
  }
  assert.match(new TextDecoder().decode(calls[0].stdin), /linux-secret-sentinel/u, "protected value is confined to stdin");
  observed.fill(0);
  sentinel.fill(0);
});

test("Windows Credential Manager adapter transports protected values only through stdin", async () => {
  const calls = [];
  const values = new Map();
  const runner = {
    run: async (request) => {
      const captured = {
        ...request,
        args: [...request.args],
        environment: { ...request.environment },
        stdin: Uint8Array.from(request.stdin),
      };
      calls.push(captured);
      const body = JSON.parse(new TextDecoder().decode(request.stdin));
      let response;
      if (body.operation === "replace") {
        values.set(body.target, body.valueBase64);
        response = { ok: true, status: "replaced" };
      } else if (body.operation === "read") {
        response = values.has(body.target)
          ? { ok: true, status: "present", valueBase64: values.get(body.target) }
          : { ok: true, status: "absent" };
      } else {
        const deleted = values.delete(body.target);
        response = { ok: true, status: deleted ? "deleted" : "absent" };
      }
      return {
        exitCode: 0,
        signal: null,
        stdout: new TextEncoder().encode(JSON.stringify(response)),
        stderrPresent: false,
      };
    },
  };
  const backend = createWindowsCredentialManagerBackend({ runner, environment: { SystemRoot: "C:\\Windows" } });
  const text = "windows-secret-sentinel";
  const encoded = new TextEncoder().encode(text);
  await backend.replace("opaque-target", encoded);
  const observed = await backend.read("opaque-target");
  assert.equal(new TextDecoder().decode(observed), text);
  const encodedSecret = Buffer.from(text).toString("base64");
  for (const call of calls) {
    const publicTransport = JSON.stringify({ args: call.args, environment: call.environment });
    assert.doesNotMatch(publicTransport, /windows-secret-sentinel/u);
    assert.equal(publicTransport.includes(encodedSecret), false, "base64 secret must not enter argv or environment");
  }
  assert.equal(new TextDecoder().decode(calls[0].stdin).includes(encodedSecret), true);
  observed.fill(0);
  encoded.fill(0);
});

test("secure credential helpers require absolute executable and working-directory authority", async () => {
  const runner = createSecureProcessRunner();
  await assert.rejects(
    runner.run({ executable: "powershell.exe", cwd: process.cwd(), args: [] }),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_process_failed",
  );
  await assert.rejects(
    runner.run({ executable: process.execPath, cwd: ".", args: [] }),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_process_failed",
  );
});

test("Windows Credential Manager pins PowerShell and cwd beneath SystemRoot", async () => {
  const calls = [];
  const runner = {
    run: async (request) => {
      calls.push(request);
      return {
        exitCode: 0,
        signal: null,
        stdout: new TextEncoder().encode(JSON.stringify({ ok: true, status: "absent" })),
        stderrPresent: false,
      };
    },
  };
  const backend = createWindowsCredentialManagerBackend({
    runner,
    environment: { SystemRoot: "C:\\Windows" },
  });
  assert.equal(await backend.read("opaque-target"), undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(calls[0].cwd, "C:\\Windows\\System32");
  assert.equal(Object.hasOwn(calls[0].environment, "PATH"), false);
});

test("macOS adapter refuses argv-based Keychain fallback when no native bridge exists", async () => {
  const backend = createMacOsKeychainBackend({ clock: () => NOW });
  const evidence = await backend.probe();
  assert.equal(evidence.status, "unavailable");
  await assert.rejects(
    backend.replace("target", new TextEncoder().encode("never-on-security-dash-w")),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_backend_unavailable",
  );
});
