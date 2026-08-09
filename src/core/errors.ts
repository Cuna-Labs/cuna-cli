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

export type SafeErrorDetails = Readonly<Record<string, string | number | boolean | null>>;

export class RunaError extends Error {
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
    this.name = "RunaError";
    this.code = input.code;
    this.exitCode = input.exitCode;
    this.hint = input.hint;
    this.retryable = input.retryable ?? false;
    this.details = input.details;
  }
}

export function usageError(message: string, hint?: string): RunaError {
  return new RunaError({
    code: "runa.usage.invalid",
    message,
    exitCode: EXIT_CODES.usage,
    ...(hint === undefined ? {} : { hint }),
  });
}

export function unsupportedError(feature: string, reason = "not_implemented"): RunaError {
  return new RunaError({
    code: "runa.capability.unsupported",
    message: `The ${feature} capability is not available in this CLI build or server contract.`,
    exitCode: EXIT_CODES.unsupported,
    hint: "Run `runa capabilities` to inspect current server support.",
    details: { feature, reason },
  });
}

export function normalizeError(error: unknown): RunaError {
  if (error instanceof RunaError) return error;
  return new RunaError({
    code: "runa.internal.unexpected",
    message: "Runa could not complete the command because of an internal failure.",
    exitCode: EXIT_CODES.internal,
    hint: "Retry once. If the problem persists, run `runa doctor --json` and contact Runa support.",
    cause: error,
  });
}
