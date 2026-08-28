import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const CUNA_TRANSFER_ROOT = ".cuna-transfers" as const;
export const CUNA_TRANSFER_STAGING_ROOT = ".cuna-transfer-staging" as const;
export const MAX_TRANSFER_FILES = 1_000;
export const MAX_TRANSFER_BYTES = 1024 * 1024 * 1024;

const IDENTIFIER = /^[A-Za-z0-9._:@-]{1,256}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const EXTENSION = /^\.[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/u;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u;

export interface FileSelectArgs {
  readonly purpose: "attachment" | "workspace_import";
  readonly accept: readonly { readonly extension?: string; readonly mediaType?: string }[];
  readonly multiple: boolean;
  readonly maximumFiles: number;
  readonly maximumTotalBytes: number;
}

export interface ArtifactSaveArgs {
  readonly remoteArtifactId: string;
  readonly expectedSha256: string;
  readonly suggestedName: string;
  readonly maximumBytes: number;
}

export interface FileTransferBinding {
  readonly workspaceBindingId: string;
  readonly workspaceBindingGeneration: number;
}

export interface SelectedFileSnapshot {
  readonly opaqueId: string;
  readonly displayName: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly workspaceRelativeSnapshotPath: string;
}

export interface FileSelectionReceipt {
  readonly selectionId: string;
  readonly count: number;
  readonly files: readonly SelectedFileSnapshot[];
}

export interface AttachmentImportReceipt {
  readonly opaqueArtifactId: string;
  readonly digest: string;
}

export interface ArtifactSaveReceipt {
  readonly completed: true;
}

export interface HumanFilePicker {
  selectFiles(args: FileSelectArgs, signal?: AbortSignal): Promise<readonly string[] | null>;
  selectSaveDestination(suggestedName: string, signal?: AbortSignal): Promise<string | null>;
  confirmOverwrite(destinationDisplayName: string, signal?: AbortSignal): Promise<boolean>;
}

export interface SynchronizedArtifact {
  readonly localCopyPath: string;
  readonly workspaceBindingId: string;
  readonly workspaceBindingGeneration: number;
}

export interface SynchronizedArtifactResolver {
  resolve(remoteArtifactId: string, signal?: AbortSignal): Promise<SynchronizedArtifact | null>;
}

export interface FileTransferActionsOptions {
  readonly platform: NodeJS.Platform;
  readonly workspaceRoot: string;
  readonly picker: HumanFilePicker;
  readonly artifacts: SynchronizedArtifactResolver;
  readonly isSyncExcluded: (workspaceRelativePath: string) => boolean | Promise<boolean>;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly beforeSourceRevalidation?: (sourcePath: string) => void | Promise<void>;
  /** A native Windows implementation must replace the Node path implementation. */
  readonly windowsNativeStore?: FileTransferStore;
}

export interface FileTransferStore {
  readonly supported: boolean;
  createSnapshot(input: {
    readonly sourcePath: string;
    readonly binding: FileTransferBinding;
    readonly opaqueId: string;
    readonly maximumBytes: number;
    readonly signal?: AbortSignal;
  }): Promise<SelectedFileSnapshot>;
  verifySnapshot(input: {
    readonly binding: FileTransferBinding;
    readonly opaqueId: string;
    readonly expectedSha256: string;
    readonly maximumBytes: number;
    readonly signal?: AbortSignal;
  }): Promise<SelectedFileSnapshot>;
  saveArtifact(input: {
    readonly sourcePath: string;
    readonly binding: FileTransferBinding;
    readonly expectedSha256: string;
    readonly maximumBytes: number;
    readonly destinationPath: string;
    readonly overwrite: boolean;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  destinationExists(destinationPath: string): Promise<boolean>;
  removeSnapshot(binding: FileTransferBinding, opaqueId: string): Promise<void>;
}

export class FileTransferActions {
  readonly #options: FileTransferActionsOptions;
  readonly #store: FileTransferStore;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #snapshots = new Map<string, { readonly binding: FileTransferBinding; readonly snapshot: SelectedFileSnapshot }>();

  constructor(options: FileTransferActionsOptions) {
    if (!isAbsolute(options.workspaceRoot)) throw new FileTransferError("workspace_root_invalid");
    this.#options = options;
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.#store = options.platform === "win32"
      ? options.windowsNativeStore ?? UNSUPPORTED_STORE
      : new NodePosixFileTransferStore(options.workspaceRoot, options.beforeSourceRevalidation);
  }

  get supported(): boolean {
    return this.#store.supported;
  }

  async selectFiles(
    args: FileSelectArgs,
    binding: FileTransferBinding,
    signal?: AbortSignal,
  ): Promise<FileSelectionReceipt | null> {
    validateSelectArgs(args);
    validateBinding(binding);
    this.#requireSupported();
    const publishedPrefix = `${CUNA_TRANSFER_ROOT}/${binding.workspaceBindingId}`;
    if (await this.#options.isSyncExcluded(publishedPrefix)) throw new FileTransferError("snapshot_path_excluded");
    throwIfAborted(signal);
    const selected = await this.#options.picker.selectFiles(freezeSelectArgs(args), signal);
    if (selected === null || selected.length === 0) return null;
    if ((!args.multiple && selected.length !== 1) || selected.length > args.maximumFiles) {
      throw new FileTransferError("selection_limit_exceeded");
    }
    const created: Array<{ readonly opaqueId: string; readonly snapshot: SelectedFileSnapshot }> = [];
    let remainingBytes = args.maximumTotalBytes;
    try {
      for (const sourcePath of selected) {
        throwIfAborted(signal);
        if (typeof sourcePath !== "string" || !isAbsolute(sourcePath)) throw new FileTransferError("selection_invalid");
        const opaqueId = deriveOpaqueId(binding, this.#randomBytes(16));
        const snapshot = await this.#store.createSnapshot({
          sourcePath,
          binding,
          opaqueId,
          maximumBytes: remainingBytes,
          ...(signal === undefined ? {} : { signal }),
        });
        remainingBytes -= snapshot.byteLength;
        created.push({ opaqueId, snapshot });
      }
    } catch (error) {
      await Promise.allSettled(created.map((item) => this.#store.removeSnapshot(binding, item.opaqueId)));
      throw error;
    }
    for (const item of created) this.#snapshots.set(snapshotKey(binding, item.opaqueId), { binding: freezeBinding(binding), snapshot: item.snapshot });
    const files = Object.freeze(created.map((item) => item.snapshot));
    return Object.freeze({ selectionId: deriveOpaqueId(binding, this.#randomBytes(16)), count: files.length, files });
  }

  async importAttachment(
    args: { readonly opaqueId: string; readonly expectedSha256: string },
    binding: FileTransferBinding,
    signal?: AbortSignal,
  ): Promise<AttachmentImportReceipt> {
    validateBinding(binding);
    if (!IDENTIFIER.test(args.opaqueId) || !DIGEST.test(args.expectedSha256)) throw new FileTransferError("request_invalid");
    this.#requireSupported();
    const registered = this.#snapshots.get(snapshotKey(binding, args.opaqueId));
    if (registered === undefined || !sameBinding(registered.binding, binding) || registered.snapshot.sha256 !== args.expectedSha256) {
      throw new FileTransferError("snapshot_scope_mismatch");
    }
    const verified = await this.#store.verifySnapshot({
      binding,
      opaqueId: args.opaqueId,
      expectedSha256: args.expectedSha256,
      maximumBytes: registered.snapshot.byteLength,
      ...(signal === undefined ? {} : { signal }),
    });
    if (verified.byteLength !== registered.snapshot.byteLength || verified.workspaceRelativeSnapshotPath !== registered.snapshot.workspaceRelativeSnapshotPath) {
      throw new FileTransferError("snapshot_changed");
    }
    return Object.freeze({ opaqueArtifactId: args.opaqueId, digest: args.expectedSha256 });
  }

  async saveArtifact(
    args: ArtifactSaveArgs,
    binding: FileTransferBinding,
    signal?: AbortSignal,
  ): Promise<ArtifactSaveReceipt | null> {
    validateArtifactArgs(args);
    validateBinding(binding);
    this.#requireSupported();
    throwIfAborted(signal);
    const artifact = await this.#options.artifacts.resolve(args.remoteArtifactId, signal);
    if (artifact === null || artifact.workspaceBindingId !== binding.workspaceBindingId ||
      artifact.workspaceBindingGeneration !== binding.workspaceBindingGeneration) {
      throw new FileTransferError("artifact_scope_mismatch");
    }
    // The store verifies the synchronized copy before any Save As UI appears.
    await this.#store.saveArtifact({
      sourcePath: artifact.localCopyPath,
      binding,
      expectedSha256: args.expectedSha256,
      maximumBytes: args.maximumBytes,
      destinationPath: "",
      overwrite: false,
      ...(signal === undefined ? {} : { signal }),
    }).catch((error) => {
      if (error instanceof FileTransferError && error.code === "destination_required") return;
      throw error;
    });
    throwIfAborted(signal);
    const destination = await this.#options.picker.selectSaveDestination(args.suggestedName, signal);
    if (destination === null) return null;
    if (!isAbsolute(destination)) throw new FileTransferError("destination_invalid");
    let overwrite = false;
    if (await this.#store.destinationExists(destination)) {
      overwrite = await this.#options.picker.confirmOverwrite(sanitizeDisplayName(destination), signal);
      if (!overwrite) return null;
    }
    await this.#store.saveArtifact({
      sourcePath: artifact.localCopyPath,
      binding,
      expectedSha256: args.expectedSha256,
      maximumBytes: args.maximumBytes,
      destinationPath: destination,
      overwrite,
      ...(signal === undefined ? {} : { signal }),
    });
    return Object.freeze({ completed: true });
  }

  #requireSupported(): void {
    if (!this.#store.supported) throw new FileTransferError("unsupported");
  }
}

export class NodePosixFileTransferStore implements FileTransferStore {
  readonly supported = process.platform !== "win32";
  readonly #workspaceRoot: string;
  readonly #beforeSourceRevalidation: ((sourcePath: string) => void | Promise<void>) | undefined;

  constructor(workspaceRoot: string, beforeSourceRevalidation?: (sourcePath: string) => void | Promise<void>) {
    this.#workspaceRoot = resolve(workspaceRoot);
    this.#beforeSourceRevalidation = beforeSourceRevalidation;
  }

  async createSnapshot(input: {
    readonly sourcePath: string; readonly binding: FileTransferBinding; readonly opaqueId: string;
    readonly maximumBytes: number; readonly signal?: AbortSignal;
  }): Promise<SelectedFileSnapshot> {
    this.#assertSupported();
    const roots = await this.#roots(input.binding);
    const stagingPath = join(roots.staging, input.opaqueId);
    const publishedPath = join(roots.published, input.opaqueId);
    let published = false;
    try {
      const copied = await copyStableRegularFile(
        input.sourcePath, stagingPath, input.maximumBytes, input.signal, this.#beforeSourceRevalidation,
      );
      await link(stagingPath, publishedPath);
      published = true;
      await unlink(stagingPath);
      return Object.freeze({
        opaqueId: input.opaqueId,
        displayName: sanitizeDisplayName(input.sourcePath),
        byteLength: copied.byteLength,
        sha256: copied.sha256,
        workspaceRelativeSnapshotPath: `${CUNA_TRANSFER_ROOT}/${input.binding.workspaceBindingId}/${input.opaqueId}`,
      });
    } catch (error) {
      await safeUnlink(stagingPath);
      if (published) await safeUnlink(publishedPath);
      throw normalizeFileError(error);
    }
  }

  async verifySnapshot(input: {
    readonly binding: FileTransferBinding; readonly opaqueId: string; readonly expectedSha256: string;
    readonly maximumBytes: number; readonly signal?: AbortSignal;
  }): Promise<SelectedFileSnapshot> {
    this.#assertSupported();
    const roots = await this.#roots(input.binding);
    const sourcePath = join(roots.published, input.opaqueId);
    const verified = await hashStableRegularFile(sourcePath, input.maximumBytes, input.signal);
    if (verified.sha256 !== input.expectedSha256) throw new FileTransferError("snapshot_digest_mismatch");
    return Object.freeze({
      opaqueId: input.opaqueId,
      displayName: input.opaqueId,
      byteLength: verified.byteLength,
      sha256: verified.sha256,
      workspaceRelativeSnapshotPath: `${CUNA_TRANSFER_ROOT}/${input.binding.workspaceBindingId}/${input.opaqueId}`,
    });
  }

  async saveArtifact(input: {
    readonly sourcePath: string; readonly binding: FileTransferBinding; readonly expectedSha256: string;
    readonly maximumBytes: number; readonly destinationPath: string; readonly overwrite: boolean;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    this.#assertSupported();
    const verified = await hashStableRegularFile(input.sourcePath, input.maximumBytes, input.signal);
    if (verified.sha256 !== input.expectedSha256) throw new FileTransferError("artifact_digest_mismatch");
    if (input.destinationPath === "") throw new FileTransferError("destination_required");
    const canonicalParent = await realpath(dirname(input.destinationPath));
    const destinationPath = join(canonicalParent, basename(input.destinationPath));
    const temporaryPath = join(canonicalParent, `.cuna-save-${nodeRandomBytes(16).toString("hex")}`);
    try {
      const copied = await copyStableRegularFile(
        input.sourcePath, temporaryPath, input.maximumBytes, input.signal, this.#beforeSourceRevalidation,
      );
      if (copied.sha256 !== input.expectedSha256) throw new FileTransferError("artifact_digest_mismatch");
      if (input.overwrite) await rename(temporaryPath, destinationPath);
      else {
        await link(temporaryPath, destinationPath);
        await unlink(temporaryPath);
      }
    } catch (error) {
      await safeUnlink(temporaryPath);
      throw normalizeFileError(error);
    }
  }

  async removeSnapshot(binding: FileTransferBinding, opaqueId: string): Promise<void> {
    if (!IDENTIFIER.test(opaqueId)) return;
    const roots = await this.#roots(binding);
    await Promise.allSettled([safeUnlink(join(roots.staging, opaqueId)), safeUnlink(join(roots.published, opaqueId))]);
  }

  async destinationExists(destinationPath: string): Promise<boolean> {
    this.#assertSupported();
    const canonicalParent = await realpath(dirname(destinationPath));
    const candidate = join(canonicalParent, basename(destinationPath));
    try {
      await lstat(candidate);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw normalizeFileError(error);
    }
  }

  async #roots(binding: FileTransferBinding): Promise<{ readonly staging: string; readonly published: string }> {
    const workspace = await realpath(this.#workspaceRoot);
    if (workspace !== this.#workspaceRoot && resolve(workspace) !== resolve(this.#workspaceRoot)) throw new FileTransferError("workspace_root_changed");
    const metadata = await lstat(workspace);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new FileTransferError("workspace_root_unsafe");
    const staging = safeChild(workspace, CUNA_TRANSFER_STAGING_ROOT);
    const transferRoot = safeChild(workspace, CUNA_TRANSFER_ROOT);
    const published = safeChild(transferRoot, binding.workspaceBindingId);
    for (const directory of [staging, transferRoot, published]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const current = await lstat(directory);
      if (!current.isDirectory() || current.isSymbolicLink()) throw new FileTransferError("transfer_root_unsafe");
    }
    return Object.freeze({ staging, published });
  }

  #assertSupported(): void {
    if (!this.supported) throw new FileTransferError("unsupported");
  }
}

export class FileTransferError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(`Cuna file transfer failed: ${code}.`, options);
    this.name = "FileTransferError";
  }
}

const UNSUPPORTED_STORE: FileTransferStore = Object.freeze({
  supported: false,
  async createSnapshot() { throw new FileTransferError("unsupported"); },
  async verifySnapshot() { throw new FileTransferError("unsupported"); },
  async saveArtifact() { throw new FileTransferError("unsupported"); },
  async destinationExists() { throw new FileTransferError("unsupported"); },
  async removeSnapshot() { /* no owned path exists */ },
});

async function copyStableRegularFile(
  sourcePath: string,
  destinationPath: string,
  maximumBytes: number,
  signal?: AbortSignal,
  beforeRevalidation?: (sourcePath: string) => void | Promise<void>,
): Promise<{ readonly byteLength: number; readonly sha256: string }> {
  const beforePath = await lstat(sourcePath, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1n) throw new FileTransferError("source_unsafe_type");
  const source = await open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let destination;
  try {
    const before = await source.stat({ bigint: true });
    assertStableRegular(before, beforePath);
    if (before.size > BigInt(maximumBytes)) throw new FileTransferError("byte_budget_exceeded");
    destination = await open(destinationPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    for (;;) {
      throwIfAborted(signal);
      const read = await source.read(buffer, 0, buffer.byteLength, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
      if (offset > maximumBytes) throw new FileTransferError("byte_budget_exceeded");
      const chunk = buffer.subarray(0, read.bytesRead);
      hash.update(chunk);
      await destination.write(chunk);
    }
    await destination.sync();
    await beforeRevalidation?.(sourcePath);
    const after = await source.stat({ bigint: true });
    const afterPath = await lstat(sourcePath, { bigint: true });
    assertStableRegular(after, before);
    assertStableRegular(afterPath, before);
    if (BigInt(offset) !== before.size) throw new FileTransferError("source_changed");
    return Object.freeze({ byteLength: offset, sha256: hash.digest("hex") });
  } catch (error) {
    throw normalizeFileError(error);
  } finally {
    await Promise.allSettled([source.close(), destination?.close()]);
  }
}

async function hashStableRegularFile(
  sourcePath: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<{ readonly byteLength: number; readonly sha256: string }> {
  const temporary = join(dirname(sourcePath), `.cuna-verify-${nodeRandomBytes(16).toString("hex")}`);
  try {
    return await copyStableRegularFile(sourcePath, temporary, maximumBytes, signal);
  } finally {
    await safeUnlink(temporary);
  }
}

function assertStableRegular(actual: import("node:fs").BigIntStats, expected: import("node:fs").BigIntStats): void {
  if (!actual.isFile() || actual.isSymbolicLink() || actual.nlink !== 1n ||
    actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size ||
    actual.mtimeNs !== expected.mtimeNs || actual.ctimeNs !== expected.ctimeNs) {
    throw new FileTransferError("source_changed");
  }
}

function validateSelectArgs(args: FileSelectArgs): void {
  if ((args.purpose !== "attachment" && args.purpose !== "workspace_import") ||
    typeof args.multiple !== "boolean" || !boundedInteger(args.maximumFiles, 1, MAX_TRANSFER_FILES) ||
    !boundedInteger(args.maximumTotalBytes, 1, MAX_TRANSFER_BYTES) || !Array.isArray(args.accept) || args.accept.length > 64) {
    throw new FileTransferError("request_invalid");
  }
  for (const filter of args.accept) {
    if (typeof filter !== "object" || filter === null || Array.isArray(filter) ||
      Object.keys(filter).some((key) => key !== "extension" && key !== "mediaType") ||
      (filter.extension === undefined && filter.mediaType === undefined) ||
      (filter.extension !== undefined && !EXTENSION.test(filter.extension)) ||
      (filter.mediaType !== undefined && !MEDIA_TYPE.test(filter.mediaType))) throw new FileTransferError("request_invalid");
  }
}

function validateArtifactArgs(args: ArtifactSaveArgs): void {
  if (!IDENTIFIER.test(args.remoteArtifactId) || !DIGEST.test(args.expectedSha256) ||
    sanitizeDisplayName(args.suggestedName) !== args.suggestedName ||
    !boundedInteger(args.maximumBytes, 1, MAX_TRANSFER_BYTES)) throw new FileTransferError("request_invalid");
}

function validateBinding(binding: FileTransferBinding): void {
  if (!IDENTIFIER.test(binding.workspaceBindingId) || !boundedInteger(binding.workspaceBindingGeneration, 1, Number.MAX_SAFE_INTEGER)) {
    throw new FileTransferError("binding_invalid");
  }
}

function deriveOpaqueId(binding: FileTransferBinding, entropy: Uint8Array): string {
  if (entropy.byteLength !== 16) throw new FileTransferError("entropy_invalid");
  return createHash("sha256")
    .update(binding.workspaceBindingId)
    .update("\0")
    .update(String(binding.workspaceBindingGeneration))
    .update("\0")
    .update(entropy)
    .digest("hex");
}

function freezeSelectArgs(args: FileSelectArgs): FileSelectArgs {
  return Object.freeze({ ...args, accept: Object.freeze(args.accept.map((filter) => Object.freeze({ ...filter }))) });
}

function freezeBinding(binding: FileTransferBinding): FileTransferBinding {
  return Object.freeze({ ...binding });
}

function snapshotKey(binding: FileTransferBinding, opaqueId: string): string {
  return `${binding.workspaceBindingId}:${binding.workspaceBindingGeneration}:${opaqueId}`;
}

function sameBinding(left: FileTransferBinding, right: FileTransferBinding): boolean {
  return left.workspaceBindingId === right.workspaceBindingId &&
    left.workspaceBindingGeneration === right.workspaceBindingGeneration;
}

function safeChild(parent: string, child: string): string {
  if (!IDENTIFIER.test(child)) throw new FileTransferError("path_invalid");
  const candidate = resolve(parent, child);
  const relation = relative(parent, candidate);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new FileTransferError("path_escape");
  }
  return candidate;
}

function sanitizeDisplayName(path: string): string {
  const value = [...basename(path)]
    .filter((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point > 31 && point !== 127;
    })
    .join("")
    .slice(0, 255);
  if (value === "" || value === "." || value === "..") return "file";
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FileTransferError("cancelled", { cause: signal.reason });
}

async function safeUnlink(path: string): Promise<void> {
  try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function normalizeFileError(error: unknown): FileTransferError {
  if (error instanceof FileTransferError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ELOOP") return new FileTransferError("source_symlink", { cause: error });
  if (code === "EEXIST") return new FileTransferError("destination_exists", { cause: error });
  return new FileTransferError("io_failure", { cause: error });
}
