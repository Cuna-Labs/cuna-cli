import { createHash, randomBytes } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { resolve } from "node:path";

const PROTOCOL = "RUNA_EXCLUSIVE_BUILD_V1";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const HANDSHAKE_TIMEOUT_MS = 2_000;

export class BuildLockError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "BuildLockError";
    this.code = code;
  }
}

function canonicalRoot(repositoryRoot, platform = process.platform) {
  const root = resolve(repositoryRoot).replaceAll("\\", "/");
  return platform === "win32" ? root.toLowerCase() : root;
}

export function buildLockIdentity(repositoryRoot, platform = process.platform) {
  return createHash("sha256").update(canonicalRoot(repositoryRoot, platform), "utf8").digest("hex");
}

export function buildLockEndpoint(repositoryRoot, platform = process.platform) {
  const identity = buildLockIdentity(repositoryRoot, platform);
  if (platform === "win32") return `\\\\.\\pipe\\runa-cli-build-${identity}`;
  // Loopback sockets are kernel-owned and disappear on process death. A full
  // identity handshake turns the small deterministic port space into a
  // fail-closed collision, never an excuse to steal or delete another lock.
  return Object.freeze({
    host: "127.0.0.1",
    port: 30_000 + (Number.parseInt(identity.slice(0, 8), 16) % 10_000),
    exclusive: true,
  });
}

function listen(server, endpoint) {
  return new Promise((resolveListen, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

function closeServer(server) {
  return new Promise((resolveClose, reject) => {
    server.close((error) => error === undefined ? resolveClose() : reject(error));
  });
}

function waitForOwner(endpoint, expectedGreeting, deadline) {
  return new Promise((resolveWait, reject) => {
    const socket = createConnection(endpoint);
    let settled = false;
    let authenticated = false;
    let buffer = "";
    const remaining = Math.max(1, deadline - Date.now());
    const timeout = setTimeout(() => {
      finish(new BuildLockError("build_lock_timeout", "Timed out waiting for the active build/test operation."));
    }, remaining);
    const handshakeTimeout = setTimeout(() => {
      if (!authenticated) {
        finish(new BuildLockError("build_lock_collision", "The build lock endpoint is owned by an unrecognized local service."));
      }
    }, Math.min(HANDSHAKE_TIMEOUT_MS, remaining));

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(handshakeTimeout);
      socket.destroy();
      if (error === undefined) resolveWait();
      else reject(error);
    }

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      if (authenticated) return;
      buffer += chunk;
      if (buffer.length > 512) {
        finish(new BuildLockError("build_lock_collision", "The build lock handshake exceeded its safe bound."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      if (buffer.slice(0, newline) !== expectedGreeting) {
        finish(new BuildLockError("build_lock_collision", "The build lock endpoint identity does not match this repository."));
        return;
      }
      authenticated = true;
      clearTimeout(handshakeTimeout);
    });
    socket.once("end", () => finish());
    socket.once("close", () => {
      if (authenticated) finish();
    });
    socket.once("error", (error) => {
      if (error?.code === "ECONNREFUSED" || error?.code === "ENOENT" || error?.code === "EPIPE") {
        finish();
        return;
      }
      finish(new BuildLockError("build_lock_io", "Could not observe the active build lock.", { cause: error }));
    });
  });
}

export async function acquireExclusiveBuildLock(repositoryRoot, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new BuildLockError("build_lock_invalid", `Build lock timeout must be between 1 and ${DEFAULT_TIMEOUT_MS} milliseconds.`);
  }
  const platform = options.platform ?? process.platform;
  const identity = buildLockIdentity(repositoryRoot, platform);
  const endpoint = options.endpoint ?? buildLockEndpoint(repositoryRoot, platform);
  const ownerNonce = randomBytes(24).toString("base64url");
  const greeting = `${PROTOCOL} ${identity}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const peers = new Set();
    const server = createServer((socket) => {
      peers.add(socket);
      socket.once("close", () => peers.delete(socket));
      socket.on("error", () => {
        // A waiter may time out or be terminated while the owner remains valid.
        // The kernel-held listening endpoint, not an individual peer, is the lock.
      });
      socket.write(`${greeting}\n${ownerNonce}\n`);
    });
    try {
      await listen(server, endpoint);
      let released = false;
      return Object.freeze({
        identity,
        async release() {
          if (released) return;
          released = true;
          for (const peer of peers) peer.destroy();
          await closeServer(server);
        },
      });
    } catch (error) {
      server.close();
      if (error?.code !== "EADDRINUSE") {
        throw new BuildLockError("build_lock_io", "Could not acquire the build lock.", { cause: error });
      }
      await waitForOwner(endpoint, greeting, deadline);
    }
  }
  throw new BuildLockError("build_lock_timeout", "Timed out waiting for the active build/test operation.");
}
