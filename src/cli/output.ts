import type { Writable } from "node:stream";

import type { CunaError, SafeErrorScalar } from "../core/errors.js";
import { containsCredentialValue } from "../core/namespace.js";
import { OUTPUT_SCHEMA_VERSION } from "../version.js";

export interface CliStreams {
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly stdoutIsTTY: boolean;
  readonly stdinIsTTY: boolean;
  /** Optional because injected test streams predate the preview link gate. */
  readonly stderrIsTTY?: boolean;
}

export interface OutputWriter {
  readonly structured: boolean;
  success(command: string, data: unknown, human: string): void;
  error(command: string, error: CunaError): void;
  text(value: string): void;
}

function writeLine(stream: Writable, value: string): void {
  stream.write(value.endsWith("\n") ? value : `${value}\n`);
}

/**
 * Human terminal output is a trust boundary. Preserve only the two layout
 * controls emitted deliberately by Cuna; render every other C0/C1/Unicode
 * format control visibly so API data and error text cannot execute ANSI/OSC,
 * alter the title/clipboard, or spoof text direction.
 */
export function sanitizeHumanTerminalOutput(value: string): string {
  let result = "";
  for (const character of value) {
    if (character === "\n" || character === "\t") {
      result += character;
      continue;
    }
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      /\p{Cf}/u.test(character)
    ) {
      result += codePoint <= 0xff
        ? `\\x${codePoint.toString(16).padStart(2, "0")}`
        : `\\u{${codePoint.toString(16)}}`;
      continue;
    }
    result += character;
  }
  return result;
}

function sanitizeSingleLineHumanOutput(value: string): string {
  return sanitizeHumanTerminalOutput(value).replaceAll("\n", "\\n").replaceAll("\t", "\\t");
}

/**
 * Render one `details` entry for a human terminal.
 *
 * `details` distinguishes failures that otherwise print identically: thirteen
 * distinct configuration faults share one message, and an HTTP 403 carries the
 * `request_id` support asks for. JSON mode has always emitted it; human mode
 * dropped it entirely, so the operator saw the same unactionable sentence.
 *
 * Values here originate partly from the service, so this is a print sink for
 * service-controlled bytes and is held to the same rule as every other one.
 */
function renderErrorDetail(value: SafeErrorScalar | readonly SafeErrorScalar[]): string {
  const rendered = Array.isArray(value)
    ? value.map((item) => String(item)).join(", ")
    : String(value as SafeErrorScalar);
  return containsCredentialValue(rendered) ? "[redacted credential]" : rendered;
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
        writeLine(input.streams.stdout, sanitizeHumanTerminalOutput(human));
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
        writeLine(input.streams.stderr, sanitizeSingleLineHumanOutput(`Error [${error.code}]: ${error.message}`));
        for (const [key, value] of Object.entries(error.details ?? {})) {
          writeLine(input.streams.stderr, sanitizeSingleLineHumanOutput(`  ${key}: ${renderErrorDetail(value)}`));
        }
        if (error.hint !== undefined) {
          writeLine(input.streams.stderr, sanitizeSingleLineHumanOutput(`Next: ${error.hint}`));
        }
      }
    },
    text(value) {
      writeLine(input.streams.stdout, sanitizeHumanTerminalOutput(value));
    },
  };
  return Object.freeze(writer);
}
