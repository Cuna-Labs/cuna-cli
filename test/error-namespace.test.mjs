import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CunaError, ERROR_NAMESPACE, EXIT_CODES, RunaError } from "../dist/index.js";

/**
 * Every error code this CLI prints is minted from ninety-odd separate string
 * literals, so a rename is only ever partial until something checks the whole
 * tree. Codes reach the user as `error.code` in `--json` and as `Error [code]:`
 * on a terminal; a stray `runa.*` literal is product surface, not a typo.
 *
 * `runa.` is NOT forbidden outright: the identifiers below are minted by the
 * service or already written to disk and are compared by exact equality, so
 * renaming them here and nowhere else is the mint-here/accept-there defect this
 * repository has closed four times. Each is listed with the peer that pins it.
 * Adding a line is a deliberate act; growing this list by accident is what this
 * test prevents.
 */
const WIRE_IDENTIFIERS = Object.freeze([
  // Terminal WebSocket subprotocol. Pinned by infra `edge/src/terminal-connections.ts`
  // and by the generated edge contract runtime.
  "runa.terminal.v1",
  // AgentSession auth adapter version. Pinned by infra `edge/src/agent-session-auth.ts`.
  "runa.agent-auth.v1",
  // Bearer-in-subprotocol prefix. Pinned by infra `edge/src/terminal-gateway.ts`,
  // which accepts this prefix and no other.
  "runa.auth.${request.token}",
  // Durable on-disk binding record discriminator. Pinned by every workspace
  // binding already written to a user's disk.
  "runa.workspace-binding.v2",
]);

const SOURCE_ROOT = fileURLToPath(new URL("../src", import.meta.url));

function isCommentLine(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

async function sourceFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(path));
    else if (extname(path) === ".ts") found.push(path);
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

test("the deprecated error alias stays importable and identical", () => {
  assert.equal(RunaError, CunaError);

  const error = new CunaError({
    code: `${ERROR_NAMESPACE}.usage.invalid`,
    message: "namespace probe",
    exitCode: EXIT_CODES.usage,
  });
  assert.ok(error.code.startsWith(`${ERROR_NAMESPACE}.`));
  assert.equal(error.name, "CunaError");
});
