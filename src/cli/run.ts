import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";

import { createCunaApiClient, type CunaApiClient } from "../api/client.js";
import { createHttpTransport, type HttpRequest } from "../api/http.js";
import { createBrowserOpener, createManualBrowserOpener, type BrowserOpener } from "../auth/browser.js";
import { createHumanAuthClient } from "../auth/human-client.js";
import { createHumanAuthService, type HumanAuthResult, type HumanAuthService } from "../auth/human-session.js";
import { ARTIFACT_CHANNEL, packageBuildDigest, PROTOCOL_RANGE } from "../build-identity.js";
import { assertApiKeyUsable, resolveConfig, type EffectiveConfig } from "../config/config.js";
import { executeCommand, preflightInvocation } from "../commands/commands.js";
import { EXIT_CODES, normalizeError, CunaError, usageError, type ExitCode } from "../core/errors.js";
import {
  CONSOLE_ORIGIN,
  INTERNAL_DEFECT_HINT,
  automationCredentialHint,
} from "../core/product-web.js";
import { integerArgument } from "../core/validation.js";
import { CredentialBoundaryError } from "../credentials/errors.js";
import { resolvePlatformAuthority, type ResolvedPlatformAuthority } from "../credentials/platform.js";
import { CredentialVault } from "../credentials/vault.js";
import { LocalSessionPreviewBackend, localSessionPreviewPath } from "../credentials/local-session-preview.js";
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
import { createOutputWriter, type CliStreams } from "./output.js";
import { booleanOption, parseArgv, stringOption } from "./parser.js";
import { rejectUnknownOptions } from "./parser.js";
import type { ParsedInvocation } from "./parser.js";

export interface RunCliDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: PlatformAdapter;
  readonly streams?: CliStreams;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly clientFactory?: (config: EffectiveConfig, timeoutMs: number) => CunaApiClient;
  readonly humanAuth?: HumanAuthService;
  readonly credentialVault?: CredentialVault;
  readonly browser?: BrowserOpener;
  readonly signal?: AbortSignal;
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
  readonly authorizeMachineCreate?: (agent: "claude-code" | "codex" | "openclaw", signal: AbortSignal) => Promise<boolean>;
  /** Test-only injection; production uses CUNA_SESSION_PASSPHRASE. */
  readonly sessionPassphrase?: string;
}

async function confirmMachineCreate(agent: "claude-code" | "codex" | "openclaw", signal: AbortSignal): Promise<boolean> {
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
    command === "claude" || command === "codex" || command === "openclaw" || foreground !== undefined;
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
  readonly expectedAgentKinds?: readonly ("claude-code" | "codex" | "openclaw")[];
}

function foregroundSelection(parsed: ParsedInvocation): ForegroundSelection | undefined {
  if (parsed.command === "connect") return Object.freeze({ agentSessionIds: parsed.operands });
  if (parsed.command === "agent-sessions" && parsed.operands[0] === "attach") {
    return Object.freeze({ agentSessionIds: parsed.operands.slice(1) });
  }
  const expectedAgent: "claude-code" | "codex" | "openclaw" | undefined = parsed.command === "claude"
    ? "claude-code"
    : parsed.command === "codex" || parsed.command === "openclaw"
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

function previewSessionPassphrase(
  environment: NodeJS.ProcessEnv,
  injected: string | undefined,
): string {
  const passphrase = injected ?? environment.CUNA_SESSION_PASSPHRASE;
  if (passphrase === undefined || passphrase.length === 0) {
    throw new CunaError({
      code: "cuna.auth.preview_passphrase_required",
      message: "Preview authentication stores an encrypted local session and requires CUNA_SESSION_PASSPHRASE.",
      exitCode: EXIT_CODES.auth,
      hint: "Set a passphrase of at least 12 characters, then retry with --session-only. This is preview storage, not a native vault.",
    });
  }
  return passphrase;
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

    preflightInvocation(parsed);

    const journeyIntent = parsed.command === "claude" || parsed.command === "codex" || parsed.command === "openclaw"
      ? preflightAgentJourneyInvocation(parsed)
      : undefined;

    const foreground = foregroundSelection(parsed);
    const sessionOnly = booleanOption(parsed, "session-only");
    if (sessionOnly && !usesCredentialAuthority(parsed.command, foreground)) {
      throw usageError("Option --session-only applies only to authenticated commands.");
    }
    if (
      sessionOnly &&
      (writer.structured || !streams.stdinIsTTY || !streams.stdoutIsTTY || streams.stderrIsTTY !== true) &&
      dependencies.humanAuth === undefined &&
      dependencies.browser === undefined &&
      (parsed.command === "login" || parsed.command === "signup")
    ) {
      throw usageError(
        "Preview browser authentication requires an interactive terminal and does not support JSON or redirected output.",
        "Run `cuna login --session-only` directly in a TTY; the one-time link is printed only to the terminal.",
      );
    }
    if ((foreground !== undefined || journeyIntent?.target === "reconcile") &&
      (writer.structured || !streams.stdinIsTTY || !streams.stdoutIsTTY)) {
      throw usageError(
        "Foreground AgentSession attachment requires an interactive terminal and does not support JSON output.",
        "Run this command directly in an interactive terminal without --json or output redirection.",
      );
    }
    const effectiveEnvironment = dependencies.env ?? process.env;
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
      ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
      overrides: {
        ...(profile === undefined ? {} : { profile }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(configFile === undefined ? {} : { configFile }),
      },
    });
    // Fail closed before any authority is selected, and only for a command that
    // selects one. Empty or malformed still never means absent: an unusable
    // `*_API_KEY` refuses the command rather than silently demoting automation
    // mode to an interactive browser sign-in.
    if (usesCredentialAuthority(parsed.command, foreground)) assertApiKeyUsable(config);
    if (sessionOnly && config.apiKey !== undefined) {
      throw new CunaError({
        code: "cuna.auth.mode_conflict",
        message: `--session-only cannot be combined with ${config.apiKeyVariable ?? "CUNA_API_KEY"}.`,
        exitCode: EXIT_CODES.auth,
        hint: "Unset the automation credential before starting the encrypted preview session.",
      });
    }
    // One resolution of the signed native authority per process, shared by the
    // credential vault and the Windows browser opener. Both used to construct
    // their own unwired defaults, so neither ever saw a native bridge.
    let platformAuthority: ResolvedPlatformAuthority | undefined;
    const getPlatformAuthority = async (): Promise<ResolvedPlatformAuthority> => {
      platformAuthority ??= await resolvePlatformAuthority({
        platform: nodePlatform(platform.kind),
        ...(dependencies.now === undefined ? {} : { clock: dependencies.now }),
      });
      return platformAuthority;
    };

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
      const authority = sessionOnly
        ? undefined
        : dependencies.credentialVault !== undefined && dependencies.browser !== undefined
        ? undefined
        : await getPlatformAuthority();
      const previewPassphrase = sessionOnly
        ? previewSessionPassphrase(effectiveEnvironment, dependencies.sessionPassphrase)
        : undefined;
      const previewBackend = sessionOnly && dependencies.credentialVault === undefined
        ? new LocalSessionPreviewBackend({
            filePath: localSessionPreviewPath(platform.paths.configDirectory, config.profile),
            passphrase: previewPassphrase!,
            platform: nodePlatform(platform.kind),
            ...(dependencies.now === undefined ? {} : { clock: dependencies.now }),
          })
        : undefined;
      humanAuth = createHumanAuthService({
        config,
        client: humanClient,
        vault: dependencies.credentialVault ?? new CredentialVault({
          backend: previewBackend ?? authority!.credentials,
          platform: nodePlatform(platform.kind),
          ...(dependencies.now === undefined ? {} : { clock: dependencies.now }),
          ...(sessionOnly ? { allowPreviewBackend: true } : {}),
        }),
        browser: dependencies.browser ?? (sessionOnly
          ? createManualBrowserOpener((message) => { streams.stderr.write(message); })
          : createBrowserOpener(
              nodePlatform(platform.kind),
              effectiveEnvironment,
              ...(authority?.browserBridge === undefined ? [] : [authority.browserBridge]),
            )),
        ...(sessionOnly ? { allowPreviewStorage: true } : {}),
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
      rejectUnknownOptions(parsed, ["session-only"]);
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
          ...(sessionOnly ? { storage_mode: "preview" as const } : {}),
        });
        writer.success(
          "login",
          data,
          sessionOnly
            ? `Signed in to Cuna profile ${result.profile} using an encrypted preview session (no native vault).`
            : `Signed in to Cuna profile ${result.profile}.`,
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
    if (config.apiKey === undefined && needsRemoteCredential(parsed.command, foreground) && dependencies.clientFactory === undefined) {
      bearerToken = await (await getHumanAuth()).acquireAccessToken(dependencies.signal);
      credentialMode = "interactive";
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
      const backend = (await getPlatformAuthority()).credentials;
      let credentialBackendStatus: "verified" | "unavailable" | "unknown" = "unknown";
      let credentialBackendReason: string | undefined;
      try {
        const evidence = await backend.probe();
        credentialBackendStatus = evidence.status === "preview" ? "unavailable" : evidence.status;
        credentialBackendReason = evidence.reason;
      } catch {
        credentialBackendStatus = "unavailable";
      }
      runtimeFeatures = runtimeFeatureGates({
        platform: platform.kind,
        credentialBackendStatus,
        credentialBackendId: backend.backendId,
        ...(credentialBackendReason === undefined ? {} : { credentialBackendReason }),
      });
    }
    const result = await executeCommand({
      parsed,
      config,
      client,
      now: dependencies.now?.() ?? Date.now(),
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
