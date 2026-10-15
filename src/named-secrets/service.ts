import { requireCapability, type CunaApiClient } from "../api/client.js";
import { NamedSecretRequestError, validNamedSecretScope, type NamedSecretContext, type NamedSecretReceipt } from "../api/named-secrets.js";
import type { SecretMaterial } from "../credentials/secret-material.js";

export interface NamedSecretService {
  prepare(context: NamedSecretContext, userId: string, signal: AbortSignal): Promise<string>;
  create(operationId: string, name: string, secret: SecretMaterial, context: NamedSecretContext, signal: AbortSignal): Promise<NamedSecretReceipt>;
  read(operationId: string, signal: AbortSignal, expectedUserId?: string): Promise<NamedSecretReceipt>;
}
export function createNamedSecretService(client: CunaApiClient): NamedSecretService {
  return {
    async prepare(context, userId, signal) {
      try {
        if(!validNamedSecretScope(context)) throw new NamedSecretRequestError(403);
        const [identity, machine, session] = await Promise.all([client.getIdentity(signal), client.getMachine(context.machine_id, signal), client.getAgentSession(context.agent_session_id, signal)]);
        if (identity.id !== userId || identity.workspaceId === undefined || machine.state !== "running" || session.machineId !== context.machine_id ||
            session.workspaceBindingId !== context.workspace_binding_id || session.processState !== "running" || session.processEpoch !== context.process_epoch) throw new NamedSecretRequestError(403);
        if(context.workspace_binding_id===undefined) {
          await requireCapability({client,scope:"agent_session",resourceId:context.agent_session_id,capabilityId:"agent_sessions.workspace.read",allowedInteractions:["read_only"],signal});
          const workspace=await client.getAgentSessionWorkspaceContext(context.agent_session_id,signal);
          if(workspace.agentSessionId!==context.agent_session_id || workspace.machineId!==context.machine_id || workspace.executionWorkspaceId!==context.execution_workspace_id ||
            workspace.workspaceGeneration!==context.execution_workspace_generation || workspace.remoteRoot!==`/workspace/workspaces/${workspace.executionWorkspaceId}` ||
            !(session.cwd===workspace.remoteRoot || session.cwd.startsWith(`${workspace.remoteRoot}/`)) || session.cwd.split("/").some(part=>part==="."||part==="..")) throw new NamedSecretRequestError(403);
        }
        return identity.workspaceId;
      } catch { throw new NamedSecretRequestError(403); }
    },
    async create(operationId, name, secret, context, signal) {
      try {
        return await secret.withBytes(async (bytes) => await client.createNamedSecret({ operation_id: operationId, name,
          password: new TextDecoder("utf-8", { fatal: true }).decode(bytes), context }, signal));
      } catch (error) { throw error instanceof NamedSecretRequestError ? error : new NamedSecretRequestError(); }
    },
    async read(operationId, signal, expectedUserId) {
      try {
        if (expectedUserId !== undefined && (await client.getIdentity(signal)).id !== expectedUserId) throw new NamedSecretRequestError(403);
        const receipt = await client.getNamedSecretOperation(operationId, signal);
        if (expectedUserId !== undefined && (await client.getIdentity(signal)).id !== expectedUserId) throw new NamedSecretRequestError(403);
        return receipt;
      }
      catch (error) { throw error instanceof NamedSecretRequestError ? error : new NamedSecretRequestError(); }
    },
  };
}
