import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import type { HttpTransport } from "../api/http.js";
import { EXIT_CODES, CunaError } from "../core/errors.js";
import { assertCanonicalUuid } from "../core/validation.js";
import { compileExclusionPolicy, type ExclusionRuleSource } from "../workspace/exclusion.js";
import { createWorkspaceManifest, type ManifestLimits } from "../workspace/manifest.js";
import type { FilesystemCapabilities } from "../workspace/paths.js";
import { createWorkspaceSyncClient } from "./workspace-sync-client.js";
import {
  ContinuousWorkspaceSyncSupervisor,
  type ContinuousSyncAuthority,
} from "./continuous-sync-supervisor.js";
import {
  FileWorkspaceSyncCheckpointStore,
  WorkspaceSyncCoordinator,
  createFilesystemChunkSource,
  type WorkspaceSyncProgress,
} from "./workspace-sync-coordinator.js";
import { WORKSPACE_SYNC_PROTOCOL } from "./workspace-sync-protocol.js";

const MAX_POLICY_BYTES = 1_048_576;

/**
 * The caller must only brand a transport after selecting a real API-key or
 * interactive credential authority. Keeping this explicit prevents the
 * product service from silently accepting an anonymous transport.
 */
export interface AuthenticatedWorkspaceSyncTransport extends HttpTransport {
  readonly authentication: "authenticated";
  readonly credentialAuthority: "api_key" | "interactive";
}

export interface SynchronizeLocalWorkspaceInput {
  readonly localRoot: string;
  readonly workspaceId: string;
  readonly workspaceBindingId: string;
  readonly machineId: string;
  readonly baseGeneration: number;
  readonly transport: AuthenticatedWorkspaceSyncTransport;
  /** A caller-owned secure state root. A non-secret binding directory is derived below it. */
  readonly checkpointRoot: string;
  readonly filesystemCapabilities: FilesystemCapabilities;
  readonly manifestLimits?: Partial<ManifestLimits>;
  readonly allowSafeRelativeSymlinks?: boolean;
  readonly maximumConcurrentUploads?: number;
  readonly maximumAttempts?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: WorkspaceSyncProgress) => void;
}

export interface WorkspaceSyncProductReceipt {
  readonly phase: "committed";
  readonly bytes: number;
  readonly files: number;
  readonly entries: number;
  readonly generation: number;
  readonly manifest_root: string;
  readonly exclusion_policy_digest: string;
  readonly selected_protocol: 1 | 2;
}

export interface StartContinuousWorkspaceSyncInput extends SynchronizeLocalWorkspaceInput {
  readonly initialReceipt: WorkspaceSyncProductReceipt;
}

export interface WorkspaceSyncPolicyInspection {
  readonly canonicalRoot: string;
  readonly exclusionPolicyDigest: string;
}

/** Safe policy-only preflight used to bind the exact policy before transfer. */
export async function inspectWorkspaceSyncPolicy(input: {
  readonly localRoot: string;
  readonly filesystemCapabilities: FilesystemCapabilities;
}): Promise<WorkspaceSyncPolicyInspection> {
  const root = await canonicalWorkspaceRoot(input.localRoot);
  const policy = compileExclusionPolicy(
    await readProjectExclusionPolicy(root),
    input.filesystemCapabilities,
  );
  return Object.freeze({ canonicalRoot: root, exclusionPolicyDigest: policy.digest });
}

/**
 * Composes project policy, a content-addressed manifest, durable recovery and
 * the authenticated public protocol. It returns facts, never estimated
 * progress, local paths, credential material, or policy contents.
 */
export async function synchronizeLocalWorkspace(
  input: SynchronizeLocalWorkspaceInput,
): Promise<WorkspaceSyncProductReceipt> {
  try {
    validateAuthority(input);
    const workspaceId = assertCanonicalUuid(input.workspaceId, "workspace ID");
    const workspaceBindingId = assertCanonicalUuid(input.workspaceBindingId, "workspace binding ID");
    if (workspaceBindingId === workspaceId) throw invalidInput("workspace_binding_id_domain");
    const machineId = assertCanonicalUuid(input.machineId, "machine ID");
    if (!Number.isSafeInteger(input.baseGeneration) || input.baseGeneration < 0) {
      throw invalidInput("base_generation");
    }

    const root = await canonicalWorkspaceRoot(input.localRoot);
    const checkpointRoot = await canonicalCheckpointRoot(input.checkpointRoot, root);
    const checkpointDirectory = join(checkpointRoot, checkpointIntentDigest(
      workspaceId, workspaceBindingId, machineId, input.baseGeneration,
    ));
    await assertSafeDerivedCheckpoint(checkpointDirectory, root);

    const policy = compileExclusionPolicy(
      await readProjectExclusionPolicy(root),
      input.filesystemCapabilities,
    );
    const manifest = await createWorkspaceManifest({
      root,
      policy,
      capabilities: input.filesystemCapabilities,
      ...(input.manifestLimits === undefined ? {} : { limits: input.manifestLimits }),
      ...(input.allowSafeRelativeSymlinks === undefined
        ? {}
        : { allowSafeRelativeSymlinks: input.allowSafeRelativeSymlinks }),
    });
    const checkpointStore = new FileWorkspaceSyncCheckpointStore(checkpointDirectory);
    const coordinator = new WorkspaceSyncCoordinator({
      client: createWorkspaceSyncClient(input.transport),
      checkpointStore,
      chunkSource: await createFilesystemChunkSource(root, manifest),
      ...(input.maximumConcurrentUploads === undefined
        ? {}
        : { maximumConcurrentUploads: input.maximumConcurrentUploads }),
      ...(input.maximumAttempts === undefined ? {} : { maximumAttempts: input.maximumAttempts }),
      ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    });
    const receipt = await coordinator.synchronize({
      workspaceId,
      workspaceBindingId,
      machineId,
      baseGeneration: input.baseGeneration,
      manifest,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const checkpoint = await checkpointStore.load();
    if (checkpoint?.phase !== "committed" || checkpoint.sync_id === null) {
      throw unexpectedFailure();
    }

    return Object.freeze({
      phase: "committed" as const,
      bytes: manifest.totalBytes,
      files: manifest.entries.filter((entry) => entry.kind === "file").length,
      entries: manifest.entryCount,
      generation: receipt.generation,
      manifest_root: receipt.manifest_root,
      exclusion_policy_digest: manifest.policyDigest,
      selected_protocol: receipt.selected_protocol,
    });
  } catch (error) {
    if (error instanceof CunaError) throw error;
    throw unexpectedFailure();
  }
}

/**
 * Starts the sole live writer for one foreground WorkspaceBinding. The initial
 * immutable upload remains the admission boundary; this function refuses to
 * start unless the exact committed manifest can be reproduced locally.
 */
export async function startContinuousWorkspaceSync(
  input: StartContinuousWorkspaceSyncInput,
): Promise<ContinuousWorkspaceSyncSupervisor> {
  validateAuthority(input);
  const workspaceId = assertCanonicalUuid(input.workspaceId, "workspace ID");
  const workspaceBindingId = assertCanonicalUuid(input.workspaceBindingId, "workspace binding ID");
  if (workspaceBindingId === workspaceId) throw invalidInput("workspace_binding_id_domain");
  const machineId = assertCanonicalUuid(input.machineId, "machine ID");
  if (!Number.isSafeInteger(input.baseGeneration) || input.baseGeneration < 0) {
    throw invalidInput("base_generation");
  }
  const root = await canonicalWorkspaceRoot(input.localRoot);
  const checkpointRoot = await canonicalCheckpointRoot(input.checkpointRoot, root);
  const policy = compileExclusionPolicy(
    await readProjectExclusionPolicy(root),
    input.filesystemCapabilities,
  );
  const initialManifest = await createWorkspaceManifest({
    root,
    policy,
    capabilities: input.filesystemCapabilities,
    ...(input.manifestLimits === undefined ? {} : { limits: input.manifestLimits }),
    ...(input.allowSafeRelativeSymlinks === undefined
      ? {}
      : { allowSafeRelativeSymlinks: input.allowSafeRelativeSymlinks }),
  });
  if (
    initialManifest.manifestRoot !== input.initialReceipt.manifest_root ||
    initialManifest.policyDigest !== input.initialReceipt.exclusion_policy_digest ||
    input.initialReceipt.generation < 1
  ) {
    throw new CunaError({
      code: "cuna.workspace_sync.initial_manifest_unproven",
      message: "Continuous synchronization requires the exact admitted initial workspace generation.",
      exitCode: EXIT_CODES.conflict,
    });
  }
  const client = createWorkspaceSyncClient(input.transport);
  const initialCheckpoint = await new FileWorkspaceSyncCheckpointStore(join(
    checkpointRoot,
    checkpointIntentDigest(workspaceId, workspaceBindingId, machineId, input.baseGeneration),
  )).load();
  if (
    initialCheckpoint?.phase !== "committed" ||
    initialCheckpoint.sync_id === null ||
    initialCheckpoint.committed_generation !== input.initialReceipt.generation ||
    initialCheckpoint.manifest_root !== input.initialReceipt.manifest_root ||
    initialCheckpoint.exclusion_policy_digest !== input.initialReceipt.exclusion_policy_digest ||
    initialCheckpoint.selected_protocol !== input.initialReceipt.selected_protocol
  ) {
    throw new CunaError({
      code: "cuna.workspace_sync.initial_checkpoint_unproven",
      message: "Continuous synchronization requires the durable initial commit authority.",
      exitCode: EXIT_CODES.conflict,
    });
  }
  const authority: ContinuousSyncAuthority = {
    async commitLocalSnapshot({ baseGeneration, manifest, signal }) {
      const directory = join(checkpointRoot, checkpointIntentDigest(
        workspaceId, workspaceBindingId, machineId, baseGeneration,
      ));
      await assertSafeDerivedCheckpoint(directory, root);
      const checkpointStore = new FileWorkspaceSyncCheckpointStore(directory);
      const coordinator = new WorkspaceSyncCoordinator({
        client,
        checkpointStore,
        chunkSource: await createFilesystemChunkSource(root, manifest),
        ...(input.maximumConcurrentUploads === undefined
          ? {}
          : { maximumConcurrentUploads: input.maximumConcurrentUploads }),
        ...(input.maximumAttempts === undefined ? {} : { maximumAttempts: input.maximumAttempts }),
      });
      const receipt = await coordinator.synchronize({
        workspaceId,
        workspaceBindingId,
        machineId,
        baseGeneration,
        manifest,
        signal,
      });
      const checkpoint = await checkpointStore.load();
      if (checkpoint?.phase !== "committed" || checkpoint.sync_id === null) throw unexpectedFailure();
      return Object.freeze({
        syncId: checkpoint.sync_id,
        generation: receipt.generation,
        manifestRoot: receipt.manifest_root,
      });
    },
    async listChanges({ syncId, cursor, signal }) {
      const response = await client.changes(syncId, {
        ...(cursor === undefined ? {} : { cursor }),
        readerVersion: WORKSPACE_SYNC_PROTOCOL.maximum,
        signal,
      });
      return response.data;
    },
    async readChunk({ syncId, digest, byteLength, signal }) {
      const response = await client.downloadChunk(
        syncId,
        digest,
        WORKSPACE_SYNC_PROTOCOL.maximum,
        signal,
      );
      const bytes = Buffer.from(response.data.content_base64, "base64");
      if (bytes.byteLength !== byteLength) {
        bytes.fill(0);
        throw new CunaError({
          code: "cuna.workspace_sync.chunk_mismatch",
          message: "The downloaded workspace chunk did not match the requested length.",
          exitCode: EXIT_CODES.policy,
        });
      }
      return bytes;
    },
    async reconcile({ generation, manifestRoot, signal }) {
      const response = await client.reconcile(workspaceId, {
        workspace_binding_id: workspaceBindingId,
        machine_id: machineId,
        observed_generation: generation,
        exclusion_policy_digest: policy.digest,
        manifest_root: manifestRoot,
        protocol: WORKSPACE_SYNC_PROTOCOL,
      }, reconcileKey(workspaceBindingId, generation, manifestRoot), signal);
      return Object.freeze({
        status: response.data.status,
        generation: response.data.active_generation,
        manifestRoot: response.data.active_manifest_root,
      });
    },
  };
  const bindingStateDirectory = join(
    checkpointRoot,
    bindingDigest(workspaceId, workspaceBindingId, machineId),
    "continuous",
  );
  return ContinuousWorkspaceSyncSupervisor.start({
    bindingId: workspaceBindingId,
    bindingGeneration: input.initialReceipt.generation,
    syncId: initialCheckpoint.sync_id,
    initialGeneration: input.initialReceipt.generation,
    initialManifestRoot: input.initialReceipt.manifest_root,
    canonicalRoot: root,
    stateDirectory: join(bindingStateDirectory, `generation-${input.initialReceipt.generation}`),
    writerLeaseDirectory: join(bindingStateDirectory, "writer-authority"),
    policy,
    filesystemCapabilities: input.filesystemCapabilities,
    authority,
    initialManifest,
  });
}

function validateAuthority(input: SynchronizeLocalWorkspaceInput): void {
  if (
    input.transport?.authentication !== "authenticated" ||
    (input.transport.credentialAuthority !== "api_key" &&
      input.transport.credentialAuthority !== "interactive") ||
    typeof input.transport.request !== "function"
  ) {
    throw new CunaError({
      code: "cuna.auth.required",
      message: "Workspace synchronization requires authenticated Cuna authority.",
      exitCode: EXIT_CODES.auth,
    });
  }
}

async function canonicalWorkspaceRoot(value: string): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value)) throw invalidInput("workspace_root");
  try {
    const metadata = await lstat(value);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw unsafeRoot("workspace_root_type");
    const canonical = await realpath(value);
    if (resolve(canonical) === resolve(parse(canonical).root)) throw unsafeRoot("filesystem_root");
    return canonical;
  } catch (error) {
    if (error instanceof CunaError) throw error;
    throw unsafeRoot("workspace_root_unavailable");
  }
}

async function canonicalCheckpointRoot(value: string, workspaceRoot: string): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value)) throw invalidInput("checkpoint_root");
  try {
    const metadata = await lstat(value);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw unsafeRoot("checkpoint_root_type");
    const canonical = await realpath(value);
    if (resolve(canonical) === resolve(parse(canonical).root)) throw unsafeRoot("checkpoint_filesystem_root");
    if (isSameOrInside(workspaceRoot, canonical)) throw unsafeRoot("checkpoint_inside_workspace");
    return canonical;
  } catch (error) {
    if (error instanceof CunaError) throw error;
    throw unsafeRoot("checkpoint_root_unavailable");
  }
}

async function assertSafeDerivedCheckpoint(directory: string, workspaceRoot: string): Promise<void> {
  if (isSameOrInside(workspaceRoot, directory)) throw unsafeRoot("checkpoint_inside_workspace");
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw unsafeRoot("checkpoint_binding_type");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof CunaError) throw error;
    throw unsafeRoot("checkpoint_binding_unavailable");
  }
}

/**
 * `.cunaignore` is the only local exclusion authority. No earlier durable
 * workspace-policy name was published.
 */
async function readProjectExclusionPolicy(root: string): Promise<readonly ExclusionRuleSource[]> {
  const text = await readPolicyFile(join(root, ".cunaignore"));
  return Object.freeze([
    Object.freeze({ source: "gitignore" as const, text: await readPolicyFile(join(root, ".gitignore")) }),
    Object.freeze({ source: "cunaignore" as const, text }),
  ]);
}

async function readPolicyFile(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_POLICY_BYTES) throw unsafePolicy("policy_file_type_or_size");
    const bytes = await handle.readFile();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    if (error instanceof CunaError) throw error;
    throw unsafePolicy("policy_file_unavailable");
  } finally {
    await handle?.close();
  }
}

function bindingDigest(workspaceId: string, workspaceBindingId: string, machineId: string): string {
  return `binding-${createHash("sha256")
    .update("cuna-workspace-sync-binding-v2\0")
    .update(workspaceId)
    .update("\0")
    .update(workspaceBindingId)
    .update("\0")
    .update(machineId)
    .digest("hex")}`;
}

function checkpointIntentDigest(
  workspaceId: string,
  workspaceBindingId: string,
  machineId: string,
  baseGeneration: number,
): string {
  return `${bindingDigest(workspaceId, workspaceBindingId, machineId)}-generation-${baseGeneration}`;
}

function reconcileKey(bindingId: string, generation: number, manifestRoot: string): string {
  return `continuous-reconcile-${createHash("sha256")
    .update(`${bindingId}\0${generation}\0${manifestRoot}`, "utf8")
    .digest("hex")}`;
}

function isSameOrInside(root: string, candidate: string): boolean {
  const difference = relative(resolve(root), resolve(candidate));
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference));
}

function invalidInput(reason: string): CunaError {
  return new CunaError({
    code: "cuna.workspace_sync.invalid",
    message: "Workspace synchronization input is invalid.",
    exitCode: EXIT_CODES.usage,
    details: { reason },
  });
}

function unsafeRoot(reason: string): CunaError {
  return new CunaError({
    code: "cuna.workspace_sync.unsafe_root",
    message: "Workspace synchronization refused an unsafe local storage boundary.",
    exitCode: EXIT_CODES.policy,
    details: { reason },
  });
}

function unsafePolicy(reason: string): CunaError {
  return new CunaError({
    code: "cuna.workspace_sync.policy_unavailable",
    message: "Workspace synchronization could not safely read the project exclusion policy.",
    exitCode: EXIT_CODES.policy,
    details: { reason },
  });
}

function unexpectedFailure(): CunaError {
  return new CunaError({
    code: "cuna.workspace_sync.failed",
    message: "Workspace synchronization failed before a safe result was available.",
    exitCode: EXIT_CODES.internal,
  });
}
