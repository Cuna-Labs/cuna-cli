# Runa CLI Architecture Decisions

These ADRs resolve the central decisions required to move the Runa CLI from
requirements into implementation. They refine, but do not weaken, the PRDs.
Implementation evidence may invalidate an ADR; until then, every component
MUST follow the accepted direction or open a superseding decision.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](ADR-0001-runtime-repository-and-package.md) | TypeScript ESM, Node 22+, npm package authority | Accepted |
| [0002](ADR-0002-local-daemon-and-ipc.md) | One per-user daemon with authenticated local IPC | Accepted |
| [0003](ADR-0003-terminal-workbench-and-passthrough.md) | Isolated virtual terminal workbench plus passthrough fallback | Accepted with spike gate |
| [0004](ADR-0004-agent-session-workspace-overlays.md) | Copy-on-write overlay per AgentSession | Accepted |
| [0005](ADR-0005-browser-authentication-authority.md) | Runa website/identity broker owns browser enrollment | Accepted |
| [0006](ADR-0006-local-capability-bridge.md) | Outbound-only, consented local companion | Accepted for preview only |
| [0007](ADR-0007-public-contract-authority.md) | One canonical OpenAPI authority and independent consumers | Accepted |

Windows, macOS, and Linux are equal Tier-1 platforms. No ADR may silently
degrade one platform; unsupported behavior must fail before mutation.

