import { runCli } from "./run.js";
import type { FirstLine } from "./first-line.js";

type SupportedProcessSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

export interface ProcessSignalHost {
  once(signal: SupportedProcessSignal, listener: () => void): unknown;
  removeListener(signal: SupportedProcessSignal, listener: () => void): unknown;
}

export interface ProcessInputHost {
  pause(): unknown;
  destroy(): unknown;
}

/**
 * How long the process may outlive a command that has already returned.
 *
 * After `Ctrl+] d` printed `Detached · …`, the process stayed alive a further
 * 5.2-10.6 s with nothing on screen and no prompt (6 of 6 attaches, installed
 * 0.1.3, 2026-09-28). By then every piece of work the command owns has been
 * awaited: the runtime is shut down, the host terminal restored, the client
 * lock released. What remains is only what the command does not own, and the
 * reproduced case is Node's WebSocket: `close()` sends the close frame and the
 * socket then keeps the event loop alive until the SERVER answers it, however
 * long that takes (never, against a peer that does not answer). Node's
 * WebSocket has no way to drop the socket early, so the bound lives here, at
 * the one place that owns the process lifetime.
 *
 * 500 ms leaves a well-behaved close handshake (about one round trip, and the
 * close frame left before the last line was printed) time to finish on its own.
 */
export const COMMAND_EXIT_GRACE_MS = 500;
const OUTPUT_DRAIN_POLL_MS = 50;

export interface ProcessExitHost {
  readonly stdout: { readonly writableLength: number };
  readonly stderr: { readonly writableLength: number };
  /** Exits with the exit code already recorded on the process. */
  exit(): void;
}

/**
 * End the process once the command has returned, unless it ends by itself
 * first. The timer is unref'd, so a process with nothing left alive exits at
 * once and never reaches it. Output still queued for stdout or stderr is the
 * command's own answer and is always waited for.
 */
export function exitAfterCommandReturned(
  host: ProcessExitHost = process,
  graceMs: number = COMMAND_EXIT_GRACE_MS,
): void {
  const attempt = (): void => {
    if (host.stdout.writableLength > 0 || host.stderr.writableLength > 0) {
      setTimeout(attempt, OUTPUT_DRAIN_POLL_MS).unref();
      return;
    }
    host.exit();
  };
  setTimeout(attempt, graceMs).unref();
}

export async function runProcessCli(
  argv: readonly string[],
  input: {
    readonly host?: ProcessSignalHost;
    /** The real process stdin, supplied only by the executable entrypoint. */
    readonly stdin?: ProcessInputHost;
    readonly run?: typeof runCli;
    /** The row the executable painted before this module loaded; see `cli/first-line.ts`. */
    readonly firstLine?: FirstLine;
  } = {},
): Promise<number> {
  const host = input.host ?? process;
  const run = input.run ?? runCli;
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Cuna was interrupted by SIGINT."));
  const terminate = () => controller.abort(new Error("Cuna was terminated by SIGTERM."));
  const hangup = () => controller.abort(new Error("Cuna was interrupted by SIGHUP."));
  host.once("SIGINT", interrupt);
  host.once("SIGTERM", terminate);
  host.once("SIGHUP", hangup);
  try {
    return await run(argv, { signal: controller.signal, ...(input.firstLine === undefined ? {} : { firstLine: input.firstLine }) });
  } finally {
    // A row nothing took over must not outlive the command on the prompt line.
    input.firstLine?.release();
    host.removeListener("SIGINT", interrupt);
    host.removeListener("SIGTERM", terminate);
    host.removeListener("SIGHUP", hangup);
    // Raw hidden-code input must not own the lifetime of a command that has
    // already returned. Closing stdin here is safe: this is the process
    // boundary, after every interactive journey and terminal runner finished.
    input.stdin?.pause();
    input.stdin?.destroy();
  }
}
