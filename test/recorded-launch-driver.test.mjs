import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { runCli } from "../dist/index.js";
import {
  RECORDED_LAUNCH_ACKNOWLEDGEMENT_BUDGET_MS,
  RECORDED_LAUNCH_QUESTION,
} from "../dist/cli/recorded-launch-prompt.js";

/**
 * THE RECORDED-LAUNCH QUESTION, DRIVEN THROUGH `runCli` — the prompt, the
 * readline, the progress row and the line that answers it, in one command.
 *
 * WHY THIS EXISTS RATHER THAN ONLY `test/recorded-launch-prompt.test.mjs`. That
 * file asserts the module: given an answer, a line is written before the promise
 * resolves. What it cannot see is the closure in `cli/run.ts` that owns the
 * readline and the spinner row, and that closure is where the measured defect
 * lived — the journey copy stopped the spinner to ask and never took the row
 * back. Measured 2026-09-22 (`prds/cuna-cli-latency-before-20260922.md` § 3,
 * finding 1): up to 18 314 ms of BYTE silence immediately after the answer was
 * accepted, in 3 of 5 runs.
 *
 * AND WHY IT EXISTS NOW. The live re-measurement of that repair was n=0
 * (§ 8.2): the planner selected an existing row in all nine runs, so the
 * question was never asked and the 500 ms bound rested on unit tests of the
 * module alone. This is the executable witness of the real path.
 *
 * THE CLOCK IS THE TEST'S. It advances only where the fixture says a remote
 * step took time, so "within 500 ms" here is a fact about ordering inside the
 * command rather than about how fast this machine happens to be.
 */

/** The worst byte silence measured after the answer: § 3, finding 1, run `reattach4`. */
const MEASURED_SILENCE_MS = 18_314;

const MACHINE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";
const EXECUTION_WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";
const REMOTE_ROOT = `/workspace/workspaces/${EXECUTION_WORKSPACE_ID}`;
const START = Date.parse("2026-09-22T15:27:10.557Z");

const PRESET = Object.freeze({
  kind: "native_interactive",
  agent: "claude-code",
  label: "Claude Code",
  profile_id: "profile",
  profile_revision: 1,
});

/**
 * One `cuna claude --new-session` against a fake remote, with the state
 * directory carried between runs so the second one meets its own recorded
 * launch.
 *
 * `answer` is written to the CLI's prompt input the moment the question reaches
 * stderr, and the clock is read at that instant, so the gap reported below is
 * measured from the answer rather than from the start of the command.
 */
async function launch(stateDirectory, options = {}) {
  let clock = START;
  const lines = [];
  const capture = (sink) => new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      sink.push({ text, at: clock, index: sink.length });
      if (options.answer !== undefined && askedAt === undefined && text.includes(RECORDED_LAUNCH_QUESTION)) {
        askedAt = clock;
        askedIndex = sink.length - 1;
        promptInput.write(`${options.answer}\n`);
      }
      callback();
    },
  });
  let askedAt;
  let askedIndex;
  const promptInput = new PassThrough();
  const stderrLines = [];
  const streams = Object.freeze({
    stdout: capture([]),
    stderr: capture(stderrLines),
    stdoutIsTTY: true,
    stdinIsTTY: true,
    stderrIsTTY: true,
  });
  const workspace = {
    machineId: MACHINE_ID,
    workspaceId: WORKSPACE_ID,
    executionWorkspaceId: EXECUTION_WORKSPACE_ID,
    remoteRoot: REMOTE_ROOT,
    workspaceGeneration: 1,
    publicationStatus: "ready",
  };
  const session = {
    id: SESSION_ID,
    machineId: MACHINE_ID,
    agent: "claude-code",
    cwd: REMOTE_ROOT,
    authMode: "interactive_login",
    requestState: "launch_pending",
    processState: "running",
  };
  const operationIds = [];
  const exit = await runCli(["claude", "--new-session"], {
    streams,
    platform: {
      kind: "linux",
      paths: { configDirectory: join(stateDirectory, "cfg"), stateDirectory, runtimeDirectory: join(stateDirectory, "run") },
      async readSafeConfig() { return { exists: false }; },
    },
    env: { NO_COLOR: "1" },
    now: () => clock,
    promptInput,
    managedWorkspaceMachineId: MACHINE_ID,
    providerScreenRunner: async () => PRESET,
    foregroundTerminalRunner: async () => undefined,
    humanAuth: { async acquireAccessToken() { return `cuna_at_${"a".repeat(43)}`; } },
    clientFactory: () => ({
      async getIdentity() {
        return { id: USER_ID, email: "someone@example.com", workspaceAssigned: true, workspaceId: WORKSPACE_ID };
      },
      async discoverCapabilities(scope, id) {
        return {
          schemaVersion: "1.0",
          subjectScope: scope,
          subjectId: id,
          observedAt: new Date(clock).toISOString(),
          expiresAt: new Date(clock + 60_000).toISOString(),
          etag: "test",
          capabilities: [["machines.default_workspace.read", "read_only"]].map(([id, interaction]) => ({
            id,
            interaction,
            availability: "supported",
            mutationClass: "none",
            surfaces: ["cli"],
            requiredPermissions: [],
          })),
        };
      },
      async getMachineDefaultWorkspace() { return workspace; },
      async createProviderSessionV2(_machineId, request) {
        operationIds.push(request.operation_id);
        // The step the person waits through after answering. In the measured
        // runs this was the silence; here it is the clock moving, so a screen
        // that says nothing at the answer is caught by the same arithmetic.
        clock += MEASURED_SILENCE_MS;
        return { agentSession: session };
      },
      async getAgentSession() { return session; },
    }),
  });
  lines.push(...stderrLines);
  return {
    exit,
    lines,
    askedAt,
    operationIds,
    /** The first line whose text contains `fragment`, with the clock it was written at. */
    find: (fragment) => lines.find((line) => line.text.includes(fragment)),
    /**
     * The first such line written AFTER the question. Ordering here is by write
     * index rather than by the clock, because the clock deliberately does not
     * move across the answer — which is the whole claim — so every row on both
     * sides of it carries the same timestamp.
     */
    findAfterTheQuestion: (fragment) => lines.find(
      (line) => askedIndex !== undefined && line.index > askedIndex && line.text.includes(fragment),
    ),
  };
}

async function stateDirectoryFor(t) {
  const directory = await mkdtemp(join(tmpdir(), "cuna-recorded-launch-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return directory;
}

test("the first launch is never asked, and it records one identity", async (t) => {
  const stateDirectory = await stateDirectoryFor(t);
  const first = await launch(stateDirectory);
  assert.equal(first.exit, 0, JSON.stringify(first.lines.map((line) => line.text)));
  assert.equal(first.askedAt, undefined, "there is nothing recorded yet to ask about");
  assert.equal(first.operationIds.length, 1);
  // Announced as new, because it is: no recorded launch was re-dispatched.
  assert.ok(first.find(`AgentSession ${SESSION_ID.slice(0, 8)} · created`));
});

test("answering No is answered on screen before the next remote step", async (t) => {
  const stateDirectory = await stateDirectoryFor(t);
  const first = await launch(stateDirectory);
  assert.equal(first.exit, 0);

  const second = await launch(stateDirectory, { answer: "n" });
  assert.equal(second.exit, 0);
  assert.notEqual(second.askedAt, undefined, "the recorded launch must produce the question");

  const acknowledgement = second.findAfterTheQuestion("Resuming the recorded launch");
  assert.ok(acknowledgement, "the answer itself is an event worth rendering");
  const silenceMs = acknowledgement.at - second.askedAt;
  assert.equal(silenceMs, 0);
  assert.ok(silenceMs < RECORDED_LAUNCH_ACKNOWLEDGEMENT_BUDGET_MS);

  // The branch that was taken, named on the row that carries the id.
  assert.ok(second.find(`AgentSession ${SESSION_ID.slice(0, 8)} · reused`));
  // And it really was a re-dispatch: the recorded operation id, not a new one.
  assert.deepEqual(second.operationIds, first.operationIds);
});

test("DISCRIMINATING CONTROL: the step behind the answer is 18 314 ms long, and the instrument sees it", async (t) => {
  // Without this the assertion above would pass on a fixture where nothing
  // happens after the answer. The next line the CLI writes lands a full
  // measured silence later, so a build that wrote nothing at the answer would
  // report 18 314 ms here — which is what the transcripts of § 3 show.
  const stateDirectory = await stateDirectoryFor(t);
  await launch(stateDirectory);
  const second = await launch(stateDirectory, { answer: "n" });

  const afterTheStep = second.lines.filter((line) => line.at >= second.askedAt + MEASURED_SILENCE_MS);
  assert.ok(afterTheStep.length > 0, "the fixture must actually spend the time");
  const firstAfterTheAnswer = second.lines.find((line) => line.at > second.askedAt);
  assert.equal(firstAfterTheAnswer.at - second.askedAt, MEASURED_SILENCE_MS);
  assert.ok(MEASURED_SILENCE_MS > RECORDED_LAUNCH_ACKNOWLEDGEMENT_BUDGET_MS);
});

test("answering Yes says so, and mints a new launch identity", async (t) => {
  const stateDirectory = await stateDirectoryFor(t);
  const first = await launch(stateDirectory);
  const second = await launch(stateDirectory, { answer: "y" });
  assert.equal(second.exit, 0);

  const acknowledgement = second.findAfterTheQuestion("Creating Claude Code session");
  assert.ok(acknowledgement, "the create branch is named after itself");
  assert.equal(acknowledgement.at - second.askedAt, 0);
  assert.ok(acknowledgement.at - second.askedAt < RECORDED_LAUNCH_ACKNOWLEDGEMENT_BUDGET_MS);
  assert.ok(second.find(`AgentSession ${SESSION_ID.slice(0, 8)} · created`));
  assert.notDeepEqual(second.operationIds, first.operationIds);
});
