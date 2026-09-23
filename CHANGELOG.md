# Changelog

All notable changes to this project will be documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-09-22

### Fixed

- **Workspace sync no longer overwrites newer or local bytes.** A folder
  re-attached after the Machine moved ahead now takes in the newer generations
  before sending its own edits, instead of committing its stale tree over them.
  A folder whose base cannot be proven is refused with
  `cuna.journey.workspace_base_unproven`, and a base ahead of the server with
  `cuna.journey.workspace_generation_rollback`; nothing is sent in either case.
- **A path changed on both sides keeps both versions.** The local bytes stay
  (or, for a conflict the Machine already resolved, the Machine's bytes win)
  and the other version is kept beside it as `<path>.cuna-conflict-<G>-<sha12>`.
  One line names each conflict (`cuna.workspace_sync.conflict_retained`), and
  sync continues instead of stopping silently in `conflicted`.
- Relaunching a folder after its session ended no longer dead-ends: the
  recorded-launch question is asked before the journal lease is taken,
  `--new-session` answers it, and answering No to a launch recorded under
  another version is a typed refusal with a `--new-session` hint.
- A remote launch no longer ends in `Unknown command` (exit 2) right after the
  AgentSession is created; it attaches again.
- A running execution-Workspace session for the same folder is reused instead
  of a second one being created.
- A fresh AgentSession whose terminal capability is not yet attested is waited
  for, bounded, instead of reported as a failure to retry.
- A second writer can no longer be admitted through the journal lock fallback.

### Changed

- The first line is painted before the CLI's module graph loads.
- The progress row names what it waits for and for how long; the account read
  at the head of every journey waits under a 45 s deadline
  (`Still waiting for your account · 15s of 45s`).
- A keystroke unacknowledged for 5 s is named
  (`Connection stalled · reconnecting — input not resent`) and the connection
  is reopened; the input is not resent.
- Re-attaching from the same computer reuses its terminal client id for that
  profile and AgentSession while this process holds the local lock; a second
  local process attaches as a new client and says so.

### Known issues

- Re-attaching can fail once with exit 4,
  `cuna.runtime.capability_snapshot_expired`, when the journey's preparation
  outlasts the terminal capability it read; running the same command again
  attached in the observed case.
- An attach was observed to take the writer seat and then paint nothing for
  about ten minutes; `Ctrl+] d` detached it at once. Not yet diagnosed.
- Answering No to the recorded-launch question for a folder whose last session
  was terminated prints `AgentSession … · reused` and exits 7
  (`cuna.journey.agent_session_failed`). Answer y, or pass `--new-session`.

## [0.1.0] - 2026-09-16

### Changed

- **The CLI no longer reports a failure for an operation that succeeded.** Two
  commands were measured on 2026-08-19 against Fly release v93 returning a hard
  `retryable: false` error for work the server completed: `machines create`
  returned `cuna.network.timeout` for a machine that reached `running` five
  seconds later, and `machines delete` returned
  `cuna.remote.postcondition_unverified` with `observed_state: "present"` for a
  machine that `machines list` showed gone six seconds later. Both were the
  CLI's own observation budget being shorter than the operation, reported as
  though the operation had failed.

  A refusal caused by the CLI's budget now carries its own codes, minted in one
  place, always `retryable: true`, and always naming the read-only command that
  settles the question:

  | Before | After |
  | --- | --- |
  | `cuna.network.timeout` (exit 5, `retryable: false` for mutations) | `cuna.client.response_budget_elapsed` (exit 5, `retryable: true`) |
  | `cuna.remote.postcondition_unverified` (exit 6) for a state that had not converged yet | `cuna.client.convergence_budget_elapsed` (exit 5, `retryable: true`) |

  `cuna.network.timeout` is retired. `cuna.remote.postcondition_unverified`
  remains, narrowed to what it always meant: a read-back that CONTRADICTS the
  write and that waiting cannot repair. `cuna.network.failed` is unchanged,
  including its fail-closed retryability for mutations — there the network
  really did fail.

  `machines delete` and the four `machines` lifecycle transitions now read back
  until the change is visible or the budget elapses, instead of judging on one
  immediate read. `POST /v1/sessions` carries a 90 s budget of its own instead
  of the 15 s global default; an explicit `--timeout-ms` still outranks it. No
  exit code changed its number, and no new exit code was added.
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

### Fixed

- `cuna login` now prints the browser continuation URL to the terminal before
  it tries to open a browser, so the sign-in can be completed even when no
  browser can be spawned — a headless host, an SSH session, WSL, or a desktop
  with no registered default browser. Previously the command only attempted the
  spawn and then asked the user to paste a code from a page they had no way to
  reach: the console's `/cli/continue` page takes its continuation proof from
  the URL fragment, refuses to fall back to an older one, and has no other
  entry point, and the CLI was the sole holder of that fragment. The command
  was therefore not completable by any means on a host where the spawn did
  nothing.
- A browser that cannot be opened no longer fails the sign-in. The printed URL
  is a complete affordance, so the spawn is now a convenience whose failure is
  reported (`Could not open a browser automatically.`) rather than propagated.
  Announcing and opening are one function, `handOffContinuationToBrowser`, so
  the two cannot drift apart into a build that opens without telling anyone.
- `cuna login` reads the sign-in completion mode from `GET
  /v1/cli-auth/bootstrap` instead of assuming it, and refuses with
  `cuna.auth.completion_mode_unsupported` when the service advertises a mode
  this build cannot drive — rather than silently running the paste flow against
  a service that is not going to show the user a code. The dispatch is an
  exhaustive switch, so teaching the decoder a second mode without teaching
  `login` to complete it is a compile error.

  All handoff output goes to stderr, which `run` already refuses unless stdin,
  stdout and stderr are all TTYs, so the continuation fragment cannot reach a
  pipe, a file or `$(cuna login)`. The one-time login code is unaffected: it is
  still read with echo suppressed and never printed, logged, written to a file,
  or placed in any URL the CLI constructs.

### Security

- Exact Cuna API-origin validation, bounded responses, redacted errors,
  capability-gated mutations, SHA-pinned GitHub Actions, and OIDC-only preview
  publication.

[Unreleased]: https://github.com/Cuna-Labs/cuna-cli/commits/main
