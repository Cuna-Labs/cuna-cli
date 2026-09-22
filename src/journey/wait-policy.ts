import { OBSERVATION_BUDGET_CODES } from "../core/observation-budget.js";
import { CunaError } from "../core/errors.js";

/**
 * THE ONE PLACE THAT DECIDES HOW LONG A JOURNEY PHASE WAITS, AND WHAT THE
 * SCREEN SAYS WHILE IT DOES.
 *
 * WHY THIS FILE EXISTS. Measured 2026-09-22 against `@cuna_labs/cli` 0.1.1
 * (build bb18869345927ad8…) and edge contract b25188d361c55558… on Machine
 * `rexbit-claude-qa4`, recorded in `prds/cuna-cli-latency-before-20260922.md`:
 *
 *  1. § 2 / § 4, run `cold1`. One `GET /v1/agent-sessions/<id>` exceeded the
 *     CLI's own 15 000 ms per-request budget and the WHOLE journey aborted at
 *     t=83 043 ms with `cuna.client.response_budget_elapsed` and
 *     `remote_outcome: unobserved` — against a route whose warm floor is 106 ms
 *     (§ 1), for an AgentSession that was healthy and still `process_state
 *     running` fifteen minutes later. One slow read of an IDEMPOTENT resource
 *     ended a journey that had plenty of its own time left.
 *  2. § 3, finding 2. The longest stall was 61 259 ms on one unchanging
 *     sentence, `Starting Claude Code · still working — Ctrl-C cancels`, while
 *     this exact poll loop ran. Bytes kept flowing (the spinner repaints every
 *     90 ms) and information did not, so a byte-level liveness test passes and
 *     misses the entire defect.
 *  3. § 3, finding 3. The only escalation the CLI had was appending
 *     `· still working`. It never named WHAT it waited for, never showed
 *     elapsed time, and never named the deadline it was about to enforce — so
 *     the budget expiry arrived with no warning at all.
 *
 * SO THIS MODULE SEPARATES TWO BOUNDS THAT WERE ONE. The per-request budget in
 * `core/observation-budget.ts` answers "how long do I wait for ONE response
 * before I stop believing this connection". The deadline here answers "how long
 * is this PHASE of the journey worth". Collapsing them made the first the
 * second, which is why a single slow read could end everything.
 *
 * WHAT IT DOES NOT CHANGE. A non-idempotent step keeps today's behaviour
 * exactly: a create, a transition or a reconcile whose response was not
 * observed is still an unknown outcome, and this module never re-issues one.
 * `reissueIdempotentRead` is named for the only thing it is correct for.
 */

/* -------------------------------------------------------------------------- */
/* Deadlines                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The backoff both readiness loops sleep on, kept exactly as measured.
 *
 * `min(2000, 100 * 2 ** min(attempt, 4))` looks like it climbs to 2 000 ms and
 * does not: the exponent is capped at 4, so the value is 100, 200, 400, 800 and
 * then 1 600 ms forever. The 2 000 ceiling is unreachable. Stated here because
 * every deadline below is derived from this curve, and deriving one from the
 * ceiling the expression appears to have overstates the old reach by 25%.
 */
export function readinessBackoffMs(attempt: number): number {
  return Math.min(2_000, 100 * 2 ** Math.min(attempt, 4));
}

/**
 * The wall time a loop of `attempts` iterations spends sleeping on that curve.
 * Exported so the deadlines below can be checked rather than believed.
 */
export function readinessBackoffTotalMs(attempts: number): number {
  let total = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) total += readinessBackoffMs(attempt);
  return total;
}

/**
 * How long `ready-agent-session` is worth before the CLI stops waiting.
 *
 * DERIVATION, from what the code already spent rather than from a new opinion.
 * The loop this replaces was bounded by 90 attempts on the curve above, which
 * is `readinessBackoffTotalMs(90)` = 139 100 ms of sleeping PLUS every read's
 * own time — measured median 2 744 ms for this route's command and up to
 * 15 000 ms when a read burns its whole budget
 * (`prds/cuna-cli-latency-before-20260922.md` § 1b), so the old wall reach was
 * already well above 139 s and was never a number anyone could state.
 *
 * 180 000 ms is that sleeping budget rounded up to three minutes. It is
 * deliberately a WALL bound rather than a count of attempts: an attempt count
 * cannot be rendered on a screen or promised to a person, which is exactly how
 * the measured 61 s dwell and the 83 s abort both happened inside it without
 * ever being named. The extra ~41 s over the old sleeping budget is the room
 * the re-issue policy needs to absorb a budget refusal or two inside the same
 * phase instead of ending the journey.
 */
export const AGENT_SESSION_READY_DEADLINE_MS = 180_000;

/**
 * How long `ready-machine` is worth. Same derivation from the loop it replaces:
 * 60 attempts on the same curve is `readinessBackoffTotalMs(60)` = 91 100 ms of
 * sleeping. 120 000 ms is that rounded up to two minutes. Deliberately lower
 * than the AgentSession deadline: starting an existing VM is not provisioning
 * one, and the machine-create budget that DOES provision one is declared
 * separately in `core/observation-budget.ts`.
 */
export const MACHINE_READY_DEADLINE_MS = 120_000;

/**
 * How long the CLI pauses before re-issuing a read whose response budget
 * elapsed.
 *
 * DERIVATION. The read that just failed already spent `DEFAULT_REQUEST_BUDGET_MS`
 * (15 000 ms), so a long pause on top of it would be waiting twice for the same
 * answer. The measured warm floor for a complete HTTPS exchange on this exact
 * route is 106 ms (`prds/cuna-cli-latency-before-20260922.md` § 1), so 250 ms is
 * roughly two floors — enough that a re-issue is a new attempt rather than a
 * hot loop, and under 2% of what the failed attempt already cost.
 */
export const REISSUE_PAUSE_MS = 250;

export interface JourneyDeadline {
  /** The declared bound, in milliseconds, for rendering and for diagnostics. */
  readonly deadlineMs: number;
  elapsedMs(): number;
  remainingMs(): number;
  /** True once no further read may be DISPATCHED. */
  elapsed(): boolean;
}

/**
 * Start the clock for one journey phase.
 *
 * THE BOUND THIS GIVES, STATED EXACTLY. `elapsed()` gates DISPATCH: a read
 * already in flight when the deadline passes is awaited rather than discarded,
 * because throwing away an answer that arrived is strictly worse than being
 * late, and the caller reports the real `elapsed_ms` either way. So the worst
 * case for the phase is `deadlineMs` plus at most one request budget
 * (`DEFAULT_REQUEST_BUDGET_MS`), and never unbounded.
 */
export function startJourneyDeadline(deadlineMs: number, now: () => number): JourneyDeadline {
  if (!Number.isFinite(deadlineMs) || deadlineMs < 0) {
    throw new TypeError("A journey deadline must be a non-negative number of milliseconds.");
  }
  const startedAt = now();
  const elapsedMs = (): number => Math.max(0, now() - startedAt);
  return Object.freeze({
    deadlineMs,
    elapsedMs,
    remainingMs: (): number => Math.max(0, deadlineMs - elapsedMs()),
    elapsed: (): boolean => elapsedMs() >= deadlineMs,
  });
}

/* -------------------------------------------------------------------------- */
/* What the screen says while it waits                                        */
/* -------------------------------------------------------------------------- */

export interface JourneyWait {
  /**
   * A noun phrase naming what has not answered yet, e.g. `the machine's
   * terminal supervisor to register`. It completes the sentence "Still waiting
   * for ___", so it never repeats the verb and never names a transport path.
   */
  readonly waitingFor: string;
  readonly elapsedMs: number;
  readonly deadlineMs: number;
}

export type JourneyWaitReporter = (wait: JourneyWait) => void;

function wholeSeconds(milliseconds: number): number {
  // Floor, not round: a line that says 24s when 23.6s have passed claims time
  // that has not elapsed, on the one number a person uses to judge a stall.
  return Math.max(0, Math.floor(milliseconds / 1_000));
}

/**
 * The wait, as one line. Elapsed is NOT clamped to the deadline: a read still
 * in flight past it truthfully reads `181s of 180s`, and hiding that would hide
 * exactly the overshoot `startJourneyDeadline` documents.
 */
export function journeyWaitLine(wait: JourneyWait): string {
  return `Still waiting for ${wait.waitingFor} · ${wholeSeconds(wait.elapsedMs)}s of ${wholeSeconds(wait.deadlineMs)}s`;
}

/* -------------------------------------------------------------------------- */
/* The re-issue rule                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Did the CLI's own per-request budget elapse, as opposed to anything the
 * remote actually answered?
 *
 * Deliberately narrower than `isObservationBudgetCode`, which also covers
 * `convergence`. A convergence budget elapses AFTER an accepted mutation, and
 * re-issuing there would be a blind retry of an effect — the exact thing this
 * repository refuses. Only the `response` kind of a read is re-issuable.
 */
export function isResponseBudgetElapsed(error: unknown): error is CunaError {
  return error instanceof CunaError && error.code === OBSERVATION_BUDGET_CODES.response;
}

export interface JourneyDeadlineElapsed {
  readonly waitingFor: string;
  readonly elapsedMs: number;
  readonly deadlineMs: number;
  /**
   * How many times THIS read's response-budget refusal was absorbed and
   * re-issued before the deadline elapsed. It is per-read, not per-phase: a
   * phase that simply ran out of time while polling reports 0, which is what
   * happened — the read that ended it was not re-issued at all.
   */
  readonly readReissues: number;
  /** The last refusal, so the phase's typed failure can carry it as its cause. */
  readonly cause: unknown;
}

export interface IdempotentReadInput<T> {
  readonly waitingFor: string;
  /**
   * MUST be idempotent. This function may dispatch it more than once, and a
   * second dispatch of anything that commits is a blind retry.
   */
  readonly read: () => Promise<T>;
  readonly deadline: JourneyDeadline;
  /**
   * Declared required, read defensively. The journey effects are reachable
   * without a cancellation authority, and the poll loops around this one
   * already spell `signal?.aborted` for the same reason: a missing signal must
   * not become a TypeError on the path that handles a slow network.
   */
  readonly signal: AbortSignal;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly onWait?: JourneyWaitReporter;
  /** The phase's own typed failure, minted only when the deadline has elapsed. */
  readonly deadlineFailure: (elapsed: JourneyDeadlineElapsed) => Error;
}

/**
 * Run one idempotent read, absorbing a response-budget refusal for as long as
 * the phase's deadline has not elapsed.
 *
 * WHAT IS AND IS NOT ABSORBED, because that discriminator is the whole
 * mechanism. A `cuna.client.response_budget_elapsed` says THIS PROCESS stopped
 * listening; the request may well have been answered. For a GET that is a
 * reason to ask again. Everything else — a refusal the remote actually sent, a
 * transport failure, a cancellation by the person at the keyboard — is an
 * answer, and propagates unchanged on the first occurrence.
 */
export async function reissueIdempotentRead<T>(input: IdempotentReadInput<T>): Promise<T> {
  let readReissues = 0;
  for (;;) {
    try {
      return await input.read();
    } catch (error) {
      // A person pressing Ctrl-C outranks every budget: their decision is an
      // answer, and re-issuing against it would ignore it.
      if (input.signal?.aborted === true) throw error;
      if (!isResponseBudgetElapsed(error)) throw error;
      if (input.deadline.elapsed()) {
        throw input.deadlineFailure(Object.freeze({
          waitingFor: input.waitingFor,
          elapsedMs: input.deadline.elapsedMs(),
          deadlineMs: input.deadline.deadlineMs,
          readReissues,
          cause: error,
        }));
      }
      readReissues += 1;
      // Say it before sleeping, not after: the screen is the only place a
      // person can see that the CLI decided to keep waiting rather than stop.
      input.onWait?.(Object.freeze({
        waitingFor: input.waitingFor,
        elapsedMs: input.deadline.elapsedMs(),
        deadlineMs: input.deadline.deadlineMs,
      }));
      await input.sleep(REISSUE_PAUSE_MS, input.signal);
    }
  }
}
