import assert from "node:assert/strict";
import test from "node:test";

import {
  CredentialBoundaryError,
  createNativeBrowserProcessBridge,
  createNativeBrowserOwnedProcessBridge,
  createNativeCredentialProcessBridge,
  createNativeCredentialOwnedProcessBridge,
  createPlatformCredentialBackend,
} from "../dist/credentials/index.js";
import { createBrowserOpener } from "../dist/index.js";

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

const credentialTarget = `cuna-cli:v1:${"a".repeat(64)}`;

function childObservation(child, overrides = {}) {
  return {
    pid: child.pid,
    platform: descriptor.platform,
    architecture: descriptor.architecture,
    executable: descriptor.executable,
    binarySha256: descriptor.binarySha256,
    fileVersion: descriptor.fileVersion,
    loadedImageVerified: true,
    processInstanceVerified: true,
    processInstanceId: `windows-process-object-${child.pid}`,
    ...overrides,
  };
}

const admittedChildIdentityAuthority = Object.freeze({
  platform: "win32",
  authorityKind: "windows-owned-process-handle",
  verify: async ({ child }) => ({
    observation: childObservation(child),
    release: () => {},
  }),
});

function ownedObservation(overrides = {}) {
  return childObservation({ pid: 42_424 }, overrides);
}

function response(status, payload = new Uint8Array()) {
  const result = Buffer.alloc(13 + payload.byteLength);
  result.write("CUNANR01", 0, "ascii");
  result[8] = status;
  result.writeUInt32BE(payload.byteLength, 9);
  result.set(payload, 13);
  return result;
}

test("TC-048-04/14 production exchange delegates process creation and protected stdin atomically", async () => {
  let capturedRequest;
  const authority = {
    platform: "win32",
    authorityKind: "windows-owned-process-spawn",
    exchange: async (input) => {
      capturedRequest = input.request;
      assert.equal(Object.hasOwn(input, "pid"), false);
      assert.equal(Buffer.from(input.request.subarray(0, 8)).toString("ascii"), "CUNANV01");
      return {
        exitCode: 0,
        signal: null,
        stdout: response(0),
        stderrPresent: false,
        cleanupProven: true,
        observation: ownedObservation(),
      };
    },
  };
  const bridge = createNativeCredentialOwnedProcessBridge({
    descriptor,
    runtimePlatform: "win32",
    runtimeArchitecture: "x64",
    authority,
    verifier: { verify: async () => {} },
  });
  const secret = Uint8Array.from([31, 41, 59, 26]);
  await bridge.replace(credentialTarget, secret);
  assert.equal(capturedRequest.every((byte) => byte === 0), true);
  assert.deepEqual(secret, Uint8Array.from([31, 41, 59, 26]));
});

test("owned-process production exchange rejects unproven cleanup and PID-observer authority labels", async () => {
  assert.throws(
    () => createNativeCredentialOwnedProcessBridge({
      descriptor,
      runtimePlatform: "win32",
      runtimeArchitecture: "x64",
      authority: {
        platform: "win32",
        authorityKind: "windows-owned-process-handle",
        exchange: async () => assert.fail("must not run"),
      },
      verifier: { verify: async () => {} },
    }),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_backend_unverified",
  );

  const bridge = createNativeBrowserOwnedProcessBridge({
    descriptor,
    runtimePlatform: "win32",
    runtimeArchitecture: "x64",
    authority: {
      platform: "win32",
      authorityKind: "windows-owned-process-spawn",
      exchange: async () => ({
        exitCode: 0,
        signal: null,
        stdout: response(0),
        stderrPresent: false,
        cleanupProven: false,
        observation: ownedObservation(),
      }),
    },
    verifier: { verify: async () => {} },
  });
  await assert.rejects(
    bridge.open("https://app.getcuna.com/cli/continue"),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_backend_unverified",
  );
});

async function admittedResult(request, stdout) {
  assert.equal(typeof request.beforeStdin, "function");
  const lease = await request.beforeStdin({ pid: 42_424, platform: "win32" });
  lease.release();
  return {
    exitCode: 0,
    signal: null,
    stdout,
    stderrPresent: false,
    stdinAdmissionConfirmed: true,
  };
}

test("TC-048-04/14 native bridge verifies every invocation and keeps protected bytes off argv and environment", async () => {
  let verifierCalls = 0;
  let runnerCalls = 0;
  let capturedInput;
  let capturedOutput;
  const secret = Uint8Array.from([11, 22, 33, 44]);
  const bridge = createNativeCredentialProcessBridge({
    descriptor,
    runtimePlatform: "win32",
    runtimeArchitecture: "x64",
    childIdentityAuthority: admittedChildIdentityAuthority,
    verifier: { verify: async (observed) => {
      verifierCalls += 1;
      assert.equal(observed, descriptor);
    } },
    runner: { run: async (request) => {
      runnerCalls += 1;
      const lease = await request.beforeStdin({ pid: 42_424, platform: "win32" });
      lease.release();
      assert.deepEqual(request.args, []);
      assert.deepEqual(request.environment, {});
      assert.equal(Buffer.from(request.stdin.subarray(0, 8)).toString("ascii"), "CUNANV01");
      capturedInput = request.stdin;
      capturedOutput = response(0);
      return { exitCode: 0, signal: null, stdout: capturedOutput, stderrPresent: false, stdinAdmissionConfirmed: true };
    } },
  });

  await bridge.replace(credentialTarget, secret);
  assert.equal(verifierCalls, 2);
  assert.equal(runnerCalls, 1);
  assert.ok(capturedInput.every((value) => value === 0), "the owned request must be zeroized");
  assert.ok(capturedOutput.every((value) => value === 0), "the process response must be zeroized");
  assert.deepEqual(secret, Uint8Array.from([11, 22, 33, 44]), "the caller retains ownership of its value");
});

test("TC-048-05 unsigned or substituted bridge evidence fails before process creation", async () => {
  let runnerCalls = 0;
  const bridge = createNativeCredentialProcessBridge({
    descriptor,
    runtimePlatform: "win32",
    runtimeArchitecture: "x64",
    childIdentityAuthority: admittedChildIdentityAuthority,
    verifier: { verify: async () => { throw new Error("substituted"); } },
    runner: { run: async (request) => {
      runnerCalls += 1;
      return admittedResult(request, response(0));
    } },
  });
  await assert.rejects(
    bridge.read(credentialTarget),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_backend_unverified",
  );
  assert.equal(runnerCalls, 0);
});

test("TC-048-14 child-image authority is mandatory before native process creation", () => {
  let verifierCalls = 0;
  let runnerCalls = 0;
  assert.throws(
    () => createNativeCredentialProcessBridge({
      descriptor,
      runtimePlatform: "win32",
      runtimeArchitecture: "x64",
      verifier: { verify: async () => { verifierCalls += 1; } },
      runner: { run: async () => {
        runnerCalls += 1;
        return { exitCode: 0, signal: null, stdout: response(0), stderrPresent: false };
      } },
    }),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_backend_unverified",
  );
  assert.equal(verifierCalls, 0);
  assert.equal(runnerCalls, 0);
});

test("TC-048-14 cross-platform native descriptors fail before verifier or process effects", () => {
  let verifierCalls = 0;
  let runnerCalls = 0;
  assert.throws(
    () => createNativeCredentialProcessBridge({
      descriptor,
      runtimePlatform: "darwin",
      runtimeArchitecture: "x64",
      childIdentityAuthority: admittedChildIdentityAuthority,
      verifier: { verify: async () => { verifierCalls += 1; } },
      runner: { run: async () => {
        runnerCalls += 1;
        return { exitCode: 0, signal: null, stdout: response(0), stderrPresent: false };
      } },
    }),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_backend_unverified",
  );
  assert.equal(verifierCalls, 0);
  assert.equal(runnerCalls, 0);
});

test("TC-048-14 Windows rejects a child authority that does not own a process handle", () => {
  let verifierCalls = 0;
  let runnerCalls = 0;
  assert.throws(
    () => createNativeCredentialProcessBridge({
      descriptor,
      runtimePlatform: "win32",
      runtimeArchitecture: "x64",
      childIdentityAuthority: {
        platform: "win32",
        authorityKind: "darwin-audit-token",
        verify: async ({ child }) => ({ observation: childObservation(child), release: () => {} }),
      },
      verifier: { verify: async () => { verifierCalls += 1; } },
      runner: { run: async () => {
        runnerCalls += 1;
        return { exitCode: 0, signal: null, stdout: response(0), stderrPresent: false };
      } },
    }),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_backend_unverified",
  );
  assert.equal(verifierCalls, 0);
  assert.equal(runnerCalls, 0);
});

test("TC-048-11 Windows capacity is explicit and rejects 0 or 2,561 bytes before native effects", async () => {
  let verifierCalls = 0;
  let runnerCalls = 0;
  const bridge = createNativeCredentialProcessBridge({
    descriptor,
    runtimePlatform: "win32",
    runtimeArchitecture: "x64",
    childIdentityAuthority: admittedChildIdentityAuthority,
    verifier: { verify: async () => { verifierCalls += 1; } },
    runner: { run: async (request) => {
      runnerCalls += 1;
      return admittedResult(request, response(0));
    } },
  });
  for (const length of [0, 2_561]) {
    await assert.rejects(
      bridge.replace(credentialTarget, new Uint8Array(length)),
      (error) => error instanceof CredentialBoundaryError && error.code === "credential_corrupt",
    );
  }
  assert.equal(verifierCalls, 0);
  assert.equal(runnerCalls, 0);
  await bridge.replace(credentialTarget, new Uint8Array(1));
  await bridge.replace(credentialTarget, new Uint8Array(2_559));
  await bridge.replace(credentialTarget, new Uint8Array(2_560));
  assert.equal(verifierCalls, 6);
  assert.equal(runnerCalls, 3);
});

test("native credential operations reject targets outside the exact Cuna namespace before native effects", async () => {
  let verifierCalls = 0;
  let runnerCalls = 0;
  const bridge = createNativeCredentialProcessBridge({
    descriptor,
    runtimePlatform: "win32",
    runtimeArchitecture: "x64",
    childIdentityAuthority: admittedChildIdentityAuthority,
    verifier: { verify: async () => { verifierCalls += 1; } },
    runner: { run: async (request) => {
      runnerCalls += 1;
      return admittedResult(request, response(0));
    } },
  });

  for (const target of [
    "arbitrary-credential",
    "cuna-cli:v1:short",
    `cuna-cli:v1:${"A".repeat(64)}`,
    `cuna-cli:v2:${"a".repeat(64)}`,
    `runa-cli:v1:${"a".repeat(64)}`,
  ]) {
    await assert.rejects(
      bridge.read(target),
      (error) => error instanceof CredentialBoundaryError && error.code === "credential_binding_invalid",
    );
  }
  assert.equal(verifierCalls, 0);
  assert.equal(runnerCalls, 0);
});

test("TC-048-12 closed native statuses distinguish absence and corruption", async () => {
  const replies = [response(1), response(1, Uint8Array.from([9])), Buffer.from("not-a-cuna-response")];
  const bridge = createNativeCredentialProcessBridge({
    descriptor,
    runtimePlatform: "win32",
    runtimeArchitecture: "x64",
    childIdentityAuthority: admittedChildIdentityAuthority,
    verifier: { verify: async () => {} },
    runner: { run: async (request) => admittedResult(request, replies.shift()) },
  });
  assert.equal(await bridge.read(credentialTarget), undefined);
  await assert.rejects(
    bridge.read(credentialTarget),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_corrupt",
  );
  await assert.rejects(
    bridge.read(credentialTarget),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_corrupt",
  );
});

test("TC-048-02 Windows admits only a platform-matching native bridge with live round-trip evidence", async () => {
  const values = new Map();
  const bridge = {
    platform: "win32",
    backendId: "test-windows-native",
    transportSecurity: "native_memory_only",
    read: async (target) => values.get(target)?.slice(),
    replace: async (target, value) => { values.set(target, value.slice()); },
    delete: async (target) => values.delete(target) ? "deleted" : "absent",
  };
  const backend = createPlatformCredentialBackend({ platform: "win32", windowsBridge: bridge });
  const evidence = await backend.probe();
  assert.equal(evidence.status, "verified");
  assert.equal(evidence.platform, "win32");
  assert.equal(values.size, 0, "probe material must be deleted");
});

test("TC-048-06 native probe cleanup uncertainty revokes backend readiness", async () => {
  const values = new Map();
  let observed;
  const bridge = {
    platform: "win32",
    backendId: "test-windows-native",
    transportSecurity: "native_memory_only",
    read: async (target) => {
      observed = values.get(target)?.slice();
      return observed;
    },
    replace: async (target, value) => { values.set(target, value.slice()); },
    delete: async () => { throw new Error("cleanup unavailable"); },
  };
  const backend = createPlatformCredentialBackend({ platform: "win32", windowsBridge: bridge });
  const evidence = await backend.probe();
  assert.equal(evidence.status, "unavailable");
  assert.match(evidence.reason, /prove probe cleanup/u);
  assert.ok(observed.every((value) => value === 0), "probe copies are wiped before cleanup failure");
});

test("TC-048-18/20 Windows browser handoff uses only the freshly verified native stdin protocol", async () => {
  const url = "https://app.getcuna.com/cli/continue?state=private-test-state";
  let verifierCalls = 0;
  let capturedInput;
  let capturedOutput;
  const native = createNativeBrowserProcessBridge({
    descriptor,
    runtimePlatform: "win32",
    runtimeArchitecture: "x64",
    childIdentityAuthority: admittedChildIdentityAuthority,
    verifier: { verify: async () => { verifierCalls += 1; } },
    runner: { run: async (request) => {
      const lease = await request.beforeStdin({ pid: 42_424, platform: "win32" });
      lease.release();
      assert.deepEqual(request.args, []);
      assert.deepEqual(request.environment, {});
      assert.equal(request.stdin[8], 5);
      assert.equal(Buffer.from(request.stdin).readUInt16BE(9), 0);
      assert.equal(Buffer.from(request.stdin.subarray(15)).toString("utf8"), url);
      capturedInput = request.stdin;
      capturedOutput = response(0);
      return { exitCode: 0, signal: null, stdout: capturedOutput, stderrPresent: false, stdinAdmissionConfirmed: true };
    } },
  });
  await createBrowserOpener("win32", {}, native).open(url);
  assert.equal(verifierCalls, 2);
  assert.ok(capturedInput.every((value) => value === 0));
  assert.ok(capturedOutput.every((value) => value === 0));
});

test("TC-048-18 native browser bridges reject control-bearing and oversized URLs before authority effects", async () => {
  let exchangeCalls = 0;
  const bridge = createNativeBrowserOwnedProcessBridge({
    descriptor,
    runtimePlatform: "win32",
    runtimeArchitecture: "x64",
    verifier: { verify: async () => assert.fail("verifier must not run") },
    authority: {
      platform: "win32",
      authorityKind: "windows-owned-process-spawn",
      exchange: async () => {
        exchangeCalls += 1;
        return assert.fail("authority must not run");
      },
    },
  });
  for (const url of [
    "http://app.getcuna.com/cli/continue",
    "https://app.getcuna.com/cli/continue\n",
    `https://app.getcuna.com/cli/continue?state=${"a".repeat(8_192)}`,
  ]) {
    await assert.rejects(bridge.open(url), /HTTPS/u);
  }
  assert.equal(exchangeCalls, 0);
});

test("TC-048-14 swap-for-spawn and restore-before-check is denied by loaded-image identity", async () => {
  let verifierCalls = 0;
  let stdinReleased = false;
  let childTerminated = false;
  let childAuthorityCalls = 0;
  const bridge = createNativeCredentialProcessBridge({
    descriptor,
    runtimePlatform: "win32",
    runtimeArchitecture: "x64",
    childIdentityAuthority: {
      platform: "win32",
      authorityKind: "windows-owned-process-handle",
      verify: async ({ child }) => {
        childAuthorityCalls += 1;
        // The executable path has already been restored, but the spawned PID still
        // identifies the malicious image loaded during the swap window.
        return {
          observation: childObservation(child, { binarySha256: "e".repeat(64) }),
          release: () => {},
        };
      },
    },
    verifier: {
      verify: async () => {
        verifierCalls += 1;
        // Both path observations see the restored admitted file.
      },
    },
    runner: {
      run: async (request) => {
        try {
          const lease = await request.beforeStdin({ pid: 42_424, platform: "win32" });
          lease.release();
          stdinReleased = true;
          return {
            exitCode: 0,
            signal: null,
            stdout: response(0),
            stderrPresent: false,
            stdinAdmissionConfirmed: true,
          };
        } catch (error) {
          childTerminated = true;
          throw error;
        }
      },
    },
  });
  await assert.rejects(
    bridge.read(credentialTarget),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_backend_unverified",
  );
  assert.equal(verifierCalls, 2);
  assert.equal(childAuthorityCalls, 1);
  assert.equal(stdinReleased, false);
  assert.equal(childTerminated, true);
});

test("TC-048-14 PID reuse cannot satisfy process-instance admission and releases the retained authority once", async () => {
  let releaseCalls = 0;
  let stdinReleased = false;
  const bridge = createNativeCredentialProcessBridge({
    descriptor,
    runtimePlatform: "win32",
    runtimeArchitecture: "x64",
    childIdentityAuthority: {
      platform: "win32",
      authorityKind: "windows-owned-process-handle",
      verify: async ({ child }) => ({
        observation: childObservation(child, {
          pid: child.pid + 1,
          processInstanceId: `reused-process-object-${child.pid}`,
        }),
        release: () => { releaseCalls += 1; },
      }),
    },
    verifier: { verify: async () => {} },
    runner: {
      run: async (request) => {
        await request.beforeStdin({ pid: 42_424, platform: "win32" });
        stdinReleased = true;
        return {
          exitCode: 0,
          signal: null,
          stdout: response(0),
          stderrPresent: false,
          stdinAdmissionConfirmed: true,
        };
      },
    },
  });

  await assert.rejects(
    bridge.read(credentialTarget),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_backend_unverified",
  );
  assert.equal(stdinReleased, false);
  assert.equal(releaseCalls, 1);
});

test("TC-048-14 PID-only identity tokens are rejected before protected stdin", async () => {
  let releaseCalls = 0;
  const bridge = createNativeCredentialProcessBridge({
    descriptor,
    runtimePlatform: "win32",
    runtimeArchitecture: "x64",
    childIdentityAuthority: {
      platform: "win32",
      authorityKind: "windows-owned-process-handle",
      verify: async ({ child }) => ({
        observation: childObservation(child, { processInstanceId: String(child.pid) }),
        release: () => { releaseCalls += 1; },
      }),
    },
    verifier: { verify: async () => {} },
    runner: {
      run: async (request) => {
        await request.beforeStdin({ pid: 42_424, platform: "win32" });
        throw new Error("protected stdin must not be released");
      },
    },
  });
  await assert.rejects(
    bridge.read(credentialTarget),
    (error) => error instanceof CredentialBoundaryError && error.code === "credential_backend_unverified",
  );
  assert.equal(releaseCalls, 1);
});
