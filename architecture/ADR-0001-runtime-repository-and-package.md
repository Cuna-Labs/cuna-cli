# ADR-0001: Runtime, Repository, and Package

**Status:** Accepted  
**Decision owners:** CLI Architecture, Release Engineering  
**PRDs:** 003, 027, 028, 029, 043

## Decision

Runa CLI is an independent public repository and npm package written in
TypeScript ESM for Node.js 22 or newer. The canonical package is
`@runa_laboratories/cli`, installed with:

```text
npm install -g @runa_laboratories/cli
```

npm is the publication authority. Bun consumes the same registry package.
curl, Homebrew, and paru/AUR are digest-pinned projections of the same admitted
release, not independent builds. The CLI may bundle approved runtime code to
reduce production dependencies, but the SBOM and NOTICE must describe every
embedded component.

## Consequences

- Node 22/24 installed-artifact tests run on Windows, macOS, and Linux.
- No workstation publication and no long-lived npm publishing token.
- Trusted Publisher, protected GitHub environment, provenance, registry
  recovery, and post-publication tarball verification are release gates.
- Standalone native binaries require a superseding distribution envelope.

## Falsifier

This ADR is superseded if the terminal/daemon requirements cannot meet the
supported performance and reliability budgets on the declared Node envelope.

