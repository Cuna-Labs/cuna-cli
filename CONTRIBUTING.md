# Contributing to Runa CLI

Runa CLI is a cross-platform security-sensitive client. Contributions must
preserve user files, credentials, cloud resource ownership, terminal state, and
public API compatibility across Windows, macOS, and Linux.

## Development requirements

1. Use a supported Node.js version declared in `packaging/support-policy.json`.
2. Install from the committed lockfile with `npm ci --ignore-scripts`.
3. Do not introduce install or lifecycle scripts, native modules, git/file
   dependencies, or a new registry without an explicit security decision.
4. Run the repository quality commands and distribution verification before
   opening a pull request.
5. Add a behavioral oracle and a negative control for every material new
   obligation. A test that has not been shown able to fail is not release
   evidence.

## Pull requests

Describe the user-visible obligation, affected trust boundaries, public
contract changes, durable-state changes, platform impact, recovery path, and
evidence invalidated by the change. Public API changes require an expand-first
compatibility plan covering infra, the app, the CLI, and appropriate TypeScript
and Python SDK consumers. CLI-only PTY, TUI, watcher, daemon, browser, and
automatic synchronization behavior must not be added to the SDKs.

Never commit credentials, terminal transcripts containing secrets, customer
source, real browser state, or release tokens. Generated content and tool output
cannot approve their own changes.

## Release boundary

Local workstations must never publish this package. `npm publish` is permitted
only in the protected repository release workflow after candidate admission and
with short-lived OIDC identity. Maintainers must not create or reuse a persistent
`NPM_TOKEN` or `NODE_AUTH_TOKEN` for publication.

The canonical installation command will be:

```sh
npm install -g @runa_laboratories/cli
```

Bun, curl, Homebrew, and paru/AUR are projections of the same immutable
candidate. Their templates in this repository are not claims that those
channels are live.
