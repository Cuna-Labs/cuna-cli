import { usageError } from "./errors.js";

const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_CODE = /^[a-z][a-z0-9_.-]{0,127}$/u;
// C0/C1 controls and Unicode format controls can mutate terminal state, forge
// rows, reverse text direction, or hide content. They are never valid in a
// Cuna display name, state label, or workspace path.
const UNSAFE_DISPLAY_CHARACTER = /[\p{Cc}\p{Cf}]/u;
const IDEMPOTENCY_KEY = /^[!-~]{8,128}$/u;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function assertPublicId(value: string, label: string): string {
  if (!PUBLIC_ID.test(value)) {
    throw usageError(`Invalid ${label}.`, `${label} must be an opaque public Cuna identifier.`);
  }
  return value;
}

export function encodePublicId(value: string, label: string): string {
  return encodeURIComponent(assertPublicId(value, label));
}

export function assertCanonicalUuid(value: string, label: string): string {
  if (!CANONICAL_UUID.test(value)) {
    throw usageError(`Invalid ${label}.`, `${label} must be a canonical lowercase Cuna UUID.`);
  }
  return value;
}

export function encodeCanonicalUuid(value: string, label: string): string {
  return encodeURIComponent(assertCanonicalUuid(value, label));
}

/**
 * A machine identifier, in the one shape the product accepts.
 *
 * The command layer used `assertPublicId` and the transport used
 * `encodeCanonicalUuid`, so `mch_1` passed preflight, spent a capability
 * round-trip, and only then failed deep in the transport against a rule the
 * command layer never enforced. The user paid a network call to learn that
 * their argument was malformed, and the error named a layer they had never
 * heard of.
 *
 * The transport is the authority here — the server routes by canonical UUID —
 * so both layers now call this, and the shape is stated once. Note that
 * `--machine` on `cuna claude` is a machine NAME, not an ID, and is deliberately
 * not validated here.
 */
export function assertMachineId(value: string): string {
  return assertCanonicalUuid(value, "machine ID");
}

/** The same authority, percent-encoded for a request path. */
export function encodeMachineId(value: string): string {
  return encodeURIComponent(assertMachineId(value));
}

export function assertIdempotencyKey(value: string): string {
  if (!IDEMPOTENCY_KEY.test(value)) {
    throw usageError(
      "Invalid idempotency key.",
      "Idempotency key must contain 8 through 128 printable ASCII characters.",
    );
  }
  return value;
}

// Exactly a base-10 integer: no sign, no radix prefix, no exponent, no
// surrounding whitespace, no decimal point.
const DECIMAL_INTEGER = /^\d+$/u;

/**
 * Parse a command-line integer option, or throw a usage error naming it.
 *
 * `Number(raw)` is not a base-10 integer parser. It accepts `0x1F4` (500),
 * `1e5` (100000), `" 500 "`, `+500`, `.5e3`, `0b111` and `Infinity`, and
 * `Number.isInteger` then waves the first five through. That is tolerable for a
 * timeout and not tolerable for `--workspace-generation`, which is a fencing
 * token: `1e3` silently becoming 1000 is a write against the wrong generation,
 * and the mistake is invisible because the value looks like what was typed.
 *
 * Both the root option parser and the per-command option parser now go through
 * here, because the two had independently written the same `Number(raw)` bug.
 */
export function integerArgument(
  raw: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const invalid = (): never => {
    throw usageError(
      `Option --${name} must be an integer from ${minimum} through ${maximum}.`,
      "Write the value in base 10 with no sign, exponent, radix prefix, or surrounding spaces.",
    );
  };
  if (!DECIMAL_INTEGER.test(raw)) return invalid();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid();
  return value;
}

export function safeReasonCode(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : undefined;
}

export function assertSafeDisplayText(value: string, label: string): string {
  if (UNSAFE_DISPLAY_CHARACTER.test(value)) {
    throw usageError(`Invalid ${label}.`, `${label} must not contain control or formatting characters.`);
  }
  return value;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A response that did not match the published contract, carrying WHICH part.
 *
 * WHY THIS TYPE EXISTS. Every decoder in `api/contracts.ts` already knew the
 * exact predicate that failed and threw a bare `TypeError` whose message the
 * client then discarded, so `cuna.remote.malformed_response` reached the user as
 * one unactionable sentence — "Cuna returned a response that does not match the
 * public contract." — with no `details` and no `hint`. Finding out that
 * production omits `workspace.id` required isolating `decodeRunaIdentity` in a
 * throwaway script. That is a diagnosis a user cannot perform and the CLI did
 * not need to lose: the information existed at the throw site and died one
 * `catch` later.
 *
 * WHAT MAY BE CARRIED, AND WHAT MAY NOT. `field` and `predicate` are NAMES and
 * SHAPES. A response body may hold an API key, an email address, or a workspace
 * path, so no value from the payload is ever placed on this error — not the
 * offending value, not a truncation of it, not its length. `field` is the key
 * path the CLI itself asked for and `predicate` is a fixed token chosen from
 * this source tree. Both are safe to print and safe to log.
 *
 * `field` is the NARROWEST KNOWN location, not necessarily a leaf. A compound
 * check that spans a subtree reports the subtree, because claiming a leaf it did
 * not test would be a more precise answer than the code actually has.
 */
export class ContractViolation extends TypeError {
  /** Narrowest known location, e.g. `workspace.id` or `capabilities[3].id`. */
  readonly field: string | undefined;
  /** Stable token naming the rule that failed, e.g. `required_string`. */
  readonly predicate: string;

  constructor(predicate: string, field?: string) {
    super(field === undefined
      ? `Contract violation: ${predicate}`
      : `Contract violation: ${predicate} at ${field}`);
    this.name = "ContractViolation";
    this.predicate = predicate;
    this.field = field;
  }
}

/** Mint a contract violation. `field` is omitted when the check spans no one key. */
export function contractViolation(predicate: string, field?: string): ContractViolation {
  return field === undefined ? new ContractViolation(predicate) : new ContractViolation(predicate, field);
}

/**
 * Run a nested decode, reporting any violation under `prefix`.
 *
 * Without this, `decodeRunaIdentity` reported `id` for a violation inside
 * `workspace`, which names a key that also exists at the root — the one reading
 * that would send a user to the wrong field.
 */
export function underField<T>(prefix: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof ContractViolation) {
      throw contractViolation(
        error.predicate,
        error.field === undefined ? prefix : `${prefix}.${error.field}`,
      );
    }
    throw error;
  }
}

/** The same, for one element of a decoded array. */
export function underIndex<T>(prefix: string, index: number, run: () => T): T {
  return underField(`${prefix}[${index}]`, run);
}

export function requiredString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw contractViolation("required_non_empty_string", key);
  }
  return value;
}

export function requiredDisplayString(source: Record<string, unknown>, key: string): string {
  const value = requiredString(source, key);
  if (UNSAFE_DISPLAY_CHARACTER.test(value)) throw contractViolation("no_control_characters", key);
  return value;
}

export function optionalDisplayString(source: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(source, key);
  if (value !== undefined && UNSAFE_DISPLAY_CHARACTER.test(value)) {
    throw contractViolation("no_control_characters", key);
  }
  return value;
}

export function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw contractViolation("string_when_present", key);
  return value;
}

export function optionalNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw contractViolation("finite_number_when_present", key);
  }
  return value;
}
