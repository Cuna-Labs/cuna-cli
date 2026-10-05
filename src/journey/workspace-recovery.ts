import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { CunaApiClient } from "../api/client.js";
import { EXIT_CODES, CunaError, usageError, type ExitCode, type SafeErrorDetails } from "../core/errors.js";
import type {
  ContinuousSyncConflict,
  ContinuousSyncSnapshot,
  ContinuousWorkspaceSyncSupervisor,
} from "../sync/continuous-sync-supervisor.js";
import {
  inspectWorkspaceSyncPolicy,
  readLocalWorkspaceBase,
  resumeContinuousWorkspaceSyncFromLocalBase,
  type AuthenticatedWorkspaceSyncTransport,
} from "../sync/workspace-sync-product-service.js";
import { discoverWorkspaceBindingMarker, loadWorkspaceBindingIntent } from "../workspace/binding-store.js";
import type { FilesystemCapabilities } from "../workspace/paths.js";
import { conflictNotice, observeBoundMachine, syncHolder } from "./workspace-effects.js";

/** How long `cuna sync recover` waits for the folder to sync again unless `--timeout-ms` says otherwise. */
export const DEFAULT_WORKSPACE_RECOVERY_TIMEOUT_MS = 120_000;

/** The exact command, as the attached terminal prints it when a folder's sync stops. */
export const WORKSPACE_RECOVERY_COMMAND = "cuna sync recover [PATH] --yes";

export interface WorkspaceSyncRecoveryInput {
  readonly client: Pick<CunaApiClient, "getIdentity" | "getWorkspaceBinding" | "getMachine">;
  readonly transport: AuthenticatedWorkspaceSyncTransport;
  readonly profileId: string;
  /** The installation's state directory; the sync state lives in its `workspace-sync`. */
  readonly stateDirectory: string;
  readonly filesystemCapabilities: FilesystemCapabilities;
  /** An absolute path inside the folder; the folder is the one its `.cuna/workspace.json` binds. */
  readonly path: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface WorkspaceSyncRecoveryState {
  readonly generation: number;
  readonly status: string;
  readonly reason: string | null;
}

export interface WorkspaceSyncRecoveryResult {
  readonly bindingId: string;
  readonly machineId: string;
  /** The generation the WorkspaceBinding authority published when recovery began. */
  readonly serverGeneration: number;
  readonly before: WorkspaceSyncRecoveryState;
  readonly after: WorkspaceSyncRecoveryState;
  /** Every path kept in two versions while recovering; neither version was overwritten. */
  readonly conflicts: readonly ContinuousSyncConflict[];
}

/**
 * Brings a folder whose sync stopped back to syncing, or says exactly why it
 * will not (R7.3). BL-7, 2026-10-03: a folder's sync stopped at
 * recovery_required, re-attaching did not move it, and nothing in the CLI
 * could.
 *
 * Every refusal comes before the folder or its sync state is touched and before
 * anything is sent: binding_missing, policy_changed, machine_gone,
 * binding_changed, recovery_state_missing, generation_rollback, active_writer.
 * Past them the folder's own continuous supervisor is started from its durable
 * state with `recoverStop`, and this waits until it syncs again, stops again,
 * or the wait ends. The supervisor is always stopped before this returns, so
 * the folder's writer lease is released.
 *
 * Byte safety is the supervisor's apply rule and nothing else: no path here
 * writes or removes a file in the folder.
 */
export async function recoverWorkspaceSync(input: WorkspaceSyncRecoveryInput): Promise<WorkspaceSyncRecoveryResult> {
  if (!isAbsolute(input.path)) throw usageError("The folder to recover must be an absolute path.");
  const signal = input.signal ?? new AbortController().signal;
  const named = await inspectWorkspaceSyncPolicy({ localRoot: input.path, filesystemCapabilities: input.filesystemCapabilities });
  // Local first: an unbound folder is refused before any request.
  if (await discoverWorkspaceBindingMarker({ startPath: named.canonicalRoot }) === undefined) {
    throw refused("binding_missing", "This folder is not bound to a Cuna workspace, so there is no sync to recover.", BINDING_MISSING_HINT, EXIT_CODES.policy);
  }
  const identity = await input.client.getIdentity(signal);
  if (identity.workspaceId === undefined) {
    throw new CunaError({
      code: "cuna.journey.workspace_identity_unavailable",
      message: "The signed-in account has no assigned workspace authority.",
      exitCode: EXIT_CODES.auth,
      hint: "Run `cuna workspace show` to see the current assignment.",
    });
  }
  const workspaceId = identity.workspaceId;
  const loaded = await loadWorkspaceBindingIntent({
    startPath: named.canonicalRoot,
    profileId: input.profileId,
    userId: identity.id,
    workspaceId,
  });
  if (loaded === undefined) {
    throw refused("binding_missing", "This folder is not bound to a Cuna workspace, so there is no sync to recover.", BINDING_MISSING_HINT, EXIT_CODES.policy);
  }
  const record = loaded.record;
  // The folder is the one the binding names, wherever inside it PATH points.
  const root = loaded.marker.workspaceRoot.path;
  const policy = await inspectWorkspaceSyncPolicy({ localRoot: root, filesystemCapabilities: input.filesystemCapabilities });
  if (policy.exclusionPolicyDigest !== record.policyDigest) throw policyChanged();

  const bound = await observeBoundMachine(input.client, record.machineId, signal);
  if (bound.kind === "absent") {
    throw refused(
      "machine_gone",
      "The Machine this folder is bound to no longer exists, so there is nothing to sync with.",
      "Run `cuna claude --machine NAME` (or codex, opencode) in this folder to bind it to another Machine. Nothing was changed.",
      EXIT_CODES.conflict,
      { bound_machine_id: record.machineId },
    );
  }
  const authority = await input.client.getWorkspaceBinding(record.bindingId, {
    ...(record.executionWorkspaceId === undefined ? {} : { executionWorkspaceId: record.executionWorkspaceId }),
    workspaceId,
    projectId: record.projectId,
    localInstanceId: record.localInstanceId,
    machineId: record.machineId,
    exclusionPolicyDigest: record.policyDigest,
  }, signal);
  if (authority.exclusionPolicyDigest !== record.policyDigest) throw policyChanged();
  if ((authority.executionWorkspaceId ?? null) !== (record.executionWorkspaceId ?? null) || authority.remoteRoot !== record.remoteRoot) {
    throw refused(
      "binding_changed",
      "The server's Workspace for this binding is not the one this folder recorded.",
      "Run `cuna claude` (or codex, opencode) in this folder to see the binding conflict. Nothing was changed.",
      EXIT_CODES.conflict,
    );
  }

  const checkpointRoot = join(input.stateDirectory, "workspace-sync");
  const base = await pathExists(checkpointRoot)
    ? await readLocalWorkspaceBase({
      localRoot: root,
      workspaceId,
      workspaceBindingId: authority.bindingId,
      machineId: record.machineId,
      checkpointRoot,
      filesystemCapabilities: input.filesystemCapabilities,
    })
    : undefined;
  const resumable = base?.resumable;
  if (base === undefined || resumable === undefined) {
    throw refused(
      "recovery_state_missing",
      "This computer holds no sync state for this folder, so nothing proves which files here are your edits. Cuna will not guess. Nothing was changed.",
      "Copy your changed files somewhere safe, bring the folder back to the Machine's version, then run `cuna claude` (or codex, opencode) here again.",
      EXIT_CODES.conflict,
      { server_generation: authority.activeGeneration, ...(base === undefined ? {} : { local_generation: base.generation }) },
    );
  }
  if (base.generation > authority.activeGeneration) {
    throw refused(
      "generation_rollback",
      `This folder last synchronized workspace generation ${base.generation}, but the server publishes ${authority.activeGeneration}. Nothing was sent and nothing was changed.`,
      "Keep this folder as it is. A server generation older than this folder's is not something recovery may sync against.",
      EXIT_CODES.conflict,
      { local_generation: base.generation, server_generation: authority.activeGeneration },
    );
  }
  const before: WorkspaceSyncRecoveryState = Object.freeze({ generation: base.generation, status: resumable.status, reason: resumable.reason });

  const conflicts: ContinuousSyncConflict[] = [];
  let supervisor: ContinuousWorkspaceSyncSupervisor;
  try {
    supervisor = await resumeContinuousWorkspaceSyncFromLocalBase({
      localRoot: root,
      workspaceId,
      workspaceBindingId: authority.bindingId,
      machineId: record.machineId,
      base: resumable,
      transport: input.transport,
      checkpointRoot,
      filesystemCapabilities: input.filesystemCapabilities,
      onConflict: (conflict) => { conflicts.push(conflict); },
      recoverStop: true,
    });
  } catch (error) {
    if (error instanceof CunaError && error.details?.reason === "active_writer") {
      const holder = error.details.holder_pid;
      // Worded as the journey words it (`syncHolder`), so the two places a
      // held folder is reported name the same process the same way.
      throw refused(
        "active_writer",
        `Another cuna run holds this folder's sync, and nothing was changed${syncHolder(error)}`,
        "Close the other cuna run in this folder, or end its process if that run is no longer open, then run this command again.",
        EXIT_CODES.conflict,
        typeof holder === "number" ? { holder_pid: holder } : {},
      );
    }
    if (error instanceof CunaError) {
      throw incomplete("start_failed", before, conflicts, {
        state: before.status,
        generation: before.generation,
        sync_reason: typeof error.details?.reason === "string" ? error.details.reason : error.code,
      }, "Workspace sync could not be started from this folder's sync state.", EXIT_CODES.conflict);
    }
    throw error;
  }
  let settled: { readonly outcome: "recovered" | "stopped" | "timeout" | "cancelled"; readonly snapshot: ContinuousSyncSnapshot };
  try {
    settled = await waitForRecovery(supervisor, authority.activeGeneration, input.timeoutMs ?? DEFAULT_WORKSPACE_RECOVERY_TIMEOUT_MS, signal);
  } finally {
    await supervisor.stop();
  }
  const snapshot = settled.snapshot;
  const after: WorkspaceSyncRecoveryState = Object.freeze({
    generation: snapshot.generation,
    status: snapshot.state,
    reason: snapshot.reason ?? null,
  });
  if (settled.outcome === "recovered") {
    return Object.freeze({
      bindingId: authority.bindingId,
      machineId: record.machineId,
      serverGeneration: authority.activeGeneration,
      before,
      after,
      conflicts: Object.freeze([...conflicts]),
    });
  }
  const facts = { state: after.status, generation: after.generation, sync_reason: after.reason };
  if (settled.outcome === "stopped") {
    throw incomplete("stopped_again", before, conflicts, facts,
      `Workspace sync stopped again at ${stateLabel(after)} · this folder is at generation ${after.generation}.`, EXIT_CODES.conflict);
  }
  if (settled.outcome === "cancelled") {
    throw incomplete("cancelled", before, conflicts, facts, "Workspace sync recovery was cancelled before the folder synced again.", EXIT_CODES.network);
  }
  throw incomplete("recovery_timeout", before, conflicts, facts,
    `Workspace sync did not finish recovering in time · it was at ${stateLabel(after)} · this folder is at generation ${after.generation}.`, EXIT_CODES.network);
}

/** The human lines for a recovered folder: the result, where it started, and one line per kept conflict. */
export function workspaceRecoveryLines(result: WorkspaceSyncRecoveryResult): readonly string[] {
  return Object.freeze([
    `Workspace sync recovered · this folder is at generation ${result.after.generation}`,
    `Before: ${stateLabel(result.before)} at generation ${result.before.generation} · now ${stateLabel(result.after)} · the server was at generation ${result.serverGeneration}`,
    ...result.conflicts.map(conflictNotice),
  ]);
}

/** The `sync.recover` record. */
export function workspaceRecoveryRecord(result: WorkspaceSyncRecoveryResult): Readonly<Record<string, unknown>> {
  return Object.freeze({
    binding_id: result.bindingId,
    machine_id: result.machineId,
    server_generation: result.serverGeneration,
    before: stateRecord(result.before),
    after: stateRecord(result.after),
    conflicts: result.conflicts.map((conflict) => ({
      code: conflict.code,
      resolution: conflict.resolution,
      path: conflict.path,
      sibling: conflict.sibling,
      generation: conflict.generation,
    })),
  });
}

function stateRecord(state: WorkspaceSyncRecoveryState): Readonly<Record<string, unknown>> {
  return Object.freeze({ generation: state.generation, status: state.status, reason: state.reason });
}

function stateLabel(state: WorkspaceSyncRecoveryState): string {
  return state.reason === null ? state.status : `${state.status} (${state.reason})`;
}

/**
 * The supervisor's snapshot once it syncs again, stops again, or the wait ends.
 *
 * Synced again means: live, not dirty, nothing left to apply or send, and at
 * the generation the server published when recovery began or a newer one (its
 * own commit of this folder's edits). `recoverStop` makes the loop's first
 * pass a reconciliation, which marks the state dirty before `start` returns;
 * the state is clean again only once the server confirmed the folder (a
 * converged reconciliation) or took its commit. A snapshot is not taken as
 * success before one that was dirty has been seen, so a state loaded clean is
 * never reported as recovered without that proof.
 */
async function waitForRecovery(
  supervisor: ContinuousWorkspaceSyncSupervisor,
  serverGeneration: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ readonly outcome: "recovered" | "stopped" | "timeout" | "cancelled"; readonly snapshot: ContinuousSyncSnapshot }> {
  return await new Promise((resolve) => {
    let settled = false;
    let sawWork = false;
    let unsubscribe: (() => void) | undefined;
    const settle = (outcome: "recovered" | "stopped" | "timeout" | "cancelled", snapshot = supervisor.snapshot): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      unsubscribe?.();
      resolve(Object.freeze({ outcome, snapshot }));
    };
    const cancel = (): void => settle("cancelled");
    const timer = setTimeout(() => settle("timeout"), timeoutMs);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    unsubscribe = supervisor.subscribe((snapshot) => {
      if (snapshot.dirty) sawWork = true;
      // A pause on a queue limit is a stop in all but name: the loop takes
      // nothing in and sends nothing until the folder shrinks. Any other pause
      // is a dependency the loop retries, so it is waited out.
      const limited = snapshot.state === "paused" && (snapshot.reason === "operation_limit" || snapshot.reason === "byte_limit");
      if (snapshot.state === "conflicted" || snapshot.state === "recovery_required" || snapshot.state === "stopped" || limited) {
        settle("stopped", snapshot);
        return;
      }
      if (
        sawWork &&
        (snapshot.state === "live_unverified" || snapshot.state === "converged") &&
        !snapshot.dirty &&
        snapshot.pendingRemoteChanges === 0 &&
        snapshot.pendingLocalOperations === 0 &&
        snapshot.generation >= serverGeneration
      ) {
        settle("recovered", snapshot);
      }
    });
    if (settled) unsubscribe();
  });
}

const BINDING_MISSING_HINT = "Run `cuna claude`, `cuna codex` or `cuna opencode` in this folder to bind it and start syncing.";

function policyChanged(): CunaError {
  return refused(
    "policy_changed",
    "This folder's .gitignore or .cunaignore is not the one its sync was bound with, so its sync state cannot tell an edit from an excluded file. Nothing was changed.",
    "Put back the .gitignore and .cunaignore this folder was bound with, then run this command again.",
    EXIT_CODES.policy,
  );
}

function refused(reason: string, message: string, hint: string, exitCode: ExitCode, details: SafeErrorDetails = {}): CunaError {
  return new CunaError({
    code: "cuna.workspace_sync.recovery_refused",
    message,
    exitCode,
    hint,
    details: { reason, ...details },
  });
}

function incomplete(
  reason: string,
  before: WorkspaceSyncRecoveryState,
  conflicts: readonly ContinuousSyncConflict[],
  facts: SafeErrorDetails,
  message: string,
  exitCode: ExitCode,
): CunaError {
  return new CunaError({
    code: "cuna.workspace_sync.recovery_incomplete",
    message,
    exitCode,
    hint: reason === "recovery_timeout" || reason === "cancelled"
      ? "Nothing is retried on its own. Run this command again, with a larger --timeout-ms if the folder is large."
      : "Nothing is retried on its own. The reason above says what stopped it; run this command again once that is resolved.",
    details: {
      reason,
      ...facts,
      before_state: before.status,
      before_generation: before.generation,
      before_reason: before.reason,
      conflicts: conflicts.map((conflict) => conflict.sibling === null ? conflict.path : `${conflict.path} -> ${conflict.sibling}`),
    },
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
