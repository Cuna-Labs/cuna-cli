# Runa CLI

[![CI](https://github.com/Runa-Laboratories/runa-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Runa-Laboratories/runa-cli/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Runa-Laboratories/runa-cli/actions/workflows/codeql.yml/badge.svg)](https://github.com/Runa-Laboratories/runa-cli/actions/workflows/codeql.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-22.17.1%2B%20%7C%2024.4.1%2B-339933?logo=node.js&logoColor=white)](package.json)

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
- Polling-only browser sign-in contracts with PKCE, OS-vault refresh rotation,
  and memory-only access tokens; native Windows browser and vault adapters are
  still blocked and fail closed.
- Capability discovery that treats absent, stale, contradictory, or unknown
  evidence as unauthorized for mutation.
- Machine and AgentSession command foundations over public Runa contracts.
- Explicit Windows, macOS, and Linux path/configuration adapters.
- Network-free installed-artifact identity and self-test.
- Fail-closed gates for features whose producer contract or runtime is not yet
  available.

Cloud terminal attachment, daemon integration, workspace synchronization, and
the local companion remain pre-release work. Browser authentication is
implemented against the commit-pinned public 1.4.0 candidate contract.
Canonical contract approval, producer deployment and native Windows adapters
remain blocked. Source code or a documented interface is not evidence that a
capability is deployed.

## Quick start for contributors

Node.js 22.17.1+ on the Node 22 line or Node.js 24.4.1+ on the Node 24 line is
required. The current candidate supports x64 only.

```sh
git clone https://github.com/Runa-Laboratories/runa-cli.git
cd runa-cli
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm test
```

Inspect the local build without making a network request:

```sh
node dist/bin/runa.js self-test --offline --json
node dist/bin/runa.js version --json
```

## Installation interfaces

| Surface | Command | Platform | Current status |
| --- | --- | --- | --- |
| npm | `npm install -g @runa_laboratories/cli` | Windows x64, Intel macOS x64, Linux x64 | Not live; canonical publication is gated |
| Bun | `bun add --global @runa_laboratories/cli` | Windows x64, Intel macOS x64, Linux x64 | Not live; projects the same Node-based npm artifact |
| curl | `curl -fsSL https://runacode.io/install \| sh` | Intel macOS x64, Linux x64 | Not live; endpoint and recovery evidence are pending |
| Homebrew | `brew install Runa-Laboratories/tap/runa` | Intel macOS x64, Linux x64 | Not live; tap and installed-product evidence are pending |
| paru/AUR | `paru -S runa-cli-bin` | Arch Linux x64 | Not live; AUR ownership and installed-product evidence are pending |

Every projection must install the exact admitted npm tarball. No channel may
rebuild, patch, or independently version the CLI.

## Command surface

The current foundation exposes:

```text
runa capabilities
runa login
runa whoami
runa logout
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
unsupported/capability error and do not simulate a machine, session, or
successful mutation.

## Configuration and authentication

Configuration precedence is flag, environment, selected user profile, then the
canonical default. Production requests use exactly `https://api.runacode.io`.
Custom origins require an explicit development profile; repository content is
never a configuration authority.

`RUNA_API_KEY` is supported only as an explicit automation credential and is
never persisted automatically. Interactive `runa login` uses the browser
continuation contract without a local HTTP listener. Its renewable credential
and binding metadata are stored only in the operating-system vault; access
tokens remain process-memory-only. The automation and interactive credential
authorities never fall back to each other.

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
behavioral change needs executable test evidence, and every public contract
change must update producer and consumers through an expand-contract campaign.

## License

Copyright 2026 Runa Laboratories. Licensed under the
[Apache License 2.0](LICENSE). See [`NOTICE`](NOTICE) for attribution.

## Project status

Active pre-release development. The authoritative completion rule is stricter
than compilation or green unit tests: release requires installed-artifact,
contract, security, recovery, runtime, support, and cross-platform evidence.
