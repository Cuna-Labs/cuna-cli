import type { NativeCredentialBridge, SecureCredentialBackend } from "./contracts.js";
import { createLinuxSecretServiceBackend } from "./linux-secret-service.js";
import { createMacOsKeychainBackend } from "./native-bridge-backend.js";
import type { SecureProcessRunner } from "./process-runner.js";
import { createUnavailableCredentialBackend } from "./unavailable-backend.js";
import { createWindowsCredentialManagerBackend } from "./windows-credential-manager.js";

export function createPlatformCredentialBackend(input: {
  readonly platform?: NodeJS.Platform;
  readonly runner?: SecureProcessRunner;
  readonly macOsBridge?: NativeCredentialBridge;
  readonly clock?: () => number;
} = {}): SecureCredentialBackend {
  const platform = input.platform ?? process.platform;
  if (platform === "win32") {
    return createWindowsCredentialManagerBackend({
      ...(input.runner !== undefined && { runner: input.runner }),
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
