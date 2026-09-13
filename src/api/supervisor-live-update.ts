import { contractViolation, isObject, underIndex } from "../core/validation.js";
import { decodeMachineItem, type Machine } from "./contracts.js";

/**
 * `sessions.updateSupervisorInPlace` — the running-Machine supervisor update.
 *
 * WHAT THE PATH ID IS. `POST /v1/sessions/{id}/supervisor/live-update` reads
 * `{id}` as a MACHINE, exactly like its stopped-boundary sibling
 * `sessions.replaceSupervisor`: the producer parses it with `canonicalUuid` into
 * `machineId` and the `Session` schema it answers with is the Machine row. It is
 * NOT an AgentSession id, and the per-session custody it reports is a separate
 * array of `agent_session_id` values. Binding the response to the requested
 * Machine is therefore a real check, and `api/client.ts` performs it.
 *
 * WHY THIS SHAPE IS HAND-WRITTEN AND NOT PROJECTED. The repository's convention
 * for a canonical DTO is a generated projection (`scripts/project-provider-v2.mjs`
 * and its siblings) whose source is the VENDORED producer contract at
 * `contracts/infra/cuna-api.openapi.json`. That artifact is producer revision
 * `a9d7b17550c69df895f32d19fdda0a2cd4f93935` (98 operations) and does not carry
 * this operation or the `SupervisorLiveUpdateResult` schema at all, so there is
 * nothing to project from: a projection script would have to read bytes that are
 * not in this repository, and copying them in by hand would assert a producer
 * provenance that `scripts/sync-infra-openapi.mjs` has not established.
 *
 * The shape below was read from the producer contract whose CANONICAL digest is
 * `2d69d5cb8c6bf6e5528b0527c2873042b0c3e2675d51a52c35c682e731e46077`
 * (100 operations, 40 SDK), verified under the producer's own digest semantics
 * — `sha256(canonical-json)`, not the raw bytes. `SUPERVISOR_LIVE_UPDATE_WIRE`
 * records that exact source, and `test/supervisor-live-update-contract.test.mjs`
 * fails the moment the vendored contract does start carrying the operation while
 * this module still claims to be derived from the reference instead.
 *
 * THE OUTSTANDING PREREQUISITE, stated here because it is a release condition
 * and not a comment: `npm run contract:sync:infra` against a clean Infra
 * worktree that carries this operation must replace the vendored artifact before
 * this command can claim contract-derived provenance.
 */
export const SUPERVISOR_LIVE_UPDATE_WIRE = Object.freeze({
  operationId: "sessions.updateSupervisorInPlace",
  method: "POST",
  /** `{id}` is the Machine, not the AgentSession. */
  pathTemplate: "/v1/sessions/{id}/supervisor/live-update",
  pathParameterSubject: "machine",
  responseSchema: "SupervisorLiveUpdateResult",
  sessionSchema: "SupervisorLiveUpdateSession",
  requiredPermission: "machines:update",
  /** No request body and no idempotency key: the producer declares neither. */
  hasRequestBody: false,
  responseKeys: Object.freeze([
    "machine",
    "control_generation",
    "artifact_sha256",
    "installed_at",
    "agent_sessions",
  ] as const),
  sessionKeys: Object.freeze(["agent_session_id", "process_epoch", "outcome"] as const),
  outcomes: Object.freeze(["preserved", "exited", "ended", "unknown"] as const),
  /** `maxItems` on `agent_sessions` in the producer schema. */
  maximumSessions: 64,
  source: Object.freeze({
    state: "producer_reference_not_vendored",
    canonicalDigest: "2d69d5cb8c6bf6e5528b0527c2873042b0c3e2675d51a52c35c682e731e46077",
    digestSemantics: "sha256(canonical-json:utf8;recursive-object-key-sort;array-order-preserved)",
    operations: 100,
    sdkOperations: 40,
    synchronizeWith: "npm run contract:sync:infra",
  }),
} as const);

export type SupervisorLiveUpdateOutcome = (typeof SUPERVISOR_LIVE_UPDATE_WIRE.outcomes)[number];

export interface SupervisorLiveUpdateSession {
  readonly agentSessionId: string;
  readonly processEpoch: string;
  /**
   * The producer's own account of ONE AgentSession that existed before the
   * update. `preserved` is the only value that means the same process, PTY and
   * stored master survived; `unknown` is an absent answer and is never folded
   * into either decided outcome.
   */
  readonly outcome: SupervisorLiveUpdateOutcome;
}

export interface SupervisorLiveUpdate {
  readonly machine: Machine;
  readonly controlGeneration: number;
  readonly artifactSha256: string;
  readonly installedAt: string;
  readonly sessions: readonly SupervisorLiveUpdateSession[];
}

const OUTCOMES: ReadonlySet<string> = new Set(SUPERVISOR_LIVE_UPDATE_WIRE.outcomes);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function exactKeys(value: Record<string, unknown>, keys: readonly string[], predicate: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw contractViolation(predicate);
  }
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw contractViolation("canonical_uuid", field);
  return value;
}

function decodeSession(value: unknown): SupervisorLiveUpdateSession {
  if (!isObject(value)) throw contractViolation("object");
  exactKeys(value, SUPERVISOR_LIVE_UPDATE_WIRE.sessionKeys, "exact_live_update_session_shape");
  const outcome = value.outcome;
  // A value this build does not know is a contract violation, never a silent
  // demotion to `unknown`: an unrecognised outcome could be a NEW way to say
  // "ended", and rendering it as "we could not tell" would understate it.
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) {
    throw contractViolation("known_enum_value", "outcome");
  }
  return Object.freeze({
    agentSessionId: uuid(value.agent_session_id, "agent_session_id"),
    processEpoch: uuid(value.process_epoch, "process_epoch"),
    outcome: outcome as SupervisorLiveUpdateOutcome,
  });
}

/** Strict: the producer declares `additionalProperties: false` on both objects. */
export function decodeSupervisorLiveUpdate(value: unknown): SupervisorLiveUpdate {
  if (!isObject(value)) throw contractViolation("object");
  exactKeys(value, SUPERVISOR_LIVE_UPDATE_WIRE.responseKeys, "exact_live_update_result_shape");
  const controlGeneration = value.control_generation;
  if (!Number.isSafeInteger(controlGeneration) || Number(controlGeneration) < 1) {
    throw contractViolation("safe_positive_integer", "control_generation");
  }
  const artifactSha256 = value.artifact_sha256;
  if (typeof artifactSha256 !== "string" || !SHA256.test(artifactSha256)) {
    throw contractViolation("sha256_digest", "artifact_sha256");
  }
  const installedAt = value.installed_at;
  if (typeof installedAt !== "string" || !Number.isFinite(Date.parse(installedAt))) {
    throw contractViolation("parsable_timestamp", "installed_at");
  }
  if (!Array.isArray(value.agent_sessions) ||
      value.agent_sessions.length > SUPERVISOR_LIVE_UPDATE_WIRE.maximumSessions) {
    throw contractViolation("bounded_live_update_session_array", "agent_sessions");
  }
  const sessions = value.agent_sessions.map((item, index) =>
    underIndex("agent_sessions", index, () => decodeSession(item)));
  // One AgentSession may not be accounted for twice: two rows for one id would
  // let a `preserved` and an `ended` verdict coexist for the same process.
  if (new Set(sessions.map((session) => session.agentSessionId)).size !== sessions.length) {
    throw contractViolation("distinct_agent_sessions", "agent_sessions");
  }
  return Object.freeze({
    machine: decodeMachineItem(value.machine),
    controlGeneration: Number(controlGeneration),
    artifactSha256,
    installedAt,
    sessions: Object.freeze(sessions),
  });
}
