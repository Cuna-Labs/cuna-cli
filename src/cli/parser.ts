import { usageError } from "../core/errors.js";

export type OptionValue = string | boolean;
export interface ParsedInvocation {
  readonly command: string | undefined;
  readonly operands: readonly string[];
  readonly options: Readonly<Record<string, OptionValue>>;
}

const BOOLEAN_OPTIONS = new Set([
  "help",
  "version",
  "json",
  "no-color",
  "yes",
  "background",
  "no-sync",
  "new",
  "new-session",
  "offline",
  // Legacy compatibility spelling; preview is selected by login or a stored
  // preview record, and never by an automation API key.
  "session-only",
  // `cuna help --all`. Absent from this set, the parser reads it as a
  // value option, swallows the next token, and answers "Option --all requires
  // a value" — a usage error about a flag that takes none.
  "all",
]);

function optionName(raw: string): string {
  if (!/^[a-z][a-z0-9-]*$/u.test(raw)) throw usageError(`Invalid option --${raw}.`);
  return raw;
}

export function parseArgv(argv: readonly string[]): ParsedInvocation {
  const options: Record<string, OptionValue> = {};
  const positionals: string[] = [];
  let flags = true;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (flags && token === "--") {
      flags = false;
      continue;
    }
    if (flags && token.startsWith("--")) {
      const separator = token.indexOf("=");
      const name = optionName(token.slice(2, separator === -1 ? undefined : separator));
      if (Object.hasOwn(options, name)) throw usageError(`Option --${name} was provided more than once.`);
      if (BOOLEAN_OPTIONS.has(name)) {
        if (separator !== -1) throw usageError(`Option --${name} does not accept a value.`);
        options[name] = true;
      } else {
        const value = separator === -1 ? argv[index + 1] : token.slice(separator + 1);
        if (value === undefined || value === "" || (separator === -1 && value.startsWith("--"))) {
          throw usageError(`Option --${name} requires a value.`);
        }
        options[name] = value;
        if (separator === -1) index += 1;
      }
      continue;
    }
    positionals.push(token);
  }
  return Object.freeze({
    command: positionals[0],
    operands: Object.freeze(positionals.slice(1)),
    options: Object.freeze(options),
  });
}

export function stringOption(parsed: ParsedInvocation, name: string): string | undefined {
  const value = parsed.options[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw usageError(`Option --${name} requires a value.`);
  return value;
}

export function booleanOption(parsed: ParsedInvocation, name: string): boolean {
  const value = parsed.options[name];
  if (value === undefined) return false;
  if (value !== true) throw usageError(`Option --${name} does not accept a value.`);
  return true;
}

export function rejectUnknownOptions(parsed: ParsedInvocation, allowed: readonly string[]): void {
  const allow = new Set([...allowed, "json", "no-color", "profile", "base-url", "config-file", "timeout-ms", "session-only"]);
  const unknown = Object.keys(parsed.options).filter((key) => !allow.has(key));
  if (unknown.length > 0) throw usageError(`Unknown option --${unknown[0]}.`);
}
