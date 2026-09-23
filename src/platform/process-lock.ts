import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rename, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * An exclusive lock the OPERATING SYSTEM holds for this process: a listening
 * named pipe on Windows, a listening Unix socket in a private per-user
 * directory elsewhere. Only one process can listen on a name, and the kernel
 * stops listening when the process ends, however it ends — so a crashed
 * holder never leaves the lock taken on Windows, and on POSIX its leftover
 * socket file answers ECONNREFUSED and is replaced.
 *
 * This is the mechanism `workspace/binding-store.ts` already uses for its
 * writer lock, written once more here with a neutral error vocabulary; the
 * binding store keeps its own copy and its own refusal names for now.
 */
export interface ProcessLock {
  release(): Promise<void>;
}

/**
 * Take the lock named by `(scope, key)`, or answer `undefined` when another
 * live process holds it. `undefined` is an ordinary answer, not a fault.
 */
export async function tryAcquireProcessLock(scope: string, key: string): Promise<ProcessLock | undefined> {
  if (!/^[a-z][a-z0-9-]{0,39}$/u.test(scope)) throw new TypeError("A process lock scope must be a short lowercase name.");
  const endpoint = await lockEndpoint(scope, key);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const server = createServer((socket) => socket.destroy());
    try {
      await listen(server, endpoint);
      return heldLock(server);
    } catch (error) {
      await closeUnbound(server);
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      if (process.platform === "win32" || await socketIsActive(endpoint)) return undefined;
      await removeStaleSocket(endpoint);
    }
  }
  return undefined;
}

async function lockEndpoint(scope: string, key: string): Promise<string> {
  const digest = createHash("sha256").update(`cuna-process-lock-v1\0${scope}\0`).update(key).digest("hex");
  if (process.platform === "win32") return `\\\\.\\pipe\\cuna-${scope}-${digest}`;
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("The process lock needs a user identity on this platform.");
  const directory = join(await realpath(tmpdir()), `.cuna-${uid}`);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid) {
    throw new Error("The process lock directory is not a private directory of this user.");
  }
  await chmod(directory, 0o700);
  return join(directory, `${scope}-${digest.slice(0, 32)}.sock`);
}

async function listen(server: Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

function heldLock(server: Server): ProcessLock {
  // A lock must not keep the process alive on its own.
  server.unref();
  let released = false;
  return Object.freeze({
    release: async (): Promise<void> => {
      if (released) return;
      released = true;
      // Node removes a Unix socket's pathname while closing. Never unlink
      // after: another process may already have bound the name again.
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  });
}

async function closeUnbound(server: Server): Promise<void> {
  if (server.listening) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function socketIsActive(endpoint: string): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    const socket = createConnection(endpoint);
    socket.once("connect", () => {
      socket.destroy();
      resolveProbe(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolveProbe(error.code !== "ECONNREFUSED" && error.code !== "ENOENT");
    });
  });
}

async function removeStaleSocket(endpoint: string): Promise<void> {
  const stale = `${endpoint}.stale-${process.pid}-${randomUUID()}`;
  try {
    const entry = await lstat(endpoint);
    if (!entry.isSocket() || entry.isSymbolicLink()) throw new Error("The stale process lock is not a socket.");
    await rename(endpoint, stale);
    await unlink(stale);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
