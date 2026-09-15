import type { AgentSession, AgentSessionProcessObservation } from "../api/contracts.js";

const MAX_FUTURE_SKEW_MS = 5_000;

/**
 * Whether a supervisor ESTABLISHED this row's process state for its CURRENT
 * epoch, folding "the field is absent" into the one answer it is.
 *
 * Absence is `unknown`, not `observed`. A deployment older than the release that
 * began recording provenance sends no field at all, and the producer's own
 * description of `unknown` already covers exactly that case: "every observation
 * older than the release that began recording it". Defaulting the other way is
 * the single mistake this field exists to make impossible, so the fold happens
 * once, here, and no renderer is left to decide it.
 */
export function agentSessionProcessObservation(
  session: AgentSession,
): AgentSessionProcessObservation {
  return session.processObservation ?? "unknown";
}

/**
 * The words a human surface puts beside a state whose provenance is not
 * `observed`, defined once so the session list, the Machine tree and the
 * explorer cannot drift into three vocabularies for one producer field.
 *
 * `observed` has no word on purpose. It is what an unqualified "running"
 * already means, and a qualifier on every healthy row is noise that teaches a
 * reader to skip the two that matter.
 *
 * The other two are kept apart rather than folded into one "unverified",
 * because the producer distinguishes them and the causes differ: `unproven` is
 * a supervisor that settled a runtime-lease renewal without being able to
 * observe the child, and `unknown` is no provenance recorded for this epoch at
 * all — including every row from a deployment older than the release that
 * began recording it. Neither says the process is stale, and neither may be
 * rendered as a termination.
 */
export const AGENT_SESSION_OBSERVATION_NOTE: Readonly<
  Record<AgentSessionProcessObservation, string | undefined>
> = Object.freeze({
  observed: undefined,
  unproven: "not observed",
  unknown: "observation unknown",
});

/**
 * A still-running process is not an active session once termination has been
 * requested. The machine overview is an operational view, not session history.
 */
export function isAgentSessionIntendedActive(session: AgentSession): boolean {
  return session.desiredState === "running" && session.requestState !== "termination_pending";
}

/**
 * What an AgentSession row supports about its runtime, as two separate facts.
 *
 * WHY THIS REPLACED `isAgentSessionRunningNow`. That predicate answered one
 * boolean named "running now" from `process_state === "running"` plus
 * `runtime_expires_at > now`, and it placed no bound at all on how old
 * `runtime_observed_at` was. Those are two different things:
 *
 *   `runtime_observed_at`  a PAST fact — when the producer last observed this
 *                          process. It can only ever say "was", never "is".
 *   `runtime_expires_at`   a WINDOW — how long the runtime lease the supervisor
 *                          renews remains valid. A renewal moves this forward
 *                          and says nothing about the process.
 *
 * A lease renewal that carries no fresh observation therefore kept the old
 * predicate answering `true` from an observation of any age, which is the exact
 * shape of "the row asserts running while nothing observed it".
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It invents no freshness threshold. There
 * is no interval after which this module declares an observation stale, because
 * no producer contract publishes one and a number chosen here would be a
 * fabricated liveness claim wearing a constant's clothes. The observation's age
 * is REPORTED so a caller can show it or decide with it; it is never compared
 * against anything.
 *
 * It also grants nothing. Attachment, control and observation authority stay
 * exactly where they are — with the server's capability snapshot and the
 * terminal grant — and no reading here substitutes for either.
 */
export type AgentSessionRuntimeEvidence =
  /** Termination is intended or requested; the runtime fields do not matter. */
  | "not_intended_active"
  /** The producer does not report this process as running or ready. */
  | "not_reported_running"
  /** One of the two runtime timestamps is absent. */
  | "evidence_missing"
  /** A timestamp does not parse, is in the future, or the window is inverted. */
  | "evidence_invalid"
  /** Last observed running, and the runtime lease has since lapsed. */
  | "observed_running_lease_expired"
  /**
   * The row reports running, and the producer says nobody established that for
   * this process epoch: a lease renewal settled without observing the child, or
   * no provenance is recorded at all.
   *
   * It is deliberately its own value rather than a qualifier on the two
   * `observed_*` ones. The word "observed" is a claim, and the whole reason the
   * producer publishes `process_observation` is that a moving lease was making
   * that claim on nobody's behalf. The lease is still reported in
   * `leaseCurrent`, because it is still true — it is just not this.
   */
  | "reported_running_observation_unproven"
  /**
   * The strongest thing an AgentSession row can support: a supervisor observed
   * it running at `lastObservedAt` for this epoch, and the lease covering it is
   * still open. It is NOT a statement that the process is alive at `now`.
   */
  | "observed_running_lease_current";

export interface AgentSessionRuntimeReading {
  readonly evidence: AgentSessionRuntimeEvidence;
  /** The producer's own timestamp, forwarded verbatim. Absent when unusable. */
  readonly lastObservedAt?: string;
  /** How old that observation is at `now`. Reported; never thresholded here. */
  readonly observationAgeMs?: number;
  readonly leaseExpiresAt?: string;
  /** The lease window alone. True says nothing about the process. */
  readonly leaseCurrent: boolean;
  /**
   * The producer's provenance for `processState`, with absence folded into
   * `unknown`. Carried on every reading so a caller can never get a lease
   * without also getting the answer to "did anybody look?".
   */
  readonly processObservation: AgentSessionProcessObservation;
}

/**
 * The two runtime timestamps, parsed once.
 *
 * `session-actionability.ts` used to parse the same pair with the same skew
 * constant a few lines away from the copy here, and the two could drift into
 * disagreeing about one row. There is one parser now, and it never decides what
 * the pair MEANS — only what it says.
 */
export type RuntimeWindowKind = "missing" | "invalid" | "lease_current" | "lease_expired";

export interface RuntimeWindow {
  readonly kind: RuntimeWindowKind;
  readonly lastObservedAt?: string;
  readonly observationAgeMs?: number;
  readonly leaseExpiresAt?: string;
}

export function readRuntimeWindow(session: AgentSession, now: number): RuntimeWindow {
  if (session.runtimeObservedAt === undefined || session.runtimeExpiresAt === undefined) {
    return Object.freeze({ kind: "missing" as const });
  }
  const observedAt = Date.parse(session.runtimeObservedAt);
  const expiresAt = Date.parse(session.runtimeExpiresAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt) ||
      observedAt > now + MAX_FUTURE_SKEW_MS || expiresAt <= observedAt) {
    return Object.freeze({ kind: "invalid" as const });
  }
  const kind: RuntimeWindowKind = expiresAt > now ? "lease_current" : "lease_expired";
  return Object.freeze({
    kind,
    lastObservedAt: session.runtimeObservedAt,
    observationAgeMs: now - observedAt,
    leaseExpiresAt: session.runtimeExpiresAt,
  });
}

function reading(
  evidence: AgentSessionRuntimeEvidence,
  processObservation: AgentSessionProcessObservation,
  extra: Omit<AgentSessionRuntimeReading, "evidence" | "processObservation"> = { leaseCurrent: false },
): AgentSessionRuntimeReading {
  return Object.freeze({ evidence, processObservation, ...extra });
}

export function readAgentSessionRuntime(session: AgentSession, now: number): AgentSessionRuntimeReading {
  const observation = agentSessionProcessObservation(session);
  if (!isAgentSessionIntendedActive(session)) return reading("not_intended_active", observation);
  if (session.processState !== "running") return reading("not_reported_running", observation);
  const runtimeWindow = readRuntimeWindow(session, now);
  if (runtimeWindow.kind === "missing") return reading("evidence_missing", observation);
  if (runtimeWindow.kind === "invalid") return reading("evidence_invalid", observation);
  const leaseCurrent = runtimeWindow.kind === "lease_current";
  const window = {
    ...(runtimeWindow.lastObservedAt === undefined ? {} : { lastObservedAt: runtimeWindow.lastObservedAt }),
    ...(runtimeWindow.observationAgeMs === undefined ? {} : { observationAgeMs: runtimeWindow.observationAgeMs }),
    ...(runtimeWindow.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: runtimeWindow.leaseExpiresAt }),
    leaseCurrent,
  };
  // The ordering that answers the requirement: a current lease is checked AFTER
  // provenance, never instead of it. `unproven` with an open lease is the exact
  // row this field was published for -- the lease moved and nothing observed the
  // child -- and it must not render as a fresh observation.
  if (observation !== "observed") {
    return reading("reported_running_observation_unproven", observation, window);
  }
  return reading(
    leaseCurrent ? "observed_running_lease_current" : "observed_running_lease_expired",
    observation,
    window,
  );
}

/**
 * The last thing a supervisor OBSERVED about the process, with no lease in it.
 *
 * Past tense in the name because it is past tense in the data: a caller that
 * wants to say something about `now` needs more than this row. It is false when
 * the producer says nobody established the state for this epoch, because then
 * there is no observation to be past tense about.
 */
export function wasAgentSessionObservedRunning(session: AgentSession, now: number): boolean {
  const value = readAgentSessionRuntime(session, now).evidence;
  return value === "observed_running_lease_current" || value === "observed_running_lease_expired";
}

/** The runtime lease window alone. A renewal moves this and nothing else. */
export function hasCurrentAgentSessionRuntimeLease(session: AgentSession, now: number): boolean {
  return readAgentSessionRuntime(session, now).leaseCurrent;
}
