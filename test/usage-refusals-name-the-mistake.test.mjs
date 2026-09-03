// A refusal names the mistake the person actually made.
//
// Two shapes are guarded. A placeholder standing where the person's own word
// would be, for a word they never typed; and an absent option laundered into
// `""` and reported by the shape validator, which names the wrong mistake.
// Absent and malformed must stay distinguishable, which is what the negative
// controls below pin.
import test from "node:test";
import assert from "node:assert/strict";

import { CunaError, EXIT_CODES, memoryStreams, runCli } from "../dist/index.js";

const PLATFORM = Object.freeze({
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
});

/** Run one invocation and return its exit code with the rendered error record. */
async function refusal(argv) {
  const streams = memoryStreams({ stdoutIsTTY: false, stderrIsTTY: false });
  const exit = await runCli([...argv, "--json"], {
    streams: streams.streams,
    platform: PLATFORM,
    env: {},
    humanAuth: { async acquireAccessToken() { return `cuna_at_${"a".repeat(43)}`; } },
    clientFactory: () => ({}),
  });
  // A refusal is written to stderr, so stdout stays clean for the result the
  // command still owes a caller. Reading stdout here would make every
  // assertion below pass against `undefined`.
  const stderr = streams.stderr().trim();
  const record = stderr === "" ? undefined : JSON.parse(stderr.split("\n").at(-1));
  return { exit, error: record?.error, stderr };
}

// The commands whose only action is a single word: typing the bare command is
// the most likely way to meet them, and it was the case that read worst.
const SINGLE_ACTION = [
  ["usage", "show"],
  ["records", "list"],
  ["workspace", "show"],
  ["authorizations", "list"],
];

for (const [command, action] of SINGLE_ACTION) {
  test(`cuna ${command} with no action says an action is required and names it`, async () => {
    const run = await refusal([command]);
    assert.equal(run.exit, EXIT_CODES.usage);
    assert.equal(run.error?.message, `cuna ${command} requires an action.`);
    assert.equal(run.error?.hint, `The only action is \`${action}\`.`);
    // The placeholder is the defect itself: it must not survive anywhere in the
    // rendered record.
    assert.doesNotMatch(JSON.stringify(run.error), /<none>/u);
  });
}

test("a wrong action reads differently from a missing one, and still names what exists", async () => {
  const run = await refusal(["usage", "nonsense"]);
  assert.equal(run.exit, EXIT_CODES.usage);
  assert.equal(run.error?.message, "cuna usage has no action nonsense.");
  assert.equal(run.error?.hint, "The only action is `show`.");
});

test("a pasted paragraph cannot become the error message", async () => {
  const run = await refusal(["usage", `${"x".repeat(400)}`]);
  assert.equal(run.exit, EXIT_CODES.usage);
  assert.ok(
    run.error?.message.length < 80,
    `an unbounded operand reached the message: ${run.error?.message.length} characters`,
  );
  assert.match(run.error?.message ?? "", /…\.$/u);
});

test("a missing --machine is reported as missing, not as an invalid machine ID", async () => {
  for (const argv of [["agent-sessions", "list"], ["authorizations", "list"]]) {
    const run = await refusal(argv);
    assert.equal(run.exit, EXIT_CODES.usage, argv.join(" "));
    assert.equal(run.error?.message, "Option --machine is required.", argv.join(" "));
    assert.equal(run.error?.hint, "Run `cuna machines list` to find a machine ID.");
    // The old message named a value the person never wrote.
    assert.doesNotMatch(run.error?.message ?? "", /Invalid machine ID/u);
  }
});

test("a malformed --machine is still reported as malformed", async () => {
  // The negative control for the change above: absent and malformed must not
  // collapse into one message. If this ever reads "is required", the fix has
  // swallowed a real shape error.
  const run = await refusal(["agent-sessions", "list", "--machine", "mch_1"]);
  assert.equal(run.exit, EXIT_CODES.usage);
  assert.equal(run.error?.message, "Invalid machine ID.");
  assert.match(run.error?.hint ?? "", /canonical lowercase Cuna UUID/u);
});

test("a resource-scoped capability query names the option it is missing", async () => {
  const run = await refusal(["capabilities", "--scope", "machine"]);
  assert.equal(run.exit, EXIT_CODES.usage);
  assert.equal(run.error?.message, "Option --resource-id is required.");
  assert.match(run.error?.hint ?? "", /scoped to one resource/u);
});

// ---------------------------------------------------------------------------
// A refusal must also name the right SUBJECT. Three more, measured by the
// journey harness against the installed CLI on 2026-09-02, where the product
// blamed itself or nobody for something the reader had done.
// ---------------------------------------------------------------------------

test("a config file the person named and that does not exist is refused, not answered with defaults", async () => {
  // Measured before: exit 0, every value `default`, and `config_file` echoing
  // the path that does not exist. The reader asked which settings that file
  // supplies and was told, wordlessly, that it supplies none.
  const run = await refusal(["config", "get", "--config-file", "/no/such/cuna.json"]);
  assert.equal(run.exit, EXIT_CODES.usage);
  assert.equal(run.error?.message, "No Cuna configuration file at /no/such/cuna.json.");
  assert.equal(run.error?.details?.reason, "config_file_missing");
  assert.match(run.error?.hint ?? "", /omit --config-file/u);
});

test("a missing file at the DEFAULT path is still the first run, not a refusal", async () => {
  // The negative control that keeps the fix honest: `readSafeConfig` reports
  // `exists: false` for every path in these tests, so if the refusal were not
  // conditioned on the path being explicit, every first run would now fail.
  const run = await refusal(["config", "get"]);
  assert.equal(run.exit, EXIT_CODES.success, JSON.stringify(run.error));
});

test("a mistyped resource id is refused here, not reported as a server-contract defect", async () => {
  // Measured before: a 422 round-trip rendered as "The deployed Cuna API is
  // behind its published contract… report it at github.com/Cuna-Labs/cuna-cli/
  // issues" — the product asking the reader to file a bug about their own typo.
  for (const scope of ["machine", "agent_session"]) {
    const run = await refusal(["capabilities", "--scope", scope, "--resource-id", "not-a-uuid"]);
    assert.equal(run.exit, EXIT_CODES.usage, scope);
    assert.match(run.error?.message ?? "", /^Invalid (machine ID|AgentSession ID)\.$/u, scope);
    assert.match(run.error?.hint ?? "", /canonical lowercase Cuna UUID/u, scope);
    assert.doesNotMatch(JSON.stringify(run.error), /github\.com|behind its published contract/u, scope);
  }
});

test("a Machine that does not exist is reported as missing, not as a broken deployment", async () => {
  // Measured before: `cuna machines delete <id that never existed> --yes`
  // answered exit 8, "This Cuna deployment does not expose capability
  // discovery. Update the Cuna server contract before retrying." — a
  // server-contract accusation for a mistyped id. The same 404, asked through
  // `cuna capabilities --scope machine`, already came back as not-found, so the
  // product knew; one branch was reading a resource 404 as a route 404.
  const missing = "00000000-0000-4000-8000-000000000009";
  const streams = memoryStreams({ stdoutIsTTY: false, stderrIsTTY: false });
  let mutated = false;
  const exit = await runCli(["machines", "delete", missing, "--yes", "--json"], {
    streams: streams.streams,
    platform: PLATFORM,
    env: {},
    humanAuth: { async acquireAccessToken() { return `cuna_at_${"a".repeat(43)}`; } },
    clientFactory: () => ({
      async discoverCapabilities() {
        throw new CunaError({
          code: "cuna.remote.not_found",
          message: "Not found.",
          exitCode: EXIT_CODES.remote,
        });
      },
      async transitionMachine() { mutated = true; return {}; },
      async deleteMachine() { mutated = true; return {}; },
    }),
  });
  const record = JSON.parse(streams.stderr().trim().split("\n").at(-1));
  assert.equal(exit, EXIT_CODES.remote);
  assert.equal(record.error.code, "cuna.remote.not_found");
  assert.equal(record.error.message, `Machine ${missing} does not exist.`);
  assert.match(record.error.hint, /Nothing was attempted\..*cuna machines list/u);
  assert.doesNotMatch(JSON.stringify(record.error), /does not expose capability discovery/u);
  assert.equal(mutated, false, "a missing Machine must not reach a mutation");
});

test("a deployment that truly does not serve discovery still says so", async () => {
  // The negative control: the account scope has no resource to be missing, so a
  // 404 there really is the route. If this ever reads "does not exist", the fix
  // above has swallowed the case it was carved out of.
  const streams = memoryStreams({ stdoutIsTTY: false, stderrIsTTY: false });
  const exit = await runCli(["records", "list", "--json"], {
    streams: streams.streams,
    platform: PLATFORM,
    env: {},
    humanAuth: { async acquireAccessToken() { return `cuna_at_${"a".repeat(43)}`; } },
    clientFactory: () => ({
      async discoverCapabilities() {
        throw new CunaError({
          code: "cuna.remote.not_found",
          message: "Not found.",
          exitCode: EXIT_CODES.remote,
        });
      },
    }),
  });
  const record = JSON.parse(streams.stderr().trim().split("\n").at(-1));
  assert.equal(exit, EXIT_CODES.unsupported);
  assert.equal(record.error.code, "cuna.capability.discovery_unavailable");
});
