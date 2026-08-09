import {
  isObject,
  optionalDisplayString,
  optionalNumber,
  optionalString,
  requiredDisplayString,
  requiredString,
} from "../core/validation.js";

export type CapabilityAvailability =
  | "supported"
  | "unsupported"
  | "temporarily_unavailable"
  | "unknown";
export type CapabilityInteraction = "native" | "read_only" | "browser_handoff" | "unknown";
export type MutationClass =
  | "none"
  | "reversible"
  | "destructive"
  | "secret_revealing"
  | "financial"
  | "unknown";
export type CapabilityScope = "account" | "machine" | "agent_session";

export interface Capability {
  readonly id: string;
  readonly availability: CapabilityAvailability;
  readonly interaction: CapabilityInteraction;
  readonly mutationClass: MutationClass;
  readonly surfaces: readonly string[];
  readonly requiredPermissions: readonly string[];
  readonly reasonCode?: string;
}

export interface CapabilitySnapshot {
  readonly schemaVersion: string;
  readonly subjectScope: CapabilityScope;
  readonly subjectId?: string;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly etag: string;
  readonly capabilities: readonly Capability[];
}

const AVAILABILITY = new Set(["supported", "unsupported", "temporarily_unavailable", "unknown"]);
const INTERACTION = new Set(["native", "read_only", "browser_handoff"]);
const MUTATION = new Set(["none", "reversible", "destructive", "secret_revealing", "financial"]);
const SCOPE = new Set(["account", "machine", "agent_session"]);

function stringArray(value: unknown, key: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`Malformed field: ${key}`);
  }
  return Object.freeze([...value] as string[]);
}

function decodeCapability(value: unknown): Capability {
  if (!isObject(value)) throw new TypeError("Malformed capability");
  const id = requiredString(value, "id");
  const rawAvailability = requiredString(value, "availability");
  const rawInteraction = requiredString(value, "interaction");
  const rawMutation = requiredString(value, "mutation_class");
  const known =
    AVAILABILITY.has(rawAvailability) && INTERACTION.has(rawInteraction) && MUTATION.has(rawMutation);
  const reasonCode = optionalString(value, "reason_code");
  return Object.freeze({
    id,
    availability: (known ? rawAvailability : "unknown") as CapabilityAvailability,
    interaction: (INTERACTION.has(rawInteraction) ? rawInteraction : "unknown") as CapabilityInteraction,
    mutationClass: (MUTATION.has(rawMutation) ? rawMutation : "unknown") as MutationClass,
    surfaces: stringArray(value.surfaces, "surfaces"),
    requiredPermissions: stringArray(value.required_permissions, "required_permissions"),
    ...(reasonCode === undefined ? {} : { reasonCode }),
  });
}

export function decodeCapabilitySnapshot(value: unknown): CapabilitySnapshot {
  if (!isObject(value)) throw new TypeError("Malformed capability snapshot");
  const rawScope = requiredString(value, "subject_scope");
  if (!SCOPE.has(rawScope)) throw new TypeError("Malformed capability scope");
  if (!Array.isArray(value.capabilities)) throw new TypeError("Malformed capabilities");
  const subjectId = optionalString(value, "subject_id");
  const snapshot = Object.freeze({
    schemaVersion: requiredString(value, "schema_version"),
    subjectScope: rawScope as CapabilityScope,
    ...(subjectId === undefined ? {} : { subjectId }),
    observedAt: requiredString(value, "observed_at"),
    expiresAt: requiredString(value, "expires_at"),
    etag: requiredString(value, "etag"),
    capabilities: Object.freeze(value.capabilities.map(decodeCapability)),
  });
  if (!Number.isFinite(Date.parse(snapshot.observedAt)) || !Number.isFinite(Date.parse(snapshot.expiresAt))) {
    throw new TypeError("Malformed capability time");
  }
  return snapshot;
}

export interface Machine {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly agent?: string;
  readonly vcpus?: number;
  readonly memoryMiB?: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface MachinePage {
  readonly items: readonly Machine[];
  readonly nextCursor?: string;
}

function decodeMachine(value: unknown): Machine {
  if (!isObject(value)) throw new TypeError("Malformed machine");
  const state = optionalDisplayString(value, "state") ?? optionalDisplayString(value, "status") ?? "unknown";
  const memoryMiB = optionalNumber(value, "memory_mib");
  const vcpus = optionalNumber(value, "vcpus");
  const agent = optionalDisplayString(value, "agent");
  const createdAt = optionalString(value, "created_at");
  const updatedAt = optionalString(value, "updated_at");
  return Object.freeze({
    id: requiredString(value, "id"),
    name: optionalDisplayString(value, "name") ?? optionalDisplayString(value, "slug") ?? requiredString(value, "id"),
    state,
    ...(agent === undefined ? {} : { agent }),
    ...(vcpus === undefined ? {} : { vcpus }),
    ...(memoryMiB === undefined ? {} : { memoryMiB }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  });
}

export function decodeMachinePage(value: unknown): MachinePage {
  if (Array.isArray(value)) return Object.freeze({ items: Object.freeze(value.map(decodeMachine)) });
  if (!isObject(value) || !Array.isArray(value.items)) throw new TypeError("Malformed machine page");
  const nextCursor = optionalString(value, "next_cursor");
  return Object.freeze({
    items: Object.freeze(value.items.map(decodeMachine)),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

export function decodeMachineItem(value: unknown): Machine {
  return decodeMachine(value);
}

export type AgentKind = "claude-code" | "codex" | "openclaw";
export type AgentAuthMode = "interactive_login" | "credential_binding";
export type AgentSessionDesiredState = "running" | "terminated";
export type AgentSessionRequestState =
  | "launch_pending"
  | "runtime_claimed"
  | "launched"
  | "termination_pending"
  | "terminal"
  | "failed";
export type AgentSessionProcessState =
  | "unknown"
  | "starting"
  | "ready"
  | "running"
  | "exited"
  | "failed"
  | "terminating"
  | "terminated";
export interface AgentSession {
  readonly id: string;
  readonly machineId: string;
  readonly name: string;
  readonly agent: AgentKind;
  readonly cwd: string;
  readonly authMode: AgentAuthMode;
  readonly desiredState: AgentSessionDesiredState;
  readonly requestState: AgentSessionRequestState;
  readonly processState: AgentSessionProcessState;
  readonly processEpoch?: string;
  readonly runtimeObservedAt?: string;
  readonly terminationRequestedAt?: string;
  readonly rowVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentSessionPage {
  readonly items: readonly AgentSession[];
  readonly nextCursor?: string;
}

const AGENTS = new Set<AgentKind>(["claude-code", "codex", "openclaw"]);
const AUTH_MODES = new Set<AgentAuthMode>(["interactive_login", "credential_binding"]);
const DESIRED_STATES = new Set<AgentSessionDesiredState>(["running", "terminated"]);
const REQUEST_STATES = new Set<AgentSessionRequestState>([
  "launch_pending", "runtime_claimed", "launched", "termination_pending", "terminal", "failed",
]);
const PROCESS_STATES = new Set<AgentSessionProcessState>([
  "unknown", "starting", "ready", "running", "exited", "failed", "terminating", "terminated",
]);

function enumField<T extends string>(value: Record<string, unknown>, key: string, allowed: ReadonlySet<T>): T {
  const decoded = requiredString(value, key);
  if (!allowed.has(decoded as T)) throw new TypeError(`Malformed field: ${key}`);
  return decoded as T;
}

function decodeAgentSession(value: unknown): AgentSession {
  if (!isObject(value)) throw new TypeError("Malformed agent session");
  const agent = enumField(value, "agent", AGENTS);
  const authMode = enumField(value, "auth_mode", AUTH_MODES);
  const desiredState = enumField(value, "desired_state", DESIRED_STATES);
  const requestState = enumField(value, "request_state", REQUEST_STATES);
  const processState = enumField(value, "process_state", PROCESS_STATES);
  const processEpoch = optionalString(value, "process_epoch");
  const runtimeObservedAt = optionalString(value, "runtime_observed_at");
  const terminationRequestedAt = optionalString(value, "termination_requested_at");
  const rowVersion = optionalNumber(value, "row_version");
  if (rowVersion === undefined || !Number.isSafeInteger(rowVersion) || rowVersion < 0) {
    throw new TypeError("Malformed field: row_version");
  }
  return Object.freeze({
    id: requiredString(value, "id"),
    machineId: requiredString(value, "machine_id"),
    name: requiredDisplayString(value, "name"),
    agent,
    cwd: requiredDisplayString(value, "cwd"),
    authMode,
    desiredState,
    requestState,
    processState,
    ...(processEpoch === undefined ? {} : { processEpoch }),
    ...(runtimeObservedAt === undefined ? {} : { runtimeObservedAt }),
    ...(terminationRequestedAt === undefined ? {} : { terminationRequestedAt }),
    rowVersion,
    createdAt: requiredString(value, "created_at"),
    updatedAt: requiredString(value, "updated_at"),
  });
}

export function decodeAgentSessionPage(value: unknown): AgentSessionPage {
  if (Array.isArray(value)) return Object.freeze({ items: Object.freeze(value.map(decodeAgentSession)) });
  if (!isObject(value) || !Array.isArray(value.items)) throw new TypeError("Malformed agent-session page");
  const nextCursor = optionalString(value, "next_cursor");
  return Object.freeze({
    items: Object.freeze(value.items.map(decodeAgentSession)),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

export function decodeAgentSessionItem(value: unknown): AgentSession {
  return decodeAgentSession(value);
}
