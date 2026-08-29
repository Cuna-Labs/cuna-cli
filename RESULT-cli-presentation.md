# RESULT — CLI presentation — 2026-08-19

Status: IMPLEMENTED, UNCOMMITTED because this sandbox denies writes to this clone's `.git/index.lock` (`Permission denied`). No push, PR, merge, network access, production call, or package installation occurred.

## Bound subject and measurement

- Subject ref: `feat/cli-presentation@c857adc` before this lane; working result is the uncommitted diff on that ref.
- Host: `ANGEL / Microsoft Windows NT 10.0.26200.0`, Node `v24.18.0`.
- Encoding: UTF-8 source and Node string capture; terminal controls are literal ANSI only when stderr is a TTY.
- Parser population: all 28 root command arms in `src/commands/commands.ts` — `config`, `capabilities`, `machines`, `records`, `authorizations`, `account`, `workspace`, `usage`, `api-keys`, `agent-sessions`, `agent`, `signup`, `login`, `logout`, `whoami`, `access`, `claude`, `codex`, `openclaw`, `opencode`, `connect`, `doctor`, `self-test`, `version`, `help`, plus reserved `shell`, `sync`, `companion` — including their parser-owned nested actions. Presentation is at the single `OutputWriter` result boundary, so it covers this whole population without a duplicate registry.

A correct renderer scores: for every phase actually entered by an automatic journey, stderr contains a start render and exactly one durable terminal line with its outcome and elapsed duration; structured stdout is byte-identical for every `--json` or non-TTY success in this population. A successful create path enters nine phases; `reconcile-machine-create` is only entered when `create-machine` fails to return an authoritative outcome, so no successful run can honestly show both as completed.

## What changed

- Replaced inherited one-line phase narration with a zero-dependency renderer: ASCII spinner frames, elapsed seconds, durable completed/failed/cancelled lines, ANSI cursor hide/show, and cleanup in `finally` plus `AbortSignal`.
- The orchestrator now emits lifecycle events from its existing phase authority; presentation never owns a second phase list. Presentation observer failures are advisory and cannot change provisioning, sync, or attach semantics.
- Workspace synchronization reports only manifest/page-confirmed byte and file milestones. The displayed bar is never timer-derived.
- Interactive list results are tables on stderr. Human output and help now use stderr; structured JSON remains on stdout for `--json` and every pipe. Existing CunaError output already renders code, message, details and hint on stderr and remains semantically unchanged.
- `NO_COLOR` and `--no-color` suppress SGR colour; JSON and non-TTY construction create no renderer, timer, cursor sequence, or colour byte.

## C0 decision record

1. Recommended: zero-dependency ANSI. The implementation is local strings, an interval and four ANSI families; no runtime supply-chain expansion.
2. Rejected: a small spinner dependency such as ora. The binding PRD records roughly ten transitives for ora alone; this published developer artifact currently ships exactly one runtime dependency. Network is unavailable here, so this result does not claim a fresh release/licence lookup.
3. Rejected: a full task UI such as listr2 or ink. It buys richer layouts and nested task state, but adds runtime dependencies, React/TUI lifecycle surface, and more terminal compatibility risk than the single-authority phase feed warrants. Chalk loses because four colour codes suffice; ora loses because elapsed phase lines, terminal restoration and real sync progress are the hard parts, not spinner glyphs.

## Verification

- `feat/cli-presentation@c857adc` BEFORE — **63 tests / 0 pass / 63 fail / 0 skip**, host above. This is not a product-suite population measurement: Node's runner failed before execution with `spawn EPERM` in `test/terminal-passthrough.test.mjs`.
- uncommitted result AFTER — **64 tests / 0 pass / 64 fail / 0 skip**, same host. The only count change is discovery of `test/cli-presentation.test.mjs`; the same sandbox `spawn EPERM` aborts before tests execute.
- `npm run typecheck`: PASS.
- `npm run lint`: PASS.
- Direct same-process renderer suite: **4 tests / 4 pass / 0 fail**. It proves JSON stderr empty; non-TTY stderr empty; a positive TTY control emits terminal bytes; elapsed/proportional durable output; show-cursor on failure and abort; TTY table on stderr; and exact structured JSON stdout.
- Direct focal automatic-journey integration: **1 test / 1 pass / 0 fail** (`valid automatic agent intents execute the effects-fenced journey and exact attach`).

The JSON and non-TTY controls are failure-capable: remove either side of `if (input.json || !input.stderrIsTTY)` and its corresponding empty-capture assertion fails; the TTY control proves the sink can observe the cursor sequence.

## Plain-text transcripts (deterministic local integration fixtures, no network)

`cuna claude .` successful-create path:

```text
$ cuna claude .
| inspect workspace - 0.0s
[completed] inspect workspace - completed in 0.1s
/ observe machines - 0.1s
[completed] observe machines - completed in 0.2s
- create machine - 0.2s
[completed] create machine - completed in 37.0s
\ ready machine - 37.0s
[completed] ready machine - completed in 37.2s
| synchronize workspace - 37.2s
/ synchronize workspace - 37.4s  [████████░░░░░░░░] 50% 512 KiB/1.0 MiB 1/2 files
[completed] synchronize workspace - completed in 38.0s  [████████████████] 100% 1.0 MiB/1.0 MiB 2/2 files
/ observe agent sessions - 38.0s
[completed] observe agent sessions - completed in 38.1s
- create agent session - 38.1s
[completed] create agent session - completed in 38.5s
\ ready agent session - 38.5s
[completed] ready agent session - completed in 39.0s
| attach - 39.0s
[completed] attach - completed in 39.1s
```

`cuna machines list` TTY:

```text
$ cuna machines list
ID                                    NAME  STATE
------------------------------------  ----  -------
m-1                                   dev   running
```

## Required closure

What I built: the zero-dependency stderr renderer, real sync denominator propagation, durable outcomes/durations, safe terminal restoration, parser-wide human tables, and failure-capable tests.

What I REFUTED: at `c857adc`, the finding's statement that `machines list` prints raw JSON to a TTY is stale; it already emitted tab-separated human rows. The sibling commit also refutes complete phase silence by adding start narration. This lane upgrades both to legible tables and lifecycle-aware feedback.

What I did NOT do and why: no dependency, provider/network call, production journey, destructive command, push, PR, merge or package install — all are forbidden or unavailable. I did not commit because `.git/index.lock` is write-denied by the sandbox. I did not write `_buzon/RESULT-cli-presentation-2026-08-19.md` or its README row because that path is outside the writable roots; this fallback report is at the clone root as directed.

Cheapest overturning observations: (1) run the compiled CLI in a real Windows PTY and capture separate stdout/stderr during a machine create; any missing durable phase line, escaped cursor, or stdout presentation byte disproves the renderer claim. (2) capture one synchronization with more than one manifest page; a reported numerator that advances before the page's manifest and uploads settle disproves the real-progress claim. (3) grant write access to `.git` and rerun `git commit`; a successful commit disproves the sandbox-commit blocker.