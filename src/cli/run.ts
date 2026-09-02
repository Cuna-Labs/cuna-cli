import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { createCunaApiClient, type CunaApiClient } from "../api/client.js";
import { createHttpTransport, type BearerRefreshRequest, type HttpRequest } from "../api/http.js";
import { createBrowserOpener, type BrowserOpener } from "../auth/browser.js";
import type { BrowserHandoffReporter } from "../auth/browser-handoff.js";
import { createHumanAuthClient } from "../auth/human-client.js";
import { createHumanAuthService, type HumanAuthResult, type HumanAuthService } from "../auth/human-session.js";
import { ARTIFACT_CHANNEL, packageBuildDigest, PROTOCOL_RANGE } from "../build-identity.js";
import { assertApiKeyUsable, resolveConfig, type EffectiveConfig } from "../config/config.js";
import {
  executeCommand,
  preflightInvocation,
  type ConvergencePoller,
} from "../commands/commands.js";
import { EXIT_CODES, normalizeError, CunaError, unsupportedError, usageError, type ExitCode } from "../core/errors.js";
import { DEFAULT_REQUEST_BUDGET_MS } from "../core/observation-budget.js";
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
  type AgentJourneyPhase,
  type ReconciledAgentJourneyIntent,
} from "../journey/index.js";
import {
  rootJourneyArgv,
  runNodeRootJourney,
  type RootJourneyRunner,
} from "../journey/root-entry.js";
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
import { runNodeMachinesExplorer, type MachinesExplorerRunner } from "../machines/explorer.js";
import { isOpenCodeSupervisorUpgradeReason } from "../machines/opencode-supervisor.js";
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
   * Test seam for every bounded read-back that waits for an accepted mutation to
   * become visible. Production always uses a wall-clock deadline.
   */
  readonly convergencePoller?: ConvergencePoller;
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
  readonly machinesExplorerRunner?: MachinesExplorerRunner;
  readonly rootJourneyRunner?: RootJourneyRunner;
  /** Internal root-UI hint; never parsed from or printed to user input. */
  readonly managedWorkspaceMachineId?: string;
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
  // Three facts, one line each: where to go, what to do there, and — only when
  // it happened — what went wrong. Everything the longer copy added was
  // description of the link ("single-use") or of the mechanism ("in your
  // browser", "automatically"), which the person is not deciding anything with
  // while a terminal waits on them.
  const reporter: BrowserHandoffReporter = {
    continuationUrl(url) {
      line("");
      line("Sign in to Cuna:");
      line("");
      line(`  ${url}`);
      line("");
    },
    browserOpened() {
      line("Opened your browser. Approve there, then paste the code below.");
    },
    browserOpenFailed() {
      line("Could not open a browser. Open the link above, then paste the code below.");
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
 * The control sequences several terminals wrap a paste in while raw mode is
 * active. They are input framing, not pasted content: `finish` strips them from
 * the value and `maskedLength` excludes them from the echo, so the number of
 * mask characters on screen equals the number of credential bytes accepted.
 */
const BRACKETED_PASTE_START = `${String.fromCharCode(0x1b)}[200~`;
const BRACKETED_PASTE_END = `${String.fromCharCode(0x1b)}[201~`;

/** One mask character stands for one accepted byte. */
const LOGIN_CODE_MASK = "*";

/**
 * How many accepted bytes the person should currently see masked — the buffer
 * length minus whichever bracketed-paste markers are present. Derived from the
 * same buffer `finish` reads, so the count on screen cannot drift from the
 * value that will be submitted.
 */
function maskedLength(bytes: readonly number[]): number {
  const raw = Buffer.from(bytes).toString("binary");
  let length = bytes.length;
  if (raw.startsWith(BRACKETED_PASTE_START)) length -= BRACKETED_PASTE_START.length;
  if (raw.endsWith(BRACKETED_PASTE_END)) length -= BRACKETED_PASTE_END.length;
  return length < 0 ? 0 : length;
}

/**
 * Read the reusable browser login code without writing its bytes to terminal
 * output. `readline.question` echoes pasted text, which is unacceptable for a
 * credential retained in the encrypted local session store. Raw TTY input is
 * the narrowest portable Node primitive that gives this command that boundary.
 *
 * This intentionally refuses pipes and terminals without `setRawMode`: a
 * process that cannot suppress echo must not accept the durable code at all.
 *
 * Suppressing the bytes is not the same as suppressing all feedback. For a
 * TYPED password an empty prompt is correct, because the person knows what they
 * pressed. For a PASTED high-entropy code it is a dead end: nothing on screen
 * distinguishes "the clipboard was empty", "the paste arrived", and "the paste
 * arrived twice", so the only way to find out is to submit and read the error.
 * So each accepted byte echoes one mask character and a backspace erases one,
 * which keeps the display a truthful count of what will be submitted. That
 * reveals the code's LENGTH and nothing else, and the length is already fixed
 * and public in the `cuna_login_` format.
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
  // `resume()` below refs the terminal handle. Remember whether another
  // consumer was already flowing so a completed login does not leave stdin
  // keeping the whole CLI process alive after the success message.
  const wasFlowing = input.readableFlowing === true;
  const bytes: number[] = [];
  const maxBytes = 256;
  let masked = 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    /**
     * Reconcile the echo with the buffer instead of emitting per keystroke. A
     * paste can be split across chunks and its closing marker only becomes
     * recognizable on the last one, so the mask count is recomputed from the
     * whole buffer rather than incremented as bytes arrive.
     */
    const renderMask = () => {
      const target = maskedLength(bytes);
      if (target > masked) output.write(LOGIN_CODE_MASK.repeat(target - masked));
      else if (target < masked) output.write("\b \b".repeat(masked - target));
      masked = target;
    };
    const cleanup = () => {
      input.off("data", onData);
      input.off("error", onError);
      input.off("end", onEnd);
      signal?.removeEventListener("abort", onAbort);
      try { input.setRawMode?.(wasRaw); } catch { /* best-effort terminal restoration */ }
      if (!wasFlowing) input.pause();
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
      // Accept exactly the bracketed-paste pair, never arbitrary escapes.
      const withoutPasteStart = raw.startsWith(BRACKETED_PASTE_START)
        ? raw.slice(BRACKETED_PASTE_START.length)
        : raw;
      const value = withoutPasteStart.endsWith(BRACKETED_PASTE_END)
        ? withoutPasteStart.slice(0, -BRACKETED_PASTE_END.length)
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
        // Render before finishing. A clipboard whose contents end in a newline
        // delivers the code and the Enter in ONE chunk, so returning straight
        // into `finish` here would submit a paste that was never drawn — the
        // exact no-feedback case this mask exists to remove.
        if (byte === 0x0d || byte === 0x0a) {
          renderMask();
          return finish();
        }
        if (byte === 0x08 || byte === 0x7f) {
          bytes.pop();
          continue;
        }
        if (bytes.length >= maxBytes) {
          return settle({ error: loginCodeInputError("too_long", "The pasted Cuna login code is too long.") });
        }
        bytes.push(byte);
      }
      renderMask();
    };

    try {
      input.setRawMode(true);
      // The host and the `cuna_login_` prefix were both already on screen —
      // the host in the link three lines up, the prefix in the code the person
      // is holding in their clipboard. "(input hidden)" stays because it is
      // still true and still the thing worth saying: the mask below shows the
      // length, never the bytes.
      output.write("Paste the login code (input hidden): ");
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

/**
 * The caller's explicit per-request budget, or `undefined` when they gave none.
 *
 * This used to return the literal `15_000` for an absent flag, which erased the
 * difference between "the user chose 15 seconds" and "the user chose nothing" —
 * and with it any possibility of an operation declaring a budget of its own.
 * `machines create` waits ~50 s on the producer and was cut off at 15 s by a
 * default nobody had asked for, then told the user the network had timed out.
 * The default now lives in `core/observation-budget.ts` and is applied by the
 * transport, after a per-operation budget has had its chance.
 */
function parseTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
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
    command === "claude" || command === "codex" || command === "opencode" || foreground !== undefined;
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
  const expectedAgent: "claude-code" | "codex" | "opencode" | undefined = parsed.command === "claude"
    ? "claude-code"
    : parsed.command === "codex"
      ? "codex"
      : parsed.command === "opencode"
        ? "opencode"
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

function platformHomeDirectory(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  const candidate = platform === "win32" ? environment.USERPROFILE : environment.HOME;
  return typeof candidate === "string" && candidate.trim() !== "" ? candidate : undefined;
}

function sameHostPath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const canonicalLeft = resolve(left);
  const canonicalRight = resolve(right);
  return platform === "win32"
    ? canonicalLeft.toLocaleLowerCase("en-US") === canonicalRight.toLocaleLowerCase("en-US")
    : canonicalLeft === canonicalRight;
}

function managedWorkspaceScope(intent: ReconciledAgentJourneyIntent, machineId?: string): string {
  if (machineId !== undefined) {
    const digest = createHash("sha256").update(machineId, "utf8").digest("hex").slice(0, 16);
    return `machine-${digest}`;
  }
  if (intent.machine.kind === "exact-name") {
    const digest = createHash("sha256").update(intent.machine.name, "utf8").digest("hex").slice(0, 16);
    return `machine-${digest}`;
  }
  return `${intent.agent}-${intent.machine.kind}`;
}

function agentDisplayName(agent: string): string {
  return agent === "claude-code" ? "Claude Code"
    : agent === "codex" ? "Codex"
    : agent === "opencode" ? "OpenCode"
    : "OpenClaw";
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

/**
 * A credential refresh that failed because the request did — a 429, a 5xx, a
 * timeout — is not an auth failure. Reporting it as one exits `auth`, which
 * this CLI documents as "no usable credential", and sends a person to
 * `cuna login` to fix something that clears on its own. The exit-code contract
 * already promises that "HTTP 429 and 5xx arrive as `cuna.network.rate_limited`
 * and `cuna.network.service_unavailable`"; this keeps that promise across the
 * credential boundary, where the class used to be overwritten.
 *
 * Every authenticated command re-exchanges the stored login code, and the
 * server allows ten exchanges per rolling minute, so the eleventh command in a
 * minute lands here. Say that, rather than doubting the credential.
 */
function credentialError(error: CredentialBoundaryError): CunaError {
  const reason = error.safeDetails?.["reason"];
  const transport = typeof reason === "string" &&
      (reason.startsWith("cuna.network.") || reason.startsWith("cuna.client."))
    ? reason
    : undefined;
  if (transport !== undefined) {
    return new CunaError({
      code: transport,
      message: "Cuna could not renew this session because the request did not complete.",
      exitCode: EXIT_CODES.network,
      retryable: true,
      hint: transport === "cuna.network.rate_limited"
        ? "This account exchanged its sign-in too many times in the last minute. Wait a minute and run the command again. The stored session is unchanged and `cuna login` is not needed."
        : "Run the command again. The stored session is unchanged.",
      details: { reason: transport },
      cause: error,
    });
  }
  return new CunaError({
    code: `cuna.auth.${error.code}`,
    message: error.message,
    exitCode: EXIT_CODES.auth,
    retryable: error.retryable,
    // `RuntimeBoundaryError` already forwards its safe details; this arm
    // dropped them, so the credential backend's reason died here even
    // when the vault had populated it.
    ...(error.safeDetails === undefined ? {} : { details: error.safeDetails }),
    cause: error,
  });
}

interface InlineProgress {
  update(label: string): void;
  /** Print one durable line above the spinner, then keep spinning. */
  note(line: string): void;
  stop(): void;
}

const INLINE_CLOSE_FRAME_MS = 90;
const INLINE_CLOSE_FRAMES = Object.freeze(["✦ Closing Cuna...", "✧ Closing Cuna...", "✓ Closed."]);

function waitForUiFrame(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function animateInlineClose(stream: Writable, color: boolean): Promise<void> {
  for (const [index, frame] of INLINE_CLOSE_FRAMES.entries()) {
    const styled = color
      ? index === INLINE_CLOSE_FRAMES.length - 1
        ? `\u001b[38;5;42m\u001b[1m${frame}\u001b[0m`
        : `\u001b[38;5;202m${frame}\u001b[0m`
      : frame;
    stream.write(`\r\u001b[2K${styled}`);
    await waitForUiFrame(INLINE_CLOSE_FRAME_MS);
  }
  stream.write("\n");
}

function isTerminalResumeHandleConflict(error: CunaError): boolean {
  return error.code === "cuna.remote.conflict" &&
    error.details?.reason === "terminal_connection_resume_handle_conflict";
}

function terminalSupervisorReadiness(error: CunaError): "waiting" | "lease_expired" | "upgrade_required" | "unverified" | undefined {
  if (
    error.code !== "cuna.runtime.capability_unknown" &&
    error.code !== "cuna.runtime.capability_unavailable"
  ) return undefined;
  const reason = error.details?.reason_code;
  if (isOpenCodeSupervisorUpgradeReason(reason)) return "upgrade_required";
  if (reason === "runtime_lease_expired") return "lease_expired";
  if (reason === "supervisor_registry_unavailable") return "waiting";
  // A capability-abstention at this exact boundary is not an actionable CLI
  // error for a person.  The server has declined to prove that it can mint an
  // attached terminal; Cuna must leave the AgentSession alone and explain the
  // transient state without leaking the internal capability vocabulary.
  if (error.details?.capability_id === "terminal_connections.create") return "unverified";
  return undefined;
}

function writeTerminalReconnectConflict(stream: Writable, color: boolean): void {
  const accent = (value: string): string => color ? `\u001b[38;5;202m\u001b[1m${value}\u001b[0m` : value;
  const success = (value: string): string => color ? `\u001b[38;5;42m${value}\u001b[0m` : value;
  stream.write(`${accent("◆ CUNA")}  Terminal connection changed\n`);
  stream.write("The previous terminal link was already replaced.\n");
  stream.write(`${success("Cuna did not stop the remote AgentSession.")}\n`);
  stream.write("Run `cuna` again to reconnect.\n");
}

function writeTerminalSupervisorReadiness(
  stream: Writable,
  color: boolean,
  state: "waiting" | "lease_expired" | "upgrade_required" | "unverified",
): void {
  const accent = (value: string): string => color ? `\u001b[38;5;202m\u001b[1m${value}\u001b[0m` : value;
  const success = (value: string): string => color ? `\u001b[38;5;42m${value}\u001b[0m` : value;
  if (state === "upgrade_required") {
    stream.write(`${accent("◆ CUNA")}  Machine terminal update needed\n`);
    stream.write("This machine needs its terminal supervisor updated before it can attach.\n");
  } else if (state === "lease_expired") {
    stream.write(`${accent("◆ CUNA")}  AgentSession needs a fresh runtime check\n`);
    stream.write("The machine has not recently confirmed that this selected AgentSession is still running.\n");
  } else if (state === "unverified") {
    stream.write(`${accent("◆ CUNA")}  Terminal connection not ready\n`);
    stream.write("Cuna could not verify this machine's terminal authority yet.\n");
  } else {
    stream.write(`${accent("◆ CUNA")}  Waiting for the machine terminal supervisor\n`);
    stream.write("The machine is reconnecting its terminal control.\n");
  }
  if (state === "unverified") {
    stream.write(`${success("Cuna did not attach a terminal and did not change the remote AgentSession.")}\n`);
    stream.write("Open this same AgentSession again in a moment.\n");
  } else {
    stream.write(`${success("No terminal connection was created and the remote AgentSession was not changed.")}\n`);
    stream.write(state === "lease_expired"
      ? "Wait for a fresh runtime observation, then open this same AgentSession again.\n"
      : state === "upgrade_required"
        ? "After the stopped-machine supervisor update, open this same AgentSession again.\n"
        : "When the machine terminal control reconnects, open this same AgentSession again.\n");
  }
}

function startInlineProgress(stream: Writable, color: boolean, initialLabel = "Loading machines"): Readonly<InlineProgress> {
  const frames = ["◐", "◓", "◑", "◒"];
  const bars = ["━╺━━━━", "━━╺━━━", "━━━╺━━", "━━━━╺━", "━━━━━╺", "━━━━╸━", "━━━╸━━", "━━╸━━━"];
  const startedAt = Date.now();
  let frame = 0;
  let label = initialLabel;
  let stopped = false;
  const paint = (): void => {
    const elapsed = Date.now() - startedAt;
    // A spinner alone is too easy to mistake for a frozen cursor on slower
    // Windows terminals. Keep the phase honest, then add a small, actionable
    // acknowledgement while an authenticated read is still in flight.
    const slowHint = elapsed >= 12_000
      ? " · still working — Ctrl-C cancels"
      : elapsed >= 4_000
        ? " · still working"
        : "";
    const text = `◆ CUNA  ${frames[frame % frames.length]} ${label}${slowHint}  ${bars[frame % bars.length]}`;
    const styled = color
      ? `\u001b[38;5;202m\u001b[1m◆ CUNA\u001b[0m  \u001b[38;5;202m${frames[frame % frames.length]}\u001b[0m \u001b[38;5;255m\u001b[1m${label}\u001b[0m\u001b[38;5;245m${slowHint}\u001b[0m  \u001b[38;5;208m${bars[frame % bars.length]}\u001b[0m`
      : text;
    stream.write(`\r\u001b[2K${styled}`);
    frame += 1;
  };
  paint();
  const timer = setInterval(paint, 90);
  timer.unref();
  return Object.freeze({
    update(nextLabel: string) {
      if (stopped || nextLabel === label) return;
      label = nextLabel;
      paint();
    },
    note(line: string) {
      if (stopped) {
        stream.write(`${line}\n`);
        return;
      }
      // Clear the spinner row, leave the line behind, resume spinning below it.
      stream.write(`\r${String.fromCharCode(0x1b)}[2K${line}\n`);
      paint();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      stream.write("\r\u001b[2K");
    },
  });
}

function writeJourneyDiscovery(stream: Writable, color: boolean): void {
  if (!color) {
    stream.write("Cuna: finding a machine or AgentSession to open...\n");
    return;
  }
  stream.write(`\u001b[38;5;202m\u001b[1m◆ CUNA\u001b[0m  \u001b[38;5;255mFinding a machine or AgentSession\u001b[0m\n`);
}

function journeyPhaseLabel(phase: AgentJourneyPhase, agent: "claude-code" | "codex" | "opencode"): string {
  const display = agentDisplayName(agent);
  switch (phase) {
    case "inspect-workspace": return "Inspecting workspace";
    case "observe-machines": return "Finding a compatible machine";
    case "create-machine": return "Creating machine";
    case "reconcile-machine-create": return "Confirming machine creation";
    case "ready-machine": return "Starting machine";
    case "synchronize-workspace": return "Syncing workspace";
    case "observe-agent-sessions": return `Finding ${/^[AEIOU]/u.test(display) ? "an" : "a"} ${display} session`;
    case "create-agent-session": return `Creating ${display} session`;
    case "ready-agent-session": return `Starting ${display}`;
    case "attach": return agent === "opencode"
      ? "Opening OpenCode terminal — use /connect there"
      : `Opening ${display}`;
  }
}

function journeyPreparationLabel(agent: string): string {
  return agent === "opencode"
    ? "Preparing OpenCode — use /connect in its terminal"
    : `Preparing ${agentDisplayName(agent)}`;
}

function foregroundAttachLabel(agent: string): string {
  return agent === "opencode"
    ? "Opening OpenCode terminal — use /connect there"
    : `Attaching to ${agentDisplayName(agent)}`;
}

export async function runCli(argv: readonly string[], dependencies: RunCliDependencies = {}): Promise<ExitCode> {
  const streams = dependencies.streams ?? defaultStreams();
  const writer = createOutputWriter({ streams, json: argv.includes("--json") });
  const label = commandLabel(argv);
  let inlineMachinesProgress: Readonly<InlineProgress> | undefined;
  let inlineJourneyProgress: Readonly<InlineProgress> | undefined;
  let inlineRootProgress: Readonly<InlineProgress> | undefined;
  let interactiveRootUi = false;
  let interactiveRootColor = false;
  // Root discovery, an explicit foreground attach, and an automatic provider
  // journey all own the terminal interactively.  They must share the same
  // one-Ctrl-C close affordance; restricting it to bare `cuna` leaked a raw
  // journey cancellation error from `cuna opencode` before it reached the PTY.
  let interactiveCloseUi = false;
  let interactiveCloseColor = false;
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
      // Both `cuna version --json` and the help text promise version, build
      // digest, platform and protocol range; the human branch printed the
      // version alone. The digest is the one field that separates two
      // installations reporting the same `0.1.0` — measured 2026-08-25, when
      // the installed CLI was not the repo build and nothing printed said so.
      // It is shown as a 12-hex prefix with the same `…` this CLI already uses
      // for a truncated API-key prefix, so it can never read as the whole hash.
      const humanIdentity = `${identity.version}\tbuild ${identity.buildDigest.slice(0, 12)}…` +
        `\t${identity.platform}/${identity.architecture}` +
        `\tprotocol ${identity.protocolRange.minimum}..${identity.protocolRange.maximum}`;
      if (writer.structured) {
        writer.success("version", identity, humanIdentity);
      } else {
        writer.text(humanIdentity);
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
      if (topic === "openclaw") {
        throw usageError(`Unknown command ${topic}.`, "Run `cuna --help`.");
      }
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
    const interactiveRoot = parsed.command === undefined &&
      !writer.structured && streams.stdinIsTTY && streams.stdoutIsTTY;
    interactiveRootUi = interactiveRoot;
    if (parsed.command === undefined && !interactiveRoot) {
      if (writer.structured) {
        writer.success("help", { version: CLI_VERSION, output_schema_version: OUTPUT_SCHEMA_VERSION, help: ROOT_HELP }, ROOT_HELP);
      } else {
        writer.text(ROOT_HELP);
      }
      return EXIT_CODES.success;
    }

    // A bare interactive invocation must acknowledge input before any local
    // credential-store, configuration, or network read.  In particular, an
    // access-token refresh can take several seconds; leaving the terminal
    // blank during that work makes Cuna look stuck and encourages a duplicate
    // invocation.  The phase remains deliberately neutral until config and
    // authentication tell us what is actually happening.
    const effectiveEnvironment: NodeJS.ProcessEnv = { ...(dependencies.env ?? process.env) };
    Object.freeze(effectiveEnvironment);
    if (interactiveRoot) {
      const color = !booleanOption(parsed, "no-color") && !Object.hasOwn(effectiveEnvironment, "NO_COLOR");
      interactiveRootColor = color;
      interactiveCloseUi = true;
      interactiveCloseColor = color;
      if (streams.stderrIsTTY === true) {
        inlineRootProgress = startInlineProgress(streams.stderr, color, "Starting Cuna");
      } else {
        streams.stderr.write("Cuna: starting...\n");
      }
    }

    // Preflight gates and configuration must read the same invocation
    // environment. This keeps credential and profile selection deterministic
    // across embedded invocations.
    if (parsed.command !== undefined) preflightInvocation(parsed, (dependencies.now ?? Date.now)());

    let journeyIntent = parsed.command === "claude" || parsed.command === "codex" || parsed.command === "opencode"
      ? preflightAgentJourneyInvocation(parsed)
      : undefined;
    if (journeyIntent?.target === "reconcile" && journeyIntent.localPath === undefined) {
      const homeDirectory = platformHomeDirectory(effectiveEnvironment, process.platform);
      if (homeDirectory !== undefined && sameHostPath(process.cwd(), homeDirectory, process.platform)) {
        // Keep HOME safe without forcing every machine to share one local
        // binding. Exact machine selections get a stable private root; the
        // automatic root remains stable so its committed binding can guide
        // later automatic selection.
        // Do not nest these roots under the former single-root `~/Cuna`.
        // Workspace binding discovery intentionally walks ancestors, so a
        // child below that already-bound root would inherit its record and
        // then fail the child-root compare-and-swap.
        const managedWorkspace = join(
          homeDirectory,
          "Cuna Workspaces",
          managedWorkspaceScope(journeyIntent, dependencies.managedWorkspaceMachineId),
        );
        await mkdir(managedWorkspace, { recursive: true });
        journeyIntent = Object.freeze({ ...journeyIntent, localPath: managedWorkspace });
      }
    }

    const foreground = foregroundSelection(parsed);
    if ((foreground !== undefined || journeyIntent?.target === "reconcile") &&
      (writer.structured || !streams.stdinIsTTY || !streams.stdoutIsTTY)) {
      throw usageError(
        "Foreground AgentSession attachment requires an interactive terminal and does not support JSON output.",
        "Run this command directly in an interactive terminal without --json or output redirection.",
      );
    }
    if ((journeyIntent !== undefined || foreground !== undefined) &&
      !writer.structured && streams.stdinIsTTY && streams.stdoutIsTTY && streams.stderrIsTTY) {
      interactiveCloseUi = true;
      interactiveCloseColor = !booleanOption(parsed, "no-color") && !Object.hasOwn(effectiveEnvironment, "NO_COLOR");
    }
    if (journeyIntent !== undefined) {
      // This is deliberately before config, credential, and network work: it
      // tells the truth immediately without claiming that attach has begun.
      const preparation = journeyPreparationLabel(journeyIntent.agent);
      const color = !booleanOption(parsed, "no-color") && !Object.hasOwn(effectiveEnvironment, "NO_COLOR");
      if (streams.stderrIsTTY === true) inlineJourneyProgress = startInlineProgress(streams.stderr, color, preparation);
      else streams.stderr.write(`Cuna: ${preparation.charAt(0).toLowerCase()}${preparation.slice(1)}...\n`);
    }
    const platform = dependencies.platform ?? createPlatformAdapter({ env: effectiveEnvironment });
    let foregroundPresentation: ForegroundPresentationMode | undefined;
    if (foreground !== undefined) {
      foregroundPresentation = selectNodeForegroundPresentation({
        platform: nodePlatform(platform.kind),
        environment: effectiveEnvironment,
        sessionCount: foreground.agentSessionIds.length,
        ...(effectiveEnvironment.TERM === undefined ? {} : { terminalKind: effectiveEnvironment.TERM }),
      });
      if (foregroundPresentation === "plain" && foreground.agentSessionIds.length !== 1) {
        throw usageError(
          "Plain passthrough mode attaches exactly one AgentSession.",
          "Select one AgentSession or use an admitted rich terminal for the multi-tab workbench.",
        );
      }
    }

    let timeoutMs: number | undefined;
    try {
      timeoutMs = parseTimeout(stringOption(parsed, "timeout-ms"));
    } catch {
      throw usageError("Option --timeout-ms must be an integer from 100 through 120000.");
    }
    // Seams and probes that never carry a per-operation budget still need one
    // number, and it is the same number, read from the same constant.
    const effectiveTimeoutMs = timeoutMs ?? DEFAULT_REQUEST_BUDGET_MS;
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
    if (interactiveRoot) {
      inlineRootProgress?.update(config.apiKey === undefined ? "Checking your Cuna sign-in" : "Checking Cuna access");
    }
    // Fail closed before any authority is selected, and only for a command that
    // selects one. Empty or malformed still never means absent: an unusable
    // `*_API_KEY` refuses the command rather than silently demoting automation
    // mode to an interactive browser sign-in.
    if (interactiveRoot || usesCredentialAuthority(parsed.command, foreground)) assertApiKeyUsable(config);
    const sessionPaths = localEncryptedSessionPaths(platform.paths.configDirectory, config.profile);
    if (config.apiKey !== undefined && (parsed.command === "login" || parsed.command === "signup")) {
      throw new CunaError({
        code: "cuna.auth.mode_conflict",
        message: `Encrypted browser authentication cannot be combined with ${config.apiKeyVariable ?? "CUNA_API_KEY"}.`,
        exitCode: EXIT_CODES.auth,
        hint: "Unset the automation credential before running `cuna login` or another interactive command.",
      });
    }
    const browserAuthUnavailable =
      (parsed.command === "login" || parsed.command === "signup") &&
      (writer.structured || !streams.stdinIsTTY || !streams.stdoutIsTTY || streams.stderrIsTTY !== true) &&
      dependencies.humanAuth === undefined &&
      dependencies.browser === undefined;
    const browserAuthUsageError = (): CunaError => usageError(
      "Browser authentication requires an interactive terminal and does not support JSON or redirected output.",
      "Run `cuna login` directly in a TTY; the one-time link is printed only to the terminal.",
    );
    // `signup` always needs the browser. `login` decides after reading the
    // vault: a profile that is already signed in has nothing to print, and
    // "already signed in" is the answer, not a usage error (the one-time link
    // is still never written to redirected output — see the login branch).
    if (browserAuthUnavailable && parsed.command === "signup") throw browserAuthUsageError();
    let humanAuth = dependencies.humanAuth;
    const getHumanAuth = async (): Promise<HumanAuthService> => {
      if (humanAuth !== undefined) return humanAuth;
      const transportOptions = {
        baseUrl: config.baseUrl,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
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

    // The primary human entry points own authentication as part of their
    // journey. A person who runs `cuna`, `cuna machines`, `cuna claude`, or
    // `cuna codex` should never see machine-discovery feedback followed by an
    // instruction to discover a separate login command. Establish or recover
    // the interactive session first, then begin the product action.
    const guidedInteractiveEntry = config.apiKey === undefined && (
      interactiveRoot ||
      (parsed.command === "machines" && parsed.operands.length === 0 &&
        !writer.structured && streams.stdinIsTTY && streams.stdoutIsTTY) ||
      journeyIntent?.target === "reconcile"
    );
    if (guidedInteractiveEntry) {
      const guidedAuth = await getHumanAuth();
      try {
        await guidedAuth.acquireAccessToken(dependencies.signal);
      } catch (error) {
        if (!(error instanceof CunaError) ||
          (error.code !== "cuna.auth.required" && error.code !== "cuna.auth.reauthentication_required")) {
          throw error;
        }
        inlineRootProgress?.stop();
        inlineRootProgress = undefined;
        streams.stderr.write("Cuna: let's sign you in first...\n");
        await guidedAuth.login(dependencies.signal === undefined ? {} : { signal: dependencies.signal });
        streams.stderr.write("Cuna: signed in. Continuing...\n");
        if (interactiveRoot && streams.stderrIsTTY === true) {
          inlineRootProgress = startInlineProgress(streams.stderr, interactiveRootColor, "Finding a machine or AgentSession");
        }
      }
    }

    // Progress starts only after authentication is usable. This ordering is
    // observable UX: it must not claim to search machines while login is the
    // actual operation in progress.
    if (journeyIntent !== undefined) {
      const display = agentDisplayName(journeyIntent.agent);
      if (inlineJourneyProgress !== undefined) inlineJourneyProgress.update(`Connecting to ${display}`);
      else streams.stderr.write(`Cuna: connecting to ${display}...\n`);
    }
    if (
      parsed.command === "machines" && parsed.operands.length === 0 &&
      !writer.structured && streams.stdinIsTTY && streams.stdoutIsTTY
    ) {
      const color = !booleanOption(parsed, "no-color") && !Object.hasOwn(effectiveEnvironment, "NO_COLOR");
      if (streams.stderrIsTTY === true) inlineMachinesProgress = startInlineProgress(streams.stderr, color);
      else streams.stderr.write("Cuna: loading machines...\n");
    }

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
        const auth = await getHumanAuth();
        let result;
        let alreadySignedIn = false;
        if (browserAuthUnavailable) {
          // No terminal to print a link to: the only login that can succeed
          // here is the one that already happened.
          try {
            result = await auth.whoami(dependencies.signal);
          } catch {
            throw browserAuthUsageError();
          }
          alreadySignedIn = true;
        } else {
          try {
            result = await auth.login(
              dependencies.signal === undefined ? {} : { signal: dependencies.signal },
            );
          } catch (error) {
          // Being signed in already is the outcome the user asked for, not a
          // failure: report who they are and how to switch, exit 0.
          if (!(error instanceof CunaError) || error.code !== "cuna.auth.already_signed_in") throw error;
          result = await auth.whoami(dependencies.signal);
          alreadySignedIn = true;
          }
        }
        const data = Object.freeze({
          ...humanResult(result),
          storage_mode: "encrypted-local" as const,
          already_signed_in: alreadySignedIn,
        });
        writer.success(
          "login",
          data,
          alreadySignedIn
            ? `Already signed in as ${result.context.identity}. Run \`cuna logout\` to switch accounts.`
            : "Signed in to Cuna.",
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

    let bearerTokenProvider: ((signal?: AbortSignal, refresh?: BearerRefreshRequest) => Promise<string>) | undefined;
    let credentialMode: "automation" | "interactive" | undefined = config.apiKey === undefined ? undefined : "automation";
    if (config.apiKey === undefined && (interactiveRoot || needsRemoteCredential(parsed.command, foreground))) {
      if (dependencies.clientFactory === undefined || dependencies.humanAuth !== undefined) {
        const humanAuth = await getHumanAuth();
        if (dependencies.clientFactory === undefined) {
          bearerTokenProvider = (signal, refresh) => refresh === undefined
            ? humanAuth.acquireAccessToken(signal)
            : humanAuth.refreshRejectedAccessToken(refresh.rejectedToken, signal);
        } else {
          await humanAuth.acquireAccessToken(dependencies.signal);
        }
        credentialMode = "interactive";
      }
    }
    const httpTransport = dependencies.clientFactory === undefined ? createHttpTransport({
      baseUrl: config.baseUrl,
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
      ...(bearerTokenProvider === undefined ? {} : { bearerTokenProvider }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    }) : undefined;
    const client = dependencies.clientFactory?.(config, effectiveTimeoutMs) ?? createCunaApiClient(httpTransport!);
    if (interactiveRoot) {
      const color = !booleanOption(parsed, "no-color") && !Object.hasOwn(effectiveEnvironment, "NO_COLOR");
      interactiveRootColor = color;
      interactiveCloseUi = true;
      interactiveCloseColor = color;
      if (streams.stderrIsTTY === true) {
        if (inlineRootProgress === undefined) {
          inlineRootProgress = startInlineProgress(streams.stderr, color, "Finding a machine or AgentSession");
        } else {
          inlineRootProgress.update("Finding a machine or AgentSession");
        }
      } else {
        writeJourneyDiscovery(streams.stderr, false);
      }
      const rootRunner = dependencies.rootJourneyRunner ?? runNodeRootJourney;
      let selection: Awaited<ReturnType<RootJourneyRunner>>;
      try {
        selection = await rootRunner({
          client,
          color,
          onBeforeTerminalOwnership: () => {
            inlineRootProgress?.stop();
            inlineRootProgress = undefined;
          },
          ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
        }, dependencies.now === undefined ? {} : { now: dependencies.now });
      } finally {
        inlineRootProgress?.stop();
        inlineRootProgress = undefined;
      }
      if (selection === undefined) {
        if (dependencies.signal?.aborted === true && streams.stderrIsTTY === true) {
          await animateInlineClose(streams.stderr, color);
        }
        return EXIT_CODES.success;
      }
      if (selection.kind === "attach") {
        const attachLabel = foregroundAttachLabel(selection.agent);
        if (streams.stderrIsTTY === true) inlineRootProgress = startInlineProgress(streams.stderr, color, attachLabel);
        else streams.stderr.write(`Cuna: ${attachLabel.charAt(0).toLowerCase()}${attachLabel.slice(1)}...\n`);
        const runner = dependencies.foregroundTerminalRunner ?? runNodeForegroundSessions;
        try {
          await runner({
            client,
            baseUrl: config.baseUrl,
            browser: dependencies.browser ?? createBrowserOpener(nodePlatform(platform.kind), effectiveEnvironment),
            agentSessionIds: [selection.agentSessionId],
            expectedAgentKinds: [selection.agent],
            color,
            hostPlatform: nodePlatform(platform.kind),
            presentationMode: selectNodeForegroundPresentation({
              platform: nodePlatform(platform.kind),
              environment: effectiveEnvironment,
              sessionCount: 1,
              ...(effectiveEnvironment.TERM === undefined ? {} : { terminalKind: effectiveEnvironment.TERM }),
            }),
            onProgress: (nextLabel) => inlineRootProgress?.update(nextLabel),
            onBeforeTerminalOwnership: () => {
              inlineRootProgress?.stop();
              inlineRootProgress = undefined;
            },
            ...(effectiveEnvironment.TERM === undefined ? {} : { terminalKind: effectiveEnvironment.TERM }),
            ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
          });
        } finally {
          inlineRootProgress?.stop();
          inlineRootProgress = undefined;
        }
        return EXIT_CODES.success;
      }
      if (selection.kind === "lifecycle") {
        const noColor = booleanOption(parsed, "no-color") || Object.hasOwn(effectiveEnvironment, "NO_COLOR");
        const progress = startInlineProgress(streams.stderr, !noColor, selection.action === "start" ? "Starting machine" : "Stopping machine");
        const exit = await runCli([
          "machines", selection.action, selection.machineId, "--yes",
          ...(noColor ? ["--no-color"] : []),
        ], dependencies);
        progress.stop();
        return exit === EXIT_CODES.success
          ? await runCli(noColor ? ["--no-color"] : [], dependencies)
          : exit;
      }
      if (selection.kind === "supervisor-update") {
        const noColor = booleanOption(parsed, "no-color") || Object.hasOwn(effectiveEnvironment, "NO_COLOR");
        const progress = startInlineProgress(streams.stderr, !noColor, "Updating terminal supervisor");
        const exit = await runCli([
          "machines", "update-supervisor", selection.machineId, "--yes",
          ...(noColor ? ["--no-color"] : []),
        ], dependencies);
        progress.stop();
        return exit === EXIT_CODES.success
          ? await runCli(noColor ? ["--no-color"] : [], dependencies)
          : exit;
      }
      if (selection.kind === "create") {
        // E13-R1/R6: the screen chose provider and name; the batch command
        // owns the `machines.create` gate, the idempotency key and the read.
        const noColor = booleanOption(parsed, "no-color") || Object.hasOwn(effectiveEnvironment, "NO_COLOR");
        const progress = startInlineProgress(streams.stderr, !noColor, "Creating machine");
        const exit = await runCli([
          "machines", "create", "--name", selection.name, "--agent", selection.agent, "--yes",
          ...(noColor ? ["--no-color"] : []),
        ], dependencies);
        progress.stop();
        return exit === EXIT_CODES.success
          ? await runCli(noColor ? ["--no-color"] : [], dependencies)
          : exit;
      }
      return await runCli(rootJourneyArgv(selection, { noColor: booleanOption(parsed, "no-color") }), {
        ...dependencies,
        ...(selection.machineId === undefined ? {} : { managedWorkspaceMachineId: selection.machineId }),
        ...(humanAuth === undefined ? {} : { humanAuth }),
      });
    }
    if (journeyIntent?.target === "reconcile") {
      if (journeyIntent.agent === "openclaw") {
        throw unsupportedError("openclaw", "provider_route_unavailable");
      }
      const journeyAgent = journeyIntent.agent;
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
          // The journey never runs under structured output (fenced above), so
          // this line is always a human-facing note on stderr: above the
          // spinner while it runs, a plain line otherwise.
          onNotice: (line) => {
            if (inlineJourneyProgress !== undefined) inlineJourneyProgress.note(line);
            else streams.stderr.write(`${line}\n`);
          },
        });
        stopJourneyWorkspace = () => workspace.stopContinuousSync();
        const runner = dependencies.foregroundTerminalRunner ?? runNodeForegroundSessions;
        effects = createApiAgentJourneyEffects({
          client,
          requestedAgent: journeyAgent,
          inspectWorkspace: workspace.inspectWorkspace,
          synchronizeWorkspace: workspace.synchronizeWorkspace,
          authorizeMachineCreate: async ({ requestedAgent, signal }) =>
            (dependencies.authorizeMachineCreate ?? confirmMachineCreate)(requestedAgent, signal),
          attach: async ({ agentSessionId, expectedAgent, signal }) => {
            const presentationMode = selectNodeForegroundPresentation({
              platform: nodePlatform(platform.kind),
              environment: effectiveEnvironment,
              sessionCount: 1,
              ...(effectiveEnvironment.TERM === undefined ? {} : { terminalKind: effectiveEnvironment.TERM }),
            });
            await runner({
              client,
              baseUrl: config.baseUrl,
              browser: dependencies.browser ?? createBrowserOpener(nodePlatform(platform.kind), effectiveEnvironment),
              agentSessionIds: [agentSessionId],
              expectedAgentKinds: [expectedAgent],
              color: !booleanOption(parsed, "no-color") && !Object.hasOwn(effectiveEnvironment, "NO_COLOR"),
              hostPlatform: nodePlatform(platform.kind),
              presentationMode,
              onProgress: (nextLabel) => inlineJourneyProgress?.update(nextLabel),
              onBeforeTerminalOwnership: () => {
                inlineJourneyProgress?.stop();
                inlineJourneyProgress = undefined;
              },
              ...(effectiveEnvironment.TERM === undefined ? {} : { terminalKind: effectiveEnvironment.TERM }),
              signal,
            });
          },
          ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        });
      }
      const baseEffects = effects;
      effects = Object.freeze({
        ...baseEffects,
        onPhase(phase: AgentJourneyPhase) {
          baseEffects.onPhase?.(phase);
          inlineJourneyProgress?.update(journeyPhaseLabel(phase, journeyAgent));
        },
        async attach(input: Parameters<AgentJourneyEffects["attach"]>[0]) {
          inlineJourneyProgress?.update(`Attaching to ${agentDisplayName(journeyAgent)}`);
          try {
            await baseEffects.attach(input);
          } finally {
            inlineJourneyProgress?.stop();
            inlineJourneyProgress = undefined;
          }
        },
      });
      try {
        await orchestrateAgentJourney({
          intent: journeyIntent,
          effects,
          scope: journeyScope,
          ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
        });
      } finally {
        inlineJourneyProgress?.stop();
        inlineJourneyProgress = undefined;
        await stopJourneyWorkspace?.();
      }
      return EXIT_CODES.success;
    }
    if (foreground !== undefined) {
      const expectedAgent = foreground.expectedAgentKinds?.length === 1
        ? foreground.expectedAgentKinds[0]
        : undefined;
      const attachLabel = expectedAgent === undefined
        ? foreground.agentSessionIds.length === 1
          ? "Attaching to AgentSession"
          : `Attaching to ${foreground.agentSessionIds.length} AgentSessions`
        : foregroundAttachLabel(expectedAgent);
      const color = !booleanOption(parsed, "no-color") && !Object.hasOwn(effectiveEnvironment, "NO_COLOR");
      if (inlineJourneyProgress !== undefined) inlineJourneyProgress.update(attachLabel);
      else if (streams.stderrIsTTY === true) inlineJourneyProgress = startInlineProgress(streams.stderr, color, attachLabel);
      else streams.stderr.write(`Cuna: ${attachLabel.toLowerCase()}...\n`);
      const runner = dependencies.foregroundTerminalRunner ?? runNodeForegroundSessions;
      try {
        await runner({
          client,
          baseUrl: config.baseUrl,
          browser: dependencies.browser ?? createBrowserOpener(nodePlatform(platform.kind), effectiveEnvironment),
          agentSessionIds: foreground.agentSessionIds,
          ...(foreground.expectedAgentKinds === undefined
            ? {}
            : { expectedAgentKinds: foreground.expectedAgentKinds }),
          color,
          hostPlatform: nodePlatform(platform.kind),
          ...(foregroundPresentation === undefined ? {} : { presentationMode: foregroundPresentation }),
          onProgress: (nextLabel) => inlineJourneyProgress?.update(nextLabel),
          onBeforeTerminalOwnership: () => {
            inlineJourneyProgress?.stop();
            inlineJourneyProgress = undefined;
          },
          ...(effectiveEnvironment.TERM === undefined ? {} : { terminalKind: effectiveEnvironment.TERM }),
          ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
        });
      } finally {
        inlineJourneyProgress?.stop();
        inlineJourneyProgress = undefined;
      }
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
          timeoutMs: effectiveTimeoutMs,
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
    if (
      parsed.command === "machines" && parsed.operands.length === 0 &&
      !writer.structured && streams.stdinIsTTY && streams.stdoutIsTTY
    ) {
      inlineMachinesProgress?.stop();
      inlineMachinesProgress = undefined;
      const runner = dependencies.machinesExplorerRunner ?? runNodeMachinesExplorer;
      const selection = await runner({
        client,
        color: !booleanOption(parsed, "no-color") && !Object.hasOwn(effectiveEnvironment, "NO_COLOR"),
        ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
      }, dependencies.now === undefined ? {} : { now: dependencies.now });
      if (selection !== undefined) {
        if (selection.kind === "attach") {
          const attachLabel = foregroundAttachLabel(selection.agent);
          const color = !booleanOption(parsed, "no-color") && !Object.hasOwn(effectiveEnvironment, "NO_COLOR");
          if (streams.stderrIsTTY === true) inlineRootProgress = startInlineProgress(streams.stderr, color, attachLabel);
          else streams.stderr.write(`Cuna: ${attachLabel.charAt(0).toLowerCase()}${attachLabel.slice(1)}...\n`);
          const foregroundRunner = dependencies.foregroundTerminalRunner ?? runNodeForegroundSessions;
          try {
            await foregroundRunner({
              client,
              baseUrl: config.baseUrl,
              browser: dependencies.browser ?? createBrowserOpener(nodePlatform(platform.kind), effectiveEnvironment),
              agentSessionIds: [selection.agentSessionId],
              expectedAgentKinds: [selection.agent],
              color,
              hostPlatform: nodePlatform(platform.kind),
              presentationMode: selectNodeForegroundPresentation({
                platform: nodePlatform(platform.kind),
                environment: effectiveEnvironment,
                sessionCount: 1,
                ...(effectiveEnvironment.TERM === undefined ? {} : { terminalKind: effectiveEnvironment.TERM }),
              }),
              onProgress: (nextLabel) => inlineRootProgress?.update(nextLabel),
              onBeforeTerminalOwnership: () => {
                inlineRootProgress?.stop();
                inlineRootProgress = undefined;
              },
              ...(effectiveEnvironment.TERM === undefined ? {} : { terminalKind: effectiveEnvironment.TERM }),
              ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
            });
          } finally {
            inlineRootProgress?.stop();
            inlineRootProgress = undefined;
          }
        } else if (selection.kind === "launch") {
          return await runCli(rootJourneyArgv(selection, { noColor: booleanOption(parsed, "no-color") }), {
            ...dependencies,
            ...(selection.machineId === undefined ? {} : { managedWorkspaceMachineId: selection.machineId }),
          });
        } else if (selection.kind === "supervisor-update") {
          const noColor = booleanOption(parsed, "no-color") || Object.hasOwn(effectiveEnvironment, "NO_COLOR");
          const progress = startInlineProgress(streams.stderr, !noColor, "Updating terminal supervisor");
          const exit = await runCli([
            "machines", "update-supervisor", selection.machineId, "--yes",
            ...(noColor ? ["--no-color"] : []),
          ], dependencies);
          progress.stop();
          return exit === EXIT_CODES.success
            ? await runCli(["machines", ...(noColor ? ["--no-color"] : [])], dependencies)
            : exit;
        } else if (selection.kind === "create") {
          const noColor = booleanOption(parsed, "no-color") || Object.hasOwn(effectiveEnvironment, "NO_COLOR");
          const progress = startInlineProgress(streams.stderr, !noColor, "Creating machine");
          const exit = await runCli([
            "machines", "create", "--name", selection.name, "--agent", selection.agent, "--yes",
            ...(noColor ? ["--no-color"] : []),
          ], dependencies);
          progress.stop();
          return exit === EXIT_CODES.success
            ? await runCli(["machines", ...(noColor ? ["--no-color"] : [])], dependencies)
            : exit;
        } else {
          const noColor = booleanOption(parsed, "no-color") || Object.hasOwn(effectiveEnvironment, "NO_COLOR");
          const progress = startInlineProgress(streams.stderr, !noColor, selection.action === "start" ? "Starting machine" : "Stopping machine");
          const exit = await runCli([
            "machines", selection.action, selection.machineId, "--yes",
            ...(noColor ? ["--no-color"] : []),
          ], dependencies);
          progress.stop();
          return exit === EXIT_CODES.success
            ? await runCli(["machines", ...(noColor ? ["--no-color"] : [])], dependencies)
            : exit;
        }
      }
      return EXIT_CODES.success;
    }
    const commandClock = dependencies.now ?? Date.now;
    const result = await executeCommand({
      parsed,
      config,
      client,
      now: commandClock(),
      capabilityClock: commandClock,
      ...(dependencies.convergencePoller === undefined
        ? {}
        : { convergencePoller: dependencies.convergencePoller }),
      ...(credentialMode === undefined ? {} : { credentialMode }),
      ...(runtimeFeatures === undefined ? {} : { runtimeFeatures }),
    });
    writer.success(result.command, result.data, result.human);
    return EXIT_CODES.success;
  } catch (unknownError) {
    inlineMachinesProgress?.stop();
    inlineJourneyProgress?.stop();
    inlineRootProgress?.stop();
    const error = unknownError instanceof CredentialBoundaryError
      ? credentialError(unknownError)
      : unknownError instanceof RuntimeBoundaryError
        ? runtimeError(unknownError)
      : normalizeError(unknownError);
    if (interactiveCloseUi && streams.stderrIsTTY === true &&
      (dependencies.signal?.aborted === true || error.code === "cuna.journey.cancelled")) {
      await animateInlineClose(streams.stderr, interactiveCloseColor);
      return EXIT_CODES.success;
    }
    if (interactiveRootUi && streams.stderrIsTTY === true && isTerminalResumeHandleConflict(error)) {
      writeTerminalReconnectConflict(streams.stderr, interactiveRootColor);
      return error.exitCode;
    }
    const supervisorReadiness = terminalSupervisorReadiness(error);
    // The initial Cuna journey is interactive whenever stdin/stdout are TTYs.
    // Some Windows hosts expose stderr as a non-TTY even though it is visible
    // to the person.  Never leak an internal capability name merely because
    // that host classification is conservative; render the same plain-language
    // recovery instead.
    if (interactiveCloseUi && supervisorReadiness !== undefined) {
      writeTerminalSupervisorReadiness(
        streams.stderr,
        interactiveCloseColor && streams.stderrIsTTY === true,
        supervisorReadiness,
      );
      return error.exitCode;
    }
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
