import type { ReadStream, WriteStream } from "node:tty";

import type { HostTerminalAdapter } from "../terminal/mode.js";
import { HostTerminalLease } from "../terminal/mode.js";
import type { ForegroundTerminalHost } from "../terminal/foreground.js";
import { runtimeFailure } from "../runtime/errors.js";

const ENTER_ALTERNATE_SCREEN = "\u001b[?1049h\u001b[H";
const LEAVE_ALTERNATE_SCREEN = "\u001b[?1049l";
const RESET_REMOTE_MODES = "\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?2004l\u001b[?25h";
const HOST_WRITE_TIMEOUT_MS = 5_000;

export function createNodeHostTerminalAdapter(input: {
  readonly stdin?: ReadStream;
  readonly stdout?: WriteStream;
  readonly writeTimeoutMs?: number;
} = {}): HostTerminalAdapter {
  const stdin = input.stdin ?? process.stdin;
  const stdout = input.stdout ?? process.stdout;
  const writeTimeoutMs = input.writeTimeoutMs ?? HOST_WRITE_TIMEOUT_MS;
  if (!Number.isSafeInteger(writeTimeoutMs) || writeTimeoutMs < 1 || writeTimeoutMs > 60_000) {
    throw new RangeError("Host terminal write timeout must be between 1 and 60000 milliseconds.");
  }
  let shouldPauseAfterRawMode = false;
  return Object.freeze({
    enterRawMode(): void {
      assertInteractive(stdin, stdout);
      // `readableFlowing === null` is Node's initial no-consumer state. Calling
      // resume() changes it to `true` and keeps the process alive, so restoration
      // must pause both the initial and explicitly-paused states.
      shouldPauseAfterRawMode = stdin.readableFlowing !== true;
      stdin.setRawMode(true);
      stdin.resume();
    },
    async enterAlternateScreen(): Promise<void> {
      assertInteractive(stdin, stdout);
      await writeWithBackpressure(stdout, new TextEncoder().encode(ENTER_ALTERNATE_SCREEN), writeTimeoutMs);
    },
    async disableRemoteModes(): Promise<void> {
      if (stdout.isTTY) await writeWithBackpressure(stdout, new TextEncoder().encode(RESET_REMOTE_MODES), writeTimeoutMs);
    },
    async leaveAlternateScreen(): Promise<void> {
      if (stdout.isTTY) await writeWithBackpressure(stdout, new TextEncoder().encode(LEAVE_ALTERNATE_SCREEN), writeTimeoutMs);
    },
    leaveRawMode(): void {
      if (stdin.isTTY && typeof stdin.setRawMode === "function") stdin.setRawMode(false);
      if (shouldPauseAfterRawMode) stdin.pause();
      shouldPauseAfterRawMode = false;
    },
  });
}

export function createNodeForegroundTerminalHost(input: {
  readonly stdin?: ReadStream;
  readonly stdout?: WriteStream;
  readonly writeTimeoutMs?: number;
} = {}): ForegroundTerminalHost {
  const stdin = input.stdin ?? process.stdin;
  const stdout = input.stdout ?? process.stdout;
  const writeTimeoutMs = input.writeTimeoutMs ?? HOST_WRITE_TIMEOUT_MS;
  if (!Number.isSafeInteger(writeTimeoutMs) || writeTimeoutMs < 1 || writeTimeoutMs > 60_000) {
    throw new RangeError("Host terminal write timeout must be between 1 and 60000 milliseconds.");
  }
  return Object.freeze({
    dimensions(): { readonly columns: number; readonly rows: number } {
      assertInteractive(stdin, stdout);
      return Object.freeze({ columns: stdout.columns, rows: stdout.rows });
    },
    async acquire(): Promise<HostTerminalLease> {
      return await HostTerminalLease.acquire(createNodeHostTerminalAdapter({ stdin, stdout, writeTimeoutMs }));
    },
    async write(bytes: Uint8Array): Promise<void> {
      assertInteractive(stdin, stdout);
      await writeWithBackpressure(stdout, bytes, writeTimeoutMs);
    },
    onInput(listener: (bytes: Uint8Array) => void): () => void {
      const receive = (chunk: Buffer | string): void => listener(
        typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk),
      );
      stdin.on("data", receive);
      return () => stdin.removeListener("data", receive);
    },
    onResize(listener: () => void): () => void {
      stdout.on("resize", listener);
      return () => stdout.removeListener("resize", listener);
    },
  });
}

function assertInteractive(stdin: ReadStream, stdout: WriteStream): void {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    throw runtimeFailure("pty_unavailable", "The current streams do not provide an interactive host terminal.");
  }
}

async function writeWithBackpressure(stdout: WriteStream, bytes: Uint8Array, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let callbackComplete = false;
    let drainComplete = false;
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("The host terminal output sink exceeded its bounded deadline.")), timeoutMs);
    timeout.unref();
    const cleanup = (): void => {
      clearTimeout(timeout);
      stdout.removeListener("error", onError);
      stdout.removeListener("drain", onDrain);
    };
    const finish = (error?: Error | null): void => {
      if (settled) return;
      if (error === undefined || error === null) {
        if (!callbackComplete || !drainComplete) return;
        settled = true;
        cleanup();
        resolve();
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const onError = (error: Error): void => finish(error);
    const onDrain = (): void => {
      drainComplete = true;
      finish();
    };
    stdout.once("error", onError);
    let accepted: boolean;
    try {
      accepted = stdout.write(Buffer.from(bytes), (error) => {
        callbackComplete = true;
        finish(error);
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error("The host terminal output sink failed."));
      return;
    }
    drainComplete = accepted;
    if (!accepted) stdout.once("drain", onDrain);
    finish();
  });
}
