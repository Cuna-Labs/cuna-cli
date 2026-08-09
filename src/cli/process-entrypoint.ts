import { runCli } from "./run.js";

type SupportedProcessSignal = "SIGINT" | "SIGTERM";

export interface ProcessSignalHost {
  once(signal: SupportedProcessSignal, listener: () => void): unknown;
  removeListener(signal: SupportedProcessSignal, listener: () => void): unknown;
}

export async function runProcessCli(
  argv: readonly string[],
  input: {
    readonly host?: ProcessSignalHost;
    readonly run?: typeof runCli;
  } = {},
): Promise<number> {
  const host = input.host ?? process;
  const run = input.run ?? runCli;
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Runa was interrupted by SIGINT."));
  const terminate = () => controller.abort(new Error("Runa was terminated by SIGTERM."));
  host.once("SIGINT", interrupt);
  host.once("SIGTERM", terminate);
  try {
    return await run(argv, { signal: controller.signal });
  } finally {
    host.removeListener("SIGINT", interrupt);
    host.removeListener("SIGTERM", terminate);
  }
}
