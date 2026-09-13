import { createHash } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { SupervisorLiveUpdate, SupervisorLiveUpdateOutcome } from "../api/supervisor-live-update.js";
import { CunaError } from "../core/errors.js";
import { isObservationBudgetCode } from "../core/observation-budget.js";
import { assertCanonicalUuid, assertMachineId } from "../core/validation.js";
import type { PlatformAdapter, SafeFileSnapshot } from "../platform/adapter.js";

/* -------------------------------------------------------------------------- */
/* What the producer's refusals mean for the Machine                          */
/* -------------------------------------------------------------------------- */

/**
 * Every reason code `live-supervisor-update.ts` can answer with, grouped by the
 * only question the caller has to act on: could this Machine have changed?
 *
 * The grouping is the producer's, not a guess. Its operation sets one `spent`
 * flag immediately before the installer call and classifies every escape from
 * that point as `supervisor_live_update_pending`; everything ordered before it
 * carries a reason whose own detail says the Machine is unchanged.
 */
const UNCHANGED_REASONS: ReadonlySet<string> = new Set([
  // 422: the request never named a Machine.
  "invalid_supervisor_upgrade_request",
  // 404/409: refused after a read, before any enrollment, installer or control change.
  "resource_not_found",
  "supervisor_live_update_machine_not_running",
  "supervisor_live_update_runtime_unavailable",
  "supervisor_live_update_control_unavailable",
  "supervisor_live_update_preconditions_unmet",
  "supervisor_live_update_not_required",
  // 503, and the one 503 that is explicitly "nothing was changed; try again".
  "supervisor_live_update_unverifiable",
]);

/** The update landed, was acknowledged, and named AgentSessions that did not survive. */
const SESSIONS_ENDED_REASON = "supervisor_live_update_sessions_ended";

/**
 * The producer's single word for "this operation may or may not have applied".
 *
 * Several of its sites set `retryable: true` on the Problem, and the transport
 * faithfully carries that through as a retryable network condition. That flag is
 * about re-READING, and every one of those details ends with "do not repeat the
 * update". This CLI therefore never lets the flag reach a retry decision for
 * this mutation.
 */
const PENDING_REASON = "supervisor_live_update_pending";

export type LiveSupervisorUpdateDisposition =
  /** No enrollment, installer or control change was sent. */
  | "unchanged"
  /** Installed and acknowledged; named AgentSessions did not survive it. */
  | "applied_with_ended_sessions"
  /** It may or may not have applied. Not retryable, not a failure, not a success. */
  | "unknown";

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
 * supervisor may already have been replaced.
 */
export function classifyLiveSupervisorUpdateFailure(error: unknown): LiveSupervisorUpdateDisposition {
  const reason = reasonOf(error);
  if (reason !== undefined && UNCHANGED_REASONS.has(reason)) return "unchanged";
  if (reason === SESSIONS_ENDED_REASON) return "applied_with_ended_sessions";
  if (reason === PENDING_REASON) return "unknown";
  if (error instanceof CunaError) {
    // The CLI stopped waiting for its own response. The request is still in
    // flight as far as this process knows.
    if (isObservationBudgetCode(error.code)) return "unknown";
    // Refusals this CLI raised itself, before anything left the process.
    if (
      error.code === "cuna.usage.invalid" ||
      error.code === "cuna.confirmation.required" ||
      error.code.startsWith("cuna.capability.")
    ) return "unchanged";
    // A credential the server refused outright never reached the operation.
    if (error.code === "cuna.auth.rejected" || error.code === "cuna.policy.denied") return "unchanged";
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
/* The durable local note                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One local note per Machine whose in-place update this installation dispatched
 * and never saw settle.
 *
 * Modelled on `machines/execution-receipt.ts`: written BEFORE the request leaves,
 * dropped only when an authoritative answer arrives, and never permission to
 * replay. It exists for exactly one requirement — a FRESH invocation must not
 * silently repeat a mutation whose outcome is still outstanding — and the
 * producer gives this operation no durable operation identity of its own (no
 * request body, no idempotency key), so the Machine ID is the whole narrow
 * resource identity available.
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
  readonly version: 1;
  readonly scope: string;
  readonly machineId: string;
  readonly dispatchedAt: string;
  /** Label only. Never part of the key, never consulted to admit a mutation. */
  readonly account?: string;
}

const MAXIMUM_BYTES = 2048;
const NOTE_KEYS = "dispatchedAt,machineId,scope,version";
const NOTE_KEYS_WITH_ACCOUNT = "account,dispatchedAt,machineId,scope,version";
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
  reserve(machineId: string, dispatchedAt: string, account?: string): Promise<LiveSupervisorUpdateNote | undefined>;
  /**
   * Remove ONLY the record this exact dispatch created.
   *
   * The Machine ID alone was the whole key, so a late answer from an earlier
   * dispatch removed whatever happened to be filed — including a newer
   * process's outstanding intent, which then admitted a third dispatch.
   * Measured. `dispatchedAt` is this operation's identity here; anything else
   * under the name belongs to someone else.
   */
  settle(machineId: string, dispatchedAt: string): Promise<LiveSupervisorUpdateSettlement>;
  /**
   * Unconditional removal, for the one caller that is a person saying "I have
   * looked, and I am done with this record". Never called on a completion path:
   * that is what `settle` is for, and the difference is the whole of UR1-B.
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
    async reserve(machineId, dispatchedAt, account) {
      if (!Number.isFinite(Date.parse(dispatchedAt))) throw new Error("Invalid dispatch timestamp.");
      const value: LiveSupervisorUpdateNote = Object.freeze({
        version: 1, scope: digest, machineId: assertMachineId(machineId), dispatchedAt,
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
        throw new Error("The supervisor update record could not be verified. Nothing was sent.");
      }
      return value;
    },
    async settle(machineId, dispatchedAt) {
      const current = await notes.read(machineId);
      if (current.state === "none") return "absent";
      // Unreadable bytes are not this dispatch's record. Removing them here
      // would let a completion silently clear a state only a person should.
      if (current.state === "unreadable") return "superseded";
      if (current.note.dispatchedAt !== dispatchedAt) return "superseded";
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
      const account = row.account;
      const keys = Object.keys(row).sort().join(",");
      if ((keys !== NOTE_KEYS && keys !== NOTE_KEYS_WITH_ACCOUNT) || row.version !== 1 ||
          row.scope !== digest || row.machineId !== machineId ||
          typeof dispatchedAt !== "string" || !Number.isFinite(Date.parse(dispatchedAt)) ||
          (keys === NOTE_KEYS_WITH_ACCOUNT && typeof account !== "string")) {
        return unreadable("the record does not match the shape this build writes");
      }
      // The account is returned for display and nothing else. It is NOT compared
      // against the caller: a note that named a different account and let the
      // mutation through would be metadata granting access, and the whole point
      // of this record is that it can only ever refuse.
      const note: LiveSupervisorUpdateNote = Object.freeze({
        version: 1, scope: digest, machineId, dispatchedAt,
        ...(typeof account === "string" ? { account } : {}),
      });
      return Object.freeze({ state: "outstanding" as const, note });
    },
  };
  return Object.freeze(notes);
}
