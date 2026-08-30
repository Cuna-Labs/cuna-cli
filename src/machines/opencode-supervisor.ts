import {
  CunaError,
  EXIT_CODES,
  type SafeErrorDetails,
} from "../core/errors.js";

const OPENCODE_SUPERVISOR_REPAIR_REASONS: ReadonlySet<string> = new Set([
  "opencode_supervisor_upgrade_required",
  "opencode_supervisor_protocol_unavailable",
] as const);
const OPENCODE_RUNTIME_UNVERIFIED_REASON = "opencode_runtime_unverified";

const OPENCODE_SUPERVISOR_UPGRADE_REASONS: ReadonlySet<string> = new Set([
  ...OPENCODE_SUPERVISOR_REPAIR_REASONS,
  // A legacy supervisor can return this provider-neutral spelling. Callers
  // must also fence it to an OpenCode create intent before showing
  // OpenCode-specific copy.
  "supervisor_upgrade_required",
] as const);
const CANONICAL_MACHINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function isOpenCodeSupervisorUpgradeReason(value: unknown): boolean {
  return typeof value === "string" && OPENCODE_SUPERVISOR_UPGRADE_REASONS.has(value);
}

/** Only these provider-specific reasons authorize the explicit Machine repair. */
export function isOpenCodeSupervisorRepairReason(value: unknown): boolean {
  return typeof value === "string" && OPENCODE_SUPERVISOR_REPAIR_REASONS.has(value);
}

/**
 * A legacy supervisor is a durable, explicit upgrade prerequisite. Keep this
 * narrower than `isOpenCodeSupervisorRepairReason`: an unannounced
 * supervisor reports the same broad family of condition, but it is a
 * retryable heartbeat wait rather than evidence that a person should restart
 * anything.
 */
export function isOpenCodeSupervisorUpgradeRequiredReason(value: unknown): boolean {
  return value === "opencode_supervisor_upgrade_required";
}

/** A compatible supervisor has not yet advertised its protocol heartbeat. */
export function isOpenCodeSupervisorProtocolUnavailableReason(value: unknown): boolean {
  return value === "opencode_supervisor_protocol_unavailable";
}

export function isOpenCodeRuntimeUnverifiedReason(value: unknown): boolean {
  return value === OPENCODE_RUNTIME_UNVERIFIED_REASON;
}

/**
 * Capability discovery happens before the AgentSession create dispatch. The
 * exact capability ID and reason prove that no create request was sent.
 */
export function isOpenCodeSupervisorUpgradeCapabilityRejection(
  error: unknown,
): error is CunaError {
  if (!(error instanceof CunaError)) return false;
  const details = error.details;
  return details?.capability_id === "agent_sessions.create" &&
    isOpenCodeSupervisorUpgradeReason(details.reason ?? details.reason_code);
}

/**
 * Runtime verification is a temporary create fence, not evidence that a
 * create was accepted. Keep it provider-scoped so another agent's temporary
 * capability result cannot be presented as an OpenCode status.
 */
export function isOpenCodeRuntimeUnverifiedCapabilityRejection(
  error: unknown,
): error is CunaError {
  if (!(error instanceof CunaError)) return false;
  const details = error.details;
  return details?.capability_id === "agent_sessions.create" &&
    isOpenCodeRuntimeUnverifiedReason(details.reason ?? details.reason_code);
}

/**
 * The explicit Machine action has no selected provider argument, so it must
 * not reinterpret the provider-neutral supervisor reason as OpenCode intent.
 * Only the OpenCode-specific capability refusal makes the action available.
 */
export function isOpenCodeSupervisorRepairCapabilityRejection(
  error: unknown,
): error is CunaError {
  if (!(error instanceof CunaError)) return false;
  const details = error.details;
  return details?.capability_id === "agent_sessions.create" &&
    isOpenCodeSupervisorRepairReason(details.reason ?? details.reason_code);
}

export function openCodeSupervisorUpgradeRequired(input: Readonly<{
  readonly details?: SafeErrorDetails;
  /** A locally known, canonical Machine ID. Never interpolate untrusted text into a shell hint. */
  readonly machineId?: string;
  readonly retryable?: boolean;
  readonly cause?: unknown;
}> = {}): CunaError {
  const reason = input.details?.reason ?? input.details?.reason_code;
  const protocolUnavailable = reason === "opencode_supervisor_protocol_unavailable";
  const machineId = input.machineId !== undefined && CANONICAL_MACHINE_ID.test(input.machineId)
    ? input.machineId
    : undefined;
  const repair = machineId === undefined
    ? "Open `cuna machines` to inspect this Machine. When you decide to stop it yourself, select Update terminal supervisor and confirm it."
    : `When you decide to stop this Machine yourself, run \`cuna machines update-supervisor ${machineId} --yes\`, or open \`cuna machines\` and select Update terminal supervisor. That command refuses to stop the Machine and preserves server blockers for active AgentSessions.`;
  const protection = "No OpenCode AgentSession was created. Cuna will not stop the Machine or terminate sessions for you, including existing AgentSessions.";
  return new CunaError({
    code: "cuna.agent.opencode_supervisor_upgrade_required",
    message: protocolUnavailable
      ? "OpenCode cannot start because this Machine's terminal supervisor does not provide the required protocol."
      : "OpenCode cannot start until this Machine's terminal supervisor is updated.",
    exitCode: EXIT_CODES.unsupported,
    hint: protocolUnavailable
      ? `${protection} This Machine's current terminal supervisor cannot provide the OpenCode protocol. ${repair} When the update completes, retry OpenCode.`
      : `${protection} ${repair} When the update completes, retry OpenCode.`,
    retryable: input.retryable ?? false,
    ...(input.details === undefined && machineId === undefined
      ? {}
      : { details: Object.freeze({ ...input.details, ...(machineId === undefined ? {} : { machine_id: machineId }) }) }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
}

/**
 * `requireCapability` runs before dispatching AgentSession creation. This
 * specialised result preserves that fact and gives the foreground journey a
 * truthful transient next step instead of a generic capability failure.
 */
export function openCodeRuntimeUnverified(input: Readonly<{
  readonly details?: SafeErrorDetails;
  /** A locally known, canonical Machine ID. Never interpolate untrusted text into a shell hint. */
  readonly machineId?: string;
  readonly cause?: unknown;
}> = {}): CunaError {
  const machineId = input.machineId !== undefined && CANONICAL_MACHINE_ID.test(input.machineId)
    ? input.machineId
    : undefined;
  const retry = machineId === undefined
    ? "If the Machine is stopped, start it. Otherwise keep it running and retry OpenCode once it reports ready."
    : `If this Machine is stopped, start it. Otherwise keep it running and retry OpenCode once it reports ready. You can inspect it with \`cuna machines\` or \`cuna capabilities --scope machine --resource-id ${machineId}\`.`;
  return new CunaError({
    code: "cuna.agent.opencode_runtime_unverified",
    message: "Cuna is still checking that OpenCode is ready on this Machine.",
    exitCode: EXIT_CODES.network,
    hint: `No OpenCode AgentSession was created. ${retry} Cuna will not create another Machine or change this Machine automatically.`,
    retryable: true,
    ...(input.details === undefined && machineId === undefined
      ? {}
      : { details: Object.freeze({ ...input.details, ...(machineId === undefined ? {} : { machine_id: machineId }) }) }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
}
