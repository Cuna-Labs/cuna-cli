import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { posix, resolve } from "node:path";

import { assertPublicId } from "../core/validation.js";
import { assertReadableSchema, type DurableSchemaEnvelope } from "./schema.js";
import { workspaceError } from "./errors.js";

export interface WorkspaceBinding extends DurableSchemaEnvelope {
  readonly bindingId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly localInstanceId: string;
  readonly canonicalLocalRoot: string;
  readonly remoteRoot: string;
  readonly machineId: string;
  readonly generation: number;
  readonly createdAt: string;
  readonly repositoryFingerprint?: string;
}

export interface BindingExpectations {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly machineId: string;
  readonly canonicalLocalRoot: string;
  readonly generation?: number;
}

export async function canonicalizeWorkspaceRoot(path: string): Promise<string> {
  if (path.includes("\0") || /^(?:\\\\[.?]\\|\/dev\/)/u.test(path)) {
    throw workspaceError("root_unsafe", "The workspace root is unsafe.", "policy", "device_path");
  }
  const lexical = resolve(path);
  const metadata = await lstat(lexical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw workspaceError("root_unsafe", "The workspace root must be a physical directory.", "policy", "unsafe_type");
  }
  return realpath(lexical);
}

export async function createWorkspaceBinding(input: {
  readonly root: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly machineId: string;
  readonly now?: Date;
  readonly idFactory?: () => string;
}): Promise<WorkspaceBinding> {
  const canonicalLocalRoot = await canonicalizeWorkspaceRoot(input.root);
  const idFactory = input.idFactory ?? randomUUID;
  const projectId = assertPublicId(idFactory(), "project ID");
  const localInstanceId = assertPublicId(idFactory(), "local instance ID");
  if (projectId === localInstanceId) {
    throw workspaceError(
      "identity_invalid",
      "Project and local-instance identities must be distinct.",
      "integrity",
      "identity_collision",
    );
  }
  const binding: WorkspaceBinding = {
    schemaVersion: 2,
    minimumReaderVersion: 1,
    minimumWriterVersion: 2,
    bindingId: assertPublicId(idFactory(), "binding ID"),
    tenantId: assertPublicId(input.tenantId, "tenant ID"),
    workspaceId: assertPublicId(input.workspaceId, "workspace ID"),
    projectId,
    localInstanceId,
    canonicalLocalRoot,
    remoteRoot: posix.join("/workspace/projects", projectId),
    machineId: assertPublicId(input.machineId, "machine ID"),
    generation: 0,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
  return Object.freeze(binding);
}

export async function validateWorkspaceBinding(
  binding: WorkspaceBinding,
  expected: BindingExpectations,
): Promise<WorkspaceBinding> {
  assertReadableSchema(binding);
  for (const [value, label] of [
    [binding.bindingId, "binding ID"],
    [binding.tenantId, "tenant ID"],
    [binding.workspaceId, "workspace ID"],
    [binding.projectId, "project ID"],
    [binding.localInstanceId, "local instance ID"],
    [binding.machineId, "machine ID"],
  ] as const) assertPublicId(value, label);
  const canonicalRoot = await canonicalizeWorkspaceRoot(expected.canonicalLocalRoot);
  const expectedRemoteRoot = posix.join("/workspace/projects", binding.projectId);
  if (
    binding.tenantId !== expected.tenantId ||
    binding.workspaceId !== expected.workspaceId ||
    binding.machineId !== expected.machineId ||
    binding.remoteRoot !== expectedRemoteRoot ||
    resolve(binding.canonicalLocalRoot) !== resolve(canonicalRoot) ||
    (expected.generation !== undefined && binding.generation !== expected.generation)
  ) {
    throw workspaceError(
      "identity_unproven",
      "Workspace binding identity could not be proven.",
      "policy",
      "binding_mismatch",
    );
  }
  return Object.freeze({ ...binding, canonicalLocalRoot: canonicalRoot });
}

export function relocateWorkspaceBinding(
  binding: WorkspaceBinding,
  canonicalLocalRoot: string,
  expectedGeneration: number,
): WorkspaceBinding {
  if (binding.generation !== expectedGeneration) {
    throw workspaceError("binding_stale", "The workspace binding generation is stale.", "conflict", "generation_cas");
  }
  return Object.freeze({
    ...binding,
    canonicalLocalRoot: resolve(canonicalLocalRoot),
    generation: binding.generation + 1,
  });
}

