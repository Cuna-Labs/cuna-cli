import { EXIT_CODES, CunaError } from "../core/errors.js";
import {
  assertCanonicalUuid,
  assertIdempotencyKey,
  assertSafeDisplayText,
  encodeCanonicalUuid,
} from "../core/validation.js";
import {
  decodeAuditRecords,
  decodeAgentSessionAuth,
  decodeAgentSessionAuthLogout,
  decodeAgentSessionItem,
  decodeAgentSessionPage,
  decodeApiKeyList,
  decodeCapabilitySnapshot,
  decodeCredentialRules,
  decodeMachineItem,
  decodeMachineCreateRequest,
  decodeMachinePage,
  decodeOk,
  decodeRunaIdentity,
  decodeTerminalConnectionGrant,
  decodeWorkspaceBindingAuthority,
  type AgentKind,
  type AgentAuthMode,
  type AgentSession,
  type AgentSessionAuth,
  type AgentSessionAuthLogout,
  type AgentSessionPage,
  type AuditRecord,
  type ApiKeyMetadata,
  type CapabilityScope,
  type CapabilitySnapshot,
  type CredentialRule,
  type Machine,
  type MachineCreateRequest,
  type MachinePage,
  type RunaIdentity,
  type TerminalConnectionGrant,
  type WorkspaceBindingAuthority,
} from "./contracts.js";
import type { HttpTransport } from "./http.js";
import { classifyCapabilitySnapshot } from "./capability-evidence.js";

export interface MachineCreateInput {
  readonly name: string;
  readonly agent?: AgentKind;
  readonly vcpus?: number;
  readonly memoryMiB?: number;
  readonly background?: boolean;
}

export interface AgentSessionCreateInput {
  readonly name?: string;
  readonly agent: AgentKind;
  readonly cwd: string;
  readonly workspaceBindingId: string;
  readonly workspaceGeneration: number;
  readonly authMode?: AgentAuthMode;
  readonly credentialBindingId?: string;
}

export interface WorkspaceBindingIdentityInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly localInstanceId: string;
  readonly machineId: string;
  readonly exclusionPolicyDigest: string;
}

export interface WorkspaceBindingCreateInput extends WorkspaceBindingIdentityInput {
  readonly excludedPrefixes: readonly string[];
}

export interface PageOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface TerminalConnectionCreateInput {
  readonly protocol: "runa.terminal.v1";
  readonly clientInstanceId: string;
  readonly resumeHandle?: string;
}

export interface RunaApiClient {
  getIdentity(signal?: AbortSignal): Promise<RunaIdentity>;
  discoverCapabilities(scope: CapabilityScope, resourceId?: string, signal?: AbortSignal): Promise<CapabilitySnapshot>;
  listMachines(signal?: AbortSignal): Promise<MachinePage>;
  getMachine(id: string, signal?: AbortSignal): Promise<Machine>;
  listRecords(): Promise<readonly AuditRecord[]>;
  listAuthorizations(machineId: string): Promise<readonly CredentialRule[]>;
  listApiKeys(): Promise<readonly ApiKeyMetadata[]>;
  revokeApiKey(id: string): Promise<true>;
  createMachine(
    input: MachineCreateInput,
    idempotencyKey: string,
    requestId?: string,
    signal?: AbortSignal,
  ): Promise<Machine>;
  getMachineCreateRequest(id: string, signal?: AbortSignal): Promise<MachineCreateRequest>;
  reconcileMachineCreateRequest(id: string, signal?: AbortSignal): Promise<MachineCreateRequest>;
  transitionMachine(id: string, action: "start" | "pause" | "resume" | "stop", signal?: AbortSignal): Promise<Machine>;
  deleteMachine(id: string): Promise<unknown>;
  createWorkspaceBinding(
    input: WorkspaceBindingCreateInput,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceBindingAuthority>;
  getWorkspaceBinding(
    bindingId: string,
    identity: WorkspaceBindingIdentityInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceBindingAuthority>;
  listAgentSessions(machineId: string, options?: PageOptions, signal?: AbortSignal): Promise<AgentSessionPage>;
  createAgentSession(
    machineId: string,
    input: AgentSessionCreateInput,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<AgentSession>;
  inspectAgentSessionCreate(
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<AgentSession>;
  getAgentSession(id: string, signal?: AbortSignal): Promise<AgentSession>;
  getAgentSessionAuth(id: string, signal?: AbortSignal): Promise<AgentSessionAuth>;
  logoutAgentSessionAuth(
    id: string,
    expectedProcessEpoch: string,
    signal?: AbortSignal,
  ): Promise<AgentSessionAuthLogout>;
  renameAgentSession(id: string, name: string): Promise<AgentSession>;
  terminateAgentSession(id: string): Promise<AgentSession>;
  createTerminalConnection(
    agentSessionId: string,
    input: TerminalConnectionCreateInput,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<TerminalConnectionGrant>;
}

function malformed(cause: unknown): CunaError {
  return new CunaError({
    code: "cuna.remote.malformed_response",
    message: "Cuna returned a response that does not match the public contract.",
    exitCode: EXIT_CODES.remote,
    cause,
  });
}

function decode<T>(decoder: (value: unknown) => T, value: unknown): T {
  try {
    return decoder(value);
  } catch (error) {
    if (error instanceof CunaError) throw error;
    throw malformed(error);
  }
}

function assertAgentSessionBinding(
  session: AgentSession,
  expected: {
    readonly id?: string;
    readonly machineId?: string;
    readonly workspaceBindingId?: string;
    readonly workspaceGeneration?: number;
  },
): AgentSession {
  if (
    (expected.id !== undefined && session.id !== expected.id) ||
    (expected.machineId !== undefined && session.machineId !== expected.machineId) ||
    (expected.workspaceBindingId !== undefined &&
      session.workspaceBindingId !== expected.workspaceBindingId) ||
    (expected.workspaceGeneration !== undefined &&
      session.workspaceGeneration !== expected.workspaceGeneration)
  ) {
    throw malformed(new TypeError("AgentSession response authority does not match the requested resource."));
  }
  return session;
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validatePageOptions(options: PageOptions): Readonly<Record<string, string>> {
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
  ) {
    throw new CunaError({
      code: "cuna.usage.invalid",
      message: "AgentSession page limit must be an integer from 1 through 100.",
      exitCode: EXIT_CODES.usage,
    });
  }
  if (
    options.cursor !== undefined &&
    (options.cursor.length < 1 || options.cursor.length > 512 || containsAsciiControl(options.cursor))
  ) {
    throw new CunaError({
      code: "cuna.usage.invalid",
      message: "AgentSession cursor is malformed.",
      exitCode: EXIT_CODES.usage,
    });
  }
  return Object.freeze({
    ...(options.limit === undefined ? {} : { limit: String(options.limit) }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  });
}

function validateAgentSessionCreate(input: AgentSessionCreateInput): void {
  assertCanonicalUuid(input.workspaceBindingId, "workspace binding ID");
  if (!Number.isSafeInteger(input.workspaceGeneration) || input.workspaceGeneration < 1) {
    throw new CunaError({
      code: "cuna.usage.invalid",
      message: "AgentSession workspace generation must be a positive safe integer.",
      exitCode: EXIT_CODES.usage,
    });
  }
  if (input.name !== undefined && (input.name.length < 1 || input.name.length > 80)) {
    throw new CunaError({
      code: "cuna.usage.invalid",
      message: "AgentSession name must contain 1 through 80 characters.",
      exitCode: EXIT_CODES.usage,
    });
  }
  if (
    !input.cwd.startsWith("/workspace") ||
    (input.cwd !== "/workspace" && !input.cwd.startsWith("/workspace/")) ||
    input.cwd.length > 1024 ||
    input.cwd.split("/").includes("..")
  ) {
    throw new CunaError({
      code: "cuna.usage.invalid",
      message: "AgentSession cwd must be a safe absolute path inside /workspace.",
      exitCode: EXIT_CODES.usage,
    });
  }
  if (input.authMode === "credential_binding" && input.credentialBindingId === undefined) {
    throw new CunaError({
      code: "cuna.usage.invalid",
      message: "credential_binding auth mode requires a credential binding ID.",
      exitCode: EXIT_CODES.usage,
    });
  }
  if (input.authMode !== "credential_binding" && input.credentialBindingId !== undefined) {
    throw new CunaError({
      code: "cuna.usage.invalid",
      message: "A credential binding ID requires credential_binding auth mode.",
      exitCode: EXIT_CODES.usage,
    });
  }
  if (input.credentialBindingId !== undefined) {
    assertCanonicalUuid(input.credentialBindingId, "credential binding ID");
  }
}

function validateMachineCreate(input: MachineCreateInput, idempotencyKey: string): void {
  assertIdempotencyKey(idempotencyKey);
  assertSafeDisplayText(input.name, "machine name");
  if (input.name.length < 1 || input.name.length > 80) {
    throw new CunaError({
      code: "cuna.usage.invalid",
      message: "Machine name must contain 1 through 80 characters.",
      exitCode: EXIT_CODES.usage,
    });
  }
  if (input.vcpus !== undefined && (!Number.isInteger(input.vcpus) || input.vcpus < 1 || input.vcpus > 8)) {
    throw new CunaError({
      code: "cuna.usage.invalid",
      message: "Machine vcpus must be an integer from 1 through 8.",
      exitCode: EXIT_CODES.usage,
    });
  }
  if (
    input.memoryMiB !== undefined &&
    (!Number.isInteger(input.memoryMiB) || input.memoryMiB < 512 || input.memoryMiB > 16_384)
  ) {
    throw new CunaError({
      code: "cuna.usage.invalid",
      message: "Machine memoryMiB must be an integer from 512 through 16384.",
      exitCode: EXIT_CODES.usage,
    });
  }
}

function validateWorkspaceBindingIdentity(input: WorkspaceBindingIdentityInput): void {
  assertCanonicalUuid(input.workspaceId, "workspace ID");
  assertCanonicalUuid(input.projectId, "project ID");
  assertCanonicalUuid(input.localInstanceId, "local instance ID");
  assertCanonicalUuid(input.machineId, "machine ID");
  if (!/^[0-9a-f]{64}$/u.test(input.exclusionPolicyDigest)) {
    throw new CunaError({
      code: "cuna.usage.invalid",
      message: "Workspace exclusion policy digest must be a lowercase SHA-256 digest.",
      exitCode: EXIT_CODES.usage,
    });
  }
}

function workspaceBindingIdentityMatches(
  actual: WorkspaceBindingAuthority,
  expected: WorkspaceBindingIdentityInput,
): boolean {
  return actual.workspaceId === expected.workspaceId &&
    actual.projectId === expected.projectId &&
    actual.localInstanceId === expected.localInstanceId &&
    actual.machineId === expected.machineId &&
    actual.exclusionPolicyDigest === expected.exclusionPolicyDigest;
}

export function createRunaApiClient(transport: HttpTransport): RunaApiClient {
  const client: RunaApiClient = {
    async getIdentity(signal) {
      return decode(
        decodeRunaIdentity,
        await transport.request({ method: "GET", path: "/v1/me", ...(signal === undefined ? {} : { signal }) }),
      );
    },
    async discoverCapabilities(scope, resourceId, signal) {
      const raw = await transport.request({
        method: "GET",
        path: "/v1/capabilities",
        query: { scope, resource_id: resourceId },
        ...(signal === undefined ? {} : { signal }),
      });
      return decode(decodeCapabilitySnapshot, raw);
    },
    async listMachines(signal) {
      return decode(decodeMachinePage, await transport.request({ method: "GET", path: "/v1/sessions", ...(signal === undefined ? {} : { signal }) }));
    },
    async getMachine(id, signal) {
      const safeId = encodeCanonicalUuid(id, "machine ID");
      const machine = decode(
        decodeMachineItem,
        await transport.request({
          method: "GET",
          path: `/v1/sessions/${safeId}`,
          ...(signal === undefined ? {} : { signal }),
        }),
      );
      if (machine.id !== id) {
        throw malformed(new TypeError("Machine response authority does not match the requested resource."));
      }
      return machine;
    },
    async listRecords() {
      return decode(decodeAuditRecords, await transport.request({ method: "GET", path: "/v1/records" }));
    },
    async listAuthorizations(machineId) {
      const safeId = encodeCanonicalUuid(machineId, "machine ID");
      return decode(
        decodeCredentialRules,
        await transport.request({ method: "GET", path: `/v1/sessions/${safeId}/authorizations` }),
      );
    },
    async listApiKeys() {
      return decode(decodeApiKeyList, await transport.request({ method: "GET", path: "/v1/api-keys" }));
    },
    async revokeApiKey(id) {
      const safeId = encodeCanonicalUuid(id, "API key ID");
      return decode(decodeOk, await transport.request({ method: "DELETE", path: `/v1/api-keys/${safeId}` }));
    },
    async createMachine(input, idempotencyKey, requestId, signal) {
      validateMachineCreate(input, idempotencyKey);
      if (requestId !== undefined) assertCanonicalUuid(requestId, "machine create request ID");
      const body = {
        name: input.name,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.vcpus === undefined ? {} : { vcpus: input.vcpus }),
        ...(input.memoryMiB === undefined ? {} : { memory_mib: input.memoryMiB }),
        ...(input.background === undefined ? {} : { background: input.background }),
      };
      const raw = await transport.request({
        method: "POST",
        path: "/v1/sessions",
        body,
        idempotencyKey,
        ...(requestId === undefined ? {} : { machineCreateRequestId: requestId }),
        ...(signal === undefined ? {} : { signal }),
      });
      return decode(decodeMachineItem, raw);
    },
    async getMachineCreateRequest(id, signal) {
      const safeId = encodeCanonicalUuid(id, "machine create request ID");
      const request = decode(
        decodeMachineCreateRequest,
        await transport.request({
          method: "GET",
          path: `/v1/machine-creates/${safeId}`,
          ...(signal === undefined ? {} : { signal }),
        }),
      );
      if (request.id !== id) throw malformed(new TypeError("Machine create request authority mismatch."));
      return request;
    },
    async reconcileMachineCreateRequest(id, signal) {
      const safeId = encodeCanonicalUuid(id, "machine create request ID");
      const request = decode(
        decodeMachineCreateRequest,
        await transport.request({
          method: "POST",
          path: `/v1/machine-creates/${safeId}/reconcile`,
          ...(signal === undefined ? {} : { signal }),
        }),
      );
      if (request.id !== id) throw malformed(new TypeError("Machine create request authority mismatch."));
      return request;
    },
    async transitionMachine(id, action, signal) {
      const safeId = encodeCanonicalUuid(id, "machine ID");
      const raw = await transport.request({
        method: "POST",
        path: `/v1/sessions/${safeId}/${action}`,
        ...(signal === undefined ? {} : { signal }),
      });
      const machine = decode(decodeMachineItem, raw);
      if (machine.id !== id) throw malformed(new TypeError("Machine response authority does not match the requested resource."));
      return machine;
    },
    async deleteMachine(id) {
      const safeId = encodeCanonicalUuid(id, "machine ID");
      return transport.request({ method: "DELETE", path: `/v1/sessions/${safeId}` });
    },
    async createWorkspaceBinding(input, idempotencyKey, signal) {
      validateWorkspaceBindingIdentity(input);
      assertIdempotencyKey(idempotencyKey);
      if (!Array.isArray(input.excludedPrefixes) || input.excludedPrefixes.length > 10_000) {
        throw new CunaError({ code: "cuna.usage.invalid", message: "Workspace excluded prefixes are invalid.", exitCode: EXIT_CODES.usage });
      }
      const prefixes = input.excludedPrefixes.map((prefix) => {
        if (typeof prefix !== "string" || prefix.length < 1 || prefix.length > 4_096 ||
          prefix.startsWith("/") || prefix.startsWith("\\") || prefix.includes("\\") ||
          containsAsciiControl(prefix) || /^[A-Za-z]:/u.test(prefix) ||
          prefix.split("/").some((part) => part === "" || part === "." || part === "..")) {
          throw new CunaError({ code: "cuna.usage.invalid", message: "Workspace excluded prefixes are invalid.", exitCode: EXIT_CODES.usage });
        }
        return prefix;
      });
      if (new Set(prefixes).size !== prefixes.length) {
        throw new CunaError({ code: "cuna.usage.invalid", message: "Workspace excluded prefixes must be unique.", exitCode: EXIT_CODES.usage });
      }
      const authority = decode(
        decodeWorkspaceBindingAuthority,
        await transport.request({
          method: "POST",
          path: "/v1/workspace-bindings",
          idempotencyKey,
          body: {
            workspace_id: input.workspaceId,
            project_id: input.projectId,
            local_instance_id: input.localInstanceId,
            machine_id: input.machineId,
            exclusion_policy_digest: input.exclusionPolicyDigest,
            excluded_prefixes: prefixes,
          },
          ...(signal === undefined ? {} : { signal }),
        }),
      );
      if (!workspaceBindingIdentityMatches(authority, input)) {
        throw malformed(new TypeError("Workspace binding response authority mismatch."));
      }
      return authority;
    },
    async getWorkspaceBinding(bindingId, identity, signal) {
      const safeId = encodeCanonicalUuid(bindingId, "workspace binding ID");
      validateWorkspaceBindingIdentity(identity);
      const authority = decode(
        decodeWorkspaceBindingAuthority,
        await transport.request({
          method: "GET",
          path: `/v1/workspace-bindings/${safeId}`,
          query: {
            workspace_id: identity.workspaceId,
            project_id: identity.projectId,
            local_instance_id: identity.localInstanceId,
            machine_id: identity.machineId,
            exclusion_policy_digest: identity.exclusionPolicyDigest,
          },
          ...(signal === undefined ? {} : { signal }),
        }),
      );
      if (authority.bindingId !== bindingId || !workspaceBindingIdentityMatches(authority, identity)) {
        throw malformed(new TypeError("Workspace binding response authority mismatch."));
      }
      return authority;
    },
    async listAgentSessions(machineId, options = {}, signal) {
      const safeId = encodeCanonicalUuid(machineId, "machine ID");
      const query = validatePageOptions(options);
      const raw = await transport.request({
        method: "GET",
        path: `/v1/sessions/${safeId}/agent-sessions`,
        query,
        ...(signal === undefined ? {} : { signal }),
      });
      const page = decode(decodeAgentSessionPage, raw);
      for (const session of page.items) assertAgentSessionBinding(session, { machineId });
      return page;
    },
    async createAgentSession(machineId, input, idempotencyKey, signal) {
      const safeId = encodeCanonicalUuid(machineId, "machine ID");
      validateAgentSessionCreate(input);
      const raw = await transport.request({
        method: "POST",
        path: `/v1/sessions/${safeId}/agent-sessions`,
        body: {
          ...(input.name === undefined ? {} : { name: input.name }),
          agent: input.agent,
          cwd: input.cwd,
          workspace_binding_id: input.workspaceBindingId,
          workspace_generation: input.workspaceGeneration,
          ...(input.authMode === undefined ? {} : { auth_mode: input.authMode }),
          ...(input.credentialBindingId === undefined
            ? {}
            : { credential_binding_id: input.credentialBindingId }),
        },
        idempotencyKey,
        ...(signal === undefined ? {} : { signal }),
      });
      return assertAgentSessionBinding(decode(decodeAgentSessionItem, raw), {
        machineId,
        workspaceBindingId: input.workspaceBindingId,
        workspaceGeneration: input.workspaceGeneration,
      });
    },
    async inspectAgentSessionCreate(idempotencyKey, signal) {
      assertIdempotencyKey(idempotencyKey);
      return decode(
        decodeAgentSessionItem,
        await transport.request({
          method: "GET",
          path: "/v1/agent-session-creates",
          idempotencyKey,
          ...(signal === undefined ? {} : { signal }),
        }),
      );
    },
    async getAgentSession(id, signal) {
      const safeId = encodeCanonicalUuid(id, "AgentSession ID");
      return assertAgentSessionBinding(
        decode(
          decodeAgentSessionItem,
          await transport.request({
            method: "GET",
            path: `/v1/agent-sessions/${safeId}`,
            ...(signal === undefined ? {} : { signal }),
          }),
        ),
        { id },
      );
    },
    async getAgentSessionAuth(id, signal) {
      const safeId = encodeCanonicalUuid(id, "AgentSession ID");
      const status = decode(
        decodeAgentSessionAuth,
        await transport.request({
          method: "GET",
          path: `/v1/agent-sessions/${safeId}/agent-auth`,
          ...(signal === undefined ? {} : { signal }),
        }),
      );
      if (status.agentSessionId !== id) {
        throw malformed(new TypeError("AgentSession authentication authority targets another resource."));
      }
      return status;
    },
    async logoutAgentSessionAuth(id, expectedProcessEpoch, signal) {
      const safeId = encodeCanonicalUuid(id, "AgentSession ID");
      const safeEpoch = assertCanonicalUuid(expectedProcessEpoch, "AgentSession process epoch");
      const result = decode(
        decodeAgentSessionAuthLogout,
        await transport.request({
          method: "POST",
          path: `/v1/agent-sessions/${safeId}/agent-auth/logout`,
          body: { process_epoch: safeEpoch },
          ...(signal === undefined ? {} : { signal }),
        }),
      );
      if (result.agentSessionId !== id || result.processEpoch !== expectedProcessEpoch) {
        throw malformed(new TypeError("AgentSession sign-out confirmation targets another resource."));
      }
      return result;
    },
    async renameAgentSession(id, name) {
      const safeId = encodeCanonicalUuid(id, "AgentSession ID");
      if (name.length < 1 || name.length > 80) {
        throw new CunaError({
          code: "cuna.usage.invalid",
          message: "AgentSession name must contain 1 through 80 characters.",
          exitCode: EXIT_CODES.usage,
        });
      }
      return assertAgentSessionBinding(
        decode(
          decodeAgentSessionItem,
          await transport.request({
            method: "PATCH",
            path: `/v1/agent-sessions/${safeId}`,
            body: { name },
          }),
        ),
        { id },
      );
    },
    async terminateAgentSession(id) {
      const safeId = encodeCanonicalUuid(id, "AgentSession ID");
      return assertAgentSessionBinding(
        decode(
          decodeAgentSessionItem,
          await transport.request({ method: "POST", path: `/v1/agent-sessions/${safeId}/terminate` }),
        ),
        { id },
      );
    },
    async createTerminalConnection(agentSessionId, input, idempotencyKey, signal) {
      const safeId = encodeCanonicalUuid(agentSessionId, "AgentSession ID");
      assertIdempotencyKey(idempotencyKey);
      if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(input.clientInstanceId)) {
        throw new CunaError({
          code: "cuna.usage.invalid",
          message: "Terminal client instance ID is malformed.",
          exitCode: EXIT_CODES.usage,
        });
      }
      if (
        input.resumeHandle !== undefined &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
          input.resumeHandle,
        )
      ) {
        throw new CunaError({
          code: "cuna.usage.invalid",
          message: "Terminal resume handle must be a canonical Cuna UUID.",
          exitCode: EXIT_CODES.usage,
        });
      }
      return decode(
        decodeTerminalConnectionGrant,
        await transport.request({
          method: "POST",
          path: `/v1/agent-sessions/${safeId}/terminal-connections`,
          body: {
            protocol: input.protocol,
            client_instance_id: input.clientInstanceId,
            ...(input.resumeHandle === undefined ? {} : { resume_handle: input.resumeHandle }),
          },
          idempotencyKey,
          ...(signal === undefined ? {} : { signal }),
        }),
      );
    },
  };
  return Object.freeze(client);
}

export type CapabilityDecision =
  | { readonly status: "supported"; readonly capabilityId: string }
  | { readonly status: "unsupported" | "temporarily_unavailable" | "unknown"; readonly capabilityId: string; readonly reason?: string };

export function decideCapability(
  snapshot: CapabilitySnapshot,
  capabilityId: string,
  now = Date.now(),
  allowedInteractions: readonly import("./contracts.js").CapabilityInteraction[] = ["native"],
): CapabilityDecision {
  if (classifyCapabilitySnapshot(snapshot, now) !== "valid") {
    return Object.freeze({ status: "unknown", capabilityId, reason: "snapshot_expired" });
  }
  const matches = snapshot.capabilities.filter((capability) => capability.id === capabilityId);
  if (matches.length !== 1) {
    return Object.freeze({
      status: "unknown",
      capabilityId,
      reason: matches.length === 0 ? "capability_absent" : "capability_ambiguous",
    });
  }
  const capability = matches[0];
  if (capability === undefined || capability.availability !== "supported") {
    return Object.freeze({
      status: capability?.availability ?? "unknown",
      capabilityId,
      ...(capability?.reasonCode === undefined ? {} : { reason: capability.reasonCode }),
    });
  }
  if (!capability.surfaces.includes("cli") || !allowedInteractions.includes(capability.interaction)) {
    return Object.freeze({ status: "unsupported", capabilityId, reason: "cli_interaction_mismatch" });
  }
  return Object.freeze({ status: "supported", capabilityId });
}

export async function requireCapability(input: {
  readonly client: RunaApiClient;
  readonly scope: CapabilityScope;
  readonly resourceId?: string;
  readonly capabilityId: string;
  readonly now?: number;
  readonly allowedInteractions?: readonly import("./contracts.js").CapabilityInteraction[];
  readonly signal?: AbortSignal;
}): Promise<void> {
  let snapshot: CapabilitySnapshot;
  try {
    snapshot = await input.client.discoverCapabilities(input.scope, input.resourceId, input.signal);
  } catch (error) {
    if (error instanceof CunaError && error.code === "cuna.remote.not_found") {
      throw new CunaError({
        code: "cuna.capability.discovery_unavailable",
        message: "This Cuna deployment does not expose capability discovery.",
        exitCode: EXIT_CODES.unsupported,
        hint: "No mutation was attempted. Update the Cuna server contract before retrying.",
        details: { capability_id: input.capabilityId },
        cause: error,
      });
    }
    throw error;
  }
  if (
    snapshot.subjectScope !== input.scope ||
    (input.scope !== "account" && snapshot.subjectId !== input.resourceId)
  ) {
    throw new CunaError({
      code: "cuna.capability.unknown",
      message: `Cuna cannot currently authorize the ${input.capabilityId} capability.`,
      exitCode: EXIT_CODES.unsupported,
      details: {
        capability_id: input.capabilityId,
        availability: "unknown",
        reason: "subject_scope_mismatch",
      },
    });
  }
  const decision = decideCapability(snapshot, input.capabilityId, input.now, input.allowedInteractions);
  if (decision.status === "supported") return;
  throw new CunaError({
    code:
      decision.status === "temporarily_unavailable"
        ? "cuna.capability.temporarily_unavailable"
        : decision.status === "unsupported"
          ? "cuna.capability.unsupported"
          : "cuna.capability.unknown",
    message: `Cuna cannot currently authorize the ${input.capabilityId} capability.`,
    exitCode:
      decision.status === "temporarily_unavailable" ? EXIT_CODES.network : EXIT_CODES.unsupported,
    retryable: decision.status === "temporarily_unavailable",
    details: {
      capability_id: input.capabilityId,
      availability: decision.status,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    },
  });
}
