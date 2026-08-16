import { runtimeFailure } from "./errors.js";
import { DEPLOYED_WIRE_COMPATIBILITY } from "../core/deployed-wire-compatibility.js";
import type {
  TerminalConnector,
  TerminalWireConnection,
} from "./terminal-transport.js";

const MAX_MESSAGE_BYTES = 1_048_596;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_MESSAGES = 1_024;
const MAX_BUFFERED_SEND_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_CONVERSION_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_CONVERSION_MESSAGES = 64;
const DEFAULT_CONVERSION_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

interface ByteWaiter {
  readonly resolve: (result: IteratorResult<Uint8Array>) => void;
  readonly reject: (error: unknown) => void;
}

class BoundedByteQueue implements AsyncIterableIterator<Uint8Array> {
  readonly #values: Uint8Array[] = [];
  readonly #waiters: ByteWaiter[] = [];
  #queuedBytes = 0;
  #closed = false;
  #failure: unknown;

  push(value: Uint8Array): void {
    if (this.#closed) return;
    if (value.byteLength < 1 || value.byteLength > MAX_MESSAGE_BYTES) {
      throw runtimeFailure("terminal_protocol_error", "The terminal transport message is outside the bounded frame window.");
    }
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value });
      return;
    }
    if (this.#queuedBytes + value.byteLength > MAX_QUEUED_BYTES) {
      throw runtimeFailure("terminal_protocol_error", "The terminal receive queue exceeded its bounded memory budget.");
    }
    if (this.#values.length >= MAX_QUEUED_MESSAGES) {
      throw runtimeFailure("terminal_protocol_error", "The terminal receive queue exceeded its bounded message budget.");
    }
    this.#values.push(value);
    this.#queuedBytes += value.byteLength;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#failure = error;
    this.#closed = true;
    this.#values.length = 0;
    this.#queuedBytes = 0;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this;
  }

  next(): Promise<IteratorResult<Uint8Array>> {
    const value = this.#values.shift();
    if (value !== undefined) {
      this.#queuedBytes -= value.byteLength;
      return Promise.resolve({ done: false, value });
    }
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }
}

function terminalSessionId(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw runtimeFailure("grant_invalid", "The terminal WebSocket URL is malformed.");
  }
  const match = /^\/v1\/terminal-connections\/([^/]+)\/stream$/u.exec(parsed.pathname);
  const id = match?.[1];
  if (id === undefined || !UUID.test(id)) {
    throw runtimeFailure("grant_invalid", "The terminal WebSocket URL has no canonical Cuna terminal session.");
  }
  return id;
}

async function messageBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  throw runtimeFailure("terminal_protocol_error", "The terminal transport received a non-binary message.");
}

function messageByteLength(data: unknown): number {
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  throw runtimeFailure("terminal_protocol_error", "The terminal transport received a non-binary message.");
}

export function createNodeWebSocketConnector(input: {
  readonly WebSocket?: typeof WebSocket;
  readonly conversionTimeoutMs?: number;
} = {}): TerminalConnector {
  const WebSocketAuthority = input.WebSocket ?? globalThis.WebSocket;
  if (WebSocketAuthority === undefined) {
    return Object.freeze({
      async connect(): Promise<never> {
        throw runtimeFailure("control_plane_unavailable", "This Node runtime has no approved WebSocket client.");
      },
    });
  }
  const conversionTimeoutMs = input.conversionTimeoutMs ?? DEFAULT_CONVERSION_TIMEOUT_MS;
  if (!Number.isSafeInteger(conversionTimeoutMs) || conversionTimeoutMs < 1 || conversionTimeoutMs > 60_000) {
    throw new RangeError("Terminal message conversion timeout must be between 1 and 60000 milliseconds.");
  }
  return Object.freeze({
    async connect(
      request: Parameters<TerminalConnector["connect"]>[0],
    ): Promise<TerminalWireConnection> {
      if (request.signal?.aborted) {
        throw runtimeFailure("terminal_disconnected", "Terminal attachment was cancelled before network dispatch.");
      }
      const connectionId = terminalSessionId(request.url);
      const authProtocol = `${DEPLOYED_WIRE_COMPATIBILITY.websocketAuthPrefix}${request.token}`;
      let socket: WebSocket;
      try {
        socket = new WebSocketAuthority(request.url, [request.protocol, authProtocol]);
      } catch (error) {
        throw runtimeFailure("terminal_disconnected", "Cuna could not start the terminal WebSocket handshake.", {
          retryable: true,
          cause: error,
        });
      }
      socket.binaryType = "arraybuffer";
      const queue = new BoundedByteQueue();
      let opened = false;
      let closed = false;
      let messageTail: Promise<void> = Promise.resolve();
      let pendingConversionBytes = 0;
      let pendingConversionMessages = 0;
      let discardPendingConversions = false;

      const closeSocket = (code: number, reason: string): void => {
        if (closed) return;
        closed = true;
        try { socket.close(code, reason); } catch { /* the transport is already unusable */ }
      };

      const onMessage = (event: MessageEvent): void => {
        if (closed || discardPendingConversions) return;
        let expectedBytes: number;
        try {
          expectedBytes = messageByteLength(event.data);
        } catch (error) {
          discardPendingConversions = true;
          queue.fail(error);
          closeSocket(1003, "cuna_binary_required");
          return;
        }
        try {
          if (expectedBytes < 1 || expectedBytes > MAX_MESSAGE_BYTES) {
            throw runtimeFailure("terminal_protocol_error", "The terminal transport message is outside the bounded frame window.");
          }
          if (
            pendingConversionBytes + expectedBytes > MAX_PENDING_CONVERSION_BYTES ||
            pendingConversionMessages + 1 > MAX_PENDING_CONVERSION_MESSAGES
          ) {
            throw runtimeFailure("terminal_protocol_error", "The terminal conversion queue exceeded its bounded memory budget.");
          }
        } catch (error) {
          discardPendingConversions = true;
          queue.fail(error);
          closeSocket(1009, "cuna_frame_queue_limit");
          return;
        }
        pendingConversionBytes += expectedBytes;
        pendingConversionMessages += 1;
        messageTail = messageTail.then(async () => {
          try {
            if (discardPendingConversions) return;
            const bytes = await withConversionDeadline(messageBytes(event.data), conversionTimeoutMs);
            if (bytes.byteLength !== expectedBytes) {
              throw runtimeFailure("terminal_protocol_error", "The terminal transport message changed size during conversion.");
            }
            queue.push(bytes);
          } catch (error) {
            discardPendingConversions = true;
            queue.fail(error);
            closeSocket(1003, "cuna_binary_required");
          } finally {
            pendingConversionBytes -= expectedBytes;
            pendingConversionMessages -= 1;
          }
        });
      };
      const cleanupActive = (): void => {
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", onClose);
        socket.removeEventListener("error", onTransportError);
        request.signal?.removeEventListener("abort", onActiveAbort);
      };
      const onClose = (): void => {
        closed = true;
        cleanupActive();
        void messageTail.then(
          () => queue.close(),
          (error) => queue.fail(error),
        );
      };
      const onTransportError = (): void => {
        discardPendingConversions = true;
        queue.fail(runtimeFailure("terminal_disconnected", "The terminal WebSocket transport failed.", { retryable: true }));
        closeSocket(1011, "cuna_transport_failure");
      };
      const onActiveAbort = (): void => {
        discardPendingConversions = true;
        queue.fail(runtimeFailure("terminal_disconnected", "Terminal attachment was cancelled."));
        closeSocket(1000, "cuna_cancelled");
      };
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onTransportError);

      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("close", onEarlyClose);
          socket.removeEventListener("error", onEarlyError);
          request.signal?.removeEventListener("abort", onAbort);
        };
        const onOpen = (): void => {
          cleanup();
          if (socket.protocol !== request.protocol) {
            closeSocket(1002, "cuna_protocol_mismatch");
            reject(runtimeFailure("terminal_protocol_error", "The terminal WebSocket negotiated an unexpected protocol."));
            return;
          }
          opened = true;
          resolve();
        };
        const onEarlyClose = (): void => {
          if (opened) return;
          cleanup();
          reject(runtimeFailure("terminal_disconnected", "The terminal WebSocket closed before negotiation completed.", { retryable: true }));
        };
        const onEarlyError = (): void => {
          if (opened) return;
          cleanup();
          reject(runtimeFailure("terminal_disconnected", "The terminal WebSocket failed before negotiation completed.", { retryable: true }));
        };
        const onAbort = (): void => {
          cleanup();
          closeSocket(1000, "cuna_cancelled");
          reject(runtimeFailure("terminal_disconnected", "Terminal attachment was cancelled."));
        };
        socket.addEventListener("open", onOpen);
        socket.addEventListener("close", onEarlyClose);
        socket.addEventListener("error", onEarlyError);
        request.signal?.addEventListener("abort", onAbort, { once: true });
      });
      request.signal?.addEventListener("abort", onActiveAbort, { once: true });
      if (request.signal?.aborted) {
        onActiveAbort();
        throw runtimeFailure("terminal_disconnected", "Terminal attachment was cancelled.");
      }

      return Object.freeze({
        connectionId,
        receive: () => queue,
        async send(bytes: Uint8Array): Promise<void> {
          if (closed || socket.readyState !== WebSocketAuthority.OPEN) {
            throw runtimeFailure("terminal_disconnected", "The terminal WebSocket is not open.");
          }
          if (socket.bufferedAmount + bytes.byteLength > MAX_BUFFERED_SEND_BYTES) {
            closeSocket(1011, "cuna_backpressure_limit");
            throw runtimeFailure("terminal_disconnected", "The terminal send queue exceeded its bounded memory budget.", { retryable: true });
          }
          socket.send(bytes.slice());
        },
        async close(closeInput: { readonly code?: number; readonly reason?: string } = {}): Promise<void> {
          cleanupActive();
          queue.close();
          closeSocket(closeInput.code ?? 1000, closeInput.reason ?? "cuna_closed");
        },
      });
    },
  });
}

async function withConversionDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(runtimeFailure(
          "terminal_protocol_error",
          "The terminal message conversion exceeded its bounded deadline.",
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
