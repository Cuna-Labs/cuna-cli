import { createHash } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { join } from "node:path";

import type {
  SupervisorLiveUpdate,
  SupervisorLiveUpdateInstallationEvidence,
  SupervisorLiveUpdateInstallerOutcome,
  SupervisorLiveUpdateOperation,
  SupervisorLiveUpdateOutcome,
  SupervisorLiveUpdatePhase,
} from "../api/supervisor-live-update.js";
import { CunaError } from "../core/errors.js";
import { isObservationBudgetCode } from "../core/observation-budget.js";
import { assertCanonicalUuid, assertMachineId } from "../core/validation.js";
import type { PlatformAdapter, SafeFileSnapshot } from "../platform/adapter.js";

/* -------------------------------------------------------------------------- */
/* What the producer's refusals mean for the Machine                          */
/* -------------------------------------------------------------------------- */

/**
 * Refusals ordered strictly BEFORE the producer admits a durable operation.
 *
 * The grouping is the producer's ordering, read at
 * `7cb7e37ec8f0821fc6b402be5fcc9bc8e9439d55`, not a guess: `updateLiveSupervisor`
 * parses, reads the owned Machine, checks `status === "running"`, checks the
 * runtime and resolves the tenant, and only THEN calls `claimOperation` — under
 * the comment "the durable identity, before any observation of the Machine …
 * an ABSENT record is itself evidence". Every code below can only be reached
 * above that line, so no operation exists under the identity this CLI sent and
 * the local record that holds it has nothing left to protect.
 *
 * `supervisor_live_update_unverifiable`, `..._control_unavailable`,
 * `..._preconditions_unmet` and `..._not_required` are deliberately NOT here.
 * The producer raises each of them from BOTH sides of the claim, and the wire
 * carries no field that says which. Whether they settled the record is then the
 * record's own question, and `machines live-update-status` is what asks it.
 */
const NOT_ADMITTED_REASONS: ReadonlySet<string> = new Set([
  // 422: the request never named a Machine, or never named an operation.
  "invalid_supervisor_upgrade_request",
  // 409, both raised above the claim.
  "supervisor_live_update_machine_not_running",
  "supervisor_live_update_runtime_unavailable",
]);

/**
 * 404, and the one reason whose meaning depends on WHOSE identity was sent.
 *
 * The producer answers `resource_not_found` for an absent Machine, a Machine
 * this principal does not own, AND an operation row that its owner-scoped query
 * cannot see. Those are one answer by design — it refuses to tell a caller which
 * of them is true — so the client cannot read it without saying what it asked
 * with.
 *
 * With an identity this process MINTED microseconds ago, no operation can exist
 * under it, so the answer is about the Machine and nothing was admitted.
 *
 * With an identity read from this computer's record, it is not. The signed-in
 * principal may simply have changed since the record was written: the record is
 * keyed by API origin and Machine, deliberately, so that switching profiles
 * cannot clear it — and the same property means the account asking may not be
 * the account that filed it. Treating that 404 as "this operation never
 * existed" would discard the one handle that could still resolve it, on the say
 * so of an answer that means "you cannot see it".
 */
const NOT_FOUND_REASON = "resource_not_found";

export type LiveSupervisorUpdateIdentityOrigin =
  /** Minted by this process for this attempt, and never sent before. */
  | "new_identity"
  /** Read from this computer's durable record, and possibly already admitted. */
  | "recorded_identity";

/** The update landed, was acknowledged, and named AgentSessions that did not survive. */
const SESSIONS_ENDED_REASON = "supervisor_live_update_sessions_ended";

/**
 * The producer's single word for "this operation has not resolved".
 *
 * Its meaning INVERTED at the producer commit this CLI is pinned to, and the
 * inversion is the whole point of the durable identity. Every detail carrying
 * this code used to end "do not repeat the update"; every one of them now ends
 * "Repeat this same update request; do not start a new one." Repetition is safe
 * because the identity is the producer's journal key — the same value resumes an
 * attempt that spent nothing and reconciles one that may have spent something.
 *
 * It is still not a TRANSPORT retry. `api/client.ts` keeps `automaticRedispatch`
 * off for this mutation so the only repetition is one a person chose.
 */
const PENDING_REASON = "supervisor_live_update_pending";

/**
 * Another operation holds this Machine, or this identity meant something else.
 *
 * One code covers five producer conditions, two of which ("this update has
 * already changed this Machine's control", "this Machine is no longer the one
 * this update measured") mean the identity we sent DID rotate control. The wire
 * does not separate them, so this build does not either: it keeps the record and
 * reads the operation.
 */
const OPERATION_CONFLICT_REASON = "supervisor_live_update_operation_conflict";

/** Terminal, control rotated, nothing installed: the Machine was busy launching. */
const IN_PROGRESS_REASON = "supervisor_live_update_in_progress";

export type LiveSupervisorUpdateDisposition =
  /**
   * Proven before the producer admitted a durable operation, so no operation
   * exists under this identity and the Machine is unchanged.
   */
  | "not_admitted"
  /** Installed and acknowledged; named AgentSessions did not survive it. */
  | "applied_with_ended_sessions"
  /** Control rotated for this operation and nothing was installed. Terminal. */
  | "settled_control_rotated"
  /** Unresolved, and the producer's own next step is repeating THIS identity. */
  | "resumable"
  /** Refused because an operation already holds this Machine, or this one did. */
  | "operation_conflict"
  /**
   * Another operation holds this Machine and the identity sent was minted for
   * this attempt, so the producer refused above its own claim and journalled
   * nothing under it. Nothing was admitted, nothing was spent, and the Machine
   * is free again as soon as the other operation settles.
   */
  | "not_admitted_machine_busy"
  /**
   * The recorded identity is not readable by the account that asked. It is not
   * evidence that the operation never existed, and it never clears the record.
   */
  | "operation_inaccessible"
  /** It may or may not have applied. Not retryable, not a failure, not a success. */
  | "unknown";

/**
 * Dispositions for which the local record must survive.
 *
 * With a durable server-side operation the record stopped being a local
 * suppression and became the only place the identity of a possibly-open
 * operation lives. Dropping it strands the Machine twice over: the owner cannot
 * resume the identity, and the producer refuses every DIFFERENT identity until
 * that operation settles. So the record is kept unless an authoritative read
 * says the operation settled, or the refusal proves it was never admitted.
 */
/**
 * Answers the producer only reaches through `settled(...)`, which writes the
 * terminal record before it throws. Reaching one is itself proof that the
 * operation is closed, whichever identity asked.
 */
const SETTLED_DISPOSITIONS: ReadonlySet<LiveSupervisorUpdateDisposition> = new Set([
  "applied_with_ended_sessions",
  "settled_control_rotated",
] as const);

/**
 * Whether the local record must survive this refusal.
 *
 * Two ways out, and the asymmetry between them is what a reviewer drove out. A
 * refusal that proves nothing was ADMITTED only proves it for an identity this
 * process MINTED: the same refusal reached with a RECORDED identity may be
 * about an operation that exists and is merely out of this account's view — the
 * record is keyed by API origin and Machine so that switching profiles cannot
 * clear it, and the price of that is that the account asking need not be the
 * account that filed it. A record dropped there leaves a Machine nobody can
 * resume and nobody can start afresh.
 */
export function liveSupervisorUpdateRecordSurvives(
  disposition: LiveSupervisorUpdateDisposition,
  origin: LiveSupervisorUpdateIdentityOrigin = "recorded_identity",
): boolean {
  if (SETTLED_DISPOSITIONS.has(disposition)) return false;
  // `not_admitted_machine_busy` is only ever produced for a minted identity, so
  // the origin conjunct is stated once and both of them share it.
  return !(
    origin === "new_identity" &&
    (disposition === "not_admitted" || disposition === "not_admitted_machine_busy")
  );
}

/** Whether re-sending the SAME operation identity is the producer's own next step. */
export function liveSupervisorUpdateMayResume(
  disposition: LiveSupervisorUpdateDisposition,
): boolean {
  return disposition === "resumable" || disposition === "unknown";
}

function reasonOf(error: unknown): string | undefined {
  if (!(error instanceof CunaError)) return undefined;
  const reason = error.details?.["reason"];
  return typeof reason === "string" ? reason : undefined;
}

/**
 * Classify a failed dispatch of the in-place update.
 *
 * Fails CLOSED on purpose: an error this build cannot name is `unknown`, because
 * the alternative is telling a caller nothing happened to a Machine whose
 * supervisor may already have been replaced — and, now, discarding the one
 * identity that could still resolve it.
 */
export function classifyLiveSupervisorUpdateFailure(
  error: unknown,
  /**
   * What was sent. Defaulted to the conservative reading, so a caller that
   * forgets to say cannot accidentally get the one answer that discards a
   * record.
   */
  origin: LiveSupervisorUpdateIdentityOrigin = "recorded_identity",
): LiveSupervisorUpdateDisposition {
  const reason = reasonOf(error);
  if (reason === NOT_FOUND_REASON) {
    return origin === "new_identity" ? "not_admitted" : "operation_inaccessible";
  }
  if (reason !== undefined && NOT_ADMITTED_REASONS.has(reason)) return "not_admitted";
  if (reason === SESSIONS_ENDED_REASON) return "applied_with_ended_sessions";
  if (reason === IN_PROGRESS_REASON) return "settled_control_rotated";
  if (reason === PENDING_REASON) return "resumable";
  if (reason === OPERATION_CONFLICT_REASON) {
    /* One code, five producer conditions, and which are reachable depends on
       what was sent. With an identity this process minted moments ago, only
       `machine_busy` is: `claim_supervisor_live_update_operation` at 7cb
       (migration 0193) looks the offered id up first, and when it is absent and
       another unsettled operation holds the Machine it returns `machine_busy`
       BEFORE its insert. No row exists for the id that was sent, so nothing was
       admitted under it. The other four all require that id to exist already.
       Treating this as `operation_conflict` for a fresh identity kept a record
       naming an operation the producer had never heard of: no repeat, no new
       update, and a read that could only ever answer not-found. The dispatch
       path still confirms non-admission with that read before it acts. */
    return origin === "new_identity" ? "not_admitted_machine_busy" : "operation_conflict";
  }
  if (error instanceof CunaError) {
    // The CLI stopped waiting for its own response. The request is still in
    // flight as far as this process knows.
    if (isObservationBudgetCode(error.code)) return "unknown";
    // Refusals this CLI raised itself, before anything left the process.
    if (
      error.code === "cuna.usage.invalid" ||
      error.code === "cuna.confirmation.required" ||
      error.code.startsWith("cuna.capability.")
    ) return "not_admitted";
    // A credential the server refused outright never reached the operation.
    if (error.code === "cuna.auth.rejected" || error.code === "cuna.policy.denied") return "not_admitted";
  }
  return "unknown";
}

/* -------------------------------------------------------------------------- */
/* The per-session account                                                     */
/* -------------------------------------------------------------------------- */

export interface LiveSupervisorUpdateSummary {
  readonly total: number;
  readonly preserved: number;
  readonly exited: number;
  readonly ended: number;
  readonly unknown: number;
  /** True only when every declared AgentSession is accounted for as `preserved`. */
  readonly allPreserved: boolean;
  /** True while any outcome is `unknown`: the local record must survive this. */
  readonly anyUnknown: boolean;
}

export function summarizeLiveSupervisorUpdate(result: SupervisorLiveUpdate): LiveSupervisorUpdateSummary {
  const count = (outcome: SupervisorLiveUpdateOutcome): number =>
    result.sessions.filter((session) => session.outcome === outcome).length;
  const preserved = count("preserved");
  const unknown = count("unknown");
  return Object.freeze({
    total: result.sessions.length,
    preserved,
    exited: count("exited"),
    ended: count("ended"),
    unknown,
    // An empty Machine has nothing to preserve, and saying "all preserved" of
    // zero sessions would read as a custody claim nobody made.
    allPreserved: result.sessions.length > 0 && preserved === result.sessions.length,
    anyUnknown: unknown > 0,
  });
}

/**
 * The human sentence for one session outcome.
 *
 * `ended` and `unknown` are deliberately not softened. A 200 that carries either
 * is a producer this build does not expect — its operation raises instead — and
 * the honest reading of that response is still the outcome it states.
 */
export function liveSupervisorSessionOutcomeLabel(outcome: SupervisorLiveUpdateOutcome): string {
  switch (outcome) {
    case "preserved": return "preserved (same process, PTY and stored master)";
    case "exited": return "exited on its own during the update";
    case "ended": return "did not survive the update";
    case "unknown": return "unknown: Cuna could not re-read it";
  }
}

/* -------------------------------------------------------------------------- */
/* Reading one operation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The producer's four phases in the one sentence each owner needs.
 *
 * None of them says "running", and that is deliberate. The producer's own note
 * on this route is that a running Machine is not evidence that an update did or
 * did not apply, and that this read is the only thing that is.
 */
export function liveSupervisorUpdatePhaseLabel(phase: SupervisorLiveUpdatePhase): string {
  switch (phase) {
    case "claimed":
      return "claimed: recorded, and no enrollment, installer or control change has left Cuna";
    case "control_rotated":
      return "control rotated: this Machine's supervisor control HAS changed for this update, and what the installer did is unknown";
    case "installed":
      return "installed: the selected artifact is on the Machine; its acknowledgement and the fate of the AgentSessions may still be unestablished";
    case "settled":
      return "settled: terminal, and this recorded answer is what every repeat of this identity receives";
  }
}

/**
 * What Cuna OBSERVED of the installer, qualified by whether that installer can
 * still act.
 *
 * `unknown` is the reason this takes a second argument. On its own the word
 * covers two states a person has to tell apart: a request was sent and nobody
 * found out, and an authorized installer may still wake up and write; or the
 * same, plus a fence the Machine has since raised so that it never can. The
 * producer publishes the difference and this sentence carries it.
 *
 * The fence never changes the outcome itself. `unknown` retired is still
 * `unknown` — Cuna did not observe an installation and does not claim one — and
 * `installed` is Cuna's own observation, which no retirement record replaces.
 */
export function liveSupervisorInstallerOutcomeLabel(
  outcome: SupervisorLiveUpdateInstallerOutcome,
  reach: LiveSupervisorInstallerReach = "may_still_arrive",
): string {
  switch (outcome) {
    case "not_sent":
      return "not sent: no installer request left Cuna";
    case "unknown":
      return reach === "may_still_arrive"
        ? "unknown: a request was sent, nothing observed what it did, and an installer it authorized may still arrive"
        : "unknown: a request was sent and nothing observed what it did. Cuna has since retired that installer on the Machine, so it can no longer act";
    case "refused":
      return "refused: the installer answered and refused, which it does before it writes";
    case "installed":
      return "installed: the selected artifact is on the Machine";
  }
}

/**
 * What `installed_at` is a timestamp OF, which is not the same question twice.
 *
 * `installer_exit` is the installer's own zero exit inside this operation's
 * request, so the time is the installation's. `reconciled` is a later read-only
 * observation that found the artifact there: it establishes THAT it is
 * installed and never WHEN, so the timestamp is when Cuna looked.
 */
export function liveSupervisorInstallationEvidenceLabel(
  evidence: SupervisorLiveUpdateInstallationEvidence,
): string {
  return evidence === "installer_exit"
    ? "installer_exit: the installer's own zero exit, observed in this operation's own request"
    : "reconciled: a later read-only observation found the artifact on the Machine, which establishes that it is installed and never when";
}

/**
 * How far the installer this operation authorized can still reach, from the
 * producer's install fence.
 *
 * The fence is what makes an `unknown` installer outcome readable at all.
 * Before it, `unknown` had exactly one meaning — nobody found out, and an
 * authorized installer may still wake up and write. After a retirement, the
 * SAME `unknown` means Cuna never observed that installer AND it can no longer
 * perform any configuration write, binary replacement or service restart. Those
 * two are not interchangeable for anyone deciding whether this Machine is safe
 * to touch, so they are two values here and two sentences to a reader.
 *
 * None of these is an installation. `retired_after_completion` is the FENCE's
 * record that an admitted installer finished; `installerOutcome` is what Cuna
 * itself observed, and only that may be rendered as an installation.
 */
export type LiveSupervisorInstallerReach =
  /** The fence has not been advanced past this operation's control generation. */
  | "may_still_arrive"
  /** Retired with no admission: it never reached the fence, so it never wrote. */
  | "retired_without_admission"
  /** Retired after admission, unfinished: it began writing and stopped. */
  | "retired_after_partial_write"
  /** Retired after admission, finished. Still not Cuna's own observation. */
  | "retired_after_completion";

export interface LiveSupervisorUpdateOperationReading {
  /** Terminal: nothing further will change this record. */
  readonly settled: boolean;
  /** The producer's own next step, and the only safe repetition. */
  readonly mayRepeatSameOperation: boolean;
  /** Irreversible once true, including for a settled failure. */
  readonly controlRotated: boolean;
  /** AgentSessions the attempt measured. Scope, never outcome. */
  readonly declared: number;
  /** AgentSessions the operation settled an account for. */
  readonly accounted: number;
  /**
   * True when the operation declared AgentSessions and has settled no account
   * for them. The right rendering is silence about their fate — NOT a set of
   * `unknown` outcomes, which would be an answer the producer withheld.
   */
  readonly accountWithheld: boolean;
  /** What the producer's install fence says this operation's installer can do. */
  readonly installerReach: LiveSupervisorInstallerReach;
  /**
   * Whether an installer this operation authorized could still change this
   * Machine. Derived from the fence alone, never from the phase: a settled
   * operation whose fence was never advanced is exactly the row this exists for.
   */
  readonly installerCanStillAct: boolean;
  /**
   * True only where the producer says nothing on the Machine was changed: the
   * fence held no admission for this generation, and it is ordered before every
   * write the installer could perform. It is a statement about the INSTALLER,
   * never about the update as a whole — control may still have rotated.
   */
  readonly installerWroteNothing: boolean;
}

/** The fence reading, from the two fields the producer keeps paired. */
function installerReachOf(operation: SupervisorLiveUpdateOperation): LiveSupervisorInstallerReach {
  if (operation.retiredAt === undefined) return "may_still_arrive";
  if (operation.retirementOutcome === "retired") return "retired_without_admission";
  if (operation.retirementOutcome === "installed") return "retired_after_completion";
  // `partial`, and the shape the decoder already refuses -- a retirement time
  // with no outcome beside it. Falling through to `partial` is the safe
  // direction for both: it is the only reading that asserts nothing about what
  // the installer did or did not write, and it names an action. Falling through
  // to `retired` would be the dangerous one, because that reading TELLS a person
  // nothing on the Machine was changed.
  return "retired_after_partial_write";
}

export function readLiveSupervisorUpdateOperation(
  operation: SupervisorLiveUpdateOperation,
): LiveSupervisorUpdateOperationReading {
  const declared = operation.declaredSessions.length;
  const accounted = operation.sessions.length;
  const installerReach = installerReachOf(operation);
  return Object.freeze({
    settled: operation.phase === "settled",
    mayRepeatSameOperation: operation.nextAction === "repeat_same_operation",
    controlRotated: operation.controlRotated,
    declared,
    accounted,
    accountWithheld: declared > 0 && accounted === 0,
    installerReach,
    installerCanStillAct: installerReach === "may_still_arrive",
    installerWroteNothing: installerReach === "retired_without_admission",
  });
}

/**
 * What the fence says, and what a person may do next because of it.
 *
 * Two sentences, and the second is an ACTION only where the producer supports
 * one. The producer names it in its own refusals, which reach only a client
 * that was live at the moment they were recorded; a client recovering later
 * sees these fields and nothing else, so the sentence is derived from them here
 * rather than left to a reader to reconstruct.
 *
 * What none of these may do: turn `unknown` into a success, or read a fence
 * record of a completed installer as Cuna having observed an installation.
 */
export function liveSupervisorInstallerReachLines(
  reading: LiveSupervisorUpdateOperationReading,
  machineId: string,
): readonly string[] {
  const startNew =
    `Start a new in-place supervisor update: \`cuna machines live-update-supervisor ${machineId} --yes\`.`;
  switch (reading.installerReach) {
    case "may_still_arrive":
      return [
        "This update's installer has not been retired on the Machine, so one it authorized could still arrive and change this Machine, however long it has been.",
      ];
    case "retired_without_admission":
      return [
        "Cuna has retired this update's installer on the Machine itself: it reports that the installer never reached it, and it can no longer arrive. Nothing this installer would have written was written.",
        `${startNew} This Machine's control generation has already moved, which is irreversible and is not undone by the retirement.`,
      ];
    case "retired_after_partial_write":
      return [
        "Cuna has retired this update's installer on the Machine, and the Machine reports that it had been admitted and did not finish: it began replacing the supervisor and stopped. Cuna cannot say which files it had already written, and cannot say what became of the AgentSessions.",
        `${startNew} It re-measures this Machine and installs the whole release over what is there. Inspect the AgentSessions first if they matter.`,
      ];
    case "retired_after_completion":
      return [
        "Cuna has retired this update's installer on the Machine, and the Machine's own fence records that it had been admitted and finished. That is the FENCE's record, not an observation by Cuna: the installer outcome above is the only thing that says what Cuna saw.",
        "Inspect this Machine's supervisor and its AgentSessions before starting anything else.",
      ];
  }
}

/* -------------------------------------------------------------------------- */
/* The durable local note                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One local note per Machine whose in-place update this installation dispatched
 * and never saw settle.
 *
 * Modelled on `machines/execution-receipt.ts`: written BEFORE the request leaves,
 * dropped only when an authoritative answer arrives, and never permission to
 * replay by itself.
 *
 * WHAT CHANGED WHEN THE PRODUCER GREW AN OPERATION IDENTITY. The note used to
 * exist for one requirement — a fresh invocation must not silently repeat a
 * mutation whose outcome is outstanding — because the operation had no durable
 * identity of its own and a second POST was indistinguishable from a first. It
 * now has two requirements, and the second is the larger one:
 *
 *   1. it still suppresses a blind repeat, and
 *   2. it is the ONLY place `operation_id` survives a lost response.
 *
 * That identity is what the recovery read is addressed to and what a deliberate
 * repeat re-sends, so a note discarded on a guess does not merely lose a
 * suppression: it strands the Machine, because the producer refuses every
 * DIFFERENT identity until the open one settles. Every path that removes a note
 * therefore needs an authoritative answer or a proof that none was admitted.
 *
 * THE KEY IS (CANONICAL API ORIGIN, MACHINE). Nothing else.
 *
 * The local profile used to be part of it, and that was a hole rather than a
 * refinement: one owner with two profiles pointing at the same API could clear
 * the suppression by passing `--profile` and repeat an update whose outcome the
 * first profile was still holding open. A Machine is a Machine on one API
 * whichever local profile names it, so the note is keyed by what the Machine
 * actually belongs to. `URL.origin` is the canonicalization — scheme, lowercased
 * host, non-default port — so `https://API.GetCuna.com:443/v1` and
 * `https://api.getcuna.com/` are the same scope, and a genuinely different
 * deployment is a genuinely different one.
 *
 * WHAT IT CANNOT DO, because a note that over-claims is worse than none:
 *   - it is not evidence that anything was or was not applied;
 *   - it is local to this computer, so a second computer or the web console
 *     sees nothing;
 *   - an account is deliberately NOT part of the key. The note must be readable
 *     in precisely the state that produced it — one where the API may not be
 *     answering — and `getIdentity()` would make recovering it depend on the
 *     service whose silence is the reason it exists. `account` may be recorded
 *     as a LABEL when the caller already holds authoritative identity, and it is
 *     never consulted to admit anything: a note whose account is absent, or
 *     names someone else, still suppresses. Metadata can refuse; it cannot
 *     grant. The API remains the authentication and authorization boundary, and
 *     a Machine this account may not touch is refused there, not here.
 *
 * Nothing secret is persisted: a scope digest, a Machine UUID, a timestamp and
 * optionally one already-public account UUID.
 */
export interface LiveSupervisorUpdateScope {
  /** Any URL on the API the Machine belongs to. Only its origin is used. */
  readonly baseUrl: string;
}

export interface LiveSupervisorUpdateNote {
  readonly version: 2;
  readonly scope: string;
  readonly machineId: string;
  /**
   * The identity this computer chose and sent. It is the whole reason the note
   * outlives a lost answer: the recovery read is addressed to it, and a
   * deliberate repeat re-sends exactly it.
   */
  readonly operationId: string;
  readonly dispatchedAt: string;
  /** Label only. Never part of the key, never consulted to admit a mutation. */
  readonly account?: string;
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAXIMUM_BYTES = 2048;
const NOTE_KEYS = "dispatchedAt,machineId,operationId,scope,version";
const NOTE_KEYS_WITH_ACCOUNT = "account,dispatchedAt,machineId,operationId,scope,version";
const DIRECTORY = "supervisor-live-updates";

/**
 * One short, printable sentence about why a record could not be read.
 *
 * It reaches a terminal and a `--json` record, so it is bounded and carries no
 * bytes from the record itself — only the reason the reader gave.
 */
function boundedReason(error: unknown): string {
  const message = error instanceof Error && typeof error.message === "string"
    ? error.message
    : "the record could not be read";
  const flattened = message.replaceAll(/\s+/gu, " ").trim();
  return flattened.length <= 160 ? flattened : `${flattened.slice(0, 159)}…`;
}

function scopeDigest(scope: LiveSupervisorUpdateScope): string {
  const url = new URL(scope.baseUrl);
  if (url.username || url.password || !["https:", "http:"].includes(url.protocol)) {
    throw new Error("Invalid live supervisor update scope.");
  }
  // `url.origin`, not `url.href`: the path, query and fragment of whichever
  // base URL a profile happens to carry must not fork the exclusion.
  return createHash("sha256")
    .update(JSON.stringify(["supervisor-live-update", url.origin]))
    .digest("hex");
}

/**
 * What the slot says, without ever refusing to answer.
 *
 * `read` used to throw on bytes it could not decode, and the command called it
 * BEFORE `settle` on the `--forget-unknown` path — so the one state the
 * documented recovery exists for was the one state that recovery could not
 * reach. An unreadable record is now an answer with a name, and every caller
 * decides what to do with it: the dispatch path refuses (fail closed), the
 * explicit acknowledgement discards it.
 */
export type LiveSupervisorUpdateReading =
  | Readonly<{ state: "none" }>
  | Readonly<{ state: "outstanding"; note: LiveSupervisorUpdateNote }>
  | Readonly<{ state: "unreadable"; path: string; reason: string }>;

/** What `settle` did, so a caller can say it rather than assume it. */
export type LiveSupervisorUpdateSettlement =
  /** The record this exact dispatch created was removed. */
  | "settled"
  /** There was nothing filed. A settled operation settling twice is normal. */
  | "absent"
  /**
   * Something else is filed under this Machine: a newer dispatch, or bytes this
   * build cannot read. Not ours to remove, so it stays.
   */
  | "superseded";

export interface LiveSupervisorUpdateNotes {
  /**
   * Take the slot, or answer that it is taken.
   *
   * `undefined` means a record already exists; it is NOT an exception, because
   * losing this race is an ordinary product outcome with its own sentence.
   * Exclusive at the OS level, not by reading first and writing after.
   */
  reserve(
    machineId: string,
    operationId: string,
    dispatchedAt: string,
    account?: string,
  ): Promise<LiveSupervisorUpdateNote | undefined>;
  /**
   * Remove ONLY the record for this exact operation identity.
   *
   * The Machine ID alone was the whole key, so a late answer from an earlier
   * dispatch removed whatever happened to be filed — including a newer
   * process's outstanding intent, which then admitted a third dispatch.
   * Measured. The operation identity is what distinguishes them now, and it is
   * the producer's key as well as this computer's; anything else under the name
   * belongs to someone else.
   */
  settle(machineId: string, operationId: string): Promise<LiveSupervisorUpdateSettlement>;
  /**
   * Unconditional removal.
   *
   * The ONLY caller allowed to reach this with a readable record is one holding
   * an authoritative answer that the operation settled, or one clearing bytes
   * that carry no identity to read. It is never a completion path — that is
   * `settle` — and it is never a person's opinion about a Machine: with a
   * durable operation identity, "I am done with this record" would discard the
   * one handle that could still resolve it. `commands.ts` gates it.
   */
  discard(machineId: string): Promise<boolean>;
  read(machineId: string): Promise<LiveSupervisorUpdateReading>;
}

export function liveSupervisorUpdateNotes(
  platform: PlatformAdapter,
  scope: LiveSupervisorUpdateScope,
): LiveSupervisorUpdateNotes {
  const digest = scopeDigest(scope);
  const file = (machineId: string): string =>
    join(platform.paths.stateDirectory, DIRECTORY, digest, `${assertMachineId(machineId)}.json`);
  // An adapter without the exclusive primitive cannot fence this mutation, and
  // silently falling back to read-then-write is exactly the defect. Refuse to
  // build the store at all rather than build one that cannot keep its promise.
  if (typeof platform.createExclusiveConfig !== "function") {
    throw new Error("This host cannot reserve a supervisor update exclusively. Nothing was sent.");
  }
  const notes: LiveSupervisorUpdateNotes = {
    async reserve(machineId, operationId, dispatchedAt, account) {
      if (!Number.isFinite(Date.parse(dispatchedAt))) throw new Error("Invalid dispatch timestamp.");
      const value: LiveSupervisorUpdateNote = Object.freeze({
        version: 2, scope: digest, machineId: assertMachineId(machineId),
        operationId: assertCanonicalUuid(operationId, "supervisor update operation ID"),
        dispatchedAt,
        // Recorded only when the caller already held it. Nothing is fetched to
        // populate a label, and nothing reads it back to decide.
        ...(account === undefined ? {} : { account: assertCanonicalUuid(account, "account ID") }),
      });
      const path = file(machineId);
      const text = `${JSON.stringify(value)}\n`;
      // THE fence. One `open(O_CREAT|O_EXCL)` on the target, resolved by the
      // kernel, so two processes interleaved in any order produce one winner.
      // There is no read before it: a read that finds the slot free proves
      // nothing about the instant of the write.
      const created = await platform.createExclusiveConfig(path, text, MAXIMUM_BYTES);
      if (!created) return undefined;
      // Kept from the original: the slot is ours, and these are the bytes that
      // have to be in it. A file we created but cannot read back is a record
      // this computer does not really hold.
      const saved = await platform.readSafeConfig(path, MAXIMUM_BYTES);
      if (!saved.exists || saved.text !== text) {
        /* The message said "Nothing was sent" and left the file behind, so the
           next invocation found a readable record naming an operation that had
           never reached the producer — unresumable, and unclearable for as long
           as the read of it answered not-found.
           Withdrawn through `settle`, which is bound to THIS identity: if the
           bytes now belong to another writer, `settle` answers `superseded` and
           leaves them alone. A blind `discard` here would delete a concurrent
           process's live reservation, which is the same class of defect one
           layer down. Either way the refusal below is still raised. */
        try { await notes.settle(machineId, value.operationId); } catch { /* the throw below is the answer */ }
        throw new Error("The supervisor update record could not be verified. Nothing was sent.");
      }
      return value;
    },
    async settle(machineId, operationId) {
      const current = await notes.read(machineId);
      if (current.state === "none") return "absent";
      // Unreadable bytes are not this dispatch's record. Removing them here
      // would let a completion silently clear a state only an authoritative
      // read may resolve.
      if (current.state === "unreadable") return "superseded";
      if (current.note.operationId !== operationId) return "superseded";
      return (await notes.discard(machineId)) ? "settled" : "absent";
    },
    async discard(machineId) {
      const path = file(machineId);
      try {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          throw new Error("Unsafe supervisor update record.");
        }
        await unlink(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async read(machineId) {
      const path = file(machineId);
      // Every failure below answers `unreadable` instead of throwing, including
      // a refusal from `readSafeConfig` itself: the acknowledgement path must
      // stay reachable for a record whose bytes or permissions are wrong, and
      // `discard` unlinks without needing to read.
      const unreadable = (reason: string): LiveSupervisorUpdateReading =>
        Object.freeze({ state: "unreadable" as const, path, reason });
      let snapshot: SafeFileSnapshot;
      try { snapshot = await platform.readSafeConfig(path, MAXIMUM_BYTES); }
      catch (error) { return unreadable(boundedReason(error)); }
      if (!snapshot.exists) return Object.freeze({ state: "none" as const });
      let value: unknown;
      try { value = JSON.parse(snapshot.text ?? ""); }
      catch { return unreadable("the record is not JSON"); }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return unreadable("the record is not an object");
      }
      const row = value as Record<string, unknown>;
      const dispatchedAt = row.dispatchedAt;
      const operationId = row.operationId;
      const account = row.account;
      const keys = Object.keys(row).sort().join(",");
      if ((keys !== NOTE_KEYS && keys !== NOTE_KEYS_WITH_ACCOUNT) || row.version !== 2 ||
          row.scope !== digest || row.machineId !== machineId ||
          typeof operationId !== "string" || !CANONICAL_UUID.test(operationId) ||
          typeof dispatchedAt !== "string" || !Number.isFinite(Date.parse(dispatchedAt)) ||
          (keys === NOTE_KEYS_WITH_ACCOUNT && typeof account !== "string")) {
        return unreadable("the record does not match the shape this build writes");
      }
      // The account is returned for display and nothing else. It is NOT compared
      // against the caller: a note that named a different account and let the
      // mutation through would be metadata granting access, and the whole point
      // of this record is that it can only ever refuse.
      const note: LiveSupervisorUpdateNote = Object.freeze({
        version: 2, scope: digest, machineId, operationId, dispatchedAt,
        ...(typeof account === "string" ? { account } : {}),
      });
      return Object.freeze({ state: "outstanding" as const, note });
    },
  };
  return Object.freeze(notes);
}
