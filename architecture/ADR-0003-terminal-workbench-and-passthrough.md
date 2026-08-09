# ADR-0003: Terminal Workbench and Passthrough

**Status:** Accepted with spike gate  
**Decision owners:** CLI Runtime, Developer Experience  
**PRDs:** 004, 008, 009, 010, 033, 038

## Decision

Rich mode owns the outer terminal screen. Each AgentSession renders inside an
isolated virtual terminal viewport; trusted orange Runa chrome remains outside
remote escape-sequence authority. Exactly one view owns foreground input. A
session switch fences the old target before activating the new target.

Passthrough mode remains a first-class fallback for unsupported terminals,
accessibility modes, automation, `TERM=dumb`, and environments where the rich
renderer cannot prove safe restoration. Passthrough shows no persistent appbar.

The first implementation spike evaluates `@xterm/headless` against Claude Code,
Codex, shells, alternate screen, Unicode width, mouse, bracketed paste, resize,
OSC containment, 1 GiB output, tmux, SSH, Windows Terminal, macOS Terminal, and
a representative Linux terminal. The dependency is admitted only after this
suite and its seeded cross-session routing defect pass.

## Consequences

- Remote payload is never parsed as product/auth/billing truth.
- Remote OSC/title/clipboard sequences cannot change trusted chrome or local
  authority.
- Renderer failure restores the host terminal and detaches; it does not kill
  the cloud process.
- A platform that cannot satisfy rich-mode invariants uses explicit passthrough,
  never a visually similar weakened mode.

