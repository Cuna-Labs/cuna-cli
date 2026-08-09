import type { ReadStream, WriteStream } from "node:tty";

import type { HostTerminalAdapter } from "../terminal/mode.js";
import { runtimeFailure } from "../runtime/errors.js";

const ENTER_ALTERNATE_SCREEN = "\u001b[?1049h\u001b[H";
const LEAVE_ALTERNATE_SCREEN = "\u001b[?1049l";
const RESET_REMOTE_MODES = "\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?2004l\u001b[?25h";

export function createNodeHostTerminalAdapter(input: {
  readonly stdin?: ReadStream;
  readonly stdout?: WriteStream;
} = {}): HostTerminalAdapter {
  const stdin = input.stdin ?? process.stdin;
  const stdout = input.stdout ?? process.stdout;
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
    enterAlternateScreen(): void {
      assertInteractive(stdin, stdout);
      stdout.write(ENTER_ALTERNATE_SCREEN);
    },
    disableRemoteModes(): void {
      if (stdout.isTTY) stdout.write(RESET_REMOTE_MODES);
    },
    leaveAlternateScreen(): void {
      if (stdout.isTTY) stdout.write(LEAVE_ALTERNATE_SCREEN);
    },
    leaveRawMode(): void {
      if (stdin.isTTY && typeof stdin.setRawMode === "function") stdin.setRawMode(false);
      if (shouldPauseAfterRawMode) stdin.pause();
      shouldPauseAfterRawMode = false;
    },
  });
}

function assertInteractive(stdin: ReadStream, stdout: WriteStream): void {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    throw runtimeFailure("pty_unavailable", "The current streams do not provide an interactive host terminal.");
  }
}
