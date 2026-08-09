import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createPkceAuthorization } from "../dist/index.js";
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

test("browser handoff fails closed without a native Windows adapter and pins approved Unix helpers", () => {
  const url = "https://app.runacode.io/cli/continue#opaque";
  assert.throws(
    () => resolveBrowserCommand("win32", url, { SystemRoot: "C:\\Windows" }),
    /approved signed native adapter/u,
  );
  assert.deepEqual(resolveBrowserCommand("darwin", url, {}), {
    executable: "/usr/bin/open",
    args: [url],
    cwd: "/",
  });
  assert.deepEqual(resolveBrowserCommand("linux", url, {}), {
    executable: "/usr/bin/xdg-open",
    args: [url],
    cwd: "/",
  });
});
