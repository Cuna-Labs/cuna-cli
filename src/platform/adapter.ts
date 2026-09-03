import { randomBytes } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";

import { EXIT_CODES, CunaError } from "../core/errors.js";

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
  /**
   * Replace the configuration file's whole contents, owner-only and atomically.
   *
   * The read side is the standard: a file this refuses to read is a file it
   * also refuses to overwrite, checked with the same ownership and permission
   * predicates before the replacement begins. The write itself goes to a
   * sibling temporary file, is fsynced, and is renamed over the target, so a
   * crash or a concurrent reader observes either the previous bytes or the new
   * ones — never a truncated file.
   *
   * The caller supplies the complete text. Merging belongs to the caller
   * (`ensureProfileRecorded` in `config/config.ts`), which parses the current
   * file and preserves every key it already holds.
   */
  writeSafeConfig(path: string, text: string, maximumBytes: number): Promise<void>;
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
  throw new CunaError({
    code: "cuna.platform.unsupported",
    hint: "Run `cuna doctor` to see which runtime features this platform provides.",
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
      configDirectory: win32.join(appData, "Cuna"),
      stateDirectory: win32.join(localAppData, "Cuna", "State"),
      runtimeDirectory: win32.join(localAppData, "Cuna", "Runtime"),
    });
  }
  if (kind === "macos") {
    return Object.freeze({
      configDirectory: posix.join(input.homeDirectory, "Library", "Application Support", "Cuna"),
      stateDirectory: posix.join(input.homeDirectory, "Library", "Application Support", "Cuna", "State"),
      runtimeDirectory: posix.join(input.env.TMPDIR ?? "/tmp", `cuna-${input.userId ?? "user"}`),
    });
  }
  const configRoot = input.env.XDG_CONFIG_HOME ?? posix.join(input.homeDirectory, ".config");
  const stateRoot = input.env.XDG_STATE_HOME ?? posix.join(input.homeDirectory, ".local", "state");
  const runtimeRoot = input.env.XDG_RUNTIME_DIR ?? posix.join(input.homeDirectory, ".local", "run");
  return Object.freeze({
    configDirectory: posix.join(configRoot, "cuna"),
    stateDirectory: posix.join(stateRoot, "cuna"),
    runtimeDirectory: posix.join(runtimeRoot, "cuna"),
  });
}

async function readSafeConfig(
  kind: PlatformKind,
  expectedUserId: number | undefined,
  path: string,
  maximumBytes: number,
): Promise<SafeFileSnapshot> {
  let handle;
  try {
    handle = await open(path, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ exists: false });
    throw configFileError("unreadable", error);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw configFileError("unsafe_type");
    if (metadata.size > maximumBytes) throw configFileError("oversized");
    if (kind !== "windows") {
      if (expectedUserId !== undefined && metadata.uid !== expectedUserId) {
        throw configFileError("wrong_owner");
      }
      if ((metadata.mode & 0o022) !== 0) throw configFileError("unsafe_permissions");
    }
    const text = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(text, "utf8") > maximumBytes) throw configFileError("oversized");
    return Object.freeze({ exists: true, text });
  } catch (error) {
    if (error instanceof CunaError) throw error;
    throw configFileError("unreadable", error);
  } finally {
    await handle.close();
  }
}

/**
 * The predicates `readSafeConfig` enforces, applied to a file that is about to
 * be replaced rather than read. Written once so the two sides cannot drift:
 * a file the CLI would refuse to read must never be a file it silently
 * overwrites. Windows is excluded from the ownership and mode checks here for
 * the same reason it is excluded there — `st_uid` and the POSIX mode bits carry
 * no ACL meaning on that platform, and the encrypted session store owns the
 * only ACL authority in this codebase.
 */
async function assertReplaceableConfigFile(
  kind: PlatformKind,
  expectedUserId: number | undefined,
  path: string,
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw configFileError("unwritable", error);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw configFileError("unsafe_type");
  if (kind !== "windows") {
    if (expectedUserId !== undefined && metadata.uid !== expectedUserId) throw configFileError("wrong_owner");
    if ((metadata.mode & 0o022) !== 0) throw configFileError("unsafe_permissions");
  }
}

async function writeSafeConfig(
  kind: PlatformKind,
  expectedUserId: number | undefined,
  path: string,
  text: string,
  maximumBytes: number,
): Promise<void> {
  if (Buffer.byteLength(text, "utf8") > maximumBytes) throw configFileError("oversized");
  const directory = dirname(path);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw configFileError("unwritable", error);
  }
  await assertReplaceableConfigFile(kind, expectedUserId, path);
  // A sibling in the same directory, so the rename is a same-filesystem atomic
  // replacement rather than a copy. `O_EXCL` means this process never writes
  // through a name another process or a symlink already claimed.
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, fileConstants.O_WRONLY | fileConstants.O_CREAT | fileConstants.O_EXCL, 0o600);
    await handle.writeFile(text, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    try { await handle?.close(); } catch { /* the replacement already failed */ }
    try { await unlink(temporary); } catch { /* the temporary may never have been created */ }
    if (error instanceof CunaError) throw error;
    throw configFileError("unwritable", error);
  }
}

function configFileError(reason: string, cause?: unknown): CunaError {
  return new CunaError({
    code: "cuna.config.unsafe_file",
    message: "The Cuna configuration file is unavailable or unsafe.",
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
    writeSafeConfig: (path, text, maximumBytes) =>
      writeSafeConfig(kind, environment.userId, path, text, maximumBytes),
  };
  return Object.freeze(adapter);
}
