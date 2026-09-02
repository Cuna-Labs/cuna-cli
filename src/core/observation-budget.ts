import { EXIT_CODES, CunaError, type SafeErrorDetails } from "./errors.js";

/**
 * THE ONE PLACE THE CLI IS ALLOWED TO SAY "I STOPPED LOOKING".
 *
 * WHY THIS FILE EXISTS. Measured 2026-08-19 against Fly release v93 from the
 * installed `cuna 0.1.0`: `cuna machines create --yes` returned
 * `cuna.network.timeout` with `retryable: false` while the machine reached
 * `running` about five seconds later, and `cuna machines delete <id> --yes`
 * returned `cuna.remote.postcondition_unverified` with
 * `observed_state: "present"` while `cuna machines list` six seconds later
 * showed the machine gone. Neither detector detected what its code named. The
 * first detected THIS PROCESS'S OWN `setTimeout` firing — the network was fine.
 * The second detected THIS PROCESS reading back once, immediately, before a
 * durable accept could become visible — the postcondition was not unverifiable,
 * it was unwaited.
 *
 * So the rule this file enforces is not "wait longer". Raising a default moves
 * the boundary without naming it and the next slower operation reproduces the
 * bug identically. The rule is: **a refusal caused by the client's own budget
 * is a different KIND of answer from a refusal caused by the operation**, and it
 * gets its own codes, its own retryability and its own sentence.
 *
 * THREE PROPERTIES, AND THEY ARE STRUCTURAL RATHER THAN CONVENTIONAL.
 *
 *  1. `retryable` is written `true` at exactly one site — below. A caller cannot
 *     mint a budget refusal that denies retry, because the field is not a
 *     parameter. `retryable: false` was the worst available answer: it told the
 *     user not to try again AND implied the mutation had not landed, and both
 *     halves were false.
 *  2. The refusal names the read-only command that resolves the unknown. A
 *     refusal that says "unknown" and stops has handed the user a dead end,
 *     which is the specific failure this repository already closed on the
 *     credential path. `settleWith` is optional in the TYPE and never optional
 *     in practice for the commands that mutate: the alternative — a required
 *     field with a default — would put a confidently WRONG command in front of
 *     users of every operation that forgot to declare one, and a false
 *     instruction is worse than a general one. The declarations live beside the
 *     paths in `api/client.ts`, and `test/observation-budget.test.mjs` asserts
 *     the exact command for the two operations this was measured on.
 *  3. The message never asserts the mutation did not apply, and `details`
 *     carries `remote_outcome: "unobserved"` so a machine reader sees the same
 *     limit the human sentence states.
 *
 * WHAT THIS FILE IS NOT. It is not a place for genuine remote failures. A
 * connection that was refused, a TLS error or a DNS failure is a network fault
 * and keeps `cuna.network.failed`, including its fail-closed retryability for
 * mutations: there the network really did fail, and the CLI has no evidence the
 * request was ever dispatched. A read-back that returns a value which CONTRADICTS
 * the write — a rename that observed a different name, a create that observed a
 * different id — is a real postcondition violation that no amount of waiting
 * repairs, and keeps `cuna.remote.postcondition_unverified`. The discriminator
 * is the one this file is named after: did the operation answer wrongly, or did
 * we stop asking?
 */

/* -------------------------------------------------------------------------- */
/* Budgets                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The per-request observation budget when the caller passes no `--timeout-ms`
 * and the operation declares no budget of its own.
 *
 * This used to be the literal `15_000` written twice — once in `cli/run.ts` as
 * the flag default and once in `api/http.ts` as the transport default — which is
 * the one-concept-two-homes shape this repository keeps closing. It is read from
 * here in both places now.
 */
export const DEFAULT_REQUEST_BUDGET_MS = 15_000;

/**
 * `POST /v1/sessions` waits for the provider, so it is not bounded by the same
 * budget as a list.
 *
 * DERIVATION, because a constant without one cannot be confirmed or refuted.
 * Measured 2026-08-19T00:17Z against Fly release v93: the CLI aborted at the
 * 15 s default and the machine reached `state=running` roughly five seconds
 * after a 24 s wall-clock invocation, so the server-side create is at least
 * ~50 s [owner-measured, not re-measured here — re-measuring costs a real
 * machine]. 90 000 ms is that duration with an 80% margin, and it stays inside
 * the documented `--timeout-ms` ceiling of 120 000 so a user can still widen it
 * by hand.
 *
 * This is deliberately NOT the global default. Raising the global default would
 * make every unrelated failure take six times longer to surface.
 */
export const MACHINE_CREATE_REQUEST_BUDGET_MS = 90_000;

/**
 * How long the CLI reads back before it stops judging a postcondition.
 *
 * DERIVATION. Measured 2026-08-19: a deleted machine was still `present` on an
 * immediate read and absent from `cuna machines list` six seconds later. The
 * pre-existing AgentSession termination budget in `commands/commands.ts` was
 * 15 000 ms and was the only convergence budget in the tree. 30 000 ms is the
 * larger of the two doubled, and one constant replaces both so the two cannot
 * drift apart again.
 *
 * Re-measured 2026-09-02 on production: `agent-sessions terminate` was
 * accepted and the row read `exited` about 36 s later, so a 30 s read-back
 * reported a false failure (exit 5) for a termination that completed. The
 * read-back is a cheap poll; 120 s covers a supervisor that has to fence and
 * flush a live PTY without turning a completed operation into an error.
 */
export const REMOTE_CONVERGENCE_BUDGET_MS = 120_000;

/** Interval between read-backs while converging. */
export const REMOTE_CONVERGENCE_POLL_INTERVAL_MS = 500;

/* -------------------------------------------------------------------------- */
/* The authority                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every error code the CLI can mint because ITS OWN budget elapsed.
 *
 * This record is the authority. Consumers that need to ask "is this refusal one
 * of ours?" — the workspace sync retry policy, the journey's uncertain-dispatch
 * recovery — read `isObservationBudgetCode` rather than comparing literals, so
 * adding a third kind cannot leave a consumer behind.
 *
 * `test/observation-budget.test.mjs` holds a hand-written floor of these exact
 * strings in both directions, so neither deleting an entry nor adding one
 * silently is possible. A test parametrized over this record alone would narrow
 * along with it.
 */
export const OBSERVATION_BUDGET_CODES = Object.freeze({
  /** The CLI stopped waiting for a single HTTP response. */
  response: "cuna.client.response_budget_elapsed",
  /** The CLI stopped reading back before an accepted change became visible. */
  convergence: "cuna.client.convergence_budget_elapsed",
} as const);

export type ObservationBudgetKind = keyof typeof OBSERVATION_BUDGET_CODES;

const OBSERVATION_BUDGET_CODE_SET: ReadonlySet<string> = new Set(
  Object.values(OBSERVATION_BUDGET_CODES),
);

export function isObservationBudgetCode(code: string): boolean {
  return OBSERVATION_BUDGET_CODE_SET.has(code);
}

/* -------------------------------------------------------------------------- */
/* The mint                                                                   */
/* -------------------------------------------------------------------------- */

export interface ObservationBudgetElapsedInput {
  readonly kind: ObservationBudgetKind;
  /** What was being observed, e.g. `machine deletion` or `POST /v1/sessions`. */
  readonly operation: string;
  /** The read-only command that settles the question, e.g. `cuna machines list`. */
  readonly settleWith?: string;
  /** The budget that elapsed, in milliseconds. */
  readonly budgetMs: number;
  readonly details?: SafeErrorDetails;
  readonly cause?: unknown;
}

/**
 * Mint the refusal that says "the CLI stopped observing", and nothing stronger.
 *
 * The exit code is `network` (5), whose published meaning is already "no
 * authoritative answer arrived", which is exactly this. It is deliberately NOT
 * `conflict` (6): `conflict` means current state contradicts the change and
 * repeating it unchanged repeats the answer, and telling a script that about an
 * operation which probably succeeded is worse than saying nothing.
 */
export function observationBudgetElapsed(input: ObservationBudgetElapsedInput): CunaError {
  const settle = input.settleWith === undefined
    ? "Re-read the resource with a read-only `cuna` command before re-issuing this mutation."
    : `Run \`${input.settleWith}\` to see the current state.`;
  return new CunaError({
    code: OBSERVATION_BUDGET_CODES[input.kind],
    message: input.kind === "response"
      ? `The CLI stopped waiting for Cuna to answer ${input.operation} after ${input.budgetMs} ms.`
      : `Cuna accepted ${input.operation}; the CLI stopped reading back after ${input.budgetMs} ms, before the change became visible.`,
    exitCode: EXIT_CODES.network,
    hint: input.kind === "response"
      ? `This is the CLI's own limit, not a Cuna failure, and the operation may have completed. ${settle} Raise --timeout-ms to wait longer.`
      : `This is the CLI's own limit, not a Cuna failure, and the change may still be settling. ${settle}`,
    // Written once, here, and not reachable as a parameter. A budget refusal
    // that denied retry is the defect this module exists to make unspellable.
    retryable: true,
    details: Object.freeze({
      ...input.details,
      budget_ms: input.budgetMs,
      ...(input.settleWith === undefined ? {} : { settle_with: input.settleWith }),
      // Stated for machine readers in the same record as the sentence: the CLI
      // observed nothing, which is not the same as observing that nothing
      // happened.
      remote_outcome: "unobserved",
    }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
}
