# Distribution projections

npm is the canonical first-GA publication for Runa CLI. Every other surface in
this directory is a projection of the exact admitted npm tarball; no projection
may rebuild, patch, re-bundle, or independently version the CLI.

## Channel status

| Surface | Intended command | Current repository status |
| --- | --- | --- |
| npm | `npm install -g @runa_laboratories/cli` | Workflow scaffold only; no live package is asserted. |
| Bun | `bun add --global @runa_laboratories/cli` | Compatibility projection; no independent publication. |
| curl | `curl -fsSL https://runacode.io/install \| sh` | Release-bound template only; endpoint availability is not asserted. |
| Homebrew | `brew install Runa-Laboratories/tap/runa` | Formula template only; tap availability is not asserted. |
| paru/AUR | `paru -S runa-cli-bin` | PKGBUILD template only; AUR package availability is not asserted. |

## Release envelope

`release-envelope.schema.json` defines the immutable handoff. A release envelope
binds package name and version, source commit, npm registry and tarball URL,
tarball digest, SBOM digest, support policy digest, and build identity. Projection
generation fails unless all fields are exact and every referenced digest
matches bytes on disk.

The release workflow generates projections from the admitted envelope into an
ephemeral artifact. Templates intentionally contain `@@...@@` markers and are
not executable release installers. Generated files are admitted only after:

1. the candidate tarball and SBOM match their envelope digests;
2. no template marker remains;
3. each projection pins the exact version and SHA-256 digest;
4. projection verification rejects a substituted tarball;
5. installed-artifact self-tests pass on the declared platform matrix.

## Publication boundary

Projection scripts never publish. Publication is possible only from the
protected GitHub release workflow, using the `npm` environment and short-lived
OIDC Trusted Publishing. The curl endpoint, Homebrew tap, and AUR repository are
separate external systems and require explicit configuration and runtime
evidence before any channel may be called live.
