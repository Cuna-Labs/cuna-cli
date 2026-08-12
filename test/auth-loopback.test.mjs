import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createBrowserOpener, createPkceAuthorization } from "../dist/index.js";
import { resolveBrowserCommand } from "../dist/auth/browser.js";

test("PKCE material is independent, bounded, and S256-verifiable without a callback listener", () => {
  let marker = 0;
  const material = createPkceAuthorization((size) => {
    marker += 1;
    return Uint8Array.from({ length: size }, (_, index) => (index + marker) % 256);
  });
  assert.notEqual(material.verifier, material.state);
  assert.equal(material.challengeMethod, "S256");
  assert.equal(material.challenge, createHash("sha256").update(material.verifier, "ascii").digest("base64url"));
  assert.match(material.verifier, /^[A-Za-z0-9_-]{43,128}$/u);
  assert.match(material.state, /^[A-Za-z0-9_-]{43,}$/u);
});

test("browser handoff requires signed native authority on Windows and macOS and pins Linux xdg-open", () => {
  const url = "https://app.getcuna.com/cli/continue#opaque";
  assert.throws(
    () => resolveBrowserCommand("win32", url, { SystemRoot: "C:\\Windows" }),
    /approved signed native adapter/u,
  );
  assert.throws(
    () => resolveBrowserCommand("darwin", url, {}),
    /approved signed native adapter/u,
  );
  assert.deepEqual(resolveBrowserCommand("linux", url, {}), {
    executable: "/usr/bin/xdg-open",
    args: [url],
    cwd: "/",
  });
});

test("macOS browser handoff uses only a platform-bound admitted native bridge", async () => {
  const url = "https://app.getcuna.com/cli/continue#opaque";
  const opened = [];
  const native = Object.freeze({
    platform: "darwin",
    open: async (value) => { opened.push(value); },
  });
  await createBrowserOpener("darwin", {}, native).open(url);
  assert.deepEqual(opened, [url]);
  assert.throws(
    () => createBrowserOpener("darwin", {}, { ...native, platform: "win32" }).open(url),
    /platform binding does not match/u,
  );
});

test("browser handoff rejects control-bearing and oversized URLs before every platform effect", async () => {
  const opened = [];
  const native = Object.freeze({
    platform: "darwin",
    open: async (value) => { opened.push(value); },
  });
  for (const url of [
    "http://app.getcuna.com/cli/continue",
    "https://app.getcuna.com/cli/continue\n",
    `https://app.getcuna.com/cli/continue?state=${"a".repeat(8_192)}`,
  ]) {
    assert.throws(() => createBrowserOpener("darwin", {}, native).open(url), /bounded HTTPS/u);
  }
  assert.deepEqual(opened, []);
});
