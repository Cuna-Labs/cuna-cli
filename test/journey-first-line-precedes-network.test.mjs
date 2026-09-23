import assert from "node:assert/strict";
import test from "node:test";

import { memoryStreams, runCli } from "../dist/index.js";

/**
 * THE FIRST TRUTHFUL LINE IS PAINTED BEFORE THE CLI TOUCHES THE NETWORK, AND
 * THAT ORDER IS THE THING UNDER TEST — not how many milliseconds it took.
 *
 * WHY IT IS AN ORDER AND NOT A DURATION. Measured 2026-09-22
 * (`prds/cuna-cli-latency-before-20260922.md` § 8.1, row (i)): the first line
 * was reported at 499 ms before the responsiveness work and 1 125 ms after it,
 * and the regression was read as "something now runs before the first paint".
 * Nothing does. From `runCli` to the first paint the compiled code of the two
 * builds (installed `bb18869345…`, candidate `7e62dd7`) is byte-identical; the
 * candidate's static import graph is 4 files and 51 KB (2.3%) larger, and
 * loading that graph is ~98% of the time before the paint. Interleaved on one
 * host (17:43Z–17:45Z, n=15 per run, two runs) the paired medians were +33 ms
 * and −24 ms. The same UNCHANGED installed build, through the same npm shim in
 * a ConPTY, painted at 1 391 ms that hour (median, n=10, host CPU 81–100%)
 * against 499 ms the night before, so the 626 ms belonged to the host, not to
 * the code. A millisecond threshold here
 * would encode that host noise and fail on a loaded machine while the property
 * it cares about still held.
 *
 * The property that actually protects the person at the keyboard is this one:
 * whatever else is inserted at the head of the command, the screen speaks
 * first. A read placed before the paint cannot be hidden by a fast network, and
 * this test sees it even when every read answers in a microsecond.
 */

const MACHINE = "harness";
const NOW_MS = Date.parse("2026-09-22T15:27:10.557Z");
const STOP = "stop-after-the-probe";

const PLATFORM = Object.freeze({
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
});

/**
 * Run one command and report what was on stderr the first time the CLI reached
 * for the network.
 *
 * The probe sits in `acquireAccessToken`, which is the EARLIEST network touch
 * on every interactive path: the guided sign-in recovery awaits it before the
 * journey's own account read, so a read inserted anywhere at the head of the
 * command is still downstream of this snapshot. It also sits in `fetch`, under
 * every HTTP transport the command builds, so a request that bypasses both
 * seams is seen too.
 */
async function screenAtFirstNetworkTouch(argv, extra = {}) {
  const streams = memoryStreams({ stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: extra.stderrIsTTY ?? true });
  let atFirstTouch;
  let touches = 0;
  const exit = await runCli(argv, {
    streams: streams.streams,
    platform: PLATFORM,
    env: {},
    now: () => NOW_MS,
    fetch: async () => {
      touches += 1;
      atFirstTouch ??= streams.stderr();
      throw new Error(STOP);
    },
    humanAuth: {
      async acquireAccessToken() {
        touches += 1;
        atFirstTouch ??= streams.stderr();
        return `cuna_at_${"a".repeat(43)}`;
      },
    },
    clientFactory: () => ({
      async getIdentity() {
        touches += 1;
        atFirstTouch ??= streams.stderr();
        throw new Error(STOP);
      },
    }),
    ...extra.dependencies,
  });
  return { exit, touches, atFirstTouch: atFirstTouch ?? "", stderr: streams.stderr() };
}

test("`cuna claude` names what it is doing before it touches the network", async () => {
  const run = await screenAtFirstNetworkTouch(["claude", "/work/project", "--machine", MACHINE]);
  assert.ok(run.touches >= 1, "the probe must have fired; otherwise it proves nothing");
  assert.match(run.atFirstTouch, /Preparing Claude Code/u);
});

test("and the line it shows first is the one that is true at that moment", async () => {
  // `Connecting to Claude Code` is painted only once authentication is usable.
  // If it were on screen at the first network touch, the CLI would be claiming
  // a connection it had not yet attempted — the same defect one step earlier.
  const run = await screenAtFirstNetworkTouch(["claude", "/work/project", "--machine", MACHINE]);
  assert.doesNotMatch(run.atFirstTouch, /Connecting to Claude Code/u);
  // It does get there later in the same command, so the absence above is an
  // ordering fact rather than a line that never exists.
  assert.match(run.stderr, /Connecting to Claude Code/u);
});

test("DISCRIMINATING CONTROL: the same probe reports an empty screen where nothing is painted first", async () => {
  // `cuna machines` deliberately starts its row only AFTER authentication, so
  // that it never claims to search machines while signing in is the real
  // operation. The instrument must report that difference rather than always
  // finding a label — otherwise the assertion above would pass on any command.
  const run = await screenAtFirstNetworkTouch(["machines"], {
    dependencies: { machinesExplorerRunner: async () => undefined },
  });
  assert.ok(run.touches >= 1);
  assert.equal(run.atFirstTouch, "");
});

test("the plain-stderr rendering keeps the same order", async () => {
  // Without a TTY there is no spinner row, and the same sentence is one plain
  // line. The order it is written in is the property, so it is asserted on both
  // renderings rather than only on the one a person usually sees.
  const run = await screenAtFirstNetworkTouch(["claude", "/work/project", "--machine", MACHINE], { stderrIsTTY: false });
  assert.ok(run.touches >= 1);
  assert.match(run.atFirstTouch, /Cuna: preparing Claude Code\.\.\./u);
});
