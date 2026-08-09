# External release-authority setup

This repository contains policy and workflow scaffolding. It does not prove that
the GitHub repository, npm package, Trusted Publisher, installer endpoint,
Homebrew tap, or AUR package exists or is correctly configured. Each item below
requires independent external evidence before release.

## GitHub repository

- Public repository `Runa-Laboratories/runa-cli` was created without generated
  initial files on 2026-08-08; its first protected branch still awaits the
  initial reviewed push.
- `CODEOWNERS` currently names the verified repository administrator directly;
  replace it with least-privilege organization teams when those teams exist.
- Protect `main`: no force push or deletion; administrators included; require
  linear history; require conversation resolution and the exact current checks
  `repository-governance`, `source-quality-gates`, `release-admission`,
  `codeql-javascript-typescript`, and `dependency-review`.
- Enable private vulnerability reporting, secret scanning, push protection,
  Dependabot alerts, dependency graph, CodeQL default/code scanning, and signed
  commit/tag policy selected by the release authority.
- Create protected environments `release-evidence` and `npm`. The `npm`
  environment must require independent release/security reviewers and allow
  deployment only from protected `main`.
- Verify that all GitHub Actions remain full-commit pinned when Dependabot
  proposes updates.

## npm

- Verify ownership and mandatory 2FA for the `runa_laboratories` organization
  and the exact package name `@runa_laboratories/cli`.
- Configure npm Trusted Publishing for repository
  `Runa-Laboratories/runa-cli`, workflow `.github/workflows/release.yml`, and
  GitHub environment `npm`.
- Do not create `NPM_TOKEN` or `NODE_AUTH_TOKEN` repository/environment secrets.
- Perform the first immutable publication only from the protected workflow. The
  workflow currently publishes to the `preview` dist-tag; it does not promote
  `latest` or claim GA.
- Recover the published tarball and provenance from npm and prove its SHA-256
  equals the admitted release envelope before any further channel projection.

## Projection channels

- The official curl route must be deployed on Runa-controlled infrastructure
  with TLS, immutable release-envelope input, cache/revocation behavior, and
  runtime probes. Source templates do not prove `https://runacode.io/install`
  is live.
- Create and protect `Runa-Laboratories/homebrew-tap`; generate each formula
  from the admitted envelope and test both clean install and uninstall.
- Establish the AUR maintainer account/package for `runa-cli-bin`; generate the
  PKGBUILD from the admitted envelope and test in a clean supported Arch
  environment. The build must remain offline after source acquisition.
- Bun is not a publisher. Test `bun add --global` against the same exact npm
  version and compare `runa version --json` with the npm-installed identity.

## Pre-GA evidence

- Enroll or procure policy-approved real-platform runners for Windows 11 x64,
  interactive macOS, and interactive Linux terminal behavior. Hosted CI runner
  success alone cannot prove clipboard, PTY, credential-vault, tmux/SSH, or
  local-browser behavior.
- Define quantitative release observation and halt thresholds from baseline
  evidence. Until those values exist, promotion beyond internal/preview is
  blocked by PRD-030.
- Complete the offline threshold-root/recovery ceremony if a standalone updater
  is later accepted. npm Trusted Publishing is not that update root.
- Rehearse revocation, dist-tag containment, fixed-forward publication, durable
  state compatibility, and diagnostic/support response with named owners.
- Capture content-addressed receipts for npm, Bun, curl, Homebrew, and AUR
  installed identities. Missing telemetry or a digest mismatch is a blocker,
  never a warning.
