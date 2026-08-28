import type { AgentAuthMode, AgentKind } from "../api/contracts.js";
import { parseArgv, type OptionValue, type ParsedInvocation } from "../cli/parser.js";
import { usageError } from "../core/errors.js";
import { assertCanonicalUuid, assertSafeDisplayText } from "../core/validation.js";

export type AgentJourneyCommand = "claude" | "codex" | "opencode";
export type AgentJourneySyncMode = "enabled" | "disabled" | "not-applicable";

export type MachineJourneySelection =
  | Readonly<{ readonly kind: "automatic" }>
  | Readonly<{ readonly kind: "exact-name"; readonly name: string }>
  | Readonly<{ readonly kind: "new" }>;

interface AgentJourneyIntentBase {
  readonly schemaVersion: "1.0";
  readonly command: AgentJourneyCommand;
  readonly agent: AgentKind;
}

export interface ReconciledAgentJourneyIntent extends AgentJourneyIntentBase {
  readonly target: "reconcile";
  readonly machine: MachineJourneySelection;
  readonly localPath?: string;
  readonly syncMode: Exclude<AgentJourneySyncMode, "not-applicable">;
  readonly newSession: boolean;
  readonly authMode?: AgentAuthMode;
  readonly credentialBindingId?: string;
}

export interface ExplicitAgentSessionJourneyIntent extends AgentJourneyIntentBase {
  readonly target: "agent-session";
  readonly agentSessionId: string;
  readonly syncMode: "not-applicable";
}

export type AgentJourneyIntent =
  | ReconciledAgentJourneyIntent
  | ExplicitAgentSessionJourneyIntent;

const JOURNEY_OPTIONS = new Set([
  "agent-session",
  "auth-mode",
  "credential-binding",
  "machine",
  "new",
  "new-session",
  "no-sync",
]);
const GLOBAL_OPTIONS = new Set([
  "base-url",
  "config-file",
  "json",
  "no-color",
  "profile",
  "timeout-ms",
]);
const BOOLEAN_OPTIONS = new Set(["json", "new", "new-session", "no-color", "no-sync"]);
const STRING_OPTIONS = new Set([
  "agent-session",
  "auth-mode",
  "base-url",
  "config-file",
  "credential-binding",
  "machine",
  "profile",
  "timeout-ms",
]);
const FORMAT_CONTROL = /[\p{Cc}\p{Cf}]/u;

function assertRawArgv(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw usageError("Agent journey arguments must be strings.");
  }
}

function commandAgent(command: string | undefined): {
  readonly command: AgentJourneyCommand;
  readonly agent: AgentKind;
} {
  switch (command) {
    case "claude":
      return Object.freeze({ command, agent: "claude-code" });
    case "codex":
      return Object.freeze({ command, agent: "codex" });
    case "opencode":
      return Object.freeze({ command, agent: "opencode" });
    default:
      throw usageError(
        `Agent journey command must be claude, codex, or opencode; received ${command ?? "<none>"}.`,
      );
  }
}

function validateOptionShape(name: string, value: OptionValue): void {
  if (BOOLEAN_OPTIONS.has(name)) {
    if (value !== true) throw usageError(`Option --${name} does not accept a value.`);
    return;
  }
  if (STRING_OPTIONS.has(name)) {
    if (typeof value !== "string" || value.length === 0) {
      throw usageError(`Option --${name} requires a value.`);
    }
    return;
  }
  throw usageError(`Unknown option --${name}.`);
}

function validateOptions(options: Readonly<Record<string, OptionValue>>): void {
  for (const [name, value] of Object.entries(options)) {
    if (!JOURNEY_OPTIONS.has(name) && !GLOBAL_OPTIONS.has(name)) {
      throw usageError(`Unknown option --${name}.`);
    }
    validateOptionShape(name, value);
  }
}

function booleanOption(parsed: ParsedInvocation, name: string): boolean {
  const value = parsed.options[name];
  if (value === undefined) return false;
  if (value !== true) throw usageError(`Option --${name} does not accept a value.`);
  return true;
}

function stringOption(parsed: ParsedInvocation, name: string): string | undefined {
  const value = parsed.options[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw usageError(`Option --${name} requires a value.`);
  }
  return value;
}

function safeLocalPath(value: string): string {
  if (value.length === 0 || value.length > 4096 || FORMAT_CONTROL.test(value)) {
    throw usageError(
      "Invalid local path.",
      "The path must not contain control or formatting characters and must be at most 4096 characters.",
    );
  }
  return value;
}

function safeMachineName(value: string): string {
  const name = assertSafeDisplayText(value, "machine selector");
  if (name.length > 80) {
    throw usageError("Invalid machine selector.", "Machine names contain at most 80 characters.");
  }
  return name;
}

function normalizedAuthMode(parsed: ParsedInvocation): AgentAuthMode | undefined {
  const value = stringOption(parsed, "auth-mode");
  if (value === undefined) return undefined;
  if (value !== "interactive_login" && value !== "credential_binding") {
    throw usageError("Option --auth-mode must be interactive_login or credential_binding.");
  }
  return value;
}

function explicitAgentSessionIntent(
  parsed: ParsedInvocation,
  identity: ReturnType<typeof commandAgent>,
  agentSessionId: string,
): ExplicitAgentSessionJourneyIntent {
  const forbidden = ["auth-mode", "credential-binding", "machine", "new", "new-session", "no-sync"].filter(
    (name) => parsed.options[name] !== undefined,
  );
  if (parsed.operands.length > 0 || forbidden.length > 0) {
    const conflict = parsed.operands.length > 0 ? "a local path" : `--${forbidden[0]}`;
    throw usageError(
      `Option --agent-session cannot be combined with ${conflict}.`,
      "Attach the explicit AgentSession without machine reconciliation, synchronization, or creation options.",
    );
  }
  return Object.freeze({
    schemaVersion: "1.0",
    ...identity,
    target: "agent-session",
    agentSessionId: assertCanonicalUuid(agentSessionId, "AgentSession ID"),
    syncMode: "not-applicable",
  });
}

export function preflightAgentJourneyInvocation(parsed: ParsedInvocation): AgentJourneyIntent {
  const identity = commandAgent(parsed.command);
  if (!Array.isArray(parsed.operands) || parsed.operands.some((value) => typeof value !== "string")) {
    throw usageError("Agent journey operands must be strings.");
  }
  if (parsed.options === null || typeof parsed.options !== "object" || Array.isArray(parsed.options)) {
    throw usageError("Agent journey options are malformed.");
  }
  validateOptions(parsed.options);
  if (parsed.operands.length > 1) {
    throw usageError(`${identity.command} accepts at most one local path.`);
  }

  const agentSessionId = stringOption(parsed, "agent-session");
  if (agentSessionId !== undefined) {
    return explicitAgentSessionIntent(parsed, identity, agentSessionId);
  }

  const forceNew = booleanOption(parsed, "new");
  const newSession = booleanOption(parsed, "new-session");
  const noSync = booleanOption(parsed, "no-sync");
  const machineName = stringOption(parsed, "machine");
  const requestedAuthMode = normalizedAuthMode(parsed);
  const rawCredentialBindingId = stringOption(parsed, "credential-binding");
  if (
    identity.agent === "opencode" &&
    (requestedAuthMode === "credential_binding" || rawCredentialBindingId !== undefined)
  ) {
    throw usageError(
      "OpenCode supports interactive_login only; credential bindings are not accepted.",
      "Use OpenCode's interactive provider flow and omit --credential-binding.",
    );
  }
  const authMode = identity.agent === "opencode"
    ? "interactive_login"
    : requestedAuthMode;
  if (authMode === "credential_binding" && rawCredentialBindingId === undefined) {
    throw usageError(
      "Option --credential-binding is required for credential_binding auth mode.",
      "Pass the exact credential binding ID authorized for this AgentSession.",
    );
  }
  if (authMode !== "credential_binding" && rawCredentialBindingId !== undefined) {
    throw usageError(
      "Option --credential-binding requires --auth-mode credential_binding.",
    );
  }
  const credentialBindingId = rawCredentialBindingId === undefined
    ? undefined
    : assertCanonicalUuid(rawCredentialBindingId, "credential binding ID");

  if (forceNew && machineName !== undefined) {
    throw usageError(
      "Options --new and --machine are mutually exclusive.",
      "Choose an exact existing machine or request creation of a new machine.",
    );
  }
  if (forceNew && newSession) {
    throw usageError(
      "Options --new and --new-session are mutually exclusive.",
      "A new machine necessarily requires a new AgentSession.",
    );
  }
  const localPath = parsed.operands[0];
  const machine: MachineJourneySelection = forceNew
    ? Object.freeze({ kind: "new" })
    : machineName === undefined
      ? Object.freeze({ kind: "automatic" })
      : Object.freeze({ kind: "exact-name", name: safeMachineName(machineName) });

  return Object.freeze({
    schemaVersion: "1.0",
    ...identity,
    target: "reconcile",
    machine,
    ...(localPath === undefined ? {} : { localPath: safeLocalPath(localPath) }),
    syncMode: noSync ? "disabled" : "enabled",
    newSession,
    ...(authMode === undefined ? {} : { authMode }),
    ...(credentialBindingId === undefined ? {} : { credentialBindingId }),
  });
}

export function parseAgentJourneyIntent(argv: readonly string[]): AgentJourneyIntent {
  assertRawArgv(argv);
  return preflightAgentJourneyInvocation(parseArgv(argv));
}
