<div align="center">
  <h1>Cuna CLI</h1>
  <p><strong>Run cloud coding agents from your own terminal.</strong></p>
  <p>[![CI](https://github.com/Cuna-Labs/cuna-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Cuna-Labs/cuna-cli/actions/workflows/ci.yml) [![CodeQL](https://github.com/Cuna-Labs/cuna-cli/actions/workflows/codeql.yml/badge.svg)](https://github.com/Cuna-Labs/cuna-cli/actions/workflows/codeql.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE) [![Node.js](https://img.shields.io/badge/node-22.17.1%2B%20%7C%2024.4.1%2B-339933?logo=node.js&logoColor=white)](package.json)</p>
</div>

Claude Code, Codex and OpenCode feel like they are running on your laptop. They
are not: the processes, the sessions and the files live on a Cuna cloud machine,
and they survive when you close the lid.

## What it gives you

- **Sessions that outlive your terminal.** Close the lid, lose the network, come back — the agent kept working.
- **Your files, their machine.** A directory syncs to an isolated cloud workspace and back.
- **Three agents, one client.** Claude Code, Codex and OpenCode, chosen per machine.
- **One command to start.** `cuna` picks the machine, the provider and the session for you.
- **Exit codes you can script against.** A closed set, each with one meaning, pinned by tests.
- **Browser sign-in with no local listener.** PKCE, and the credential encrypted at rest.
- **Windows, macOS and Linux.** One payload, no per-platform build.

## Quick start

```sh
npm install -g @cuna_labs/cli
cuna login
cuna
```

`cuna` with no arguments walks you through choosing a machine, a provider and a
session. You never type a resource ID on the normal path.

Needs Node.js 22.17.1+ or 24.4.1+. npm is the only channel, on Windows, macOS
and Linux.

## A minimal session

Point a provider at a directory and it opens there:

```sh
cuna claude ./my-project
```

Your files sync to a cloud machine, the agent runs on that machine, and the
terminal in front of you is a view of it. Close the lid and the session keeps
going.

Detach with `Ctrl+C` — it leaves your terminal, it does not stop the agent. To
come back:

```sh
cuna machines
```

Inside a session, `Ctrl+]` is the escape prefix: `?` for help, `d` to detach,
`c` to send a real `Ctrl+C` to the agent, `n` for the next tab, `1`-`4` to pick
one. Pasted text never triggers them.

## Commands

```text
cuna login | whoami | logout
cuna capabilities
cuna config get

cuna machines list
cuna machines create --name NAME --idempotency-key KEY --yes
cuna machines start | pause | resume | stop | delete ID --yes

cuna agent-sessions list --machine ID
cuna agent-sessions create --machine ID --agent claude-code --idempotency-key KEY --yes

cuna claude | codex | opencode [PATH]
cuna self-test --offline --json
cuna version --json
```

`cuna help --all` has the rest. A command whose capability the server does not
serve returns a clear error and a non-zero exit code; it never pretends a
machine, a session or a change succeeded.

## Configuration

Settings resolve flag first, then environment variable, then your profile, then
the default. Production always talks to `https://api.getcuna.com`.

`cuna login` opens your browser and you paste back the `cuna_login_` value it
shows once. It is stored encrypted, scoped to your OS user, and exchanged for a
short-lived token on every run. `cuna logout` revokes it before deleting it.

`CUNA_API_KEY` is for automation and is never saved for you.

> [!WARNING]
> Never put an API key in a command-line argument, a repository file, an issue,
> a terminal recording, or a diagnostic bundle.

## Exit codes

For anything scripting this CLI, the exit code is the whole contract. `3`, `7`
and `8` all mean "that did not happen", and each asks for something different:
replace the credential, distrust the answer, or stop asking this deployment.

<!-- BEGIN GENERATED: exit-codes -->
| Exit code | Name | Meaning | One reachable path |
| --- | --- | --- | --- |
| `0` | `success` | The command completed and the record it printed is authoritative. | `cuna self-test --offline` verifies the installed artifact without a network request and returns. |
| `2` | `usage` | The invocation or the resolved configuration is invalid. | `cuna nonsense` fails the command preflight with `cuna.usage.invalid`. Nothing is sent to the server. |
| `3` | `auth` | No usable credential, a rejected credential, or an auth-mode conflict. | `cuna whoami` while `CUNA_API_KEY` is set mints `cuna.auth.mode_conflict`. A credential the server refuses arrives as `cuna.auth.rejected` from HTTP 401. |
| `4` | `policy` | Understood and refused by policy, including a required confirmation. | `cuna machines delete ID` without `--yes` mints `cuna.confirmation.required`. A server refusal arrives as `cuna.policy.denied` from HTTP 403. |
| `5` | `network` | No authoritative answer arrived, including when the CLI stopped waiting for one. | a request exceeding its observation budget mints `cuna.client.response_budget_elapsed`, and a bounded read-back that has not converged mints `cuna.client.convergence_budget_elapsed`; both are retryable and name the read to run. HTTP 429 and 5xx arrive as `cuna.network.rate_limited` and `cuna.network.service_unavailable`. |
| `6` | `conflict` | Current state contradicts the change; repeating it unchanged repeats this. | Most HTTP 409 responses mint `cuna.remote.conflict`. A foreground attach to a session already held mints `cuna.runtime.session_conflict`; provider-installation admission is instead an unsupported action with a concrete Machine-selection remedy. |
| `7` | `remote` | The server answered, but not in a way the published contract allows. | `cuna account show` against a deployment whose body fails contract decoding mints `cuna.remote.malformed_response`. A 404 that does carry a JSON body is an absent resource and lands here as `cuna.remote.not_found`. |
| `8` | `unsupported` | This deployment does not serve or does not advertise the capability. | `cuna records list` against a deployment with no route for it mints `cuna.remote.operation_not_served`: HTTP 404 whose body is not JSON, which only a layer in front of the API writes. |
| `70` | `internal` | The CLI itself failed; no server outcome is implied. | any throw that is not a `CunaError` reaching the top of `runCli` is normalized to `cuna.internal.unexpected`. |
<!-- END GENERATED: exit-codes -->

Two of them are easy to misread. `5` does not mean the change failed — a
timeout cannot tell you whether it arrived, so the CLI stops rather than guess
and never retries a mutation on its own. `8` is not load; it describes what the
deployment serves, so trying again returns `8` again.

## Development

```sh
git clone https://github.com/Cuna-Labs/cuna-cli.git
cd cuna-cli
npm ci --ignore-scripts
npm run lint && npm run typecheck && npm test
```

Inspect a build without touching the network:

```sh
node dist/bin/cuna.js self-test --offline --json
```

Or install the packed artifact and take the journey a user takes:

```sh
npm install --global ./cuna_labs-cli-0.1.0.tgz
cuna login
cuna
```

The public OpenAPI contract decides what goes over the wire. The CLI owns the
interactive parts: terminal behaviour, the local daemon and file
synchronization. The daemon, synchronization and the companion app are still
pre-release, and source code is never evidence that a capability is deployed —
commands ask the live server and fail closed when the answer is missing or
stale.

## Security

Report vulnerabilities privately per [`SECURITY.md`](SECURITY.md). Never open a
public issue containing an exploit, a credential, a private URL or customer
data.

Releases build one immutable npm candidate, generate an SBOM and provenance,
install that exact artifact on every supported platform, and publish through npm
Trusted Publishing with short-lived OIDC.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. Every behavioural change needs a
test that can fail.

## License

Copyright 2026 Ring0 Labs, Inc. - Cuna Labs. Licensed under the
[Apache License 2.0](LICENSE). See [`NOTICE`](NOTICE) for attribution.
