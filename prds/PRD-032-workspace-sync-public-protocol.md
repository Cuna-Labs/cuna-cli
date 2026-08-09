# PRD-032: Workspace Sync Public Protocol

| Field | Value |
| --- | --- |
| Status | Accepted |
| Owner | Infrastructure contract and Runa CLI maintainers |
| Depends on | PRD-002, PRD-003, PRD-005, PRD-015, PRD-018, PRD-020 |
| Unlocks | PRD-016, PRD-017, PRD-021, PRD-024 |

## Problem

Workspace PRDs define content and convergence behavior but no public wire
authority. Without exact operations, schemas, limits, idempotency and
mixed-version rules, neither implementation nor compatibility evidence is
deterministic.

## Goals and non-goals

- **G-032-01:** Freeze a Runa-only, versioned content-addressed sync protocol.
- **G-032-02:** Make retries idempotent and commits atomic.
- **G-032-03:** Bound data, protect tenant/workspace isolation and avoid secrets.
- **G-032-04:** Support N/N-1 rollout and state-safe rollback.

Non-goals: generic object storage, arbitrary filesystem access, public internal
provider transports, last-writer-wins, or sync of excluded content.

## Versioned operations

The OpenAPI authority SHALL define these additive Runa operations (names are
stable; exact JSON Schemas are implementation-gate artifacts):

| Operation | Method/path | Purpose |
| --- | --- | --- |
| `workspaces.sync.begin` | `POST /v1/workspaces/{id}/sync-sessions` | Bind base generation, policy digest, protocol range and idempotency key. |
| `workspaces.sync.negotiate` | `POST /v1/workspace-sync/{id}/manifests` | Submit bounded manifest pages and receive missing content digests. |
| `workspaces.sync.chunk` | `PUT /v1/workspace-sync/{id}/chunks/{digest}` | Idempotent bounded content upload with digest verification. |
| `workspaces.sync.commit` | `POST /v1/workspace-sync/{id}/commit` | Compare-and-swap atomic generation commit. |
| `workspaces.sync.changes` | `GET /v1/workspace-sync/{id}/changes` | Bounded cursor page or upgrade metadata for remote deltas. |
| `workspaces.sync.reconcile` | `POST /v1/workspaces/{id}/reconcile` | Compare full safe manifest after dirty/uncertain state. |

Every response uses closed schemas, stable problem codes, request ID, selected
protocol and capability flags. Content URLs, when used, remain Runa-controlled,
short-lived and purpose-bound.

## Requirements

| ID | Force | EARS requirement | Goal | Test |
| --- | --- | --- | --- | --- |
| R-032-01 | MUST | WHEN sync begins, the server SHALL authenticate ownership and bind workspace, machine, base generation, exclusion-policy digest, protocol version and idempotency identity. | G-032-01, G-032-03 | TC-032-01 |
| R-032-02 | MUST | WHEN client/server protocol ranges intersect, the producer SHALL select the highest shared version; otherwise it SHALL return `protocol_not_supported` without state mutation. | G-032-01, G-032-04 | TC-032-02 |
| R-032-03 | MUST | WHEN manifest, page, chunk, path, total-byte, entry-count or concurrency limits are exceeded, the producer SHALL reject safely before activating a generation. | G-032-03 | TC-032-03 |
| R-032-04 | MUST | WHEN a chunk is accepted, its digest and length SHALL match the declared content and same-intent retries SHALL be idempotent. | G-032-02 | TC-032-04 |
| R-032-05 | MUST | WHEN commit base generation or policy digest is stale, the producer SHALL return a conflict and preserve both the active generation and staged evidence. | G-032-02, G-032-03 | TC-032-05 |
| R-032-06 | MUST | WHEN commit succeeds, the complete generation SHALL become visible atomically; partial staged content SHALL never become the active workspace. | G-032-02 | TC-032-06 |
| R-032-07 | MUST | IF a request references a foreign/nonexistent workspace, THEN observable status/body classes SHALL not disclose existence. | G-032-03 | TC-032-07 |
| R-032-08 | MUST | Sync schemas and diagnostics SHALL contain no local absolute path, credential plaintext, internal provider field, excluded-content digest or terminal bytes. | G-032-03 | TC-032-08 |
| R-032-09 | MUST | N and N-1 producers/clients SHALL read every durable journal/generation created during the supported rollout window or reject before mutation with a recoverable migration path. | G-032-04 | TC-032-09 |

## Protocol sequence

```mermaid
sequenceDiagram
  participant C as Runa CLI
  participant A as Runa API
  participant S as Workspace store
  C->>A: begin(base generation, policy digest, version range)
  A-->>C: selected version + sync id
  C->>A: manifest pages
  A-->>C: missing digests
  loop bounded parallel chunks
    C->>A: chunk(digest, bytes)
    A->>S: verify and stage idempotently
  end
  C->>A: commit(expected generation, manifest root)
  alt CAS and verification pass
    A->>S: atomic generation activation
    A-->>C: committed generation
  else stale, malformed or incomplete
    A-->>C: stable conflict/rejection; active tree unchanged
  end
```

## Fault model, compatibility and recovery

Tests cover duplicate/reordered pages/chunks, digest collision attempts,
truncation, timeout before/after commit, concurrent commits, cross-tenant IDs,
quota exhaustion, policy drift and crash recovery. Negative controls replace
CAS with last-write-wins and digest verification with trust-on-input; both must
fail.

The compatibility matrix includes old server/new CLI, new server/old CLI,
unknown required fields, N/N-1 manifest/journal/conflict schemas and rollback
after new durable state. Deploy storage/schema and producer first; disable begin
for new protocol versions before rollback. Never delete active or staged user
content merely to roll back code.

## Consumer obligations and abstraction boundary

The OpenAPI document plus canonical examples, problem-code registry, state-transition model and golden digest/path vectors form the sole public contract authority. Infrastructure owns runtime authorization, CAS, journals and storage. CLI owns workspace discovery, exclusion evaluation, traversal, watching, reconciliation orchestration and local application. The app may expose status/actions but SHALL NOT create a second sync protocol.

Every public operation introduced here SHALL ship, when intended for programmatic clients, with equivalent idiomatic TypeScript and Python SDK methods, request/result models, typed errors, pagination/stream semantics, documentation and contract tests in the same compatible release campaign. SDKs may upload explicit bytes/manifests and query explicit server state; they SHALL NOT implicitly scan directories, start watchers, choose conflicts, manage PTYs or synchronize a workspace merely by constructing a client.

Request and response compatibility are evaluated separately for CLI, app, TypeScript SDK and Python SDK N/N-1 populations. Unknown required semantics SHALL reject before mutation. Durable manifest, journal, generation and conflict records carry minimum-reader/minimum-writer versions; rollback requires a proven old-reader path, reversible migration, read-only export or roll-forward containment.

Protocol evidence requires independent runtime-conformance replay, consumer-driven tests and negative controls that remove CAS, tenant binding, policy binding or digest verification. Schema generation alone cannot prove behavior. Evidence expires on OpenAPI, implementation, storage schema, canonicalizer, policy, SDK generator/runtime or deployment-topology change.

## Observability and acceptance

Record only structural counts, bytes, latency, selected version, safe result and
non-secret IDs. Acceptance requires TC-032-01 through TC-032-09, schema-derived
consumer tests, replay/concurrency negative controls and a rollback rehearsal.
