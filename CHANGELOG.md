# Changelog

All notable changes to this project will be documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Every error code the CLI emits now uses the `cuna.*` namespace instead of
  `runa.*`, in both `--json` records (`error.code`) and human output
  (`Error [code]: …`). Nothing is published yet, so no released consumer is
  affected. Wire protocol identifiers the service mints and compares
  (`runa.terminal.v1`, `runa.agent-auth.v1`, the `runa.auth.<token>` WebSocket
  subprotocol) are unchanged, as are the OS credential-vault target namespace
  and refresh-token binding digest.
- `RunaError` is renamed to `CunaError`. `RunaError` remains exported as a
  deprecated alias and will be removed after the first published release.
- Project exclusions are now read from `.cunaignore`; `.runaignore` is still
  honoured as a fallback so existing workspaces keep excluding the same paths.
- Every configuration environment variable is accepted under both `CUNA_` and
  `RUNA_` again: `*_API_KEY`, `*_BASE_URL`, `*_PROFILE` and `*_CONFIG_FILE`.
  The rename had replaced the four `RUNA_*` reads rather than adding to them,
  so a customer holding a key issued under the earlier brand — which the
  credential validator still accepts, and which both SDKs accept from either
  variable — could not present it here at all. `CUNA_` stays canonical and wins
  whenever it is set, including when it is set to an unusable value, which
  fails the command instead of falling back to the other spelling. Both names
  are derived from one brand list, so neither can be widened alone.
  `CUNA_TERMINAL_MODE` keeps its single name: no `RUNA_` spelling of it was
  ever shipped.
- An automation credential that is set but unusable is still refused, but only
  for commands that select a credential authority. `doctor`,
  `self-test --offline` and `config get` now run and report it instead of
  exiting 2 — a failed `export CUNA_API_KEY=$(fetch-secret)` used to disable
  the commands whose purpose is diagnosing exactly that. `cuna doctor` gained
  `environment_credential` and `environment_credential_variable`; `config get`
  gained `api_key_variable` and can report `api_key: "invalid"`.
- A configuration error raised by the environment now names the variable at
  fault in its `hint` and in `details.variable`, instead of telling every
  caller to correct the selected user profile.
- **An operation the deployed API does not serve now exits `8`, not `7`.** An
  HTTP 404 whose body is not a JSON object is written by a layer in front of the
  API, which has no route for the path; the transport used to decode the body
  before reading the status, so that answer surfaced as
  `cuna.remote.malformed_response` and exited `7`. It is now
  `cuna.remote.operation_not_served` and exits `8`. Production serves 26 of the
  57 operations this build knows, so this is the majority answer today and not
  an edge case. **A consumer that branches on `7` for an unserved operation is
  broken by this and must accept `8`.** The neighbouring case is unchanged: a
  404 that does carry a JSON body is an absent resource, stays
  `cuna.remote.not_found`, and still exits `7`.

### Added

- The exit-code contract is documented. `README.md` gained an **Exit codes**
  section listing all nine codes the program can return — `0`, `2`, `3`, `4`,
  `5`, `6`, `7`, `8` and `70` — with one reachable path each, and
  `cuna --help` gained an `Exit codes:` section listing the same set. Both are
  projected from the `EXIT_CODES` map rather than transcribed beside it, so
  neither can describe a build that no longer exists.
  `test/exit-code-contract.test.mjs` pins every number against a hand-written
  literal and exercises one reachable path per code, which is what makes a move
  like the `7` to `8` above impossible to land unrecorded.
- Established the initial public CLI architecture and release controls.
- Initial fail-closed TypeScript CLI, public API client, cross-platform adapters,
  offline installed-artifact identity, and release-admission scaffolding.

### Security

- Exact Cuna API-origin validation, bounded responses, redacted errors,
  capability-gated mutations, SHA-pinned GitHub Actions, and OIDC-only preview
  publication.

[Unreleased]: https://github.com/Cuna-Labs/cuna-cli/commits/main
