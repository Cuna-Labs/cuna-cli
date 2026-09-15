import { runCli } from "./run.js";

type SupportedProcessSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

export interface ProcessSignalHost {
  once(signal: SupportedProcessSignal, listener: () => void): unknown;
  removeListener(signal: SupportedProcessSignal, listener: () => void): unknown;
}

export interface ProcessInputHost {
  pause(): unknown;
  destroy(): unknown;
}

export async function runProcessCli(
  argv: readonly string[],
  input: {
    readonly host?: ProcessSignalHost;
    /** The real process stdin, supplied only by the executable entrypoint. */
    readonly stdin?: ProcessInputHost;
    readonly run?: typeof runCli;
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
    return await run(argv, { signal: controller.signal });
  } finally {
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
