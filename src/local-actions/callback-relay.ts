import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { assertLoopbackHost, assertPort, isLoopbackPeer, type LoopbackHost } from "./loopback.js";

const MAX_REQUEST_TARGET_BYTES = 8 * 1024;
const MAX_CALLBACK_VALUE_BYTES = 8 * 1024;

export type CallbackRelayProvider = "codex" | "opencode";

export interface AcceptedProviderCallback {
  readonly provider: CallbackRelayProvider;
  readonly state: string;
  readonly code?: string;
  readonly error?: string;
}

export interface CallbackRelayReceipt {
  readonly outcome: "relayed";
  readonly acceptedAt: number;
}

export interface CallbackRelayHandle {
  readonly host: LoopbackHost;
  readonly port: number;
  readonly completion: Promise<CallbackRelayReceipt>;
  close(reason?: string): Promise<void>;
}

export interface CallbackRelayServerFactory {
  create(handler: (request: IncomingMessage, response: ServerResponse) => void): Server;
}

export interface CallbackRelayOptions {
  readonly provider: CallbackRelayProvider;
  readonly localHost: LoopbackHost;
  readonly exactLocalPort: number;
  readonly localPath: string;
  readonly expectedStateDigest: `sha256:${string}`;
  readonly expectedNonceDigest: `sha256:${string}`;
  /** Envelope nonce; it is never accepted from or returned to the browser. */
  readonly requestNonce: string;
  readonly deadlineMs: number;
  readonly maxAttempts: number;
  readonly maxConnections: number;
  readonly relay: (callback: AcceptedProviderCallback, signal: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly serverFactory?: CallbackRelayServerFactory;
}

export class CallbackRelayError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "CallbackRelayError";
  }
}

export async function startCallbackRelay(options: CallbackRelayOptions): Promise<CallbackRelayHandle> {
  validateOptions(options);
  const now = options.now ?? Date.now;
  if (isAborted(options.signal)) throw new CallbackRelayError("cancelled", "Callback relay was cancelled before it started.");
  if (now() >= options.deadlineMs) throw new CallbackRelayError("expired", "Callback relay deadline has elapsed.");

  const controller = new AbortController();
  let settled = false;
  let consumed = false;
  let attempts = 0;
  let totalConnections = 0;
  let resolveCompletion!: (receipt: CallbackRelayReceipt) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<CallbackRelayReceipt>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const factory = options.serverFactory ?? {
    create: (handler) => createServer({ maxHeaderSize: MAX_REQUEST_TARGET_BYTES }, handler),
  };
  const server = factory.create((request, response) => {
    attempts += 1;
    if (consumed) {
      fixedResponse(response, 410, "Callback already consumed.");
      return;
    }
    if (now() >= options.deadlineMs) {
      fixedResponse(response, 410, "Callback relay expired.");
      void fail("expired", "Callback relay deadline elapsed.");
      return;
    }
    if (attempts > options.maxAttempts) {
      fixedResponse(response, 429, "Callback attempt limit reached.");
      void fail("attempt_limit", "Callback attempt limit reached.");
      return;
    }
    const admitted = admitCallbackRequest(request, options);
    if (admitted === undefined) {
      fixedResponse(response, 400, "Invalid callback request.");
      return;
    }

    // The one-shot authority is consumed synchronously, before the first await.
    // This prevents two requests in the same event-loop turn from both relaying.
    consumed = true;
    fixedResponse(response, 202, "Callback received. You can return to Cuna.");
    server.close();
    void options.relay(admitted, controller.signal).then(
      () => succeed(),
      () => fail("relay_failed", "The provider callback could not be relayed."),
    );
  });
  server.on("connection", (socket) => {
    totalConnections += 1;
    if (totalConnections > options.maxConnections || !isLoopbackPeer(socket.remoteAddress)) {
      socket.destroy();
      if (totalConnections > options.maxConnections) void fail("connection_limit", "Callback connection limit reached.");
    }
  });

  let deadlineTimer: NodeJS.Timeout | undefined;
  let abortRegistered = false;
  const abortListener = (): void => { void fail("cancelled", "Callback relay was cancelled."); };

  function cleanup(): Promise<void> {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (abortRegistered) options.signal?.removeEventListener("abort", abortListener);
    controller.abort();
    return closeServer(server);
  }

  async function fail(code: string, message: string): Promise<void> {
    if (settled) return;
    settled = true;
    await cleanup();
    rejectCompletion(new CallbackRelayError(code, message));
  }

  function succeed(): void {
    if (settled) return;
    settled = true;
    const acceptedAt = now();
    void cleanup().then(() => resolveCompletion(Object.freeze({ outcome: "relayed", acceptedAt })));
  }

  try {
    await listen(server, options.exactLocalPort, options.localHost);
  } catch (error) {
    await cleanup();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string" || address.port !== options.exactLocalPort) {
    await cleanup();
    throw new CallbackRelayError("bind_mismatch", "Callback relay did not bind the exact requested port.");
  }
  if (isAborted(options.signal) || now() >= options.deadlineMs) {
    await cleanup();
    throw new CallbackRelayError(isAborted(options.signal) ? "cancelled" : "expired", "Callback relay authority ended while binding.");
  }
  deadlineTimer = setTimeout(() => {
    void fail("expired", "Callback relay deadline elapsed.");
  }, Math.max(1, options.deadlineMs - now()));
  deadlineTimer.unref();
  options.signal?.addEventListener("abort", abortListener, { once: true });
  abortRegistered = options.signal !== undefined;

  return Object.freeze({
    host: options.localHost,
    port: address.port,
    completion,
    close: async (reason = "cancelled") => {
      await fail("cancelled", reason);
    },
  });
}

function admitCallbackRequest(
  request: IncomingMessage,
  options: CallbackRelayOptions,
): AcceptedProviderCallback | undefined {
  if (request.method !== "GET" || !isLoopbackPeer(request.socket.remoteAddress)) return undefined;
  const target = request.url;
  if (target === undefined || Buffer.byteLength(target, "utf8") > MAX_REQUEST_TARGET_BYTES || target.includes("#")) return undefined;
  if (request.socket.localPort !== options.exactLocalPort || !sameBoundLoopback(request.socket.localAddress, options.localHost) ||
    !exactHostHeader(request, options.localHost, options.exactLocalPort) || request.headers["content-length"] !== undefined ||
    request.headers["transfer-encoding"] !== undefined) return undefined;
  const queryOffset = target.indexOf("?");
  if (queryOffset <= 0 || target.slice(0, queryOffset) !== options.localPath || target.indexOf("?", queryOffset + 1) !== -1) return undefined;
  const parameters = parseStrictQuery(target.slice(queryOffset + 1));
  if (parameters === undefined || parameters.size !== 2 || !parameters.has("state") ||
    (parameters.has("code") === parameters.has("error"))) return undefined;
  const state = parameters.get("state");
  const code = parameters.get("code");
  const providerError = parameters.get("error");
  if (state === undefined || !boundedValue(state) || !digestMatches(state, options.expectedStateDigest) ||
    (code !== undefined && !boundedValue(code)) || (providerError !== undefined && !boundedValue(providerError))) return undefined;
  return Object.freeze({
    provider: options.provider,
    state,
    ...(code === undefined ? {} : { code }),
    ...(providerError === undefined ? {} : { error: providerError }),
  });
}

function validateOptions(options: CallbackRelayOptions): void {
  assertLoopbackHost(options.localHost, "Callback relay host");
  assertPort(options.exactLocalPort, "Callback relay port");
  if (!/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/u.test(options.localPath)) {
    throw new TypeError("Callback path must be an exact absolute path without traversal, query, or fragment.");
  }
  if (!digestShape(options.expectedStateDigest) || !digestShape(options.expectedNonceDigest)) {
    throw new TypeError("Callback state and nonce digests must be SHA-256 digests.");
  }
  if (!boundedValue(options.requestNonce) || !digestMatches(options.requestNonce, options.expectedNonceDigest)) {
    throw new TypeError("Callback relay nonce does not match its approved envelope digest.");
  }
  if (!Number.isSafeInteger(options.deadlineMs) || !Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1 ||
    !Number.isSafeInteger(options.maxConnections) || options.maxConnections < 1 || options.maxConnections > 32) {
    throw new TypeError("Callback relay bounds are invalid.");
  }
}

function digestShape(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

function digestMatches(value: string, expected: string): boolean {
  const actual = Buffer.from(createHash("sha256").update(value, "utf8").digest("hex"), "ascii");
  const wanted = Buffer.from(expected.slice("sha256:".length), "ascii");
  return actual.byteLength === wanted.byteLength && timingSafeEqual(actual, wanted);
}

function boundedValue(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= MAX_CALLBACK_VALUE_BYTES;
}

function parseStrictQuery(raw: string): ReadonlyMap<string, string> | undefined {
  const parsed = new Map<string, string>();
  const pairs = raw.split("&");
  if (pairs.length !== 2) return undefined;
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator < 1) return undefined;
    const key = pair.slice(0, separator);
    const encodedValue = pair.slice(separator + 1);
    if ((key !== "state" && key !== "code" && key !== "error") || parsed.has(key) || !strictPercentEncoding(encodedValue)) return undefined;
    let value: string;
    try { value = decodeURIComponent(encodedValue); } catch { return undefined; }
    if (!boundedValue(value)) return undefined;
    parsed.set(key, value);
  }
  return parsed;
}

function strictPercentEncoding(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "%") continue;
    if (index + 2 >= value.length || !/^[0-9A-Fa-f]{2}$/u.test(value.slice(index + 1, index + 3))) return false;
    index += 2;
  }
  return true;
}

function exactHostHeader(request: IncomingMessage, host: LoopbackHost, port: number): boolean {
  let hostCount = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "host") hostCount += 1;
  }
  const expected = `${host === "::1" ? "[::1]" : host}:${port}`;
  return hostCount === 1 && request.headers.host === expected;
}

function sameBoundLoopback(actual: string | undefined, expected: LoopbackHost): boolean {
  return actual === expected || (expected === "127.0.0.1" && actual === "::ffff:127.0.0.1");
}

function fixedResponse(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function listen(server: Server, port: number, host: LoopbackHost): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { server.off("listening", onListening); reject(error); };
    const onListening = (): void => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port, exclusive: true });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    if (!server.listening) { resolve(); return; }
    server.close(() => resolve());
  });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
