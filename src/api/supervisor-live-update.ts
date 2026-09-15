import { contractViolation, isObject, underIndex } from "../core/validation.js";
import { decodeMachineItem, type Machine } from "./contracts.js";

/**
 * `sessions.updateSupervisorInPlace` and `sessions.readSupervisorInPlaceUpdate`
 * — the running-Machine supervisor update, and the read that recovers it.
 *
 * WHAT THE PATH ID IS. `POST /v1/sessions/{id}/supervisor/live-update` reads
 * `{id}` as a MACHINE, exactly like its stopped-boundary sibling
 * `sessions.replaceSupervisor`: the producer parses it with `canonicalUuid` into
 * `machineId` and the `Session` schema it answers with is the Machine row. It is
 * NOT an AgentSession id, and the per-session custody it reports is a separate
 * array of `agent_session_id` values. Binding the response to the requested
 * Machine is therefore a real check, and `api/client.ts` performs it.
 *
 * THE OPERATION IDENTITY, which is what makes a lost answer recoverable. The
 * POST now carries a required body — one field, `operation_id`, chosen by the
 * CALLER before sending. The producer records that identity durably before it
 * issues any supervisor enrollment, so repeating the SAME value never rotates a
 * second time: it resumes an attempt that spent nothing, reconciles one that
 * may have spent something, and returns the recorded answer once the operation
 * has settled. A DIFFERENT value for a Machine whose update has not settled is
 * refused. `sessions.readSupervisorInPlaceUpdate` is the read of that record: it
 * dispatches no installer, sends nothing to the Machine and changes no state.
 *
 * WHERE THE SHAPES BELOW COME FROM, exactly. The VENDORED producer contract at
 * `contracts/infra/cuna-api.openapi.json`, synchronized by
 * `npm run contract:sync:infra` from producer repository `Cuna-Labs/infra` at
 * commit `7b1b3e425ed273986a909a68395b5272bd6a01ba` — read from a clean,
 * detached, read-only reference worktree, never from a mutable one. The sync
 * runs the producer's own `contracts/tools/verify-contract.mjs` and refuses
 * unless the consumer's recomputed canonical digest equals the digest that
 * verifier attests, so the artifact in this repository is the producer's bytes
 * and is provably so. `contracts/infra/cuna-api.openapi.identity.json` carries
 * the commit, tree and blob ids.
 *
 * WHY THE TABLE BELOW IS STILL HAND-WRITTEN. The repository's convention for a
 * canonical DTO is a generated projection (`scripts/project-provider-v2.mjs`
 * and its siblings). This module keeps its own declaration for one reason a
 * schema projection cannot cover: the decoders enforce CROSS-FIELD invariants
 * the producer states in prose and encodes nowhere — a settled phase agrees
 * with `next_action: "none"` and with a non-null `settled_at`; a declared
 * session carries no verdict; one AgentSession is never accounted for twice. A
 * generated shape would check none of those.
 *
 * It is not therefore unchecked. `test/machines-live-update-supervisor.test.mjs`
 * reads the vendored artifact and asserts that every key list, enum and bound
 * in `SUPERVISOR_LIVE_UPDATE_WIRE` equals the producer's own, so this table is
 * a VERIFIED projection rather than a copy that can drift in silence. If the
 * next sync moves any of them, that test names which.
 */
export const SUPERVISOR_LIVE_UPDATE_WIRE = Object.freeze({
  operationId: "sessions.updateSupervisorInPlace",
  method: "POST",
  /** `{id}` is the Machine, not the AgentSession. */
  pathTemplate: "/v1/sessions/{id}/supervisor/live-update",
  pathParameterSubject: "machine",
  requestSchema: "SupervisorLiveUpdateRequest",
  responseSchema: "SupervisorLiveUpdateResult",
  sessionSchema: "SupervisorLiveUpdateSession",
  requiredPermission: "machines:update",
  /**
   * A required JSON body carrying the caller's chosen operation identity. There
   * is still no idempotency key: this identity is the durable one, and it is the
   * producer's own journal key rather than a transport-level retry token.
   */
  hasRequestBody: true,
  requestContentType: "application/json; charset=utf-8",
  requestKeys: Object.freeze(["operation_id"] as const),
  responseKeys: Object.freeze([
    "machine",
    "operation_id",
    "control_generation",
    "artifact_sha256",
    "installed_at",
    "agent_sessions",
  ] as const),
  sessionKeys: Object.freeze(["agent_session_id", "process_epoch", "outcome"] as const),
  outcomes: Object.freeze(["preserved", "exited", "ended", "unknown"] as const),
  /** `maxItems` on `agent_sessions` in the producer schema. */
  maximumSessions: 64,
  /**
   * The read that recovers a lost answer.
   *
   * `machines:read`, not `machines:update`: it is a database read scoped to the
   * owner and the exact Machine. `dispatchesInstaller: false` is the producer's
   * own statement about it and the reason this CLI may call it freely after an
   * interruption — the thing a caller must NOT do to resolve an operation is
   * send a second one, and this is not that.
   */
  recovery: Object.freeze({
    operationId: "sessions.readSupervisorInPlaceUpdate",
    method: "GET",
    pathTemplate: "/v1/sessions/{id}/supervisor/live-update/{operationId}",
    pathParameterSubject: "machine",
    responseSchema: "SupervisorLiveUpdateOperation",
    declaredSessionSchema: "SupervisorLiveUpdateDeclaredSession",
    failureSchema: "SupervisorLiveUpdateFailure",
    requiredPermission: "machines:read",
    dispatchesInstaller: false,
    operationKeys: Object.freeze([
      "operation_id",
      "machine_id",
      "phase",
      "control_rotated",
      "installer_outcome",
      "control_generation",
      "artifact_sha256",
      "installed_at",
      "installation_evidence",
      "declared_sessions",
      "agent_sessions",
      "failure",
      "next_action",
      "claimed_at",
      "updated_at",
      "settled_at",
      /**
       * The install fence, added at producer `7b1b3e42`. Both are required and
       * both are nullable, and they are one fact in two fields: the producer's
       * own column constraint is `(retired_at is null) = (retirement_receipt is
       * null)`, so a reader that got one without the other would be reading a
       * row the producer forbids.
       */
      "retired_at",
      "retirement_outcome",
    ] as const),
    declaredSessionKeys: Object.freeze(["agent_session_id", "process_epoch"] as const),
    failureKeys: Object.freeze([
      "status",
      "code",
      "title",
      "detail",
      "retryable",
      "action",
    ] as const),
    phases: Object.freeze(["claimed", "control_rotated", "installed", "settled"] as const),
    installerOutcomes: Object.freeze(["not_sent", "unknown", "refused", "installed"] as const),
    /** `null` is a declared member of the producer's own enum, not an absence. */
    installationEvidence: Object.freeze(["installer_exit", "reconciled"] as const),
    nextActions: Object.freeze(["none", "repeat_same_operation"] as const),
    failureActions: Object.freeze(["retry", "none"] as const),
    /**
     * What the Machine's install fence had recorded for this operation's
     * control generation when the fence was advanced past it. `null` is a
     * declared member of the producer's enum — "not retired yet" — and is
     * decoded as absence rather than listed here.
     *
     * NEVER a substitute for `installerOutcome`. `installed` here says the
     * fence recorded an admitted installer that finished; `installerOutcome`
     * says what CUNA observed, and only it may be rendered as an installation.
     */
    retirementOutcomes: Object.freeze(["retired", "partial", "installed"] as const),
  }),
  source: Object.freeze({
    state: "vendored",
    producerRepository: "Cuna-Labs/infra",
    producerRevision: "7b1b3e425ed273986a909a68395b5272bd6a01ba",
    /**
     * The producer-side artifact is `contracts/` plus the producer's own file
     * name, which still carries the earlier brand. That literal now exists in
     * exactly ONE shipped place — `scripts/sync-infra-openapi.mjs`'s
     * `expectedSourceName`, whose classification `test/error-namespace.test.mjs`
     * pins line-exactly — and the sync refuses any other source, so restating it
     * here bought no authority and minted a second unclassified copy of it.
     * `contracts/infra/cuna-api.openapi.identity.json` records the commit, tree
     * and blob this table is attributed to.
     */
    /** `sha256` of the artifact's exact bytes at that commit. */
    rawDigest: "f4c2d396b94f296b22df276435dc04ecf1da48807efa1e819c4cbff9ea59a83e",
    /** The producer's own published digest, under its own canonical semantics. */
    canonicalDigest: "43213c2adac602676437b612b7d4153707e09155bdc4fa3029cca15a0b207ecc",
    digestSemantics: "sha256(canonical-json:utf8;recursive-object-key-sort;array-order-preserved)",
    operations: 101,
    sdkOperations: 40,
    vendoredArtifact: "contracts/infra/cuna-api.openapi.json",
    /** Synchronized 2026-09-13. The declarations above are checked against it. */
    vendoredCarriesOperation: true,
    synchronizeWith: "npm run contract:sync:infra",
  }),
} as const);

export type SupervisorLiveUpdateOutcome = (typeof SUPERVISOR_LIVE_UPDATE_WIRE.outcomes)[number];
export type SupervisorLiveUpdatePhase =
  (typeof SUPERVISOR_LIVE_UPDATE_WIRE.recovery.phases)[number];
export type SupervisorLiveUpdateInstallerOutcome =
  (typeof SUPERVISOR_LIVE_UPDATE_WIRE.recovery.installerOutcomes)[number];
export type SupervisorLiveUpdateInstallationEvidence =
  (typeof SUPERVISOR_LIVE_UPDATE_WIRE.recovery.installationEvidence)[number];
export type SupervisorLiveUpdateNextAction =
  (typeof SUPERVISOR_LIVE_UPDATE_WIRE.recovery.nextActions)[number];
export type SupervisorLiveUpdateFailureAction =
  (typeof SUPERVISOR_LIVE_UPDATE_WIRE.recovery.failureActions)[number];
export type SupervisorLiveUpdateRetirementOutcome =
  (typeof SUPERVISOR_LIVE_UPDATE_WIRE.recovery.retirementOutcomes)[number];

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

/**
 * An AgentSession the attempt MEASURED and is accountable for.
 *
 * A statement of scope, never of outcome. It carries no verdict on purpose, and
 * a renderer that turns a declared session into an `unknown` outcome has
 * invented an answer the producer withheld.
 */
export interface SupervisorLiveUpdateDeclaredSession {
  readonly agentSessionId: string;
  readonly processEpoch: string;
}

export interface SupervisorLiveUpdate {
  readonly machine: Machine;
  /** Echoed from the request. The client checks it against what it sent. */
  readonly operationId: string;
  readonly controlGeneration: number;
  readonly artifactSha256: string;
  readonly installedAt: string;
  readonly sessions: readonly SupervisorLiveUpdateSession[];
}

/** The refusal a settled operation recorded, in the fields the mutation returned. */
export interface SupervisorLiveUpdateFailure {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly retryable: boolean;
  readonly action: SupervisorLiveUpdateFailureAction;
}

export interface SupervisorLiveUpdateOperation {
  readonly operationId: string;
  readonly machineId: string;
  readonly phase: SupervisorLiveUpdatePhase;
  /** True is irreversible and stays true in every later phase. */
  readonly controlRotated: boolean;
  readonly installerOutcome: SupervisorLiveUpdateInstallerOutcome;
  readonly controlGeneration?: number;
  readonly artifactSha256?: string;
  /**
   * When Cuna ESTABLISHED the installation, which is the installation time only
   * when `installationEvidence` is `installer_exit`.
   */
  readonly installedAt?: string;
  readonly installationEvidence?: SupervisorLiveUpdateInstallationEvidence;
  /** Scope: the AgentSessions this attempt measured. Empty until prestate binds. */
  readonly declaredSessions: readonly SupervisorLiveUpdateDeclaredSession[];
  /** Account: empty unless the operation settled with one. Never fabricated. */
  readonly sessions: readonly SupervisorLiveUpdateSession[];
  readonly failure?: SupervisorLiveUpdateFailure;
  readonly nextAction: SupervisorLiveUpdateNextAction;
  readonly claimedAt: string;
  readonly updatedAt: string;
  readonly settledAt?: string;
  /**
   * When Cuna advanced this Machine's install fence past this operation's
   * control generation. After it, the installer this operation authorized can
   * perform no configuration write, binary replacement or service restart,
   * however long it was delayed. Absent until that happens.
   *
   * It is what tells one `installerOutcome: "unknown"` from another. Absent,
   * `unknown` means an authorized installer may still arrive. Present, it means
   * Cuna never observed that installer AND it can no longer act — and those two
   * are not interchangeable for anyone deciding whether this Machine is safe to
   * touch.
   */
  readonly retiredAt?: string;
  /**
   * What the fence had recorded for this generation when it was retired, and
   * NEVER a substitute for `installerOutcome`, which is what Cuna observed.
   *
   *   `retired`   no admission existed, so the installer never reached the
   *               fence and the fence precedes every write it could perform.
   *   `partial`   admitted and unfinished: it began writing.
   *   `installed` admitted and finished.
   */
  readonly retirementOutcome?: SupervisorLiveUpdateRetirementOutcome;
}

const OUTCOMES: ReadonlySet<string> = new Set(SUPERVISOR_LIVE_UPDATE_WIRE.outcomes);
const PHASES: ReadonlySet<string> = new Set(SUPERVISOR_LIVE_UPDATE_WIRE.recovery.phases);
const INSTALLER_OUTCOMES: ReadonlySet<string> =
  new Set(SUPERVISOR_LIVE_UPDATE_WIRE.recovery.installerOutcomes);
const INSTALLATION_EVIDENCE: ReadonlySet<string> =
  new Set(SUPERVISOR_LIVE_UPDATE_WIRE.recovery.installationEvidence);
const NEXT_ACTIONS: ReadonlySet<string> = new Set(SUPERVISOR_LIVE_UPDATE_WIRE.recovery.nextActions);
const FAILURE_ACTIONS: ReadonlySet<string> =
  new Set(SUPERVISOR_LIVE_UPDATE_WIRE.recovery.failureActions);
const RETIREMENT_OUTCOMES: ReadonlySet<string> =
  new Set(SUPERVISOR_LIVE_UPDATE_WIRE.recovery.retirementOutcomes);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PROBLEM_CODE = /^[a-z][a-z0-9_]{2,63}$/u;

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

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw contractViolation("parsable_timestamp", field);
  }
  return value;
}

/**
 * A field the producer types as `["X", "null"]`.
 *
 * `null` is the producer's own way of saying "not established yet", and it is
 * decoded to `undefined` — absent rather than a falsy value some later branch
 * could read as zero, empty or settled.
 */
function nullable<T>(value: unknown, field: string, decode: (value: unknown) => T): T | undefined {
  if (value === null) return undefined;
  if (value === undefined) throw contractViolation("explicit_null_not_absence", field);
  return decode(value);
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

function decodeDeclaredSession(value: unknown): SupervisorLiveUpdateDeclaredSession {
  if (!isObject(value)) throw contractViolation("object");
  exactKeys(
    value,
    SUPERVISOR_LIVE_UPDATE_WIRE.recovery.declaredSessionKeys,
    "exact_live_update_declared_session_shape",
  );
  return Object.freeze({
    agentSessionId: uuid(value.agent_session_id, "agent_session_id"),
    processEpoch: uuid(value.process_epoch, "process_epoch"),
  });
}

function decodeSessionArray<T extends { readonly agentSessionId: string }>(
  value: unknown,
  field: string,
  decode: (item: unknown) => T,
): readonly T[] {
  if (!Array.isArray(value) || value.length > SUPERVISOR_LIVE_UPDATE_WIRE.maximumSessions) {
    throw contractViolation("bounded_live_update_session_array", field);
  }
  const items = value.map((item, index) => underIndex(field, index, () => decode(item)));
  // One AgentSession may not appear twice: two rows for one id would let a
  // `preserved` and an `ended` verdict coexist for the same process.
  if (new Set(items.map((item) => item.agentSessionId)).size !== items.length) {
    throw contractViolation("distinct_agent_sessions", field);
  }
  return items;
}

function decodeFailure(value: unknown): SupervisorLiveUpdateFailure {
  if (!isObject(value)) throw contractViolation("object", "failure");
  exactKeys(value, SUPERVISOR_LIVE_UPDATE_WIRE.recovery.failureKeys, "exact_live_update_failure_shape");
  const status = value.status;
  if (!Number.isSafeInteger(status) || Number(status) < 400 || Number(status) > 599) {
    throw contractViolation("problem_status", "failure.status");
  }
  const code = value.code;
  if (typeof code !== "string" || !PROBLEM_CODE.test(code)) {
    throw contractViolation("problem_code", "failure.code");
  }
  const title = value.title;
  if (typeof title !== "string" || title.length < 1 || title.length > 120) {
    throw contractViolation("bounded_title", "failure.title");
  }
  const detail = value.detail;
  if (typeof detail !== "string" || detail.length < 1 || detail.length > 500) {
    throw contractViolation("bounded_detail", "failure.detail");
  }
  if (typeof value.retryable !== "boolean") {
    throw contractViolation("boolean", "failure.retryable");
  }
  const action = value.action;
  if (typeof action !== "string" || !FAILURE_ACTIONS.has(action)) {
    throw contractViolation("known_enum_value", "failure.action");
  }
  return Object.freeze({
    status: Number(status),
    code,
    title,
    detail,
    retryable: value.retryable,
    action: action as SupervisorLiveUpdateFailureAction,
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
  const sessions = decodeSessionArray(value.agent_sessions, "agent_sessions", decodeSession);
  return Object.freeze({
    machine: decodeMachineItem(value.machine),
    operationId: uuid(value.operation_id, "operation_id"),
    controlGeneration: Number(controlGeneration),
    artifactSha256,
    installedAt: timestamp(value.installed_at, "installed_at"),
    sessions: Object.freeze(sessions),
  });
}

/**
 * The authoritative phase and known result of ONE owned in-place update.
 *
 * Everything optional here is optional because the producer types it nullable,
 * and every one of those nulls means "Cuna has not established this". None of
 * them is defaulted: a `control_generation` of null is not generation zero, an
 * empty `agent_sessions` is not a set of `unknown` outcomes, and an
 * `installed_at` with `installation_evidence: reconciled` is when Cuna LOOKED,
 * not when the artifact arrived.
 */
export function decodeSupervisorLiveUpdateOperation(value: unknown): SupervisorLiveUpdateOperation {
  if (!isObject(value)) throw contractViolation("object");
  exactKeys(
    value,
    SUPERVISOR_LIVE_UPDATE_WIRE.recovery.operationKeys,
    "exact_live_update_operation_shape",
  );
  const phase = value.phase;
  if (typeof phase !== "string" || !PHASES.has(phase)) {
    throw contractViolation("known_enum_value", "phase");
  }
  if (typeof value.control_rotated !== "boolean") {
    throw contractViolation("boolean", "control_rotated");
  }
  const installerOutcome = value.installer_outcome;
  if (typeof installerOutcome !== "string" || !INSTALLER_OUTCOMES.has(installerOutcome)) {
    throw contractViolation("known_enum_value", "installer_outcome");
  }
  const nextAction = value.next_action;
  if (typeof nextAction !== "string" || !NEXT_ACTIONS.has(nextAction)) {
    throw contractViolation("known_enum_value", "next_action");
  }
  const controlGeneration = nullable(value.control_generation, "control_generation", (raw) => {
    if (!Number.isSafeInteger(raw) || Number(raw) < 1) {
      throw contractViolation("safe_positive_integer", "control_generation");
    }
    return Number(raw);
  });
  const artifactSha256 = nullable(value.artifact_sha256, "artifact_sha256", (raw) => {
    if (typeof raw !== "string" || !SHA256.test(raw)) {
      throw contractViolation("sha256_digest", "artifact_sha256");
    }
    return raw;
  });
  const installedAt = nullable(value.installed_at, "installed_at", (raw) =>
    timestamp(raw, "installed_at"));
  const installationEvidence = nullable(value.installation_evidence, "installation_evidence", (raw) => {
    if (typeof raw !== "string" || !INSTALLATION_EVIDENCE.has(raw)) {
      throw contractViolation("known_enum_value", "installation_evidence");
    }
    return raw as SupervisorLiveUpdateInstallationEvidence;
  });
  const failure = nullable(value.failure, "failure", decodeFailure);
  const settledAt = nullable(value.settled_at, "settled_at", (raw) => timestamp(raw, "settled_at"));
  const retiredAt = nullable(value.retired_at, "retired_at", (raw) => timestamp(raw, "retired_at"));
  const retirementOutcome = nullable(value.retirement_outcome, "retirement_outcome", (raw) => {
    if (typeof raw !== "string" || !RETIREMENT_OUTCOMES.has(raw)) {
      throw contractViolation("known_enum_value", "retirement_outcome");
    }
    return raw as SupervisorLiveUpdateRetirementOutcome;
  });
  // The producer's own invariant, and the one a renderer would otherwise have to
  // guess at: only a settled operation is finished with, and only a settled one
  // stops asking for the same identity back.
  if ((phase === "settled") !== (nextAction === "none")) {
    throw contractViolation("settled_phase_agrees_with_next_action", "next_action");
  }
  if ((phase === "settled") !== (settledAt !== undefined)) {
    throw contractViolation("settled_phase_agrees_with_settled_at", "settled_at");
  }
  // The producer's own column constraint, `(retired_at is null) =
  // (retirement_receipt is null)`. One of the two alone is a row the producer
  // forbids, and accepting it would let a surface say "the installer can no
  // longer act" with nothing recording what it had already done, or the reverse.
  if ((retiredAt !== undefined) !== (retirementOutcome !== undefined)) {
    throw contractViolation("retirement_time_agrees_with_retirement_outcome", "retirement_outcome");
  }
  // `supervisor_live_update_retirement_after_rotation`: nothing can be retired
  // that never authorized an installer. A retirement on an operation that never
  // rotated control would be a fence raised against nothing.
  if (retiredAt !== undefined && !value.control_rotated) {
    throw contractViolation("retirement_follows_control_rotation", "retired_at");
  }
  // `supervisor_live_update_unknown_settles_only_on_retirement`: the retirement
  // receipt is the ONLY evidence on which an unobserved installer outcome may
  // settle. This is the invariant the whole presentation rests on -- it is what
  // makes "settled and unknown" mean "it never ran and can no longer run"
  // rather than "nobody ever found out" -- so a row that settles `unknown`
  // without it is refused here rather than rendered as either.
  //
  // Deliberately NOT the converse. A retired operation may still be open: a
  // `partial` receipt whose Machine still reports an outstanding systemd job
  // cannot settle, and the producer records the fence anyway because raising it
  // is true regardless and is what stops a new effect from starting.
  if (phase === "settled" && installerOutcome === "unknown" && retiredAt === undefined) {
    throw contractViolation("settled_unknown_carries_retirement", "retired_at");
  }
  return Object.freeze({
    operationId: uuid(value.operation_id, "operation_id"),
    machineId: uuid(value.machine_id, "machine_id"),
    phase: phase as SupervisorLiveUpdatePhase,
    controlRotated: value.control_rotated,
    installerOutcome: installerOutcome as SupervisorLiveUpdateInstallerOutcome,
    ...(controlGeneration === undefined ? {} : { controlGeneration }),
    ...(artifactSha256 === undefined ? {} : { artifactSha256 }),
    ...(installedAt === undefined ? {} : { installedAt }),
    ...(installationEvidence === undefined ? {} : { installationEvidence }),
    declaredSessions: Object.freeze(
      decodeSessionArray(value.declared_sessions, "declared_sessions", decodeDeclaredSession),
    ),
    sessions: Object.freeze(decodeSessionArray(value.agent_sessions, "agent_sessions", decodeSession)),
    ...(failure === undefined ? {} : { failure }),
    nextAction: nextAction as SupervisorLiveUpdateNextAction,
    claimedAt: timestamp(value.claimed_at, "claimed_at"),
    updatedAt: timestamp(value.updated_at, "updated_at"),
    ...(settledAt === undefined ? {} : { settledAt }),
    ...(retiredAt === undefined ? {} : { retiredAt }),
    ...(retirementOutcome === undefined ? {} : { retirementOutcome }),
  });
}
