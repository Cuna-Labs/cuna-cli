import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";

import { createCunaApiClient, type CunaApiClient } from "../api/client.js";
import { createHttpTransport, type HttpRequest } from "../api/http.js";
import { createBrowserOpener, type BrowserOpener } from "../auth/browser.js";
import type { BrowserHandoffReporter } from "../auth/browser-handoff.js";
import { createHumanAuthClient } from "../auth/human-client.js";
import { createHumanAuthService, type HumanAuthResult, type HumanAuthService } from "../auth/human-session.js";
import { ARTIFACT_CHANNEL, packageBuildDigest, PROTOCOL_RANGE } from "../build-identity.js";
import { assertApiKeyUsable, resolveConfig, type EffectiveConfig } from "../config/config.js";
import { assertOpenCodeExecutionEnabled } from "../config/opencode-feature-gate.js";
import {
  executeCommand,
  preflightInvocation,
  type AgentSessionTerminationPoller,
} from "../commands/commands.js";
import { EXIT_CODES, normalizeError, CunaError, usageError, type ExitCode } from "../core/errors.js";
import {
  CONSOLE_ORIGIN,
  INTERNAL_DEFECT_HINT,
  automationCredentialHint,
} from "../core/product-web.js";
import { integerArgument } from "../core/validation.js";
import { CredentialBoundaryError } from "../credentials/errors.js";
import type { SecureCredentialBackend } from "../credentials/contracts.js";
import { CredentialVault } from "../credentials/vault.js";
import { LocalEncryptedSessionBackend, localEncryptedSessionPaths } from "../credentials/local-session.js";
import {
  conservativeFilesystemCapabilities,
  createApiAgentJourneyEffects,
  createWorkspaceJourneyEffects,
  orchestrateAgentJourney,
  preflightAgentJourneyInvocation,
  type AgentJourneyEffects,
  type ReconciledAgentJourneyIntent,
} from "../journey/index.js";
import { createPlatformAdapter, type PlatformAdapter } from "../platform/adapter.js";
import { CLI_VERSION, OUTPUT_SCHEMA_VERSION } from "../version.js";
import { runtimeFeatureGates, type RuntimeFeatureGate } from "../runtime/contracts.js";
import { RuntimeBoundaryError } from "../runtime/errors.js";
import {
  runNodeForegroundSessions,
  selectNodeForegroundPresentation,
  type ForegroundSessionRunner,
  type ForegroundPresentationMode,
} from "../runtime/node-foreground-session.js";
import { commandHelp, helpTopicName } from "./command-help.js";
import { FULL_HELP, ROOT_HELP } from "./help.js";
import { createOutputWriter, sanitizeHumanTerminalOutput, type CliStreams } from "./output.js";
import { booleanOption, parseArgv, stringOption } from "./parser.js";
import { rejectUnknownOptions } from "./parser.js";
import type { ParsedInvocation } from "./parser.js";

export interface RunCliDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: PlatformAdapter;
  readonly streams?: CliStreams;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  /**
   * Test seam for the bounded read-only confirmation after an AgentSession
   * termination request. Production always uses a wall-clock deadline.
   */
  readonly agentSessionTerminationPoller?: AgentSessionTerminationPoller;
  readonly clientFactory?: (config: EffectiveConfig, timeoutMs: number) => CunaApiClient;
  readonly humanAuth?: HumanAuthService;
  readonly credentialVault?: CredentialVault;
  readonly browser?: BrowserOpener;
  readonly readLoginCode?: (signal?: AbortSignal) => Promise<string>;
  readonly signal?: AbortSignal;
  /**
   * Test seam for the diagnostic-only local-store observation. Production CLI
   * invocations leave this absent and construct the AES backend below. Keeping
   * the remote bootstrap probe outside this seam lets tests prove the two
   * independent `doctor --check-browser-login` predicates without depending on
   * host ACL subprocess availability.
   */
  readonly doctorCredentialBackend?: Pick<SecureCredentialBackend, "backendId" | "probe">;
  readonly runtimeFeatures?: readonly RuntimeFeatureGate[];
  readonly foregroundTerminalRunner?: ForegroundSessionRunner;
  readonly automaticJourneyEffectsFactory?: (input: {
    readonly client: CunaApiClient;
    readonly intent: ReconciledAgentJourneyIntent;
    readonly config: EffectiveConfig;
    readonly platform: PlatformAdapter;
    readonly credentialMode: "automation" | "interactive";
    readonly signal?: AbortSignal;
  }) => AgentJourneyEffects;
  readonly authorizeMachineCreate?: (agent: "claude-code" | "codex" | "openclaw" | "opencode", signal: AbortSignal) => Promise<boolean>;
}

async function confirmMachineCreate(agent: "claude-code" | "codex" | "openclaw" | "opencode", signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    const answer = await prompt.question(`No compatible machine is available. Create one for ${agent}? [y/N] `, { signal });
    return answer.trim().toLocaleLowerCase("en-US") === "y" || answer.trim().toLocaleLowerCase("en-US") === "yes";
  } catch {
    return false;
  } finally {
    prompt.close();
  }
}

/**
 * Render the browser handoff onto the interactive terminal.
 *
 * Everything here goes to **stderr**, deliberately and for two reasons.
 *
 * It is prompt text, not a command result, so `stdout` stays clean for the
 * structured result the command still owes its caller. And the continuation
 * fragment is a bearer proof: on stderr it stays out of `$(cuna login)`,
 * pipelines and redirected logs, while `run` already refuses the whole command
 * unless stdin, stdout **and** stderr are all TTYs — so this print cannot reach
 * a file or a pipe without that refusal firing first.
 *
 * Every line is passed through the same human-output sanitizer as the rest of
 * the CLI. The URL is already constrained by `decodeCliContinuationIssued` and
 * by `isBoundedHttpsBrowserUrl`, so this is defence in depth rather than the
 * only control, but a print sink for service-controlled bytes is held to the
 * same rule everywhere else in this file.
 */
export function createTerminalBrowserHandoffReporter(output: Writable): BrowserHandoffReporter {
  const line = (value: string): void => {
    output.write(`${sanitizeHumanTerminalOutput(value)}\n`);
  };
  const reporter: BrowserHandoffReporter = {
    continuationUrl(url) {
      line("");
      line("Sign in to Cuna in your browser. Open this single-use link:");
      line("");
      line(`  ${url}`);
      line("");
    },
    browserOpened() {
      line("Opened your default browser. Approve the sign-in there, then return here.");
    },
    browserOpenFailed() {
      line("Could not open a browser automatically. Open the link above yourself.");
    },
  };
  return Object.freeze(reporter);
}

function loginCodeInputError(code: "unavailable" | "cancelled" | "too_long", message: string): CunaError {
  return new CunaError({
    code: `cuna.auth.login_code_input_${code}`,
    message,
    exitCode: EXIT_CODES.auth,
    hint: code === "unavailable"
      ? "Run `cuna login` from an interactive terminal that supports hidden input."
      : "Run `cuna login` again and paste the complete cuna_login_ code.",
  });
}

/**
 * Read the reusable browser login code without writing its bytes to terminal
 * output. `readline.question` echoes pasted text, which is unacceptable for a
 * credential retained in the encrypted local session store. Raw TTY input is
 * the narrowest portable Node primitive that gives this command that boundary.
 *
 * This intentionally refuses pipes and terminals without `setRawMode`: a
 * process that cannot suppress echo must not accept the durable code at all.
 */
export async function readHiddenLoginCode(
  input: NodeJS.ReadStream,
  output: Writable,
  signal?: AbortSignal,
): Promise<string> {
  if (input.isTTY !== true || typeof input.setRawMode !== "function") {
    throw loginCodeInputError("unavailable", "Cuna cannot safely accept a login code from this input.");
  }
  if (signal?.aborted) throw loginCodeInputError("cancelled", "Cuna sign-in was cancelled.");

  const wasRaw = input.isRaw === true;
  const bytes: number[] = [];
  const maxBytes = 256;

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      input.off("data", onData);
      input.off("error", onError);
      input.off("end", onEnd);
      signal?.removeEventListener("abort", onAbort);
      try { input.setRawMode?.(wasRaw); } catch { /* best-effort terminal restoration */ }
      output.write("\n");
      bytes.fill(0);
    };
    const settle = (outcome: { readonly value: string } | { readonly error: CunaError }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.value);
    };
    const finish = () => {
      const raw = Buffer.from(bytes).toString("utf8");
      // Several terminals wrap a paste in these control sequences while raw
      // mode is active. Accept exactly the pair, never arbitrary escapes.
      const bracketedPasteStart = `${String.fromCharCode(0x1b)}[200~`;
      const bracketedPasteEnd = `${String.fromCharCode(0x1b)}[201~`;
      const withoutPasteStart = raw.startsWith(bracketedPasteStart)
        ? raw.slice(bracketedPasteStart.length)
        : raw;
      const value = withoutPasteStart.endsWith(bracketedPasteEnd)
        ? withoutPasteStart.slice(0, -bracketedPasteEnd.length)
        : withoutPasteStart;
      settle({ value });
    };
    const onAbort = () => settle({ error: loginCodeInputError("cancelled", "Cuna sign-in was cancelled.") });
    const onError = () => settle({ error: loginCodeInputError("unavailable", "Cuna could not safely read the login code.") });
    const onEnd = () => settle({ error: loginCodeInputError("cancelled", "Cuna did not receive a login code.") });
    const onData = (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const byte of data) {
        if (byte === 0x03) return onAbort(); // Ctrl+C
        if (byte === 0x04) return onEnd(); // Ctrl+D
        if (byte === 0x0d || byte === 0x0a) return finish();
        if (byte === 0x08 || byte === 0x7f) {
          bytes.pop();
          continue;
        }
        if (bytes.length >= maxBytes) {
          return settle({ error: loginCodeInputError("too_long", "The pasted Cuna login code is too long.") });
        }
        bytes.push(byte);
      }
    };

    try {
      input.setRawMode(true);
      output.write("Paste the cuna_login_ code shown by app.getcuna.com (input hidden): ");
      input.on("data", onData);
      input.once("error", onError);
      input.once("end", onEnd);
      signal?.addEventListener("abort", onAbort, { once: true });
      // AbortSignal does not replay an abort that happened immediately before
      // listener registration (for example while raw mode is being enabled).
      // Recheck before resuming input so hidden-code input never waits for a
      // second user action after cancellation.
      if (signal?.aborted === true) return onAbort();
      input.resume();
    } catch {
      settle({ error: loginCodeInputError("unavailable", "Cuna cannot safely prepare hidden login-code input.") });
    }
  });
}

async function promptLoginCode(signal?: AbortSignal): Promise<string> {
  return readHiddenLoginCode(process.stdin, process.stderr, signal);
}

function defaultStreams(): CliStreams {
  return Object.freeze({
    stdout: process.stdout,
    stderr: process.stderr,
    stdoutIsTTY: process.stdout.isTTY === true,
    stdinIsTTY: process.stdin.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
  });
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return 15_000;
  return integerArgument(raw, "timeout-ms", 100, 120_000);
}

/**
 * The `command` field of every output record, including error records.
 *
 * This used to be "the first argv token that does not start with `-`", which is
 * an option VALUE whenever a global option precedes the command:
 * `cuna --config-file /home/me/.cuna/config.toml machines list` reported the
 * command as `/home/me/.cuna/config.toml`, putting an absolute filesystem path
 * into a JSON record and into whatever consumes it. The parser already knows
 * which token is the command, so ask it; if the argv is too malformed to parse,
 * there is no command to name.
 */
function commandLabel(argv: readonly string[]): string {
  try {
    return parseArgv(argv).command ?? "root";
  } catch {
    return "root";
  }
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
    ...(result.storageMode === undefined ? {} : { storage_mode: result.storageMode }),
    ...(result.context.waitlistPosition === undefined ? {} : { waitlist_position: result.context.waitlistPosition }),
  });
}

function needsRemoteCredential(command: string | undefined, foreground: ForegroundSelection | undefined): boolean {
  return command === "capabilities" || command === "machines" || command === "agent-sessions" ||
    command === "agent" ||
    command === "records" || command === "authorizations" || command === "api-keys" ||
    command === "account" || command === "workspace" || command === "usage" ||
    command === "claude" || command === "codex" || command === "openclaw" || command === "opencode" || foreground !== undefined;
}

function managesInteractiveSession(command: string | undefined): boolean {
  return command === "signup" || command === "login" || command === "logout" ||
    command === "whoami" || command === "access";
}

/**
 * Whether this invocation selects a credential authority — either by presenting
 * a credential to the API, or because the presence of an automation credential
 * changes what the command does.
 *
 * This is the blast radius of a broken environment credential. Everything
 * outside it — `doctor`, `self-test --offline`, `config get`, `version`,
 * `help`, and the fail-closed reserved commands — reads no credential, so an
 * unusable one must not stop it. It used to, because the refusal lived inside
 * `resolveConfig`, which runs before dispatch: a failed
 * `export CUNA_API_KEY=$(fetch-secret)` disabled the two commands whose entire
 * purpose is diagnosing a broken environment.
 */
function usesCredentialAuthority(
  command: string | undefined,
  foreground: ForegroundSelection | undefined,
): boolean {
  return managesInteractiveSession(command) || needsRemoteCredential(command, foreground);
}

interface ForegroundSelection {
  readonly agentSessionIds: readonly string[];
  readonly expectedAgentKinds?: readonly ("claude-code" | "codex" | "openclaw" | "opencode")[];
}

function foregroundSelection(parsed: ParsedInvocation): ForegroundSelection | undefined {
  if (parsed.command === "connect") return Object.freeze({ agentSessionIds: parsed.operands });
  if (parsed.command === "agent-sessions" && parsed.operands[0] === "attach") {
    return Object.freeze({ agentSessionIds: parsed.operands.slice(1) });
  }
  const expectedAgent: "claude-code" | "codex" | "openclaw" | "opencode" | undefined = parsed.command === "claude"
    ? "claude-code"
    : parsed.command === "codex" || parsed.command === "openclaw" || parsed.command === "opencode"
      ? parsed.command
      : undefined;
  const agentSessionId = stringOption(parsed, "agent-session");
  if (expectedAgent !== undefined && agentSessionId !== undefined) {
    return Object.freeze({
      agentSessionIds: Object.freeze([agentSessionId]),
      expectedAgentKinds: Object.freeze([expectedAgent]),
    });
  }
  return undefined;
}

function nodePlatform(kind: PlatformAdapter["kind"]): NodeJS.Platform {
  return kind === "windows" ? "win32" : kind === "macos" ? "darwin" : "linux";
}

type BrowserLoginRemoteProbe = Readonly<{
  status: "verified" | "unavailable" | "unknown" | "not_checked";
  reason: string;
}>;

/**
 * `doctor` must distinguish two independent facts: whether this host can
 * protect a durable login-code envelope, and whether the selected deployment
 * currently serves the anonymous browser-login bootstrap. The latter is an
 * opt-in network check so the normal diagnostic stays safe and offline.
 */
async function probeBrowserLoginRemote(input: {
  readonly config: EffectiveConfig;
  readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}): Promise<BrowserLoginRemoteProbe> {
  const transportOptions = {
    baseUrl: input.config.baseUrl,
    timeoutMs: input.timeoutMs,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  };
  try {
    const bootstrap = await createHumanAuthClient({
      anonymous: createHttpTransport(transportOptions),
      authenticated: (accessToken) => createHttpTransport({ ...transportOptions, bearerToken: accessToken }),
    }).bootstrap(input.signal);
    return bootstrap.enabled
      ? Object.freeze({ status: "verified", reason: "remote_browser_login_bootstrap_verified" })
      : Object.freeze({ status: "unavailable", reason: "remote_browser_login_disabled" });
  } catch {
    // The exact transport/decoder error is intentionally not copied into a
    // public diagnostic. It might contain an untrusted endpoint response, and
    // this gate only needs to say that a fresh bootstrap could not be proven.
    return Object.freeze({ status: "unknown", reason: "remote_browser_login_probe_failed" });
  }
}

function runtimeError(error: RuntimeBoundaryError): CunaError {
  const exitCode = error.code === "session_conflict"
    ? EXIT_CODES.conflict
    : error.code === "capability_unsupported" || error.code === "control_plane_unavailable" || error.code === "pty_unavailable"
      ? EXIT_CODES.unsupported
      : error.code === "capability_unavailable" || error.code === "terminal_disconnected" || error.code === "terminal_timeout"
        ? EXIT_CODES.network
        : error.code.startsWith("capability_") || error.code.startsWith("grant_") || error.code === "remote_state_unproven"
          ? EXIT_CODES.policy
          : EXIT_CODES.remote;
  return new CunaError({
    code: `cuna.runtime.${error.code}`,
    message: error.message,
    exitCode,
    retryable: error.retryable,
    ...(error.safeDetails === undefined ? {} : { details: error.safeDetails }),
    cause: error,
  });
}

export async function runCli(argv: readonly string[], dependencies: RunCliDependencies = {}): Promise<ExitCode> {
  const streams = dependencies.streams ?? defaultStreams();
  const writer = createOutputWriter({ streams, json: argv.includes("--json") });
  const label = commandLabel(argv);
  try {
    const parsed = parseArgv(argv);
    if (!booleanOption(parsed, "help") && (booleanOption(parsed, "version") || parsed.command === "version")) {
      rejectUnknownOptions(parsed, ["version"]);
      if (parsed.command === "version" && parsed.operands.length !== 0) {
        throw usageError("version accepts no operands.");
      }
      const identity = Object.freeze({
        version: CLI_VERSION,
        buildDigest: await packageBuildDigest(),
        platform: process.platform,
        architecture: process.arch,
        updateChannel: ARTIFACT_CHANNEL,
        artifactChannel: ARTIFACT_CHANNEL,
        protocolRange: PROTOCOL_RANGE,
      });
      if (writer.structured) {
        writer.success("version", identity, CLI_VERSION);
      } else {
        writer.text(CLI_VERSION);
      }
      return EXIT_CODES.success;
    }
    // Help is answered before the root-option allowlist below. That allowlist
    // exists to reject `cuna --profile x` with no command, but it ran first and
    // so also rejected `cuna --help --profile x`: asking for help was refused
    // because of the very option the user wanted help about. `--json` and
    // `--no-color` happened to be on the allowlist and worked, which is what
    // made the behaviour look arbitrary rather than wrong.
    if (parsed.command === "help" || booleanOption(parsed, "help")) {
      rejectUnknownOptions(parsed, ["help", "all"]);
      if (parsed.command === "help" && parsed.operands.length !== 0) throw usageError("help accepts no operands.");
      const topic = parsed.command === "help" || parsed.command === undefined
        ? undefined
        : parsed.command;
      // `--all` widens the ROOT topic only. On a command topic the per-command
      // help is already the complete surface for that command, so there is
      // nothing to widen and the flag would promise something it cannot do.
      const wantsFullSurface = booleanOption(parsed, "all");
      if (wantsFullSurface && topic !== undefined) {
        throw usageError(
          "Option --all applies to `cuna help`, not to one command's help.",
          `Run \`cuna ${topic} --help\` for this command, or \`cuna help --all\` for the complete surface.`,
        );
      }
      const help = wantsFullSurface ? FULL_HELP : commandHelp(topic, parsed.operands);
      if (writer.structured) {
        writer.success(
          "help",
          {
            version: CLI_VERSION,
            output_schema_version: OUTPUT_SCHEMA_VERSION,
            ...(topic === undefined
              ? (wantsFullSurface ? { topic: "all" } : {})
              : { topic: helpTopicName(topic, parsed.operands) }),
            help,
          },
          help,
        );
      } else {
        writer.text(help);
      }
      return EXIT_CODES.success;
    }
    if (parsed.command === undefined) {
      const allowedRootOptions = new Set(["help", "version", "json", "no-color"]);
      const invalidRootOption = Object.keys(parsed.options).find((name) => !allowedRootOptions.has(name));
      if (invalidRootOption !== undefined) throw usageError(`Option --${invalidRootOption} requires a command.`);
    }
    if (parsed.command === undefined) {
      if (writer.structured) {
        writer.success("help", { version: CLI_VERSION, output_schema_version: OUTPUT_SCHEMA_VERSION, help: ROOT_HELP }, ROOT_HELP);
      } else {
        writer.text(ROOT_HELP);
      }
      return EXIT_CODES.success;
    }

    // Preflight gates and configuration must read the same invocation
    // environment. Otherwise an injected test or embedding could report an
    // OpenCode gate as enabled after preflight had already read a different
    // process-level value.
    const effectiveEnvironment: NodeJS.ProcessEnv = { ...(dependencies.env ?? process.env) };
    Object.freeze(effectiveEnvironment);
    preflightInvocation(parsed, effectiveEnvironment);

    const journeyIntent = parsed.command === "claude" || parsed.command === "codex" || parsed.command === "openclaw" || parsed.command === "opencode"
      ? preflightAgentJourneyInvocation(parsed)
      : undefined;

    const foreground = foregroundSelection(parsed);
    if ((foreground !== undefined || journeyIntent?.target === "reconcile") &&
      (writer.structured || !streams.stdinIsTTY || !streams.stdoutIsTTY)) {
      throw usageError(
        "Foreground AgentSession attachment requires an interactive terminal and does not support JSON output.",
        "Run this command directly in an interactive terminal without --json or output redirection.",
      );
    }
    const platform = dependencies.platform ?? createPlatformAdapter({ env: effectiveEnvironment });
    let foregroundPresentation: ForegroundPresentationMode | undefined;
    if (foreground !== undefined) {
      foregroundPresentation = selectNodeForegroundPresentation({
        platform: nodePlatform(platform.kind),
        environment: effectiveEnvironment,
        ...(effectiveEnvironment.TERM === undefined ? {} : { terminalKind: effectiveEnvironment.TERM }),
      });
      if (foregroundPresentation === "plain" && foreground.agentSessionIds.length !== 1) {
        throw usageError(
          "Plain passthrough mode attaches exactly one AgentSession.",
          "Select one AgentSession or use an admitted rich terminal for the multi-tab workbench.",
        );
      }
    }

    let timeoutMs: number;
    try {
      timeoutMs = parseTimeout(stringOption(parsed, "timeout-ms"));
    } catch {
      throw usageError("Option --timeout-ms must be an integer from 100 through 120000.");
    }
    const profile = stringOption(parsed, "profile");
    const baseUrl = stringOption(parsed, "base-url");
    const configFile = stringOption(parsed, "config-file");
    const config = await resolveConfig({
      platform,
      env: effectiveEnvironment,
      overrides: {
        ...(profile === undefined ? {} : { profile }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(configFile === undefined ? {} : { configFile }),
      },
    });
    // Re-admit every executable OpenCode journey from the immutable, resolved
    // configuration. This prevents a mutable embedding environment from
    // passing preflight under one value and reaching remote, host, or child
    // effects after it has changed under another.
    if (journeyIntent?.agent === "opencode") {
      assertOpenCodeExecutionEnabled(config.opencodeFeatureGate);
    }
    // Fail closed before any authority is selected, and only for a command that
    // selects one. Empty or malformed still never means absent: an unusable
    // `*_API_KEY` refuses the command rather than silently demoting automation
    // mode to an interactive browser sign-in.
    if (usesCredentialAuthority(parsed.command, foreground)) assertApiKeyUsable(config);
    const sessionPaths = localEncryptedSessionPaths(platform.paths.configDirectory, config.profile);
    if (config.apiKey !== undefined && (parsed.command === "login" || parsed.command === "signup")) {
      throw new CunaError({
        code: "cuna.auth.mode_conflict",
        message: `Encrypted browser authentication cannot be combined with ${config.apiKeyVariable ?? "CUNA_API_KEY"}.`,
        exitCode: EXIT_CODES.auth,
        hint: "Unset the automation credential before running `cuna login` or another interactive command.",
      });
    }
    if (
      (parsed.command === "login" || parsed.command === "signup") &&
      (writer.structured || !streams.stdinIsTTY || !streams.stdoutIsTTY || streams.stderrIsTTY !== true) &&
      dependencies.humanAuth === undefined &&
      dependencies.browser === undefined &&
      (parsed.command === "login" || parsed.command === "signup")
    ) {
      throw usageError(
        "Browser authentication requires an interactive terminal and does not support JSON or redirected output.",
        "Run `cuna login` directly in a TTY; the one-time link is printed only to the terminal.",
      );
    }
    let humanAuth = dependencies.humanAuth;
    const getHumanAuth = async (): Promise<HumanAuthService> => {
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
        vault: dependencies.credentialVault !== undefined
          ? dependencies.credentialVault
          : new CredentialVault({
          backend: new LocalEncryptedSessionBackend({
            ...sessionPaths,
            platform: nodePlatform(platform.kind),
            ...(dependencies.now === undefined ? {} : { clock: dependencies.now }),
          }),
          platform: nodePlatform(platform.kind),
          ...(dependencies.now === undefined ? {} : { clock: dependencies.now }),
        }),
        browser: dependencies.browser ?? createBrowserOpener(nodePlatform(platform.kind), effectiveEnvironment),
        // Bound to the real stderr the command was given, never to an injected
        // seam. A test that stubs `browser` still sees the URL it would have
        // printed to a user, so "the browser opened" and "the user was told
        // where to go" cannot be proven independently of each other.
        browserHandoff: createTerminalBrowserHandoffReporter(streams.stderr),
        readLoginCode: dependencies.readLoginCode ?? promptLoginCode,
        ...(dependencies.now === undefined ? {} : { clock: dependencies.now }),
      });
      return humanAuth;
    };

    if (
      parsed.command === "signup" ||
      parsed.command === "login" ||
      parsed.command === "logout" ||
      parsed.command === "whoami" ||
      parsed.command === "access"
    ) {
      rejectUnknownOptions(parsed, []);
      if (parsed.command === "access") {
        if (parsed.operands.length !== 1 || parsed.operands[0] !== "status") {
          throw usageError("access requires the status action.");
        }
      } else if (parsed.operands.length !== 0) {
        throw usageError(`${parsed.command} accepts no operands.`);
      }
      if (config.apiKey !== undefined) {
        throw new CunaError({
          code: "cuna.auth.mode_conflict",
          message: `Interactive authentication is disabled while ${config.apiKeyVariable ?? "CUNA_API_KEY"} selects automation mode.`,
          exitCode: EXIT_CODES.auth,
          hint: `Unset ${config.apiKeyVariable ?? "CUNA_API_KEY"} before managing the interactive session.`,
        });
      }
      if (parsed.command === "signup") {
        const result = await (await getHumanAuth()).signup(
          dependencies.signal === undefined ? {} : { signal: dependencies.signal },
        );
        const data = humanResult(result);
        writer.success(
          "signup",
          data,
          result.context.admission === "waitlisted"
            ? `Cuna saved your waitlist place for profile ${result.profile}.`
            : `Cuna completed signup for profile ${result.profile}.`,
        );
      } else if (parsed.command === "login") {
        const result = await (await getHumanAuth()).login(
          dependencies.signal === undefined ? {} : { signal: dependencies.signal },
        );
        const data = Object.freeze({
          ...humanResult(result),
          storage_mode: "encrypted-local" as const,
        });
        writer.success(
          "login",
          data,
          `Signed in to Cuna profile ${result.profile} using the encrypted local session store.`,
        );
      } else if (parsed.command === "whoami" || parsed.command === "access") {
        const result = await (await getHumanAuth()).whoami(dependencies.signal);
        const data = humanResult(result);
        writer.success(
          parsed.command === "access" ? "access.status" : "whoami",
          data,
          `${result.context.identity}\t${result.context.admission}\t${result.context.workspace.state}`,
        );
      } else {
        const result = await (await getHumanAuth()).logout(dependencies.signal);
        writer.success("logout", result, "Signed out of Cuna on this device.");
      }
      return EXIT_CODES.success;
    }

    let bearerToken: string | undefined;
    let credentialMode: "automation" | "interactive" | undefined = config.apiKey === undefined ? undefined : "automation";
    if (config.apiKey === undefined && needsRemoteCredential(parsed.command, foreground)) {
      if (dependencies.clientFactory === undefined || dependencies.humanAuth !== undefined) {
        bearerToken = await (await getHumanAuth()).acquireAccessToken(dependencies.signal);
        credentialMode = "interactive";
      }
    }
    const httpTransport = dependencies.clientFactory === undefined ? createHttpTransport({
      baseUrl: config.baseUrl,
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
      ...(bearerToken === undefined ? {} : { bearerToken }),
      timeoutMs,
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    }) : undefined;
    const client = dependencies.clientFactory?.(config, timeoutMs) ?? createCunaApiClient(httpTransport!);
    if (journeyIntent?.target === "reconcile") {
      if (credentialMode === undefined) {
        throw new CunaError({
          code: "cuna.auth.required",
          message: "The automatic Cuna journey requires authenticated account authority.",
          exitCode: EXIT_CODES.auth,
          hint: `Run \`cuna login\` for interactive use, or use an automation credential. ${automationCredentialHint()}`,
        });
      }
      let effects: AgentJourneyEffects;
      let stopJourneyWorkspace: (() => Promise<void>) | undefined;
      // Read before the effects branch, not inside it: the principal and the
      // workspace are half of the machine-create request identity, so every
      // journey needs them, including the one built from injected effects.
      const identity = await client.getIdentity(dependencies.signal);
      const workspaceId = identity.workspaceId;
      if (workspaceId === undefined) {
        throw new CunaError({
          code: "cuna.journey.workspace_identity_unavailable",
          message: "The signed-in account has no assigned workspace authority.",
          exitCode: EXIT_CODES.auth,
          hint: `Run \`cuna workspace show\` to see the current assignment or waitlist position. Workspace assignment happens at ${CONSOLE_ORIGIN}, not from the CLI.`,
        });
      }
      const journeyScope = Object.freeze({ userId: identity.id, workspaceId });
      if (dependencies.automaticJourneyEffectsFactory !== undefined) {
        effects = dependencies.automaticJourneyEffectsFactory({
          client,
          intent: journeyIntent,
          config,
          platform,
          credentialMode,
          ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
        });
      } else {
        if (httpTransport === undefined) {
          throw new CunaError({
            code: "cuna.journey.workspace_transport_unavailable",
            message: "The injected API client did not provide authenticated workspace-sync transport authority.",
            exitCode: EXIT_CODES.unsupported,
            hint: INTERNAL_DEFECT_HINT,
          });
        }
        const workspace = createWorkspaceJourneyEffects({
          client,
          transport: Object.freeze({
            request: (request: HttpRequest) => httpTransport.request(request),
            authentication: "authenticated" as const,
            credentialAuthority: credentialMode === "interactive" ? "interactive" as const : "api_key" as const,
          }),
          profileId: config.profile,
          userId: identity.id,
          workspaceId,
          stateDirectory: platform.paths.stateDirectory,
          filesystemCapabilities: conservativeFilesystemCapabilities(platform.kind),
        });
        stopJourneyWorkspace = () => workspace.stopContinuousSync();
        const runner = dependencies.foregroundTerminalRunner ?? runNodeForegroundSessions;
        effects = createApiAgentJourneyEffects({
          client,
          inspectWorkspace: workspace.inspectWorkspace,
          synchronizeWorkspace: workspace.synchronizeWorkspace,
          authorizeMachineCreate: async ({ requestedAgent, signal }) =>
            (dependencies.authorizeMachineCreate ?? confirmMachineCreate)(requestedAgent, signal),
          attach: async ({ agentSessionId, expectedAgent, signal }) => {
            const presentationMode = selectNodeForegroundPresentation({
              platform: nodePlatform(platform.kind),
              environment: effectiveEnvironment,
              ...(effectiveEnvironment.TERM === undefined ? {} : { terminalKind: effectiveEnvironment.TERM }),
            });
            await runner({
              client,
              baseUrl: config.baseUrl,
              agentSessionIds: [agentSessionId],
              expectedAgentKinds: [expectedAgent],
              color: !booleanOption(parsed, "no-color") && !Object.hasOwn(effectiveEnvironment, "NO_COLOR"),
              hostPlatform: nodePlatform(platform.kind),
              presentationMode,
              ...(effectiveEnvironment.TERM === undefined ? {} : { terminalKind: effectiveEnvironment.TERM }),
              signal,
            });
          },
          ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        });
      }
      try {
        await orchestrateAgentJourney({
          intent: journeyIntent,
          effects,
          scope: journeyScope,
          ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
        });
      } finally {
        await stopJourneyWorkspace?.();
      }
      return EXIT_CODES.success;
    }
    if (foreground !== undefined) {
      const runner = dependencies.foregroundTerminalRunner ?? runNodeForegroundSessions;
      await runner({
        client,
        baseUrl: config.baseUrl,
        agentSessionIds: foreground.agentSessionIds,
        ...(foreground.expectedAgentKinds === undefined
          ? {}
          : { expectedAgentKinds: foreground.expectedAgentKinds }),
        color: !booleanOption(parsed, "no-color") && !Object.hasOwn(effectiveEnvironment, "NO_COLOR"),
        hostPlatform: nodePlatform(platform.kind),
        ...(foregroundPresentation === undefined ? {} : { presentationMode: foregroundPresentation }),
        ...(effectiveEnvironment.TERM === undefined ? {} : { terminalKind: effectiveEnvironment.TERM }),
        ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
      });
      return EXIT_CODES.success;
    }
    let runtimeFeatures = dependencies.runtimeFeatures;
    if (parsed.command === "doctor" && runtimeFeatures === undefined) {
      const backend = dependencies.doctorCredentialBackend ?? new LocalEncryptedSessionBackend({
        ...sessionPaths,
        platform: nodePlatform(platform.kind),
        ...(dependencies.now === undefined ? {} : { clock: dependencies.now }),
      });
      let credentialBackendStatus: "verified" | "unavailable" | "unknown" = "unknown";
      let credentialBackendReason: string | undefined;
      try {
        const evidence = await backend.probe();
        credentialBackendStatus = evidence.status === "preview" ? "unavailable" : evidence.status;
        credentialBackendReason = evidence.reason;
      } catch {
        credentialBackendStatus = "unavailable";
      }
      const browserLoginRemote = booleanOption(parsed, "check-browser-login")
        ? await probeBrowserLoginRemote({
          config,
          timeoutMs,
          ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
          ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
        })
        : Object.freeze<BrowserLoginRemoteProbe>({
          status: "not_checked",
          reason: "remote_browser_login_not_checked",
        });
      runtimeFeatures = runtimeFeatureGates({
        platform: platform.kind,
        credentialBackendStatus,
        credentialBackendId: backend.backendId,
        ...(credentialBackendReason === undefined ? {} : { credentialBackendReason }),
        browserLoginRemoteStatus: browserLoginRemote.status,
        browserLoginRemoteReason: browserLoginRemote.reason,
      });
    }
    const result = await executeCommand({
      parsed,
      config,
      client,
      now: dependencies.now?.() ?? Date.now(),
      ...(dependencies.agentSessionTerminationPoller === undefined
        ? {}
        : { agentSessionTerminationPoller: dependencies.agentSessionTerminationPoller }),
      ...(credentialMode === undefined ? {} : { credentialMode }),
      ...(runtimeFeatures === undefined ? {} : { runtimeFeatures }),
    });
    writer.success(result.command, result.data, result.human);
    return EXIT_CODES.success;
  } catch (unknownError) {
    const error = unknownError instanceof CredentialBoundaryError
      ? new CunaError({
          code: `cuna.auth.${unknownError.code}`,
          message: unknownError.message,
          exitCode: EXIT_CODES.auth,
          retryable: unknownError.retryable,
          // `RuntimeBoundaryError` already forwards its safe details; this arm
          // dropped them, so the credential backend's reason died here even
          // when the vault had populated it.
          ...(unknownError.safeDetails === undefined ? {} : { details: unknownError.safeDetails }),
          cause: unknownError,
        })
      : unknownError instanceof RuntimeBoundaryError
        ? runtimeError(unknownError)
      : normalizeError(unknownError);
    writer.error(label, error);
    return error.exitCode;
  }
}

export function memoryStreams(input?: {
  readonly stdoutIsTTY?: boolean;
  readonly stdinIsTTY?: boolean;
  readonly stderrIsTTY?: boolean;
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
      stderrIsTTY: input?.stderrIsTTY ?? input?.stdoutIsTTY ?? false,
    }),
    stdout: () => stdout,
    stderr: () => stderr,
  });
}
