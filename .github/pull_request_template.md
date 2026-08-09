## Obligation

Describe the user or system obligation this change implements or preserves.

## Semantic impact

- [ ] Public API or wire contract
- [ ] Durable local/cloud state
- [ ] Authentication, authorization, secret, or capability boundary
- [ ] Terminal, PTY, signal, or clipboard behavior
- [ ] Sync, filesystem, conflict, or data-loss behavior
- [ ] Packaging, dependency, CI, provenance, or distribution
- [ ] No material semantic impact (explain below)

## Platforms and compatibility

List affected Windows, macOS, Linux, Node, API, CLI, app, and SDK versions. Link
the mixed-version plan when a contract or durable state changes.

## Verification

Identify the behavior oracle, seeded negative control, exact candidate or source
revision, test environment, evidence location, and invalidation conditions.

## Recovery

State how the change is halted, rolled back, rolled forward, or otherwise
contained without losing user data or exposing secrets.

## Distribution declaration

- [ ] This pull request does not publish any package or activate any installer.
- [ ] No long-lived publication token was introduced.
- [ ] Every changed installer projection remains exact-version and digest-bound.
