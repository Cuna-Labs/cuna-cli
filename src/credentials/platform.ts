import type { NativeCredentialBridge, SecureCredentialBackend } from "./contracts.js";
import { CredentialBoundaryError } from "./errors.js";
import { createLinuxSecretServiceBackend } from "./linux-secret-service.js";
import { createMacOsKeychainBackend, createNativeBridgeBackend } from "./native-bridge-backend.js";
import type { NativeBrowserProcessBridge } from "./native-process-bridge.js";
import { createProductionNativeAuthBridges, type ProductionNativeAuthBridges } from "./native-production.js";
import type { SecureProcessRunner } from "./process-runner.js";
import { createUnavailableCredentialBackend } from "./unavailable-backend.js";

export function createPlatformCredentialBackend(input: {
  readonly platform?: NodeJS.Platform;
  readonly runner?: SecureProcessRunner;
  readonly windowsBridge?: NativeCredentialBridge;
  readonly macOsBridge?: NativeCredentialBridge;
  readonly clock?: () => number;
} = {}): SecureCredentialBackend {
  const platform = input.platform ?? process.platform;
  if (platform === "win32") {
    return createNativeBridgeBackend({
      platform,
      ...(input.windowsBridge !== undefined && { bridge: input.windowsBridge }),
      ...(input.clock !== undefined && { clock: input.clock }),
    });
  }
  if (platform === "linux") {
    return createLinuxSecretServiceBackend({
      ...(input.runner !== undefined && { runner: input.runner }),
      ...(input.clock !== undefined && { clock: input.clock }),
    });
  }
  if (platform === "darwin") {
    return createMacOsKeychainBackend({
      ...(input.macOsBridge !== undefined && { bridge: input.macOsBridge }),
      ...(input.clock !== undefined && { clock: input.clock }),
    });
  }
  return createUnavailableCredentialBackend({
    backendId: "unsupported-secure-vault",
    platform,
    reason: "This operating system has no approved secure credential adapter.",
    ...(input.clock !== undefined && { clock: input.clock }),
  });
}

/**
 * The platform authority the CLI actually runs on, resolved once.
 *
 * `createPlatformCredentialBackend` is synchronous, so it cannot itself load
 * the signed native package; on Windows and macOS it therefore returns an
 * unavailable backend whenever a bridge is not handed to it. Nothing in `src/`
 * ever handed it one — `createProductionNativeAuthBridges` was called only from
 * `test/` — so every authenticated command failed on those two platforms with
 * `credential_backend_unavailable` and a reason that named no cause.
 *
 * Resolution happens here, exactly once per process, and feeds BOTH consumers
 * of the native authority: the credential vault and the Windows browser opener.
 * They were two separate unwired call sites of one resolution; wiring only the
 * first would have left the second to be rediscovered later.
 *
 * When the native package is absent this still fails closed — that is the
 * point — but it now carries the admission error's own message forward as the
 * backend `reason`, so `cuna doctor` and any failing command can say which of
 * "not installed", "not admitted for this release", "identity does not match"
 * or "could not be loaded" actually happened.
 */
export interface ResolvedPlatformAuthority {
  readonly credentials: SecureCredentialBackend;
  readonly browserBridge: NativeBrowserProcessBridge | undefined;
}

export async function resolvePlatformAuthority(input: {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readonly runner?: SecureProcessRunner;
  readonly windowsBridge?: NativeCredentialBridge;
  readonly macOsBridge?: NativeCredentialBridge;
  readonly clock?: () => number;
  readonly nativeBridges?: typeof createProductionNativeAuthBridges;
} = {}): Promise<ResolvedPlatformAuthority> {
  const platform = input.platform ?? process.platform;
  const supplied = platform === "win32" ? input.windowsBridge : platform === "darwin" ? input.macOsBridge : undefined;
  if ((platform !== "win32" && platform !== "darwin") || supplied !== undefined) {
    return Object.freeze({ credentials: createPlatformCredentialBackend(input), browserBridge: undefined });
  }
  let bridges: ProductionNativeAuthBridges | undefined;
  try {
    bridges = await (input.nativeBridges ?? createProductionNativeAuthBridges)({
      runtimePlatform: platform,
      ...(input.architecture !== undefined && { runtimeArchitecture: input.architecture }),
    });
  } catch (error) {
    // Never fall back to a working-looking backend: an unverified native
    // authority is exactly the thing this admission path exists to refuse.
    return Object.freeze({
      credentials: createUnavailableCredentialBackend({
        backendId: platform === "win32" ? "windows-native-vault-required" : "macos-keychain",
        platform,
        reason: error instanceof CredentialBoundaryError
          ? error.message
          : "The admitted native authentication package could not be resolved.",
        ...(input.clock !== undefined && { clock: input.clock }),
      }),
      browserBridge: undefined,
    });
  }
  if (bridges === undefined) {
    return Object.freeze({ credentials: createPlatformCredentialBackend(input), browserBridge: undefined });
  }
  return Object.freeze({
    credentials: createPlatformCredentialBackend({
      ...input,
      platform,
      ...(platform === "win32"
        ? { windowsBridge: bridges.credentialBridge }
        : { macOsBridge: bridges.credentialBridge }),
    }),
    browserBridge: bridges.browserBridge,
  });
}
