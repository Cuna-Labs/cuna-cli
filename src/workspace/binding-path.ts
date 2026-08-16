import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { workspaceError } from "./errors.js";

export type WorkspaceRootPlatform = "windows" | "macos" | "linux";

export interface CanonicalWorkspaceRootIdentity {
  readonly platform: WorkspaceRootPlatform;
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNanoseconds: string;
}

export interface CanonicalWorkspaceRoot {
  readonly path: string;
  readonly identity: CanonicalWorkspaceRootIdentity;
}

export async function captureCanonicalWorkspaceRoot(input: string): Promise<CanonicalWorkspaceRoot> {
  if (input.includes("\0") || /^(?:\\\\[.?]\\|\/dev\/)/u.test(input)) {
    throw unsafeRoot("device_path");
  }
  const requested = resolve(input);
  if (!isAbsolute(requested)) throw unsafeRoot("not_absolute");
  await assertPhysicalPathComponents(requested);
  const canonical = await realpath(requested);
  if (!sameCanonicalPath(canonical, requested)) throw unsafeRoot("linked_component");
  const before = await lstat(canonical, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw unsafeRoot("unsafe_type");
  const confirmed = await realpath(canonical);
  const after = await lstat(canonical, { bigint: true });
  if (
    !sameCanonicalPath(confirmed, canonical) ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.birthtimeNs !== after.birthtimeNs
  ) {
    throw unsafeRoot("identity_changed");
  }
  if (after.ino <= 0n) throw unsafeRoot("identity_unavailable");
  return Object.freeze({
    path: canonical,
    identity: Object.freeze({
      platform: runtimeWorkspacePlatform(),
      device: after.dev.toString(10),
      inode: after.ino.toString(10),
      birthtimeNanoseconds: after.birthtimeNs.toString(10),
    }),
  });
}

export async function assertCanonicalWorkspaceRootUnchanged(
  expected: CanonicalWorkspaceRoot,
): Promise<void> {
  const observed = await captureCanonicalWorkspaceRoot(expected.path);
  if (!sameWorkspaceRootIdentity(observed.identity, expected.identity)) {
    throw unsafeRoot("identity_changed");
  }
}

export function sameWorkspaceRootIdentity(
  left: CanonicalWorkspaceRootIdentity,
  right: CanonicalWorkspaceRootIdentity,
): boolean {
  return left.platform === right.platform &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNanoseconds === right.birthtimeNanoseconds;
}

export function sameCanonicalPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

export function assertPathWithinBoundary(boundary: string, candidate: string): void {
  const difference = relative(resolve(boundary), resolve(candidate));
  if (difference === ".." || difference.startsWith(`..${sep}`) || isAbsolute(difference)) {
    throw workspaceError(
      "root_unsafe",
      "The workspace root is outside the permitted discovery boundary.",
      "policy",
      "boundary_escape",
    );
  }
}

async function assertPhysicalPathComponents(path: string): Promise<void> {
  const parsed = parse(path);
  let current = parsed.root;
  await assertPlainDirectory(current);
  const components = path.slice(parsed.root.length).split(/[\\/]+/u).filter(Boolean);
  for (const component of components) {
    current = join(current, component);
    await assertPlainDirectory(current);
  }
}

async function assertPlainDirectory(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw unsafeRoot("linked_component");
  const canonical = await realpath(path);
  if (!sameCanonicalPath(canonical, path)) throw unsafeRoot("linked_component");
}

function runtimeWorkspacePlatform(): WorkspaceRootPlatform {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

function unsafeRoot(reason: string) {
  return workspaceError("root_unsafe", "The workspace root is unsafe.", "policy", reason);
}
