import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { RunaApiClient } from "../api/client.js";
import { EXIT_CODES, CunaError, type ExitCode } from "../core/errors.js";
import type { ContinuousSyncSnapshot } from "../sync/continuous-sync-supervisor.js";
import {
  inspectWorkspaceSyncPolicy,
  startContinuousWorkspaceSync,
  synchronizeLocalWorkspace,
  type AuthenticatedWorkspaceSyncTransport,
} from "../sync/workspace-sync-product-service.js";
import { loadWorkspaceBindingIntent, persistWorkspaceBinding, workspaceBindingCompareAndSwap, type LoadedWorkspaceBinding } from "../workspace/binding-store.js";
import type { FilesystemCapabilities } from "../workspace/paths.js";
import type { AgentJourneyEffects } from "./orchestrator.js";

export interface WorkspaceJourneyEffectsInput {
  readonly client: RunaApiClient;
  readonly transport: AuthenticatedWorkspaceSyncTransport;
  readonly profileId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly stateDirectory: string;
  readonly filesystemCapabilities: FilesystemCapabilities;
}

function fail(code: string, message: string, exitCode: ExitCode = EXIT_CODES.conflict): CunaError {
  return new CunaError({ code, message, exitCode });
}

function bindingKey(workspaceId: string, userId: string, canonicalRoot: string): string {
  return createHash("sha256").update(`${workspaceId}\0${userId}\0${canonicalRoot}`, "utf8").digest("hex");
}

function stableUuid(domain: string, value: string): string {
  const bytes = createHash("sha256").update(`${domain}\0${value}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Local binding facts are only hints until the complete tuple is re-read from the API. */
export interface WorkspaceJourneyEffects extends Pick<AgentJourneyEffects, "inspectWorkspace" | "synchronizeWorkspace"> {
  readonly continuousSyncSnapshot: () => ContinuousSyncSnapshot | undefined;
  readonly subscribeContinuousSync: (listener: (snapshot: ContinuousSyncSnapshot) => void) => () => void;
  readonly stopContinuousSync: () => Promise<void>;
}

export function createWorkspaceJourneyEffects(input: WorkspaceJourneyEffectsInput): WorkspaceJourneyEffects {
  let supervisor: Awaited<ReturnType<typeof startContinuousWorkspaceSync>> | undefined;
  const syncListeners = new Set<(snapshot: ContinuousSyncSnapshot) => void>();
  let unsubscribeSupervisor: (() => void) | undefined;
  const inspect = async (localPath: string): Promise<{
    readonly policy: Awaited<ReturnType<typeof inspectWorkspaceSyncPolicy>>;
    readonly local?: LoadedWorkspaceBinding;
  }> => {
    const policy = await inspectWorkspaceSyncPolicy({ localRoot: localPath, filesystemCapabilities: input.filesystemCapabilities });
    const local = await loadWorkspaceBindingIntent({
      startPath: policy.canonicalRoot,
      profileId: input.profileId,
      userId: input.userId,
      workspaceId: input.workspaceId,
    });
    return local === undefined ? Object.freeze({ policy }) : Object.freeze({ policy, local });
  };

  const effects: WorkspaceJourneyEffects = {
    continuousSyncSnapshot: () => supervisor?.snapshot,
    subscribeContinuousSync(listener: (snapshot: ContinuousSyncSnapshot) => void) {
      syncListeners.add(listener);
      const snapshot = supervisor?.snapshot;
      if (snapshot !== undefined) {
        try { listener(snapshot); } catch { /* Status observers never own synchronization correctness. */ }
      }
      return () => syncListeners.delete(listener);
    },
    async stopContinuousSync() {
      const current = supervisor;
      supervisor = undefined;
      unsubscribeSupervisor?.();
      unsubscribeSupervisor = undefined;
      await current?.stop();
    },
    async inspectWorkspace({ localPath }) {
      const inspected = await inspect(localPath);
      return inspected.local === undefined
        ? Object.freeze({})
        : Object.freeze({ projectMachineId: inspected.local.record.machineId });
    },
    async synchronizeWorkspace({ machineId, localPath, syncMode, signal }) {
      const inspected = await inspect(localPath);
      let authority;
      if (inspected.local !== undefined) {
        const record = inspected.local.record;
        if (record.machineId !== machineId || record.policyDigest !== inspected.policy.exclusionPolicyDigest) {
          throw fail("cuna.journey.workspace_binding_conflict", "The local project binding does not authorize the selected machine and exclusion policy.");
        }
        authority = await input.client.getWorkspaceBinding(record.bindingId, {
          workspaceId: input.workspaceId,
          projectId: record.projectId,
          localInstanceId: record.localInstanceId,
          machineId,
          exclusionPolicyDigest: inspected.policy.exclusionPolicyDigest,
        }, signal);
      } else {
        if (syncMode === "disabled") {
          throw fail("cuna.journey.workspace_binding_required", "--no-sync requires an existing remotely committed workspace binding.", EXIT_CODES.policy);
        }
        const intentDigest = bindingKey(input.workspaceId, input.userId, inspected.policy.canonicalRoot);
        // These identities are stable for this owner/root and installation.
        // Therefore a crash after the remote create but before local commit
        // retries the identical tuple and idempotency key, never a duplicate.
        const projectId = stableUuid("cuna.workspace.project.v1", intentDigest);
        const localInstanceId = stableUuid("cuna.workspace.local-instance.v1", `${intentDigest}\0${input.stateDirectory}`);
        const createKey = `cuna-workspace-${intentDigest}`;
        authority = await input.client.createWorkspaceBinding({
          workspaceId: input.workspaceId,
          projectId,
          localInstanceId,
          machineId,
          exclusionPolicyDigest: inspected.policy.exclusionPolicyDigest,
          excludedPrefixes: [],
        }, createKey, signal);
      }

      if (syncMode === "disabled") {
        if (authority.activeGeneration < 1) {
          throw fail("cuna.journey.workspace_generation_unavailable", "--no-sync cannot attach until the binding has a committed workspace generation.", EXIT_CODES.policy);
        }
        return Object.freeze({ bindingId: authority.bindingId, workspaceIdentity: authority.bindingId, generation: authority.activeGeneration, remoteCwd: authority.remoteRoot });
      }

      const checkpointRoot = join(input.stateDirectory, "workspace-sync");
      await mkdir(checkpointRoot, { recursive: true, mode: 0o700 });
      const receipt = await synchronizeLocalWorkspace({
        localRoot: inspected.policy.canonicalRoot,
        workspaceId: input.workspaceId,
        workspaceBindingId: authority.bindingId,
        machineId,
        baseGeneration: authority.activeGeneration,
        transport: input.transport,
        checkpointRoot,
        filesystemCapabilities: input.filesystemCapabilities,
        signal,
      });
      const committedAuthority = await input.client.getWorkspaceBinding(authority.bindingId, {
        workspaceId: input.workspaceId,
        projectId: authority.projectId,
        localInstanceId: authority.localInstanceId,
        machineId,
        exclusionPolicyDigest: authority.exclusionPolicyDigest,
      }, signal);
      if (
        committedAuthority.activeGeneration !== receipt.generation ||
        committedAuthority.activeManifestRoot !== receipt.manifest_root
      ) {
        throw fail(
          "cuna.journey.workspace_commit_unproven",
          "The WorkspaceBinding authority does not confirm the committed synchronization receipt.",
          EXIT_CODES.remote,
        );
      }
      const persisted = await persistWorkspaceBinding({
        root: inspected.policy.canonicalRoot,
        binding: {
          profileId: input.profileId,
          userId: input.userId,
          workspaceId: input.workspaceId,
          bindingId: committedAuthority.bindingId,
          projectId: committedAuthority.projectId,
          localInstanceId: committedAuthority.localInstanceId,
          machineId,
          remoteRoot: committedAuthority.remoteRoot,
          policyDigest: committedAuthority.exclusionPolicyDigest,
          generation: receipt.generation,
          bindingCreatedAt: committedAuthority.createdAt,
          bindingUpdatedAt: committedAuthority.updatedAt,
        },
        expected: inspected.local === undefined ? null : workspaceBindingCompareAndSwap(inspected.local.record),
      });
      supervisor = await startContinuousWorkspaceSync({
        localRoot: inspected.policy.canonicalRoot,
        workspaceId: input.workspaceId,
        workspaceBindingId: persisted.bindingId,
        machineId,
        baseGeneration: authority.activeGeneration,
        transport: input.transport,
        checkpointRoot,
        filesystemCapabilities: input.filesystemCapabilities,
        initialReceipt: receipt,
      });
      unsubscribeSupervisor = supervisor.subscribe((snapshot) => {
        for (const listener of syncListeners) {
          try { listener(snapshot); } catch { /* Status observers never own synchronization correctness. */ }
        }
      });
      return Object.freeze({ bindingId: persisted.bindingId, workspaceIdentity: persisted.bindingId, generation: persisted.generation, remoteCwd: persisted.remoteRoot });
    },
  };
  return Object.freeze(effects);
}

/** Safe under-claims never become guessed remote capabilities. */
export function conservativeFilesystemCapabilities(platform: FilesystemCapabilities["platform"]): FilesystemCapabilities {
  return Object.freeze({ platform, caseSensitive: false, unicodeNormalization: "nfc", symlinks: false, atomicRename: false, maximumComponentBytes: 255, maximumPathBytes: 4_096 });
}
