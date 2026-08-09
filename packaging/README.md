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

## Release envelope and distribution manifest

`release-envelope.schema.json` defines the immutable handoff. A release envelope
binds package name and version, source commit, npm registry and tarball URL,
tarball digest, SBOM digest, support policy digest, and build identity. Projection
generation fails unless all fields are exact and every referenced digest
matches bytes on disk.

`distribution-manifest.schema.json` is the separate projection boundary. It
binds the release-envelope digest, canonical tarball, CycloneDX SBOM, support
policy, platform claim, exact immutable command, generated projection digest,
publisher requirements, and recovery truth for every approved channel. A local
manifest is deliberately `BLOCKED` and every channel is
`PROJECTED_NOT_PUBLISHED`; generation cannot assert that an external channel is
live.

Generate and verify a projection bundle without publishing it:

```bash
node scripts/release-project-distributions.mjs \
  --root . \
  --evidence release-artifacts \
  --output release-artifacts/distributions
node scripts/verify-release-distributions.mjs \
  --root . \
  --evidence release-artifacts \
  --distributions release-artifacts/distributions
```

The generated bundle contains five independently hashed surfaces:

- `npm/install-command.txt` for the canonical registry package;
- `bun/install-command.txt` for Bun's exact-version view of that package;
- `curl/install.sh`, which downloads the exact npm tarball, verifies SHA-256,
  stages it without lifecycle scripts, runs the offline self-test, and compares
  staged/active runtime identity;
- `homebrew/runa.rb`, digest-pinned to the same npm tarball;
- `aur/PKGBUILD`, digest-pinned, offline after source acquisition, and free of
  lifecycle scripts.

The release workflow generates projections from the admitted envelope into an
ephemeral artifact. Templates intentionally contain `@@...@@` markers and are
not executable release installers. Generated files are admitted only after:

1. the candidate tarball and SBOM match their envelope digests;
2. no template marker remains;
3. each projection pins the exact version and SHA-256 digest;
4. projection verification rejects a substituted tarball;
5. installed-artifact self-tests pass on the declared platform matrix.

`distribution-receipt.schema.json` defines the later external evidence needed
to prove an installed channel. The verifier requires eleven fresh receipts:
npm and Bun on Linux/macOS/Windows x64, curl and Homebrew on Linux/macOS x64,
and AUR/paru on Linux x64. Each receipt binds raw install, self-test, version,
provenance, uninstall, and recovery evidence by digest. All observed installed
build digests and protocol ranges must converge.

```bash
node scripts/verify-distribution-receipts.mjs \
  --root . \
  --evidence release-artifacts \
  --distributions release-artifacts/distributions \
  --receipts evidence/distribution-receipts
```

Even a passing distribution-receipt gate reports the overall release as
`BLOCKED`; approval leases, recovery state, cohort telemetry, and the other
The complete release workflow and its authorization receipts remain separate mandatory evidence.

## Local artifact evidence

The current workstation can prove packaging behavior without impersonating a
release builder or publisher:

```bash
npm run build
node scripts/release-local-artifact-evidence.mjs \
  --root . \
  --output evidence/local-distribution
node scripts/verify-local-distribution-evidence.mjs \
  --root evidence/local-distribution
```

This packs the actual current npm payload with lifecycle scripts disabled,
generates and semantically validates its CycloneDX SBOM, installs into an
isolated prefix, and captures the network-free self-test and runtime identity.
The resulting record is permanently `LOCAL_NON_RELEASE_EVIDENCE` and
`releaseEligible: false`; it cannot satisfy Trusted Publisher, registry,
cross-platform, rollback, or rollout gates.

## Publication boundary

Projection scripts never publish. Publication is possible only from the
protected GitHub release workflow, using the `npm` environment and short-lived
OIDC Trusted Publishing. The curl endpoint, Homebrew tap, and AUR repository are
separate external systems and require explicit configuration and runtime
evidence before any channel may be called live.

`.github/workflows/distribution-projection-proof.yml` is a read-only manual
projection proof. It accepts only a successful protected-main candidate run,
verifies the exact candidate digest and GitHub attestation, generates the
projection bundle, parses the shell/Ruby/PKGBUILD outputs, and uploads evidence.
It has no package-publish or repository-write permission.
