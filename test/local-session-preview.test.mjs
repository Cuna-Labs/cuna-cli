import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalSessionPreviewBackend, localSessionPreviewPath } from "../dist/credentials/local-session-preview.js";
import { CredentialVault, SecretMaterial } from "../dist/credentials/index.js";

const BINDING = Object.freeze({
  profileId: "default",
  accountId: "account-1",
  workspaceId: "workspace-1",
  kind: "cuna-refresh-token",
});

test("preview backend encrypts the vault envelope and round-trips it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cuna-preview-"));
  const filePath = join(directory, "session-preview.json");
  try {
    const backend = new LocalSessionPreviewBackend({
      filePath,
      passphrase: "preview-passphrase-2026",
      platform: "linux",
      clock: () => 1_000,
    });
    const evidence = await backend.probe();
    assert.equal(evidence.status, "preview");
    assert.equal(evidence.source, "local_file_preview");
    const payload = Buffer.from("CUNACRED\0cuna_rt_secret");
    await backend.replace("target", payload);
    const stored = await readFile(filePath, "utf8");
    assert.equal(stored.includes("cuna_rt_secret"), false);
    assert.deepEqual(Buffer.from(await backend.read("target")), payload);
    await backend.delete("target");
    assert.equal(await backend.read("target"), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preview backend rejects a wrong passphrase and authenticated tampering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cuna-preview-"));
  const filePath = join(directory, "session-preview.json");
  try {
    const backend = new LocalSessionPreviewBackend({
      filePath,
      passphrase: "preview-passphrase-2026",
      platform: "linux",
    });
    await backend.replace("target", Buffer.from("secret-envelope"));
    const wrong = new LocalSessionPreviewBackend({ filePath, passphrase: "wrong-passphrase-2026", platform: "linux" });
    await assert.rejects(wrong.read("target"), /passphrase|authentication tag|encrypted preview session/iu);
    const tampered = JSON.parse(await readFile(filePath, "utf8"));
    tampered.tag = `${tampered.tag.startsWith("A") ? "B" : "A"}${tampered.tag.slice(1)}`;
    await writeFile(filePath, JSON.stringify(tampered), { mode: 0o600 });
    await assert.rejects(backend.read("target"), /passphrase|authentication tag|encrypted preview session/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preview evidence is opt-in and never masquerades as a native vault", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cuna-preview-"));
  const filePath = join(directory, "session-preview.json");
  try {
    const backend = new LocalSessionPreviewBackend({
      filePath,
      passphrase: "preview-passphrase-2026",
      platform: "linux",
      clock: () => 1_000,
    });
    const normalVault = new CredentialVault({ backend, platform: "linux", clock: () => 1_000 });
    assert.equal((await normalVault.status(BINDING)).backendStatus, "unavailable");

    const previewVault = new CredentialVault({
      backend,
      platform: "linux",
      clock: () => 1_000,
      allowPreviewBackend: true,
    });
    const material = SecretMaterial.fromUtf8("refresh-preview");
    try {
      const status = await previewVault.rotate({ binding: BINDING, material, expiresAt: 100_000 });
      assert.equal(status.backendStatus, "preview");
      const loaded = await previewVault.load(BINDING);
      assert.ok(loaded);
      assert.equal(new TextDecoder().decode(loaded.material.copyBytes()), "refresh-preview");
      loaded.material.dispose();
    } finally {
      material.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preview passphrases count Unicode code points and reject malformed UTF-16", () => {
  const make = (passphrase) => new LocalSessionPreviewBackend({
    filePath: "C:/cuna-preview/session-preview.json",
    passphrase,
    platform: "win32",
  });
  assert.throws(() => make("a".repeat(11)), /passphrase/iu);
  assert.doesNotThrow(() => make("😀".repeat(12)));
  assert.throws(() => make("\ud800".repeat(12)), /passphrase/iu);
  assert.throws(() => make("\ud801".repeat(12)), /passphrase/iu);
});

test("preview profile filenames remain distinct on case-insensitive filesystems", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cuna-preview-"));
  try {
    const upperPath = localSessionPreviewPath(directory, "Foo");
    const lowerPath = localSessionPreviewPath(directory, "foo");
    assert.notEqual(upperPath.toLowerCase(), lowerPath.toLowerCase());
    const upper = new LocalSessionPreviewBackend({ filePath: upperPath, passphrase: "preview-passphrase-2026", platform: "win32" });
    const lower = new LocalSessionPreviewBackend({ filePath: lowerPath, passphrase: "preview-passphrase-2026", platform: "win32" });
    await upper.replace("target", Buffer.from("upper"));
    await lower.replace("target", Buffer.from("lower"));
    assert.equal(Buffer.from(await upper.read("target")).toString(), "upper");
    assert.equal(Buffer.from(await lower.read("target")).toString(), "lower");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
