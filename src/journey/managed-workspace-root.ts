import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CunaError, EXIT_CODES } from "../core/errors.js";
import { captureCanonicalWorkspaceRoot, sameCanonicalPath } from "../workspace/binding-path.js";
import { loadWorkspaceBindingIntent } from "../workspace/binding-store.js";
import type { ReconciledAgentJourneyIntent } from "./intent.js";

function scope(intent: ReconciledAgentJourneyIntent, machineId?: string): string {
  const machine = machineId ?? (intent.machine.kind === "exact-name" ? intent.machine.name : undefined);
  return machine === undefined ? `${intent.agent}-${intent.machine.kind}`
    : `machine-${createHash("sha256").update(machine, "utf8").digest("hex").slice(0, 16)}`;
}
async function existing(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
/** Select only after authenticated account authority; never redirect an explicit user path. */
export async function selectManagedWorkspaceRoot(input: {
  homeDirectory: string; baseUrl: string; profileId: string; userId: string; workspaceId: string;
  intent: ReconciledAgentJourneyIntent; machineId?: string;
}): Promise<string> {
  if (input.intent.localPath !== undefined) return input.intent.localPath;
  const home = await captureCanonicalWorkspaceRoot(input.homeDirectory);
  const parent = join(home.path, "Cuna Workspaces");
  const owner = { profileId: input.profileId, userId: input.userId, workspaceId: input.workspaceId };
  // A bound ancestor is a separate protected project. Account namespacing must
  // not become a way to cross or bypass its authority.
  let ancestor = parent;
  while (!await existing(ancestor)) ancestor = dirname(ancestor);
  const ancestorBinding = await loadWorkspaceBindingIntent({ startPath: ancestor, ...owner });
  if (ancestorBinding !== undefined) throw new CunaError({ code: "cuna.workspace.identity_unproven",
    message: "The managed Workspace parent is already bound to a project.", exitCode: EXIT_CODES.policy,
    details: { reason: "managed_workspace_ancestor_binding" } });
  const leaf = scope(input.intent, input.machineId);
  const legacy = join(parent, leaf);
  if (await existing(legacy)) {
    // Validate physical paths before interpreting an owner mismatch as a
    // foreign but intact legacy record. Unsafe and corrupt records always refuse.
    await captureCanonicalWorkspaceRoot(legacy);
    try {
      const loaded = await loadWorkspaceBindingIntent({ startPath: legacy, ...owner });
      if (loaded !== undefined && sameCanonicalPath(loaded.marker.workspaceRoot.path, legacy)) return legacy;
    } catch (error) {
      if (!(error instanceof CunaError && error.code === "cuna.workspace.identity_unproven" && error.details?.reason === "binding_owner_mismatch")) throw error;
    }
  }
  const namespace = createHash("sha256").update(JSON.stringify([
    "cuna-managed-workspace-account-v1", new URL(input.baseUrl).origin, input.profileId, input.userId, input.workspaceId,
  ]), "utf8").digest("hex");
  const root = join(parent, "accounts", namespace, leaf);
  let newAncestor = dirname(root);
  while (!await existing(newAncestor)) newAncestor = dirname(newAncestor);
  await captureCanonicalWorkspaceRoot(newAncestor);
  if (await loadWorkspaceBindingIntent({ startPath: newAncestor, ...owner }) !== undefined) throw new CunaError({
    code: "cuna.workspace.identity_unproven", message: "The managed Workspace ancestor is already bound to a project.",
    exitCode: EXIT_CODES.policy, details: { reason: "managed_workspace_ancestor_binding" },
  });
  if (await existing(root)) {
    await captureCanonicalWorkspaceRoot(root);
    const loaded = await loadWorkspaceBindingIntent({ startPath: root, ...owner });
    if (loaded !== undefined && !sameCanonicalPath(loaded.marker.workspaceRoot.path, root)) throw new CunaError({
      code: "cuna.workspace.identity_unproven", message: "The managed Workspace root identity changed.",
      exitCode: EXIT_CODES.policy, details: { reason: "managed_workspace_ancestor_binding" },
    });
  }
  await mkdir(root, { recursive: true });
  await captureCanonicalWorkspaceRoot(root);
  return root;
}
