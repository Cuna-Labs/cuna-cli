import { EXIT_CODES, CunaError } from "../core/errors.js";
import { CredentialBoundaryError } from "../credentials/errors.js";
import {
  INTERNAL_DEFECT_HINT,
  OFF_CONTRACT_RESPONSE_HINT,
  SUPPORT_URL,
  automationCredentialHint,
} from "../core/product-web.js";
import {
  isAccessToken,
  isProblemType,
  isProblemTypeForCode,
  isTransportCredential,
} from "../core/namespace.js";
import { isIdempotencyKey, isObject, safeReasonCode } from "../core/validation.js";
import {
  DEFAULT_REQUEST_BUDGET_MS,
  observationBudgetElapsed,
} from "../core/observation-budget.js";
import { CLI_VERSION } from "../version.js";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
// A 16 MiB body is never a legitimate answer on this contract, so the remedy is
// to narrow the request rather than to retry it.
const OVERSIZED_RESPONSE_HINT =
  "Narrow the request with --limit or a cursor. Retrying unchanged returns the same oversized body.";
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
  readonly signal?: AbortSignal;
  /**
   * How long THIS operation is worth observing, when the caller has not named a
   * budget with `--timeout-ms`.
   *
   * A create that waits on a provider and a list that reads one table do not
   * share a duration, and pretending they do is what made `machines create`
   * report a network timeout for a machine that came up. Declared per operation
   * in `api/client.ts`, from a named constant in `core/observation-budget.ts`;
   * an explicit `--timeout-ms` still wins, because a budget the user typed is
   * the user's decision and not ours.
   */
  readonly budgetMs?: number;
  /**
   * The read-only command that settles this operation's outcome, named in the
   * refusal when the budget elapses. Without it the CLI can only tell the user
   * that something is unknown, which is a dead end.
   */
  readonly settleWith?: string;
}

export interface HttpTransport {
  request(input: HttpRequest): Promise<unknown>;
}

export interface BearerRefreshRequest {
  readonly reason: "unauthorized";
  readonly rejectedToken: string;
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

/**
 * Build the error for a non-2xx response.
 *
 * `body` is the decoded response body, or `undefined` when the body was not
 * JSON at all. The distinction is load-bearing: a status this API produced
 * always carries a JSON object (a Problem document, or at minimum
 * `{"error":"…"}`), because the request asks for exactly
 * `application/json, application/problem+json`. A non-JSON body at an error
 * status therefore came from a layer in front of the API that has no route for
 * this path — measured: `GET https://api.getcuna.com/v1/capabilities` answers
 * `404` with `content-type: text/plain` and the body `404 Not Found`, while
 * `GET /v1/me` answers `401` with `application/json`.
 */
function apiError(input: {
  readonly status: number;
  readonly requestId: string | undefined;
  readonly body: unknown;
  readonly apiEncodedBody: boolean;
  readonly credentialKind: "api_key" | "interactive" | "anonymous";
  readonly method: HttpRequest["method"];
  readonly path: string;
  readonly origin: string;
}): CunaError {
  const { status, requestId, body, credentialKind } = input;
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
      // The api_key arm used to say "Replace CUNA_API_KEY with a valid
      // automation credential" and name no source, which is the same dead end
      // the sign-in path had. It now shares the one sentence that does.
      hint: credentialKind === "interactive"
        ? "The access token was refused. Retry the command so Cuna can obtain a fresh token from the encrypted local session."
        : credentialKind === "api_key"
          ? `The current automation credential was refused. ${automationCredentialHint()}`
          : `Run \`cuna login\`, or provide an automation credential. ${automationCredentialHint()}`,
      ...(problem === undefined ? {} : { retryable: problem.retryable }),
      details,
    });
  }
  if (status === 403) {
    return new CunaError({
      code: "cuna.policy.denied",
      message: "Cuna denied this operation.",
      exitCode: EXIT_CODES.policy,
      hint: "The credential authenticated but is not permitted to do this. Retrying will not change the outcome.",
      ...(problem === undefined ? {} : { retryable: problem.retryable }),
      details,
    });
  }
  if (status === 409) {
    return new CunaError({
      code: "cuna.remote.conflict",
      message: "Cuna could not apply the operation because current state conflicts with it.",
      exitCode: EXIT_CODES.conflict,
      hint: "Re-read the resource and decide again from its current state. Repeating this request unchanged repeats this answer.",
      ...(problem === undefined ? {} : { retryable: problem.retryable }),
      details,
    });
  }
  if (status === 429 || status >= 500) {
    return new CunaError({
      code: status === 429 ? "cuna.network.rate_limited" : "cuna.network.service_unavailable",
      message: status === 429 ? "Cuna is rate limiting this request." : "The Cuna service is temporarily unavailable.",
      exitCode: EXIT_CODES.network,
      hint: status === 429
        ? "Wait before retrying. No change was applied by this request."
        : "No authoritative answer was received. Retry a read; do not assume a write was applied.",
      retryable: problem?.retryable ?? true,
      details,
    });
  }
  if (status === 404 && !input.apiEncodedBody) {
    // Reporting this as `cuna.remote.malformed_response` — which is what
    // happened while the body was parsed before the status was read — names the
    // layer that noticed the failure instead of the layer that caused it. The
    // response is not malformed; this deployment does not implement the
    // operation. Production serves 26 of the 57 operations this build knows, so
    // this is the majority answer today, not an edge case.
    return new CunaError({
      code: "cuna.remote.operation_not_served",
      message: `The Cuna API at ${input.origin} does not serve ${input.method} ${input.path}.`,
      exitCode: EXIT_CODES.unsupported,
      hint: `The deployed Cuna API does not implement this operation. Run \`cuna version --json\` and report it with that record at ${SUPPORT_URL} if it should be available.`,
      details: {
        http_status: status,
        ...(requestId === undefined ? {} : { request_id: requestId }),
        method: input.method,
        path: input.path,
        api_origin: input.origin,
      },
    });
  }
  return new CunaError({
    code: status === 404 ? "cuna.remote.not_found" : "cuna.remote.rejected",
    message: status === 404 ? "The requested Cuna resource or operation was not found." : "Cuna rejected the request.",
    exitCode: EXIT_CODES.remote,
    hint: status === 404
      ? "The identifier does not name a resource this account can see. Re-list to get a current one."
      : OFF_CONTRACT_RESPONSE_HINT,
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
      hint: OVERSIZED_RESPONSE_HINT,
      details: { predicate: "response_within_size_limit", limit_bytes: MAX_RESPONSE_BYTES },
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
          hint: OVERSIZED_RESPONSE_HINT,
          details: { predicate: "response_within_size_limit", limit_bytes: MAX_RESPONSE_BYTES },
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

type JsonDecoding =
  | { readonly decoded: true; readonly value: unknown }
  | { readonly decoded: false; readonly cause: unknown };

function decodeJson(bytes: Uint8Array): JsonDecoding {
  if (bytes.byteLength === 0) return { decoded: true, value: null };
  try {
    return {
      decoded: true,
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    };
  } catch (cause) {
    return { decoded: false, cause };
  }
}

/**
 * Decode a 2xx body, or fail naming the operation whose body would not parse.
 *
 * This is the other half of `cuna.remote.malformed_response`: not "the shape is
 * wrong" but "these bytes are not JSON at all". The two are worth telling apart
 * — a `predicate` of `response_body_is_json` points at a proxy or a truncated
 * transfer, while a field-level predicate points at the API itself — so the
 * detail says which, using the same key names the decode path uses.
 */
function parseJson(bytes: Uint8Array, request: Pick<HttpRequest, "method" | "path">): unknown {
  const result = decodeJson(bytes);
  if (result.decoded) return result.value;
  throw new CunaError({
    code: "cuna.remote.malformed_response",
    message: "Cuna returned a response body that is not valid JSON.",
    exitCode: EXIT_CODES.remote,
    hint: OFF_CONTRACT_RESPONSE_HINT,
    details: {
      operation: `${request.method} ${request.path}`,
      predicate: "response_body_is_json",
      // A byte count is a property of the transfer, not of the payload's
      // contents, so it discloses nothing a proxy log would not already show.
      response_bytes: bytes.byteLength,
    },
    cause: result.cause,
  });
}

function isRetryableAfterUnknownDispatch(request: HttpRequest): boolean {
  // A transport FAILURE — connection refused, TLS error, DNS — cannot prove
  // whether a mutating request reached the authority. An idempotency key alone
  // is not reconciliation evidence, so mutations stay fail-closed until a
  // producer contract exposes authoritative operation-status reconciliation.
  //
  // This no longer governs the timeout arm, and that separation is the fix.
  // A budget elapsing is not a transport failure: nothing failed, the CLI
  // stopped waiting. `core/observation-budget.ts` owns that answer and makes it
  // retryable at a single site.
  return request.method === "GET";
}

export function createHttpTransport(input: {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly bearerToken?: string;
  readonly bearerTokenProvider?: (
    signal?: AbortSignal,
    refresh?: BearerRefreshRequest,
  ) => Promise<string>;
  /**
   * The caller's EXPLICIT budget for every request, from `--timeout-ms`.
   *
   * Absent means "the caller did not decide", not "the caller chose 15 000".
   * The difference is the whole of D1: while this was eagerly defaulted in
   * `cli/run.ts`, a per-operation budget could never take effect, because the
   * default was indistinguishable from a typed flag by the time it arrived here.
   */
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}): HttpTransport {
  const credentialAuthorities = [
    input.apiKey,
    input.bearerToken,
    input.bearerTokenProvider,
  ].filter((value) => value !== undefined).length;
  if (credentialAuthorities > 1) {
    throw new TypeError("HTTP transport accepts exactly one credential authority.");
  }
  const credential = input.apiKey ?? input.bearerToken;
  const credentialKind = input.apiKey !== undefined
    ? "api_key" as const
    : input.bearerToken !== undefined || input.bearerTokenProvider !== undefined
      ? "interactive" as const
      : "anonymous" as const;
  if (credential !== undefined && !isTransportCredential(credential)) {
    throw new TypeError("HTTP transport credential is invalid.");
  }
  const fetcher = input.fetch ?? globalThis.fetch;
  // Precedence, in one expression so it cannot be spelled differently twice:
  // what the user typed, then what the operation declares it is worth, then the
  // one default.
  const budgetFor = (request: HttpRequest): number =>
    input.timeoutMs ?? request.budgetMs ?? DEFAULT_REQUEST_BUDGET_MS;
  return Object.freeze({
    async request(request: HttpRequest): Promise<unknown> {
      if (request.signal?.aborted === true) {
        throw new CunaError({
          code: "cuna.network.cancelled",
          message: "The Cuna request was cancelled.",
          exitCode: EXIT_CODES.network,
          hint: "The request was cancelled before dispatch, so nothing was sent.",
          retryable: false,
          cause: request.signal.reason,
        });
      }
      if (!request.path.startsWith("/v1/") || request.path.includes("..") || request.path.includes("?")) {
        throw new CunaError({
          code: "cuna.internal.invalid_api_path",
          message: "Cuna refused an invalid API operation.",
          exitCode: EXIT_CODES.internal,
          hint: INTERNAL_DEFECT_HINT,
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
          hint: INTERNAL_DEFECT_HINT,
        });
      }
      const target = new URL(request.path, `${input.baseUrl}/`);
      if (target.origin !== input.baseUrl || target.pathname !== request.path) {
        throw new CunaError({
          code: "cuna.internal.invalid_api_origin",
          message: "Cuna refused an invalid API origin.",
          exitCode: EXIT_CODES.internal,
          hint: INTERNAL_DEFECT_HINT,
        });
      }
      for (const [key, value] of Object.entries(request.query ?? {})) {
        if (value !== undefined) target.searchParams.set(key, value);
      }
      const budgetMs = budgetFor(request);
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
              hint: INTERNAL_DEFECT_HINT,
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
              hint: INTERNAL_DEFECT_HINT,
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
              hint: INTERNAL_DEFECT_HINT,
              cause,
            });
          }
        }
      } else if (request.contentType !== undefined) {
        throw new CunaError({
          code: "cuna.usage.invalid_body",
          message: "A request content type requires a request body.",
          exitCode: EXIT_CODES.usage,
          hint: INTERNAL_DEFECT_HINT,
        });
      }
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => controller.abort(request.signal?.reason);
      request.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const requestCredential = input.bearerTokenProvider === undefined
          ? credential
          : await input.bearerTokenProvider(controller.signal);
        if (
          requestCredential !== undefined &&
          (input.bearerTokenProvider === undefined
            ? !isTransportCredential(requestCredential)
            : !isAccessToken(requestCredential))
        ) {
          throw new CunaError({
            code: "cuna.internal.invalid_transport_credential",
            message: "Cuna refused an invalid HTTP credential authority.",
            exitCode: EXIT_CODES.internal,
            hint: INTERNAL_DEFECT_HINT,
          });
        }
        // The response-observation budget starts at dispatch. Credential
        // acquisition is a distinct local security boundary and may wait for
        // another healthy CLI process to finish a revision-fenced refresh.
        // The caller's AbortSignal remains live throughout both phases.
        timeout = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), budgetMs);
        const dispatch = async (bearer: string | undefined): Promise<unknown> => {
          const response = await fetcher(target, {
            method: request.method,
            headers: {
              Accept: "application/json, application/problem+json",
              ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
              "User-Agent": `cuna-cli/${CLI_VERSION}`,
              ...(contentType === undefined ? {} : { "Content-Type": contentType }),
              ...(contentLength === undefined ? {} : { "Content-Length": String(contentLength) }),
              ...(request.idempotencyKey === undefined ? {} : { "Idempotency-Key": request.idempotencyKey }),
              ...(request.machineCreateRequestId === undefined
                ? {}
                : { "X-Cuna-Machine-Create-Request-Id": request.machineCreateRequestId }),
            },
            ...(body === undefined ? {} : { body }),
            signal: controller.signal,
            redirect: "error",
          });
          const bytes = await readLimited(response);
          if (!response.ok) {
            const decoded = decodeJson(bytes);
            throw apiError({
              status: response.status,
              requestId: response.headers.get("x-request-id") ?? undefined,
              body: decoded.decoded ? decoded.value : undefined,
              apiEncodedBody: decoded.decoded && isObject(decoded.value),
              credentialKind,
              method: request.method,
              path: request.path,
              origin: input.baseUrl,
            });
          }
          return parseJson(bytes, request);
        };
        try {
          return await dispatch(requestCredential);
        } catch (error) {
          const canRetryUnauthorized = error instanceof CunaError &&
            error.code === "cuna.auth.rejected" &&
            input.bearerTokenProvider !== undefined &&
            requestCredential !== undefined &&
            (request.method === "GET" ||
              (request.idempotencyKey !== undefined && isIdempotencyKey(request.idempotencyKey)));
          if (!canRetryUnauthorized) throw error;
          const refreshedCredential = await input.bearerTokenProvider(controller.signal, {
            reason: "unauthorized",
            rejectedToken: requestCredential,
          });
          if (!isAccessToken(refreshedCredential)) {
            throw new CunaError({
              code: "cuna.internal.invalid_transport_credential",
              message: "Cuna refused an invalid refreshed HTTP credential authority.",
              exitCode: EXIT_CODES.internal,
              hint: INTERNAL_DEFECT_HINT,
            });
          }
          // Deliberately outside a retry loop: a second 401 is authoritative.
          // The same serialized body and Idempotency-Key are reused verbatim.
          return await dispatch(refreshedCredential);
        }
      } catch (error) {
        if (error instanceof CunaError) throw error;
        // Token acquisition is a local credential boundary, not a network
        // dispatch. Preserve its typed failure so the CLI can name the exact
        // authentication repair instead of misreporting connectivity.
        if (error instanceof CredentialBoundaryError) throw error;
        if (controller.signal.aborted) {
          // TWO DIFFERENT DETECTORS ARRIVE AT THIS ONE BRANCH, and collapsing
          // them is the defect. The caller pressing Ctrl-C is a decision by a
          // person; this process's own `setTimeout` firing is a decision by
          // this process's configuration. Only the first is `cancelled`.
          //
          // Read through a binding rather than compared inline: the pre-dispatch
          // guard above narrowed `request.signal?.aborted` to `false | undefined`
          // for the rest of the function, and the whole point here is that it may
          // have become `true` in the meantime.
          const cancelledByCaller: boolean = request.signal?.aborted ?? false;
          if (cancelledByCaller) {
            throw new CunaError({
              code: "cuna.network.cancelled",
              message: "The Cuna request was cancelled.",
              exitCode: EXIT_CODES.network,
              hint: "No authoritative answer was received, so a mutating request may still have been applied.",
              retryable: false,
              cause: error,
            });
          }
          // Named `cuna.network.timeout` until 2026-08-19, which named the
          // network. The network was fine: `cuna machines create` reported it
          // for a machine that reached `running` five seconds later. What
          // elapsed was this budget.
          throw observationBudgetElapsed({
            kind: "response",
            operation: `${request.method} ${request.path}`,
            budgetMs,
            ...(request.settleWith === undefined ? {} : { settleWith: request.settleWith }),
            details: { method: request.method, path: request.path },
            cause: error,
          });
        }
        throw new CunaError({
          code: "cuna.network.failed",
          message: "The Cuna request failed before an authoritative result was received.",
          exitCode: EXIT_CODES.network,
          hint: "Check connectivity to the API origin shown by `cuna config get`. A mutating request may still have been applied.",
          retryable: isRetryableAfterUnknownDispatch(request),
          cause: error,
        });
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        request.signal?.removeEventListener("abort", onAbort);
      }
    },
  });
}
