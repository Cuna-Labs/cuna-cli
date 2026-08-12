import { exitCodeHelpSection } from "../core/exit-codes.js";
import { brandedEnvironmentNames } from "../core/namespace.js";
import { API_KEYS_URL } from "../core/product-web.js";

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
 * user who cannot use the native vault still needs a safe browser-link next
 * step rather than a platform-specific promise.
 *
 * NOTHING WAS DELETED. Every line that used to be here is still in `FULL_HELP`,
 * reachable as `cuna help --all`, and `cuna <command> --help` is untouched.
 *
 * THE UNAVAILABILITY CLAIMS BELOW ARE MEASURED FROM THIS TREE, not guessed, and
 * they are deliberately stated as properties of the BUILD rather than of a
 * platform:
 *
 *   - `credentials/native-platform-release-index.ts` ships an EMPTY index, so
 *     `createProductionNativeAuthBridges` fails closed before any package
 *     resolution. Interactive commands therefore use the encrypted browser-link
 *     preview backend in this build; native storage remains unavailable, a
 *     property of the release rather than of an operating system.
 *   - the automatic journey and exact foreground attach are composed by
 *     `runCli` before the generic command dispatcher. Their local
 *     implementation is present, while each invocation still fails closed
 *     unless the live producer proves the required capabilities and state.
 *
 * What is NOT claimed here: that sign-in fails on every operating system.
 * `credentials/linux-secret-service.ts` exists and the vault verdict is a
 * runtime fact, so this text points at `cuna doctor`, which measures it, rather
 * than asserting a platform list a static string cannot know.
 */
export const SHORT_HELP = `Cuna CLI

Run cloud development agents from your local command line.

Usage:
  cuna <command> [options]

First run:
  1. Set CUNA_SESSION_PASSPHRASE to a passphrase (it is never stored)
  2. Run \`cuna login\` and complete the one-time browser link
  3. Continue with \`cuna whoami\` or \`cuna machines list\` without repeating a mode flag

Works with no network:
  doctor                Report platform, runtime, and credential-vault state
  version               Show the CLI version, build digest, and protocol range
  config get            Show effective, redacted configuration
  self-test --offline   Verify the installed CLI without network access

Works with an automation credential:
  account show          Show the public account identity
  workspace show        Show assignment or waitlist state
  usage show            Show authoritative workspace estimates
  machines list         List owned Cuna machines
  records list          List redacted account activity records
  capabilities          Inspect what this deployment actually serves
  api-keys list         List API-key metadata without secret values
  claude [PATH]         Synchronize, select or create, and attach Claude Code
  codex [PATH]          Synchronize, select or create, and attach Codex
  openclaw [PATH]       Synchronize, select or create, and attach OpenClaw
  connect SESSION_ID    Attach one exact AgentSession in this terminal

Not available in this build:
  native credential vault  Native OS credential storage is not admitted in this
                           build. \`cuna login\` uses the encrypted browser-link
                           preview session instead; it is profile-scoped and
                           remains available until expiry or \`cuna logout\`.
  background daemon, local companion
  Run \`cuna doctor\` to see what this platform and build actually provide.

More:
  cuna help --all          Every command, option, and exit code
  cuna <command> --help    Help for one command
`;

export const FULL_HELP = `Cuna CLI

Run cloud development agents from your local command line through public Cuna contracts.

Usage:
  cuna <command> [options]

Available now:
  signup                               Create a waitlist-only Cuna account in the browser
  login [--session-only]               Sign in through the Cuna browser continuation;
                                       encrypted local storage is the default
  whoami [--session-only]              Show account context; reuse the encrypted session
  access status                        Show identity, admission, and workspace separately
  logout [--session-only]              Revoke the interactive token family server-first;
                                       reuse the encrypted session automatically
  capabilities                         Inspect current server capability truth
  machines list                        List owned Cuna machines
  machines create [options]            Create a machine when server-advertised
  machines start|pause|resume|stop ID  Change lifecycle when server-advertised
  machines delete ID                   Delete when server-advertised
  records list                         List redacted account activity records
  account show                         Show the public account identity
  workspace show                       Show assignment or waitlist state
  usage show                           Show authoritative workspace estimates
  authorizations list --machine ID     List active credential injection rules
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
  doctor                               Report platform, runtime, and credential-vault state

Capability-gated foreground preview:
  connect SESSION_ID [SESSION_ID...]   Attach 1-4 exact cloud sessions in this terminal
  agent-sessions attach SESSION_ID     Attach one exact cloud session in this terminal
  agent logout --agent-session ID      Sign the provider out of one exact AgentSession
  claude --agent-session SESSION_ID    Attach one exact Claude Code child
  codex --agent-session SESSION_ID     Attach one exact Codex child
  openclaw --agent-session SESSION_ID  Attach one exact OpenClaw child
  The server must prove current native terminal support. JSON and redirected output
  fail closed. Nested SSH/tmux and TERM=dumb use a one-session byte-preserving plain
  fallback with no appbar; set CUNA_TERMINAL_MODE=plain for accessibility or diagnosis.
  Background daemon and local companion behavior remain unavailable.

Automatic local-to-cloud journey:
  claude [PATH] [--machine NAME | --new] [--no-sync] [--new-session]
         [--auth-mode interactive_login|credential_binding]
         [--credential-binding ID]
  codex [PATH] [--machine NAME | --new] [--no-sync] [--new-session]
        [--auth-mode interactive_login|credential_binding]
        [--credential-binding ID]
  openclaw [PATH] [--machine NAME | --new] [--new-session]
           [--auth-mode interactive_login|credential_binding]
           [--credential-binding ID]
  Cuna validates the complete command before effects, selects only from fresh
  machine capability evidence, reconciles creation by a caller-known request ID,
  binds and synchronizes the exact workspace generation, selects or creates one
  exact AgentSession, waits for child readiness, and then attaches this terminal.
  Ambiguous, stale, cancelled, or unknown outcomes fail closed without silently
  choosing a target or retrying with a second identity.
  --credential-binding ID is required exactly when --auth-mode is credential_binding.
  Use --agent-session SESSION_ID to bypass reconciliation and attach one exact child;
  it cannot be combined with PATH, --machine, --new, --new-session, --no-sync,
  --auth-mode, or --credential-binding.

Reserved and fail-closed in this build:
  shell, background daemon, local companion

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
  Use cuna login for a browser-assisted interactive session. The CLI uses polling;
  it does not open a local callback listener. In this build the one-time browser
  link is the default login flow and the resulting refresh session is stored only
  in an encrypted, profile-scoped preview file. Set CUNA_SESSION_PASSPHRASE before
  login; keep CUNA_SESSION_PASSPHRASE set and later authenticated commands
  automatically reuse that session until it expires or you run cuna logout.
  \`--session-only\` remains accepted for explicit
  compatibility but is not required. This is not a native vault or a GA readiness claim.
  ${API_KEY_NAMES} selects explicit automation mode and never falls
  back to browser login. Both spellings are accepted and both admit every key brand the
  service has issued; the first one that is SET wins, even when its value is unusable.

Canonical install:
  npm install -g @cuna_labs/cli
`;

/**
 * The root topic. Bare \`cuna\` and \`cuna --help\` answer with the short
 * orientation; \`cuna help --all\` and \`cuna --help --all\` answer with the
 * complete surface. Per-command help is unaffected.
 */
export const ROOT_HELP = SHORT_HELP;
