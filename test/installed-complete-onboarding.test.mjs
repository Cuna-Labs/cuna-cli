import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { sha256File, verifyEnvelopeFiles } from "../scripts/lib/release-evidence.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "20000000-0000-4000-8000-000000000002";
const WORKSPACE_ID = "30000000-0000-4000-8000-000000000003";
const API_KEY_ID = "40000000-0000-4000-8000-000000000004";
const AGENT_SESSION_ID = "50000000-0000-4000-8000-000000000005";
const CLAUDE_SESSION_ID = "51000000-0000-4000-8000-000000000005";
const OPENCLAW_SESSION_ID = "52000000-0000-4000-8000-000000000005";
const OPENCODE_SESSION_ID = "53000000-0000-4000-8000-000000000005";
const OPENCODE_AUTH_MISSING_SESSION_ID = "54000000-0000-4000-8000-000000000005";
const OPENCODE_AUTH_INVALID_SESSION_ID = "55000000-0000-4000-8000-000000000005";
const OPENCODE_AUTH_CONFIGURED_SESSION_ID = "56000000-0000-4000-8000-000000000005";
const WORKSPACE_BINDING_ID = "60000000-0000-4000-8000-000000000006";
const PROCESS_EPOCH = "70000000-0000-4000-8000-000000000007";
const LOGIN_CODE = `cuna_login_${"l".repeat(43)}`;
const LOGIN_CODE_2 = `cuna_login_${"m".repeat(43)}`;
const EXPIRED_LOGIN_CODE = `cuna_login_${"e".repeat(43)}`;

const RELEASE_E2E_MODE = "release";
const DEVELOPMENT_E2E_MODE = "development";
const SERVER_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 15_000;
const INSTALLED_COMMAND_TIMEOUT_MS = 30_000;
// The final serial phase invokes two cleanup mutations, two whoami checks,
// three API-key commands, logout, and the post-logout whoami negative.
const INSTALLED_SESSION_API_KEY_AND_LOGOUT_COMMAND_COUNT = 9;
const INSTALLED_SESSION_API_KEY_AND_LOGOUT_PHASE_TIMEOUT_MS =
  INSTALLED_SESSION_API_KEY_AND_LOGOUT_COMMAND_COUNT * INSTALLED_COMMAND_TIMEOUT_MS + SERVER_TIMEOUT_MS + CLEANUP_TIMEOUT_MS;
// The browser-code driver returns the code immediately; a status-poll attempt
// still fails at the first forbidden GET.  Its process bound must nevertheless
// match the authenticated phase because a real Windows owner-only ACL check is
// part of the installed product path and can legitimately consume tens of
// seconds on a cold profile.
const INSTALLED_AUTH_DRIVER_TIMEOUT_MS = 90_000;
const READ_ONLY_MATRIX_CONCURRENCY = 4;
// This journey is deliberately serial after sign-in because every mutation
// observes one encrypted profile and one contract authority. The Node test
// runner's generic five-minute default is therefore not an authority for this
// test: the only valid parent bound is the sum of these named phase budgets.
// Each individual child and phase remains independently bounded below.
const INSTALLED_E2E_PHASE_TIMEOUTS = Object.freeze({
  "contract-server-start": SERVER_TIMEOUT_MS,
  "isolated-profile-config": SERVER_TIMEOUT_MS,
  "candidate-selection-and-integrity": 125_000,
  "isolated-npm-install": 125_000,
  "installed-package-surface": 30_000,
  "installed-readonly-command-matrix": 125_000,
  "installed-doctor-browser-contract": 90_000,
  "installed-signup": 90_000,
  "installed-waitlisted-whoami": 45_000,
  "installed-waitlisted-logout": 45_000,
  "installed-login": 90_000,
  "installed-admitted-whoami": 45_000,
  "installed-authenticated-readonly-command-matrix": 10 * INSTALLED_COMMAND_TIMEOUT_MS + CLEANUP_TIMEOUT_MS,
  "installed-machine-lifecycle-command-matrix": 5 * INSTALLED_COMMAND_TIMEOUT_MS + CLEANUP_TIMEOUT_MS,
  "installed-agent-session-command-matrix": 5 * INSTALLED_COMMAND_TIMEOUT_MS + CLEANUP_TIMEOUT_MS,
  "installed-stale-supervisor-evidence-negative": 45_000,
  "installed-explicit-foreground-command-matrix": 120_000,
  "installed-opencode-mutable-witness-gate": 90_000,
  "installed-automatic-foreground-command-matrix": 120_000,
  "installed-session-api-key-and-logout": INSTALLED_SESSION_API_KEY_AND_LOGOUT_PHASE_TIMEOUT_MS,
  "contract-server-teardown": CLEANUP_TIMEOUT_MS,
  "sandbox-cleanup": CLEANUP_TIMEOUT_MS,
});
const INSTALLED_E2E_SERIAL_PHASE_TIMEOUT_MS = Object.values(INSTALLED_E2E_PHASE_TIMEOUTS)
  .reduce((total, timeoutMs) => total + timeoutMs, 0);
// On a phase failure `within` owns child teardown for one cleanup budget, then
// the test's finally block owns server and sandbox cleanup. Keep that bounded
// recovery time explicit rather than silently relying on the global runner.
const INSTALLED_E2E_FAILURE_CLEANUP_TIMEOUT_MS = 3 * CLEANUP_TIMEOUT_MS;
const INSTALLED_E2E_TEST_TIMEOUT_MS = INSTALLED_E2E_SERIAL_PHASE_TIMEOUT_MS + INSTALLED_E2E_FAILURE_CLEANUP_TIMEOUT_MS;
const INSTALLED_E2E_TEST_OPTIONS = Object.freeze({ timeout: INSTALLED_E2E_TEST_TIMEOUT_MS });

function installedE2ePhaseTimeout(name) {
  const timeoutMs = INSTALLED_E2E_PHASE_TIMEOUTS[name];
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`Installed E2E phase ${name} has no bounded timeout.`);
  }
  return timeoutMs;
}

const PRODUCT_CREDENTIAL_FILES = Object.freeze(
  ["contracts", "errors", "index", "local-session", "secret-material", "vault"].flatMap((module) => [
    `${module}.d.ts`,
    `${module}.d.ts.map`,
    `${module}.js`,
    `${module}.js.map`,
  ]),
);
const installedE2eExecutionScope = new AsyncLocalStorage();
const activeInstalledE2eInvocations = new Map();
const activeInstalledE2ePhases = new Map();
let installedE2eChildSequence = 0;
let installedE2ePhaseSequence = 0;

/**
 * Keeps the installed-artifact test legible when a command times out. The
 * receipt deliberately contains phases and immutable candidate identifiers
 * only: captured output can contain secrets, so it is never persisted here.
 */
class InstalledE2eReceipt {
  #startedAtMs = Date.now();
  #startedAt = new Date(this.#startedAtMs).toISOString();
  #active;
  #phases = [];
  #candidate;
  #children = [];

  candidate(input) {
    this.#candidate = Object.freeze(input);
  }

  begin(name, timeoutMs) {
    if (this.#active !== undefined) throw new Error(`Installed E2E phase ${this.#active.name} did not finish.`);
    this.#active = { name, timeoutMs, startedAt: Date.now() };
  }

  complete() {
    if (this.#active === undefined) throw new Error("Installed E2E phase completion has no active phase.");
    const active = this.#active;
    this.#active = undefined;
    this.#phases.push(this.#phaseRecord(active, "passed"));
  }

  fail(error) {
    if (this.#active === undefined) return;
    const active = this.#active;
    this.#active = undefined;
    this.#phases.push(this.#phaseRecord(
      active,
      Date.now() - active.startedAt >= active.timeoutMs ? "timed_out" : "failed",
      error,
    ));
  }

  abort(name, error, status) {
    if (this.#active === undefined || this.#active.name !== name) return;
    const active = this.#active;
    this.#active = undefined;
    this.#phases.push(this.#phaseRecord(active, status, error));
  }

  childStarted(input) {
    const child = {
      id: input.id,
      phase: input.phase,
      label: input.label,
      resourceLabels: input.resourceLabels,
      startedAt: Date.now(),
    };
    this.#children.push(child);
    return child;
  }

  childTerminationRequested(child, reason, resourceLabels) {
    if (child === undefined || child.terminationReason !== undefined) return;
    child.terminationReason = safeReceiptReason(reason);
    child.resourceLabelsAtTermination = resourceLabels;
  }

  childFinished(child, status, resourceLabels) {
    if (child === undefined || child.status !== undefined) return;
    child.status = status;
    child.durationMs = Date.now() - child.startedAt;
    child.resourceLabelsAtFinish = resourceLabels;
  }

  #phaseRecord(active, status, error) {
    return Object.freeze({
      name: active.name,
      timeout_ms: active.timeoutMs,
      duration_ms: Date.now() - active.startedAt,
      status,
      ...(error === undefined ? {} : { error: safeReceiptError(error) }),
    });
  }

  snapshot() {
    const active = this.#active === undefined
      ? []
      : [this.#phaseRecord(this.#active, "running")];
    return Object.freeze({
      schema_version: 1,
      kind: "installed_complete_onboarding_e2e",
      started_at: this.#startedAt,
      candidate: this.#candidate ?? null,
      phases: Object.freeze([...this.#phases, ...active]),
      children: Object.freeze(this.#children.map((child) => Object.freeze({
        id: child.id,
        phase: child.phase,
        label: child.label,
        started_offset_ms: child.startedAt - this.#startedAtMs,
        duration_ms: child.durationMs ?? Date.now() - child.startedAt,
        status: child.status ?? "running",
        resource_labels: child.resourceLabels,
        ...(child.terminationReason === undefined ? {} : { termination_reason: child.terminationReason }),
        ...(child.resourceLabelsAtTermination === undefined
          ? {}
          : { resource_labels_at_termination: child.resourceLabelsAtTermination }),
        ...(child.resourceLabelsAtFinish === undefined
          ? {}
          : { resource_labels_at_finish: child.resourceLabelsAtFinish }),
      }))),
    });
  }
}

async function runPhase(receipt, name, timeoutMs, operation) {
  const scope = createInstalledE2ePhaseScope(receipt, name, timeoutMs);
  receipt.begin(name, timeoutMs);
  activeInstalledE2ePhases.set(scope.id, scope);
  try {
    const result = await installedE2eExecutionScope.run(scope, () => within(timeoutMs, operation, name, scope));
    receipt.complete();
    return result;
  } catch (error) {
    receipt.fail(error);
    throw error;
  } finally {
    activeInstalledE2ePhases.delete(scope.id);
  }
}

function createInstalledE2ePhaseScope(receipt, name, timeoutMs) {
  let rejectAbort;
  const scope = {
    id: ++installedE2ePhaseSequence,
    receipt,
    name,
    timeoutMs,
    controller: new AbortController(),
    abortError: undefined,
    teardown: undefined,
    abortPromise: undefined,
    rejectAbort: undefined,
  };
  scope.abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
  scope.rejectAbort = rejectAbort;
  return scope;
}

function abortInstalledE2ePhase(scope, error, status) {
  if (scope.abortError !== undefined) return scope.teardown ?? Promise.resolve();
  scope.abortError = error;
  scope.receipt.abort(scope.name, error, status);
  try { scope.controller.abort(error); } catch { /* AbortController is best effort here. */ }
  scope.rejectAbort(error);
  scope.teardown = terminateInstalledE2eChildren(scope, safeReceiptReason(error.message));
  return scope.teardown;
}

async function terminateInstalledE2eChildren(scope, reason) {
  const owned = [...activeInstalledE2eInvocations.values()].filter((child) => child.phaseId === scope.id);
  await Promise.allSettled(owned.map((child) => child.terminate(reason)));
  await awaitBounded(
    Promise.allSettled(owned.map((child) => child.settled)),
    CLEANUP_TIMEOUT_MS,
  );
}

function abortAllInstalledE2ePhases(error) {
  return Promise.allSettled(
    [...activeInstalledE2ePhases.values()].map((scope) => abortInstalledE2ePhase(scope, error, "aborted")),
  );
}

async function within(timeoutMs, operation, name, suppliedScope) {
  const scope = suppliedScope ?? installedE2eExecutionScope.getStore();
  let timer;
  let timeoutError;
  const running = Promise.resolve().then(operation);
  try {
    return await Promise.race([
      running,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const active = activeInstalledE2eLabels(scope).join(", ") || "no owned child process";
          timeoutError = new Error(`Installed E2E phase ${name} exceeded ${timeoutMs}ms while running ${active}.`);
          if (scope !== undefined) void abortInstalledE2ePhase(scope, timeoutError, "timed_out");
          reject(timeoutError);
        }, timeoutMs);
      }),
      ...(scope === undefined ? [] : [scope.abortPromise]),
    ]);
  } catch (error) {
    // The phase limit owns every child it started. Wait for their bounded
    // teardown before the caller closes the fixture server or removes the
    // temporary prefix; otherwise a timeout can hide the actual command behind
    // an EBUSY cleanup error.
    if (error === timeoutError || (scope !== undefined && error === scope.abortError)) {
      await awaitBounded(
        Promise.allSettled([
          running.catch(() => undefined),
          scope?.teardown ?? Promise.resolve(),
        ]),
        CLEANUP_TIMEOUT_MS,
      );
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function activeInstalledE2eLabels(scope) {
  return [...activeInstalledE2eInvocations.values()]
    .filter((child) => scope === undefined || child.phaseId === scope.id)
    .map((child) => `child-${child.id}:${child.label}`);
}

async function awaitBounded(operation, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      operation,
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function safeReceiptReason(value) {
  return typeof value === "string" && /^[-A-Za-z0-9_.: ]{1,240}$/u.test(value)
    ? value
    : "redacted_diagnostic";
}

function safeReceiptError(error) {
  const code = error !== null && typeof error === "object" &&
    typeof error.code === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/u.test(error.code)
    ? error.code
    : undefined;
  if (code !== undefined) return `error:${code}`;
  if (error instanceof Error && error.message.startsWith("Installed E2E phase ")) {
    return safeReceiptReason(error.message);
  }
  if (error instanceof Error && error.message.startsWith("Installed E2E child ")) {
    return safeReceiptReason(error.message);
  }
  return error instanceof Error ? `error:${error.name}` : "non_error_failure";
}

async function selectInstalledCandidate(sandbox) {
  const mode = process.env.CUNA_E2E_MODE ?? RELEASE_E2E_MODE;
  const suppliedCandidate = process.env.CUNA_E2E_CANDIDATE_DIR;
  if (mode !== RELEASE_E2E_MODE && mode !== DEVELOPMENT_E2E_MODE) {
    throw new Error(`CUNA_E2E_MODE must be ${RELEASE_E2E_MODE} or ${DEVELOPMENT_E2E_MODE}.`);
  }
  if (mode === RELEASE_E2E_MODE) {
    if (suppliedCandidate === undefined || suppliedCandidate.length === 0) {
      throw new Error("Release-mode installed E2E requires CUNA_E2E_CANDIDATE_DIR; refusing an unbound source-tree pack fallback.");
    }
    const candidateRoot = path.resolve(suppliedCandidate);
    const manifest = JSON.parse(await readFile(path.join(candidateRoot, "release-envelope.json"), "utf8"));
    await verifyEnvelopeFiles(manifest, candidateRoot);
    const tarball = path.resolve(candidateRoot, manifest.tarball.file);
    const tarballSha256 = await sha256File(tarball);
    assert.equal(tarballSha256, manifest.tarball.sha256, "Release-mode candidate tarball digest differs from its release envelope");
    await stat(tarball);
    return Object.freeze({
      mode,
      candidateRoot,
      manifest,
      tarball,
      candidateSha256: tarballSha256,
    });
  }
  if (suppliedCandidate !== undefined) {
    throw new Error("Development-mode installed E2E must not accept CUNA_E2E_CANDIDATE_DIR; use CUNA_E2E_MODE=release for an immutable candidate.");
  }
  const candidate = path.join(sandbox, "development-unbound-source-pack");
  await mkdir(candidate, { recursive: false });
  const packed = await runNpm(["pack", root, "--ignore-scripts", "--json", "--pack-destination", candidate], { cwd: sandbox, timeout: 120_000 });
  assert.equal(packed.code, 0, "development-mode installed E2E npm pack failed");
  const packRecord = JSON.parse(packed.stdout)[0];
  const tarball = path.join(candidate, packRecord.filename);
  await stat(tarball);
  return Object.freeze({
    mode,
    candidateRoot: candidate,
    manifest: Object.freeze({ version: packRecord.version }),
    tarball,
    candidateSha256: await sha256File(tarball),
  });
}

async function closeServerBounded(server) {
  server.closeAllConnections?.();
  await within(CLEANUP_TIMEOUT_MS, () => new Promise((resolve, reject) => {
    server.close((error) => {
      if (error?.code === "ERR_SERVER_NOT_RUNNING") return resolve();
      if (error !== undefined) return reject(error);
      resolve();
    });
  }), "contract-server-teardown");
}

class InstalledE2eReceiptPublisher {
  #write = Promise.resolve();
  #output;

  constructor(output = process.env.CUNA_E2E_RECEIPT_FILE) {
    this.#output = output;
  }

  publish(receipt) {
    // Take the snapshot before queueing the write. A later cleanup event can
    // only publish a newer snapshot, never turn a timeout receipt back into a
    // stale running record.
    const snapshot = receipt.snapshot();
    this.#write = this.#write.catch(() => undefined).then(() => writeReceiptSnapshot(snapshot, this.#output));
    return this.#write;
  }
}

async function writeReceiptSnapshot(receipt, output = process.env.CUNA_E2E_RECEIPT_FILE) {
  if (output === undefined || output.length === 0) return;
  const destination = path.resolve(output);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(receipt, null, 2)}\n`);
}

test("installed E2E phase timeout owns its child tree and emits a redacted timing receipt", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cuna-installed-e2e-harness-"));
  const receiptPath = path.join(directory, "receipt.json");
  const timeoutReceipt = new InstalledE2eReceipt();
  const independentReceipt = new InstalledE2eReceipt();
  try {
    const [timedOut, independent] = await Promise.allSettled([
      runPhase(timeoutReceipt, "harness-owned-child-timeout", 50, () =>
        runNode(["--eval", "setInterval(() => {}, 1_000);"], { cwd: root, timeout: 120_000 })),
      runPhase(independentReceipt, "harness-independent-child", 5_000, () =>
        runNode(["--eval", "setTimeout(() => process.exit(0), 100);"], { cwd: root, timeout: 120_000 })),
    ]);
    assert.equal(timedOut.status, "rejected");
    assert.match(timedOut.reason?.message ?? "", /harness-owned-child-timeout/u);
    assert.match(timedOut.reason?.message ?? "", /child-\d+:process:node/u, "a phase timeout must identify its active owned child");
    assert.equal(independent.status, "fulfilled", independent.reason?.message);

    const publisher = new InstalledE2eReceiptPublisher(receiptPath);
    await publisher.publish(timeoutReceipt);
    const snapshot = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(snapshot.phases.length, 1);
    assert.equal(snapshot.phases[0].name, "harness-owned-child-timeout");
    assert.equal(snapshot.phases[0].status, "timed_out");
    assert.equal(snapshot.children.length, 1);
    assert.equal(snapshot.children[0].phase, "harness-owned-child-timeout");
    assert.equal(snapshot.children[0].label, "process:node");
    assert.match(snapshot.children[0].status, /^(?:terminated|teardown_unconfirmed)$/u);
    assert.match(snapshot.children[0].termination_reason ?? "", /child-\d+:process:node/u);
    assert.equal(Array.isArray(snapshot.children[0].resource_labels), true);
    assert.equal(Array.isArray(snapshot.children[0].resource_labels_at_termination), true);
    assert.doesNotMatch(JSON.stringify(snapshot), /(?:cuna|runa)_(?:sk|login|ct|at)_[A-Za-z0-9_-]+/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installed E2E parent timeout is derived from serial named phases without relaxing child ownership", () => {
  const declaredSerialBudget = Object.values(INSTALLED_E2E_PHASE_TIMEOUTS)
    .reduce((total, timeoutMs) => total + timeoutMs, 0);
  assert.equal(INSTALLED_E2E_SERIAL_PHASE_TIMEOUT_MS, declaredSerialBudget);
  assert.equal(
    INSTALLED_E2E_TEST_OPTIONS.timeout,
    declaredSerialBudget + INSTALLED_E2E_FAILURE_CLEANUP_TIMEOUT_MS,
  );
  assert.ok(
    INSTALLED_E2E_TEST_OPTIONS.timeout > 300_000,
    "the installed journey needs its derived test-local budget instead of the generic five-minute runner limit",
  );
  assert.equal(INSTALLED_COMMAND_TIMEOUT_MS, 30_000, "the aggregate parent budget must not relax a child command cutoff");
  assert.equal(
    installedE2ePhaseTimeout("installed-waitlisted-logout"),
    45_000,
    "a named phase remains independently bounded below the parent budget",
  );
});

test("the candidate-bound installed CLI completes signup/login/API-key/logout against a local contract server", INSTALLED_E2E_TEST_OPTIONS, async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cuna-installed-onboarding-"));
  const prefix = path.join(sandbox, "npm-prefix");
  const user = path.join(sandbox, "user");
  const configFile = path.join(user, "config.json");
  const authority = createContractAuthority();
  const server = createServer(authority.handle);
  const receipt = new InstalledE2eReceipt();
  const publisher = new InstalledE2eReceiptPublisher();
  let serverListening = false;
  let primaryFailure;
  let cleanupFailure;
  const abortOnTestCancellation = () => {
    const error = new Error("Installed E2E test cancellation requested.");
    void abortAllInstalledE2ePhases(error);
    void publisher.publish(receipt).catch(() => undefined);
  };
  t.signal?.addEventListener("abort", abortOnTestCancellation, { once: true });
  try {
    await runPhase(receipt, "contract-server-start", installedE2ePhaseTimeout("contract-server-start"), () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    }));
    serverListening = true;
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await runPhase(receipt, "isolated-profile-config", installedE2ePhaseTimeout("isolated-profile-config"), async () => {
      await mkdir(user, { recursive: true });
      await writeFile(configFile, `${JSON.stringify({
        schema_version: 1,
        selected_profile: "installed-e2e",
        profiles: { "installed-e2e": { development: true, base_url: baseUrl } },
      })}\n`);
    });

    const candidate = await runPhase(receipt, "candidate-selection-and-integrity", installedE2ePhaseTimeout("candidate-selection-and-integrity"), () => selectInstalledCandidate(sandbox));
    receipt.candidate({
      mode: candidate.mode,
      tarball_sha256: candidate.candidateSha256,
      ...(candidate.mode === RELEASE_E2E_MODE ? { source_commit: candidate.manifest.sourceCommit } : {}),
    });
    const { manifest, tarball } = candidate;
    await runPhase(receipt, "isolated-npm-install", installedE2ePhaseTimeout("isolated-npm-install"), async () => {
      const installed = await runNpm(["install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix, tarball], { cwd: sandbox, timeout: 120_000 });
      assert.equal(installed.code, 0, `installed E2E npm install failed after ${installed.durationMs}ms`);
    });

    const installedEntrypoint = path.join(prefix, "node_modules", "@cuna_labs", "cli", "dist", "bin", "cuna.js");
    const installedRoot = path.join(prefix, "node_modules", "@cuna_labs", "cli");
    const env = {
      ...process.env,
      APPDATA: path.join(user, "appdata"),
      LOCALAPPDATA: path.join(user, "localappdata"),
      USERPROFILE: user,
      HOME: user,
      CUNA_CONFIG_FILE: configFile,
      CUNA_PROFILE: "installed-e2e",
      CUNA_TEST_INSTALLED_ROOT: installedRoot,
      NO_COLOR: "1",
    };
    delete env.CUNA_API_KEY;
    delete env.RUNA_API_KEY;
    delete env.CUNA_OPENCODE_ENABLED;

    let installedHelpTopics;
    await runPhase(receipt, "installed-package-surface", installedE2ePhaseTimeout("installed-package-surface"), async () => {
      await stat(installedEntrypoint);
      assert.equal(path.resolve(installedEntrypoint).startsWith(path.resolve(prefix)), true);
      assert.equal(path.resolve(installedEntrypoint).startsWith(path.resolve(root)), false);
      const installedCredentialFiles = await readdir(path.join(installedRoot, "dist", "credentials"));
      assert.deepEqual(
        [...installedCredentialFiles].sort(),
        [...PRODUCT_CREDENTIAL_FILES].sort(),
        "installed package must ship only the public AES-GCM credential surface",
      );
      const installedPackageJson = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8"));
      assert.equal(installedPackageJson.optionalDependencies, undefined, "pure-JavaScript tarball declared a native optional dependency");
      installedHelpTopics = (await import(pathToFileURL(path.join(installedRoot, "dist", "cli", "command-help.js")).href)).HELP_TOPICS;
      assert.deepEqual([...installedHelpTopics].sort(), [...INSTALLED_HELP_TOPICS].sort(), "a new installed command lacks matrix classification");
      const leafTopics = installedHelpTopics.filter((topic) => !installedHelpTopics.some((candidate) => candidate.startsWith(`${topic} `)));
      assert.deepEqual([...leafTopics].sort(), [...SUPPORTED_SUCCESS_TOPICS, ...DELIBERATE_UNSUPPORTED_TOPICS].sort(), "a leaf command lacks success or deliberate-unsupported evidence");
    });

    await runPhase(receipt, "installed-readonly-command-matrix", installedE2ePhaseTimeout("installed-readonly-command-matrix"), async () => {
    const version = await invokeInstalled(installedEntrypoint, ["version", "--json"], env, sandbox);
    assert.equal(version.code, 0);
    assert.equal(JSON.parse(version.stdout).data.version, manifest.version);
    if (candidate.mode === RELEASE_E2E_MODE) {
      assert.equal(
        JSON.parse(version.stdout).data.buildDigest,
        manifest.identities.payloadSha256,
        "Installed release-mode payload identity differs from the candidate release envelope",
      );
    }
    await runBoundedConcurrent(INSTALLED_HELP_TOPICS, READ_ONLY_MATRIX_CONCURRENCY, async (topic) => {
      const help = await invokeInstalled(installedEntrypoint, [...topic.split(" "), "--help", "--json"], env, sandbox);
      assert.equal(help.code, 0, `installed help failed for ${topic}`);
      assert.equal(JSON.parse(help.stdout).type, "result", topic);
    });
    await runBoundedConcurrent(INSTALLED_FAILURE_MATRIX, READ_ONLY_MATRIX_CONCURRENCY, async (entry) => {
      const result = await invokeInstalled(installedEntrypoint, entry.argv, env, sandbox);
      assert.equal(result.code, entry.exit, `installed failure mode drifted for ${entry.id}`);
      const record = JSON.parse(result.stderr);
      assert.equal(record.error.code, entry.code, entry.id);
    }, (entry) => entry.id);
    });

    await runPhase(receipt, "installed-doctor-browser-contract", installedE2ePhaseTimeout("installed-doctor-browser-contract"), async () => {
    const doctor = await invokeInstalledRuntime(["doctor", "--json"], env, sandbox);
    assert.equal(doctor.code, 0, `installed doctor failed: ${safeErrorCode(doctor.stderr)}`);
    const doctorRecord = JSON.parse(doctor.stdout);
    assert.equal(doctorRecord.command, "doctor");
    const encryptedStore = doctorRecord.data.runtime_features.find((feature) => feature.feature === "encrypted_local_session_store");
    assert.equal(encryptedStore.implementation, "available");
    const unprobedBrowserLogin = doctorRecord.data.runtime_features.find((feature) => feature.feature === "browser_login_remote");
    assert.deepEqual(unprobedBrowserLogin, {
      feature: "browser_login_remote",
      implementation: "unsupported",
      reason: "remote_browser_login_not_checked",
    });
    const checkedDoctor = await invokeInstalledRuntime(["doctor", "--check-browser-login", "--json"], env, sandbox);
    assert.equal(checkedDoctor.code, 0, checkedDoctor.stderr);
    const checkedFeatures = JSON.parse(checkedDoctor.stdout).data.runtime_features;
    assert.deepEqual(checkedFeatures.find((feature) => feature.feature === "browser_login_remote"), {
      feature: "browser_login_remote",
      implementation: "available",
      reason: "remote_browser_login_bootstrap_verified",
    });
    assert.deepEqual(checkedFeatures.find((feature) => feature.feature === "browser_auth"), {
      feature: "browser_auth",
      implementation: "available",
      reason: "browser_login_remote_and_encrypted_local_verified",
    });
    });

    await runPhase(receipt, "installed-signup", installedE2ePhaseTimeout("installed-signup"), async () => {
      const signup = await invokeInstalledAuth(["signup"], env, sandbox, LOGIN_CODE);
      assert.equal(signup.code, 0, `installed signup failed: ${safeErrorCode(signup.stderr)}`);
    });

    await runPhase(receipt, "installed-waitlisted-whoami", installedE2ePhaseTimeout("installed-waitlisted-whoami"), async () => {
      const signupWhoami = await invokeInstalledRuntime(["whoami", "--json"], env, sandbox, { sessionTrace: true });
      assert.equal(signupWhoami.code, 0, `installed signup whoami failed: ${safeErrorCode(signupWhoami.stderr)}`);
      assert.equal(JSON.parse(signupWhoami.stdout).data.admission, "waitlisted");
    });

    await runPhase(receipt, "installed-waitlisted-logout", installedE2ePhaseTimeout("installed-waitlisted-logout"), async () => {
      const signupLogout = await invokeInstalledRuntime(["logout", "--json"], env, sandbox, { sessionTrace: true });
      assert.equal(signupLogout.code, 0, `installed signup logout failed: ${safeErrorCode(signupLogout.stderr)}`);
    });

    await runPhase(receipt, "installed-login", installedE2ePhaseTimeout("installed-login"), async () => {
      const login = await invokeInstalledAuth(["login"], env, sandbox, LOGIN_CODE_2);
      const sessionState = await installedSessionPairState(user);
      assert.equal(login.code, 0, `installed login failed: ${safeErrorCode(login.stderr)}; ${sessionState.diagnostic}`);
      assert.equal(sessionState.valid, true, `installed login did not persist both encrypted session artifacts: ${sessionState.diagnostic}`);
    });

    await runPhase(receipt, "installed-admitted-whoami", installedE2ePhaseTimeout("installed-admitted-whoami"), async () => {
      // Keep this at the installed-process boundary, but record only redacted
      // lifecycle timings if it fails.  The previous direct child timeout
      // cannot distinguish a slow secure-store operation from a process that
      // already returned from runCli but retained a handle.
      const whoami = await invokeInstalledRuntime(["whoami", "--json"], env, sandbox, { sessionTrace: true });
      assert.equal(whoami.code, 0, "installed whoami failed");
      assert.equal(JSON.parse(whoami.stdout).data.workspace.state, "assigned");
      assert.equal(JSON.parse(whoami.stdout).data.storage_mode, "encrypted-local");
    });

    // Keep the authenticated surface serial: the mutations deliberately share
    // one local profile and authority.  It must still be phase-scoped, though.
    // On a cold Windows profile each installed process independently verifies
    // the owner-only store; treating the entire command inventory as one
    // under-budget aggregate operation turns healthy completions into a false
    // timeout before the final command starts.
    await runPhase(receipt, "installed-authenticated-readonly-command-matrix", installedE2ePhaseTimeout("installed-authenticated-readonly-command-matrix"), async () => {
    const successMatrix = [
      ["access", ["access", "status", "--json"]],
      ["capabilities", ["capabilities", "--json"]],
      ["machines.list", ["machines", "list", "--json"]],
      ["records.list", ["records", "list", "--json"]],
      ["authorizations.list", ["authorizations", "list", "--machine", ID, "--json"]],
      ["account.show", ["account", "show", "--json"]],
      ["workspace.show", ["workspace", "show", "--json"]],
      ["usage.show", ["usage", "show", "--json"]],
      ["config.get", ["config", "get", "--json"]],
      ["self-test.offline", ["self-test", "--offline", "--json"]],
    ];
    for (const [id, argv] of successMatrix) {
      const result = await invokeInstalled(installedEntrypoint, argv, env, sandbox);
      const sessionState = await installedSessionPairState(user);
      if (result.code !== 0) {
        throw installedCommandFailure(id, result.stderr, sessionState.diagnostic);
      }
      assert.equal(sessionState.valid, true, `installed success matrix damaged the encrypted session pair for ${id}: ${sessionState.diagnostic}`);
    }
    });

    await runPhase(receipt, "installed-machine-lifecycle-command-matrix", installedE2ePhaseTimeout("installed-machine-lifecycle-command-matrix"), async () => {
    const successMatrix = [
      ["machines.create", ["machines", "create", "--name", "matrix-machine", "--yes", "--json"]],
      ["machines.start", ["machines", "start", ID, "--yes", "--json"]],
      ["machines.pause", ["machines", "pause", ID, "--yes", "--json"]],
      ["machines.resume", ["machines", "resume", ID, "--yes", "--json"]],
      ["machines.stop", ["machines", "stop", ID, "--yes", "--json"]],
    ];
    for (const [id, argv] of successMatrix) {
      const result = await invokeInstalled(installedEntrypoint, argv, env, sandbox);
      const sessionState = await installedSessionPairState(user);
      assert.equal(result.code, 0, `installed success matrix failed for ${id}: ${safeErrorCode(result.stderr)}; ${sessionState.diagnostic}`);
      assert.equal(sessionState.valid, true, `installed machine lifecycle damaged the encrypted session pair for ${id}: ${sessionState.diagnostic}`);
    }
    });

    await runPhase(receipt, "installed-agent-session-command-matrix", installedE2ePhaseTimeout("installed-agent-session-command-matrix"), async () => {
    const successMatrix = [
      ["agent-sessions.create", ["agent-sessions", "create", "--machine", ID, "--workspace-binding-id", WORKSPACE_BINDING_ID, "--workspace-generation", "1", "--agent", "codex", "--yes", "--json"]],
      ["agent-sessions.list", ["agent-sessions", "list", "--machine", ID, "--json"]],
      ["agent-sessions.get", ["agent-sessions", "get", AGENT_SESSION_ID, "--json"]],
      ["agent-sessions.rename", ["agent-sessions", "rename", AGENT_SESSION_ID, "--name", "renamed-agent", "--yes", "--json"]],
      ["agent.logout", ["agent", "logout", "--agent-session", AGENT_SESSION_ID, "--yes", "--json"]],
    ];
    for (const [id, argv] of successMatrix) {
      const result = await invokeInstalled(installedEntrypoint, argv, env, sandbox);
      const sessionState = await installedSessionPairState(user);
      assert.equal(result.code, 0, `installed success matrix failed for ${id}: ${safeErrorCode(result.stderr)}; ${sessionState.diagnostic}`);
      assert.equal(sessionState.valid, true, `installed AgentSession command damaged the encrypted session pair for ${id}: ${sessionState.diagnostic}`);
    }
    });

    await runPhase(receipt, "installed-stale-supervisor-evidence-negative", installedE2ePhaseTimeout("installed-stale-supervisor-evidence-negative"), async () => {
      const staleEvidence = await invokeInstalledForeground(
        ["connect", AGENT_SESSION_ID],
        env,
        sandbox,
        { authorityScenario: "stale-supervisor-evidence" },
      );
      assert.equal(staleEvidence.code, 4, staleEvidence.stderr);
      assert.match(staleEvidence.stderr, /cuna\.runtime\.remote_state_unproven/u);
      assert.equal(Object.hasOwn(staleEvidence.receipt, "child_pid"), false, "stale supervisor evidence reached terminal child creation");
      assert.equal(staleEvidence.receipt.events.includes("host:acquire"), false, "stale supervisor evidence reached terminal ownership");
      assert.equal(staleEvidence.receipt.events.some((event) => event.startsWith("child:spawn") || event.startsWith("wire:")), false, "stale supervisor evidence opened terminal transport");
    });

    await runPhase(receipt, "installed-explicit-foreground-command-matrix", installedE2ePhaseTimeout("installed-explicit-foreground-command-matrix"), async () => {
    for (const [id, argv] of [
      ["connect", ["connect", AGENT_SESSION_ID]],
      ["agent-sessions.attach", ["agent-sessions", "attach", AGENT_SESSION_ID]],
      ["claude", ["claude", "--agent-session", CLAUDE_SESSION_ID]],
      ["codex", ["codex", "--agent-session", AGENT_SESSION_ID]],
      ["openclaw", ["openclaw", "--agent-session", OPENCLAW_SESSION_ID]],
    ]) {
      const result = await invokeInstalledForeground(argv, env, sandbox);
      assert.equal(result.code, 0, `installed foreground matrix failed for ${id}: ${safeErrorCode(result.stderr)} ${result.stderr.slice(0, 500)}`);
      assert.equal(result.receipt.child_closed, true, `${id} left its transport child open`);
      assert.equal(result.receipt.input_listener_removed, true, `${id} leaked an input listener`);
      assert.equal(result.receipt.resize_listener_removed, true, `${id} leaked a resize listener`);
      assert.equal(result.receipt.events.includes("child:ready"), true);
      assert.equal(result.receipt.events.includes("wire:close"), true);
      assert.equal(result.receipt.events.includes("host:restore"), true);
      assert.equal(result.receipt.child_exit_code, 0);
      assert.throws(() => process.kill(result.receipt.child_pid, 0), { code: "ESRCH" });
    }
    });

    await runPhase(receipt, "installed-opencode-mutable-witness-gate", installedE2ePhaseTimeout("installed-opencode-mutable-witness-gate"), async () => {
      for (const [id, argv] of [
        ["login-required", ["opencode", "--agent-session", OPENCODE_SESSION_ID]],
        ["404", ["opencode", "--agent-session", OPENCODE_AUTH_MISSING_SESSION_ID]],
        ["semantic-invalid", ["opencode", "--agent-session", OPENCODE_AUTH_INVALID_SESSION_ID]],
        ["configured", ["opencode", "--agent-session", OPENCODE_AUTH_CONFIGURED_SESSION_ID]],
        ["automatic", ["opencode", ".", "--new-session"]],
      ]) {
        const result = await invokeInstalledForeground(
          argv,
          { ...env, CUNA_OPENCODE_ENABLED: "true" },
          sandbox,
        );
        assert.equal(result.code, 4, `OpenCode ${id} must fail closed on a mutable producer witness: ${result.stderr}`);
        assert.match(result.stderr, /cuna\.feature\.opencode_disabled/u);
        assert.match(result.stderr, /immutable_contract_witness_required/u);
        assert.deepEqual(result.receipt.automatic, { phases: [] });
        assert.equal(Object.hasOwn(result.receipt, "child_pid"), false, `OpenCode ${id} reached terminal child creation`);
        assert.equal(result.receipt.events.includes("host:acquire"), false, `OpenCode ${id} reached terminal ownership`);
        assert.equal(result.receipt.events.some((event) => event.startsWith("child:spawn") || event.startsWith("wire:")), false, `OpenCode ${id} opened terminal transport`);
      }
      assert.equal(authority.state.openCodeSessionRequests, 0, "mutable OpenCode witness reached any AgentSession read");
      assert.equal(authority.state.openCodeAgentAuth404Requests, 0, "mutable OpenCode witness reached 404 auth evidence");
      assert.equal(authority.state.openCodeAgentAuthInvalidEvidenceRequests, 0, "mutable OpenCode witness reached invalid auth evidence");
      assert.equal(authority.state.openCodeAgentAuthConfiguredRequests, 0, "mutable OpenCode witness reached configured auth evidence");
    });

    await runPhase(receipt, "installed-automatic-foreground-command-matrix", installedE2ePhaseTimeout("installed-automatic-foreground-command-matrix"), async () => {
    for (const [command, expectedAgent, expectedSessionId] of [["claude", "claude-code", CLAUDE_SESSION_ID], ["codex", "codex", AGENT_SESSION_ID], ["openclaw", "openclaw", OPENCLAW_SESSION_ID]]) {
      const result = await invokeInstalledForeground(
        [command, ".", "--new-session"],
        env,
        sandbox,
      );
      assert.equal(result.code, 0, `installed automatic journey failed for ${command}: ${safeErrorCode(result.stderr)} ${result.stderr.slice(0, 500)}`);
      assert.equal(result.receipt.automatic.agent, expectedAgent);
      assert.deepEqual(result.receipt.automatic.attached, { id: expectedSessionId, agent: expectedAgent });
      assert.equal(result.receipt.automatic.phases[0], "inspect-workspace");
      assert.equal(result.receipt.automatic.phases.at(-1), "attach");
      assert.equal(result.receipt.child_closed, true);
      assert.equal(result.receipt.events.includes("child:ready"), true);
      assert.equal(result.receipt.child_exit_code, 0);
    }
    });

    await runPhase(receipt, "installed-session-api-key-and-logout", installedE2ePhaseTimeout("installed-session-api-key-and-logout"), async () => {
    for (const [id, argv] of [
      ["agent-sessions.terminate", ["agent-sessions", "terminate", AGENT_SESSION_ID, "--yes", "--json"]],
      ["machines.delete", ["machines", "delete", ID, "--yes", "--json"]],
    ]) {
      const result = await invokeInstalled(installedEntrypoint, argv, env, sandbox);
      assert.equal(result.code, 0, `installed cleanup mutation failed for ${id}: ${safeErrorCode(result.stderr)}`);
    }
    await authority.assertLoginCodeNegatives(baseUrl);

    const sessionFiles = await findSessionFiles(path.join(user, "appdata"));
    assert.equal(sessionFiles.length, 2, "encrypted session must use separate key and ciphertext files");
    const sessionFile = sessionFiles.find((file) => file.endsWith(".json"));
    const keyFile = sessionFiles.find((file) => file.endsWith(".key"));
    assert.ok(sessionFile && keyFile);
    const originalSession = await readFile(sessionFile);
    assert.equal(originalSession.includes(Buffer.from(LOGIN_CODE_2)), false, "login code must not persist in plaintext");
    if (process.platform !== "win32") {
      assert.equal((await stat(sessionFile)).mode & 0o077, 0);
      assert.equal((await stat(keyFile)).mode & 0o077, 0);
    }
    await writeFile(sessionFile, "{\"corrupt\":true}\n");
    const corrupt = await invokeInstalled(installedEntrypoint, ["whoami", "--json"], env, sandbox);
    assert.equal(corrupt.code, 3);
    await writeFile(sessionFile, originalSession);
    const recovered = await invokeInstalled(installedEntrypoint, ["whoami", "--json"], env, sandbox);
    assert.equal(recovered.code, 0);

    const created = await invokeInstalled(installedEntrypoint, [
      "api-keys", "create", "--name", "installed e2e", "--yes", "--json",
    ], env, sandbox);
    assert.equal(created.code, 0, "installed API-key create failed");
    const createdRecord = JSON.parse(created.stdout);
    assert.equal(createdRecord.data.id, API_KEY_ID);
    assert.equal(created.stdout.split(createdRecord.data.key).length - 1, 1);
    assert.equal(created.stderr.includes(createdRecord.data.key), false);
    const listed = await invokeInstalled(installedEntrypoint, ["api-keys", "list", "--json"], env, sandbox);
    assert.equal(listed.code, 0, "installed API-key list failed");
    assert.equal(JSON.parse(listed.stdout).data.items[0].id, API_KEY_ID);
    const revoked = await invokeInstalled(installedEntrypoint, [
      "api-keys", "revoke", API_KEY_ID, "--yes", "--json",
    ], env, sandbox);
    assert.equal(revoked.code, 0, "installed API-key revoke failed");
    assert.equal(JSON.parse(revoked.stdout).data.revoked, true);
    assert.equal((await invokeInstalled(installedEntrypoint, ["logout", "--json"], env, sandbox)).code, 0);
    for (const file of sessionFiles) await assert.rejects(stat(file), (error) => error?.code === "ENOENT");

    const afterLogout = await invokeInstalled(installedEntrypoint, ["whoami", "--json"], env, sandbox);
    assert.notEqual(afterLogout.code, 0);
    assert.equal(JSON.parse(afterLogout.stderr).error.code, "cuna.auth.required");
    assert.equal(authority.state.createdApiKeys, 1);
    assert.equal(authority.state.revokedApiKeys, 1);
    assert.equal(authority.state.logoutReceipts, 2);
    assert.equal(authority.state.continuationPollRequests, 0, "installed CLI must never fetch continuation status after paste-code onboarding");
    assert.equal(authority.state.legacyContinuationRequests, 0, "installed CLI must never call a retired continuation cancellation route");
    assert.equal(authority.state.retiredCodeRenewalRequests, 0, "installed CLI must never call the retired code-renewal route");
    assert.equal(authority.state.openCodeSessionRequests, 0, "mutable OpenCode witness made an AgentSession request");
    assert.equal(authority.state.openCodeAgentAuth404Requests, 0, "mutable OpenCode witness made a 404 auth request");
    assert.equal(authority.state.openCodeAgentAuthInvalidEvidenceRequests, 0, "mutable OpenCode witness made an invalid auth request");
    assert.equal(authority.state.openCodeAgentAuthConfiguredRequests, 0, "mutable OpenCode witness made a configured auth request");
    assert.equal(authority.state.machineDeleted, true, "machine sandbox cleanup was not verified");
    assert.equal(authority.state.agentTerminated, true, "AgentSession sandbox cleanup was not verified");
    });
  } catch (error) {
    primaryFailure = error;
    receipt.fail(error);
    throw error;
  } finally {
    if (serverListening || server.listening) {
      try {
        await runPhase(receipt, "contract-server-teardown", installedE2ePhaseTimeout("contract-server-teardown"), () => closeServerBounded(server));
      } catch (error) {
        cleanupFailure = error;
      }
    }
    try {
      await runPhase(receipt, "sandbox-cleanup", installedE2ePhaseTimeout("sandbox-cleanup"), () => rm(sandbox, { recursive: true, force: true }));
    } catch (error) {
      cleanupFailure ??= error;
    }
    try {
      await publisher.publish(receipt);
    } catch (error) {
      cleanupFailure ??= error;
    }
    t.signal?.removeEventListener("abort", abortOnTestCancellation);
    if (primaryFailure !== undefined || cleanupFailure !== undefined) {
      t.diagnostic(`installed E2E receipt: ${JSON.stringify(receipt.snapshot())}`);
    }
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
});

const INSTALLED_HELP_TOPICS = Object.freeze([
  "signup", "login", "logout", "whoami", "access", "capabilities",
  "machines", "machines list", "machines create", "machines start", "machines pause",
  "machines resume", "machines stop", "machines delete", "records", "authorizations",
  "account", "workspace", "usage", "api-keys", "api-keys create", "api-keys list",
  "api-keys revoke", "agent-sessions", "agent-sessions list", "agent-sessions get",
  "agent-sessions create", "agent-sessions rename", "agent-sessions terminate",
  "agent-sessions attach", "agent", "connect", "config", "doctor", "self-test",
  "version", "claude", "codex", "openclaw", "opencode",
]);

const SUPPORTED_SUCCESS_TOPICS = Object.freeze([
  "signup", "login", "logout", "whoami", "access", "capabilities",
  "machines list", "machines create", "machines start", "machines pause", "machines resume", "machines stop", "machines delete",
  "records", "authorizations", "account", "workspace", "usage",
  "api-keys create", "api-keys list", "api-keys revoke",
  "agent-sessions list", "agent-sessions get", "agent-sessions create", "agent-sessions rename", "agent-sessions terminate", "agent-sessions attach",
  "agent", "connect", "config", "doctor", "self-test", "version", "claude", "codex", "openclaw", "opencode",
]);
const DELIBERATE_UNSUPPORTED_TOPICS = Object.freeze([]);

const INSTALLED_FAILURE_MATRIX = Object.freeze([
  { id: "signup/usage", argv: ["signup", "extra", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "login/usage", argv: ["login", "extra", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "logout/usage", argv: ["logout", "extra", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "whoami/usage", argv: ["whoami", "extra", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "access/usage", argv: ["access", "wrong", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "capabilities/usage", argv: ["capabilities", "--scope", "wrong", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "machines/usage", argv: ["machines", "wrong", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "records/usage", argv: ["records", "wrong", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "authorizations/usage", argv: ["authorizations", "list", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "account/usage", argv: ["account", "wrong", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "workspace/usage", argv: ["workspace", "wrong", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "usage/usage", argv: ["usage", "wrong", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "api-keys/usage", argv: ["api-keys", "wrong", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "agent-sessions/usage", argv: ["agent-sessions", "wrong", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "agent/usage", argv: ["agent", "wrong", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "connect/non-tty", argv: ["connect", ID, "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "config/reserved", argv: ["config", "set", "--json"], exit: 8, code: "cuna.capability.unsupported" },
  { id: "doctor/usage", argv: ["doctor", "extra", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "self-test/usage", argv: ["self-test", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "version/usage", argv: ["version", "extra", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "claude/non-tty", argv: ["claude", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "codex/non-tty", argv: ["codex", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "openclaw/non-tty", argv: ["openclaw", "--json"], exit: 2, code: "cuna.usage.invalid" },
  // A disabled feature is rejected before terminal eligibility, with no
  // automatic attach, credential, remote, or terminal side effect.
  { id: "opencode/feature-off-non-tty", argv: ["opencode", "--json"], exit: 4, code: "cuna.feature.opencode_disabled" },
  { id: "sync/reserved", argv: ["sync", "--json"], exit: 8, code: "cuna.capability.unsupported" },
  { id: "shell/reserved", argv: ["shell", "--json"], exit: 8, code: "cuna.capability.unsupported" },
  { id: "companion/reserved", argv: ["companion", "--json"], exit: 8, code: "cuna.capability.unsupported" },
]);

function createContractAuthority() {
  const continuations = new Map();
  const accessContexts = new Map();
  const state = { continuationCounter: 0, continuationPollRequests: 0, legacyContinuationRequests: 0, retiredCodeRenewalRequests: 0, tokenCounter: 0, createdApiKeys: 0, revokedApiKeys: 0, logoutReceipts: 0, idempotencyKeys: [], loginRevoked: false, machineDeleted: false, machineStatus: "running", agentTerminated: false, agentName: "matrix-agent", apiKeyRevoked: false, openCodeSessionRequests: 0, openCodeAgentAuth404Requests: 0, openCodeAgentAuthInvalidEvidenceRequests: 0, openCodeAgentAuthConfiguredRequests: 0 };
  const machine = (status = state.machineStatus) => ({ id: ID, name: "matrix-machine", status, memory_mib: 512, vcpus: 1, url: "https://machine.invalid" });
  const agentSession = (terminated = state.agentTerminated) => ({ id: AGENT_SESSION_ID, machine_id: ID, workspace_binding_id: WORKSPACE_BINDING_ID, workspace_generation: 1, name: state.agentName, agent: "codex", cwd: "/workspace", auth_mode: "interactive_login", desired_state: terminated ? "terminated" : "running", request_state: terminated ? "terminal" : "launched", process_state: terminated ? "terminated" : "running", process_epoch: PROCESS_EPOCH, runtime_observed_at: "2026-08-14T00:00:01.000Z", runtime_expires_at: "2030-08-14T00:00:01.000Z", row_version: terminated ? 1 : 0, created_at: "2026-08-14T00:00:00.000Z", updated_at: "2026-08-14T00:00:00.000Z" });
  const foregroundAgentSession = (id) => {
    const observationTime = Date.now();
    return {
      ...agentSession(false),
      id,
      agent: id === CLAUDE_SESSION_ID ? "claude-code" : id === OPENCLAW_SESSION_ID ? "openclaw" : [OPENCODE_SESSION_ID, OPENCODE_AUTH_MISSING_SESSION_ID, OPENCODE_AUTH_INVALID_SESSION_ID, OPENCODE_AUTH_CONFIGURED_SESSION_ID].includes(id) ? "opencode" : "codex",
      runtime_observed_at: new Date(observationTime - 100).toISOString(),
      runtime_expires_at: new Date(observationTime + 10_000).toISOString(),
    };
  };
  const waitlisted = () => ({
    required_terms_version: "2026-08",
    identity: "active",
    admission: "waitlisted",
    workspace: { state: "unavailable" },
    waitlist_position: 7,
  });
  const admitted = () => ({
    required_terms_version: "2026-08",
    identity: "active",
    admission: "admitted",
    workspace: { state: "assigned", id: WORKSPACE_ID },
  });
  const issueTokens = (context, loginCodeExpiresAt) => {
    state.tokenCounter += 1;
    const access = `runa_at_${String(state.tokenCounter).padStart(43, "a")}`;
    const now = Date.now();
    accessContexts.set(access, context);
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: 600,
      access_expires_at: new Date(now + 600_000).toISOString(),
      login_code_expires_at: loginCodeExpiresAt,
      session_id: SESSION_ID,
      context,
    };
  };
  return {
    state,
    async assertLoginCodeNegatives(baseUrl) {
      const [id, record] = [...continuations.entries()].at(-1);
      assert.ok(id && record);
      const exchangeUrl = `${baseUrl}/v1/cli-auth/continuations/${id}/exchange`;
      const exactBody = (loginCode, codeVerifier = record.verifier) => ({
        login_code: loginCode, client_instance_id: record.clientInstanceId, profile: record.profile,
        state: record.state, code_verifier: codeVerifier, redirect_uri: record.redirectUri,
      });
      const wrong = await fetch(exchangeUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(exactBody(`cuna_login_${"z".repeat(43)}`)),
      });
      assert.equal(wrong.status, 401, "wrong durable login code must fail");
      const expired = await fetch(exchangeUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(exactBody(EXPIRED_LOGIN_CODE)),
      });
      assert.equal(expired.status, 401, "expired durable login code must fail");
      const reusable = await fetch(exchangeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(exactBody(record.loginCode)),
      });
      assert.equal(reusable.status, 200, `durable login code must remain reusable until revoke/expiry: ${await reusable.clone().text()}`);
      assert.equal((await reusable.json()).login_code_expires_at, record.loginCodeExpiresAt, "reuse must return the same authoritative durable-code expiry");

      const verifier = "v".repeat(64);
      const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
      const issued = await fetch(`${baseUrl}/v1/cli-auth/continuations`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "s".repeat(43), code_challenge: challenge, redirect_uri: "http://127.0.0.1:54321/callback", client_instance_id: ID, profile: "installed-e2e", intent_class: "login" }),
      }).then((response) => response.json());
      const wrongVerifier = await fetch(`${baseUrl}/v1/cli-auth/continuations/${issued.id}/exchange`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ login_code: LOGIN_CODE_2, client_instance_id: ID, profile: "installed-e2e", state: "s".repeat(43), code_verifier: "w".repeat(64), redirect_uri: "http://127.0.0.1:54321/callback" }),
      });
      assert.equal(wrongVerifier.status, 401, "wrong PKCE verifier must fail without consuming success authority");
      const browserCancel = await fetch(`${baseUrl}/v1/cli-auth/continuations/${issued.id}/browser-cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer browser-user-jwt" },
        body: JSON.stringify({ browser_nonce: `cuna_cb_${"n".repeat(43)}`, state: "s".repeat(43) }),
      });
      assert.equal(browserCancel.status, 200, "browser cancellation must be JWT- and cuna_cb_-bound, never continuation-secret-bound");
    },
    async handle(request, response) {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const body = await readJsonBody(request);
        const send = (status, value) => {
          const text = JSON.stringify(value);
          response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
          response.end(text);
        };
        if (request.method === "GET" && url.pathname === "/v1/cli-auth/bootstrap") {
          return send(200, { enabled: true, completion_mode: "paste_login_code", pkce_method: "S256", continuation_ttl_seconds: 600, access_token_ttl_seconds: 600, browser_origin: "https://app.getcuna.com" });
        }
        if (request.method === "GET" && url.pathname === "/v1/cli-auth/signup-capability") {
          return send(200, { enabled: true, enrollment: "waitlist_only", identity_methods: ["email_password", "oauth"] });
        }
        if (request.method === "POST" && url.pathname === "/v1/cli-auth/continuations") {
          state.continuationCounter += 1;
          const id = ID.slice(0, -1) + String(state.continuationCounter);
          const expiresAt = new Date(Date.now() + 600_000).toISOString();
          const context = body.intent_class === "signup" ? waitlisted() : admitted();
          const loginCode = state.continuationCounter === 1 ? LOGIN_CODE : LOGIN_CODE_2;
          continuations.set(id, { state: body.state, challenge: body.code_challenge, redirectUri: body.redirect_uri, clientInstanceId: body.client_instance_id, profile: body.profile, expiresAt, loginCodeExpiresAt: new Date(Date.now() + 2_592_000_000).toISOString(), context, loginCode, exchangeCount: 0 });
          return send(201, { id, browser_url: `https://app.getcuna.com/cli/continue#continuation=${id}&nonce=cuna_cb_${"n".repeat(43)}&state=${body.state}`, expires_at: expiresAt, completion_mode: "paste_login_code" });
        }
        const legacyStatus = /^\/v1\/cli-auth\/continuations\/[^/]+$/u.test(url.pathname);
        if (request.method === "GET" && legacyStatus) {
          state.continuationPollRequests += 1;
          throw new Error("legacy continuation status polling is forbidden by the installed fixture");
        }
        const legacyCancel = /^\/v1\/cli-auth\/continuations\/[^/]+\/cancel$/u.test(url.pathname);
        if (request.method === "POST" && legacyCancel) {
          state.legacyContinuationRequests += 1;
          throw new Error("legacy continuation cancellation is forbidden by the installed fixture");
        }
        const retiredCodeRenewalPath = ["/v1/cli-auth", "refresh"].join("/");
        if (url.pathname === retiredCodeRenewalPath) {
          state.retiredCodeRenewalRequests += 1;
          throw new Error("retired CLI code-renewal route is forbidden by the installed fixture");
        }
        const browserCancel = /^\/v1\/cli-auth\/continuations\/([^/]+)\/browser-cancel$/u.exec(url.pathname);
        if (request.method === "POST" && browserCancel !== null) {
          const record = continuations.get(browserCancel[1]);
          if (record === undefined) return send(404, { error: "not_found" });
          if (request.headers.authorization !== "Bearer browser-user-jwt" ||
              request.headers["x-cuna-continuation"] !== undefined ||
              request.headers["x-runa-continuation"] !== undefined ||
              body.browser_nonce !== `cuna_cb_${"n".repeat(43)}` || body.state !== record.state) {
            return send(401, { error: "browser_callback_proof_rejected" });
          }
          return send(200, { id: browserCancel[1], phase: "cancelled", expires_at: record.expiresAt, required_terms_version: "2026-08" });
        }
        const continuation = /^\/v1\/cli-auth\/continuations\/([^/]+)(\/exchange)?$/u.exec(url.pathname);
        if (continuation !== null) {
          const record = continuations.get(continuation[1]);
          if (record === undefined) return send(404, { error: "not_found" });
          if (request.method === "POST" && continuation[2] === "/exchange") {
            if (body.login_code === EXPIRED_LOGIN_CODE) return send(401, { error: "cli_login_code_expired" });
            if (record.exchangeCount > 0 && state.loginRevoked) return send(401, { error: "cli_auth_rejected" });
            assert.equal(request.headers["idempotency-key"], undefined, "strict login-code re-exchange has no retired renewal idempotency header");
            if (body.state !== record.state || body.redirect_uri !== record.redirectUri || body.client_instance_id !== record.clientInstanceId || body.profile !== record.profile ||
                !/^[A-Za-z0-9_-]{43,128}$/u.test(body.code_verifier) ||
                createHash("sha256").update(body.code_verifier, "ascii").digest("base64url") !== record.challenge ||
                body.login_code !== record.loginCode) return send(401, { error: "login_code_binding_rejected" });
            record.verifier = body.code_verifier;
            state.loginRevoked = false;
            record.exchangeCount += 1;
            return send(200, issueTokens(record.context, record.loginCodeExpiresAt));
          }
        }
        const authorization = request.headers.authorization?.replace(/^Bearer /u, "");
        if (request.method === "GET" && url.pathname === "/v1/cli-auth/context") return send(200, accessContexts.get(authorization));
        if (request.method === "POST" && url.pathname === "/v1/cli-auth/logout") { state.logoutReceipts += 1; state.loginRevoked = true; return send(200, { revoked: true }); }
        if (request.method === "GET" && url.pathname === "/v1/capabilities") {
          const now = Date.now();
          const scope = url.searchParams.get("scope") ?? "account";
          const resourceId = url.searchParams.get("resource_id");
          return send(200, { schema_version: "1.0", subject_scope: scope, ...(resourceId === null ? {} : { subject_id: resourceId }), observed_at: new Date(now - 100).toISOString(), expires_at: new Date(now + 30_000).toISOString(), etag: "installed-e2e", capabilities: [
            { id: "api_keys.manage", availability: "supported", interaction: "native", mutation_class: "secret_revealing", surfaces: ["cli"], required_permissions: ["api_keys:manage", "auth:interactive"] },
            { id: "records.list", availability: "supported", interaction: "read_only", mutation_class: "none", surfaces: ["cli"], required_permissions: ["records:read"] },
            { id: "authorizations.list", availability: "supported", interaction: "read_only", mutation_class: "none", surfaces: ["cli"], required_permissions: ["authorizations:read"] },
            { id: "machines.create", availability: "supported", interaction: "native", mutation_class: "reversible", surfaces: ["cli"], required_permissions: ["machines:write"] },
            { id: "machines.lifecycle", availability: "supported", interaction: "native", mutation_class: "reversible", surfaces: ["cli"], required_permissions: ["machines:write"] },
            { id: "machines.delete", availability: "supported", interaction: "native", mutation_class: "destructive", surfaces: ["cli"], required_permissions: ["machines:write"] },
            { id: "agent_sessions.create", availability: "supported", interaction: "native", mutation_class: "reversible", surfaces: ["cli"], required_permissions: ["agent_sessions:write"] },
            { id: "agent_sessions.terminate", availability: "supported", interaction: "native", mutation_class: "destructive", surfaces: ["cli"], required_permissions: ["agent_sessions:write"] },
            { id: "agent_sessions.rename", availability: "supported", interaction: "native", mutation_class: "reversible", surfaces: ["cli"], required_permissions: ["agent_sessions:write"] },
            { id: "agent_sessions.auth_logout", availability: "supported", interaction: "native", mutation_class: "reversible", surfaces: ["cli"], required_permissions: ["agent_sessions:write"] },
          ] });
        }
        if (request.method === "GET" && url.pathname === "/v1/me") return send(200, { id: ID, email: "installed@example.test", workspace: { assigned: true, id: WORKSPACE_ID, usage: { est_spend_usd: 1, est_remaining_usd: 49, note: "contract fixture" } } });
        if (request.method === "GET" && url.pathname === "/v1/sessions") return send(200, state.machineDeleted ? [] : [machine()]);
        if (request.method === "GET" && url.pathname === `/v1/sessions/${ID}`) return state.machineDeleted ? send(404, { error: "not_found" }) : send(200, machine());
        if (request.method === "POST" && url.pathname === "/v1/sessions") { state.machineDeleted = false; state.machineStatus = "created"; return send(201, machine()); }
        if (request.method === "POST" && url.pathname === `/v1/sessions/${ID}/start`) { state.machineStatus = "running"; return send(200, machine()); }
        if (request.method === "POST" && url.pathname === `/v1/sessions/${ID}/pause`) { state.machineStatus = "paused"; return send(200, machine()); }
        if (request.method === "POST" && url.pathname === `/v1/sessions/${ID}/resume`) { state.machineStatus = "running"; return send(200, machine()); }
        if (request.method === "POST" && url.pathname === `/v1/sessions/${ID}/stop`) { state.machineStatus = "stopped"; return send(200, machine()); }
        if (request.method === "DELETE" && url.pathname === `/v1/sessions/${ID}`) { state.machineDeleted = true; return send(202, { acknowledged: true }); }
        if (request.method === "GET" && url.pathname === "/v1/records") return send(200, []);
        if (request.method === "GET" && url.pathname === `/v1/sessions/${ID}/authorizations`) return send(200, []);
        if (request.method === "POST" && url.pathname === `/v1/sessions/${ID}/agent-sessions`) { state.agentTerminated = false; state.agentName = body.name ?? "matrix-agent"; return send(201, agentSession()); }
        if (request.method === "GET" && url.pathname === `/v1/sessions/${ID}/agent-sessions`) return send(200, { items: state.agentTerminated ? [] : [agentSession()] });
        const foregroundSession = /^\/v1\/agent-sessions\/(5[0123456]000000-0000-4000-8000-000000000005)$/u.exec(url.pathname);
        if (request.method === "GET" && foregroundSession !== null) {
          if ([OPENCODE_SESSION_ID, OPENCODE_AUTH_MISSING_SESSION_ID, OPENCODE_AUTH_INVALID_SESSION_ID, OPENCODE_AUTH_CONFIGURED_SESSION_ID].includes(foregroundSession[1])) {
            state.openCodeSessionRequests += 1;
          }
          return send(200, foregroundSession[1] === AGENT_SESSION_ID ? agentSession(state.agentTerminated) : foregroundAgentSession(foregroundSession[1]));
        }
        if (request.method === "PATCH" && url.pathname === `/v1/agent-sessions/${AGENT_SESSION_ID}`) { state.agentName = body.name; return send(200, { ...agentSession(), row_version: 1 }); }
        if (request.method === "POST" && url.pathname === `/v1/agent-sessions/${AGENT_SESSION_ID}/terminate`) { state.agentTerminated = true; return send(200, agentSession(true)); }
        if (request.method === "POST" && url.pathname === `/v1/agent-sessions/${AGENT_SESSION_ID}/agent-auth/logout`) return send(200, { observation_id: "80000000-0000-4000-8000-000000000008", agent_session_id: AGENT_SESSION_ID, process_epoch: PROCESS_EPOCH, auth_mode: "interactive_login", agent: "codex", agent_version: "1.0.0", adapter_version: "runa.agent-auth.v1", observed_at: "2026-08-14T00:00:02.000Z", outcome: "logout_confirmed" });
        if (request.method === "GET" && url.pathname === `/v1/agent-sessions/${AGENT_SESSION_ID}/agent-auth`) return send(200, { observation_id: "81000000-0000-4000-8000-000000000008", agent_session_id: AGENT_SESSION_ID, process_epoch: PROCESS_EPOCH, auth_mode: "interactive_login", agent_version: "1.0.0", adapter_version: "runa.agent-auth.v1", evidence_class: "provider_cli_login_status", observed_at: "2026-08-14T00:00:02.000Z", valid_until: "2026-08-14T00:00:32.000Z", state: "login_required" });
        if (request.method === "GET" && url.pathname === `/v1/agent-sessions/${OPENCODE_SESSION_ID}/agent-auth`) {
          const observationTime = Date.now();
          const observedAt = new Date(observationTime - 100).toISOString();
          const validUntil = new Date(observationTime + 10_000).toISOString();
          return send(200, { observation_id: "82000000-0000-4000-8000-000000000008", agent_session_id: OPENCODE_SESSION_ID, process_epoch: PROCESS_EPOCH, auth_mode: "interactive_login", agent_version: "1.18.18", adapter_version: "runa.agent-auth.v1", evidence_class: "provider_cli_credential_presence", observed_at: observedAt, valid_until: validUntil, state: "login_required" });
        }
        if (request.method === "GET" && url.pathname === `/v1/agent-sessions/${OPENCODE_AUTH_MISSING_SESSION_ID}/agent-auth`) {
          state.openCodeAgentAuth404Requests += 1;
          return send(404, { error: "not_found" });
        }
        if (request.method === "GET" && url.pathname === `/v1/agent-sessions/${OPENCODE_AUTH_INVALID_SESSION_ID}/agent-auth`) {
          state.openCodeAgentAuthInvalidEvidenceRequests += 1;
          const observationTime = Date.now();
          const observedAt = new Date(observationTime - 100).toISOString();
          const validUntil = new Date(observationTime + 10_000).toISOString();
          return send(200, { observation_id: "83000000-0000-4000-8000-000000000008", agent_session_id: OPENCODE_AUTH_INVALID_SESSION_ID, process_epoch: PROCESS_EPOCH, auth_mode: "interactive_login", agent_version: "1.18.18", adapter_version: "runa.agent-auth.v1", evidence_class: "provider_cli_login_status", observed_at: observedAt, valid_until: validUntil, state: "authenticated" });
        }
        if (request.method === "GET" && url.pathname === `/v1/agent-sessions/${OPENCODE_AUTH_CONFIGURED_SESSION_ID}/agent-auth`) {
          state.openCodeAgentAuthConfiguredRequests += 1;
          const observationTime = Date.now();
          const observedAt = new Date(observationTime - 100).toISOString();
          const validUntil = new Date(observationTime + 10_000).toISOString();
          return send(200, { observation_id: "84000000-0000-4000-8000-000000000008", agent_session_id: OPENCODE_AUTH_CONFIGURED_SESSION_ID, process_epoch: PROCESS_EPOCH, auth_mode: "interactive_login", agent_version: "1.18.18", adapter_version: "runa.agent-auth.v1", evidence_class: "provider_cli_credential_presence", observed_at: observedAt, valid_until: validUntil, state: "configured" });
        }
        if (request.method === "POST" && url.pathname === "/v1/api-keys") {
          assert.match(request.headers["idempotency-key"] ?? "", /^cuna-api-key-create-[0-9a-f-]{36}$/u);
          state.idempotencyKeys.push(request.headers["idempotency-key"]);
          state.createdApiKeys += 1;
          return send(201, { id: API_KEY_ID, name: body.name, prefix: "cuna_sk_", last_four: "WXYZ", created_at: new Date().toISOString(), expires_at: null, last_used_at: null, revoked_at: null, idempotency_replayed: false, key: `cuna_sk_${"k".repeat(16)}WXYZ` });
        }
        if (request.method === "GET" && url.pathname === "/v1/api-keys") {
          return send(200, [{ id: API_KEY_ID, name: "installed e2e", prefix: "cuna_sk_", last_four: "WXYZ", created_at: new Date().toISOString(), expires_at: null, last_used_at: null, revoked_at: state.apiKeyRevoked ? new Date().toISOString() : null }]);
        }
        if (request.method === "DELETE" && url.pathname === `/v1/api-keys/${API_KEY_ID}`) { state.revokedApiKeys += 1; state.apiKeyRevoked = true; return send(200, { ok: true }); }
        return send(404, { error: "unexpected_route" });
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "fixture_failure", message: error instanceof Error ? error.message : "unknown" }));
      }
    },
  };
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function invokeInstalledAuth(args, env, cwd, loginCode) {
  return runNode([path.join(root, "test", "fixtures", "installed-auth-driver.mjs"), ...args], {
    env: { ...env, CUNA_TEST_LOGIN_CODE: loginCode }, cwd, timeout: INSTALLED_AUTH_DRIVER_TIMEOUT_MS,
  });
}

async function invokeInstalledRuntime(args, env, cwd, options = {}) {
  const receiptPath = path.join(cwd, `runtime-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  try {
    const result = await runNode([path.join(root, "test", "fixtures", "installed-runtime-driver.mjs"), ...args], {
      env: {
        ...env,
        CUNA_TEST_RUNTIME_RECEIPT: receiptPath,
        ...(options.sessionTrace ? { CUNA_TEST_SESSION_TRACE: "true" } : {}),
      },
      cwd,
      timeout: 30_000,
    });
    return { ...result, receipt: await readRuntimeReceipt(receiptPath) };
  } catch (error) {
    const receipt = await readRuntimeReceipt(receiptPath);
    const detail = receipt === undefined ? "runtime receipt unavailable" : JSON.stringify(receipt);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; ${detail}`, { cause: error });
  } finally {
    await preserveRuntimeTraceForDiagnosis(receiptPath);
  }
}

/**
 * The normal E2E receipt intentionally omits command output.  During an
 * explicitly requested local diagnosis, preserve only the runtime driver's
 * secret-free method/timing receipt outside the sandbox before cleanup removes
 * it.  This is opt-in test evidence, never a package or release artifact.
 */
async function preserveRuntimeTraceForDiagnosis(receiptPath) {
  const directory = process.env.CUNA_E2E_RUNTIME_TRACE_DIRECTORY;
  if (directory === undefined || directory.length === 0) return;
  const receipt = await readRuntimeReceipt(receiptPath);
  if (receipt === undefined) return;
  await mkdir(path.resolve(directory), { recursive: true });
  const destination = path.join(
    path.resolve(directory),
    `runtime-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  await writeFile(destination, `${JSON.stringify(receipt)}\n`, "utf8");
}

async function readRuntimeReceipt(receiptPath) {
  try {
    const record = JSON.parse(await readFile(receiptPath, "utf8"));
    if (record?.schema_version !== 1 || record?.kind !== "installed_runtime_driver") return undefined;
    return record;
  } catch {
    return undefined;
  }
}

async function invokeInstalledForeground(args, env, cwd, options = {}) {
  const receiptPath = path.join(cwd, `foreground-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const explicitAgentSessionIndex = args.indexOf("--agent-session");
  const explicitAgentSessionId = explicitAgentSessionIndex === -1 ? undefined : args[explicitAgentSessionIndex + 1];
  const requestedAgentSessionId = explicitAgentSessionId ??
    (args.includes(CLAUDE_SESSION_ID) || args[0] === "claude" ? CLAUDE_SESSION_ID :
      args.includes(OPENCLAW_SESSION_ID) || args[0] === "openclaw" ? OPENCLAW_SESSION_ID :
        args.includes(OPENCODE_SESSION_ID) || args[0] === "opencode" ? OPENCODE_SESSION_ID : AGENT_SESSION_ID);
  const authorityScenario = options.authorityScenario === undefined
    ? {}
    : { CUNA_TEST_FOREGROUND_AUTHORITY_SCENARIO: options.authorityScenario };
  const result = await runNode([path.join(root, "test", "fixtures", "installed-foreground-driver.mjs"), ...args], {
    env: { ...env, ...authorityScenario, CUNA_TEST_FOREGROUND_RECEIPT: receiptPath, CUNA_TEST_AGENT_SESSION_ID: requestedAgentSessionId }, cwd, timeout: 30_000,
  });
  return { ...result, receipt: JSON.parse(await readFile(receiptPath, "utf8")) };
}

async function runBoundedConcurrent(entries, concurrency, operation, label = (entry) => String(entry)) {
  assert.ok(Number.isInteger(concurrency) && concurrency > 0, "installed E2E concurrency must be a positive integer");
  const failures = [];
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const entry = entries[next++];
      try {
        await operation(entry);
      } catch (error) {
        failures.push({ label: label(entry), error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  if (failures.length !== 0) {
    const first = failures[0];
    const message = first.error instanceof Error ? first.error.message : "non_error_failure";
    throw new Error(`Installed E2E concurrent matrix failed for ${first.label}: ${message}`);
  }
}

async function findSessionFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await findSessionFiles(file));
    else if (/^session-[0-9a-f]{32}\.(?:json|key)$/u.test(entry.name)) result.push(file);
  }
  return result.sort();
}

async function installedSessionPairState(userDirectory) {
  const files = await findSessionFiles(path.join(userDirectory, "appdata"));
  const session = files.filter((file) => file.endsWith(".json"));
  const key = files.filter((file) => file.endsWith(".key"));
  const valid = files.length === 2 && session.length === 1 && key.length === 1;
  // The receipt must remain secret-free: names are predictable product paths,
  // but the assertion carries counts and extensions only, never a profile,
  // sandbox path, ciphertext, key, or login code.
  return Object.freeze({
    valid,
    diagnostic: `encrypted_session_pair files=${files.length} json=${session.length} key=${key.length}`,
  });
}

function invokeInstalled(entrypoint, args, env, cwd, terminalStderr = false, input) {
  const preload = terminalStderr
    ? ["--import", `data:text/javascript;base64,${Buffer.from('for(const stream of [process.stdin,process.stdout,process.stderr])Object.defineProperty(stream,"isTTY",{configurable:true,value:true});').toString("base64")}`]
    : [];
  return runNode([...preload, entrypoint, ...args], { env, cwd, timeout: INSTALLED_COMMAND_TIMEOUT_MS, input });
}

function safeErrorCode(stderr) {
  const line = stderr.split(/\r?\n/u).at(-1);
  try {
    const error = JSON.parse(line).error;
    return `${error?.code ?? "unknown"}:${error?.details?.reason ?? error?.message ?? "unknown"}`;
  } catch { return "non-json"; }
}

function installedCommandFailure(id, stderr, sessionDiagnostic) {
  const error = new Error(`installed success matrix failed for ${id}: ${safeErrorCode(stderr)}; ${sessionDiagnostic}`);
  const safeCode = safeStructuredErrorCode(stderr);
  if (safeCode !== undefined) Object.defineProperty(error, "code", { value: safeCode });
  return error;
}

function safeStructuredErrorCode(stderr) {
  const line = stderr.split(/\r?\n/u).at(-1);
  try {
    const record = JSON.parse(line)?.error;
    if (typeof record?.code !== "string" || !/^cuna\.[a-z0-9_.-]{1,100}$/u.test(record.code)) return undefined;
    const reason = typeof record.details?.reason === "string" && /^[a-z0-9_.-]{1,100}$/u.test(record.details.reason)
      ? record.details.reason
      : undefined;
    return reason === undefined ? record.code : `${record.code}:${reason}`;
  } catch {
    return undefined;
  }
}

function runNode(args, options) {
  return run(process.execPath, args, options);
}

async function runNpm(args, options) {
  const npmCommand = process.platform === "win32" ? "where.exe" : "which";
  const located = await run(npmCommand, [process.platform === "win32" ? "npm.cmd" : "npm"], { cwd: options.cwd, timeout: 10_000 });
  const npm = located.stdout.split(/\r?\n/u).map((value) => value.trim()).find(Boolean);
  assert.ok(npm);
  const npmCli = path.join(path.dirname(npm), "node_modules", "npm", "bin", "npm-cli.js");
  return run(process.execPath, [npmCli, ...args], options);
}

function run(command, args, { cwd, env = process.env, timeout, input }) {
  const scope = installedE2eExecutionScope.getStore();
  if (scope?.abortError !== undefined) {
    return Promise.reject(scope.abortError);
  }
  const id = ++installedE2eChildSequence;
  const label = installedE2eChildLabel(command, args);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (input !== undefined) child.stdin.end(input);
    const receiptChild = scope?.receipt.childStarted({
      // Keep the public child number consistent with the active invocation
      // number without ever storing argv, output, paths, or credentials.
      id,
      phase: scope.name,
      label,
      resourceLabels: activeResourceLabels(),
    });
    let stdout = "";
    let stderr = "";
    const startedAt = Date.now();
    let timedOut = false;
    let settled = false;
    let timer;
    let forcedTeardown;
    let terminationReason;
    let termination;
    let resolveSettled;
    const settledPromise = new Promise((resolve) => { resolveSettled = resolve; });
    const finish = (outcome, value) => {
      if (settled) return;
      settled = true;
      activeInstalledE2eInvocations.delete(id);
      if (timer !== undefined) clearTimeout(timer);
      if (forcedTeardown !== undefined) clearTimeout(forcedTeardown);
      scope?.receipt.childFinished(
        receiptChild,
        timedOut ? "terminated" : "exited",
        activeResourceLabels(),
      );
      resolveSettled();
      outcome(value);
    };
    const terminate = (reason) => {
      if (timedOut || settled) return termination ?? Promise.resolve();
      timedOut = true;
      terminationReason = reason;
      scope?.receipt.childTerminationRequested(receiptChild, reason, activeResourceLabels());
      termination = terminateProcessTree(child).catch(() => undefined);
      // A `kill` request is not a teardown guarantee. Bound the wait too, so a
      // stuck descendant leaves an actionable timeout rather than consuming a
      // later phase's budget. The receipt explicitly marks this child as a
      // forced teardown if its close event never arrives.
      forcedTeardown = setTimeout(() => {
        void terminateProcessTree(child).catch(() => undefined).then(() => {
          scope?.receipt.childFinished(receiptChild, "teardown_unconfirmed", activeResourceLabels());
          finish(reject, new Error(`Installed E2E child ${id}:${label} did not close after ${terminationReason ?? `${timeout}ms timeout`} plus ${CLEANUP_TIMEOUT_MS}ms teardown.`));
        });
      }, CLEANUP_TIMEOUT_MS);
      return termination;
    };
    const active = Object.freeze({
      id,
      phaseId: scope?.id,
      label,
      terminate,
      settled: settledPromise,
    });
    activeInstalledE2eInvocations.set(id, active);
    timer = setTimeout(() => terminate(`${timeout}ms timeout`), timeout);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(reject, error));
    child.once("close", (code, signal) => {
      if (timedOut) {
        return finish(reject, new Error(`Installed E2E child ${id}:${label} was terminated after ${terminationReason ?? `${timeout}ms timeout`} (signal ${signal ?? "none"}).`));
      }
      finish(resolve, { code, signal, stdout: stdout.trim(), stderr: stderr.trim(), durationMs: Date.now() - startedAt });
    });
  });
}

function installedE2eChildLabel(command, args) {
  const executable = path.basename(command).replace(/\.exe$/iu, "").toLocaleLowerCase("en-US");
  const basenames = args.map((value) => path.basename(value).toLocaleLowerCase("en-US"));
  const action = (after) => args.slice(after + 1).find((value) => /^[a-z][a-z0-9-]{0,63}$/u.test(value));
  const authDriver = basenames.indexOf("installed-auth-driver.mjs");
  if (authDriver !== -1) return `installed-auth:${action(authDriver) ?? "unknown"}`;
  const foregroundDriver = basenames.indexOf("installed-foreground-driver.mjs");
  if (foregroundDriver !== -1) return `installed-foreground:${action(foregroundDriver) ?? "unknown"}`;
  const npmCli = basenames.indexOf("npm-cli.js");
  if (npmCli !== -1) return `npm:${action(npmCli) ?? "unknown"}`;
  const cunaEntrypoint = basenames.indexOf("cuna.js");
  if (cunaEntrypoint !== -1) return `cuna:${action(cunaEntrypoint) ?? "unknown"}`;
  if (executable === "where" || executable === "which") return "package-manager-resolution";
  return `process:${executable}`;
}

function activeResourceLabels() {
  if (typeof process.getActiveResourcesInfo !== "function") return Object.freeze(["resource_snapshot_unavailable"]);
  const counts = new Map();
  for (const resource of process.getActiveResourcesInfo()) {
    counts.set(resource, (counts.get(resource) ?? 0) + 1);
  }
  return Object.freeze([...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([resource, count]) => `${resource}:${count}`));
}

async function terminateProcessTree(child) {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform !== "win32") {
    try { child.kill("SIGTERM"); } catch {}
    return;
  }
  await new Promise((resolve) => {
    const terminator = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const timer = setTimeout(resolve, 5_000);
    terminator.once("error", () => { clearTimeout(timer); resolve(); });
    terminator.once("close", () => { clearTimeout(timer); resolve(); });
  });
}
