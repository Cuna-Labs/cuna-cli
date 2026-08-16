import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const retiredMarkers = Object.freeze([
  ["cuna_", "rt_"].join(""),
  ["/v1/cli-auth/", "refresh"].join(""),
  ["refresh_", "token"].join(""),
  ["refresh_", "family_ttl_seconds"].join(""),
]);

async function productFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await productFiles(child));
    else if (entry.isFile() && /\.(?:ts|mts|cts)$/u.test(entry.name)) files.push(child);
  }
  return files;
}

function assertAbsent(text, location) {
  for (const marker of retiredMarkers) {
    assert.equal(text.includes(marker), false, `${location} retains ${marker}`);
  }
}

test("product source has no retired login-code renewal DTO, route, or credential family", async () => {
  for (const file of await productFiles(path.join(root, "src"))) {
    assertAbsent(await readFile(file, "utf8"), path.relative(root, file));
  }
});

test("package verifier rejects retired human-auth protocol bytes from every emitted artifact", async () => {
  const verifier = await readFile(path.join(root, "scripts", "verify-package-contents.mjs"), "utf8");
  assert.match(verifier, /RETIRED_HUMAN_AUTH_MARKERS/u);
  assert.match(verifier, /Retired human-auth protocol marker ships in package/u);
});

test("installed authority fixture rejects legacy routes and never contains retired durable-code bytes", async () => {
  const fixtureFiles = [
    path.join(root, "test", "fixtures", "installed-foreground-driver.mjs"),
    path.join(root, "test", "fixtures", "installed-runtime-driver.mjs"),
    path.join(root, "test", "fixtures", "installed-terminal-child.mjs"),
    path.join(root, "test", "installed-complete-onboarding.test.mjs"),
  ];
  for (const file of fixtureFiles) {
    assertAbsent(await readFile(file, "utf8"), path.relative(root, file));
  }
  const authority = await readFile(fixtureFiles.at(-1), "utf8");
  assert.match(authority, /retiredCodeRenewalRequests/u);
  assert.match(authority, /retired CLI code-renewal route is forbidden/u);
});
