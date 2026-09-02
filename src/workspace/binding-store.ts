import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { instantOrNull, sameInstant } from "../core/instant.js";
import { assertPublicId } from "../core/validation.js";
import {
  assertCanonicalWorkspaceRootUnchanged,
  assertPathWithinBoundary,
  captureCanonicalWorkspaceRoot,
  sameCanonicalPath,
  sameWorkspaceRootIdentity,
  type CanonicalWorkspaceRoot,
  type CanonicalWorkspaceRootIdentity,
} from "./binding-path.js";
import { workspaceError } from "./errors.js";
import type { DurableSchemaEnvelope } from "./schema.js";

const METADATA_DIRECTORY = ".cuna";
const BINDING_FILE = "workspace.json";
const RECORD_TYPE = "cuna.workspace-binding.v2";
const MAXIMUM_RECORD_BYTES = 65_536;
const DIGEST = /^[a-f0-9]{64}$/u;
const PROFILE_CONTROL = /[\p{Cc}\p{Cf}]/u;
const TEMPORARY_RECORD = /^\.workspace\.json\.\d+\.[0-9a-f-]{36}\.tmp$/u;

export interface WorkspaceBindingRecord extends DurableSchemaEnvelope {
  readonly recordType: typeof RECORD_TYPE;
  readonly recordRevision: number;
  readonly profileId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly bindingId: string;
  readonly projectId: string;
  readonly localInstanceId: string;
  readonly machineId: string;
  readonly remoteRoot: string;
  readonly policyDigest: string;
  readonly generation: number;
  readonly canonicalLocalRoot: string;
  readonly rootIdentity: CanonicalWorkspaceRootIdentity;
  readonly bindingCreatedAt: string;
  readonly bindingUpdatedAt: string;
  readonly recordCreatedAt: string;
  readonly recordUpdatedAt: string;
  readonly integrityDigest: string;
}

export interface WorkspaceBindingRecordDraft {
  readonly profileId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly bindingId: string;
  readonly projectId: string;
  readonly localInstanceId: string;
  readonly machineId: string;
  readonly remoteRoot: string;
  readonly policyDigest: string;
  readonly generation: number;
  readonly bindingCreatedAt: string;
  readonly bindingUpdatedAt: string;
}

export interface WorkspaceBindingExpectations {
  readonly profileId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly machineId: string;
  readonly remoteRoot: string;
  readonly policyDigest: string;
  readonly generation: number;
  readonly bindingCreatedAt: string;
  readonly bindingUpdatedAt: string;
  readonly bindingId?: string;
}

export interface WorkspaceBindingCompareAndSwap {
  readonly recordRevision: number;
  readonly generation: number;
  readonly integrityDigest: string;
}

export interface WorkspaceBindingMarker {
  readonly workspaceRoot: CanonicalWorkspaceRoot;
  readonly metadataDirectory: string;
  readonly recordPath: string;
}

export interface LoadedWorkspaceBinding {
  readonly marker: WorkspaceBindingMarker;
  readonly record: WorkspaceBindingRecord;
  readonly relocationRequired: boolean;
}

export async function discoverWorkspaceBindingMarker(input: {
  readonly startPath: string;
  readonly boundaryPath?: string;
}): Promise<WorkspaceBindingMarker | undefined> {
  let current = await canonicalStartDirectory(input.startPath);
  const explicitBoundary = input.boundaryPath === undefined
    ? undefined
    : await captureCanonicalWorkspaceRoot(input.boundaryPath);
  if (explicitBoundary !== undefined) assertPathWithinBoundary(explicitBoundary.path, current.path);

  while (true) {
    const marker = await markerAt(current);
    if (marker !== undefined) return marker;
    if (explicitBoundary !== undefined && sameCanonicalPath(current.path, explicitBoundary.path)) return undefined;
    const parentPath = dirname(current.path);
    if (sameCanonicalPath(parentPath, current.path)) return undefined;
    if (explicitBoundary !== undefined) assertPathWithinBoundary(explicitBoundary.path, parentPath);
    const parent = await captureCanonicalWorkspaceRoot(parentPath);
    // Do not silently cross a mount boundary: a parent filesystem is a
    // different physical authority even when it is lexically adjacent.
    if (parent.identity.device !== current.identity.device) return undefined;
    current = parent;
  }
}

export async function loadWorkspaceBinding(input: {
  readonly startPath: string;
  readonly boundaryPath?: string;
  readonly expected: WorkspaceBindingExpectations;
}): Promise<LoadedWorkspaceBinding | undefined> {
  const marker = await discoverWorkspaceBindingMarker({
    startPath: input.startPath,
    ...(input.boundaryPath === undefined ? {} : { boundaryPath: input.boundaryPath }),
  });
  if (marker === undefined) return undefined;
  const record = await readBindingRecord(marker);
  assertExpectedAuthority(record, input.expected);
  const relocationRequired = !sameCanonicalPath(record.canonicalLocalRoot, marker.workspaceRoot.path);
  return Object.freeze({ marker, record, relocationRequired });
}

/**
 * Loads only integrity-checked local intent for the authenticated owner. Remote
 * machine, policy and generation fields remain untrusted until the caller
 * reconciles the complete tuple with the canonical WorkspaceBinding service.
 */
export async function loadWorkspaceBindingIntent(input: {
  readonly startPath: string;
  readonly boundaryPath?: string;
  readonly profileId: string;
  readonly userId: string;
  readonly workspaceId: string;
}): Promise<LoadedWorkspaceBinding | undefined> {
  const marker = await discoverWorkspaceBindingMarker({
    startPath: input.startPath,
    ...(input.boundaryPath === undefined ? {} : { boundaryPath: input.boundaryPath }),
  });
  if (marker === undefined) return undefined;
  const record = await readBindingRecord(marker);
  if (
    record.profileId !== input.profileId ||
    record.userId !== input.userId ||
    record.workspaceId !== input.workspaceId
  ) {
    throw ownerMismatch();
  }
  const relocationRequired = !sameCanonicalPath(record.canonicalLocalRoot, marker.workspaceRoot.path);
  return Object.freeze({ marker, record, relocationRequired });
}

export async function persistWorkspaceBinding(input: {
  readonly root: string;
  readonly binding: WorkspaceBindingRecordDraft;
  readonly expected: WorkspaceBindingCompareAndSwap | null;
  /**
   * The folder is the project; a Machine is disposable. A rebind moves the
   * folder's project onto another Machine under a new WorkspaceBinding, so the
   * binding and machine identities change while the project identity, the
   * owner and the remote root must not. Only a caller that has proven the
   * previous Machine is gone may ask for this; it still requires the exact
   * compare-and-swap of the record it is replacing.
   */
  readonly rebind?: boolean;
  readonly now?: Date;
}): Promise<WorkspaceBindingRecord> {
  const root = await captureCanonicalWorkspaceRoot(input.root);
  const lock = await acquireBindingWriterLock(root.identity);
  try {
    await assertCanonicalWorkspaceRootUnchanged(root);
    const metadataDirectory = await prepareMetadataDirectory(root);
    const marker = Object.freeze({
      workspaceRoot: root,
      metadataDirectory,
      recordPath: join(metadataDirectory, BINDING_FILE),
    });
    const current = await readOptionalBindingRecord(marker);
    assertCompareAndSwap(current, input.expected);
    validateDraft(input.binding);
    if (input.rebind === true) {
      if (current === undefined) throw staleBinding("rebind_without_record");
      assertRebindIdentity(current, input.binding);
    } else if (current !== undefined) {
      assertStableBindingIdentity(current, input.binding);
    }
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) throw corruptRecord("invalid_timestamp");
    if (current !== undefined && now.getTime() < Date.parse(current.recordUpdatedAt)) {
      throw corruptRecord("clock_rollback");
    }
    if (current?.recordRevision === Number.MAX_SAFE_INTEGER) {
      throw staleBinding("record_revision_exhausted");
    }
    // Only a writer that has proven the current CAS may discard a previous
    // uncommitted temporary image. The authoritative retry input recreates the
    // intended next record; readers instead stop and expose recovery_required.
    await cleanInterruptedTemporaryRecords(metadataDirectory);
    const body = createRecordBody(root, input.binding, current, now);
    const record = freezeRecord({ ...body, integrityDigest: digestRecord(body) });
    await atomicCommitRecord(marker, current, record);
    return record;
  } finally {
    await lock.close();
  }
}

export function workspaceBindingCompareAndSwap(
  record: WorkspaceBindingRecord,
): WorkspaceBindingCompareAndSwap {
  return Object.freeze({
    recordRevision: record.recordRevision,
    generation: record.generation,
    integrityDigest: record.integrityDigest,
  });
}

async function canonicalStartDirectory(input: string): Promise<CanonicalWorkspaceRoot> {
  if (input.includes("\0")) throw unsafeStore("start_path_invalid");
  const requested = resolve(input);
  const entry = await lstat(requested);
  if (entry.isSymbolicLink()) throw unsafeStore("start_path_linked");
  if (entry.isDirectory()) return captureCanonicalWorkspaceRoot(requested);
  if (!entry.isFile()) throw unsafeStore("start_path_type");
  const physicalFile = await realpath(requested);
  if (!sameCanonicalPath(physicalFile, requested)) throw unsafeStore("start_path_linked");
  return captureCanonicalWorkspaceRoot(dirname(requested));
}

async function markerAt(root: CanonicalWorkspaceRoot): Promise<WorkspaceBindingMarker | undefined> {
  await assertCanonicalWorkspaceRootUnchanged(root);
  const metadataDirectory = join(root.path, METADATA_DIRECTORY);
  try {
    await assertPrivateDirectory(metadataDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const recordPath = join(metadataDirectory, BINDING_FILE);
  try {
    await assertPrivateRegularFile(recordPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await assertNoInterruptedTemporaryRecords(metadataDirectory);
      return undefined;
    }
    throw error;
  }
  await assertNoInterruptedTemporaryRecords(metadataDirectory);
  await assertCanonicalWorkspaceRootUnchanged(root);
  return Object.freeze({ workspaceRoot: root, metadataDirectory, recordPath });
}

async function readBindingRecord(marker: WorkspaceBindingMarker): Promise<WorkspaceBindingRecord> {
  await assertMarkerAuthority(marker);
  const text = await readSecureTextFile(marker.recordPath);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw corruptRecord("invalid_json");
  }
  const record = decodeRecord(value);
  await assertMarkerAuthority(marker);
  if (!sameWorkspaceRootIdentity(record.rootIdentity, marker.workspaceRoot.identity)) {
    throw ownerMismatch();
  }
  if (
    !sameCanonicalPath(record.canonicalLocalRoot, marker.workspaceRoot.path) &&
    !sameWorkspaceRootIdentity(record.rootIdentity, marker.workspaceRoot.identity)
  ) {
    throw ownerMismatch();
  }
  return record;
}

async function readOptionalBindingRecord(
  marker: WorkspaceBindingMarker,
): Promise<WorkspaceBindingRecord | undefined> {
  try {
    return await readBindingRecord(marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function decodeRecord(value: unknown): WorkspaceBindingRecord {
  try {
    const source = exactObject(value, [
      "schemaVersion", "minimumReaderVersion", "minimumWriterVersion", "recordType",
      "recordRevision", "profileId", "userId", "workspaceId", "bindingId", "projectId",
      "localInstanceId", "machineId", "policyDigest", "generation", "canonicalLocalRoot",
      "rootIdentity", "remoteRoot", "bindingCreatedAt", "bindingUpdatedAt",
      "recordCreatedAt", "recordUpdatedAt", "integrityDigest",
    ]);
    const rootSource = exactObject(source.rootIdentity, [
      "platform", "device", "inode", "birthtimeNanoseconds",
    ]);
    const rootIdentity = Object.freeze({
      platform: oneOf(rootSource.platform, ["windows", "macos", "linux"] as const),
      device: decimal(rootSource.device),
      inode: positiveDecimal(rootSource.inode),
      birthtimeNanoseconds: decimal(rootSource.birthtimeNanoseconds),
    });
    const withoutDigest = {
      schemaVersion: exactInteger(source.schemaVersion, 2, 2),
      minimumReaderVersion: exactInteger(source.minimumReaderVersion, 1, 1),
      minimumWriterVersion: exactInteger(source.minimumWriterVersion, 2, 2),
      recordType: exactString(source.recordType, RECORD_TYPE),
      recordRevision: integer(source.recordRevision, 1),
      profileId: profile(source.profileId),
      userId: publicId(source.userId, "user ID"),
      workspaceId: publicId(source.workspaceId, "workspace ID"),
      bindingId: publicId(source.bindingId, "binding ID"),
      projectId: publicId(source.projectId, "project ID"),
      localInstanceId: publicId(source.localInstanceId, "local instance ID"),
      machineId: publicId(source.machineId, "machine ID"),
      policyDigest: digest(source.policyDigest),
      generation: integer(source.generation, 0),
      canonicalLocalRoot: absolutePath(source.canonicalLocalRoot),
      rootIdentity,
      remoteRoot: nonempty(source.remoteRoot),
      bindingCreatedAt: timestamp(source.bindingCreatedAt),
      bindingUpdatedAt: timestamp(source.bindingUpdatedAt),
      recordCreatedAt: timestamp(source.recordCreatedAt),
      recordUpdatedAt: timestamp(source.recordUpdatedAt),
    };
    if (withoutDigest.remoteRoot !== `/workspace/projects/${withoutDigest.projectId}`) {
      throw new TypeError("remote root mismatch");
    }
    if (
      Date.parse(withoutDigest.bindingUpdatedAt) < Date.parse(withoutDigest.bindingCreatedAt) ||
      Date.parse(withoutDigest.recordUpdatedAt) < Date.parse(withoutDigest.recordCreatedAt)
    ) {
      throw new TypeError("timestamp order");
    }
    const integrityDigest = digest(source.integrityDigest);
    if (digestRecord(withoutDigest) !== integrityDigest) throw new TypeError("integrity mismatch");
    return freezeRecord({ ...withoutDigest, integrityDigest });
  } catch (error) {
    if (isWorkspaceRecordError(error)) throw error;
    throw corruptRecord("record_shape_or_integrity");
  }
}

function validateDraft(draft: WorkspaceBindingRecordDraft): void {
  try {
    profile(draft.profileId);
    publicId(draft.userId, "user ID");
    publicId(draft.workspaceId, "workspace ID");
    publicId(draft.bindingId, "binding ID");
    const projectId = publicId(draft.projectId, "project ID");
    const localInstanceId = publicId(draft.localInstanceId, "local instance ID");
    if (projectId === localInstanceId) throw new TypeError("identity collision");
    publicId(draft.machineId, "machine ID");
    if (draft.remoteRoot !== `/workspace/projects/${projectId}`) throw new TypeError("remote root mismatch");
    digest(draft.policyDigest);
    integer(draft.generation, 0);
    const bindingCreatedAt = timestamp(draft.bindingCreatedAt);
    const bindingUpdatedAt = timestamp(draft.bindingUpdatedAt);
    if (Date.parse(bindingUpdatedAt) < Date.parse(bindingCreatedAt)) throw new TypeError("timestamp order");
  } catch {
    throw corruptRecord("draft_invalid");
  }
}

function assertExpectedAuthority(
  record: WorkspaceBindingRecord,
  expected: WorkspaceBindingExpectations,
): void {
  let normalizedProfile: string;
  try {
    normalizedProfile = profile(expected.profileId);
    publicId(expected.userId, "user ID");
    publicId(expected.workspaceId, "workspace ID");
    publicId(expected.machineId, "machine ID");
    nonempty(expected.remoteRoot);
    digest(expected.policyDigest);
    integer(expected.generation, 0);
    timestamp(expected.bindingCreatedAt);
    timestamp(expected.bindingUpdatedAt);
    if (expected.bindingId !== undefined) publicId(expected.bindingId, "binding ID");
  } catch {
    throw ownerMismatch();
  }
  if (
    record.profileId !== normalizedProfile ||
    record.userId !== expected.userId ||
    record.workspaceId !== expected.workspaceId ||
    record.machineId !== expected.machineId ||
    record.remoteRoot !== expected.remoteRoot ||
    record.policyDigest !== expected.policyDigest ||
    record.generation !== expected.generation ||
    // Instants, not bytes: the left side was copied out of a service response
    // and written to disk, the right side is a fresh service response. They are
    // the same moment rendered twice, and nothing guarantees one renderer.
    !sameInstant(record.bindingCreatedAt, expected.bindingCreatedAt) ||
    !sameInstant(record.bindingUpdatedAt, expected.bindingUpdatedAt) ||
    (expected.bindingId !== undefined && record.bindingId !== expected.bindingId)
  ) {
    throw ownerMismatch();
  }
}

function assertCompareAndSwap(
  current: WorkspaceBindingRecord | undefined,
  expected: WorkspaceBindingCompareAndSwap | null,
): void {
  if (expected === null) {
    if (current !== undefined) throw staleBinding("record_exists");
    return;
  }
  if (
    current === undefined ||
    current.recordRevision !== expected.recordRevision ||
    current.generation !== expected.generation ||
    current.integrityDigest !== expected.integrityDigest
  ) {
    throw staleBinding("compare_and_swap_failed");
  }
}

function assertStableBindingIdentity(
  current: WorkspaceBindingRecord,
  next: WorkspaceBindingRecordDraft,
): void {
  if (
    current.profileId !== profile(next.profileId) ||
    current.userId !== next.userId ||
    current.workspaceId !== next.workspaceId ||
    current.bindingId !== next.bindingId ||
    current.projectId !== next.projectId ||
    current.localInstanceId !== next.localInstanceId ||
    current.machineId !== next.machineId ||
    current.remoteRoot !== next.remoteRoot ||
    !sameInstant(current.bindingCreatedAt, next.bindingCreatedAt) ||
    Date.parse(next.bindingUpdatedAt) < Date.parse(current.bindingUpdatedAt) ||
    next.generation < current.generation
  ) {
    throw ownerMismatch();
  }
}

/**
 * A rebind keeps everything that names the project and changes only what
 * names the Machine and its binding. A "rebind" that lands on the same Machine
 * or the same binding is not a rebind and is refused as an identity error.
 */
function assertRebindIdentity(
  current: WorkspaceBindingRecord,
  next: WorkspaceBindingRecordDraft,
): void {
  if (
    current.profileId !== profile(next.profileId) ||
    current.userId !== next.userId ||
    current.workspaceId !== next.workspaceId ||
    current.projectId !== next.projectId ||
    current.localInstanceId !== next.localInstanceId ||
    current.remoteRoot !== next.remoteRoot ||
    current.machineId === next.machineId ||
    current.bindingId === next.bindingId
  ) {
    throw ownerMismatch();
  }
}

function createRecordBody(
  root: CanonicalWorkspaceRoot,
  draft: WorkspaceBindingRecordDraft,
  current: WorkspaceBindingRecord | undefined,
  now: Date,
) {
  return Object.freeze({
    schemaVersion: 2 as const,
    minimumReaderVersion: 1 as const,
    minimumWriterVersion: 2 as const,
    recordType: RECORD_TYPE,
    recordRevision: (current?.recordRevision ?? 0) + 1,
    profileId: profile(draft.profileId),
    userId: draft.userId,
    workspaceId: draft.workspaceId,
    bindingId: draft.bindingId,
    projectId: draft.projectId,
    localInstanceId: draft.localInstanceId,
    machineId: draft.machineId,
    policyDigest: draft.policyDigest,
    generation: draft.generation,
    canonicalLocalRoot: root.path,
    rootIdentity: root.identity,
    remoteRoot: draft.remoteRoot,
    bindingCreatedAt: draft.bindingCreatedAt,
    bindingUpdatedAt: draft.bindingUpdatedAt,
    recordCreatedAt: current?.recordCreatedAt ?? now.toISOString(),
    recordUpdatedAt: now.toISOString(),
  });
}

async function atomicCommitRecord(
  marker: WorkspaceBindingMarker,
  previous: WorkspaceBindingRecord | undefined,
  record: WorkspaceBindingRecord,
): Promise<void> {
  const temporaryPath = join(
    marker.metadataDirectory,
    `.workspace.json.${process.pid}.${randomUUID()}.tmp`,
  );
  const bytes = Buffer.from(JSON.stringify(record), "utf8");
  if (bytes.byteLength > MAXIMUM_RECORD_BYTES) throw corruptRecord("record_too_large");
  let handle;
  try {
    handle = await open(
      temporaryPath,
      fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_WRONLY | noFollowFlag(),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await assertSecureHandle(handle, temporaryPath, false);
    await handle.close();
    handle = undefined;
    await assertMarkerAuthority(marker);
    const observed = await readOptionalBindingRecord(marker);
    if (
      (previous === undefined && observed !== undefined) ||
      (previous !== undefined && observed?.integrityDigest !== previous.integrityDigest)
    ) {
      throw staleBinding("record_changed_before_commit");
    }
    await rename(temporaryPath, marker.recordPath);
    await chmod(marker.recordPath, 0o600);
    await syncDirectory(marker.metadataDirectory);
    const committed = await readBindingRecord(marker);
    if (committed.integrityDigest !== record.integrityDigest) {
      throw corruptRecord("commit_verification_failed");
    }
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function prepareMetadataDirectory(root: CanonicalWorkspaceRoot): Promise<string> {
  await assertCanonicalWorkspaceRootUnchanged(root);
  const path = join(root.path, METADATA_DIRECTORY);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertOwnedPhysicalDirectory(path);
  await chmod(path, 0o700);
  await assertPrivateDirectory(path);
  await assertCanonicalWorkspaceRootUnchanged(root);
  return path;
}

async function cleanInterruptedTemporaryRecords(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    if (!TEMPORARY_RECORD.test(name)) continue;
    const path = join(directory, name);
    await assertPrivateRegularFile(path);
    await unlink(path);
  }
}

async function assertNoInterruptedTemporaryRecords(directory: string): Promise<void> {
  if ((await readdir(directory)).some((name) => TEMPORARY_RECORD.test(name))) {
    throw workspaceError(
      "binding_recovery_required",
      "The local workspace binding has an interrupted atomic update.",
      "conflict",
      "interrupted_commit",
    );
  }
}

async function assertMarkerAuthority(marker: WorkspaceBindingMarker): Promise<void> {
  await assertCanonicalWorkspaceRootUnchanged(marker.workspaceRoot);
  await assertPrivateDirectory(marker.metadataDirectory);
  assertPathWithinBoundary(marker.workspaceRoot.path, marker.metadataDirectory);
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const entry = await assertOwnedPhysicalDirectory(path);
  assertPrivateOwnerAndMode(entry.uid, entry.mode, "metadata_directory_permissions");
}

async function assertOwnedPhysicalDirectory(path: string) {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw unsafeStore("metadata_directory_untrusted");
  const canonical = await realpath(path);
  if (!sameCanonicalPath(canonical, path)) throw unsafeStore("metadata_directory_untrusted");
  if (process.platform !== "win32") {
    const currentUid = process.getuid?.();
    if (currentUid === undefined || entry.uid !== currentUid) {
      throw unsafeStore("metadata_directory_owner");
    }
  }
  return entry;
}

async function assertPrivateRegularFile(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    throw unsafeStore("record_file_untrusted");
  }
  if (entry.size > MAXIMUM_RECORD_BYTES) throw corruptRecord("record_too_large");
  assertPrivateOwnerAndMode(entry.uid, entry.mode, "record_file_permissions");
}

function assertPrivateOwnerAndMode(uid: number, mode: number, reason: string): void {
  if (process.platform === "win32") return;
  const currentUid = process.getuid?.();
  if (currentUid === undefined || uid !== currentUid || (mode & 0o077) !== 0) {
    throw unsafeStore(reason);
  }
}

async function readSecureTextFile(path: string): Promise<string> {
  await assertPrivateRegularFile(path);
  const handle = await open(path, fileConstants.O_RDONLY | noFollowFlag());
  try {
    await assertSecureHandle(handle, path, true);
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAXIMUM_RECORD_BYTES) throw corruptRecord("record_too_large");
    await assertSecureHandle(handle, path, true);
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function assertSecureHandle(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
  requirePrivate: boolean,
): Promise<void> {
  const opened = await handle.stat();
  const linked = await lstat(path);
  if (
    !opened.isFile() || opened.nlink !== 1 ||
    !linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 1 ||
    opened.dev !== linked.dev || opened.ino !== linked.ino
  ) {
    throw unsafeStore("record_identity_changed");
  }
  if (requirePrivate) assertPrivateOwnerAndMode(linked.uid, linked.mode, "record_file_permissions");
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, fileConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

interface BindingWriterLock {
  readonly server: Server;
  close(): Promise<void>;
}

async function acquireBindingWriterLock(
  identity: CanonicalWorkspaceRootIdentity,
): Promise<BindingWriterLock> {
  const endpoint = await bindingLockEndpoint(identity);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const server = createServer((socket) => socket.destroy());
    try {
      await listen(server, endpoint);
      return bindingWriterLock(server);
    } catch (error) {
      await closeUnboundServer(server);
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      if (process.platform === "win32" || await unixSocketIsActive(endpoint)) {
        throw workspaceError(
          "workspace_busy",
          "Another process owns the workspace binding writer lock.",
          "conflict",
          "active_writer",
        );
      }
      await quarantineStaleSocket(endpoint);
    }
  }
  throw workspaceError(
    "workspace_busy",
    "Another process owns the workspace binding writer lock.",
    "conflict",
    "active_writer",
  );
}

async function bindingLockEndpoint(identity: CanonicalWorkspaceRootIdentity): Promise<string> {
  const digest = createHash("sha256")
    .update("cuna-workspace-binding-lock-v1\0")
    .update(JSON.stringify(identity))
    .digest("hex");
  if (process.platform === "win32") return `\\\\.\\pipe\\cuna-workspace-binding-${digest}`;
  const base = await realpath(tmpdir());
  const uid = process.getuid?.();
  if (uid === undefined) throw unsafeStore("lock_identity_unavailable");
  const directory = join(base, `.cuna-${uid}`);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertOwnedPhysicalDirectory(directory);
  await chmod(directory, 0o700);
  await assertPrivateDirectory(directory);
  return join(directory, `binding-${digest.slice(0, 32)}.sock`);
}

async function listen(server: Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

function bindingWriterLock(server: Server): BindingWriterLock {
  let closed = false;
  return Object.freeze({
    server,
    close: async (): Promise<void> => {
      if (closed) return;
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
      });
      // Node removes a Unix-domain socket pathname while closing the server.
      // Never unlink after the close callback: another writer may already have
      // rebound that pathname, and deleting it would orphan an active lock.
      closed = true;
    },
  });
}

async function unixSocketIsActive(endpoint: string): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    const socket = createConnection(endpoint);
    socket.once("connect", () => {
      socket.destroy();
      resolveProbe(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolveProbe(error.code !== "ECONNREFUSED" && error.code !== "ENOENT");
    });
  });
}

async function quarantineStaleSocket(endpoint: string): Promise<void> {
  const stale = `${endpoint}.stale-${process.pid}-${randomUUID()}`;
  try {
    const entry = await lstat(endpoint);
    if (!entry.isSocket() || entry.isSymbolicLink()) throw unsafeStore("lock_endpoint_untrusted");
    await rename(endpoint, stale);
    await unlink(stale);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function closeUnboundServer(server: Server): Promise<void> {
  if (server.listening) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

function noFollowFlag(): number {
  return typeof fileConstants.O_NOFOLLOW === "number" ? fileConstants.O_NOFOLLOW : 0;
}

function digestRecord(record: Omit<WorkspaceBindingRecord, "integrityDigest">): string {
  return createHash("sha256")
    .update("cuna-workspace-binding-record-v2\0")
    .update(JSON.stringify(record))
    .digest("hex");
}

function freezeRecord(record: WorkspaceBindingRecord): WorkspaceBindingRecord {
  return Object.freeze({ ...record, rootIdentity: Object.freeze({ ...record.rootIdentity }) });
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("object");
  const source = value as Record<string, unknown>;
  const actual = Object.keys(source).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError("keys");
  }
  return source;
}

function exactString<T extends string>(value: unknown, expected: T): T {
  if (value !== expected) throw new TypeError("string");
  return expected;
}

function nonempty(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || value.includes("\0")) {
    throw new TypeError("string");
  }
  return value;
}

function profile(value: unknown): string {
  const text = nonempty(value);
  if (Buffer.byteLength(text, "utf8") > 256 || PROFILE_CONTROL.test(text) || text !== text.normalize("NFC")) {
    throw new TypeError("profile");
  }
  return text;
}

function publicId(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(label);
  return assertPublicId(value, label);
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new TypeError("digest");
  return value;
}

function decimal(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new TypeError("decimal");
  return value;
}

function positiveDecimal(value: unknown): string {
  const text = decimal(value);
  if (text === "0") throw new TypeError("positive decimal");
  return text;
}

function integer(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new TypeError("integer");
  return value as number;
}

function exactInteger(value: unknown, minimum: number, maximum: number): number {
  const result = integer(value, minimum);
  if (result > maximum) throw new TypeError("integer");
  return result;
}

/**
 * An instant in any encoding a conforming service may emit.
 *
 * This used to require `new Date(text).toISOString() === text`, which is not a
 * validity check — it is an equality against ONE encoding, the one JavaScript
 * happens to render. `bindingCreatedAt` and `bindingUpdatedAt` are the
 * service's, forwarded out of Postgres verbatim, so they arrive with up to six
 * fractional digits and an explicit `+00:00`. Measured against production
 * 2026-08-18:
 *
 *   bindingCreatedAt  2026-08-18T19:55:47.437071+00:00   six digits
 *   bindingUpdatedAt  2026-08-18T20:01:57.89766+00:00    five, trailing zero trimmed
 *
 * The check could therefore never pass on a server-minted value, and
 * `cuna claude` failed for every user, every time, with
 * `binding_corrupt / draft_invalid` — a message that accuses the LOCAL record
 * of corruption when the local record was a faithful copy of what the service
 * sent.
 *
 * Still rejected: anything unparseable, and anything with no explicit offset,
 * which `Date.parse` would silently read in the host's local zone.
 */
function timestamp(value: unknown): string {
  const text = nonempty(value);
  if (instantOrNull(text) === null) throw new TypeError("timestamp");
  return text;
}

function absolutePath(value: unknown): string {
  const text = nonempty(value);
  if (!isAbsolute(text)) throw new TypeError("path");
  return text;
}

function oneOf<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) throw new TypeError("enum");
  return value as T[number];
}

function isWorkspaceRecordError(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("cuna.workspace.");
}

function corruptRecord(reason: string) {
  return workspaceError(
    "binding_corrupt",
    "The local workspace binding record is malformed or corrupt.",
    "integrity",
    reason,
  );
}

function ownerMismatch() {
  return workspaceError(
    "identity_unproven",
    "Workspace binding identity could not be proven.",
    "policy",
    "binding_owner_mismatch",
  );
}

function staleBinding(reason: string) {
  return workspaceError(
    "binding_stale",
    "The workspace binding changed before the local update could commit.",
    "conflict",
    reason,
  );
}

function unsafeStore(reason: string) {
  return workspaceError(
    "binding_store_unsafe",
    "The local workspace binding store is unsafe.",
    "policy",
    reason,
  );
}
