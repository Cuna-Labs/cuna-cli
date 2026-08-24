/**
 * The one authority in this CLI for reading a timestamp another system wrote.
 *
 * This file exists because the same defect was found four times on 2026-08-18,
 * in three languages, and each one was first fixed locally as if it were a typo:
 *
 *   infra edge/src/supervisor-attachment-authority.ts  ticket.expires_at !== expiresAt
 *   infra assets/agent-session-supervisor.py           value.endswith("Z")
 *   cuna-cli src/workspace/binding-store.ts            new Date(t).toISOString() !== t
 *   cuna-cli src/runtime/terminal-transport.ts         /\.[0-9]{3}Z$/
 *
 * Every one compares an ENCODING where it means to compare an INSTANT, and every
 * one is correct wherever a single process both writes and reads the value —
 * which is exactly why they survived review. Nothing in the code separated "we
 * minted this" from "they minted this", so one idiom was harmless in one file
 * and fatal in the next.
 *
 * The two encodings, both measured against production 2026-08-18:
 *
 *   JavaScript toISOString()    2026-08-18T21:00:00.000Z          3 digits, `Z`
 *   PostgREST over timestamptz  2026-08-18T20:49:24.458909+00:00  up to 6, `+00:00`
 *
 * They are never string-equal. The API contract settles which is correct: 36
 * properties carry `format: "date-time"`, which in OpenAPI 3.1 is RFC 3339 §5.6
 * and admits both, at any fractional precision. So neither renderer was wrong;
 * every one of those comparisons was NARROWER THAN THE CONTRACT it implements.
 *
 * `infra` carries the mirror of this module at `edge/src/instant.ts`. Two copies
 * of one rule is itself the shape this workspace keeps closing, and it is
 * accepted here only because the CLI ships as a standalone npm package with no
 * dependency on the service repository. If a shared package ever exists, this is
 * one of the first things that should move into it.
 *
 * What this module is NOT for: a value this CLI minted itself. Where the CLI is
 * both writer and reader — `src/auth/human-session.ts`, whose stored
 * `login_code_expires_at` is normalized to canonical form by
 * `src/auth/human-contracts.ts` before it is ever written — an exact-encoding
 * check is a correct integrity check on our own file, and widening it would
 * weaken it for nothing.
 */

/**
 * RFC 3339 §5.6 `date-time`: any fractional precision, and an explicit offset —
 * `Z` or `+hh:mm`/`-hh:mm`.
 *
 * The one thing it refuses is the one thing that is genuinely ambiguous. A value
 * with NO offset is not an instant: `Date.parse` reads it in the HOST's local
 * zone, so the same bytes name different moments on two machines in different
 * regions and each is certain it is right. Measured on this host,
 * `2026-08-18T20:49:24.458909` parses six hours away from the same digits with
 * `+00:00`. Refused, never guessed.
 *
 * It is otherwise exactly as wide as the contract, on purpose. `infra`'s mirror
 * at `edge/src/instant.ts` restricts the offset to zero (`Z` or `±00:00`), which
 * is narrower than `format: "date-time"` admits — the same class of narrowing
 * this module exists to repair, merely one step further out. Nothing produces a
 * non-zero offset today, and "nothing produces it today" is the reasoning that
 * put four of these in the tree. This regex is character-identical to the
 * `RFC3339` already in `src/auth/human-contracts.ts`, which is the other place
 * this repo reads a service-rendered instant.
 */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * The epoch milliseconds of an RFC 3339 instant, or `null` if the value is not
 * one.
 *
 * Note the deliberate lossiness: `Date.parse` truncates below the millisecond,
 * so `…458909+00:00` and `…458+00:00` are the same number here. That is the
 * right resolution for these call sites — each is checking that a store echoed
 * back a moment, and the sub-millisecond digits are the store's own precision,
 * never information the CLI supplied. A caller that genuinely needs exact bytes
 * should compare bytes and say why.
 */
export function instantOrNull(value: unknown): number | null {
  if (typeof value !== "string" || !RFC3339.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * True when both arguments name the same moment, whatever rendered them.
 *
 * `false` whenever either side is not an RFC 3339 instant, so an unparseable
 * value never compares equal to anything, including itself.
 */
export function sameInstant(left: unknown, right: unknown): boolean {
  const a = instantOrNull(left);
  const b = instantOrNull(right);
  return a !== null && b !== null && a === b;
}
