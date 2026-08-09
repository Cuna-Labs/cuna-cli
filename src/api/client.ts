import { EXIT_CODES, RunaError } from "../core/errors.js";
import { assertIdempotencyKey, assertPublicId, assertSafeDisplayText, encodePublicId } from "../core/validation.js";
import {
  decodeAgentSessionItem,
  decodeAgentSessionPage,
  decodeCapabilitySnapshot,
  decodeMachineItem,
  decodeMachinePage,
  decodeRunaIdentity,
  decodeTerminalConnectionGrant,
  type AgentKind,
  type AgentAuthMode,
  type AgentSession,
  type AgentSessionPage,
  type CapabilityScope,
  type CapabilitySnapshot,
  type Machine,
  type MachinePage,
  type RunaIdentity,
  type TerminalConnectionGrant,
} from "./contracts.js";
import type { HttpTransport } from "./http.js";

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
  readonly authMode?: AgentAuthMode;
  readonly credentialBindingId?: string;
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
  getIdentity(): Promise<RunaIdentity>;
  discoverCapabilities(scope: CapabilityScope, resourceId?: string): Promise<CapabilitySnapshot>;
  listMachines(): Promise<MachinePage>;
  createMachine(input: MachineCreateInput, idempotencyKey: string): Promise<Machine>;
  transitionMachine(id: string, action: "start" | "pause" | "resume" | "stop"): Promise<Machine>;
  deleteMachine(id: string): Promise<unknown>;
  listAgentSessions(machineId: string, options?: PageOptions): Promise<AgentSessionPage>;
  createAgentSession(
    machineId: string,
    input: AgentSessionCreateInput,
    idempotencyKey: string,
  ): Promise<AgentSession>;
  getAgentSession(id: string): Promise<AgentSession>;
  renameAgentSession(id: string, name: string): Promise<AgentSession>;
  terminateAgentSession(id: string): Promise<AgentSession>;
  createTerminalConnection(
    agentSessionId: string,
    input: TerminalConnectionCreateInput,
    idempotencyKey: string,
  ): Promise<TerminalConnectionGrant>;
}

function malformed(cause: unknown): RunaError {
  return new RunaError({
    code: "runa.remote.malformed_response",
    message: "Runa returned a response that does not match the public contract.",
    exitCode: EXIT_CODES.remote,
    cause,
  });
}

function decode<T>(decoder: (value: unknown) => T, value: unknown): T {
  try {
    return decoder(value);
  } catch (error) {
    if (error instanceof RunaError) throw error;
    throw malformed(error);
  }
}

function assertAgentSessionBinding(
  session: AgentSession,
  expected: { readonly id?: string; readonly machineId?: string },
): AgentSession {
  if (
    (expected.id !== undefined && session.id !== expected.id) ||
    (expected.machineId !== undefined && session.machineId !== expected.machineId)
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
    throw new RunaError({
      code: "runa.usage.invalid",
      message: "AgentSession page limit must be an integer from 1 through 100.",
      exitCode: EXIT_CODES.usage,
    });
  }
  if (
    options.cursor !== undefined &&
    (options.cursor.length < 1 || options.cursor.length > 512 || containsAsciiControl(options.cursor))
  ) {
    throw new RunaError({
      code: "runa.usage.invalid",
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
  if (input.name !== undefined && (input.name.length < 1 || input.name.length > 80)) {
    throw new RunaError({
      code: "runa.usage.invalid",
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
    throw new RunaError({
      code: "runa.usage.invalid",
      message: "AgentSession cwd must be a safe absolute path inside /workspace.",
      exitCode: EXIT_CODES.usage,
    });
  }
  if (input.authMode === "credential_binding" && input.credentialBindingId === undefined) {
    throw new RunaError({
      code: "runa.usage.invalid",
      message: "credential_binding auth mode requires a credential binding ID.",
      exitCode: EXIT_CODES.usage,
    });
  }
  if (input.authMode !== "credential_binding" && input.credentialBindingId !== undefined) {
    throw new RunaError({
      code: "runa.usage.invalid",
      message: "A credential binding ID requires credential_binding auth mode.",
      exitCode: EXIT_CODES.usage,
    });
  }
  if (input.credentialBindingId !== undefined) {
    assertPublicId(input.credentialBindingId, "credential binding ID");
  }
}

function validateMachineCreate(input: MachineCreateInput, idempotencyKey: string): void {
  assertIdempotencyKey(idempotencyKey);
  assertSafeDisplayText(input.name, "machine name");
  if (input.name.length < 1 || input.name.length > 80) {
    throw new RunaError({
      code: "runa.usage.invalid",
      message: "Machine name must contain 1 through 80 characters.",
      exitCode: EXIT_CODES.usage,
    });
  }
  if (input.vcpus !== undefined && (!Number.isInteger(input.vcpus) || input.vcpus < 1 || input.vcpus > 8)) {
    throw new RunaError({
      code: "runa.usage.invalid",
      message: "Machine vcpus must be an integer from 1 through 8.",
      exitCode: EXIT_CODES.usage,
    });
  }
  if (
    input.memoryMiB !== undefined &&
    (!Number.isInteger(input.memoryMiB) || input.memoryMiB < 512 || input.memoryMiB > 16_384)
  ) {
    throw new RunaError({
      code: "runa.usage.invalid",
      message: "Machine memoryMiB must be an integer from 512 through 16384.",
      exitCode: EXIT_CODES.usage,
    });
  }
}

export function createRunaApiClient(transport: HttpTransport): RunaApiClient {
  const client: RunaApiClient = {
    async getIdentity() {
      return decode(
        decodeRunaIdentity,
        await transport.request({ method: "GET", path: "/v1/me" }),
      );
    },
    async discoverCapabilities(scope, resourceId) {
      const raw = await transport.request({
        method: "GET",
        path: "/v1/capabilities",
        query: { scope, resource_id: resourceId },
      });
      return decode(decodeCapabilitySnapshot, raw);
    },
    async listMachines() {
      return decode(decodeMachinePage, await transport.request({ method: "GET", path: "/v1/sessions" }));
    },
    async createMachine(input, idempotencyKey) {
      validateMachineCreate(input, idempotencyKey);
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
      });
      return decode(decodeMachineItem, raw);
    },
    async transitionMachine(id, action) {
      const safeId = encodePublicId(id, "machine ID");
      const raw = await transport.request({
        method: "POST",
        path: `/v1/sessions/${safeId}/${action}`,
      });
      const machine = decode(decodeMachineItem, raw);
      if (machine.id !== id) throw malformed(new TypeError("Machine response authority does not match the requested resource."));
      return machine;
    },
    async deleteMachine(id) {
      const safeId = encodePublicId(id, "machine ID");
      return transport.request({ method: "DELETE", path: `/v1/sessions/${safeId}` });
    },
    async listAgentSessions(machineId, options = {}) {
      const safeId = encodePublicId(machineId, "machine ID");
      const query = validatePageOptions(options);
      const raw = await transport.request({
        method: "GET",
        path: `/v1/sessions/${safeId}/agent-sessions`,
        query,
      });
      const page = decode(decodeAgentSessionPage, raw);
      for (const session of page.items) assertAgentSessionBinding(session, { machineId });
      return page;
    },
    async createAgentSession(machineId, input, idempotencyKey) {
      const safeId = encodePublicId(machineId, "machine ID");
      validateAgentSessionCreate(input);
      const raw = await transport.request({
        method: "POST",
        path: `/v1/sessions/${safeId}/agent-sessions`,
        body: {
          ...(input.name === undefined ? {} : { name: input.name }),
          agent: input.agent,
          cwd: input.cwd,
          ...(input.authMode === undefined ? {} : { auth_mode: input.authMode }),
          ...(input.credentialBindingId === undefined
            ? {}
            : { credential_binding_id: input.credentialBindingId }),
        },
        idempotencyKey,
      });
      return assertAgentSessionBinding(decode(decodeAgentSessionItem, raw), { machineId });
    },
    async getAgentSession(id) {
      const safeId = encodePublicId(id, "AgentSession ID");
      return assertAgentSessionBinding(
        decode(
          decodeAgentSessionItem,
          await transport.request({ method: "GET", path: `/v1/agent-sessions/${safeId}` }),
        ),
        { id },
      );
    },
    async renameAgentSession(id, name) {
      const safeId = encodePublicId(id, "AgentSession ID");
      if (name.length < 1 || name.length > 80) {
        throw new RunaError({
          code: "runa.usage.invalid",
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
      const safeId = encodePublicId(id, "AgentSession ID");
      return assertAgentSessionBinding(
        decode(
          decodeAgentSessionItem,
          await transport.request({ method: "POST", path: `/v1/agent-sessions/${safeId}/terminate` }),
        ),
        { id },
      );
    },
    async createTerminalConnection(agentSessionId, input, idempotencyKey) {
      const safeId = encodePublicId(agentSessionId, "AgentSession ID");
      assertIdempotencyKey(idempotencyKey);
      if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(input.clientInstanceId)) {
        throw new RunaError({
          code: "runa.usage.invalid",
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
        throw new RunaError({
          code: "runa.usage.invalid",
          message: "Terminal resume handle must be a canonical Runa UUID.",
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
): CapabilityDecision {
  const observedAt = Date.parse(snapshot.observedAt);
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (expiresAt <= now || observedAt > now + 60_000 || expiresAt <= observedAt) {
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
  if (!capability.surfaces.includes("cli") || capability.interaction !== "native") {
    return Object.freeze({ status: "unsupported", capabilityId, reason: "not_native_cli" });
  }
  return Object.freeze({ status: "supported", capabilityId });
}

export async function requireCapability(input: {
  readonly client: RunaApiClient;
  readonly scope: CapabilityScope;
  readonly resourceId?: string;
  readonly capabilityId: string;
  readonly now?: number;
}): Promise<void> {
  let snapshot: CapabilitySnapshot;
  try {
    snapshot = await input.client.discoverCapabilities(input.scope, input.resourceId);
  } catch (error) {
    if (error instanceof RunaError && error.code === "runa.remote.not_found") {
      throw new RunaError({
        code: "runa.capability.discovery_unavailable",
        message: "This Runa deployment does not expose capability discovery.",
        exitCode: EXIT_CODES.unsupported,
        hint: "No mutation was attempted. Update the Runa server contract before retrying.",
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
    throw new RunaError({
      code: "runa.capability.unknown",
      message: `Runa cannot currently authorize the ${input.capabilityId} capability.`,
      exitCode: EXIT_CODES.unsupported,
      details: {
        capability_id: input.capabilityId,
        availability: "unknown",
        reason: "subject_scope_mismatch",
      },
    });
  }
  const decision = decideCapability(snapshot, input.capabilityId, input.now);
  if (decision.status === "supported") return;
  throw new RunaError({
    code:
      decision.status === "temporarily_unavailable"
        ? "runa.capability.temporarily_unavailable"
        : decision.status === "unsupported"
          ? "runa.capability.unsupported"
          : "runa.capability.unknown",
    message: `Runa cannot currently authorize the ${input.capabilityId} capability.`,
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
