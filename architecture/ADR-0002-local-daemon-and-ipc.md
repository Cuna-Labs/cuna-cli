# ADR-0002: Local Daemon and IPC

**Status:** Accepted  
**Decision owners:** CLI Runtime, Security  
**PRDs:** 003, 006, 035, 040

## Decision

One per-user Runa daemon coordinates local mutable state. CLI views connect
through an authenticated, versioned Unix-domain socket on macOS/Linux and a
user-scoped named pipe on Windows. Exactly one fenced daemon owns a writable
WorkspaceBinding lease, local journal, watcher, and companion channel.

The daemon is not a cloud control plane. It caches projections, coordinates
local work, and reconciles through server authority. It cannot declare a
Machine, AgentSession, authorization, sync revision, or billable effect
successful without the authoritative server receipt.

## Consequences

- Multiple CLI processes attach to one coordinator instead of starting
  competing watchers or refresh flows.
- IPC messages carry protocol version, client identity, operation ID, bounds,
  and explicit result truth state.
- Daemon crashes preserve journals and fence stale owners. They detach local
  views; they do not terminate cloud processes.
- Update and downgrade require an N/N-1 IPC and durable-state compatibility gate.

## Falsifier

If authenticated single-owner IPC cannot be implemented equivalently on all
Tier-1 platforms, the affected local mutation is disabled; it is never replaced
by unfenced per-process ownership.

