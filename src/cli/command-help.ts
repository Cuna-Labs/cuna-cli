import { ROOT_HELP } from "./help.js";
import { CLI_ROUTE_REGISTRY } from "./parser.js";

/**
 * Help for one command, and for one action within a command.
 *
 * `cuna machines --help` and `cuna machines list --help` both printed the root
 * help and silently discarded the subcommand, so the flags a command requires
 * were discoverable only by running it and reading the usage error — which
 * names one missing option per attempt. `machines create` needs three, so a
 * user learned the command by failing it three times.
 *
 * Keys are "<command>" and "<command> <action>"; the most specific match wins.
 * Every entry is written against the option allowlist its command actually
 * enforces in `commands/commands.ts`, so `--help` and the usage error cannot
 * disagree about which flags exist. A test asserts that correspondence.
 */
const GLOBAL_OPTIONS = [
  "Global options (valid on every command):",
  "  --json              Emit versioned JSON records",
  "  --profile NAME      Select one user profile",
  "  --base-url URL      Override the API origin (custom origins need a development profile)",
  "  --config-file PATH  Select the user configuration file",
  "  --timeout-ms N      Bound each API request (base-10 integer, 100..120000)",
  "  --no-color          Disable color",
  "  --help              Show this help",
].join("\n");

function topic(usage: string, body: string): string {
  return `${usage}\n\n${body}\n\n${GLOBAL_OPTIONS}\n`;
}

const COMMAND_HELP: Readonly<Record<string, string>> = Object.freeze({
  signup: topic(
    "Usage:\n  cuna signup",
    "Create a waitlist-only Cuna account through the browser, paste the displayed\ncuna_login_ code, and store it in the encrypted profile session. Never assigns\ncompute and never starts billing. Accepts no operands and no command options.",
  ),
  login: topic(
    "Usage:\n  cuna login",
    "Open the approved Cuna browser continuation, then paste the high-entropy\ncuna_login_ code displayed once by the page. The code is encrypted at rest in\nthe selected profile and exchanged for short-lived access in each process.",
  ),
  logout: topic(
    "Usage:\n  cuna logout",
    "Revoke the durable login-code family server-first, then delete both encrypted\nlocal session files. Accepts no operands.",
  ),
  whoami: topic(
    "Usage:\n  cuna whoami",
    "Exchange the encrypted profile login code for short-lived access and show the\nauthoritative account context. The login code is never sent as a product API\nbearer. Accepts no operands.",
  ),
  access: topic(
    "Usage:\n  cuna access status",
    "Print the account context as one tab-separated line: identity, admission, then\nworkspace state. `cuna whoami` runs the same read and prints the same line; only\nthe --json record name differs (access.status against whoami). The status action\nis required. No command options.",
  ),
  capabilities: topic(
    "Usage:\n  cuna capabilities [--scope SCOPE] [--resource-id ID]",
    [
      "Inspect current server capability truth.",
      "",
      "Options:",
      "  --scope SCOPE       account (default), machine, or agent_session",
      "  --resource-id ID    Required when --scope is machine or agent_session,",
      "                      and rejected when --scope is account",
    ].join("\n"),
  ),
  machines: topic(
    "Usage:\n  cuna machines\n  cuna machines <list|create|start|pause|resume|stop|update-supervisor|delete> [options]",
    [
      "Manage owned Cuna machines. Add --help after an action for that action.",
      "",
      "Interactive view:",
      "  machines                    Browse machines and their AgentSessions",
      "                              (↑/↓ move, Enter open, r refresh, q quit)",
      "",
      "Actions:",
      "  list                        List owned machines",
      "  create                      Create a machine when server-advertised",
      "  start|pause|resume|stop ID  Change lifecycle when server-advertised",
      "  update-supervisor ID         Update a stopped machine's terminal supervisor",
      "  delete ID                   Delete when server-advertised",
    ].join("\n"),
  ),
  "machines list": topic(
    "Usage:\n  cuna machines list",
    "List owned Cuna machines. Accepts no operands and no command options.",
  ),
  "machines create": topic(
    "Usage:\n  cuna machines create --name NAME --yes [options]",
    [
      "Create a machine when the server advertises the capability.",
      "",
      "Required:",
      "  --name NAME         1 through 80 characters, no control characters",
      "  --yes               Confirm this mutating operation",
      "",
      "Options:",
      "  --agent KIND        claude-code, codex, or opencode",
      "  --vcpus N           Base-10 integer, 1 through 8",
      "  --memory-mib N      Base-10 integer, 512 through 16384",
      "  --background        Do not wait for the machine to become ready",
      "  --idempotency-key K 8 through 128 printable ASCII characters. Generated per",
      "                      invocation when omitted; supply it only to reconcile a",
      "                      create whose outcome you never observed.",
    ].join("\n"),
  ),
  "machines start": topic(
    "Usage:\n  cuna machines start MACHINE_ID --yes",
    "Start one machine when server-advertised.\n\nRequired:\n  --yes               Confirm this mutating operation",
  ),
  "machines pause": topic(
    "Usage:\n  cuna machines pause MACHINE_ID --yes",
    "Pause one machine when server-advertised.\n\nRequired:\n  --yes               Confirm this mutating operation",
  ),
  "machines resume": topic(
    "Usage:\n  cuna machines resume MACHINE_ID --yes",
    "Resume one machine when server-advertised.\n\nRequired:\n  --yes               Confirm this mutating operation",
  ),
  "machines stop": topic(
    "Usage:\n  cuna machines stop MACHINE_ID --yes",
    "Stop one machine when server-advertised.\n\nRequired:\n  --yes               Confirm this mutating operation",
  ),
  "machines update-supervisor": topic(
    "Usage:\n  cuna machines update-supervisor MACHINE_ID --yes",
    [
      "Update the terminal supervisor on one stopped OpenCode machine when Cuna",
      "reports that exact prerequisite.",
      "",
      "Cuna never stops the machine or terminates AgentSessions for this action.",
      "End only the sessions you intend to end, stop the Machine yourself, then run it.",
      "",
      "Required:",
      "  --yes               Confirm this mutating operation",
    ].join("\n"),
  ),
  "machines delete": topic(
    "Usage:\n  cuna machines delete MACHINE_ID --yes",
    "Delete one machine when server-advertised.\n\nRequired:\n  --yes               Confirm this destructive operation",
  ),
  records: topic(
    "Usage:\n  cuna records list",
    "List redacted account activity records. The list action is required. No command\noptions.",
  ),
  authorizations: topic(
    "Usage:\n  cuna authorizations list --machine MACHINE_ID",
    "List active credential injection rules for one machine.\n\nRequired:\n  --machine ID        Canonical lowercase Cuna UUID",
  ),
  account: topic(
    "Usage:\n  cuna account show",
    "Show the public account identity. The show action is required. No command options.",
  ),
  workspace: topic(
    "Usage:\n  cuna workspace show",
    "Show workspace assignment or waitlist state. The show action is required.\nNo command options.",
  ),
  usage: topic(
    "Usage:\n  cuna usage show",
    "Show authoritative workspace estimates. The show action is required. No command\noptions.",
  ),
  "api-keys": topic(
    "Usage:\n  cuna api-keys <create|list|revoke> [options]",
    [
      "Create, inspect and revoke API keys. Creation returns the secret exactly once; list and revoke never return it.",
      "",
      "Actions:",
      "  create --name NAME --yes  Create a key from an interactive session",
      "  list                 List API-key metadata",
      "  revoke KEY_ID --yes  Revoke one API key when server-advertised",
    ].join("\n"),
  ),
  "api-keys list": topic(
    "Usage:\n  cuna api-keys list",
    "List API-key metadata without secret values. No operands, no command options.",
  ),
  "api-keys create": topic(
    "Usage:\n  cuna api-keys create --name NAME [--expires-at RFC3339] --yes",
    "Create an automation credential from an interactive session. The secret is printed once and never stored by the CLI.",
  ),
  "api-keys revoke": topic(
    "Usage:\n  cuna api-keys revoke KEY_ID --yes",
    "Revoke one API key when server-advertised.\n\nRequired:\n  KEY_ID              Canonical lowercase Cuna UUID\n  --yes               Confirm this destructive operation",
  ),
  "agent-sessions": topic(
    "Usage:\n  cuna agent-sessions <list|get|create|rename|terminate|attach> [options]",
    [
      "Manage child agent processes. Add --help after an action for that action.",
      "",
      "Actions:",
      "  list --machine ID   List child processes on one machine",
      "  get ID              Read one child process",
      "  create              Create a workspace-bound child when server-advertised",
      "  rename ID --name N  Rename one child process",
      "  terminate ID        Terminate when server-advertised",
      "  attach ID           Attach one exact cloud session in this terminal, once",
      "                      the server grants terminal_connections.create for it",
    ].join("\n"),
  ),
  "agent-sessions list": topic(
    "Usage:\n  cuna agent-sessions list --machine MACHINE_ID [--limit N] [--cursor C]",
    [
      "List child agent processes on one machine.",
      "",
      "Required:",
      "  --machine ID        Opaque public Cuna machine identifier",
      "",
      "Options:",
      "  --limit N           Base-10 integer, 1 through 100",
      "  --cursor C          Opaque page cursor, at most 512 characters",
    ].join("\n"),
  ),
  "agent-sessions get": topic(
    "Usage:\n  cuna agent-sessions get SESSION_ID",
    "Read one child process. SESSION_ID is a canonical lowercase Cuna UUID.\nNo command options.",
  ),
  "agent-sessions create": topic(
    "Usage:\n  cuna agent-sessions create --machine ID --workspace-binding-id ID\n                            --workspace-generation N --agent KIND --yes [options]",
    [
      "Create a workspace-bound child process when server-advertised.",
      "",
      "Required:",
      "  --machine ID              Opaque public Cuna machine identifier",
      "  --workspace-binding-id ID Canonical lowercase Cuna UUID",
      "  --workspace-generation N  Base-10 integer, 1 or greater. This is a fencing",
      "                            token compared exactly, so an exponent or hex form",
      "                            is rejected rather than quietly coerced.",
      "  --agent KIND              claude-code, codex, or opencode",
      "  --yes                     Confirm this mutating operation",
      "",
      "Options:",
      "  --name NAME               1 through 80 characters",
      "  --cwd PATH                Absolute path inside /workspace (default /workspace)",
      "  --auth-mode MODE          interactive_login or credential_binding",
      "  --credential-binding ID   Required exactly when --auth-mode is",
      "                            credential_binding, and rejected otherwise",
      "  --idempotency-key K       Generated per invocation when omitted",
    ].join("\n"),
  ),
  "agent-sessions rename": topic(
    "Usage:\n  cuna agent-sessions rename SESSION_ID --name NAME --yes",
    "Rename one child process.\n\nRequired:\n  --name NAME         1 through 80 characters\n  --yes               Confirm this mutating operation",
  ),
  "agent-sessions terminate": topic(
    "Usage:\n  cuna agent-sessions terminate SESSION_ID --yes",
    "Terminate one child process when server-advertised.\n\nRequired:\n  --yes               Confirm this destructive operation",
  ),
  "agent-sessions attach": topic(
    "Usage:\n  cuna agent-sessions attach SESSION_ID",
    "Attach one exact cloud session in this terminal.\n\nThis command is routed in this build, which is not a promise that it will run.\nIt re-reads an AgentSession-scoped capability snapshot first and refuses,\nchanging nothing, when the server does not grant terminal_connections.create\nfor that session. Check it first with\n`cuna capabilities --scope agent_session --resource-id SESSION_ID`.\n\nRequires an interactive terminal; JSON and redirected output fail closed.\nNo command options.",
  ),
  agent: topic(
    "Usage:\n  cuna agent logout --agent-session SESSION_ID --yes",
    "Sign Claude Code or Codex out of one exact AgentSession.\n\nRequired:\n  --agent-session ID  Canonical lowercase Cuna UUID\n  --yes               Confirm this mutating operation",
  ),
  connect: topic(
    "Usage:\n  cuna connect SESSION_ID [SESSION_ID...]",
    "Attach one through four exact cloud sessions in this terminal. Session IDs must\nbe distinct canonical lowercase Cuna UUIDs.\n\nRouted in this build, and still gated per session: each attach re-reads an\nAgentSession-scoped capability snapshot and refuses, changing nothing, when the\nserver does not grant terminal_connections.create for that session.\n\nRequires an interactive terminal; JSON and redirected output fail closed.\nNo command options.",
  ),
  config: topic(
    "Usage:\n  cuna config get",
    "Show effective, redacted configuration. Configuration writes are not implemented\nin this build. No command options.",
  ),
  "config set": topic(
    "Usage:\n  cuna config set",
    "Compatibility-reserved command. Configuration mutation is not implemented in this build.",
  ),
  doctor: topic(
    "Usage:\n  cuna doctor [--check-browser-login] [--json]",
    "Report platform, Node version, runtime features, and encrypted local\nsession-store state without network access by default.\n\nOptional:\n  --check-browser-login  Probe the anonymous remote browser-login bootstrap\n\nThe local AES store and remote browser-login bootstrap are reported separately.\nRun this first when a command fails with an authentication or capability error.\nAccepts no operands.",
  ),
  "self-test": topic(
    "Usage:\n  cuna self-test --offline",
    "Verify the installed CLI without network access.\n\nRequired:\n  --offline           The only mode this build implements",
  ),
  version: topic(
    "Usage:\n  cuna version",
    "Show the CLI version, build digest, platform, and protocol range. No operands\nand no command options.",
  ),
  shell: topic(
    "Usage:\n  cuna shell",
    "Compatibility-reserved command. This build has no standalone shell runtime; use a provider terminal through `cuna`, `cuna claude`, `cuna codex`, or `cuna opencode`.",
  ),
  sync: topic(
    "Usage:\n  cuna sync",
    "Compatibility-reserved command. Workspace synchronization is composed into the provider journeys and is not exposed as a standalone command.",
  ),
  companion: topic(
    "Usage:\n  cuna companion",
    "Compatibility-reserved command. This build has no local companion process.",
  ),
});

function agentHelp(command: "claude" | "codex" | "opencode"): string {
  const sync = "\n  --no-sync                 Bind without synchronizing workspace contents";
  const authOptions = command === "opencode"
    ? [
        "  --auth-mode MODE          interactive_login only (the default)",
        "  Provider sign-in          In the remote OpenCode terminal, use /connect",
        "                            to choose and sign in to a provider, then use",
        "                            /models to select a model. Cuna does not broker",
        "                            an OpenCode device-sign-in page. Credentials stay",
        "                            in that remote AgentSession.",
        "  Credential bindings       Not accepted for OpenCode.",
      ]
    : [
        "  --auth-mode MODE          interactive_login or credential_binding",
        "  --credential-binding ID   Required exactly when --auth-mode is",
        "                            credential_binding",
      ];
  return topic(
    `Usage:\n  cuna ${command} [PATH] [--machine NAME | --new] [--new-session] [options]\n  cuna ${command} --agent-session SESSION_ID`,
    [
      "Run one cloud agent from this directory, or attach one exact existing child.",
      "",
      "The first form validates the whole command before any effect, selects only from",
      "fresh machine capability evidence, reconciles creation by a caller-known request",
      "ID, binds and synchronizes the exact workspace generation, selects or creates one",
      "AgentSession, waits for child readiness, then attaches this terminal. Ambiguous,",
      "stale, cancelled or unknown outcomes fail closed rather than choosing a target.",
      "",
      "Options:",
      "  PATH                      Local directory to bind (default: current directory)",
      "  --machine NAME            Use one named machine",
      "  --new                     Create a machine instead of selecting one",
      `  --new-session             Create a child process instead of reusing one${sync}`,
      ...authOptions,
      "  --agent-session ID        Attach one exact child and skip reconciliation.",
      "                            Cannot be combined with PATH, --machine, --new,",
      "                            --new-session, --no-sync, --auth-mode or --credential-binding.",
      "",
      "Requires an interactive terminal; JSON and redirected output fail closed.",
      "Ctrl+C detaches locally in one press. Use Ctrl+] c to send Ctrl+C to the agent.",
    ].join("\n"),
  );
}

/** Every topic key this module can resolve, for tests and completion. */
export const HELP_TOPICS: readonly string[] = Object.freeze([
  ...Object.keys(COMMAND_HELP),
  "claude",
  "codex",
  "opencode",
]);

/** Semantic leaves represented by complete help, derived from parser discovery. */
export const HELP_ROUTE_KEYS: readonly string[] = Object.freeze(
  CLI_ROUTE_REGISTRY.map((route) => route.key),
);

/** Help for `command` plus its action operands, falling back to the root help. */
export function commandHelp(command: string | undefined, operands: readonly string[]): string {
  if (command === undefined) return ROOT_HELP;
  if (command === "claude" || command === "codex" || command === "opencode") return agentHelp(command);
  const action = operands[0];
  if (action !== undefined) {
    const specific = COMMAND_HELP[`${command} ${action}`];
    if (specific !== undefined) return specific;
  }
  return COMMAND_HELP[command] ?? ROOT_HELP;
}

/** The exact topic `commandHelp` resolved, for the `--json` record. */
export function helpTopicName(command: string, operands: readonly string[]): string {
  const action = operands[0];
  if (action !== undefined && COMMAND_HELP[`${command} ${action}`] !== undefined) return `${command} ${action}`;
  return command;
}
