import type { Writable } from "node:stream";

import type { RunaError } from "../core/errors.js";
import { OUTPUT_SCHEMA_VERSION } from "../version.js";

export interface CliStreams {
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly stdoutIsTTY: boolean;
  readonly stdinIsTTY: boolean;
}

export interface OutputWriter {
  readonly structured: boolean;
  success(command: string, data: unknown, human: string): void;
  error(command: string, error: RunaError): void;
  text(value: string): void;
}

function writeLine(stream: Writable, value: string): void {
  stream.write(value.endsWith("\n") ? value : `${value}\n`);
}

export function createOutputWriter(input: {
  readonly streams: CliStreams;
  readonly json: boolean;
}): OutputWriter {
  const structured = input.json || !input.streams.stdoutIsTTY;
  const writer: OutputWriter = {
    structured,
    success(command, data, human) {
      if (structured) {
        writeLine(
          input.streams.stdout,
          JSON.stringify({ schema_version: OUTPUT_SCHEMA_VERSION, type: "result", command, data }),
        );
      } else {
        writeLine(input.streams.stdout, human);
      }
    },
    error(command, error) {
      if (structured) {
        writeLine(
          input.streams.stderr,
          JSON.stringify({
            schema_version: OUTPUT_SCHEMA_VERSION,
            type: "error",
            command,
            error: {
              code: error.code,
              message: error.message,
              retryable: error.retryable,
              ...(error.hint === undefined ? {} : { hint: error.hint }),
              ...(error.details === undefined ? {} : { details: error.details }),
            },
          }),
        );
      } else {
        writeLine(input.streams.stderr, `Error [${error.code}]: ${error.message}`);
        if (error.hint !== undefined) writeLine(input.streams.stderr, `Next: ${error.hint}`);
      }
    },
    text(value) {
      writeLine(input.streams.stdout, value);
    },
  };
  return Object.freeze(writer);
}
