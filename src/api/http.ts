import { EXIT_CODES, RunaError } from "../core/errors.js";
import { isObject, safeReasonCode } from "../core/validation.js";
import { CLI_VERSION } from "../version.js";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface HttpRequest {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly continuationSecret?: string;
  readonly signal?: AbortSignal;
}

export interface HttpTransport {
  request(input: HttpRequest): Promise<unknown>;
}

function apiError(
  status: number,
  requestId: string | undefined,
  body: unknown,
  credentialKind: "api_key" | "interactive" | "anonymous",
): RunaError {
  const reason = isObject(body) ? safeReasonCode(body.code) ?? safeReasonCode(body.error) : undefined;
  const details = {
    http_status: status,
    ...(requestId === undefined ? {} : { request_id: requestId }),
    ...(reason === undefined ? {} : { reason }),
  };
  if (status === 401) {
    return new RunaError({
      code: "runa.auth.rejected",
      message: "Runa rejected the current credential.",
      exitCode: EXIT_CODES.auth,
      hint: credentialKind === "interactive"
        ? "Run `runa login` to reauthenticate this interactive session."
        : credentialKind === "api_key"
          ? "Replace RUNA_API_KEY with a valid automation credential."
          : "Run `runa login` or provide the required request authority.",
      details,
    });
  }
  if (status === 403) {
    return new RunaError({
      code: "runa.policy.denied",
      message: "Runa denied this operation.",
      exitCode: EXIT_CODES.policy,
      details,
    });
  }
  if (status === 409) {
    return new RunaError({
      code: "runa.remote.conflict",
      message: "Runa could not apply the operation because current state conflicts with it.",
      exitCode: EXIT_CODES.conflict,
      details,
    });
  }
  if (status === 429 || status >= 500) {
    return new RunaError({
      code: status === 429 ? "runa.network.rate_limited" : "runa.network.service_unavailable",
      message: status === 429 ? "Runa is rate limiting this request." : "The Runa service is temporarily unavailable.",
      exitCode: EXIT_CODES.network,
      retryable: true,
      details,
    });
  }
  return new RunaError({
    code: status === 404 ? "runa.remote.not_found" : "runa.remote.rejected",
    message: status === 404 ? "The requested Runa resource or operation was not found." : "Runa rejected the request.",
    exitCode: EXIT_CODES.remote,
    details,
  });
}

async function readLimited(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    throw new RunaError({
      code: "runa.remote.response_too_large",
      message: "Runa returned an oversized response.",
      exitCode: EXIT_CODES.remote,
    });
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new RunaError({
          code: "runa.remote.response_too_large",
          message: "Runa returned an oversized response.",
          exitCode: EXIT_CODES.remote,
        });
      }
      chunks.push(value);
    }
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function parseJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (cause) {
    throw new RunaError({
      code: "runa.remote.malformed_response",
      message: "Runa returned a malformed response.",
      exitCode: EXIT_CODES.remote,
      cause,
    });
  }
}

export function createHttpTransport(input: {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly bearerToken?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}): HttpTransport {
  if (input.apiKey !== undefined && input.bearerToken !== undefined) {
    throw new TypeError("HTTP transport accepts exactly one credential authority.");
  }
  const credential = input.apiKey ?? input.bearerToken;
  const credentialKind = input.apiKey !== undefined
    ? "api_key" as const
    : input.bearerToken !== undefined
      ? "interactive" as const
      : "anonymous" as const;
  if (
    credential !== undefined &&
    !/^runa_(?:sk_[A-Za-z0-9_-]{16,256}|at_[A-Za-z0-9_-]{43})$/u.test(credential)
  ) {
    throw new TypeError("HTTP transport credential is invalid.");
  }
  const fetcher = input.fetch ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? 15_000;
  return Object.freeze({
    async request(request: HttpRequest): Promise<unknown> {
      if (request.signal?.aborted === true) {
        throw new RunaError({
          code: "runa.network.cancelled",
          message: "The Runa request was cancelled.",
          exitCode: EXIT_CODES.network,
          retryable: false,
          cause: request.signal.reason,
        });
      }
      if (!request.path.startsWith("/v1/") || request.path.includes("..") || request.path.includes("?")) {
        throw new RunaError({
          code: "runa.internal.invalid_api_path",
          message: "Runa refused an invalid API operation.",
          exitCode: EXIT_CODES.internal,
        });
      }
      if (
        request.continuationSecret !== undefined &&
        !/^runa_ct_[A-Za-z0-9_-]{43}$/u.test(request.continuationSecret)
      ) {
        throw new RunaError({
          code: "runa.internal.invalid_continuation_secret",
          message: "Runa refused an invalid continuation credential.",
          exitCode: EXIT_CODES.internal,
        });
      }
      const target = new URL(request.path, `${input.baseUrl}/`);
      if (target.origin !== input.baseUrl || target.pathname !== request.path) {
        throw new RunaError({
          code: "runa.internal.invalid_api_origin",
          message: "Runa refused an invalid API origin.",
          exitCode: EXIT_CODES.internal,
        });
      }
      for (const [key, value] of Object.entries(request.query ?? {})) {
        if (value !== undefined) target.searchParams.set(key, value);
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), timeoutMs);
      const onAbort = () => controller.abort(request.signal?.reason);
      request.signal?.addEventListener("abort", onAbort, { once: true });
      let body: string | undefined;
      if (request.body !== undefined) {
        try {
          body = JSON.stringify(request.body);
        } catch (cause) {
          throw new RunaError({
            code: "runa.usage.invalid_body",
            message: "The request body cannot be encoded.",
            exitCode: EXIT_CODES.usage,
            cause,
          });
        }
      }
      try {
        const response = await fetcher(target, {
          method: request.method,
          headers: {
            Accept: "application/json",
            ...(credential === undefined ? {} : { Authorization: `Bearer ${credential}` }),
            "User-Agent": `runa-cli/${CLI_VERSION}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
            ...(request.idempotencyKey === undefined ? {} : { "Idempotency-Key": request.idempotencyKey }),
            ...(request.continuationSecret === undefined
              ? {}
              : { "X-Runa-Continuation": request.continuationSecret }),
          },
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
          redirect: "error",
        });
        const bytes = await readLimited(response);
        const parsed = parseJson(bytes);
        if (!response.ok) {
          throw apiError(response.status, response.headers.get("x-request-id") ?? undefined, parsed, credentialKind);
        }
        return parsed;
      } catch (error) {
        if (error instanceof RunaError) throw error;
        if (controller.signal.aborted) {
          throw new RunaError({
            code: request.signal?.aborted ? "runa.network.cancelled" : "runa.network.timeout",
            message: request.signal?.aborted ? "The Runa request was cancelled." : "The Runa request timed out.",
            exitCode: EXIT_CODES.network,
            retryable: !request.signal?.aborted,
            cause: error,
          });
        }
        throw new RunaError({
          code: "runa.network.failed",
          message: "The Runa request failed before an authoritative result was received.",
          exitCode: EXIT_CODES.network,
          retryable: request.method === "GET",
          cause: error,
        });
      } finally {
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", onAbort);
      }
    },
  });
}
