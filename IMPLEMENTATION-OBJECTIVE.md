# Runa CLI Implementation Objective

Implement the accepted PRD corpus in `prds/` as the official Runa CLI. Before
writing code, verify that the PRD index, dependency DAG, central decisions,
state machines, public contracts, and requirement-to-test traceability are
complete, consistent, acyclic, and Ready. Unknown central behavior blocks its
dependent implementation; it is never replaced by a silent assumption.

The user experience SHALL feel like Claude Code, Codex, or another supported
agent is running in the user's local terminal while its process and workload
run in an isolated Runa cloud machine. The CLI SHALL support account enrollment,
waitlist and browser authentication, workspace admission, machine lifecycle,
multiple independent AgentSessions per machine, a trusted orange Runa terminal
appbar with safe session switching, and a compatible plain/passthrough mode.

Implement synchronization, management commands, optional local capabilities,
security controls, observability, packaging, and release gates exactly as the
accepted PRDs define them. Public contract changes SHALL update infra,
app-website, CLI, and—where the operation is appropriate for programmatic
clients—the TypeScript and Python SDKs in one compatible expand-contract
campaign. SDKs SHALL NOT acquire implicit TUI, PTY, watcher, daemon, browser,
interactive-login, or automatic-sync behavior.

Windows, macOS, and Linux are equal Tier-1 platforms. A feature is not complete
when it works on only one of them: terminal behavior, daemon/IPC, filesystem
semantics, browser handoff, credential storage, install/update/uninstall,
recovery, and accessibility SHALL pass installed-artifact tests on all three.
The canonical installation command is
`npm install -g @runa_laboratories/cli`; Bun, the official curl bootstrap,
Homebrew, and paru/AUR SHALL be supported projections of the same approved
release identity, never independent or source-rebuilt releases.

Delegate implementation and independent verification by semantic obligation.
Serialize conflicting writes, resolve disagreements through evidence and domain
authority, and rerun independent reviews after every material remediation wave.
Every MUST requirement requires an implementation, an independent behavioral
oracle, a seeded negative control, platform coverage, and evidence freshness
rules.

Do not declare completion from compilation, green CI, UI appearance, or self-
reported status. Validate real postconditions against exact source, artifacts,
contracts, deployments, configuration, and supported environments. The final
decision SHALL be `READY`, `READY_WITH_CONDITIONS`, `BLOCKED`, or `EXPIRED`.
Production promotion and GA remain prohibited while any security, data-loss,
contract, authentication, runtime, recovery, support, or observability blocker
remains.
