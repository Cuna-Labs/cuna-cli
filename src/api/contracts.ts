import {
  containsCredentialValue,
  isApiKeyDisplayPrefix,
  isTerminalConnectToken,
  isTerminalStreamUrl,
} from "../core/namespace.js";
import {
  contractViolation,
  isObject,
  optionalDisplayString,
  optionalNumber,
  optionalString,
  requiredDisplayString,
  requiredString,
  underField,
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
  readonly schemaVersion: "1.0";
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
    throw contractViolation("array_of_strings", key);
  }
  return Object.freeze([...value] as string[]);
}

function decodeCapability(value: unknown): Capability {
  if (!isObject(value)) throw contractViolation("object");
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
  if (!isObject(value)) throw contractViolation("object");
  const rawScope = requiredString(value, "subject_scope");
  if (!SCOPE.has(rawScope)) throw contractViolation("known_subject_scope", "subject_scope");
  if (!Array.isArray(value.capabilities)) throw contractViolation("array", "capabilities");
  const subjectId = optionalString(value, "subject_id");
  const schemaVersion = requiredString(value, "schema_version");
  if (schemaVersion !== "1.0") throw contractViolation("supported_schema_version", "schema_version");
  const snapshot = Object.freeze({
    schemaVersion,
    subjectScope: rawScope as CapabilityScope,
    ...(subjectId === undefined ? {} : { subjectId }),
    observedAt: requiredString(value, "observed_at"),
    expiresAt: requiredString(value, "expires_at"),
    etag: requiredString(value, "etag"),
    capabilities: Object.freeze(
      value.capabilities.map((item, index) =>
        underField(`capabilities[${index}]`, () => decodeCapability(item))),
    ),
  });
  // Split from one compound check into two, because they name different fields.
  // Reported together, a stale `expires_at` sent the reader to `observed_at`.
  if (!Number.isFinite(Date.parse(snapshot.observedAt))) {
    throw contractViolation("parsable_timestamp", "observed_at");
  }
  if (!Number.isFinite(Date.parse(snapshot.expiresAt))) {
    throw contractViolation("parsable_timestamp", "expires_at");
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

export type MachineCreateRequestState =
  | "prepared"
  | "in_progress"
  | "unknown"
  | "provider_succeeded"
  | "settled"
  | "terminal_failed";

export interface MachineCreateRequest {
  readonly id: string;
  readonly machineId: string;
  readonly state: MachineCreateRequestState;
  readonly retryable: boolean;
  readonly action: "retry_create" | "reconcile" | "wait" | "none";
  readonly updatedAt: string;
}

export interface WorkspaceBindingAuthority {
  readonly bindingId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly localInstanceId: string;
  readonly machineId: string;
  readonly remoteRoot: string;
  readonly exclusionPolicyDigest: string;
  readonly activeGeneration: number;
  readonly activeManifestRoot: string;
  readonly bindingEpoch: number;
  readonly minimumReader: number;
  readonly minimumWriter: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function decodeMachine(value: unknown): Machine {
  if (!isObject(value)) throw contractViolation("object");
  const state = optionalDisplayString(value, "state") ?? optionalDisplayString(value, "status") ?? "unknown";
  const memoryMiB = optionalNumber(value, "memory_mib");
  const vcpus = optionalNumber(value, "vcpus");
  const agent = optionalDisplayString(value, "agent");
  const createdAt = optionalString(value, "created_at");
  const updatedAt = optionalString(value, "updated_at");
  return Object.freeze({
    id: canonicalUuid(value, "id"),
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
  if (Array.isArray(value)) {
    return Object.freeze({
      items: Object.freeze(value.map((item, index) =>
        underField(`[${index}]`, () => decodeMachine(item)))),
    });
  }
  if (!isObject(value) || !Array.isArray(value.items)) throw contractViolation("object_with_items_array");
  const nextCursor = optionalString(value, "next_cursor");
  return Object.freeze({
    items: Object.freeze(value.items.map((item, index) =>
      underField(`items[${index}]`, () => decodeMachine(item)))),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

export function decodeMachineItem(value: unknown): Machine {
  return decodeMachine(value);
}

export function decodeMachineCreateRequest(value: unknown): MachineCreateRequest {
  if (!isObject(value)) throw contractViolation("object");
  exactKeys(value, ["id", "machine_id", "state", "retryable", "action", "updated_at"]);
  const state = requiredString(value, "state") as MachineCreateRequestState;
  const action = requiredString(value, "action") as MachineCreateRequest["action"];
  const updatedAt = requiredString(value, "updated_at");
  if (!new Set<MachineCreateRequestState>([
    "prepared", "in_progress", "unknown", "provider_succeeded", "settled", "terminal_failed",
  ]).has(state)) {
    throw contractViolation("known_enum_value", "state");
  }
  if (!new Set<MachineCreateRequest["action"]>(["retry_create", "reconcile", "wait", "none"]).has(action)) {
    throw contractViolation("known_enum_value", "action");
  }
  if (typeof value.retryable !== "boolean") throw contractViolation("boolean", "retryable");
  if (!Number.isFinite(Date.parse(updatedAt))) throw contractViolation("parsable_timestamp", "updated_at");
  return Object.freeze({
    id: canonicalUuid(value, "id"),
    machineId: canonicalUuid(value, "machine_id"),
    state,
    retryable: value.retryable,
    action,
    updatedAt,
  });
}

export function decodeWorkspaceBindingAuthority(value: unknown): WorkspaceBindingAuthority {
  if (!isObject(value)) throw contractViolation("object");
  exactKeys(value, [
    "binding_id", "workspace_id", "project_id", "local_instance_id", "machine_id",
    "remote_root", "exclusion_policy_digest", "active_generation", "active_manifest_root",
    "binding_epoch", "minimum_reader", "minimum_writer", "created_at", "updated_at",
  ]);
  const bindingId = canonicalUuid(value, "binding_id");
  const projectId = canonicalUuid(value, "project_id");
  const exclusionPolicyDigest = requiredString(value, "exclusion_policy_digest");
  const activeManifestRoot = requiredString(value, "active_manifest_root");
  const remoteRoot = requiredString(value, "remote_root");
  const createdAt = requiredString(value, "created_at");
  const updatedAt = requiredString(value, "updated_at");
  const activeGeneration = optionalNumber(value, "active_generation");
  const bindingEpoch = optionalNumber(value, "binding_epoch");
  const minimumReader = optionalNumber(value, "minimum_reader");
  const minimumWriter = optionalNumber(value, "minimum_writer");
  if (remoteRoot !== `/workspace/projects/${projectId}`) {
    throw contractViolation("remote_root_derives_from_project_id", "remote_root");
  }
  if (!/^[0-9a-f]{64}$/u.test(exclusionPolicyDigest)) {
    throw contractViolation("sha256_digest", "exclusion_policy_digest");
  }
  if (!/^[0-9a-f]{64}$/u.test(activeManifestRoot)) {
    throw contractViolation("sha256_digest", "active_manifest_root");
  }
  if (!Number.isSafeInteger(activeGeneration) || Number(activeGeneration) < 0) {
    throw contractViolation("safe_non_negative_integer", "active_generation");
  }
  if (!Number.isSafeInteger(bindingEpoch) || Number(bindingEpoch) < 1) {
    throw contractViolation("safe_positive_integer", "binding_epoch");
  }
  if (!Number.isSafeInteger(minimumReader) || Number(minimumReader) < 1) {
    throw contractViolation("safe_positive_integer", "minimum_reader");
  }
  if (!Number.isSafeInteger(minimumWriter) || Number(minimumWriter) < 1) {
    throw contractViolation("safe_positive_integer", "minimum_writer");
  }
  if (!Number.isFinite(Date.parse(createdAt))) throw contractViolation("parsable_timestamp", "created_at");
  if (!Number.isFinite(Date.parse(updatedAt))) throw contractViolation("parsable_timestamp", "updated_at");
  return Object.freeze({
    bindingId,
    workspaceId: canonicalUuid(value, "workspace_id"),
    projectId,
    localInstanceId: canonicalUuid(value, "local_instance_id"),
    machineId: canonicalUuid(value, "machine_id"),
    remoteRoot,
    exclusionPolicyDigest,
    activeGeneration: Number(activeGeneration),
    activeManifestRoot,
    bindingEpoch: Number(bindingEpoch),
    minimumReader: Number(minimumReader),
    minimumWriter: Number(minimumWriter),
    createdAt,
    updatedAt,
  });
}

export interface RunaIdentity {
  readonly id: string;
  readonly email: string;
  readonly workspaceAssigned: boolean;
  readonly workspaceId?: string;
  readonly workspaceUsage?: {
    readonly estimatedSpendUsd: number;
    readonly estimatedRemainingUsd: number;
    readonly note: string;
  };
  readonly waitlistPosition?: number;
}

/**
 * Decode `/v1/me`.
 *
 * THE COMPOUND CHECKS BELOW WERE SPLIT DELIBERATELY, and the accept/reject
 * boundary is unchanged: exactly the same bodies are accepted and rejected as
 * before. What changed is that a rejection now names ONE field.
 *
 * This is the decoder that motivated the whole change. Production omits
 * `workspace.id` while its own published OpenAPI marks it required when
 * `assigned` is true, so this function is the single most likely source of
 * `cuna.remote.malformed_response` in the field — and it used to answer with
 * "Malformed Cuna workspace identity" for any of TEN different faults. The one
 * fact the user needed was already computed here and thrown away.
 */
export function decodeRunaIdentity(value: unknown): RunaIdentity {
  if (!isObject(value)) throw contractViolation("object");
  if (!isObject(value.workspace)) throw contractViolation("object", "workspace");
  if (Object.keys(value).some((key) => key !== "id" && key !== "email" && key !== "workspace")) {
    throw contractViolation("no_unknown_fields");
  }
  const assigned = value.workspace.assigned;
  if (typeof assigned !== "boolean") throw contractViolation("boolean", "workspace.assigned");
  const workspaceKeys = Object.keys(value.workspace);
  if (assigned) {
    if (workspaceKeys.some((key) => key !== "assigned" && key !== "id" && key !== "usage")) {
      throw contractViolation("no_unknown_fields", "workspace");
    }
    // The measured production defect lands exactly here.
    if (typeof value.workspace.id !== "string") {
      throw contractViolation("required_when_workspace_assigned", "workspace.id");
    }
    if (!isObject(value.workspace.usage)) {
      throw contractViolation("required_when_workspace_assigned", "workspace.usage");
    }
    if (Object.keys(value.workspace.usage).some(
      (key) => key !== "est_spend_usd" && key !== "est_remaining_usd" && key !== "note",
    )) {
      throw contractViolation("no_unknown_fields", "workspace.usage");
    }
    if (
      typeof value.workspace.usage.est_spend_usd !== "number" ||
      !Number.isFinite(value.workspace.usage.est_spend_usd)
    ) {
      throw contractViolation("finite_number", "workspace.usage.est_spend_usd");
    }
    if (
      typeof value.workspace.usage.est_remaining_usd !== "number" ||
      !Number.isFinite(value.workspace.usage.est_remaining_usd)
    ) {
      throw contractViolation("finite_number", "workspace.usage.est_remaining_usd");
    }
    if (typeof value.workspace.usage.note !== "string") {
      throw contractViolation("string", "workspace.usage.note");
    }
  } else {
    if (workspaceKeys.some((key) => key !== "assigned" && key !== "waitlist_position")) {
      throw contractViolation("no_unknown_fields", "workspace");
    }
    if (
      !Number.isSafeInteger(value.workspace.waitlist_position) ||
      Number(value.workspace.waitlist_position) < 0
    ) {
      throw contractViolation("safe_non_negative_integer", "workspace.waitlist_position");
    }
  }
  return Object.freeze({
    id: canonicalUuid(value, "id"),
    email: requiredString(value, "email"),
    workspaceAssigned: assigned,
    ...(assigned
      ? {
          workspaceId: underField("workspace", () => canonicalUuid(value.workspace as Record<string, unknown>, "id")),
          workspaceUsage: Object.freeze({
            estimatedSpendUsd: Number((value.workspace.usage as Record<string, unknown>).est_spend_usd),
            estimatedRemainingUsd: Number((value.workspace.usage as Record<string, unknown>).est_remaining_usd),
            note: String((value.workspace.usage as Record<string, unknown>).note),
          }),
        }
      : { waitlistPosition: Number(value.workspace.waitlist_position) }),
  });
}

export type AgentKind = "claude-code" | "codex" | "openclaw";
export type AgentAuthMode = "interactive_login" | "credential_binding";
export type AgentSessionAuthState =
  | "login_required"
  | "authenticated"
  | "configured"
  | "unavailable";
export type AgentSessionAuthEvidenceClass =
  | "provider_cli_login_status"
  | "credential_binding_authority"
  | "insufficient";
export const AGENT_SESSION_AUTH_ADAPTER_VERSION = "runa.agent-auth.v1" as const;
export const AGENT_SESSION_AUTH_MAX_TTL_MS = 30_000;
export const AGENT_SESSION_AUTH_MAX_FUTURE_SKEW_MS = 5_000;
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
  /**
   * Immutable workspace authority selected when the AgentSession was created.
   * Both fields are absent only for legacy rows created before workspace-bound
   * AgentSession creation became mandatory.
   */
  readonly workspaceBindingId?: string;
  readonly workspaceGeneration?: number;
  readonly name: string;
  readonly agent: AgentKind;
  readonly cwd: string;
  readonly authMode: AgentAuthMode;
  readonly desiredState: AgentSessionDesiredState;
  readonly requestState: AgentSessionRequestState;
  readonly processState: AgentSessionProcessState;
  readonly processEpoch?: string;
  readonly runtimeObservedAt?: string;
  readonly runtimeExpiresAt?: string;
  readonly terminationRequestedAt?: string;
  readonly rowVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentSessionPage {
  readonly items: readonly AgentSession[];
  readonly nextCursor?: string;
}

export interface AgentSessionAuth {
  readonly observationId: string;
  readonly agentSessionId: string;
  readonly processEpoch: string | null;
  readonly authMode: AgentAuthMode;
  readonly agentVersion: string;
  readonly adapterVersion: string;
  readonly evidenceClass: AgentSessionAuthEvidenceClass;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly state: AgentSessionAuthState;
}

export interface AgentSessionAuthLogout {
  readonly observationId: string;
  readonly agentSessionId: string;
  readonly processEpoch: string;
  readonly authMode: "interactive_login";
  readonly agent: "claude-code" | "codex";
  readonly agentVersion: string;
  readonly adapterVersion: "runa.agent-auth.v1";
  readonly observedAt: string;
  readonly outcome: "logout_confirmed";
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
const AGENT_AUTH_STATES = new Set<AgentSessionAuthState>([
  "login_required", "authenticated", "configured", "unavailable",
]);
const AGENT_AUTH_EVIDENCE_CLASSES = new Set<AgentSessionAuthEvidenceClass>([
  "provider_cli_login_status", "credential_binding_authority", "insufficient",
]);
const AGENT_AUTH_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/u;

function enumField<T extends string>(value: Record<string, unknown>, key: string, allowed: ReadonlySet<T>): T {
  const decoded = requiredString(value, key);
  if (!allowed.has(decoded as T)) throw contractViolation("known_enum_value", key);
  return decoded as T;
}

function decodeAgentSession(value: unknown): AgentSession {
  if (!isObject(value)) throw contractViolation("object");
  const allowed = new Set([
    "id",
    "machine_id",
    "workspace_binding_id",
    "workspace_generation",
    "name",
    "agent",
    "cwd",
    "auth_mode",
    "desired_state",
    "request_state",
    "process_state",
    "process_epoch",
    "runtime_observed_at",
    "runtime_expires_at",
    "termination_requested_at",
    "row_version",
    "created_at",
    "updated_at",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw contractViolation("no_unknown_fields");
  }
  const agent = enumField(value, "agent", AGENTS);
  const authMode = enumField(value, "auth_mode", AUTH_MODES);
  const desiredState = enumField(value, "desired_state", DESIRED_STATES);
  const requestState = enumField(value, "request_state", REQUEST_STATES);
  const processState = enumField(value, "process_state", PROCESS_STATES);
  const processEpoch = optionalString(value, "process_epoch");
  const runtimeObservedAt = optionalString(value, "runtime_observed_at");
  const runtimeExpiresAt = optionalString(value, "runtime_expires_at");
  const terminationRequestedAt = optionalString(value, "termination_requested_at");
  const workspaceBindingId = optionalString(value, "workspace_binding_id");
  const workspaceGeneration = optionalNumber(value, "workspace_generation");
  if ((workspaceBindingId === undefined) !== (workspaceGeneration === undefined)) {
    throw contractViolation("binding_id_and_generation_present_together");
  }
  if (
    workspaceBindingId !== undefined &&
    (!UUID.test(workspaceBindingId) ||
      !Number.isSafeInteger(workspaceGeneration) ||
      workspaceGeneration === undefined ||
      workspaceGeneration < 1)
  ) {
    throw contractViolation("workspace_binding_identity_shape");
  }
  const rowVersion = optionalNumber(value, "row_version");
  if (rowVersion === undefined || !Number.isSafeInteger(rowVersion) || rowVersion < 0) {
    throw contractViolation("safe_non_negative_integer", "row_version");
  }
  return Object.freeze({
    id: canonicalUuid(value, "id"),
    machineId: canonicalUuid(value, "machine_id"),
    ...(workspaceBindingId === undefined
      ? {}
      : { workspaceBindingId, workspaceGeneration: workspaceGeneration as number }),
    name: requiredDisplayString(value, "name"),
    agent,
    cwd: requiredDisplayString(value, "cwd"),
    authMode,
    desiredState,
    requestState,
    processState,
    ...(processEpoch === undefined
      ? {}
      : UUID.test(processEpoch)
        ? { processEpoch }
        : (() => { throw contractViolation("canonical_uuid", "process_epoch"); })()),
    ...(runtimeObservedAt === undefined ? {} : { runtimeObservedAt }),
    ...(runtimeExpiresAt === undefined ? {} : { runtimeExpiresAt }),
    ...(terminationRequestedAt === undefined ? {} : { terminationRequestedAt }),
    rowVersion,
    createdAt: requiredString(value, "created_at"),
    updatedAt: requiredString(value, "updated_at"),
  });
}

export function decodeAgentSessionPage(value: unknown): AgentSessionPage {
  if (Array.isArray(value)) {
    return Object.freeze({
      items: Object.freeze(value.map((item, index) =>
        underField(`[${index}]`, () => decodeAgentSession(item)))),
    });
  }
  if (!isObject(value) || !Array.isArray(value.items)) throw contractViolation("object_with_items_array");
  const nextCursor = optionalString(value, "next_cursor");
  return Object.freeze({
    items: Object.freeze(value.items.map((item, index) =>
      underField(`items[${index}]`, () => decodeAgentSession(item)))),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

export function decodeAgentSessionItem(value: unknown): AgentSession {
  return decodeAgentSession(value);
}

export function decodeAgentSessionAuth(value: unknown): AgentSessionAuth {
  if (!isObject(value)) throw contractViolation("object");
  const allowed = new Set([
    "observation_id",
    "agent_session_id",
    "process_epoch",
    "auth_mode",
    "agent_version",
    "adapter_version",
    "evidence_class",
    "observed_at",
    "valid_until",
    "state",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw contractViolation("no_unknown_fields");
  }
  const processEpoch = value.process_epoch;
  if (processEpoch !== null && (typeof processEpoch !== "string" || !UUID.test(processEpoch))) {
    throw contractViolation("canonical_uuid_or_null", "process_epoch");
  }
  const observedAt = requiredString(value, "observed_at");
  const validUntil = requiredString(value, "valid_until");
  const observedTime = Date.parse(observedAt);
  const validUntilTime = Date.parse(validUntil);
  if (
    !Number.isFinite(observedTime) ||
    !Number.isFinite(validUntilTime) ||
    validUntilTime < observedTime ||
    validUntilTime - observedTime > AGENT_SESSION_AUTH_MAX_TTL_MS
  ) {
    throw contractViolation("bounded_observation_freshness");
  }
  const authMode = enumField(value, "auth_mode", AUTH_MODES);
  const agentVersion = requiredDisplayString(value, "agent_version");
  const adapterVersion = requiredDisplayString(value, "adapter_version");
  if (adapterVersion !== AGENT_SESSION_AUTH_ADAPTER_VERSION) {
    throw contractViolation("supported_adapter_version", "adapter_version");
  }
  const evidenceClass = enumField(value, "evidence_class", AGENT_AUTH_EVIDENCE_CLASSES);
  const state = enumField(value, "state", AGENT_AUTH_STATES);
  const positiveInteractive = state === "authenticated" || state === "login_required";
  const configured = state === "configured";
  const unavailable = state === "unavailable";
  if (
    (!unavailable && processEpoch === null) ||
    (!unavailable && validUntilTime === observedTime) ||
    (!unavailable && !AGENT_AUTH_VERSION.test(agentVersion)) ||
    (positiveInteractive &&
      (authMode !== "interactive_login" || evidenceClass !== "provider_cli_login_status")) ||
    (configured &&
      (authMode !== "credential_binding" || evidenceClass !== "credential_binding_authority")) ||
    (unavailable !== (evidenceClass === "insufficient")) ||
    (unavailable && validUntilTime !== observedTime) ||
    (agentVersion === "unavailable" && !unavailable)
  ) {
    throw contractViolation("self_consistent_authentication_evidence");
  }
  return Object.freeze({
    observationId: canonicalUuid(value, "observation_id"),
    agentSessionId: canonicalUuid(value, "agent_session_id"),
    processEpoch,
    authMode,
    agentVersion,
    adapterVersion,
    evidenceClass,
    observedAt,
    validUntil,
    state,
  });
}

export function decodeAgentSessionAuthLogout(value: unknown): AgentSessionAuthLogout {
  if (!isObject(value)) throw contractViolation("object");
  const allowed = new Set([
    "observation_id", "agent_session_id", "process_epoch", "auth_mode", "agent",
    "agent_version", "adapter_version", "observed_at", "outcome",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.auth_mode !== "interactive_login" ||
    (value.agent !== "claude-code" && value.agent !== "codex") ||
    typeof value.agent_version !== "string" ||
    !AGENT_AUTH_VERSION.test(value.agent_version) ||
    value.adapter_version !== AGENT_SESSION_AUTH_ADAPTER_VERSION ||
    typeof value.observed_at !== "string" ||
    !Number.isFinite(Date.parse(value.observed_at)) ||
    value.outcome !== "logout_confirmed"
  ) {
    throw contractViolation("sign_out_confirmation_shape");
  }
  return Object.freeze({
    observationId: canonicalUuid(value, "observation_id"),
    agentSessionId: canonicalUuid(value, "agent_session_id"),
    processEpoch: canonicalUuid(value, "process_epoch"),
    authMode: "interactive_login" as const,
    agent: value.agent,
    agentVersion: value.agent_version,
    adapterVersion: AGENT_SESSION_AUTH_ADAPTER_VERSION,
    observedAt: value.observed_at,
    outcome: "logout_confirmed" as const,
  });
}

export const TERMINAL_PROTOCOL = "runa.terminal.v1" as const;
export type TerminalCapabilityName =
  | "acknowledgement"
  | "heartbeat"
  | "live_resize"
  | "resume"
  | "signals";
export type TerminalCapabilityAvailability = "supported" | "unsupported" | "unknown";

export interface TerminalConnectionCapability {
  readonly name: TerminalCapabilityName;
  readonly availability: TerminalCapabilityAvailability;
}

export interface TerminalConnectionGrant {
  readonly terminalSessionId: string;
  readonly resumeHandle: string;
  readonly connectUrl: string;
  readonly connectToken: string;
  readonly protocol: typeof TERMINAL_PROTOCOL;
  readonly capabilities: readonly TerminalConnectionCapability[];
  readonly expiresAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TERMINAL_CAPABILITY_NAMES = new Set<TerminalCapabilityName>([
  "acknowledgement",
  "heartbeat",
  "live_resize",
  "resume",
  "signals",
]);
const TERMINAL_CAPABILITY_AVAILABILITY = new Set<TerminalCapabilityAvailability>([
  "supported",
  "unsupported",
  "unknown",
]);

function canonicalUuid(value: Record<string, unknown>, key: string): string {
  const decoded = requiredString(value, key);
  if (!UUID.test(decoded)) throw contractViolation("canonical_uuid", key);
  return decoded;
}

function decodeTerminalCapability(value: unknown): TerminalConnectionCapability {
  if (!isObject(value)) throw contractViolation("object");
  const name = requiredString(value, "name") as TerminalCapabilityName;
  const availability = requiredString(value, "availability") as TerminalCapabilityAvailability;
  if (
    !TERMINAL_CAPABILITY_NAMES.has(name) ||
    !TERMINAL_CAPABILITY_AVAILABILITY.has(availability) ||
    Object.keys(value).some((key) => key !== "name" && key !== "availability")
  ) {
    throw contractViolation("terminal_capability_shape");
  }
  return Object.freeze({ name, availability });
}

export function decodeTerminalConnectionGrant(value: unknown): TerminalConnectionGrant {
  if (!isObject(value)) throw contractViolation("object");
  const allowed = new Set([
    "terminal_session_id",
    "resume_handle",
    "connect_url",
    "connect_token",
    "protocol",
    "capabilities",
    "expires_at",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || !Array.isArray(value.capabilities)) {
    throw contractViolation("no_unknown_fields");
  }
  const terminalSessionId = canonicalUuid(value, "terminal_session_id");
  const resumeHandle = canonicalUuid(value, "resume_handle");
  const connectUrl = requiredString(value, "connect_url");
  const connectToken = requiredString(value, "connect_token");
  const protocol = requiredString(value, "protocol");
  const expiresAt = requiredString(value, "expires_at");
  if (
    protocol !== TERMINAL_PROTOCOL ||
    !isTerminalConnectToken(connectToken) ||
    !isTerminalStreamUrl(connectUrl, terminalSessionId) ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    value.capabilities.length !== TERMINAL_CAPABILITY_NAMES.size
  ) {
    throw contractViolation("terminal_grant_shape");
  }
  const capabilities = Object.freeze(value.capabilities.map((item, index) =>
    underField(`capabilities[${index}]`, () => decodeTerminalCapability(item))));
  if (
    new Set(capabilities.map((capability) => capability.name)).size !== TERMINAL_CAPABILITY_NAMES.size ||
    [...TERMINAL_CAPABILITY_NAMES].some(
      (name) => capabilities.filter((capability) => capability.name === name).length !== 1,
    )
  ) {
    throw contractViolation("exactly_one_of_each_terminal_capability", "capabilities");
  }
  return Object.freeze({
    terminalSessionId,
    resumeHandle,
    connectUrl,
    connectToken,
    protocol: TERMINAL_PROTOCOL,
    capabilities,
    expiresAt,
  });
}

export interface AuditRecord {
  readonly id: string;
  readonly machineId: string;
  readonly kind: string;
  readonly summary: string;
  readonly detail: JsonValue;
  readonly createdAt: string;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonArray
  | JsonObject;

export interface JsonArray extends ReadonlyArray<JsonValue> {}

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface CredentialRuleTarget {
  readonly kind: "header" | "query";
  readonly name: string;
  readonly format: string;
}

export interface CredentialRule {
  readonly id: string;
  readonly host: string;
  readonly path: string;
  readonly credential: string;
  readonly target: CredentialRuleTarget;
  readonly cacheTtlSeconds: number;
}

export interface ApiKeyMetadata {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly lastFour: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

/**
 * Control and format characters may never reach the operator's terminal. The
 * credential half of this guard is NOT written here: it comes from
 * `containsCredentialValue`, the one authority, because the copy that used to
 * live on this line knew only five of the eight minted families.
 */
const FORBIDDEN_PUBLIC_CHARACTER = /[\p{Cc}\p{Cf}]/u;

function exactKeys(value: Record<string, unknown>, required: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw contractViolation("exact_key_set");
  }
}

function safePublicString(value: unknown, label: string, maximum = 4096): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    FORBIDDEN_PUBLIC_CHARACTER.test(value) ||
    containsCredentialValue(value)
  ) {
    throw contractViolation("safe_public_string", label);
  }
  return value;
}

function decodeJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 12) throw contractViolation("bounded_nesting_depth");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw contractViolation("finite_number");
    return value;
  }
  if (typeof value === "string") return safePublicString(value, "detail", 16_384);
  if (Array.isArray(value)) {
    if (value.length > 1024) throw contractViolation("bounded_array_length");
    return Object.freeze(value.map((item) => decodeJsonValue(item, depth + 1)));
  }
  if (!isObject(value) || Object.keys(value).length > 1024) {
    throw contractViolation("bounded_object_size");
  }
  const decoded: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const safeKey = safePublicString(key, "detail key", 256);
    decoded[safeKey] = decodeJsonValue(item, depth + 1);
  }
  return Object.freeze(decoded);
}

function decodeAuditRecord(value: unknown): AuditRecord {
  if (!isObject(value)) throw contractViolation("object");
  exactKeys(value, ["id", "session_id", "kind", "summary", "detail", "created_at"]);
  const createdAt = safePublicString(value.created_at, "created_at", 64);
  if (!Number.isFinite(Date.parse(createdAt))) throw contractViolation("parsable_timestamp", "created_at");
  return Object.freeze({
    id: canonicalUuid(value, "id"),
    machineId: canonicalUuid(value, "session_id"),
    kind: safePublicString(value.kind, "kind", 128),
    summary: safePublicString(value.summary, "summary", 2048),
    detail: decodeJsonValue(value.detail),
    createdAt,
  });
}

export function decodeAuditRecords(value: unknown): readonly AuditRecord[] {
  if (!Array.isArray(value) || value.length > 200) throw contractViolation("bounded_array_length");
  return Object.freeze(value.map((item, index) =>
    underField(`[${index}]`, () => decodeAuditRecord(item))));
}

function decodeCredentialRule(value: unknown): CredentialRule {
  if (!isObject(value) || !isObject(value.target)) throw contractViolation("object_with_target_object");
  exactKeys(value, ["id", "host", "path", "credential", "target", "cache_ttl_secs"]);
  const targetKeys = Object.keys(value.target);
  const isHeader = targetKeys.length === 2 && targetKeys.includes("header") && targetKeys.includes("format");
  const isQuery = targetKeys.length === 2 && targetKeys.includes("param") && targetKeys.includes("format");
  if (isHeader === isQuery) throw contractViolation("exactly_one_target_kind", "target");
  const cacheTtlSeconds = value.cache_ttl_secs;
  if (!Number.isSafeInteger(cacheTtlSeconds) || Number(cacheTtlSeconds) < 0 || Number(cacheTtlSeconds) > 86_400) {
    throw contractViolation("bounded_cache_ttl_seconds", "cache_ttl_secs");
  }
  return Object.freeze({
    id: safePublicString(value.id, "id", 256),
    host: safePublicString(value.host, "host", 2048),
    path: safePublicString(value.path, "path", 2048),
    credential: safePublicString(value.credential, "credential", 64),
    target: Object.freeze({
      kind: isHeader ? "header" : "query",
      name: safePublicString(isHeader ? value.target.header : value.target.param, "target name", 256),
      format: safePublicString(value.target.format, "target format", 4096),
    }),
    cacheTtlSeconds: Number(cacheTtlSeconds),
  });
}

export function decodeCredentialRules(value: unknown): readonly CredentialRule[] {
  if (!Array.isArray(value) || value.length > 1024) throw contractViolation("bounded_array_length");
  return Object.freeze(value.map((item, index) =>
    underField(`[${index}]`, () => decodeCredentialRule(item))));
}

function optionalTimestamp(value: unknown, label: string): string | null {
  if (value === null) return null;
  const decoded = safePublicString(value, label, 64);
  if (!Number.isFinite(Date.parse(decoded))) throw contractViolation("parsable_timestamp", label);
  return decoded;
}

function decodeApiKeyMetadata(value: unknown): ApiKeyMetadata {
  if (!isObject(value)) throw contractViolation("object");
  exactKeys(value, [
    "id", "name", "prefix", "last_four", "created_at", "expires_at", "last_used_at", "revoked_at",
  ]);
  const prefix = safePublicString(value.prefix, "prefix", 32);
  const lastFour = safePublicString(value.last_four, "last_four", 4);
  if (!isApiKeyDisplayPrefix(prefix) || !/^[A-Za-z0-9_-]{4}$/u.test(lastFour)) {
    throw contractViolation("api_key_display_metadata");
  }
  const createdAt = optionalTimestamp(value.created_at, "created_at");
  if (createdAt === null) throw contractViolation("parsable_timestamp", "created_at");
  return Object.freeze({
    id: canonicalUuid(value, "id"),
    name: safePublicString(value.name, "name", 80),
    prefix,
    lastFour,
    createdAt,
    expiresAt: optionalTimestamp(value.expires_at, "expires_at"),
    lastUsedAt: optionalTimestamp(value.last_used_at, "last_used_at"),
    revokedAt: optionalTimestamp(value.revoked_at, "revoked_at"),
  });
}

export function decodeApiKeyList(value: unknown): readonly ApiKeyMetadata[] {
  if (!Array.isArray(value) || value.length > 100) throw contractViolation("bounded_array_length");
  return Object.freeze(value.map((item, index) =>
    underField(`[${index}]`, () => decodeApiKeyMetadata(item))));
}

export function decodeOk(value: unknown): true {
  if (!isObject(value)) throw contractViolation("object");
  exactKeys(value, ["ok"]);
  if (value.ok !== true) throw contractViolation("acknowledgement_is_true", "ok");
  return true;
}
