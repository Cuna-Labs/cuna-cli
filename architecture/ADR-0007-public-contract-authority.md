# ADR-0007: Public Contract Authority

**Status:** Accepted  
**Decision owners:** API Governance, Infra, SDK, CLI, App  
**PRDs:** 003, 024, 031-034, 037

## Decision

One canonical OpenAPI artifact owns public REST names, schemas, errors,
exposure classes, and compatibility. Infra implements the producer. The app,
CLI, TypeScript SDK, and Python SDK consume candidate-bound projections and
must match the canonical digest. Generated code is a projection, not a second
authority.

Operations declare `x-cli-exposed`, `x-sdk-exposed`, or web/admin-only intent.
Programmatic public operations receive idiomatic TypeScript and Python methods,
models, errors, pagination, idempotency, examples, and contract tests. TUI,
PTY, daemon, watcher, filesystem orchestration, browser companion, and implicit
interactive login remain CLI-only.

## Consequences

- Contract/runtime/app/SDK drift blocks promotion.
- Existing `/sessions` remains a legacy Machine projection; new identifiers are
  never reinterpreted.
- New collections are bounded pages. Mutations bind idempotency keys to caller,
  operation, resource, canonical payload, and schema version.
- Unknown required semantics reject before mutation; old/new producer and
  consumer populations are tested independently.

