import { timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { EXIT_CODES, RunaError } from "../core/errors.js";

export type LoopbackHost = "127.0.0.1" | "::1";

export interface LoopbackAuthorizationResult {
  readonly code: string;
}

export interface LoopbackCallback {
  readonly redirectUri: string;
  readonly completion: Promise<LoopbackAuthorizationResult>;
  cancel(): void;
}

const CALLBACK_BODY = "Runa received the authorization response. You may close this tab.";

function authError(code: string, message: string, retryable = false): RunaError {
  return new RunaError({ code, message, exitCode: EXIT_CODES.auth, retryable });
}

function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function finishResponse(response: ServerResponse, status: number): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    Connection: "close",
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(CALLBACK_BODY);
}

function validateCallbackPath(path: string): string {
  if (!/^\/[A-Za-z0-9/_-]{1,120}$/u.test(path) || path.includes("//") || path.includes("..")) {
    throw new TypeError("Invalid loopback callback path.");
  }
  return path;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

/**
 * Starts a one-response OAuth callback on a numeric loopback address and an
 * ephemeral port. Every terminal outcome closes the listener. Browser content
 * is never accepted as proof beyond the bound state/code handoff.
 */
export async function startLoopbackCallback(input: {
  readonly expectedState: string;
  readonly timeoutMs: number;
  readonly host?: LoopbackHost;
  readonly path?: string;
  readonly signal?: AbortSignal;
}): Promise<LoopbackCallback> {
  if (input.expectedState.length < 32 || input.expectedState.length > 512) {
    throw new TypeError("Invalid OAuth state length.");
  }
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 10 || input.timeoutMs > 10 * 60_000) {
    throw new TypeError("Invalid OAuth callback timeout.");
  }
  const host = input.host ?? "127.0.0.1";
  const path = validateCallbackPath(input.path ?? "/oauth/callback");

  let resolveCompletion!: (value: LoopbackAuthorizationResult) => void;
  let rejectCompletion!: (reason: RunaError) => void;
  const completion = new Promise<LoopbackAuthorizationResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  const server = createServer((request, response) => {
    if (settled) {
      finishResponse(response, 410);
      return;
    }
    const settle = (result: LoopbackAuthorizationResult | RunaError, status: number): void => {
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      finishResponse(response, status);
      server.close();
      input.signal?.removeEventListener("abort", cancel);
      if (result instanceof RunaError) rejectCompletion(result);
      else resolveCompletion(Object.freeze(result));
    };

    if (request.method !== "GET" || request.url === undefined) {
      settle(authError("runa.auth.callback_invalid", "Runa rejected an invalid authorization callback."), 400);
      return;
    }
    const target = new URL(request.url, `http://${host === "::1" ? "[::1]" : host}`);
    const keys = [...target.searchParams.keys()];
    if (
      target.pathname !== path ||
      keys.some((key) => !["code", "state", "error"].includes(key)) ||
      ["code", "state", "error"].some((key) => target.searchParams.getAll(key).length > 1)
    ) {
      settle(authError("runa.auth.callback_invalid", "Runa rejected an invalid authorization callback."), 400);
      return;
    }
    const state = target.searchParams.get("state");
    if (state === null || !sameSecret(state, input.expectedState)) {
      settle(authError("runa.auth.state_mismatch", "Runa rejected an authorization response with invalid state."), 400);
      return;
    }
    const providerError = target.searchParams.get("error");
    const code = target.searchParams.get("code");
    if (providerError !== null) {
      settle(authError("runa.auth.authorization_rejected", "The Runa authorization request was not approved."), 400);
      return;
    }
    if (code === null || code.length < 1 || code.length > 4096 || containsControlCharacter(code)) {
      settle(authError("runa.auth.code_invalid", "Runa rejected an invalid authorization code."), 400);
      return;
    }
    settle({ code }, 200);
  });

  const cancel = (): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    server.close();
    input.signal?.removeEventListener("abort", cancel);
    rejectCompletion(authError("runa.auth.cancelled", "Runa authorization was cancelled."));
  };

  await new Promise<void>((resolve, reject) => {
    const onError = (cause: Error): void => {
      server.removeListener("listening", onListening);
      reject(cause);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port: 0, exclusive: true });
  });

  const address = server.address() as AddressInfo | null;
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Loopback listener did not expose a numeric address.");
  }
  server.on("error", () => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    input.signal?.removeEventListener("abort", cancel);
    rejectCompletion(authError("runa.auth.callback_unavailable", "The local Runa authorization callback became unavailable.", true));
  });
  timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    server.close();
    input.signal?.removeEventListener("abort", cancel);
    rejectCompletion(authError("runa.auth.timeout", "Runa authorization timed out.", true));
  }, input.timeoutMs);
  timer.unref();
  input.signal?.addEventListener("abort", cancel, { once: true });
  if (input.signal?.aborted === true) cancel();

  const literalHost = host === "::1" ? "[::1]" : host;
  return Object.freeze({
    redirectUri: `http://${literalHost}:${address.port}${path}`,
    completion,
    cancel,
  });
}
