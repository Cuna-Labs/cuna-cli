import { Writable } from "node:stream";

import { createRunaApiClient, type RunaApiClient } from "../api/client.js";
import { createHttpTransport } from "../api/http.js";
import { packageBuildDigest, PROTOCOL_RANGE, UPDATE_CHANNEL } from "../build-identity.js";
import { resolveConfig, type EffectiveConfig } from "../config/config.js";
import { executeCommand } from "../commands/commands.js";
import { EXIT_CODES, normalizeError, usageError, type ExitCode } from "../core/errors.js";
import { createPlatformAdapter, type PlatformAdapter } from "../platform/adapter.js";
import { CLI_VERSION, OUTPUT_SCHEMA_VERSION } from "../version.js";
import { ROOT_HELP } from "./help.js";
import { createOutputWriter, type CliStreams } from "./output.js";
import { booleanOption, parseArgv, stringOption } from "./parser.js";

export interface RunCliDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: PlatformAdapter;
  readonly streams?: CliStreams;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly clientFactory?: (config: EffectiveConfig, timeoutMs: number) => RunaApiClient;
}

function defaultStreams(): CliStreams {
  return Object.freeze({
    stdout: process.stdout,
    stderr: process.stderr,
    stdoutIsTTY: process.stdout.isTTY === true,
    stdinIsTTY: process.stdin.isTTY === true,
  });
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return 15_000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 100 || value > 120_000) {
    throw new Error("timeout-invalid");
  }
  return value;
}

function commandLabel(argv: readonly string[]): string {
  return argv.find((item) => !item.startsWith("-")) ?? "root";
}

export async function runCli(argv: readonly string[], dependencies: RunCliDependencies = {}): Promise<ExitCode> {
  const streams = dependencies.streams ?? defaultStreams();
  const writer = createOutputWriter({ streams, json: argv.includes("--json") });
  const label = commandLabel(argv);
  try {
    const parsed = parseArgv(argv);
    if (booleanOption(parsed, "version") || parsed.command === "version") {
      const identity = Object.freeze({
        version: CLI_VERSION,
        buildDigest: await packageBuildDigest(),
        platform: process.platform,
        architecture: process.arch,
        updateChannel: UPDATE_CHANNEL,
        protocolRange: PROTOCOL_RANGE,
      });
      if (writer.structured) {
        writer.success("version", identity, CLI_VERSION);
      } else {
        writer.text(CLI_VERSION);
      }
      return EXIT_CODES.success;
    }
    if (parsed.command === undefined || parsed.command === "help" || booleanOption(parsed, "help")) {
      if (writer.structured) {
        writer.success(
          "help",
          { version: CLI_VERSION, output_schema_version: OUTPUT_SCHEMA_VERSION, help: ROOT_HELP },
          ROOT_HELP,
        );
      } else {
        writer.text(ROOT_HELP);
      }
      return EXIT_CODES.success;
    }

    let timeoutMs: number;
    try {
      timeoutMs = parseTimeout(stringOption(parsed, "timeout-ms"));
    } catch {
      throw usageError("Option --timeout-ms must be an integer from 100 through 120000.");
    }
    const platform = dependencies.platform ?? createPlatformAdapter({ env: dependencies.env ?? process.env });
    const profile = stringOption(parsed, "profile");
    const baseUrl = stringOption(parsed, "base-url");
    const configFile = stringOption(parsed, "config-file");
    const config = await resolveConfig({
      platform,
      ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
      overrides: {
        ...(profile === undefined ? {} : { profile }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(configFile === undefined ? {} : { configFile }),
      },
    });
    const client = dependencies.clientFactory?.(config, timeoutMs) ??
      createRunaApiClient(
        createHttpTransport({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey ?? "missing",
          timeoutMs,
          ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
        }),
      );
    const result = await executeCommand({
      parsed,
      config,
      client,
      now: dependencies.now?.() ?? Date.now(),
    });
    writer.success(result.command, result.data, result.human);
    return EXIT_CODES.success;
  } catch (unknownError) {
    const error = normalizeError(unknownError);
    writer.error(label, error);
    return error.exitCode;
  }
}

export function memoryStreams(input?: {
  readonly stdoutIsTTY?: boolean;
  readonly stdinIsTTY?: boolean;
}): { readonly streams: CliStreams; readonly stdout: () => string; readonly stderr: () => string } {
  let stdout = "";
  let stderr = "";
  const stdoutStream = new Writable({ write(chunk, _encoding, callback) { stdout += chunk.toString(); callback(); } });
  const stderrStream = new Writable({ write(chunk, _encoding, callback) { stderr += chunk.toString(); callback(); } });
  return Object.freeze({
    streams: Object.freeze({
      stdout: stdoutStream,
      stderr: stderrStream,
      stdoutIsTTY: input?.stdoutIsTTY ?? false,
      stdinIsTTY: input?.stdinIsTTY ?? false,
    }),
    stdout: () => stdout,
    stderr: () => stderr,
  });
}
