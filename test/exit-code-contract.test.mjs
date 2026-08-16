import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DOCUMENTED_EXIT_CODES, EXIT_CODES, exitCodeMarkdownTable, memoryStreams, runCli } from "../dist/index.js";

/**
 * THE ORACLE IS LITERAL, ON PURPOSE. Every number below is typed out by hand
 * and nothing in this file may import it from `EXIT_CODES`, from
 * `DOCUMENTED_EXIT_CODES`, or from the rendered table.
 *
 * The failure this exists to catch is not "a code disappeared" — the type
 * system already refuses that. It is a code that CHANGES MEANING while every
 * derived artifact moves with it: the README, `cuna --help` and the JSON error
 * records are all projections of `EXIT_CODES`, so renumbering one entry
 * relabels all of them in the same commit and no derived assertion can notice.
 * That is not hypothetical here. `cuna.remote.operation_not_served` moved from
 * `7` to `8` in this repository and nothing recorded that it had moved, because
 * there was nothing that could.
 *
 * A test parametrized over the source's own list has exactly this blind spot:
 * the expectation narrows along with the thing it is meant to hold still. So
 * these nine pairs are the authority for this file, and the source under test
 * is the thing being compared against them.
 *
 * When a code legitimately changes, edit this list DELIBERATELY and record the
 * move in `CHANGELOG.md` in the same commit — a consumer pinned to the old
 * number is broken by it.
 */
const EXIT_CODE_ORACLE = Object.freeze([
  Object.freeze(["success", 0]),
  Object.freeze(["usage", 2]),
  Object.freeze(["auth", 3]),
  Object.freeze(["policy", 4]),
  Object.freeze(["network", 5]),
  Object.freeze(["conflict", 6]),
  Object.freeze(["remote", 7]),
  Object.freeze(["unsupported", 8]),
  Object.freeze(["internal", 70]),
]);

const API_KEY = "cuna_sk_abcdefghijklmnop";
const MACHINE_ID = "33333333-3333-4333-8333-333333333333";

const platform = {
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
};

async function exitOf(argv, dependencies = {}) {
  const streams = memoryStreams();
  return runCli(argv, { streams: streams.streams, platform, ...dependencies });
}

function respond(status, body, contentType) {
  return async () => new Response(body, { status, headers: { "content-type": contentType } });
}

/* -------------------------------------------------------------------------- */
/* The oracle                                                                 */
/* -------------------------------------------------------------------------- */

test("every named exit code holds its published number", () => {
  // Named one at a time so the failure message says WHICH code moved rather
  // than that two arrays differ.
  assert.equal(EXIT_CODES.success, 0);
  assert.equal(EXIT_CODES.usage, 2);
  assert.equal(EXIT_CODES.auth, 3);
  assert.equal(EXIT_CODES.policy, 4);
  assert.equal(EXIT_CODES.network, 5);
  assert.equal(EXIT_CODES.conflict, 6);
  assert.equal(EXIT_CODES.remote, 7);
  assert.equal(EXIT_CODES.unsupported, 8);
  assert.equal(EXIT_CODES.internal, 70);
});

test("the exit-code map contains these nine names and no others", () => {
  // Catches the direction the assertions above cannot: a tenth code added with
  // no documentation, or a name quietly retired.
  assert.deepEqual(
    Object.entries(EXIT_CODES).sort(([left], [right]) => left.localeCompare(right, "en-US")),
    EXIT_CODE_ORACLE.map(([name, code]) => [name, code])
      .sort(([left], [right]) => left.localeCompare(right, "en-US")),
  );
});

test("the documented contract describes every code, ascending, with its published number", () => {
  assert.deepEqual(
    DOCUMENTED_EXIT_CODES.map((entry) => [entry.name, entry.code]),
    [
      ["success", 0],
      ["usage", 2],
      ["auth", 3],
      ["policy", 4],
      ["network", 5],
      ["conflict", 6],
      ["remote", 7],
      ["unsupported", 8],
      ["internal", 70],
    ],
  );
  for (const entry of DOCUMENTED_EXIT_CODES) {
    assert.ok(entry.meaning.length > 0, `${entry.name} has no documented meaning`);
    assert.ok(entry.reachablePath.length > 0, `${entry.name} names no reachable path`);
  }
});

/* -------------------------------------------------------------------------- */
/* The published surfaces                                                     */
/* -------------------------------------------------------------------------- */

test("the README publishes the generated table and it is current", async () => {
  const readme = await readFile(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  const region = /<!-- BEGIN GENERATED: exit-codes -->\r?\n([\s\S]*?)\r?\n<!-- END GENERATED: exit-codes -->/u
    .exec(readme);
  assert.ok(region !== null, "README.md must carry the generated exit-code region");
  assert.equal(
    region[1].replace(/\r\n/gu, "\n"),
    exitCodeMarkdownTable(),
    "README.md exit-code table is stale. Replace the generated region with the output of exitCodeMarkdownTable().",
  );

  // The comparison above is a currency check between two projections of one
  // source, so it moves with that source. These rows do not: they are the
  // literal oracle again, asserted against the published document.
  for (const [name, code] of EXIT_CODE_ORACLE) {
    assert.ok(
      readme.includes(`| \`${code}\` | \`${name}\` |`),
      `README.md must publish exit code ${code} as ${name}`,
    );
  }
});

// The exit-code table moved out of the bare help and into `cuna help --all`,
// because 23 of the bare help's 105 lines were this table and a newcomer met it
// before the first usable command. The guarantee is unchanged and is asserted
// in two halves: the complete table is still published, and the short help
// still names the route to it. Relocating content without keeping a route to it
// would be a deletion.
test("cuna help --all publishes every exit code", async () => {
  const short = memoryStreams();
  assert.equal(await runCli(["--help", "--json"], { streams: short.streams, platform }), 0);
  assert.match(JSON.parse(short.stdout()).data.help, /cuna help --all/u);

  const streams = memoryStreams();
  const exit = await runCli(["help", "--all", "--json"], { streams: streams.streams, platform });
  assert.equal(exit, 0);
  const help = JSON.parse(streams.stdout()).data.help;
  assert.match(help, /^Exit codes:$/mu);
  for (const [name, code] of EXIT_CODE_ORACLE) {
    assert.match(
      help,
      new RegExp(`^\\s*${code}\\s+${name}\\s+\\S`, "mu"),
      `cuna help --all must list exit code ${code} as ${name}`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* One reachable path per code, exercised through the real dispatcher         */
/* -------------------------------------------------------------------------- */

test("success is reachable: an offline command returns 0", async () => {
  assert.equal(await exitOf(["version", "--json"]), 0);
});

test("usage is reachable: an unknown command returns 2", async () => {
  assert.equal(await exitOf(["nonsense", "--json"]), 2);
});

test("auth is reachable: an interactive command under an automation key returns 3", async () => {
  assert.equal(await exitOf(["whoami", "--json"], { env: { CUNA_API_KEY: API_KEY } }), 3);
});

test("policy is reachable: a mutation without --yes returns 4", async () => {
  assert.equal(
    await exitOf(["machines", "delete", MACHINE_ID, "--json"], { env: { CUNA_API_KEY: API_KEY } }),
    4,
  );
});

test("network is reachable: a request that outlives --timeout-ms returns 5", async () => {
  const exit = await exitOf(["machines", "list", "--timeout-ms", "100", "--json"], {
    env: { CUNA_API_KEY: API_KEY },
    fetch: (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
  });
  assert.equal(exit, 5);
});

test("conflict is reachable: HTTP 409 returns 6", async () => {
  const exit = await exitOf(["machines", "list", "--json"], {
    env: { CUNA_API_KEY: API_KEY },
    fetch: respond(409, JSON.stringify({ error: "conflict" }), "application/json"),
  });
  assert.equal(exit, 6);
});

test("remote is reachable: a success body the contract rejects returns 7", async () => {
  const exit = await exitOf(["machines", "list", "--json"], {
    env: { CUNA_API_KEY: API_KEY },
    fetch: respond(200, "not json", "text/plain"),
  });
  assert.equal(exit, 7);
});

test("unsupported is reachable: a 404 with no API body returns 8, not 7", async () => {
  // This is the move that went unrecorded. Before the transport read the status
  // ahead of the body, an unserved operation surfaced as
  // `cuna.remote.malformed_response` and exited 7; it is `operation_not_served`
  // and exits 8. A consumer that pinned 7 is broken by that, so the number is
  // asserted here as a literal and the change is recorded in CHANGELOG.md.
  const exit = await exitOf(["machines", "list", "--json"], {
    env: { CUNA_API_KEY: API_KEY },
    fetch: respond(404, "404 Not Found", "text/plain; charset=UTF-8"),
  });
  assert.equal(exit, 8);

  // The discriminator is the JSON body, and the neighbouring case must stay put:
  // a 404 the API itself minted is an absent resource and still exits 7.
  const absent = await exitOf(["machines", "list", "--json"], {
    env: { CUNA_API_KEY: API_KEY },
    fetch: respond(404, JSON.stringify({ error: "not_found" }), "application/json"),
  });
  assert.equal(absent, 7);
});

test("internal is reachable: a non-CunaError escaping the command returns 70", async () => {
  const exit = await exitOf(["machines", "list", "--json"], {
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => ({
      async listMachines() { throw new TypeError("injected defect"); },
    }),
  });
  assert.equal(exit, 70);
});
