import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CredentialBoundaryError,
  createNativeBridgeBackend,
  createNativeCredentialOwnedProcessBridge,
  credentialTarget,
  probeCredentialTarget,
} from "../dist/credentials/index.js";

/**
 * `cuna login` could not succeed on Windows or macOS even with a flawless
 * native bridge installed. The credential namespace was minted in two places
 * and accepted in a third: `vault.ts` minted `cuna-cli:v1:<64 hex>`,
 * `native-bridge-backend.ts` minted its liveness probe as
 * `cuna-cli:probe:<32 hex>`, and both the TypeScript acceptor
 * (`native-process-bridge.ts`) and the independent Rust acceptor
 * (`native/cuna-native-bridge/src/protocol.rs`) admitted only the first shape.
 * The probe's very first `replace` threw `credential_binding_invalid`, the
 * backend reported `unavailable`, and `human-session.ts` raised
 * `cuna.auth.vault_unavailable` -- a working vault reported as broken.
 *
 * Nothing compared the two sides, in either language, so nothing was red.
 *
 * These cases install that comparison. Three oracles judge the target the probe
 * actually hands a bridge, and the defective shape is run through all three as
 * the negative control, so a test that cannot fail is visible here rather than
 * assumed:
 *
 *   1. the literal regular expression, written out rather than imported;
 *   2. the Rust predicate, re-derived from `protocol.rs` at test time, so a
 *      change on the Rust side fires here instead of diverging silently;
 *   3. the real TypeScript acceptor, exercised end to end through
 *      `createNativeCredentialOwnedProcessBridge`.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = 1_800_000_000_000;

/** Oracle 1: the shape, spelled out. Never derived from the code under test. */
const LITERAL_CREDENTIAL_TARGET = /^cuna-cli:v1:[0-9a-f]{64}$/u;

/** The shape the defect minted, kept literal as the standing negative control. */
const DEFECTIVE_PROBE_TARGET = `cuna-cli:probe:${"3f".repeat(16)}`;

/** The reserved probe binding, transcribed. Pins the probe to the real mint. */
const PROBE_NAMESPACE = "cuna.credential-backend-probe.v1";
const PROBE_KIND = "credential-backend-liveness-probe";

const GENUINE_BINDING = Object.freeze({
  profileId: "default",
  accountId: "account-1",
  workspaceId: "workspace-1",
  kind: "cuna-refresh-token",
});

const descriptor = Object.freeze({
  protocol: "cuna.native-bridge.v1",
  platform: "win32",
  architecture: "x64",
  packageVersion: "0.1.0",
  nativeVersion: "0.1.0",
  fileVersion: "0.1.0.0",
  executable: "C:\\Program Files\\Cuna\\cuna-native-bridge.exe",
  workingDirectory: "C:\\Program Files\\Cuna",
  manifestPath: "C:\\Program Files\\Cuna\\cuna-native-bridge.manifest.json",
  maximumCredentialBytes: 2_560,
  binarySha256: "a".repeat(64),
  manifestSha256: "b".repeat(64),
  sbomSha256: "c".repeat(64),
  provenanceSha256: "d".repeat(64),
  signature: Object.freeze({
    kind: "authenticode",
    publisherCertificateFingerprint: "C".repeat(64),
  }),
});

function successResponse() {
  const result = Buffer.alloc(13);
  result.write("CUNANR01", 0, "ascii");
  result[8] = 0;
  result.writeUInt32BE(0, 9);
  return result;
}

/**
 * Oracle 2. Re-derived from the Rust source rather than transcribed, so this
 * oracle tracks the acceptor that actually runs inside the signed bridge.
 */
async function rustCredentialTargetPredicate() {
  const source = await readFile(
    path.join(root, "native", "cuna-native-bridge", "src", "protocol.rs"),
    "utf8",
  );
  const declaration = /fn valid_credential_target\(target: &str\) -> bool \{([\s\S]*?)\n\}/u.exec(source);
  assert.notEqual(declaration, null, "the Rust credential-target acceptor moved; re-derive this oracle");
  const body = declaration[1];
  const prefix = /strip_prefix\("([^"]+)"\)/u.exec(body);
  const digits = /digest\.len\(\) == (\d+)/u.exec(body);
  assert.notEqual(prefix, null, "the Rust acceptor no longer strips a literal prefix");
  assert.notEqual(digits, null, "the Rust acceptor no longer pins a literal digest length");
  // The alphabet is the one piece this oracle transcribes, so pin the exact
  // Rust expressions it stands for. A widened or narrowed Rust alphabet fires
  // here instead of quietly disagreeing with `[0-9a-f]`.
  assert.match(body, /byte\.is_ascii_digit\(\)/u);
  assert.match(body, /\(b'a'\.\.=b'f'\)\.contains\(byte\)/u);
  const expectedLength = Number(digits[1]);
  return (target) => {
    if (typeof target !== "string" || !target.startsWith(prefix[1])) return false;
    const digest = target.slice(prefix[1].length);
    return digest.length === expectedLength && [...digest].every((character) => /^[0-9a-f]$/u.test(character));
  };
}

/**
 * Oracle 3. The production TypeScript acceptor, not a copy of it. `replace`
 * encodes the request -- and rejects an inadmissible target -- before any
 * verification, spawn or exchange happens.
 */
function realTypeScriptAcceptor() {
  const bridge = createNativeCredentialOwnedProcessBridge({
    descriptor,
    runtimePlatform: "win32",
    runtimeArchitecture: "x64",
    verifier: { verify: async () => {} },
    authority: {
      platform: "win32",
      authorityKind: "windows-owned-process-spawn",
      exchange: async () => ({
        exitCode: 0,
        signal: null,
        stdout: successResponse(),
        stderrPresent: false,
        cleanupProven: true,
        observation: {
          pid: 42_424,
          platform: "win32",
          architecture: "x64",
          executable: descriptor.executable,
          binarySha256: descriptor.binarySha256,
          fileVersion: descriptor.fileVersion,
          loadedImageVerified: true,
          processInstanceVerified: true,
          processInstanceId: "windows-process-object-42424",
        },
      }),
    },
  });
  return async (target) => {
    try {
      await bridge.replace(target, Uint8Array.from([1]));
      return true;
    } catch (error) {
      if (error instanceof CredentialBoundaryError && error.code === "credential_binding_invalid") return false;
      throw error;
    }
  };
}

function recordingBridge(platform) {
  const calls = [];
  const stored = new Map();
  return {
    calls,
    stored,
    bridge: Object.freeze({
      platform,
      backendId: `${platform}-recording-vault`,
      transportSecurity: "native_memory_only",
      read: async (target) => {
        calls.push({ operation: "read", target });
        const value = stored.get(target);
        return value === undefined ? undefined : Uint8Array.from(value);
      },
      replace: async (target, value) => {
        calls.push({ operation: "replace", target });
        stored.set(target, Uint8Array.from(value));
      },
      delete: async (target) => {
        calls.push({ operation: "delete", target });
        return stored.delete(target) ? "deleted" : "absent";
      },
    }),
  };
}

test("the native bridge liveness probe hands the bridge a target every acceptor already admits", async () => {
  const admittedByRust = await rustCredentialTargetPredicate();
  const admittedByTypeScript = realTypeScriptAcceptor();

  const recorder = recordingBridge("darwin");
  const backend = createNativeBridgeBackend({
    platform: "darwin",
    bridge: recorder.bridge,
    clock: () => NOW,
  });
  const evidence = await backend.probe();

  assert.equal(evidence.status, "verified");
  assert.equal(evidence.source, "native_bridge_round_trip");
  assert.deepEqual(
    recorder.calls.map((call) => call.operation),
    ["replace", "read", "delete"],
  );
  const observed = new Set(recorder.calls.map((call) => call.target));
  assert.equal(observed.size, 1, "the probe must round-trip exactly one target");
  const [probeTarget] = observed;

  assert.match(probeTarget, LITERAL_CREDENTIAL_TARGET);
  assert.equal(admittedByRust(probeTarget), true, probeTarget);
  assert.equal(await admittedByTypeScript(probeTarget), true, probeTarget);

  // Negative control: the shape this call site used to mint fails all three
  // oracles, so none of them is vacuous.
  assert.doesNotMatch(DEFECTIVE_PROBE_TARGET, LITERAL_CREDENTIAL_TARGET);
  assert.equal(admittedByRust(DEFECTIVE_PROBE_TARGET), false);
  assert.equal(await admittedByTypeScript(DEFECTIVE_PROBE_TARGET), false);
});

test("the liveness probe cannot read, overwrite or delete a stored credential", async () => {
  const recorder = recordingBridge("win32");
  const genuineTarget = credentialTarget(GENUINE_BINDING);
  const genuineValue = Uint8Array.from([7, 11, 13, 17, 19]);
  recorder.stored.set(genuineTarget, Uint8Array.from(genuineValue));

  const backend = createNativeBridgeBackend({
    platform: "win32",
    bridge: recorder.bridge,
    clock: () => NOW,
  });
  const first = await backend.probe();
  // A second probe past the evidence lease proves freshness, not caching.
  const later = createNativeBridgeBackend({
    platform: "win32",
    bridge: recorder.bridge,
    clock: () => NOW + 120_000,
  });
  const second = await later.probe();

  assert.equal(first.status, "verified");
  assert.equal(second.status, "verified");
  assert.equal(recorder.calls.some((call) => call.target === genuineTarget), false);
  assert.equal(recorder.stored.size, 1, "the probe must leave nothing behind");
  assert.deepEqual(recorder.stored.get(genuineTarget), genuineValue);

  const probeTargets = [...new Set(recorder.calls.map((call) => call.target))];
  assert.equal(probeTargets.length, 2, "each probe must draw a fresh target");
  for (const target of probeTargets) assert.notEqual(target, genuineTarget);
});

test("a probe target is the credential mint applied to a reserved, nonce-bound binding", () => {
  const nonce = Uint8Array.from({ length: 32 }, (_, index) => index);
  const witness = [...nonce].map((byte) => byte.toString(16).padStart(2, "0")).join("");

  // Literal oracle: the probe target is exactly what the single credential mint
  // produces for the reserved binding. Reversing this is what the defect did.
  assert.equal(
    probeCredentialTarget(nonce),
    credentialTarget({
      profileId: PROBE_NAMESPACE,
      accountId: PROBE_NAMESPACE,
      workspaceId: `${PROBE_NAMESPACE}:${witness}`,
      kind: PROBE_KIND,
    }),
  );
  assert.equal(probeCredentialTarget(nonce), probeCredentialTarget(Uint8Array.from(nonce)));
  assert.notEqual(probeCredentialTarget(nonce), probeCredentialTarget(new Uint8Array(32)));
  assert.notEqual(probeCredentialTarget(), probeCredentialTarget());
  assert.match(probeCredentialTarget(), LITERAL_CREDENTIAL_TARGET);

  // The 256-bit nonce is the whole non-collision argument, so a short or absent
  // one is refused rather than padded.
  for (const invalid of [new Uint8Array(0), new Uint8Array(16), new Uint8Array(31), new Uint8Array(33)]) {
    assert.throws(
      () => probeCredentialTarget(invalid),
      (error) => error instanceof CredentialBoundaryError && error.code === "credential_binding_invalid",
    );
  }
});
