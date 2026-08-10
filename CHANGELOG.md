# Changelog

All notable changes to this project will be documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Every error code the CLI emits now uses the `cuna.*` namespace instead of
  `runa.*`, in both `--json` records (`error.code`) and human output
  (`Error [code]: …`). Nothing is published yet, so no released consumer is
  affected. Wire protocol identifiers the service mints and compares
  (`runa.terminal.v1`, `runa.agent-auth.v1`, the `runa.auth.<token>` WebSocket
  subprotocol) are unchanged, as are the OS credential-vault target namespace
  and refresh-token binding digest.
- `RunaError` is renamed to `CunaError`. `RunaError` remains exported as a
  deprecated alias and will be removed after the first published release.
- Project exclusions are now read from `.cunaignore`; `.runaignore` is still
  honoured as a fallback so existing workspaces keep excluding the same paths.

### Added

- Established the initial public CLI architecture and release controls.
- Initial fail-closed TypeScript CLI, public API client, cross-platform adapters,
  offline installed-artifact identity, and release-admission scaffolding.

### Security

- Exact Cuna API-origin validation, bounded responses, redacted errors,
  capability-gated mutations, SHA-pinned GitHub Actions, and OIDC-only preview
  publication.

[Unreleased]: https://github.com/Cuna-Labs/cuna-cli/commits/main
