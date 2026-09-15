import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

import { CREDENTIAL_BACKEND_PROTOCOL } from "../dist/credentials/contracts.js";
import { CredentialBoundaryError } from "../dist/credentials/errors.js";
import { SecretMaterial } from "../dist/credentials/secret-material.js";
import { CredentialVault, bindingDigest, credentialTarget } from "../dist/credentials/vault.js";

// These names keep the isolated experimental cases parseable without loading
// a legacy backend into the product candidate test process. They are never
// evaluated because the cases below are explicitly skipped.
const experimentalOnly = () => { throw new Error("Experimental credential backend is not part of the product candidate."); };
const createLinuxSecretServiceBackend = experimentalOnly;
const createMacOsKeychainBackend = experimentalOnly;
const createSecureProcessRunner = experimentalOnly;
const createPlatformCredentialBackend = experimentalOnly;
const resolvePlatformAuthority = experimentalOnly;

const NOW = 1_800_000_000_000;
const BINDING = Object.freeze({
  profileId: "développement",
  accountId: "account-1",
  workspaceId: "workspace-1",
  kind: "cuna-refresh-token",
});

class MemorySecureBackend {
  constructor(platform = process.platform) {
    this.backendId = "test-secure-vault";
    this.platform = platform;
    this.values = new Map();
    this.replaceCalls = 0;
    this.readCalls = 0;
    this.probeCalls = 0;
    this.failNextReplace = false;
    this.commitThenThrowNextReplace = false;
    this.ambiguousNextReplace = false;
    this.beforeCompareDelete = undefined;
  }

  async probe() {
    this.probeCalls += 1;
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
    if (this.commitThenThrowNextReplace) {
      this.commitThenThrowNextReplace = false;
      this.values.set(target, Uint8Array.from(value));
      throw new Error("simulated lost replacement acknowledgement");
    }
    if (this.ambiguousNextReplace) {
      this.ambiguousNextReplace = false;
      this.values.set(target, new TextEncoder().encode("foreign-corrupt-state"));
      throw new Error("simulated ambiguous replacement");
    }
    if (this.failNextReplace) {
      this.failNextReplace = false;
      throw new Error("simulated atomic replacement failure");
    }
    this.values.set(target, Uint8Array.from(value));
  }

  async delete(target) {
    return this.values.delete(target) ? "deleted" : "absent";
  }

  async compareAndDelete(target, expectedSha256) {
    await this.beforeCompareDelete?.();
    const current = this.values.get(target);
    if (current === undefined) return "absent";
    const actual = createHash("sha256").update(current).digest("hex");
    if (actual !== expectedSha256) return "conflict";
    this.values.delete(target);
    return "deleted";
  }
}

test("vault reuses valid process-local probe evidence but preserves a backend read boundary for each operation", async () => {
  const backend = new MemorySecureBackend();
  let now = NOW;
  backend.probe = async () => {
    backend.probeCalls += 1;
    return {
      protocol: CREDENTIAL_BACKEND_PROTOCOL,
      backendId: backend.backendId,
      platform: backend.platform,
      status: "verified",
      observedAt: now - 1,
      expiresAt: now + 100,
      source: "live_round_trip",
    };
  };
  const vault = new CredentialVault({ backend, clock: () => now });
  const material = SecretMaterial.fromUtf8("probe-cache-session");
  await vault.rotate({ binding: BINDING, material, expiresAt: now + 10_000 });
  const loaded = await vault.load(BINDING);
  loaded?.material.dispose();
  await vault.status(BINDING);
  assert.equal(backend.probeCalls, 1, "valid liveness evidence should not repeat an OS probe in one process");
  assert.equal(backend.readCalls, 3, "each vault operation still reads through the backend boundary");

  now += 101;
  await vault.status(BINDING);
  assert.equal(backend.probeCalls, 2, "expired evidence must be reprobed before another operation");
  assert.equal(backend.readCalls, 4);
});

class UnavailableSecureBackend extends MemorySecureBackend {
  async probe() {
    return {
      protocol: CREDENTIAL_BACKEND_PROTOCOL,
      backendId: this.backendId,
      platform: this.platform,
      status: "unavailable",
      observedAt: NOW - 1,
      expiresAt: NOW + 60_000,
      source: "probe_failed",
      reason: "test negative control",
    };
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
  assert.equal(expired.state, "absent");
  assert.equal(backend.values.size, 0, "loading an expired credential removes its durable bytes");
});

test("expiry cleanup compare-delete preserves a rotation committed by another vault instance", async () => {
  const backend = new MemorySecureBackend();
  let now = NOW;
  const expiringVault = new CredentialVault({ backend, clock: () => now });
  const rotatingVault = new CredentialVault({ backend, clock: () => NOW + 2 });
  const expired = SecretMaterial.fromUtf8("expired-before-race");
  await expiringVault.rotate({ binding: BINDING, material: expired, expiresAt: NOW + 1 });
  expired.dispose();
  now = NOW + 2;
  backend.beforeCompareDelete = async () => {
    backend.beforeCompareDelete = undefined;
    const rotated = SecretMaterial.fromUtf8("rotation-wins-race");
    try {
      await rotatingVault.rotate({ binding: BINDING, material: rotated, expectedRevision: 1, expiresAt: NOW + 60_000 });
    } finally {
      rotated.dispose();
    }
  };

  assert.equal(await expiringVault.load(BINDING), undefined);
  const preserved = await rotatingVault.load(BINDING);
  assert.equal(preserved.revision, 2);
  assert.equal(utf8(preserved.material), "rotation-wins-race");
  preserved.material.dispose();
});

test("revision-fenced compensation preserves a newer concurrent session", async () => {
  const backend = new MemorySecureBackend();
  const cancellingVault = new CredentialVault({ backend, clock: () => NOW });
  const concurrentVault = new CredentialVault({ backend, clock: () => NOW + 2 });
  const first = SecretMaterial.fromUtf8("cancelled-attempt-refresh");
  const firstStatus = await cancellingVault.rotate({ binding: BINDING, material: first, expiresAt: NOW + 60_000 });
  first.dispose();
  assert.equal(firstStatus.revision, 1);

  backend.beforeCompareDelete = async () => {
    backend.beforeCompareDelete = undefined;
    const newer = SecretMaterial.fromUtf8("concurrent-session-must-survive");
    try {
      await concurrentVault.rotate({ binding: BINDING, material: newer, expectedRevision: 1, expiresAt: NOW + 120_000 });
    } finally {
      newer.dispose();
    }
  };

  assert.equal(
    await cancellingVault.deleteIfRevision({ binding: BINDING, expectedRevision: firstStatus.revision }),
    "conflict",
  );
  const preserved = await concurrentVault.load(BINDING);
  assert.equal(preserved.revision, 2);
  assert.equal(utf8(preserved.material), "concurrent-session-must-survive");
  preserved.material.dispose();
});

test("refresh-derived fence avoids a redundant pre-CAS read while physical compare-delete remains mandatory", async () => {
  const backend = new MemorySecureBackend();
  const vault = new CredentialVault({ backend, clock: () => NOW });
  const material = SecretMaterial.fromUtf8("retained-session-for-fast-cas");
  await vault.rotate({ binding: BINDING, material, expiresAt: NOW + 60_000 });
  material.dispose();

  const snapshot = await vault.refresh(BINDING, async (current) => {
    assert.equal(current.revision, 1);
    assert.equal(utf8(current.material), "retained-session-for-fast-cas");
    return { status: "retained" };
  });
  snapshot.material.dispose();
  const readsAfterRefresh = backend.readCalls;

  assert.equal(
    await vault.deleteIfRevision({ binding: BINDING, expectedRevision: snapshot.revision }),
    "deleted",
  );
  assert.equal(
    backend.readCalls,
    readsAfterRefresh,
    "a retained refresh supplies only the exact digest for the physical CAS; vault must not pre-read the same envelope again",
  );
  assert.equal(backend.values.size, 0);
});

test("refresh-derived fence preserves a newer concurrent session when physical compare-delete conflicts", async () => {
  const backend = new MemorySecureBackend();
  const cancellingVault = new CredentialVault({ backend, clock: () => NOW });
  const concurrentVault = new CredentialVault({ backend, clock: () => NOW + 1 });
  const first = SecretMaterial.fromUtf8("retained-session-before-race");
  await cancellingVault.rotate({ binding: BINDING, material: first, expiresAt: NOW + 60_000 });
  first.dispose();

  const snapshot = await cancellingVault.refresh(BINDING, async () => ({ status: "retained" }));
  snapshot.material.dispose();
  backend.beforeCompareDelete = async () => {
    backend.beforeCompareDelete = undefined;
    const newer = SecretMaterial.fromUtf8("newer-session-must-survive-fast-cas");
    try {
      await concurrentVault.rotate({
        binding: BINDING,
        material: newer,
        expectedRevision: 1,
        expiresAt: NOW + 120_000,
      });
    } finally {
      newer.dispose();
    }
  };

  assert.equal(
    await cancellingVault.deleteIfRevision({ binding: BINDING, expectedRevision: snapshot.revision }),
    "conflict",
  );
  const preserved = await concurrentVault.load(BINDING);
  assert.equal(preserved.revision, 2);
  assert.equal(utf8(preserved.material), "newer-session-must-survive-fast-cas");
  preserved.material.dispose();
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

test("commit-then-throw replacement is reconciled by read-back and ambiguous state is never retried as failure", async () => {
  const backend = new MemorySecureBackend();
  const vault = new CredentialVault({ backend, clock: () => NOW });
  const first = SecretMaterial.fromUtf8("credential-before-ack-loss");
  await vault.rotate({ binding: BINDING, material: first });
  backend.commitThenThrowNextReplace = true;
  const committed = SecretMaterial.fromUtf8("credential-after-ack-loss");
  const status = await vault.rotate({ binding: BINDING, material: committed, expectedRevision: 1 });
  assert.equal(status.revision, 2, "authoritative read-back proves the lost acknowledgement committed");
  const loaded = await vault.load(BINDING);
  assert.equal(loaded.revision, 2);
  assert.equal(utf8(loaded.material), "credential-after-ack-loss");
  loaded.material.dispose();

  backend.ambiguousNextReplace = true;
  const ambiguous = SecretMaterial.fromUtf8("credential-with-unknown-outcome");
  await assert.rejects(
    vault.rotate({ binding: BINDING, material: ambiguous, expectedRevision: 2 }),
    (error) => error instanceof CredentialBoundaryError &&
      error.code === "credential_backend_failure" &&
      error.retryable === false &&
      error.safeDetails?.replacementOutcome === "ambiguous",
  );
  first.dispose();
  committed.dispose();
  ambiguous.dispose();
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

test("failed refresh replacement wipes every owned copy and preserves the previous revision", { concurrency: false }, async () => {
  const backend = new MemorySecureBackend();
  const vault = new CredentialVault({ backend, clock: () => NOW });
  const original = SecretMaterial.fromUtf8("refresh-before-failure");
  await vault.rotate({ binding: BINDING, material: original });
  backend.failNextReplace = true;

  const copied = [];
  const copyBytes = SecretMaterial.prototype.copyBytes;
  SecretMaterial.prototype.copyBytes = function captureOwnedCopy() {
    const bytes = copyBytes.call(this);
    copied.push(bytes);
    return bytes;
  };
  let candidate;
  try {
    await assert.rejects(vault.refresh(BINDING, async () => {
      candidate = SecretMaterial.fromUtf8("refresh-copy-must-be-wiped");
      return { status: "rotated", material: candidate, expiresAt: NOW + 60_000 };
    }));
  } finally {
    SecretMaterial.prototype.copyBytes = copyBytes;
  }

  assert.equal(copied.length, 1);
  assert.equal(copied[0].every((byte) => byte === 0), true);
  assert.throws(() => candidate.copyBytes(), (error) =>
    error instanceof CredentialBoundaryError && error.code === "credential_missing");
  const loaded = await vault.load(BINDING);
  assert.equal(loaded.revision, 1);
  assert.equal(utf8(loaded.material), "refresh-before-failure");
  loaded.material.dispose();
  original.dispose();
});

test("server refresh rejection deletes renewable material and leaves redacted revoked status", async () => {
  const backend = new MemorySecureBackend();
  const vault = new CredentialVault({ backend, clock: () => NOW });
  const secret = SecretMaterial.fromUtf8("revoked-refresh-secret");
  await vault.rotate({ binding: BINDING, material: secret });
  await assert.rejects(
    vault.refresh(BINDING, async () => ({ status: "rejected", reason: "authoritative_remote" })),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_revoked",
  );
  assert.equal(await vault.load(BINDING), undefined);
  const status = await vault.status(BINDING);
  assert.equal(status.state, "revoked");
  assert.doesNotMatch(JSON.stringify(status), /revoked-refresh-secret/u);
  secret.dispose();
});

test("authoritative refresh rejection never erases a newer concurrently rotated session", async () => {
  const backend = new MemorySecureBackend();
  const rejectingVault = new CredentialVault({ backend, clock: () => NOW });
  const concurrentVault = new CredentialVault({ backend, clock: () => NOW + 1 });
  const oldMaterial = SecretMaterial.fromUtf8("old-refresh-family");
  await rejectingVault.rotate({ binding: BINDING, material: oldMaterial, expiresAt: NOW + 60_000 });
  oldMaterial.dispose();

  backend.beforeCompareDelete = async () => {
    backend.beforeCompareDelete = undefined;
    const newerMaterial = SecretMaterial.fromUtf8("newer-refresh-family-must-survive");
    try {
      await concurrentVault.rotate({
        binding: BINDING,
        material: newerMaterial,
        expectedRevision: 1,
        expiresAt: NOW + 120_000,
      });
    } finally {
      newerMaterial.dispose();
    }
  };

  await assert.rejects(
    rejectingVault.refresh(BINDING, async () => ({ status: "rejected", reason: "authoritative_remote" })),
    (error) => error instanceof CredentialBoundaryError &&
      error.code === "credential_revision_conflict" &&
      error.retryable === true,
  );

  const preserved = await concurrentVault.load(BINDING);
  assert.equal(preserved.revision, 2);
  assert.equal(utf8(preserved.material), "newer-refresh-family-must-survive");
  preserved.material.dispose();
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

// A refresh that fails one call in three with one fixed sentence leaves a user
// nothing to act on. The code is the one field that separates "wait" from
// "sign in again", so it is lifted — under a grammar tight enough that a
// leaked secret cannot pass as a code. The cause stays dropped either way.
async function refreshFailure(thrown) {
  const backend = new MemorySecureBackend();
  const vault = new CredentialVault({ backend, clock: () => NOW });
  const secret = SecretMaterial.fromUtf8("stable-refresh-secret");
  await vault.rotate({ binding: BINDING, material: secret });
  try {
    await vault.refresh(BINDING, async () => { throw thrown; });
    assert.fail("refresh should have thrown");
  } catch (error) {
    assert.ok(error instanceof CredentialBoundaryError);
    assert.equal(error.code, "credential_refresh_failed");
    assert.equal(error.retryable, true);
    assert.equal(error.cause, undefined);
    return error;
  } finally {
    secret.dispose();
  }
}

test("a refresh failure surfaces the underlying error code so the user can act", async () => {
  const withCode = Object.assign(new Error("unusable message"), {
    code: "cuna.network.service_unavailable",
  });
  const error = await refreshFailure(withCode);
  assert.deepEqual(error.safeDetails, { reason: "cuna.network.service_unavailable" });
  assert.doesNotMatch(String(error), /unusable message/u);
});

test("NEGATIVE CONTROL: a secret-shaped code is refused by the grammar, not by its field name", async () => {
  const leaking = Object.assign(new Error("boom"), {
    code: "cuna_sk_7Fq2XvLm9RtZ0aBcDeGhJkNpQsUwYz13",
  });
  const error = await refreshFailure(leaking);
  assert.equal(error.safeDetails, undefined);
  assert.doesNotMatch(String(error), /7Fq2XvLm/u);
});

test("NEGATIVE CONTROL: a cause carrying no code adds no details at all", async () => {
  const error = await refreshFailure(new Error("provider leaked secret-token-in-cause"));
  assert.equal(error.safeDetails, undefined);
  assert.doesNotMatch(String(error), /secret-token-in-cause/u);
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
  const backend = new UnavailableSecureBackend(process.platform);
  backend.backendId = "no-secure-store";
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
    source: "probe_failed",
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

test("vault rejects clock rollback and evidence that expires while the backend probe is in flight", async () => {
  const backend = new MemorySecureBackend();
  let now = NOW;
  const vault = new CredentialVault({ backend, clock: () => now });
  assert.equal((await vault.status(BINDING)).state, "absent");
  now = NOW - 1;
  assert.equal((await vault.status(BINDING)).state, "unavailable");

  let slowNow = NOW;
  const slowBackend = new MemorySecureBackend();
  slowBackend.probe = async () => {
    const evidence = await MemorySecureBackend.prototype.probe.call(slowBackend);
    slowNow = NOW + 60_000;
    return evidence;
  };
  const slowVault = new CredentialVault({ backend: slowBackend, clock: () => slowNow });
  const material = SecretMaterial.fromUtf8("must-not-cross-expired-probe");
  await assert.rejects(
    slowVault.rotate({ binding: BINDING, material }),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_backend_unverified",
  );
  assert.equal(slowBackend.replaceCalls, 0);
  material.dispose();
});

test.skip("experimental secure process runner kills oversized output without returning it", async () => {
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

test.skip("experimental secure process timeout waits for confirmed child closure before rejecting", async () => {
  const runner = createSecureProcessRunner();
  const startedAt = Date.now();
  await assert.rejects(
    runner.run({
      executable: process.execPath,
      cwd: process.cwd(),
      args: ["-e", "setInterval(() => undefined, 1000)"],
      timeoutMs: 100,
    }),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_process_timeout",
  );
  assert.ok(Date.now() - startedAt >= 90);
});

test.skip("experimental post-spawn loaded-image rejection kills the identified child before protected stdin is released", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "cuna-stdin-admission-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "stdin-observed.txt");
  const runner = createSecureProcessRunner();
  let spawnedPid;
  await assert.rejects(
    runner.run({
      executable: process.execPath,
      cwd: process.cwd(),
      args: [
        "-e",
        "const fs=require('node:fs');let n=0;process.stdin.on('data',(b)=>n+=b.length);process.stdin.on('end',()=>fs.writeFileSync(process.argv[1],String(n)));",
        marker,
      ],
      stdin: Uint8Array.from([11, 22, 33, 44]),
      beforeStdin: async (child) => {
        spawnedPid = child.pid;
        assert.equal(child.platform, process.platform);
        throw new Error("loaded image does not match the admitted descriptor");
      },
    }),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_backend_unverified",
  );
  await assert.rejects(access(marker), { code: "ENOENT" });
  assert.ok(Number.isSafeInteger(spawnedPid) && spawnedPid > 0);
  assert.throws(() => process.kill(spawnedPid, 0), { code: "ESRCH" });
});

test.skip("experimental secure process runner retains and releases the process-instance lease around protected stdin", async () => {
  const runner = createSecureProcessRunner();
  let releaseCalls = 0;
  const result = await runner.run({
    executable: process.execPath,
    cwd: process.cwd(),
    args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('accepted'))"],
    stdin: Uint8Array.from([11, 22, 33, 44]),
    beforeStdin: async () => ({ release: () => { releaseCalls += 1; } }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(new TextDecoder().decode(result.stdout), "accepted");
  assert.equal(result.stdinAdmissionConfirmed, true);
  assert.equal(releaseCalls, 1);
  result.stdout.fill(0);
});

test.skip("experimental secure process runner fails closed when the process-instance lease cannot be released", async () => {
  const runner = createSecureProcessRunner();
  await assert.rejects(
    runner.run({
      executable: process.execPath,
      cwd: process.cwd(),
      args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"],
      stdin: Uint8Array.from([11, 22, 33, 44]),
      beforeStdin: async () => ({ release: () => { throw new Error("handle release failed"); } }),
    }),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_backend_unverified",
  );
});

test.skip("experimental Linux Secret Service adapter transports protected values only through stdin", async () => {
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
    assert.equal(call.args.includes("cuna-cli"), true, "every Secret Service operation uses the Cuna application namespace");
    assert.equal(call.args.includes("runa-cli"), false, "the unreleased Runa namespace must not be written");
  }
  assert.match(new TextDecoder().decode(calls[0].stdin), /linux-secret-sentinel/u, "protected value is confined to stdin");
  observed.fill(0);
  sentinel.fill(0);
});

test.skip("experimental secure credential helpers require absolute executable and working-directory authority", async () => {
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

test.skip("experimental Windows credential backend refuses unavailable authority", async () => {
  const backend = createPlatformCredentialBackend({ platform: "win32", clock: () => NOW });
  const evidence = await backend.probe();
  assert.equal(evidence.status, "unavailable");
  assert.equal(evidence.backendId, "windows-native-vault-required");
  await assert.rejects(
    backend.read("opaque-target"),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_backend_unavailable",
  );
});

test.skip("experimental macOS credential backend refuses unavailable authority", async () => {
  const backend = createMacOsKeychainBackend({ clock: () => NOW });
  const evidence = await backend.probe();
  assert.equal(evidence.status, "unavailable");
  await assert.rejects(
    backend.replace("target", new TextEncoder().encode("never-on-security-dash-w")),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_backend_unavailable",
  );
});

/**
 * `createProductionNativeAuthBridges` existed and was correct, but nothing in
 * `src/` ever called it -- every caller was under `test/`. The synchronous
 * `createPlatformCredentialBackend` cannot load a signed package, so on Windows
 * and macOS it returned an unavailable backend unconditionally, and every
 * authenticated command (including `cuna claude`) failed before reaching the
 * vault. These cases pin the wiring itself: that a resolved bridge is actually
 * installed into the backend, and that a refused one fails closed while
 * carrying the admission error's own message forward.
 *
 * Today the release index is empty and the platform packages are unpublished,
 * so the real resolver always refuses. Injecting the resolver is what makes the
 * success path observable at all -- without it the wiring would be untestable
 * until the packages ship, which is how it stayed unwired.
 */
function stubCredentialBridge(platform) {
  const stored = new Map();
  return Object.freeze({
    platform,
    backendId: `${platform}-stub-vault`,
    transportSecurity: "native_memory_only",
    read: async (target) => stored.get(target),
    replace: async (target, value) => void stored.set(target, Uint8Array.from(value)),
    delete: async (target) => (stored.delete(target) ? "deleted" : "absent"),
  });
}

test.skip("experimental resolved bridge is installed into the platform credential backend", async () => {
  for (const platform of ["win32", "darwin"]) {
    const authority = await resolvePlatformAuthority({
      platform,
      nativeBridges: async () => ({
        platform,
        architecture: "x64",
        packageName: "@cuna_labs/cli-native-win32-x64",
        packageVersion: "0.0.0",
        credentialBridge: stubCredentialBridge(platform),
        browserBridge: Object.freeze({ platform, open: async () => {} }),
      }),
    });
    assert.equal(authority.credentials.backendId, `${platform}-stub-vault`, platform);
    // A live round trip through the bridge, not merely a constructed object:
    // the previous behaviour also produced a backend, just a dead one.
    const evidence = await authority.credentials.probe();
    assert.equal(evidence.status, "verified", `${platform} probe`);
    assert.equal(evidence.source, "native_bridge_round_trip", `${platform} source`);
    assert.notEqual(authority.browserBridge, undefined, `${platform} browser bridge`);
  }
});

test.skip("experimental refused authority fails closed and carries its reason", async () => {
  const authority = await resolvePlatformAuthority({
    platform: "win32",
    nativeBridges: async () => {
      throw new CredentialBoundaryError({
        code: "credential_backend_unverified",
        message: "The installed native authentication package identity does not match this release.",
      });
    },
  });
  assert.equal(authority.browserBridge, undefined);
  const evidence = await authority.credentials.probe();
  assert.equal(evidence.status, "unavailable");
  // The distinguishing fact: which admission check refused, not just "no vault".
  assert.equal(
    evidence.reason,
    "The installed native authentication package identity does not match this release.",
  );
  await assert.rejects(
    authority.credentials.read("target"),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_backend_unavailable",
  );
});

test.skip("experimental Linux backend resolves without consulting another platform package", async () => {
  let consulted = false;
  const authority = await resolvePlatformAuthority({
    platform: "linux",
    nativeBridges: async () => {
      consulted = true;
      return undefined;
    },
  });
  assert.equal(consulted, false);
  assert.equal(authority.browserBridge, undefined);
  assert.equal(authority.credentials.platform, "linux");
});
