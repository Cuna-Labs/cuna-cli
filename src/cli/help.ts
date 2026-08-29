import { exitCodeHelpSection } from "../core/exit-codes.js";
import { brandedEnvironmentNames } from "../core/namespace.js";
import { API_KEYS_URL } from "../core/product-web.js";
import { CLI_ROUTE_REGISTRY } from "./parser.js";

// Help is the only place most users learn a variable name, so it is derived
// from the same authority the resolver reads. A hand-written name here would go
// stale exactly when the accepted set changes, which is the one moment it must
// not.
const API_KEY_NAMES = brandedEnvironmentNames("API_KEY").join(" or ");

// Same reason, one layer up: the exit code is the entire contract for a caller
// that is not a human, so the list below is projected from `EXIT_CODES` rather
// than typed out beside it. A hand-written copy here would have kept printing
// `7` for an unserved operation after that case moved to `8`.
const EXIT_CODES_SECTION = exitCodeHelpSection();

/**
 * What a newcomer sees from bare `cuna` and from `cuna --help`.
 *
 * WHY THIS EXISTS. The full surface below is 105 lines, 23 of them an exit-code
 * table, and the first usable command appears on line 9. Measured on the same
 * build: the whole of `cuna --help` contained ZERO `http(s)://` matches, so a
 * user who needs browser sign-in still needs a safe browser-link next
 * step rather than a platform-specific promise.
 *
 * NOTHING WAS DELETED. Every line that used to be here is still in `FULL_HELP`,
 * reachable as `cuna help --all`, and `cuna <command> --help` is untouched.
 *
 * THE UNAVAILABILITY CLAIMS BELOW ARE MEASURED FROM THIS TREE, not guessed, and
 * they are deliberately stated as properties of the BUILD rather than of a
 * platform:
 *
 *   - interactive commands use the pure-JavaScript encrypted browser-link
 *     session store. Alternative credential backends are deliberately absent
 *     from the distributable package, rather than present as an inactive fallback.
 *   - the automatic journey and exact foreground attach are composed by
 *     `runCli` before the generic command dispatcher. Their local
 *     implementation is present, while each invocation still fails closed
 *     unless the live producer proves the required capabilities and state.
 *
 * What is NOT claimed here: that browser sign-in is currently enabled by every
 * configured deployment. `cuna doctor` measures local encrypted storage, and
 * its opt-in remote probe measures the browser-login bootstrap separately.
 */
const PROVIDER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  claude: "Open Claude Code in a machine",
  codex: "Open Codex in a machine",
  opencode: "Open OpenCode in a machine",
});

const CURRENT_PROVIDER_COMMANDS = Object.freeze(
  CLI_ROUTE_REGISTRY
    .map((route) => route.key)
    .filter((key) => Object.hasOwn(PROVIDER_LABELS, key)),
);

/** Commands printed by first-run help, ending in the guided root journey. */
export const FIRST_RUN_TRANSCRIPT: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(["login"]),
  Object.freeze([]),
]);

/**
 * Render primary discovery as the intersection of this build's provider routes
 * and the caller's set.
 *
 * WHAT THE DEFAULT MEANS. Help is rendered offline, before any credential or
 * capability request, so the only authority available to it is this build's
 * route registry. The default therefore lists every ROUTED provider and makes
 * no claim at all about what the server currently serves. It is not a
 * capability filter, and the earlier comment here claimed it was one: it said
 * this call "keeps OpenCode hidden until both halves actually exist" while
 * production's only call site is `renderShortHelp()` with no argument, whose
 * default is derived from the same registry it filters — a tautology that
 * could never hide anything.
 *
 * The parameter is still real, and narrower than the default: a caller holding
 * a live capability snapshot may pass the subset it proves. Nothing in this
 * package does that today.
 */
export function renderShortHelp(
  routedProviderCommands: readonly string[] = CURRENT_PROVIDER_COMMANDS,
): string {
  const routed = new Set(routedProviderCommands);
  const providerLines = CURRENT_PROVIDER_COMMANDS
    .filter((command) => routed.has(command))
    .map((command) => `  cuna ${command} [PATH]${" ".repeat(Math.max(1, 18 - command.length))}${PROVIDER_LABELS[command]}`)
    .join("\n");
  return `Cuna CLI

Open a machine, pick an agent, keep working.

Start here:
  cuna                    Choose a machine, agent, and session
  cuna machines           Browse machines and the sessions inside them
${providerLines}

First run:
  1. Run \`cuna login\`, approve in the browser, and paste the displayed login code
  2. Run \`cuna\` to enter an attached provider terminal

Diagnose this installation:
  cuna doctor                Report platform, runtime, and encrypted local session-store state
  cuna version               Show the CLI version, build digest, and protocol range
  cuna config get            Show effective, redacted configuration
  cuna self-test --offline   Verify the installed CLI without network access

Advanced and automation:
  cuna help --all          Every command, option, and exit code
  cuna <command> --help    Help for one command
`;
}

export const SHORT_HELP = renderShortHelp();

/**
 * The marker legend, printed immediately above the reference.
 *
 * Without it the bracketed word reads as a status, and a status is exactly what
 * this CLI cannot know before it asks. Naming the authority in the same breath
 * is the whole repair.
 */
export const COMMAND_REFERENCE_LEGEND = `  [routed]   this build dispatches the command
  [reserved] this build accepts the name and refuses
  Neither marker is a server answer. Run \`cuna capabilities\` for what the
  server currently proves for your account, machine, or AgentSession.
`;

/** One generated line per semantic parser route; tests parse these markers. */
export const COMPLETE_COMMAND_REFERENCE = CLI_ROUTE_REGISTRY
  .map((route) => `  [${route.dispatch}] ${route.key} :: cuna ${route.syntax}\n      ${route.summary}`)
  .join("\n");

export const FULL_HELP = `Cuna CLI

Run cloud development agents from your local command line through public Cuna contracts.

Usage:
  cuna <command> [options]

Available now:
  signup                               Create a waitlist-only Cuna account in the browser
  login                                Sign in through the browser and paste the durable login code
  whoami                               Show account context; reuse the encrypted session
  access status                        Print the same line whoami prints, as record access.status
  logout                               Revoke the login-code family server-first;
                                       reuse the encrypted session automatically
  capabilities                         Inspect current server capability truth
  machines                             Browse machines and their AgentSessions
  machines list                        List owned Cuna machines
  machines create [options]            Create a machine when server-advertised
  machines start|pause|resume|stop ID  Change lifecycle when server-advertised
  machines update-supervisor ID        Update a stopped OpenCode terminal supervisor
  machines delete ID                   Delete when server-advertised
  records list                         List redacted account activity records
  account show                         Show the public account identity
  workspace show                       Show assignment or waitlist state
  usage show                           Show authoritative workspace estimates
  authorizations list --machine ID     List active credential injection rules
  api-keys create --name NAME --yes    Create an API key and print its secret once
  api-keys list                        List API-key metadata without secret values
  api-keys revoke ID --yes             Revoke one API key when server-advertised
  agent-sessions list --machine ID     List child agent processes
  agent-sessions create --machine ID --workspace-binding-id ID --workspace-generation N
                                       Create a workspace-bound child when server-advertised
  agent-sessions get ID                Read one child process
  agent-sessions rename ID --name NAME Rename one child process
  agent-sessions terminate ID          Terminate when server-advertised
  config get                           Show effective, redacted configuration
  self-test --offline                  Verify the installed CLI without network access
  doctor                               Report platform, runtime, and encrypted local session-store state

Foreground terminal attach (the server must grant terminal_connections.create):
  connect SESSION_ID [SESSION_ID...]   Attach 1-4 exact cloud sessions in this terminal
  agent-sessions attach SESSION_ID     Attach one exact cloud session in this terminal
  agent logout --agent-session ID      Sign Claude Code or Codex out of one exact AgentSession
  claude --agent-session SESSION_ID    Attach one exact Claude Code child
  codex --agent-session SESSION_ID     Attach one exact Codex child
  opencode --agent-session SESSION_ID  Attach one exact OpenCode child
  These routes exist in this build. That is the whole of what the [routed]
  marker in the complete reference below claims about them.
  Each invocation still re-reads an AgentSession-scoped capability snapshot and
  refuses, changing nothing, when the server does not grant
  terminal_connections.create for that exact session. \`cuna capabilities --scope
  agent_session --resource-id ID\` shows the same answer before you attach.
  JSON and redirected output fail closed. Nested SSH/tmux and TERM=dumb use a
  one-session byte-preserving plain fallback with no appbar; set
  CUNA_TERMINAL_MODE=plain for accessibility or diagnosis.
  Ctrl+C detaches locally in one press. Use Ctrl+] c to send Ctrl+C to the agent.
  Background daemon and local companion behavior are absent from this build.

Automatic local-to-cloud journey:
  claude [PATH] [--machine NAME | --new] [--no-sync] [--new-session]
         [--auth-mode interactive_login|credential_binding]
         [--credential-binding ID]
  codex [PATH] [--machine NAME | --new] [--no-sync] [--new-session]
        [--auth-mode interactive_login|credential_binding]
        [--credential-binding ID]
  opencode [PATH] [--machine NAME | --new] [--no-sync] [--new-session]
           [--auth-mode interactive_login]
  Cuna validates the complete command before effects, selects only from fresh
  machine capability evidence, reconciles creation by a caller-known request ID,
  binds and synchronizes the exact workspace generation, selects or creates one
  exact AgentSession, waits for child readiness, and then attaches this terminal.
  Ambiguous, stale, cancelled, or unknown outcomes fail closed without silently
  choosing a target or retrying with a second identity.
  --credential-binding ID is required exactly when --auth-mode is credential_binding.
  OpenCode is interactive-only: after Cuna attaches its remote terminal, use
  /connect to choose and sign in to a provider, then /models to choose a model.
  Cuna does not broker an OpenCode device-sign-in page. Provider credentials remain
  in that AgentSession and are never copied from Codex or another provider store.
  Use --agent-session SESSION_ID to bypass reconciliation and attach one exact child;
  it cannot be combined with PATH, --machine, --new, --new-session, --no-sync,
  --auth-mode, or --credential-binding.

Reserved and fail-closed in this build:
  shell, background daemon, local companion

Complete command reference:
${COMMAND_REFERENCE_LEGEND}
${COMPLETE_COMMAND_REFERENCE}

Compatibility aliases (advanced only):
  cuna --help             Alias for primary help
  cuna --help --all       Alias for complete help
  cuna --version          Alias for cuna version

Global options:
  --json              Emit versioned JSON records
  --profile NAME      Select one user profile
  --base-url URL      Override the API origin (custom origins require a development profile)
  --config-file PATH  Select the user configuration file
  --timeout-ms N      Bound each API request (100..120000)
  --no-color          Disable color (output is color-independent by default)
  --help              Show help (add it after any command for that command's help)
  --version           Show the CLI version

Exit codes:
${EXIT_CODES_SECTION}
  This is the complete set this build can return. One reachable path per code is
  documented under "Exit codes" in the README.

Authentication:
  Create an automation credential at ${API_KEYS_URL}.
  Use cuna signup for waitlist-only enrollment. It never assigns compute or starts billing.
  Use cuna login for a browser-assisted interactive session. The CLI opens the
  browser flow, then exchanges the pasted code immediately; it does not open a local callback listener. Paste the exact high-entropy
  cuna_login_ code shown once by the page. Cuna stores it using AES-256-GCM with
  a separate user-only key file and exchanges it for short-lived access in each
  process. Compromise of the same OS account can read both files and defeats this layer.
  ${API_KEY_NAMES} selects explicit automation mode and never falls
  back to browser login. Both spellings are accepted and both admit every key brand the
  service has issued; the first one that is SET wins, even when its value is unusable.

Canonical install:
  npm install --global ./cuna_labs-cli-0.1.0.tgz
`;

/**
 * The root topic. Bare \`cuna\` and \`cuna --help\` answer with the short
 * orientation; \`cuna help --all\` and \`cuna --help --all\` answer with the
 * complete surface. Per-command help is unaffected.
 */
export const ROOT_HELP = SHORT_HELP;
