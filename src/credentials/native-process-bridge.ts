import { posix, win32 } from "node:path";

import type { NativeCredentialBridge } from "./contracts.js";
import { credentialFailure } from "./errors.js";
import {
  createSecureProcessRunner,
  type SecureProcessRunner,
  type SecureSpawnedProcessIdentity,
  type SecureStdinAdmissionLease,
} from "./process-runner.js";

const REQUEST_MAGIC = Buffer.from("RUNANV01", "ascii");
const RESPONSE_MAGIC = Buffer.from("RUNANR01", "ascii");
const RESPONSE_HEADER_BYTES = 13;
const MAXIMUM_TARGET_BYTES = 512;
const MAXIMUM_PAYLOAD_BYTES = 8 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const CREDENTIAL_TARGET = /^runa-cli:v1:[0-9a-f]{64}$/u;
const FINGERPRINT = /^[0-9A-F]{40,128}$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;

const operation = Object.freeze({ read: 2, replace: 3, delete: 4, openBrowser: 5 } as const);

export interface NativeBridgeDescriptor {
  readonly protocol: "runa.native-bridge.v1";
  readonly platform: "win32" | "darwin";
  readonly architecture: "x64" | "arm64";
  readonly packageVersion: string;
  readonly nativeVersion: string;
  readonly fileVersion: string;
  readonly executable: string;
  readonly workingDirectory: string;
  readonly manifestPath: string;
  readonly maximumCredentialBytes: number;
  readonly binarySha256: string;
  readonly manifestSha256: string;
  readonly sbomSha256: string;
  readonly provenanceSha256: string;
  readonly signature:
    | { readonly kind: "authenticode"; readonly publisherCertificateFingerprint: string }
    | { readonly kind: "developer_id_notarized"; readonly publisherCertificateFingerprint: string };
}

export interface NativeBridgeInvocationVerifier {
  /** Re-open and verify the exact executable identity immediately before every invocation. */
  verify(descriptor: NativeBridgeDescriptor): Promise<void>;
}

export interface NativeChildIdentityObservation {
  readonly pid: number;
  readonly platform: "win32" | "darwin";
  readonly architecture: "x64" | "arm64";
  readonly executable: string;
  readonly binarySha256: string;
  readonly fileVersion: string;
  /** True only when the authority inspected the loaded image of this live process instance. */
  readonly loadedImageVerified: true;
  /** True only when the authority held an OS process identity that prevents PID-reuse ambiguity. */
  readonly processInstanceVerified: true;
  /** Opaque OS process-object identity; never derived from PID alone. */
  readonly processInstanceId: string;
}

export interface NativeChildIdentityAdmission extends SecureStdinAdmissionLease {
  readonly observation: NativeChildIdentityObservation;
}

export interface NativeChildIdentityAuthority {
  readonly platform: "win32" | "darwin";
  readonly authorityKind: "windows-owned-process-handle" | "darwin-audit-token";
  /**
   * Inspect the already-created OS process, not the executable path. The returned
   * observation is independently compared with the admitted descriptor before stdin.
   */
  verify(input: {
    readonly child: SecureSpawnedProcessIdentity;
    readonly expected: NativeBridgeDescriptor;
  }): Promise<NativeChildIdentityAdmission>;
}

export interface NativeBrowserProcessBridge {
  readonly platform: "win32" | "darwin";
  open(url: string): Promise<void>;
}

export interface NativeOwnedBridgeExchangeResult {
  readonly exitCode: number;
  readonly signal: null;
  readonly stdout: Uint8Array;
  readonly stderrPresent: boolean;
  readonly cleanupProven: true;
  readonly observation: NativeChildIdentityObservation;
}

/**
 * Production authority for protected native exchange. Unlike the injectable
 * PID observer used by hermetic tests, this boundary owns process creation and
 * retains the OS process object from creation through verified stdin delivery
 * and termination. A PID accepted after another component spawned the process
 * does not implement this contract.
 */
export interface NativeOwnedBridgeExchangeAuthority {
  readonly platform: "win32" | "darwin";
  readonly authorityKind: "windows-owned-process-spawn" | "darwin-owned-process-spawn";
  exchange(input: {
    readonly expected: NativeBridgeDescriptor;
    readonly request: Uint8Array;
    readonly timeoutMs: number;
    readonly maximumOutputBytes: number;
  }): Promise<NativeOwnedBridgeExchangeResult>;
}

export function createNativeCredentialProcessBridge(input: {
  readonly descriptor: NativeBridgeDescriptor;
  readonly verifier: NativeBridgeInvocationVerifier;
  readonly childIdentityAuthority: NativeChildIdentityAuthority;
  readonly runner?: SecureProcessRunner;
  readonly runtimePlatform?: NodeJS.Platform;
  readonly runtimeArchitecture?: NodeJS.Architecture;
}): NativeCredentialBridge {
  validateDescriptor(
    input.descriptor,
    input.runtimePlatform ?? process.platform,
    input.runtimeArchitecture ?? process.arch,
  );
  validateChildIdentityAuthority(input.descriptor, input.childIdentityAuthority);
  const invoke = createInvoker({ ...input, childIdentityAuthority: input.childIdentityAuthority });

  return Object.freeze({
    platform: input.descriptor.platform,
    backendId: input.descriptor.platform === "win32"
      ? "windows-credential-manager-native"
      : "macos-keychain-native",
    transportSecurity: "native_memory_only",
    read: async (target: string) => {
      const response = await invoke(operation.read, target);
      if (response.status === 1) {
        response.payload.fill(0);
        return undefined;
      }
      assertSuccess(response.status);
      return response.payload;
    },
    replace: async (target: string, protectedValue: Uint8Array) => {
      if (
        protectedValue.byteLength < 1 ||
        protectedValue.byteLength > input.descriptor.maximumCredentialBytes
      ) {
        throw credentialFailure(
          "credential_corrupt",
          "The protected credential exceeds the admitted native capacity.",
        );
      }
      const response = await invoke(operation.replace, target, protectedValue);
      try {
        assertSuccess(response.status);
        if (response.payload.byteLength !== 0) throw corruptResponse();
      } finally {
        response.payload.fill(0);
      }
    },
    delete: async (target: string) => {
      const response = await invoke(operation.delete, target);
      try {
        if (response.status === 1) return "absent";
        assertSuccess(response.status);
        if (response.payload.byteLength !== 0) throw corruptResponse();
        return "deleted";
      } finally {
        response.payload.fill(0);
      }
    },
  });
}

export function createNativeBrowserProcessBridge(input: {
  readonly descriptor: NativeBridgeDescriptor;
  readonly verifier: NativeBridgeInvocationVerifier;
  readonly childIdentityAuthority: NativeChildIdentityAuthority;
  readonly runner?: SecureProcessRunner;
  readonly runtimePlatform?: NodeJS.Platform;
  readonly runtimeArchitecture?: NodeJS.Architecture;
}): NativeBrowserProcessBridge {
  validateDescriptor(
    input.descriptor,
    input.runtimePlatform ?? process.platform,
    input.runtimeArchitecture ?? process.arch,
  );
  validateChildIdentityAuthority(input.descriptor, input.childIdentityAuthority);
  const invoke = createInvoker({ ...input, childIdentityAuthority: input.childIdentityAuthority });
  return Object.freeze({
    platform: input.descriptor.platform,
    open: async (url: string) => {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || url.includes("\0")) {
        throw new TypeError("Browser continuation URL must use HTTPS.");
      }
      const payload = Buffer.from(url, "utf8");
      try {
        const response = await invoke(operation.openBrowser, "", payload, true);
        try {
          assertSuccess(response.status);
          if (response.payload.byteLength !== 0) throw corruptResponse();
        } finally {
          response.payload.fill(0);
        }
      } finally {
        payload.fill(0);
      }
    },
  });
}

export function createNativeCredentialOwnedProcessBridge(input: {
  readonly descriptor: NativeBridgeDescriptor;
  readonly verifier: NativeBridgeInvocationVerifier;
  readonly authority: NativeOwnedBridgeExchangeAuthority;
  readonly runtimePlatform?: NodeJS.Platform;
  readonly runtimeArchitecture?: NodeJS.Architecture;
}): NativeCredentialBridge {
  validateDescriptor(
    input.descriptor,
    input.runtimePlatform ?? process.platform,
    input.runtimeArchitecture ?? process.arch,
  );
  validateOwnedAuthority(input.descriptor, input.authority);
  const invoke = createOwnedInvoker(input);
  return Object.freeze({
    platform: input.descriptor.platform,
    backendId: input.descriptor.platform === "win32"
      ? "windows-credential-manager-native"
      : "macos-keychain-native",
    transportSecurity: "native_memory_only",
    read: async (target: string) => {
      const response = await invoke(operation.read, target);
      if (response.status === 1) {
        response.payload.fill(0);
        return undefined;
      }
      assertSuccess(response.status);
      return response.payload;
    },
    replace: async (target: string, protectedValue: Uint8Array) => {
      if (protectedValue.byteLength < 1 ||
          protectedValue.byteLength > input.descriptor.maximumCredentialBytes) {
        throw credentialFailure(
          "credential_corrupt",
          "The protected credential exceeds the admitted native capacity.",
        );
      }
      const response = await invoke(operation.replace, target, protectedValue);
      try {
        assertSuccess(response.status);
        if (response.payload.byteLength !== 0) throw corruptResponse();
      } finally {
        response.payload.fill(0);
      }
    },
    delete: async (target: string) => {
      const response = await invoke(operation.delete, target);
      try {
        if (response.status === 1) return "absent";
        assertSuccess(response.status);
        if (response.payload.byteLength !== 0) throw corruptResponse();
        return "deleted";
      } finally {
        response.payload.fill(0);
      }
    },
  });
}

export function createNativeBrowserOwnedProcessBridge(input: {
  readonly descriptor: NativeBridgeDescriptor;
  readonly verifier: NativeBridgeInvocationVerifier;
  readonly authority: NativeOwnedBridgeExchangeAuthority;
  readonly runtimePlatform?: NodeJS.Platform;
  readonly runtimeArchitecture?: NodeJS.Architecture;
}): NativeBrowserProcessBridge {
  validateDescriptor(
    input.descriptor,
    input.runtimePlatform ?? process.platform,
    input.runtimeArchitecture ?? process.arch,
  );
  validateOwnedAuthority(input.descriptor, input.authority);
  const invoke = createOwnedInvoker(input);
  return Object.freeze({
    platform: input.descriptor.platform,
    open: async (url: string) => {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || url.includes("\0")) {
        throw new TypeError("Browser continuation URL must use HTTPS.");
      }
      const payload = Buffer.from(url, "utf8");
      try {
        const response = await invoke(operation.openBrowser, "", payload, true);
        try {
          assertSuccess(response.status);
          if (response.payload.byteLength !== 0) throw corruptResponse();
        } finally {
          response.payload.fill(0);
        }
      } finally {
        payload.fill(0);
      }
    },
  });
}

function createOwnedInvoker(input: {
  readonly descriptor: NativeBridgeDescriptor;
  readonly verifier: NativeBridgeInvocationVerifier;
  readonly authority: NativeOwnedBridgeExchangeAuthority;
}) {
  return async function invoke(
    code: number,
    target: string,
    payload: Uint8Array = new Uint8Array(),
    allowEmptyTarget = false,
  ): Promise<{ readonly status: number; readonly payload: Uint8Array }> {
    const request = encodeRequest(code, target, payload, allowEmptyTarget);
    try {
      await verifyFresh(input.verifier, input.descriptor);
      const result = await input.authority.exchange({
        expected: input.descriptor,
        request,
        timeoutMs: 15_000,
        maximumOutputBytes: MAXIMUM_PAYLOAD_BYTES + RESPONSE_HEADER_BYTES,
      });
      try {
        validateOwnedExchangeResult(result, input.descriptor);
        return decodeResponse(result.stdout);
      } finally {
        result.stdout.fill(0);
      }
    } finally {
      request.fill(0);
    }
  };
}

function validateOwnedAuthority(
  descriptor: NativeBridgeDescriptor,
  authority: NativeOwnedBridgeExchangeAuthority | undefined,
): void {
  if (authority === undefined || authority.platform !== descriptor.platform ||
      (descriptor.platform === "win32" && authority.authorityKind !== "windows-owned-process-spawn") ||
      (descriptor.platform === "darwin" && authority.authorityKind !== "darwin-owned-process-spawn")) {
    throw childIdentityUnavailable();
  }
}

function validateOwnedExchangeResult(
  result: NativeOwnedBridgeExchangeResult,
  descriptor: NativeBridgeDescriptor,
): void {
  const observed = result.observation;
  const pathAuthority = descriptor.platform === "win32" ? win32 : posix;
  const expectedExecutable = descriptor.platform === "win32"
    ? pathAuthority.normalize(descriptor.executable).toLowerCase()
    : pathAuthority.normalize(descriptor.executable);
  const observedExecutable = descriptor.platform === "win32"
    ? pathAuthority.normalize(observed.executable).toLowerCase()
    : pathAuthority.normalize(observed.executable);
  if (result.exitCode !== 0 || result.signal !== null || result.stderrPresent ||
      result.cleanupProven !== true || observed.platform !== descriptor.platform ||
      observed.architecture !== descriptor.architecture || observedExecutable !== expectedExecutable ||
      observed.binarySha256 !== descriptor.binarySha256 || observed.fileVersion !== descriptor.fileVersion ||
      observed.loadedImageVerified !== true || observed.processInstanceVerified !== true ||
      typeof observed.processInstanceId !== "string" || observed.processInstanceId.length < 16 ||
      observed.processInstanceId.length > 256 || /[\r\n\0]/u.test(observed.processInstanceId)) {
    throw childIdentityUnavailable();
  }
}

function createInvoker(input: {
  readonly descriptor: NativeBridgeDescriptor;
  readonly verifier: NativeBridgeInvocationVerifier;
  readonly childIdentityAuthority: NativeChildIdentityAuthority;
  readonly runner?: SecureProcessRunner;
}) {
  const runner = input.runner ?? createSecureProcessRunner();
  return async function invoke(
    code: number,
    target: string,
    payload: Uint8Array = new Uint8Array(),
    allowEmptyTarget = false,
  ): Promise<{ readonly status: number; readonly payload: Uint8Array }> {
    const request = encodeRequest(code, target, payload, allowEmptyTarget);
    try {
      await verifyFresh(input.verifier, input.descriptor);
      const result = await runner.run({
        executable: input.descriptor.executable,
        args: [],
        cwd: input.descriptor.workingDirectory,
        stdin: request,
        environment: {},
        timeoutMs: 15_000,
        maximumOutputBytes: MAXIMUM_PAYLOAD_BYTES + RESPONSE_HEADER_BYTES,
        beforeStdin: async (child) => {
          // A fresh path observation remains useful defense-in-depth, but it cannot
          // identify the image already loaded by the spawned process.
          await verifyFresh(input.verifier, input.descriptor);
          return await verifySpawnedChild(
            input.childIdentityAuthority,
            child,
            input.descriptor,
          );
        },
      });
      try {
        if (
          result.stdinAdmissionConfirmed !== true ||
          result.exitCode !== 0 ||
          result.signal !== null ||
          result.stderrPresent
        ) {
          throw credentialFailure(
            "credential_process_failed",
            "The native bridge did not complete the closed protocol.",
          );
        }
        return decodeResponse(result.stdout);
      } finally {
        result.stdout.fill(0);
      }
    } finally {
      request.fill(0);
    }
  };
}

function validateDescriptor(
  descriptor: NativeBridgeDescriptor,
  runtimePlatform: NodeJS.Platform,
  runtimeArchitecture: NodeJS.Architecture,
): void {
  const pathAuthority = descriptor.platform === "win32" ? win32 : posix;
  if (
    descriptor.protocol !== "runa.native-bridge.v1" ||
    descriptor.platform !== runtimePlatform ||
    descriptor.architecture !== runtimeArchitecture ||
    !VERSION.test(descriptor.packageVersion) ||
    !VERSION.test(descriptor.nativeVersion) ||
    !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(descriptor.fileVersion) ||
    !pathAuthority.isAbsolute(descriptor.executable) ||
    !pathAuthority.isAbsolute(descriptor.workingDirectory) ||
    !pathAuthority.isAbsolute(descriptor.manifestPath) ||
    pathAuthority.dirname(descriptor.executable) !== pathAuthority.normalize(descriptor.workingDirectory) ||
    pathAuthority.dirname(descriptor.manifestPath) !== pathAuthority.normalize(descriptor.workingDirectory) ||
    !Number.isSafeInteger(descriptor.maximumCredentialBytes) ||
    descriptor.maximumCredentialBytes < 1 ||
    descriptor.maximumCredentialBytes > MAXIMUM_PAYLOAD_BYTES ||
    (descriptor.platform === "win32" && descriptor.maximumCredentialBytes !== 2_560) ||
    descriptor.executable.includes("\0") ||
    descriptor.workingDirectory.includes("\0") ||
    !SHA256.test(descriptor.binarySha256) ||
    !SHA256.test(descriptor.manifestSha256) ||
    !SHA256.test(descriptor.sbomSha256) ||
    !SHA256.test(descriptor.provenanceSha256) ||
    !FINGERPRINT.test(descriptor.signature.publisherCertificateFingerprint) ||
    (descriptor.platform === "win32" && descriptor.signature.kind !== "authenticode") ||
    (descriptor.platform === "darwin" && descriptor.signature.kind !== "developer_id_notarized")
  ) {
    throw credentialFailure(
      "credential_backend_unverified",
      "The native credential bridge descriptor is not admissible.",
    );
  }
}

function validateChildIdentityAuthority(
  descriptor: NativeBridgeDescriptor,
  authority: NativeChildIdentityAuthority | undefined,
): void {
  if (
    authority === undefined ||
    authority.platform !== descriptor.platform ||
    (descriptor.platform === "win32" &&
      authority.authorityKind !== "windows-owned-process-handle") ||
    (descriptor.platform === "darwin" && authority.authorityKind !== "darwin-audit-token")
  ) throw childIdentityUnavailable();
}

async function verifyFresh(
  verifier: NativeBridgeInvocationVerifier,
  descriptor: NativeBridgeDescriptor,
): Promise<void> {
  try {
    await verifier.verify(descriptor);
  } catch {
    throw credentialFailure(
      "credential_backend_unverified",
      "The native credential bridge identity could not be verified.",
    );
  }
}

async function verifySpawnedChild(
  authority: NativeChildIdentityAuthority,
  child: SecureSpawnedProcessIdentity,
  descriptor: NativeBridgeDescriptor,
): Promise<SecureStdinAdmissionLease> {
  let admission: NativeChildIdentityAdmission | undefined;
  try {
    if (
      authority.platform !== descriptor.platform ||
      (descriptor.platform === "win32" &&
        authority.authorityKind !== "windows-owned-process-handle") ||
      (descriptor.platform === "darwin" && authority.authorityKind !== "darwin-audit-token")
    ) throw childIdentityUnavailable();
    admission = await authority.verify({ child, expected: descriptor });
    const observed = admission.observation;
    const pathAuthority = descriptor.platform === "win32" ? win32 : posix;
    const expectedExecutable = descriptor.platform === "win32"
      ? pathAuthority.normalize(descriptor.executable).toLowerCase()
      : pathAuthority.normalize(descriptor.executable);
    const observedExecutable = descriptor.platform === "win32"
      ? pathAuthority.normalize(observed.executable).toLowerCase()
      : pathAuthority.normalize(observed.executable);
    if (
      observed.pid !== child.pid ||
      child.platform !== descriptor.platform ||
      observed.platform !== descriptor.platform ||
      observed.architecture !== descriptor.architecture ||
      observedExecutable !== expectedExecutable ||
      observed.binarySha256 !== descriptor.binarySha256 ||
      observed.fileVersion !== descriptor.fileVersion ||
      observed.loadedImageVerified !== true ||
      observed.processInstanceVerified !== true ||
      typeof observed.processInstanceId !== "string" ||
      observed.processInstanceId.length < 16 ||
      observed.processInstanceId.length > 256 ||
      /[\r\n\0]/u.test(observed.processInstanceId) ||
      typeof admission.release !== "function"
    ) throw childIdentityUnavailable();
    const retainedAdmission = admission;
    let released = false;
    return Object.freeze({
      release: () => {
        if (released) return;
        released = true;
        retainedAdmission.release();
      },
    });
  } catch {
    try {
      admission?.release();
    } catch {
      // The public result remains fail-closed regardless of cleanup detail.
    }
    throw childIdentityUnavailable();
  }
}

function childIdentityUnavailable() {
  return credentialFailure(
    "credential_backend_unverified",
    "The spawned native bridge process image could not be bound to the admitted signed artifact.",
  );
}

function encodeRequest(
  code: number,
  target: string,
  payload: Uint8Array,
  allowEmptyTarget = false,
): Uint8Array {
  const targetBytes = Buffer.from(target, "ascii");
  if (
    (!allowEmptyTarget && target.length === 0) ||
    (!allowEmptyTarget && !CREDENTIAL_TARGET.test(target)) ||
    target.includes("\0") ||
    (target.length > 0 && !/^[\x20-\x7e]+$/u.test(target)) ||
    targetBytes.byteLength > MAXIMUM_TARGET_BYTES ||
    payload.byteLength > MAXIMUM_PAYLOAD_BYTES
  ) {
    targetBytes.fill(0);
    throw credentialFailure("credential_binding_invalid", "The native credential target is invalid.");
  }
  const request = Buffer.alloc(15 + targetBytes.byteLength + payload.byteLength);
  REQUEST_MAGIC.copy(request, 0);
  request[8] = code;
  request.writeUInt16BE(targetBytes.byteLength, 9);
  request.writeUInt32BE(payload.byteLength, 11);
  targetBytes.copy(request, 15);
  request.set(payload, 15 + targetBytes.byteLength);
  targetBytes.fill(0);
  return request;
}

function decodeResponse(bytes: Uint8Array): { readonly status: number; readonly payload: Uint8Array } {
  if (bytes.byteLength < RESPONSE_HEADER_BYTES) throw corruptResponse();
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!view.subarray(0, 8).equals(RESPONSE_MAGIC)) throw corruptResponse();
  const status = view[8] ?? 255;
  if (status > 7) throw corruptResponse();
  const payloadLength = view.readUInt32BE(9);
  if (
    payloadLength > MAXIMUM_PAYLOAD_BYTES ||
    bytes.byteLength !== RESPONSE_HEADER_BYTES + payloadLength ||
    (status !== 0 && payloadLength !== 0)
  ) {
    throw corruptResponse();
  }
  return { status, payload: Uint8Array.from(view.subarray(RESPONSE_HEADER_BYTES)) };
}

function assertSuccess(status: number): void {
  if (status === 0) return;
  if (status === 2) {
    throw credentialFailure("credential_backend_failure", "The operating system denied credential access.");
  }
  if (status === 3) {
    throw credentialFailure("credential_backend_unavailable", "The native credential service is unavailable.");
  }
  if (status === 4) {
    throw credentialFailure("credential_backend_unverified", "The native credential protocol is incompatible.");
  }
  if (status === 5 || status === 6) throw corruptResponse();
  throw credentialFailure("credential_process_failed", "The native credential operation failed.");
}

function corruptResponse() {
  return credentialFailure("credential_corrupt", "The native credential bridge returned an invalid response.");
}
