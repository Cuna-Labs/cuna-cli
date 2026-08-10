export const ROOT_HELP = `Cuna CLI

Run cloud development agents from your local command line through public Cuna contracts.

Usage:
  cuna <command> [options]

Available now:
  signup                               Create a waitlist-only Cuna account in the browser
  login                                Sign in through the Cuna browser continuation
  whoami                               Show authoritative interactive account context
  access status                        Show identity, admission, and workspace separately
  logout                               Revoke the interactive token family server-first
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

Authentication:
  Use cuna signup for waitlist-only enrollment. It never assigns compute or starts billing.
  Use cuna login for a browser-assisted interactive session. The CLI uses polling;
  it does not open a local callback listener. Refresh credentials remain in the OS vault.
  CUNA_API_KEY selects explicit automation mode and never falls back to browser login.

Canonical install:
  npm install -g @cuna_labs/cli
`;
