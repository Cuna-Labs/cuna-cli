import { EXIT_CODES, RunaError } from "../core/errors.js";
import { encodePublicId } from "../core/validation.js";
import {
  decodeAgentSessionItem,
  decodeAgentSessionPage,
  decodeCapabilitySnapshot,
  decodeMachineItem,
  decodeMachinePage,
  type AgentKind,
  type AgentSession,
  type AgentSessionPage,
  type CapabilityScope,
  type CapabilitySnapshot,
  type Machine,
  type MachinePage,
} from "./contracts.js";
import type { HttpTransport } from "./http.js";

export interface MachineCreateInput {
  readonly name?: string;
  readonly agent?: AgentKind;
  readonly vcpus?: number;
  readonly memoryMiB?: number;
  readonly background?: boolean;
}

export interface AgentSessionCreateInput {
  readonly agent: AgentKind;
  readonly cwd: string;
}

export interface RunaApiClient {
  discoverCapabilities(scope: CapabilityScope, resourceId?: string): Promise<CapabilitySnapshot>;
  listMachines(): Promise<MachinePage>;
  createMachine(input: MachineCreateInput, idempotencyKey: string): Promise<Machine>;
  transitionMachine(id: string, action: "start" | "pause" | "resume" | "stop"): Promise<Machine>;
  deleteMachine(id: string): Promise<unknown>;
  listAgentSessions(machineId: string): Promise<AgentSessionPage>;
  createAgentSession(
    machineId: string,
    input: AgentSessionCreateInput,
    idempotencyKey: string,
  ): Promise<AgentSession>;
  getAgentSession(id: string): Promise<AgentSession>;
  terminateAgentSession(id: string): Promise<AgentSession>;
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

export function createRunaApiClient(transport: HttpTransport): RunaApiClient {
  const client: RunaApiClient = {
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
      const body = {
        ...(input.name === undefined ? {} : { name: input.name }),
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
      return decode(decodeMachineItem, raw);
    },
    async deleteMachine(id) {
      const safeId = encodePublicId(id, "machine ID");
      return transport.request({ method: "DELETE", path: `/v1/sessions/${safeId}` });
    },
    async listAgentSessions(machineId) {
      const safeId = encodePublicId(machineId, "machine ID");
      const raw = await transport.request({
        method: "GET",
        path: `/v1/sessions/${safeId}/agent-sessions`,
      });
      return decode(decodeAgentSessionPage, raw);
    },
    async createAgentSession(machineId, input, idempotencyKey) {
      const safeId = encodePublicId(machineId, "machine ID");
      const raw = await transport.request({
        method: "POST",
        path: `/v1/sessions/${safeId}/agent-sessions`,
        body: { agent: input.agent, cwd: input.cwd },
        idempotencyKey,
      });
      return decode(decodeAgentSessionItem, raw);
    },
    async getAgentSession(id) {
      const safeId = encodePublicId(id, "AgentSession ID");
      return decode(
        decodeAgentSessionItem,
        await transport.request({ method: "GET", path: `/v1/agent-sessions/${safeId}` }),
      );
    },
    async terminateAgentSession(id) {
      const safeId = encodePublicId(id, "AgentSession ID");
      return decode(
        decodeAgentSessionItem,
        await transport.request({ method: "POST", path: `/v1/agent-sessions/${safeId}/terminate` }),
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
  if (Date.parse(snapshot.expiresAt) <= now) {
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
