import { SUPPORT_URL } from "./product-web.js";

export const EXIT_CODES = Object.freeze({
  success: 0,
  usage: 2,
  auth: 3,
  policy: 4,
  network: 5,
  conflict: 6,
  remote: 7,
  unsupported: 8,
  internal: 70,
} as const);

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export type SafeErrorScalar = string | number | boolean | null;
export type SafeErrorDetails = Readonly<Record<string, SafeErrorScalar | readonly SafeErrorScalar[]>>;

/**
 * The namespace every error code this CLI emits is minted under.
 *
 * Codes reach the user twice — as `error.code` in `--json` records and as
 * `Error [code]:` on a terminal — so the namespace is product surface, not an
 * internal tag.
 *
 * WHAT THIS CONSTANT IS NOT: it is not the thing codes are built from. Measured
 * — the only references to `ERROR_NAMESPACE` in the tree are this declaration
 * and its re-export from `src/index.ts`. Not one error code is derived from it.
 * The literals are still written out by hand at roughly 145 sites, so a rename
 * is still a mass edit and the guard against a half-finished one is
 * `test/error-namespace.test.mjs`, which greps for the absence of `runa.` — not
 * this constant.
 *
 * An earlier version of this comment claimed the opposite ("a rename is one
 * edit rather than the ninety-one scattered literals it used to be"). It was
 * wrong, and it is the kind of wrong that stops the next reader from adding the
 * guard that is actually missing.
 *
 * This is also NOT the wire namespace. Protocol identifiers the service mints
 * and compares by exact equality (`runa.terminal.v1`, `runa.agent-auth.v1`, the
 * `runa.auth.<token>` WebSocket subprotocol) are not error codes.
 */
export const ERROR_NAMESPACE = "cuna" as const;

export class CunaError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly hint: string | undefined;
  readonly retryable: boolean;
  readonly details: SafeErrorDetails | undefined;

  constructor(input: {
    readonly code: string;
    readonly message: string;
    readonly exitCode: ExitCode;
    readonly hint?: string;
    readonly retryable?: boolean;
    readonly details?: SafeErrorDetails;
    readonly cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "CunaError";
    this.code = input.code;
    this.exitCode = input.exitCode;
    this.hint = input.hint;
    this.retryable = input.retryable ?? false;
    this.details = input.details;
  }
}

/**
 * @deprecated Renamed to `CunaError`. Retained for one release so an internal
 * import that was missed fails loudly at review time rather than silently at
 * runtime; remove after the first published release.
 */
export const RunaError = CunaError;
/** @deprecated Renamed to `CunaError`. */
export type RunaError = CunaError;

export function usageError(message: string, hint?: string): CunaError {
  return new CunaError({
    code: "cuna.usage.invalid",
    message,
    exitCode: EXIT_CODES.usage,
    ...(hint === undefined ? {} : { hint }),
  });
}

export function unsupportedError(feature: string, reason = "not_implemented"): CunaError {
  return new CunaError({
    code: "cuna.capability.unsupported",
    message: `The ${feature} capability is not available in this CLI build or server contract.`,
    exitCode: EXIT_CODES.unsupported,
    hint: "Run `cuna capabilities` to inspect current server support.",
    details: { feature, reason },
  });
}

export function normalizeError(error: unknown): CunaError {
  if (error instanceof CunaError) return error;
  return new CunaError({
    code: "cuna.internal.unexpected",
    message: "Cuna could not complete the command because of an internal failure.",
    exitCode: EXIT_CODES.internal,
    hint: `Retry once. If the problem persists, run \`cuna doctor --json\` and report it at ${SUPPORT_URL}.`,
    cause: error,
  });
}
