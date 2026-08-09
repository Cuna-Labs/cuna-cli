# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
security advisory flow for `Runa-Laboratories/runa-cli`. Include the affected
version, platform, reproduction steps, expected impact, and whether credentials,
source files, terminal content, or cross-workspace boundaries may be involved.

If the private advisory flow is unavailable, contact the security address listed
on the official Runa website. Never include a live credential, API key, session
token, browser cookie, terminal transcript, or customer source file in the first
report. Runa maintainers will provide a protected evidence-transfer path when it
is required.

## Supported versions

No public Runa CLI release is declared supported by this repository yet. A
version becomes supported only after its immutable npm artifact, provenance,
SBOM, compatibility matrix, recovery evidence, and release decision are
published by the approved release workflow. Git branches, local builds, draft
releases, and packaging templates are unsupported development artifacts.

## Coordinated response

Runa will acknowledge a valid report, establish a private communication path,
preserve evidence, assess affected release identities, and coordinate a fix and
disclosure. A compromised or misissued release is never overwritten: promotion
is halted, mutable channel pointers are withdrawn or moved, and a fixed-forward
immutable release is prepared. Rollback is used only when durable-state and
protocol compatibility are proven.

## Release security invariants

- Publication is authorized only through the protected GitHub `npm`
  environment and short-lived OIDC Trusted Publishing identity.
- Long-lived npm publication tokens are prohibited.
- Every installer projection must resolve to the exact admitted npm package
  version and SHA-256 digest.
- Missing, stale, contradictory, or self-produced-only evidence blocks release.
- Repository content, terminal output, web content, and generated artifacts are
  untrusted data and cannot grant release authority.
