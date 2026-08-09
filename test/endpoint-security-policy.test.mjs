import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertEndpointSecuritySource } from "../scripts/lib/endpoint-security-policy.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("TC-048-18 browser handoff source contains no prohibited Windows execution intermediary", async () => {
  const source = await readFile(path.join(repositoryRoot, "src", "auth", "browser.ts"), "utf8");
  assert.doesNotThrow(() => assertEndpointSecuritySource(source, "browser handoff"));
});

test("TC-048-18 endpoint-security policy detects representative historical execution patterns", () => {
  for (const fixture of [
    "rundll32.exe url.dll,FileProtocolHandler https://example.test",
    "powershell.exe -EncodedCommand ZQB2AGkAbAA=",
    "Add-Type -TypeDefinition $source",
    "DllImport(\"advapi32.dll\")",
  ]) {
    assert.throws(() => assertEndpointSecuritySource(fixture, "negative control"), /violates endpoint-security policy/u);
  }
});
