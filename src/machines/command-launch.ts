import { randomUUID } from "node:crypto";
import { requireCapability, type CunaApiClient } from "../api/client.js";
import type { ManagedCommandResult } from "../api/managed-executions.js";
import type { MachineDefaultWorkspace } from "../api/remote-workspace.js";
import type { PlatformAdapter } from "../platform/adapter.js";
import { assertMachineId } from "../core/validation.js";
import { saveExecutionReceipt } from "./execution-receipt.js";

export interface CommandLaunchEnvironment {
  readonly platform: PlatformAdapter;
  readonly baseUrl: string;
  readonly profile: string;
}
export interface PreparedCommand {
  readonly operationId: string;
  readonly workspace: MachineDefaultWorkspace;
  run(command: string, onRecorded: (path: string) => Promise<void>, signal: AbortSignal): Promise<ManagedCommandResult>;
}

/** Preparation is read-only; confirmation rechecks authority before recording and sending once. */
export async function prepareManagedCommand(client: CunaApiClient, machineId: string,
  environment: CommandLaunchEnvironment, signal: AbortSignal): Promise<PreparedCommand> {
  assertMachineId(machineId);
  const gate = async (id: string, readOnly: boolean, activeSignal: AbortSignal) => {
    activeSignal.throwIfAborted();
    await requireCapability({ client, scope: "machine", resourceId: machineId, capabilityId: id,
      allowedInteractions: [readOnly ? "read_only" : "native"], signal: activeSignal });
  };
  await gate("machines.default_workspace.read", true, signal);
  const identity = Object.freeze({ ...await client.getIdentity(signal) });
  const workspace = Object.freeze({ ...await client.getMachineDefaultWorkspace(machineId, signal) });
  const verify = (value: MachineDefaultWorkspace) => {
    if (!identity.workspaceId || value.machineId !== machineId || value.workspaceId !== identity.workspaceId ||
      value.publicationStatus !== "ready" || value.executionWorkspaceId !== workspace.executionWorkspaceId ||
      value.remoteRoot !== workspace.remoteRoot || value.workspaceGeneration !== workspace.workspaceGeneration ||
      value.machineGeneration !== workspace.machineGeneration) {
      throw new Error("The remote Workspace is not ready or changed. Return and prepare the command again.");
    }
  };
  verify(workspace);
  await gate("machines.exec", false, signal);
  const operationId = randomUUID();
  let attempted = false;
  return Object.freeze({ operationId, workspace,
    async run(command: string, onRecorded: (path: string) => Promise<void>, activeSignal: AbortSignal) {
      if (attempted) throw new Error("This command attempt cannot be repeated. Inspect its execution ID.");
      if (!command.trim() || command.includes("\0") || Buffer.byteLength(command, "utf8") > 65536) {
        throw new Error("Enter a command of at most 64 KiB without NUL characters.");
      }
      attempted = true;
      await gate("machines.default_workspace.read", true, activeSignal);
      const currentIdentity = await client.getIdentity(activeSignal);
      if (currentIdentity.id !== identity.id || currentIdentity.workspaceId !== identity.workspaceId) {
        throw new Error("The signed-in account changed. Prepare the command again.");
      }
      verify(await client.getMachineDefaultWorkspace(machineId, activeSignal));
      await gate("machines.exec", false, activeSignal);
      activeSignal.throwIfAborted();
      const path = await saveExecutionReceipt(environment.platform,
        { baseUrl: environment.baseUrl, profile: environment.profile, userId: identity.id },
        machineId, workspace.executionWorkspaceId, operationId);
      await onRecorded(path);
      activeSignal.throwIfAborted();
      // Shell interpretation happens only on the selected remote Machine.
      return await client.executeManagedCommand(machineId, operationId,
        { command: "/bin/sh", args: ["-c", command], cwd: workspace.remoteRoot }, activeSignal);
    },
  });
}
