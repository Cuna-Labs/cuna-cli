import { lstat, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import { EXIT_CODES, RunaError } from "../core/errors.js";

export type PlatformKind = "windows" | "macos" | "linux";

export interface PlatformPaths {
  readonly configDirectory: string;
  readonly stateDirectory: string;
  readonly runtimeDirectory: string;
}

export interface SafeFileSnapshot {
  readonly exists: boolean;
  readonly text?: string;
}

export interface PlatformAdapter {
  readonly kind: PlatformKind;
  readonly paths: PlatformPaths;
  readSafeConfig(path: string, maximumBytes: number): Promise<SafeFileSnapshot>;
}

export interface PlatformEnvironment {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly userId?: number;
}

export function resolvePlatformKind(platform: NodeJS.Platform): PlatformKind {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  throw new RunaError({
    code: "runa.platform.unsupported",
    message: `The ${platform} operating system is not supported.`,
    exitCode: EXIT_CODES.unsupported,
    details: { platform },
  });
}

export function resolvePlatformPaths(input: PlatformEnvironment): PlatformPaths {
  const kind = resolvePlatformKind(input.platform);
  if (kind === "windows") {
    const appData = input.env.APPDATA ?? win32.join(input.homeDirectory, "AppData", "Roaming");
    const localAppData = input.env.LOCALAPPDATA ?? win32.join(input.homeDirectory, "AppData", "Local");
    return Object.freeze({
      configDirectory: win32.join(appData, "Runa"),
      stateDirectory: win32.join(localAppData, "Runa", "State"),
      runtimeDirectory: win32.join(localAppData, "Runa", "Runtime"),
    });
  }
  if (kind === "macos") {
    return Object.freeze({
      configDirectory: posix.join(input.homeDirectory, "Library", "Application Support", "Runa"),
      stateDirectory: posix.join(input.homeDirectory, "Library", "Application Support", "Runa", "State"),
      runtimeDirectory: posix.join(input.env.TMPDIR ?? "/tmp", `runa-${input.userId ?? "user"}`),
    });
  }
  const configRoot = input.env.XDG_CONFIG_HOME ?? posix.join(input.homeDirectory, ".config");
  const stateRoot = input.env.XDG_STATE_HOME ?? posix.join(input.homeDirectory, ".local", "state");
  const runtimeRoot = input.env.XDG_RUNTIME_DIR ?? posix.join(input.homeDirectory, ".local", "run");
  return Object.freeze({
    configDirectory: posix.join(configRoot, "runa"),
    stateDirectory: posix.join(stateRoot, "runa"),
    runtimeDirectory: posix.join(runtimeRoot, "runa"),
  });
}

async function readSafeConfig(
  kind: PlatformKind,
  expectedUserId: number | undefined,
  path: string,
  maximumBytes: number,
): Promise<SafeFileSnapshot> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ exists: false });
    throw configFileError("unreadable", error);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw configFileError("unsafe_type");
  }
  if (metadata.size > maximumBytes) throw configFileError("oversized");
  if (kind !== "windows") {
    const current = await stat(path);
    if (expectedUserId !== undefined && current.uid !== expectedUserId) {
      throw configFileError("wrong_owner");
    }
    if ((current.mode & 0o022) !== 0) throw configFileError("unsafe_permissions");
  }
  try {
    const text = await readFile(path, { encoding: "utf8" });
    if (Buffer.byteLength(text, "utf8") > maximumBytes) throw configFileError("oversized");
    return Object.freeze({ exists: true, text });
  } catch (error) {
    if (error instanceof RunaError) throw error;
    throw configFileError("unreadable", error);
  }
}

function configFileError(reason: string, cause?: unknown): RunaError {
  return new RunaError({
    code: "runa.config.unsafe_file",
    message: "The Runa configuration file is unavailable or unsafe.",
    exitCode: EXIT_CODES.policy,
    hint: "Fix the user-owned configuration file permissions or select a safe file explicitly.",
    details: { reason },
    ...(cause === undefined ? {} : { cause }),
  });
}

export function createPlatformAdapter(input?: Partial<PlatformEnvironment>): PlatformAdapter {
  const environment: PlatformEnvironment = {
    platform: input?.platform ?? process.platform,
    env: input?.env ?? process.env,
    homeDirectory: input?.homeDirectory ?? homedir(),
    ...(input?.userId === undefined
      ? typeof process.getuid === "function"
        ? { userId: process.getuid() }
        : {}
      : { userId: input.userId }),
  };
  const kind = resolvePlatformKind(environment.platform);
  const paths = resolvePlatformPaths(environment);
  const adapter: PlatformAdapter = {
    kind,
    paths,
    readSafeConfig: (path, maximumBytes) =>
      readSafeConfig(kind, environment.userId, path, maximumBytes),
  };
  return Object.freeze(adapter);
}
