import { createHash } from "node:crypto";
import { constants as fileConstants, type BigIntStats } from "node:fs";
import { open, opendir, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import { detectHighConfidenceSecret, type ExclusionPolicy } from "./exclusion.js";
import {
  assertLexicallyInsideRoot,
  assertNoPortableCollisions,
  normalizeWirePath,
  type FilesystemCapabilities,
} from "./paths.js";
import { workspaceError } from "./errors.js";

export interface ContentChunk {
  readonly index: number;
  readonly byteLength: number;
  readonly digest: string;
}

export interface ManifestEntry {
  readonly path: string;
  readonly kind: "directory" | "file" | "symlink";
  readonly byteLength: number;
  readonly executable: boolean;
  readonly contentDigest?: string;
  readonly chunks?: readonly ContentChunk[];
  readonly linkTarget?: string;
}

export interface WorkspaceManifest {
  readonly schemaVersion: 2;
  readonly minimumReaderVersion: 1;
  readonly minimumWriterVersion: 2;
  readonly policyDigest: string;
  readonly manifestRoot: string;
  readonly entryCount: number;
  readonly totalBytes: number;
  readonly excludedCounts: Readonly<Record<string, number>>;
  readonly entries: readonly ManifestEntry[];
}

export interface ManifestLimits {
  readonly maximumEntries: number;
  readonly maximumTotalBytes: number;
  readonly maximumFileBytes: number;
  readonly chunkBytes: number;
}

const DEFAULT_LIMITS: ManifestLimits = Object.freeze({
  maximumEntries: 100_000,
  maximumTotalBytes: 2 * 1024 * 1024 * 1024,
  maximumFileBytes: 512 * 1024 * 1024,
  chunkBytes: 4 * 1024 * 1024,
});

export async function createWorkspaceManifest(input: {
  readonly root: string;
  readonly policy: ExclusionPolicy;
  readonly capabilities: FilesystemCapabilities;
  readonly limits?: Partial<ManifestLimits>;
  readonly allowSafeRelativeSymlinks?: boolean;
  readonly beforeContentRead?: (wirePath: string) => void;
  readonly signal?: AbortSignal;
}): Promise<WorkspaceManifest> {
  input.signal?.throwIfAborted();
  const root = await realpath(input.root);
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...input.limits });
  validateLimits(limits);
  const entries: ManifestEntry[] = [];
  const excludedCounts = new Map<string, number>();
  let totalBytes = 0;

  async function walk(directory: string, parentWirePath: string): Promise<void> {
    input.signal?.throwIfAborted();
    const handle = await opendir(directory);
    const children = [];
    for await (const child of handle) {
      input.signal?.throwIfAborted();
      children.push(child);
    }
    children.sort((left, right) => left.name.normalize("NFC").localeCompare(right.name.normalize("NFC"), "en"));
    for (const child of children) {
      input.signal?.throwIfAborted();
      const wirePath = normalizeWirePath(
        parentWirePath.length === 0 ? child.name : `${parentWirePath}/${child.name}`,
        input.capabilities,
      );
      const physicalPath = assertLexicallyInsideRoot(root, join(directory, child.name));
      const kind = child.isDirectory()
        ? "directory"
        : child.isFile()
          ? "file"
          : child.isSymbolicLink()
            ? "symlink"
            : "special";
      const decision = input.policy.decide(wirePath, kind);
      if (decision.excluded) {
        increment(excludedCounts, decision.reason ?? "user_rule");
        continue;
      }
      if (entries.length >= limits.maximumEntries) throw limitFailure("entry_limit");
      if (kind === "special") {
        throw workspaceError(
          "portability_conflict",
          "A workspace entry kind cannot be represented portably.",
          "unsupported",
          "special_file",
        );
      }
      if (kind === "directory") {
        await verifiedPhysicalParent(root, physicalPath);
        entries.push(Object.freeze({ path: wirePath, kind, byteLength: 0, executable: false }));
        await walk(physicalPath, wirePath);
        continue;
      }
      if (kind === "symlink") {
        const target = await readlink(physicalPath);
        if (!input.allowSafeRelativeSymlinks || !input.capabilities.symlinks) {
          throw workspaceError(
            "portability_conflict",
            "The workspace symlink is not enabled for this filesystem capability tuple.",
            "unsupported",
            "symlink_unsupported",
          );
        }
        if (target.includes("\0") || /^(?:[/\\]|[A-Za-z]:)/u.test(target)) {
          throw workspaceError("path_escape", "The workspace symlink target is unsafe.", "policy", "external_symlink");
        }
        assertLexicallyInsideRoot(root, join(dirname(physicalPath), target));
        const targetBytes = Buffer.byteLength(target, "utf8");
        if (targetBytes > 4_096) throw limitFailure("symlink_limit");
        entries.push(Object.freeze({
          path: wirePath,
          kind,
          byteLength: targetBytes,
          executable: false,
          linkTarget: target.normalize("NFC"),
        }));
        totalBytes += targetBytes;
        continue;
      }
      const hashed = await hashStableFile(physicalPath, wirePath, root, limits, input.beforeContentRead, input.signal);
      totalBytes += hashed.byteLength;
      if (totalBytes > limits.maximumTotalBytes) throw limitFailure("total_bytes_limit");
      entries.push(Object.freeze({
        path: wirePath,
        kind: "file",
        byteLength: hashed.byteLength,
        executable: hashed.executable,
        contentDigest: hashed.contentDigest,
        chunks: Object.freeze(hashed.chunks),
      }));
    }
  }

  await walk(root, "");
  input.signal?.throwIfAborted();
  assertNoPortableCollisions(entries.map((entry) => entry.path), input.capabilities);
  entries.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const manifestRoot = publicProtocolManifestRoot(entries);
  return Object.freeze({
    schemaVersion: 2 as const,
    minimumReaderVersion: 1,
    minimumWriterVersion: 2,
    policyDigest: input.policy.digest,
    manifestRoot,
    entryCount: entries.length,
    totalBytes,
    excludedCounts: Object.freeze(Object.fromEntries([...excludedCounts.entries()].sort())),
    entries: Object.freeze(entries),
  });
}

export async function* streamContentChunks(
  path: string,
  chunkBytes: number,
): AsyncGenerator<{ readonly bytes: Uint8Array; readonly chunk: ContentChunk }> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw limitFailure("invalid_chunk_size");
  const handle = await open(path, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
  try {
    let index = 0;
    for await (const value of handle.createReadStream({ highWaterMark: chunkBytes, autoClose: false })) {
      const bytes = Buffer.from(value as Uint8Array);
      yield Object.freeze({
        bytes,
        chunk: Object.freeze({
          index,
          byteLength: bytes.byteLength,
          digest: createHash("sha256").update(bytes).digest("hex"),
        }),
      });
      index += 1;
    }
  } finally {
    await handle.close();
  }
}

async function hashStableFile(
  physicalPath: string,
  wirePath: string,
  root: string,
  limits: ManifestLimits,
  beforeContentRead?: (wirePath: string) => void,
  signal?: AbortSignal,
): Promise<{
  readonly byteLength: number;
  readonly executable: boolean;
  readonly contentDigest: string;
  readonly chunks: ContentChunk[];
}> {
  const resolvedParent = await verifiedPhysicalParent(root, physicalPath);
  const admittedPath = join(resolvedParent, basename(physicalPath));
  const handle = await open(admittedPath, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
  const before = await handle.stat({ bigint: true });
  if (!before.isFile() || before.nlink > 1n) {
    await handle.close();
    throw workspaceError(
      "snapshot_unstable",
      "The workspace file is unsafe or changed during admission.",
      "integrity",
      before.nlink > 1n ? "hard_link" : "unsafe_type",
    );
  }
  if (before.size > BigInt(limits.maximumFileBytes)) {
    await handle.close();
    throw limitFailure("file_bytes_limit");
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(before, opened)) throw unstableFailure();
    beforeContentRead?.(wirePath);
    signal?.throwIfAborted();
    const contentHash = createHash("sha256").update("cuna-content-v1\0");
    const chunks: ContentChunk[] = [];
    let byteLength = 0;
    let overlap = Buffer.alloc(0);
    let secretCategory: string | undefined;
    for await (const value of handle.createReadStream({ highWaterMark: limits.chunkBytes, autoClose: false, ...(signal === undefined ? {} : { signal }) })) {
      signal?.throwIfAborted();
      const bytes = Buffer.from(value as Uint8Array);
      byteLength += bytes.byteLength;
      if (byteLength > limits.maximumFileBytes) throw limitFailure("file_bytes_limit");
      contentHash.update(bytes);
      chunks.push(Object.freeze({
        index: chunks.length,
        byteLength: bytes.byteLength,
        digest: createHash("sha256").update(bytes).digest("hex"),
      }));
      secretCategory ??= detectHighConfidenceSecret(Buffer.concat([overlap, bytes]));
      overlap = bytes.subarray(Math.max(0, bytes.byteLength - 128));
    }
    // An empty file is one chunk of zero bytes, as the Edge and the database
    // require of every file entry and as the Machine's capture writes it.
    // With no chunk, a folder holding an empty `__init__.py` was refused (422
    // workspace_sync_invalid_request), and an empty file the Machine captured
    // never matched this folder's copy of it.
    if (chunks.length === 0) {
      chunks.push(Object.freeze({ index: 0, byteLength: 0, digest: createHash("sha256").digest("hex") }));
    }
    const after = await handle.stat({ bigint: true });
    const afterParent = await verifiedPhysicalParent(root, admittedPath);
    if (afterParent !== resolvedParent) throw unstableFailure();
    if (!sameIdentity(opened, after) || BigInt(byteLength) !== after.size) throw unstableFailure();
    if (secretCategory !== undefined) {
      throw workspaceError(
        "secret_blocked",
        "A workspace file was blocked by the secret-safety policy.",
        "policy",
        secretCategory,
      );
    }
    return {
      byteLength,
      executable: (Number(after.mode) & 0o111) !== 0,
      contentDigest: contentHash.digest("hex"),
      chunks,
    };
  } finally {
    await handle.close();
  }
}

async function verifiedPhysicalParent(root: string, candidate: string): Promise<string> {
  const parent = await realpath(dirname(candidate));
  const difference = relative(root, parent);
  if (difference === ".." || difference.startsWith(`..${sep}`)) {
    throw workspaceError("path_escape", "A workspace ancestor escapes the canonical root.", "policy", "symlink_escape");
  }
  return parent;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

/**
 * This folder's manifest plus entries a generation carries that the folder
 * deliberately does not hold, rooted exactly as the server roots them.
 *
 * Those entries are paths this folder's exclusion policy excludes but the
 * Machine committed anyway (a supervisor older than the policy-aware capture,
 * BL-7, 2026-10-03). They are carried, not dropped: a generation that left
 * them out would tell the Machine to delete files it alone holds. A carried
 * path the folder also holds is refused, because the two would be one path.
 */
export function withCarriedEntries(
  manifest: WorkspaceManifest,
  carried: readonly ManifestEntry[],
): WorkspaceManifest {
  if (carried.length === 0) return manifest;
  const held = new Set(manifest.entries.map((entry) => entry.path));
  for (const entry of carried) {
    if (held.has(entry.path)) {
      throw workspaceError(
        "portability_conflict",
        "A path the Machine holds outside this folder is also held by this folder.",
        "conflict",
        "carried_path_collision",
      );
    }
    held.add(entry.path);
  }
  const entries = [...manifest.entries, ...carried]
    .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  return Object.freeze({
    ...manifest,
    manifestRoot: publicProtocolManifestRoot(entries),
    entryCount: entries.length,
    totalBytes: manifest.totalBytes + carried.reduce((total, entry) => total + (entry.kind === "file" ? entry.byteLength : 0), 0),
    entries: Object.freeze(entries),
  });
}

function publicProtocolManifestRoot(entries: readonly ManifestEntry[]): string {
  const entryDigests = entries
    .map((entry) => {
      const canonical = JSON.stringify({
        path: entry.path,
        kind: entry.kind,
        byte_length: entry.kind === "symlink" ? 0 : entry.byteLength,
        executable: entry.executable,
        chunks: entry.chunks?.map((chunk) => ({
          digest: chunk.digest,
          byte_length: chunk.byteLength,
        })) ?? [],
        link_target: entry.linkTarget ?? null,
      });
      return Object.freeze({
        path: entry.path,
        digest: createHash("sha256").update(canonical).digest("hex"),
      });
    })
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"))
    );
  return createHash("sha256")
    .update(entryDigests.map((entry) => entry.digest).join(""))
    .digest("hex");
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function validateLimits(limits: ManifestLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw limitFailure("invalid_limits");
  }
}

function limitFailure(reason: string) {
  return workspaceError("resource_limit", "The workspace exceeds a declared resource limit.", "policy", reason);
}

function unstableFailure() {
  return workspaceError(
    "snapshot_unstable",
    "The workspace file changed while it was being admitted.",
    "conflict",
    "file_identity_changed",
  );
}
