export const ROOT_HELP = `Runa CLI

Run cloud development agents from your local command line through public Runa contracts.

Usage:
  runa <command> [options]

Available now:
  capabilities                         Inspect current server capability truth
  machines list                        List owned Runa machines
  machines create [options]            Create a machine when server-advertised
  machines start|pause|resume|stop ID  Change lifecycle when server-advertised
  machines delete ID                   Delete when server-advertised
  agent-sessions list --machine ID     List child agent processes
  agent-sessions create --machine ID   Create a child when server-advertised
  agent-sessions get ID                Read one child process
  agent-sessions rename ID --name NAME Rename one child process
  agent-sessions terminate ID          Terminate when server-advertised
  config get                           Show effective, redacted configuration
  self-test --offline                  Verify the installed CLI without network access

Reserved and fail-closed in this build:
  signup, login, claude, codex, openclaw, shell, connect, sync, companion

Global options:
  --json              Emit versioned JSON records
  --profile NAME      Select one user profile
  --base-url URL      Override the API origin (custom origins require a development profile)
  --config-file PATH  Select the user configuration file
  --timeout-ms N      Bound each API request (100..120000)
  --no-color          Disable color (output is color-independent by default)
  --help              Show help
  --version           Show the CLI version

Authentication:
  This initial build accepts RUNA_API_KEY for explicit automation only.
  Browser login remains unavailable until the PRD-005/036 server contract exists.

Canonical install:
  npm install -g @runa_laboratories/cli
`;
