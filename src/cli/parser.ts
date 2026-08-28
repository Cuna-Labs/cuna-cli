import { usageError } from "../core/errors.js";

export type OptionValue = string | boolean;
export interface ParsedInvocation {
  readonly command: string | undefined;
  readonly operands: readonly string[];
  readonly options: Readonly<Record<string, OptionValue>>;
}

export type CliRouteClassification = "supported" | "compatibility-reserved";

/**
 * One semantic leaf accepted by the CLI preflight/dispatch boundary.
 *
 * The tokenizer deliberately remains generic: it must parse an invocation
 * before the command layer can return a precise usage error. Discovery still
 * needs a closed world, however, so help and its tests consume this registry
 * rather than maintaining a second handwritten command census.
 */
export interface CliRouteDefinition {
  readonly key: string;
  readonly command: string;
  readonly action?: string;
  readonly operandMode: "exact" | "free";
  readonly syntax: string;
  readonly argv: readonly string[];
  readonly summary: string;
  readonly classification: CliRouteClassification;
}

const supported = (
  key: string,
  syntax: string,
  argv: readonly string[],
  summary: string,
  operandMode: "exact" | "free" = "exact",
): CliRouteDefinition => Object.freeze({
  key,
  command: key.split(" ")[0]!,
  ...(key.split(" ")[1] === undefined ? {} : { action: key.split(" ")[1] }),
  operandMode,
  syntax,
  argv: Object.freeze([...argv]),
  summary,
  classification: "supported",
});

const reserved = (key: string, summary: string): CliRouteDefinition => Object.freeze({
  key,
  command: key.split(" ")[0]!,
  ...(key.split(" ")[1] === undefined ? {} : { action: key.split(" ")[1] }),
  operandMode: "exact",
  syntax: key,
  argv: Object.freeze(key.split(" ")),
  summary,
  classification: "compatibility-reserved",
});

/** The closed discovery projection of the command preflight switch. */
export const CLI_ROUTE_REGISTRY: readonly CliRouteDefinition[] = Object.freeze([
  supported("signup", "signup", ["signup"], "Create an account through the browser"),
  supported("login", "login", ["login"], "Sign in through the browser"),
  supported("logout", "logout", ["logout"], "Revoke the current interactive login"),
  supported("whoami", "whoami", ["whoami"], "Show the current account context"),
  supported("access status", "access status", ["access", "status"], "Show identity, admission, and workspace state"),
  supported("capabilities", "capabilities", ["capabilities"], "Inspect live server capability truth"),
  supported("machines", "machines", ["machines"], "Browse machines and AgentSessions interactively"),
  supported("machines list", "machines list", ["machines", "list"], "List exact machine resources"),
  supported("machines create", "machines create --name NAME --yes", ["machines", "create", "--name", "fixture", "--yes"], "Create a machine"),
  supported("machines start", "machines start MACHINE_ID --yes", ["machines", "start", "00000000-0000-4000-8000-000000000001", "--yes"], "Start a machine"),
  supported("machines pause", "machines pause MACHINE_ID --yes", ["machines", "pause", "00000000-0000-4000-8000-000000000001", "--yes"], "Pause a machine"),
  supported("machines resume", "machines resume MACHINE_ID --yes", ["machines", "resume", "00000000-0000-4000-8000-000000000001", "--yes"], "Resume a machine"),
  supported("machines stop", "machines stop MACHINE_ID --yes", ["machines", "stop", "00000000-0000-4000-8000-000000000001", "--yes"], "Stop a machine"),
  supported("machines delete", "machines delete MACHINE_ID --yes", ["machines", "delete", "00000000-0000-4000-8000-000000000001", "--yes"], "Delete a machine"),
  supported("records list", "records list", ["records", "list"], "List redacted account activity"),
  supported("authorizations list", "authorizations list --machine MACHINE_ID", ["authorizations", "list", "--machine", "00000000-0000-4000-8000-000000000001"], "List machine credential rules"),
  supported("account show", "account show", ["account", "show"], "Show the account identity"),
  supported("workspace show", "workspace show", ["workspace", "show"], "Show workspace assignment"),
  supported("usage show", "usage show", ["usage", "show"], "Show workspace usage estimates"),
  supported("api-keys list", "api-keys list", ["api-keys", "list"], "List API-key metadata"),
  supported("api-keys create", "api-keys create --name NAME --yes", ["api-keys", "create", "--name", "fixture", "--yes"], "Create an API key"),
  supported("api-keys revoke", "api-keys revoke KEY_ID --yes", ["api-keys", "revoke", "00000000-0000-4000-8000-000000000001", "--yes"], "Revoke an API key"),
  supported("agent-sessions list", "agent-sessions list --machine MACHINE_ID", ["agent-sessions", "list", "--machine", "00000000-0000-4000-8000-000000000001"], "List a machine's AgentSessions"),
  supported("agent-sessions get", "agent-sessions get SESSION_ID", ["agent-sessions", "get", "00000000-0000-4000-8000-000000000001"], "Read one AgentSession"),
  supported("agent-sessions create", "agent-sessions create --machine ID --workspace-binding-id ID --workspace-generation N --agent KIND --yes", ["agent-sessions", "create", "--machine", "00000000-0000-4000-8000-000000000001", "--workspace-binding-id", "00000000-0000-4000-8000-000000000002", "--workspace-generation", "1", "--agent", "claude-code", "--yes"], "Create an exact AgentSession"),
  supported("agent-sessions rename", "agent-sessions rename SESSION_ID --name NAME --yes", ["agent-sessions", "rename", "00000000-0000-4000-8000-000000000001", "--name", "fixture", "--yes"], "Rename an AgentSession"),
  supported("agent-sessions terminate", "agent-sessions terminate SESSION_ID --yes", ["agent-sessions", "terminate", "00000000-0000-4000-8000-000000000001", "--yes"], "Terminate an AgentSession"),
  supported("agent-sessions attach", "agent-sessions attach SESSION_ID", ["agent-sessions", "attach", "00000000-0000-4000-8000-000000000001"], "Attach an exact AgentSession"),
  supported("agent logout", "agent logout --agent-session SESSION_ID --yes", ["agent", "logout", "--agent-session", "00000000-0000-4000-8000-000000000001", "--yes"], "Sign a provider out of one AgentSession"),
  supported("connect", "connect SESSION_ID [SESSION_ID...]", ["connect", "00000000-0000-4000-8000-000000000001"], "Attach one through four exact AgentSessions", "free"),
  supported("config get", "config get", ["config", "get"], "Show redacted configuration"),
  supported("doctor", "doctor", ["doctor"], "Inspect local runtime health"),
  supported("self-test", "self-test --offline", ["self-test", "--offline"], "Verify this installation offline"),
  supported("version", "version", ["version"], "Show build identity"),
  supported("help", "help [--all]", ["help"], "Show primary or complete help"),
  supported("claude", "claude [PATH]", ["claude"], "Open Claude Code", "free"),
  supported("codex", "codex [PATH]", ["codex"], "Open Codex", "free"),
  supported("opencode", "opencode [PATH]", ["opencode"], "Open OpenCode", "free"),
  reserved("config set", "Reserved; configuration mutation is not implemented"),
  reserved("shell", "Reserved; no shell runtime in this build"),
  reserved("sync", "Reserved; no standalone sync command in this build"),
  reserved("companion", "Reserved; no local companion in this build"),
]);

/**
 * Resolve an invocation to one admitted semantic leaf.
 *
 * Exact command leaves accept no positional operand. Action leaves consume
 * their registered first operand and leave IDs/names to the command-specific
 * validator. Only provider PATH journeys and `connect` intentionally admit
 * free positional operands. Consequently, adding a switch branch cannot make
 * a new command or subaction executable until it is registered here.
 */
export function resolveCliRoute(parsed: ParsedInvocation): CliRouteDefinition | undefined {
  if (parsed.command === undefined) return undefined;
  const candidates = CLI_ROUTE_REGISTRY.filter((route) => route.command === parsed.command);
  const action = parsed.operands[0];
  if (action !== undefined) {
    const actionRoute = candidates.find((route) => route.action === action);
    if (actionRoute !== undefined) return actionRoute;
  }
  const base = candidates.find((route) => route.action === undefined);
  if (base === undefined) return undefined;
  if (base.operandMode === "free" || parsed.operands.length === 0) return base;
  return undefined;
}

/** Fail closed before the command preflight switch can admit an unregistered leaf. */
export function assertRegisteredCliRoute(parsed: ParsedInvocation): CliRouteDefinition {
  const route = resolveCliRoute(parsed);
  if (route !== undefined) return route;
  const knownCommand = parsed.command !== undefined &&
    CLI_ROUTE_REGISTRY.some((candidate) => candidate.command === parsed.command);
  if (knownCommand) {
    throw usageError(`Unknown ${parsed.command} action ${parsed.operands[0] ?? "<none>"}.`);
  }
  throw usageError(`Unknown command ${parsed.command ?? "<none>"}.`, "Run `cuna --help`.");
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
  // `doctor` is offline by default. This opt-in is the only diagnostic that
  // makes the anonymous browser-login bootstrap request.
  "check-browser-login",
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
  const allow = new Set([...allowed, "json", "no-color", "profile", "base-url", "config-file", "timeout-ms"]);
  const unknown = Object.keys(parsed.options).filter((key) => !allow.has(key));
  if (unknown.length > 0) throw usageError(`Unknown option --${unknown[0]}.`);
}
