# ADR-0004: AgentSession Workspace Overlays

**Status:** Accepted  
**Decision owners:** Workspace Service, Machine Runtime  
**PRDs:** 015-021, 032, 033, 039, 040

## Decision

Every mutable AgentSession receives a copy-on-write overlay above an immutable
admitted workspace revision. Direct concurrent processes do not share one
unversioned writable tree. Publication is a compare-and-swap merge into the
canonical revision; conflicts preserve every causal variant until explicit
resolution.

The local filesystem, local daemon journal, workspace service, machine-side
observer, and AgentSession overlay each have distinct identities and epochs.
A watcher is a change signal, not proof of completeness. Manifest roots,
durable journals, receipts, and revision CAS are the oracles.

## Consequences

- Same-file overwrites cannot erase an unobserved sibling variant.
- AgentSession creation binds base revision, overlay identity, writer epoch,
  working directory, and policy version.
- Rename, delete, policy change, offline replay, and overlay publication are
  causal operations, not timestamp guesses.
- NTFS, APFS, and supported Linux filesystems use canonical path vectors and
  reject lossy transformations before mutation.

## Falsifier

If the selected overlay implementation cannot preserve variants or meet the
large-repository budgets, general multi-writer launch remains disabled; the
system does not fall back to silent last-write-wins.

