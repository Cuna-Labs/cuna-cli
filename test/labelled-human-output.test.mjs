// D10: human output carries labels and the ids the record already has.
//
// Measured on the installed 0.1.3 on 2026-09-28: `cuna whoami` and `cuna
// access status` printed only `active  admitted  assigned`, no label and no
// id, although the JSON record carries the workspace id and profile; `cuna
// doctor` printed record keys, `null` and internal reason codes such as
// `foreground_exact_session_composed_live_producer_required`.
import test from "node:test";
import assert from "node:assert/strict";

import { EXIT_CODES, memoryStreams, runCli, runtimeFeatureGates } from "../dist/index.js";

const PLATFORM = Object.freeze({
  kind: "linux",
  paths: { configDirectory: "/cfg", stateDirectory: "/state", runtimeDirectory: "/run" },
  async readSafeConfig() { return { exists: false }; },
});
const WORKSPACE_ID = "4b4668d9-0000-4000-8000-000000000002";

const IDENTITY_RESULT = Object.freeze({
  profile: "default",
  sessionId: "00000000-0000-4000-8000-000000000001",
  context: {
    requiredTermsVersion: "2026-08",
    identity: "active",
    admission: "admitted",
    workspace: { state: "assigned", id: WORKSPACE_ID },
  },
});

async function humanWhoami(argv) {
  const streams = memoryStreams({ stdoutIsTTY: true, stderrIsTTY: false });
  const exit = await runCli(argv, {
    streams: streams.streams,
    platform: PLATFORM,
    env: {},
    humanAuth: { async whoami() { return IDENTITY_RESULT; } },
    clientFactory: () => ({}),
  });
  assert.equal(exit, EXIT_CODES.success, streams.stderr());
  return streams.stdout();
}

test("whoami and access status print labelled lines with the workspace id and profile", async () => {
  const whoami = await humanWhoami(["whoami"]);
  assert.doesNotMatch(whoami, /^active\tadmitted\tassigned$/mu, "the bare three-value line is the defect");
  assert.match(whoami, /^Account\s+active$/mu, whoami);
  assert.match(whoami, /^Admission\s+admitted$/mu, whoami);
  assert.match(whoami, new RegExp(`^Workspace\\s+assigned · ${WORKSPACE_ID}$`, "mu"), whoami);
  assert.match(whoami, /^Profile\s+default$/mu, whoami);
  // One read, one rendering: only the JSON record name differs.
  assert.equal(await humanWhoami(["access", "status"]), whoami);
});

test("doctor speaks in labels, never in record keys, null or reason codes", async () => {
  const features = runtimeFeatureGates({ platform: "linux", credentialBackendStatus: "verified" });
  const streams = memoryStreams({ stdoutIsTTY: true, stderrIsTTY: true });
  assert.equal(await runCli(["doctor"], { streams: streams.streams, platform: PLATFORM, env: {}, runtimeFeatures: features }),
    EXIT_CODES.success, streams.stderr());
  const printed = streams.stdout();
  for (const raw of ["environment_credential", "runtime_features", "null", "unsupported\t", "available\t"]) {
    assert.ok(!printed.includes(raw), `doctor printed the raw ${JSON.stringify(raw)}:\n${printed}`);
  }
  for (const gate of features) {
    assert.ok(!printed.includes(gate.reason), `doctor printed the reason code ${gate.reason}:\n${printed}`);
    // `daemon` is also an English word; the snake_case keys are not.
    if (gate.feature.includes("_")) {
      assert.ok(!printed.includes(gate.feature), `doctor printed the feature key ${gate.feature}:\n${printed}`);
    }
  }
  assert.match(printed, /^Automation credential\s+not set; commands use your browser sign-in$/mu, printed);
  assert.match(printed, /^\s+Encrypted session store\s+verified \(AES-256-GCM\)$/mu, printed);
  assert.match(printed, /^\s+Sign-in service\s+not checked; run `cuna doctor --check-browser-login`$/mu, printed);

  // Control: the record keeps every key and code a script reads.
  const json = memoryStreams();
  assert.equal(await runCli(["doctor", "--json"], { streams: json.streams, platform: PLATFORM, env: {}, runtimeFeatures: features }),
    EXIT_CODES.success);
  const data = JSON.parse(json.stdout()).data;
  assert.equal(data.environment_credential, "absent");
  assert.equal(data.environment_credential_variable, null);
  assert.deepEqual(data.runtime_features, JSON.parse(JSON.stringify(features)));
});
