import { Writable } from "node:stream";

import { createRunaApiClient, type RunaApiClient } from "../api/client.js";
import { createHttpTransport } from "../api/http.js";
import { createBrowserOpener, type BrowserOpener } from "../auth/browser.js";
import { createHumanAuthClient } from "../auth/human-client.js";
import { createHumanAuthService, type HumanAuthResult, type HumanAuthService } from "../auth/human-session.js";
import { packageBuildDigest, PROTOCOL_RANGE, UPDATE_CHANNEL } from "../build-identity.js";
import { resolveConfig, type EffectiveConfig } from "../config/config.js";
import { executeCommand, preflightInvocation } from "../commands/commands.js";
import { EXIT_CODES, normalizeError, RunaError, usageError, type ExitCode } from "../core/errors.js";
import { CredentialBoundaryError } from "../credentials/errors.js";
import { createPlatformCredentialBackend } from "../credentials/platform.js";
import { CredentialVault } from "../credentials/vault.js";
import { createPlatformAdapter, type PlatformAdapter } from "../platform/adapter.js";
import { CLI_VERSION, OUTPUT_SCHEMA_VERSION } from "../version.js";
import { ROOT_HELP } from "./help.js";
import { createOutputWriter, type CliStreams } from "./output.js";
import { booleanOption, parseArgv, stringOption } from "./parser.js";
import { rejectUnknownOptions } from "./parser.js";

export interface RunCliDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: PlatformAdapter;
  readonly streams?: CliStreams;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly clientFactory?: (config: EffectiveConfig, timeoutMs: number) => RunaApiClient;
  readonly humanAuth?: HumanAuthService;
  readonly credentialVault?: CredentialVault;
  readonly browser?: BrowserOpener;
  readonly signal?: AbortSignal;
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

function humanResult(result: HumanAuthResult): Readonly<Record<string, unknown>> {
  return Object.freeze({
    profile: result.profile,
    session_id: result.sessionId,
    required_terms_version: result.context.requiredTermsVersion,
    identity: result.context.identity,
    admission: result.context.admission,
    workspace: {
      state: result.context.workspace.state,
      ...(result.context.workspace.id === undefined ? {} : { id: result.context.workspace.id }),
    },
    ...(result.context.waitlistPosition === undefined ? {} : { waitlist_position: result.context.waitlistPosition }),
  });
}

function needsRemoteCredential(command: string | undefined): boolean {
  return command === "capabilities" || command === "machines" || command === "agent-sessions";
}

export async function runCli(argv: readonly string[], dependencies: RunCliDependencies = {}): Promise<ExitCode> {
  const streams = dependencies.streams ?? defaultStreams();
  const writer = createOutputWriter({ streams, json: argv.includes("--json") });
  const label = commandLabel(argv);
  try {
    const parsed = parseArgv(argv);
    if (booleanOption(parsed, "version") || parsed.command === "version") {
      rejectUnknownOptions(parsed, ["version"]);
      if (parsed.command === "version" && parsed.operands.length !== 0) {
        throw usageError("version accepts no operands.");
      }
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
    if (parsed.command === undefined) {
      const allowedRootOptions = new Set(["help", "version", "json", "no-color"]);
      const invalidRootOption = Object.keys(parsed.options).find((name) => !allowedRootOptions.has(name));
      if (invalidRootOption !== undefined) throw usageError(`Option --${invalidRootOption} requires a command.`);
    }
    if (parsed.command === "help" || booleanOption(parsed, "help")) {
      rejectUnknownOptions(parsed, ["help"]);
      if (parsed.command === "help" && parsed.operands.length !== 0) throw usageError("help accepts no operands.");
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
    if (parsed.command === undefined) {
      if (writer.structured) {
        writer.success("help", { version: CLI_VERSION, output_schema_version: OUTPUT_SCHEMA_VERSION, help: ROOT_HELP }, ROOT_HELP);
      } else {
        writer.text(ROOT_HELP);
      }
      return EXIT_CODES.success;
    }

    preflightInvocation(parsed);

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
    let humanAuth = dependencies.humanAuth;
    const getHumanAuth = (): HumanAuthService => {
      if (humanAuth !== undefined) return humanAuth;
      const transportOptions = {
        baseUrl: config.baseUrl,
        timeoutMs,
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      };
      const humanClient = createHumanAuthClient({
        anonymous: createHttpTransport(transportOptions),
        authenticated: (accessToken) => createHttpTransport({ ...transportOptions, bearerToken: accessToken }),
      });
      humanAuth = createHumanAuthService({
        config,
        client: humanClient,
        vault: dependencies.credentialVault ?? new CredentialVault({
          backend: createPlatformCredentialBackend(),
          ...(dependencies.now === undefined ? {} : { clock: dependencies.now }),
        }),
        browser: dependencies.browser ?? createBrowserOpener(),
        ...(dependencies.now === undefined ? {} : { clock: dependencies.now }),
      });
      return humanAuth;
    };

    if (parsed.command === "login" || parsed.command === "logout" || parsed.command === "whoami") {
      rejectUnknownOptions(parsed, []);
      if (parsed.operands.length !== 0) throw usageError(`${parsed.command} accepts no operands.`);
      if (config.apiKey !== undefined) {
        throw new RunaError({
          code: "runa.auth.mode_conflict",
          message: "Interactive authentication is disabled while RUNA_API_KEY selects automation mode.",
          exitCode: EXIT_CODES.auth,
          hint: "Unset RUNA_API_KEY before managing the interactive session.",
        });
      }
      if (parsed.command === "login") {
        const result = await getHumanAuth().login(
          dependencies.signal === undefined ? {} : { signal: dependencies.signal },
        );
        const data = humanResult(result);
        writer.success("login", data, `Signed in to Runa profile ${result.profile}.`);
      } else if (parsed.command === "whoami") {
        const result = await getHumanAuth().whoami(dependencies.signal);
        const data = humanResult(result);
        writer.success("whoami", data, `${result.context.identity}\t${result.context.admission}\t${result.context.workspace.state}`);
      } else {
        const result = await getHumanAuth().logout(dependencies.signal);
        writer.success("logout", result, "Signed out of Runa on this device.");
      }
      return EXIT_CODES.success;
    }

    let bearerToken: string | undefined;
    let credentialMode: "automation" | "interactive" | undefined = config.apiKey === undefined ? undefined : "automation";
    if (config.apiKey === undefined && needsRemoteCredential(parsed.command) && dependencies.clientFactory === undefined) {
      bearerToken = await getHumanAuth().acquireAccessToken(dependencies.signal);
      credentialMode = "interactive";
    }
    const client = dependencies.clientFactory?.(config, timeoutMs) ?? createRunaApiClient(createHttpTransport({
      baseUrl: config.baseUrl,
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
      ...(bearerToken === undefined ? {} : { bearerToken }),
      timeoutMs,
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    }));
    const result = await executeCommand({
      parsed,
      config,
      client,
      now: dependencies.now?.() ?? Date.now(),
      ...(credentialMode === undefined ? {} : { credentialMode }),
    });
    writer.success(result.command, result.data, result.human);
    return EXIT_CODES.success;
  } catch (unknownError) {
    const error = unknownError instanceof CredentialBoundaryError
      ? new RunaError({
          code: `runa.auth.${unknownError.code}`,
          message: unknownError.message,
          exitCode: EXIT_CODES.auth,
          retryable: unknownError.retryable,
        })
      : normalizeError(unknownError);
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
