# Runa CLI

[![CI](https://github.com/Runa-Laboratories/runa-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Runa-Laboratories/runa-cli/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Runa-Laboratories/runa-cli/actions/workflows/codeql.yml/badge.svg)](https://github.com/Runa-Laboratories/runa-cli/actions/workflows/codeql.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](package.json)

Run cloud development agents from a local terminal through Runa's public,
policy-enforced control plane.

Runa CLI is designed to make Claude Code, Codex, OpenClaw, and future agents
feel local while their processes, durable sessions, and isolated workspaces run
on Runa cloud machines. The CLI keeps machine lifecycle, synchronization,
authorizations, and runtime evidence explicit instead of hiding them behind an
opaque remote shell.

> [!WARNING]
> Runa CLI is under active implementation and is not GA. The npm, Bun, curl,
> Homebrew, and AUR commands below are the approved distribution interfaces;
> this repository does not claim that every channel is live yet.

## Current capabilities

- Versioned human and JSON output with stable error and exit-code categories.
- Exact public Runa API-origin validation and bounded authenticated transport.
- Capability discovery that treats absent, stale, contradictory, or unknown
  evidence as unauthorized for mutation.
- Machine and AgentSession command foundations over public Runa contracts.
- Explicit Windows, macOS, and Linux path/configuration adapters.
- Network-free installed-artifact identity and self-test.
- Fail-closed gates for features whose producer contract or runtime is not yet
  available.

Browser authentication, cloud terminal attachment, daemon integration,
workspace synchronization, and the local companion remain pre-release work.
Their presence in the accepted PRDs is not evidence that they are deployed.

## Quick start for contributors

Node.js 22 or newer is required.

```sh
git clone https://github.com/Runa-Laboratories/runa-cli.git
cd runa-cli
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm test
node governance/validate-prd-dag.mjs
```

Inspect the local build without making a network request:

```sh
node dist/bin/runa.js self-test --offline --json
node dist/bin/runa.js version --json
```

## Installation interfaces

| Surface | Command | Platform | Current status |
| --- | --- | --- | --- |
| npm | `npm install -g @runa_laboratories/cli` | Windows, macOS, Linux | Canonical package; publication remains gated |
| Bun | `bun add --global @runa_laboratories/cli` | Windows, macOS, Linux | Same npm artifact; compatibility evidence pending |
| curl | `curl -fsSL https://runacode.io/install \| sh` | macOS, Linux | Digest-bound installer projection; endpoint pending |
| Homebrew | `brew install Runa-Laboratories/tap/runa` | macOS, Linux | Formula projection; tap pending |
| paru/AUR | `paru -S runa-cli-bin` | Arch Linux | PKGBUILD projection; AUR ownership pending |

Every projection must install the exact admitted npm tarball. No channel may
rebuild, patch, or independently version the CLI.

## Command surface

The current foundation exposes:

```text
runa capabilities
runa machines list
runa machines create --name NAME --idempotency-key KEY --yes
runa machines start|pause|resume|stop ID --yes
runa machines delete ID --yes
runa agent-sessions list --machine ID
runa agent-sessions create --machine ID --agent claude-code --idempotency-key KEY --yes
runa config get
runa self-test --offline --json
runa version --json
```

Commands that depend on an unavailable producer or runtime return a stable
unsupported/capability error and do not simulate a machine, session, login, or
successful mutation.

## Configuration and authentication

Configuration precedence is flag, environment, selected user profile, then the
canonical default. Production requests use exactly `https://api.runacode.io`.
Custom origins require an explicit development profile; repository content is
never a configuration authority.

`RUNA_API_KEY` is supported only as an explicit automation credential in the
current build. It is never persisted automatically. Browser login and secure
OS-vault refresh credentials will become available only with their accepted
identity/continuation contracts and runtime evidence.

Never place API keys in command-line arguments, repository files, issue reports,
terminal captures, or diagnostics.

## Architecture

```mermaid
flowchart LR
  User["Local developer terminal"] --> CLI["Runa CLI"]
  CLI --> Daemon["Per-user local daemon"]
  CLI --> API["Public Runa API"]
  Daemon --> Sync["Workspace sync supervisor"]
  API --> Machine["Runa cloud machine"]
  Machine --> Sessions["Independent AgentSessions"]
  CLI --> Viewports["Isolated terminal viewports"]
  Viewports --> Sessions
  Sync --> Machine
```

The public OpenAPI contract is the wire authority. The CLI owns interactive
workflows, terminal behavior, local daemon coordination, and synchronization.
TypeScript and Python SDKs remain explicit programmatic REST clients and do not
absorb watchers, PTYs, browser control, or implicit login behavior.

Architecture decisions are recorded in [`architecture/`](architecture/README.md)
and accepted product requirements in [`prds/`](prds/README.md).

## Release and security

Release workflows construct one immutable npm candidate, generate an SBOM and
provenance, install that exact artifact on the declared platform matrix, and
publish only through npm Trusted Publishing with short-lived OIDC. The current
workflow permits the `preview` dist-tag only; it cannot promote `latest` or GA.

Report vulnerabilities privately according to [`SECURITY.md`](SECURITY.md).
Do not open a public issue containing an exploit, credential, private URL, or
customer data.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before proposing changes. Every
behavioral change needs a stable requirement/test identity, and every public
contract change must update producer and consumers in an expand-contract
campaign.

## License

Copyright 2026 Runa Laboratories. Licensed under the
[Apache License 2.0](LICENSE). See [`NOTICE`](NOTICE) for attribution.

## Project status

Active pre-release development. The authoritative completion rule is stricter
than compilation or green unit tests: release requires installed-artifact,
contract, security, recovery, runtime, support, and cross-platform evidence.
