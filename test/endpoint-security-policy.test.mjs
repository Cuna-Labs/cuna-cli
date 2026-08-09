import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertEndpointSecuritySource } from "../scripts/lib/endpoint-security-policy.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("TC-048-18 browser handoff source contains no prohibited Windows execution intermediary", async () => {
  const source = await readFile(path.join(repositoryRoot, "src", "auth", "browser.ts"), "utf8");
  assert.doesNotThrow(() => assertEndpointSecuritySource(source, "browser handoff"));
});

test("TC-048-18 shipped runtime contains no prohibited Windows execution intermediary", async () => {
  for (const relativeRoot of ["src", "dist", "node_modules/@xterm/headless"]) {
    const root = path.join(repositoryRoot, relativeRoot);
    for (const file of await runtimeFiles(root)) {
      const source = await readFile(file, "utf8");
      const label = path.relative(repositoryRoot, file);
      assert.doesNotThrow(() => assertEndpointSecuritySource(source, label));
    }
  }
});

test("TC-048-18 endpoint-security policy detects representative historical execution patterns", () => {
  for (const fixture of [
    "rundll32.exe url.dll,FileProtocolHandler https://example.test",
    "powershell.exe -EncodedCommand ZQB2AGkAbAA=",
    "powershell.exe -enc ZQB2AGkAbAA=",
    "pwsh.exe -EncodedCommand ZQB2AGkAbAA=",
    "pwsh -e ZQB2AGkAbAA=",
    "Add-Type -TypeDefinition $source",
    "DllImport(\"advapi32.dll\")",
  ]) {
    assert.throws(() => assertEndpointSecuritySource(fixture, "negative control"), /violates endpoint-security policy/u);
  }
});

async function runtimeFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await runtimeFiles(absolute));
      continue;
    }
    if (entry.isFile() && /\.(?:js|json|map|ts)$/u.test(entry.name)) files.push(absolute);
  }
  return files;
}
