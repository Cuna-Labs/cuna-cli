import { createServer, createConnection, type Server, type Socket } from "node:net";

import { assertLoopbackHost, assertPort, isLoopbackPeer, type LoopbackHost } from "./loopback.js";

export interface PrivateForwardTarget {
  readonly host: LoopbackHost;
  readonly port: number;
}

export interface PrivateForwardConnector {
  connect(target: PrivateForwardTarget): Socket;
}

export interface PrivatePortForwardHandle {
  readonly localHost: LoopbackHost;
  readonly localPort: number;
  readonly remoteHost: LoopbackHost;
  readonly remotePort: number;
  readonly closed: Promise<void>;
  readonly transferredBytes: () => number;
  close(): Promise<void>;
}

export interface PrivatePortForwardOptions {
  readonly localHost: LoopbackHost;
  readonly requestedLocalPort: number;
  readonly remoteHost: LoopbackHost;
  readonly remotePort: number;
  readonly deadlineMs: number;
  readonly maximumConnections: number;
  readonly maximumBytes: number;
  readonly connector?: PrivateForwardConnector;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export class PrivatePortForwardError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PrivatePortForwardError";
  }
}

export async function startPrivatePortForward(options: PrivatePortForwardOptions): Promise<PrivatePortForwardHandle> {
  validateOptions(options);
  const now = options.now ?? Date.now;
  if (isAborted(options.signal)) throw new PrivatePortForwardError("cancelled", "Private port forward was cancelled before it started.");
  if (now() >= options.deadlineMs) throw new PrivatePortForwardError("expired", "Private port forward deadline elapsed.");

  const connector = options.connector ?? {
    connect: (target) => createConnection({ host: target.host, port: target.port }),
  };
  const sockets = new Set<Socket>();
  let activeConnections = 0;
  let bytes = 0;
  let closing: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });

  const server = createServer((local) => {
    if (!isLoopbackPeer(local.remoteAddress) || activeConnections >= options.maximumConnections) {
      local.destroy();
      return;
    }
    activeConnections += 1;
    sockets.add(local);
    let remote: Socket;
    try {
      remote = connector.connect(Object.freeze({ host: options.remoteHost, port: options.remotePort }));
    } catch {
      local.destroy();
      activeConnections -= 1;
      sockets.delete(local);
      return;
    }
    sockets.add(remote);
    let connectionClosed = false;
    const finishConnection = (): void => {
      if (connectionClosed) return;
      connectionClosed = true;
      activeConnections -= 1;
      sockets.delete(local);
      sockets.delete(remote);
      local.destroy();
      remote.destroy();
    };
    const account = (chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > options.maximumBytes) void close();
    };
    local.on("data", account);
    remote.on("data", account);
    local.once("error", finishConnection);
    remote.once("error", finishConnection);
    local.once("close", finishConnection);
    remote.once("close", finishConnection);
    local.pipe(remote);
    remote.pipe(local);
  });
  server.on("connection", (socket) => {
    if (!isLoopbackPeer(socket.remoteAddress)) socket.destroy();
  });

  let deadlineTimer: NodeJS.Timeout | undefined;
  let abortRegistered = false;
  const abortListener = (): void => { void close(); };

  async function close(): Promise<void> {
    if (closing !== undefined) return closing;
    closing = (async () => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (abortRegistered) options.signal?.removeEventListener("abort", abortListener);
      await closeAll(server, sockets);
      resolveClosed();
    })();
    return closing;
  }

  try {
    await listen(server, options.requestedLocalPort, options.localHost);
  } catch (error) {
    await close();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    await close();
    throw new PrivatePortForwardError("bind_failed", "Private port forward did not bind a TCP address.");
  }
  if (isAborted(options.signal) || now() >= options.deadlineMs) {
    await close();
    throw new PrivatePortForwardError(isAborted(options.signal) ? "cancelled" : "expired", "Private port forward authority ended while binding.");
  }
  deadlineTimer = setTimeout(() => { void close(); }, Math.max(1, options.deadlineMs - now()));
  deadlineTimer.unref();
  options.signal?.addEventListener("abort", abortListener, { once: true });
  abortRegistered = options.signal !== undefined;

  return Object.freeze({
    localHost: options.localHost,
    localPort: address.port,
    remoteHost: options.remoteHost,
    remotePort: options.remotePort,
    closed,
    transferredBytes: () => bytes,
    close,
  });
}

function validateOptions(options: PrivatePortForwardOptions): void {
  assertLoopbackHost(options.localHost, "Private forward local host");
  assertPort(options.requestedLocalPort, "Private forward local port", true);
  assertLoopbackHost(options.remoteHost, "Private forward remote host");
  assertPort(options.remotePort, "Private forward remote port");
  if (!Number.isSafeInteger(options.deadlineMs) || !Number.isSafeInteger(options.maximumConnections) ||
    options.maximumConnections < 1 || options.maximumConnections > 128 || !Number.isSafeInteger(options.maximumBytes) ||
    options.maximumBytes < 1 || options.maximumBytes > 1_073_741_824) {
    throw new TypeError("Private port forward bounds are invalid.");
  }
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

function closeAll(server: Server, sockets: ReadonlySet<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve) => {
    if (!server.listening) { resolve(); return; }
    server.close(() => resolve());
  });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
