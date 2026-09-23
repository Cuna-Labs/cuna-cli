import { observationBudgetElapsed } from "../core/observation-budget.js";
import {
  ACCOUNT_IDENTITY_DEADLINE_MS,
  reissueIdempotentRead,
  startJourneyDeadline,
  type JourneyWaitReporter,
} from "./wait-policy.js";

/**
 * THE FIRST READ OF EVERY JOURNEY, PUT UNDER THE SAME POLICY AS THE REST OF IT.
 *
 * WHY THIS IS ITS OWN MODULE. `cli/run.ts` reads the account before it chooses
 * which effects to build, because the principal and the workspace are half of
 * the machine-create request identity — so this read sits OUTSIDE
 * `journey/api-effects.ts` and outside `journey/remote-workspace.ts`, the two
 * places the re-issue policy already reached. It therefore kept the exact defect
 * both of those closed, and kept it on the one read that gates everything else.
 *
 * MEASURED, AFTER THE FIRST REPAIR WAS BUILT
 * (`prds/cuna-cli-latency-before-20260922.md` § 8.3). Run `a5` exited 5 at
 * 21 454 ms with `cuna.client.response_budget_elapsed` on `GET /v1/me`,
 * `budget_ms: 15000`; the deliberate control `slow1` reproduced the same code on
 * the same path at 5 147 ms with `--timeout-ms 800`. In both runs the journey
 * behind that read had 180 000 ms of its own that it never reached.
 *
 * WHAT IT IS SAFE TO DO HERE, EXACTLY. `GET /v1/me` is a read: re-issuing it
 * commits nothing, observes nothing twice and cannot duplicate an effect. Only
 * the CLI's own `response` budget is absorbed — a refusal Cuna actually sent, a
 * transport failure or a Ctrl-C is an answer and propagates on the first
 * occurrence, because `reissueIdempotentRead` is the one place that decides
 * that and this module does not widen it.
 */

/**
 * The noun phrase this read puts on screen, completing "Still waiting for ___":
 * `Still waiting for your account · 15s of 45s`.
 *
 * It names the ACCOUNT rather than the route, because a person reading the row
 * is waiting to be recognised, not waiting for `GET /v1/me`.
 */
export const ACCOUNT_IDENTITY_WAITING_FOR = "your account";

export interface AccountIdentityReadInput<T> {
  /** MUST be `GET /v1/me` or another read with no effect; it may be dispatched again. */
  readonly read: () => Promise<T>;
  readonly signal: AbortSignal;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly now: () => number;
  /** Where the declared wait goes on screen; see `journey/wait-policy.ts`. */
  readonly onWait?: JourneyWaitReporter;
}

/**
 * Read the signed-in account, absorbing a response-budget refusal for as long as
 * `ACCOUNT_IDENTITY_DEADLINE_MS` has not elapsed.
 *
 * THE BOUND THIS GIVES, STATED EXACTLY. The deadline is checked when a read
 * fails, before the `REISSUE_PAUSE_MS` pause that precedes the next dispatch, so
 * the command overshoots it by at most one request budget plus that one pause.
 * When it does elapse, the refusal is still
 * `cuna.client.response_budget_elapsed`: the CLI stopped waiting, Cuna did not
 * fail, and `cuna whoami` is the read-only command that settles it.
 */
export async function readAccountIdentityWithin<T>(input: AccountIdentityReadInput<T>): Promise<T> {
  const deadline = startJourneyDeadline(ACCOUNT_IDENTITY_DEADLINE_MS, input.now);
  return await reissueIdempotentRead({
    waitingFor: ACCOUNT_IDENTITY_WAITING_FOR,
    read: input.read,
    deadline,
    signal: input.signal,
    sleep: input.sleep,
    ...(input.onWait === undefined ? {} : { onWait: input.onWait }),
    deadlineFailure: (elapsed) => observationBudgetElapsed({
      kind: "response",
      operation: "GET /v1/me",
      settleWith: "cuna whoami",
      budgetMs: elapsed.deadlineMs,
      details: {
        waiting_for: elapsed.waitingFor,
        elapsed_ms: elapsed.elapsedMs,
        read_reissues: elapsed.readReissues,
      },
      ...(elapsed.cause === undefined ? {} : { cause: elapsed.cause }),
    }),
  });
}
