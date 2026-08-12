import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CunaError, ERROR_NAMESPACE, EXIT_CODES } from "../dist/index.js";
import { DEPLOYED_WIRE_COMPATIBILITY } from "../dist/core/deployed-wire-compatibility.js";

/**
 * Every error code this CLI prints is minted from ninety-odd separate string
 * literals, so a rename is only ever partial until something checks the whole
 * tree. Codes reach the user as `error.code` in `--json` and as `Error [code]:`
 * on a terminal; a stray `runa.*` literal is product surface, not a typo.
 *
 * `runa.` is NOT forbidden outright: the identifiers below are minted by the
 * deployed services and are compared by exact equality, so
 * renaming them here and nowhere else is the mint-here/accept-there defect this
 * repository has closed four times. Each is listed with the peer that pins it.
 * Adding a line is a deliberate act; growing this list by accident is what this
 * test prevents.
 *
 * KNOWN BLIND SPOT, measured: this file asserts the ABSENCE of `runa.`, so it
 * says nothing about whether any particular `cuna.*` code is the code the
 * product actually emits. A mutation audit renamed all 50 codes that no test
 * names — 64 literal sites — and the suite stayed green at 534/534. Renaming the
 * 39 codes that ARE named gave 51 failures. So this test protects the namespace
 * and nothing protects most of the codes inside it.
 *
 * `test/cli-surface-regressions.test.mjs` closes the two worst gaps: the
 * template mint sites at `cli/run.ts` that build `cuna.runtime.*` (22 codes) and
 * `cuna.auth.credential_*` (12 codes) from a boundary error, which had every
 * bare code asserted somewhere and the prefixed form asserted nowhere — the
 * exact two lines the namespace rename touched.
 */
const WIRE_IDENTIFIERS = Object.freeze([
  // Terminal WebSocket subprotocol. Pinned by infra `edge/src/terminal-connections.ts`
  // and by the generated edge contract runtime.
  "runa.terminal.v1",
  // AgentSession auth adapter version. Pinned by infra `edge/src/agent-session-auth.ts`.
  "runa.agent-auth.v1",
  // Bearer-in-subprotocol prefix. Pinned by infra `edge/src/terminal-gateway.ts`,
  // which accepts this prefix and no other.
  "runa.auth.",
]);

const SOURCE_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const SCRIPTS_ROOT = fileURLToPath(new URL("../scripts", import.meta.url));
const COMPATIBILITY_FILE = "core/deployed-wire-compatibility.ts";
const EARLIER_BRAND_LITERAL = /(?:^|[^a-z])runa(?:code)?(?:[^a-z]|$)/iu;

function isCommentLine(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

async function sourceFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(path));
    else if ([".ts", ".mjs", ".js"].includes(extname(path))) found.push(path);
  }
  return found;
}

test("no shipped source mints an error code outside the current namespace", async () => {
  assert.equal(ERROR_NAMESPACE, "cuna");

  const unexplained = [];
  for (const path of await sourceFiles(SOURCE_ROOT)) {
    const lines = (await readFile(path, "utf8")).split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      if (!line.includes("runa.") || isCommentLine(line)) continue;
      if (WIRE_IDENTIFIERS.some((identifier) => line.includes(identifier))) continue;
      unexplained.push(`${path.slice(SOURCE_ROOT.length + 1)}:${index + 1}: ${line.trim()}`);
    }
  }

  assert.deepEqual(
    unexplained,
    [],
    `Every "runa." in src/ must be one of the enumerated wire identifiers.\n${unexplained.join("\n")}`,
  );
});

test("the deployed wire compatibility authority has an exact closed schema and value set", () => {
  assert.deepEqual(DEPLOYED_WIRE_COMPATIBILITY, {
    terminalProtocol: "runa.terminal.v1",
    agentSessionAuthAdapterVersion: "runa.agent-auth.v1",
    websocketAuthPrefix: "runa.auth.",
    continuationHeader: "X-Runa-Continuation",
    credentialBrand: "runa",
    apiOrigin: "https://api.runacode.io",
    apiKeyEnvironment: "RUNA_API_KEY",
  });
});

test("earlier-brand runtime literals exist only in the exact deployed wire authority", async () => {
  const unexplained = [];
  for (const [root, label] of [[SOURCE_ROOT, "src"], [SCRIPTS_ROOT, "scripts"]]) {
    for (const path of await sourceFiles(root)) {
      const relative = path.slice(root.length + 1).replaceAll("\\", "/");
      const lines = (await readFile(path, "utf8")).split(/\r?\n/u);
      for (const [index, line] of lines.entries()) {
        if (isCommentLine(line)) continue;
        let unclassified = line;
        if (label === "src" && relative === COMPATIBILITY_FILE) {
          for (const value of Object.values(DEPLOYED_WIRE_COMPATIBILITY)) {
            unclassified = unclassified.replaceAll(JSON.stringify(value), "");
          }
        }
        if (!EARLIER_BRAND_LITERAL.test(unclassified)) continue;
        unexplained.push(`${label}/${relative}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(
    unexplained,
    [],
    `Earlier-brand runtime literals must be classified as deployed wire compatibility.\n${unexplained.join("\n")}`,
  );
});

test("the public error class is Cuna-only", () => {
  const error = new CunaError({
    code: `${ERROR_NAMESPACE}.usage.invalid`,
    message: "namespace probe",
    exitCode: EXIT_CODES.usage,
  });
  assert.ok(error.code.startsWith(`${ERROR_NAMESPACE}.`));
  assert.equal(error.name, "CunaError");
});
