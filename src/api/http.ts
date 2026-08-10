import { EXIT_CODES, CunaError } from "../core/errors.js";
import {
  isContinuationSecret,
  isProblemType,
  isProblemTypeForCode,
  isTransportCredential,
} from "../core/namespace.js";
import { isObject, safeReasonCode } from "../core/validation.js";
import { CLI_VERSION } from "../version.js";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const PROBLEM_CODE = /^[a-z][a-z0-9_]{2,63}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PROBLEM_ACTIONS = new Set(["retry", "sign_in", "open_web", "contact_support", "none"]);
const WORKSPACE_SYNC_CAPABILITIES = Object.freeze([
  "atomic_generation_commit",
  "bounded_manifest_pages",
  "content_digest_verification",
  "explicit_reconciliation",
  "ordered_generation_changes",
  "policy_bound_admission",
] as const);
const NO_WORKSPACE_SYNC_CAPABILITIES = Object.freeze([] as const);

interface ProblemMetadata {
  readonly code: string;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly selectedProtocol?: 1 | 2 | null;
  readonly capabilities?: typeof WORKSPACE_SYNC_CAPABILITIES | typeof NO_WORKSPACE_SYNC_CAPABILITIES;
}

export interface HttpRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly contentType?: "application/json; charset=utf-8" | "application/octet-stream";
  readonly idempotencyKey?: string;
  readonly machineCreateRequestId?: string;
  readonly continuationSecret?: string;
  readonly signal?: AbortSignal;
}

export interface HttpTransport {
  request(input: HttpRequest): Promise<unknown>;
}

function problemMetadata(body: unknown, expectedStatus: number): ProblemMetadata | undefined {
  if (!isObject(body)) return undefined;
  if (Object.hasOwn(body, "selected_protocol") || Object.hasOwn(body, "capabilities")) {
    return workspaceSyncProblemMetadata(body, expectedStatus);
  }
  const required = new Set(["type", "title", "status", "code", "request_id", "retryable"]);
  const optional = new Set(["detail", "action"]);
  const keys = Object.keys(body);
  if (
    [...required].some((key) => !Object.hasOwn(body, key)) ||
    keys.some((key) => !required.has(key) && !optional.has(key)) ||
    typeof body.type !== "string" || !isProblemType(body.type) ||
    typeof body.title !== "string" || body.title.length < 1 || body.title.length > 120 ||
    !Number.isSafeInteger(body.status) || body.status !== expectedStatus ||
    typeof body.code !== "string" || !PROBLEM_CODE.test(body.code) ||
    typeof body.request_id !== "string" || !UUID.test(body.request_id) ||
    typeof body.retryable !== "boolean" ||
    (Object.hasOwn(body, "detail") &&
      (typeof body.detail !== "string" || body.detail.length > 500)) ||
    (Object.hasOwn(body, "action") &&
      (typeof body.action !== "string" || !PROBLEM_ACTIONS.has(body.action)))
  ) {
    return undefined;
  }
  return Object.freeze({
    code: body.code,
    requestId: body.request_id,
    retryable: body.retryable,
  });
}

function workspaceSyncProblemMetadata(
  body: Record<string, unknown>,
  expectedStatus: number,
): ProblemMetadata | undefined {
  const required = new Set([
    "type", "title", "status", "code", "request_id", "retryable", "action",
    "selected_protocol", "capabilities", "detail",
  ]);
  const keys = Object.keys(body);
  const selectedProtocol = body.selected_protocol;
  const capabilities = body.capabilities;
  const hasSelectedProtocol = selectedProtocol === 1 || selectedProtocol === 2;
  if (
    keys.length !== required.size ||
    [...required].some((key) => !Object.hasOwn(body, key)) ||
    typeof body.code !== "string" ||
    !/^workspace_sync_[a-z0-9_]{2,48}$/u.test(body.code) ||
    typeof body.type !== "string" || !isProblemTypeForCode(body.type, body.code) ||
    typeof body.title !== "string" || body.title.length < 1 || body.title.length > 120 ||
    !Number.isSafeInteger(body.status) || body.status !== expectedStatus ||
    typeof body.request_id !== "string" || !UUID.test(body.request_id) ||
    typeof body.retryable !== "boolean" ||
    (body.action !== "retry" && body.action !== "none") ||
    typeof body.detail !== "string" || body.detail.length < 1 || body.detail.length > 500 ||
    (!hasSelectedProtocol && selectedProtocol !== null) ||
    !Array.isArray(capabilities) ||
    (selectedProtocol === null
      ? capabilities.length !== 0
      : capabilities.length !== WORKSPACE_SYNC_CAPABILITIES.length ||
        capabilities.some((value, index) => value !== WORKSPACE_SYNC_CAPABILITIES[index]))
  ) {
    return undefined;
  }
  return Object.freeze({
    code: body.code,
    requestId: body.request_id,
    retryable: body.retryable,
    selectedProtocol: selectedProtocol as 1 | 2 | null,
    capabilities: selectedProtocol === null
      ? NO_WORKSPACE_SYNC_CAPABILITIES
      : WORKSPACE_SYNC_CAPABILITIES,
  });
}

function apiError(
  status: number,
  requestId: string | undefined,
  body: unknown,
  credentialKind: "api_key" | "interactive" | "anonymous",
): CunaError {
  const problem = problemMetadata(body, status);
  const reason = problem?.code ??
    (isObject(body) ? safeReasonCode(body.code) ?? safeReasonCode(body.error) : undefined);
  const effectiveRequestId = problem?.requestId ?? requestId;
  const details = {
    http_status: status,
    ...(effectiveRequestId === undefined ? {} : { request_id: effectiveRequestId }),
    ...(reason === undefined ? {} : { reason }),
    ...(problem?.selectedProtocol === undefined
      ? {}
      : { selected_protocol: problem.selectedProtocol }),
    ...(problem?.capabilities === undefined
      ? {}
      : { capabilities: problem.capabilities }),
  };
  if (status === 401) {
    return new CunaError({
      code: "cuna.auth.rejected",
      message: "Cuna rejected the current credential.",
      exitCode: EXIT_CODES.auth,
      hint: credentialKind === "interactive"
        ? "Run `cuna login` to reauthenticate this interactive session."
        : credentialKind === "api_key"
          ? "Replace CUNA_API_KEY with a valid automation credential."
          : "Run `cuna login` or provide the required request authority.",
      ...(problem === undefined ? {} : { retryable: problem.retryable }),
      details,
    });
  }
  if (status === 403) {
    return new CunaError({
      code: "cuna.policy.denied",
      message: "Cuna denied this operation.",
      exitCode: EXIT_CODES.policy,
      ...(problem === undefined ? {} : { retryable: problem.retryable }),
      details,
    });
  }
  if (status === 409) {
    return new CunaError({
      code: "cuna.remote.conflict",
      message: "Cuna could not apply the operation because current state conflicts with it.",
      exitCode: EXIT_CODES.conflict,
      ...(problem === undefined ? {} : { retryable: problem.retryable }),
      details,
    });
  }
  if (status === 429 || status >= 500) {
    return new CunaError({
      code: status === 429 ? "cuna.network.rate_limited" : "cuna.network.service_unavailable",
      message: status === 429 ? "Cuna is rate limiting this request." : "The Cuna service is temporarily unavailable.",
      exitCode: EXIT_CODES.network,
      retryable: problem?.retryable ?? true,
      details,
    });
  }
  return new CunaError({
    code: status === 404 ? "cuna.remote.not_found" : "cuna.remote.rejected",
    message: status === 404 ? "The requested Cuna resource or operation was not found." : "Cuna rejected the request.",
    exitCode: EXIT_CODES.remote,
    ...(problem === undefined ? {} : { retryable: problem.retryable }),
    details,
  });
}

async function readLimited(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    throw new CunaError({
      code: "cuna.remote.response_too_large",
      message: "Cuna returned an oversized response.",
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
        throw new CunaError({
          code: "cuna.remote.response_too_large",
          message: "Cuna returned an oversized response.",
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
    throw new CunaError({
      code: "cuna.remote.malformed_response",
      message: "Cuna returned a malformed response.",
      exitCode: EXIT_CODES.remote,
      cause,
    });
  }
}

function isRetryableAfterUnknownDispatch(request: HttpRequest): boolean {
  // A transport timeout or failure cannot prove whether a mutating request
  // reached the authority. An idempotency key alone is not reconciliation
  // evidence, so mutations remain fail-closed until a producer contract
  // explicitly exposes authoritative operation-status reconciliation.
  return request.method === "GET";
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
  if (credential !== undefined && !isTransportCredential(credential)) {
    throw new TypeError("HTTP transport credential is invalid.");
  }
  const fetcher = input.fetch ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? 15_000;
  return Object.freeze({
    async request(request: HttpRequest): Promise<unknown> {
      if (request.signal?.aborted === true) {
        throw new CunaError({
          code: "cuna.network.cancelled",
          message: "The Cuna request was cancelled.",
          exitCode: EXIT_CODES.network,
          retryable: false,
          cause: request.signal.reason,
        });
      }
      if (!request.path.startsWith("/v1/") || request.path.includes("..") || request.path.includes("?")) {
        throw new CunaError({
          code: "cuna.internal.invalid_api_path",
          message: "Cuna refused an invalid API operation.",
          exitCode: EXIT_CODES.internal,
        });
      }
      if (
        request.continuationSecret !== undefined &&
        !isContinuationSecret(request.continuationSecret)
      ) {
        throw new CunaError({
          code: "cuna.internal.invalid_continuation_secret",
          message: "Cuna refused an invalid continuation credential.",
          exitCode: EXIT_CODES.internal,
        });
      }
      if (
        request.machineCreateRequestId !== undefined &&
        !UUID.test(request.machineCreateRequestId)
      ) {
        throw new CunaError({
          code: "cuna.internal.invalid_machine_create_request_id",
          message: "Cuna refused an invalid machine-create request identity.",
          exitCode: EXIT_CODES.internal,
        });
      }
      const target = new URL(request.path, `${input.baseUrl}/`);
      if (target.origin !== input.baseUrl || target.pathname !== request.path) {
        throw new CunaError({
          code: "cuna.internal.invalid_api_origin",
          message: "Cuna refused an invalid API origin.",
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
      let body: BodyInit | undefined;
      let contentType: HttpRequest["contentType"] | undefined;
      let contentLength: number | undefined;
      if (request.body !== undefined) {
        if (request.body instanceof Uint8Array) {
          if (request.contentType !== "application/octet-stream") {
            throw new CunaError({
              code: "cuna.usage.invalid_body",
              message: "Binary request bodies require application/octet-stream.",
              exitCode: EXIT_CODES.usage,
            });
          }
          const binary = new Uint8Array(request.body.byteLength);
          binary.set(request.body);
          body = binary.buffer;
          contentType = request.contentType;
          contentLength = request.body.byteLength;
        } else {
          if (
            request.contentType !== undefined &&
            request.contentType !== "application/json; charset=utf-8"
          ) {
            throw new CunaError({
              code: "cuna.usage.invalid_body",
              message: "Structured request bodies require JSON content type.",
              exitCode: EXIT_CODES.usage,
            });
          }
          try {
            body = JSON.stringify(request.body);
            contentType = "application/json; charset=utf-8";
          } catch (cause) {
            throw new CunaError({
              code: "cuna.usage.invalid_body",
              message: "The request body cannot be encoded.",
              exitCode: EXIT_CODES.usage,
              cause,
            });
          }
        }
      } else if (request.contentType !== undefined) {
        throw new CunaError({
          code: "cuna.usage.invalid_body",
          message: "A request content type requires a request body.",
          exitCode: EXIT_CODES.usage,
        });
      }
      try {
        const response = await fetcher(target, {
          method: request.method,
          headers: {
            Accept: "application/json, application/problem+json",
            ...(credential === undefined ? {} : { Authorization: `Bearer ${credential}` }),
            "User-Agent": `cuna-cli/${CLI_VERSION}`,
            ...(contentType === undefined ? {} : { "Content-Type": contentType }),
            ...(contentLength === undefined ? {} : { "Content-Length": String(contentLength) }),
            ...(request.idempotencyKey === undefined ? {} : { "Idempotency-Key": request.idempotencyKey }),
            ...(request.machineCreateRequestId === undefined
              ? {}
              : { "X-Cuna-Machine-Create-Request-Id": request.machineCreateRequestId }),
            // Both spellings, always. The deployed API reads only
            // `X-Runa-Continuation`; the renamed API reads either. Sending one
            // name pins the CLI to whichever side happens to be live, and a
            // dropped continuation header fails every human login exchange.
            ...(request.continuationSecret === undefined
              ? {}
              : {
                "X-Cuna-Continuation": request.continuationSecret,
                "X-Runa-Continuation": request.continuationSecret,
              }),
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
        if (error instanceof CunaError) throw error;
        if (controller.signal.aborted) {
          const cancelledByCaller = request.signal?.aborted ?? false;
          throw new CunaError({
            code: cancelledByCaller ? "cuna.network.cancelled" : "cuna.network.timeout",
            message: cancelledByCaller ? "The Cuna request was cancelled." : "The Cuna request timed out.",
            exitCode: EXIT_CODES.network,
            retryable: !cancelledByCaller && isRetryableAfterUnknownDispatch(request),
            cause: error,
          });
        }
        throw new CunaError({
          code: "cuna.network.failed",
          message: "The Cuna request failed before an authoritative result was received.",
          exitCode: EXIT_CODES.network,
          retryable: isRetryableAfterUnknownDispatch(request),
          cause: error,
        });
      } finally {
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", onAbort);
      }
    },
  });
}
