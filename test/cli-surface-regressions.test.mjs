import assert from "node:assert/strict";
import test from "node:test";

import { CunaError, EXIT_CODES, memoryStreams, runCli } from "../dist/index.js";
import { normalizeError, unsupportedError } from "../dist/core/errors.js";
import { credentialFailure } from "../dist/credentials/index.js";
import { runtimeFailure } from "../dist/runtime/errors.js";

const API_KEY = "cuna_sk_abcdefghijklmnop";
const MACHINE_ID = "33333333-3333-4333-8333-333333333333";

const platform = {
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
};

function interactive() {
  return memoryStreams({ stdoutIsTTY: true, stdinIsTTY: true });
}

async function runJson(argv, dependencies = {}) {
  const streams = memoryStreams();
  const exit = await runCli(argv, { streams: streams.streams, platform, ...dependencies });
  const stderr = streams.stderr().trim();
  const stdout = streams.stdout().trim();
  return {
    exit,
    record: JSON.parse((stderr === "" ? stdout : stderr).split("\n").at(-1)),
  };
}

/* -------------------------------------------------------------------------- */
/* Per-command help (R-4) and the option-ordering bug beside it (R-5)          */
/* -------------------------------------------------------------------------- */

test("--help resolves the command it was typed after, not the root help", async () => {
  const cases = [
    { argv: ["machines", "--help"], topic: "machines", must: ["cuna machines <list|create"] },
    { argv: ["machines", "create", "--help"], topic: "machines create", must: ["--name NAME", "--yes", "--vcpus N"] },
    { argv: ["machines", "list", "--help"], topic: "machines list", must: ["cuna machines list"] },
    { argv: ["agent-sessions", "create", "--help"], topic: "agent-sessions create", must: ["--workspace-binding-id", "--workspace-generation"] },
    { argv: ["doctor", "--help"], topic: "doctor", must: ["encrypted local\nsession-store state"] },
    { argv: ["claude", "--help"], topic: "claude", must: ["--agent-session ID", "--no-sync"] },
  ];
  for (const { argv, topic, must } of cases) {
    const { exit, record } = await runJson([...argv, "--json"]);
    assert.equal(exit, EXIT_CODES.success, argv.join(" "));
    assert.equal(record.data.topic, topic, argv.join(" "));
    for (const fragment of must) {
      assert.ok(record.data.help.includes(fragment), `${argv.join(" ")} help must mention ${fragment}`);
    }
  }
});

test("every flag a command requires appears in that command's help", async () => {
  // The failure this prevents: help that has drifted from the option allowlist
  // sends the user to a flag the parser rejects, or omits one it demands.
  const { record } = await runJson(["machines", "create", "--help", "--json"]);
  const help = record.data.help;
  for (const flag of ["--name", "--yes", "--agent", "--vcpus", "--memory-mib", "--background", "--idempotency-key"]) {
    assert.ok(help.includes(flag), `machines create help must document ${flag}`);
  }
});

test("--help is answered beside every global option, not only the allowlisted two", async () => {
  // --json and --no-color happened to be on the root allowlist and worked;
  // --profile, --base-url, --config-file and --timeout-ms were rejected, so
  // asking for help was refused because of the option it was about.
  for (const option of [
    ["--profile", "work"],
    ["--base-url", "https://api.getcuna.com"],
    ["--config-file", "/tmp/cuna.toml"],
    ["--timeout-ms", "500"],
  ]) {
    const { exit, record } = await runJson(["--help", ...option, "--json"]);
    assert.equal(exit, EXIT_CODES.success, option.join(" "));
    assert.ok(record.data.help.includes("Cuna CLI"), option.join(" "));
  }
});

test("doctor is discoverable from the root help", async () => {
  const { record } = await runJson(["--help", "--json"]);
  assert.ok(record.data.help.includes("doctor"), "doctor is the recovery instruction and must be listed");
});

/* -------------------------------------------------------------------------- */
/* The JSON command label (R-12)                                              */
/* -------------------------------------------------------------------------- */

test("the reported command is the command, never an option value", async () => {
  // `argv.find((item) => !item.startsWith("-"))` returned the VALUE of the
  // first global option, so a --config-file path landed in the JSON record.
  const secret = "/home/angel/private/cuna-config.toml";
  const { record } = await runJson(["--config-file", secret, "bogus", "--json"]);
  assert.equal(record.command, "bogus");
  assert.ok(!JSON.stringify(record).includes(secret), "an option value must never reach the output record");
});

/* -------------------------------------------------------------------------- */
/* Base-10 integer options (R-10)                                             */
/* -------------------------------------------------------------------------- */

test("integer options accept only base-10 integers", async () => {
  for (const raw of ["0x1F4", "1e5", " 500 ", "+500", "5.0", "Infinity", "", "5_00"]) {
    const { exit, record } = await runJson(["config", "get", "--timeout-ms", raw, "--json"]);
    assert.equal(exit, EXIT_CODES.usage, `--timeout-ms ${JSON.stringify(raw)} must be rejected`);
    assert.equal(record.error.code, "cuna.usage.invalid", raw);
  }
  const accepted = await runJson(["config", "get", "--timeout-ms", "500", "--json"]);
  assert.equal(accepted.exit, EXIT_CODES.success);
});

test("a workspace generation is never coerced from an exponent", async () => {
  // This is a fencing token. `1e3` silently becoming 1000 is a write against a
  // generation the user never named.
  const { exit, record } = await runJson([
    "agent-sessions", "create",
    "--machine", MACHINE_ID,
    "--workspace-binding-id", "11111111-1111-4111-8111-111111111111",
    "--workspace-generation", "1e3",
    "--agent", "codex", "--yes", "--json",
  ], { env: { CUNA_API_KEY: API_KEY }, clientFactory: () => ({}) });
  assert.equal(exit, EXIT_CODES.usage);
  assert.equal(record.error.code, "cuna.usage.invalid");
  assert.ok(record.error.message.includes("workspace-generation"));
});

/* -------------------------------------------------------------------------- */
/* One machine-ID authority, checked at the edge (R-11)                        */
/* -------------------------------------------------------------------------- */

test("a malformed machine ID fails at the edge, before any client call", async () => {
  // Previously `mch_1` passed preflight, spent a capability round trip, and
  // failed inside the transport against a rule the command layer never had.
  for (const argv of [
    ["machines", "pause", "m_1", "--yes"],
    ["machines", "delete", "mch_1", "--yes"],
    ["agent-sessions", "list", "--machine", "m_1"],
  ]) {
    let touched = 0;
    const { exit, record } = await runJson([...argv, "--json"], {
      env: { CUNA_API_KEY: API_KEY },
      clientFactory: () => new Proxy({}, { get: () => () => { touched += 1; throw new Error("unreachable"); } }),
    });
    assert.equal(exit, EXIT_CODES.usage, argv.join(" "));
    assert.equal(record.error.code, "cuna.usage.invalid", argv.join(" "));
    assert.equal(touched, 0, `${argv.join(" ")} must not reach the client`);
  }
});

/* -------------------------------------------------------------------------- */
/* Error details reach human output (R-7)                                      */
/* -------------------------------------------------------------------------- */

test("human output prints the details that distinguish one failure from another", async () => {
  const streams = interactive();
  await runCli(["capabilities"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => ({
      discoverCapabilities: async () => {
        throw new CunaError({
          code: "cuna.remote.forbidden",
          message: "Cuna refused this request.",
          exitCode: EXIT_CODES.policy,
          details: { request_id: "req-0123456789", status: 403 },
        });
      },
    }),
  });
  const stderr = streams.stderr();
  assert.ok(stderr.includes("request_id: req-0123456789"), stderr);
  assert.ok(stderr.includes("status: 403"), stderr);
});

test("a credential in error details is redacted from human output", async () => {
  const streams = interactive();
  await runCli(["capabilities"], {
    streams: streams.streams,
    platform,
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => ({
      discoverCapabilities: async () => {
        throw new CunaError({
          code: "cuna.remote.forbidden",
          message: "Cuna refused this request.",
          exitCode: EXIT_CODES.policy,
          details: { presented: `runa_sc_${"A".repeat(43)}`, request_id: "req-1" },
        });
      },
    }),
  });
  const stderr = streams.stderr();
  assert.ok(stderr.includes("[redacted credential]"), stderr);
  assert.ok(!stderr.includes("runa_sc_"), "a credential must never reach the terminal");
  assert.ok(stderr.includes("request_id: req-1"), "redaction is per value, not per record");
});

/* -------------------------------------------------------------------------- */
/* Error codes the rename passed straight through (C-2)                        */
/* -------------------------------------------------------------------------- */

test("the cuna namespace is prepended to every runtime boundary code", async () => {
  // `cuna.runtime.${error.code}` at cli/run.ts is one of two template sites that
  // mint codes. Tests asserted the bare `RuntimeBoundaryError` codes and never
  // the prefixed strings the user actually sees, so the namespace rename passed
  // straight through this line with nothing watching.
  const codes = [
    "capability_unknown", "capability_unsupported", "capability_unavailable",
    "capability_scope_mismatch", "capability_snapshot_expired", "control_plane_unavailable",
    "remote_state_unproven", "grant_invalid", "grant_expired", "grant_scope_mismatch",
    "terminal_protocol_error", "terminal_not_ready", "terminal_disconnected",
    "terminal_timeout", "session_conflict", "session_unknown", "session_discontinuous",
    "runtime_closed", "process_invalid", "process_failed", "pty_unavailable",
    "pty_evidence_invalid",
  ];
  for (const code of codes) {
    const streams = interactive();
    await runCli(["connect", "11111111-1111-4111-8111-111111111111", "--no-color"], {
      streams: streams.streams,
      platform,
      env: { CUNA_API_KEY: API_KEY },
      clientFactory: () => ({}),
      foregroundTerminalRunner: async () => { throw runtimeFailure(code, "runtime boundary failure"); },
    });
    assert.ok(
      streams.stderr().includes(`cuna.runtime.${code}`),
      `runtime code ${code} must surface as cuna.runtime.${code}, got: ${streams.stderr()}`,
    );
  }
});

test("the cuna namespace is prepended to every credential boundary code", async () => {
  const codes = [
    "credential_backend_unavailable", "credential_backend_unverified", "credential_backend_failure",
    "credential_binding_invalid", "credential_corrupt", "credential_missing",
    "credential_revision_conflict", "credential_refresh_failed", "credential_revoked",
    "credential_process_failed", "credential_process_timeout", "credential_output_oversized",
  ];
  for (const code of codes) {
    const { record } = await runJson(["capabilities", "--json"], {
      env: {},
      humanAuth: {
        acquireAccessToken: async () => { throw credentialFailure(code, "credential boundary failure"); },
      },
    });
    assert.equal(record.error.code, `cuna.auth.${code}`, code);
  }
});

test("the top-level catch names cuna.internal.unexpected for a non-Cuna throw", async () => {
  // The single most user-visible code in the product: every unclassified
  // failure in the CLI arrives here, and no test named it.
  const normalized = normalizeError(new Error("something the CLI never classified"));
  assert.equal(normalized.code, "cuna.internal.unexpected");
  assert.equal(normalized.exitCode, EXIT_CODES.internal);

  const { exit, record } = await runJson(["capabilities", "--json"], {
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => ({ discoverCapabilities: async () => { throw new Error("unclassified"); } }),
  });
  assert.equal(exit, EXIT_CODES.internal);
  assert.equal(record.error.code, "cuna.internal.unexpected");
  // The message must not leak the underlying throw.
  assert.ok(!JSON.stringify(record).includes("unclassified"));
});

test("cuna.capability.unsupported is the code every reserved surface reports", async () => {
  assert.equal(unsupportedError("workspace synchronization").code, "cuna.capability.unsupported");
  for (const argv of [["sync"], ["shell"], ["companion"]]) {
    const { exit, record } = await runJson([...argv, "--json"], { env: { CUNA_API_KEY: API_KEY }, clientFactory: () => ({}) });
    assert.equal(exit, EXIT_CODES.unsupported, argv[0]);
    assert.equal(record.error.code, "cuna.capability.unsupported", argv[0]);
  }
});

/* -------------------------------------------------------------------------- */
/* Capability snapshot faults are distinguishable (R-9)                        */
/* -------------------------------------------------------------------------- */

const NOW = Date.parse("2026-08-08T00:00:00Z");

function gatedSnapshot(overrides = {}) {
  return {
    schemaVersion: "1.0",
    subjectScope: "machine",
    subjectId: MACHINE_ID,
    observedAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 30_000).toISOString(),
    etag: "etag-1",
    capabilities: [{
      id: "machines.lifecycle",
      availability: "supported",
      interaction: "native",
      mutationClass: "reversible",
      surfaces: ["cli"],
      requiredPermissions: ["machines:update"],
    }],
    ...overrides,
  };
}

// `machines pause` is gated by requireCapability, so the snapshot verdict
// reaches the user. `cuna capabilities` merely prints a snapshot and would not
// exercise the decision at all.
async function pauseWith(snapshot) {
  return await runJson(["machines", "pause", MACHINE_ID, "--yes", "--json"], {
    env: { CUNA_API_KEY: API_KEY },
    now: () => NOW,
    clientFactory: () => ({
      discoverCapabilities: async () => snapshot,
      transitionMachine: async (id) => ({ id, name: "dev", state: "paused" }),
    }),
  });
}

test("each capability snapshot fault reports its own reason", async () => {
  const cases = [
    { reason: "unsupported_schema", snapshot: gatedSnapshot({ schemaVersion: "2.0" }) },
    {
      reason: "malformed_freshness",
      snapshot: gatedSnapshot({
        observedAt: new Date(NOW + 30_000).toISOString(),
        expiresAt: new Date(NOW - 1_000).toISOString(),
      }),
    },
    {
      reason: "future_observation",
      snapshot: gatedSnapshot({
        observedAt: new Date(NOW + 600_000).toISOString(),
        expiresAt: new Date(NOW + 630_000).toISOString(),
      }),
    },
    { reason: "excessive_ttl", snapshot: gatedSnapshot({ expiresAt: new Date(NOW + 600_000).toISOString() }) },
    {
      reason: "expired",
      snapshot: gatedSnapshot({
        observedAt: new Date(NOW - 30_000).toISOString(),
        expiresAt: new Date(NOW - 1_000).toISOString(),
      }),
    },
  ];
  const seen = new Set();
  for (const { reason, snapshot } of cases) {
    const { record } = await pauseWith(snapshot);
    assert.equal(record.error.details.reason, reason, `snapshot fault ${reason}`);
    seen.add(record.error.details.reason);
  }
  // All five used to collapse into "snapshot_expired", which told a user whose
  // server sent an unsupported schema to retry a request that cannot succeed.
  assert.equal(seen.size, 5, "every snapshot fault must be distinguishable");
  // The control: a valid snapshot still authorizes the mutation.
  const ok = await pauseWith(gatedSnapshot());
  assert.equal(ok.exit, EXIT_CODES.success);
});

test("a permanent snapshot fault is never advertised as retryable", async () => {
  for (const snapshot of [
    gatedSnapshot({ schemaVersion: "9.9" }),
    gatedSnapshot({ expiresAt: new Date(NOW + 600_000).toISOString() }),
  ]) {
    const { record } = await pauseWith(snapshot);
    assert.equal(record.error.retryable, false, record.error.details.reason);
    assert.ok(record.error.hint.includes("Retrying cannot help"), record.error.hint);
  }
  // A merely expired snapshot keeps the ordinary, actionable hint.
  const { record } = await pauseWith(gatedSnapshot({
    observedAt: new Date(NOW - 30_000).toISOString(),
    expiresAt: new Date(NOW - 1_000).toISOString(),
  }));
  assert.equal(record.error.details.reason, "expired");
  assert.ok(record.error.hint.includes("cuna capabilities"), record.error.hint);
});

/* -------------------------------------------------------------------------- */
/* Generated idempotency key (R-6)                                             */
/* -------------------------------------------------------------------------- */

test("machines create generates an idempotency key and still honours an override", async () => {
  const keys = [];
  const client = {
    discoverCapabilities: async () => ({
      schemaVersion: "1.0",
      subjectScope: "account",
      observedAt: new Date(Date.parse("2026-08-08T00:00:00Z") - 1_000).toISOString(),
      expiresAt: new Date(Date.parse("2026-08-08T00:00:00Z") + 30_000).toISOString(),
      etag: "etag-1",
      capabilities: [{
        id: "machines.create",
        availability: "supported",
        interaction: "native",
        mutationClass: "reversible",
        surfaces: ["cli"],
        requiredPermissions: ["machines:create"],
      }],
    }),
    createMachine: async (_body, idempotencyKey) => {
      keys.push(idempotencyKey);
      return { id: MACHINE_ID, name: "dev", state: "creating" };
    },
  };
  const generated = await runJson(["machines", "create", "--name", "dev", "--yes", "--json"], {
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  });
  assert.equal(generated.exit, EXIT_CODES.success);
  assert.match(keys[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);

  await runJson(["machines", "create", "--name", "dev", "--yes", "--idempotency-key", "operation-1", "--json"], {
    env: { CUNA_API_KEY: API_KEY },
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    clientFactory: () => client,
  });
  assert.equal(keys[1], "operation-1", "an explicit key must still win");

  const rejected = await runJson(["machines", "create", "--name", "dev", "--yes", "--idempotency-key", "short", "--json"], {
    env: { CUNA_API_KEY: API_KEY },
    clientFactory: () => client,
  });
  assert.equal(rejected.exit, EXIT_CODES.usage, "an explicit key is still validated");
});
