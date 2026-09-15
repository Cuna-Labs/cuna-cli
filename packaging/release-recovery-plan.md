# Cuna CLI npm preview release — recovery plan

This file is digested into every release-approval lease as `recovery.planSha256`.
A lease cannot be minted without naming a recovery plan by digest, so changing
this document changes the lease and invalidates any lease minted against the
previous text. That is intentional: an approval is an approval of a specific
recovery posture, not of a publication in the abstract.

Bound strategy: `dist-tag-recovery-and-fixed-forward`.

## What the publication actually does

`.github/workflows/release.yml` publishes exactly the admitted tarball bytes to
`https://registry.npmjs.org` under the `preview` dist-tag, via npm OIDC trusted
publishing. It never sets `latest`. A consumer therefore reaches a published
preview only by asking for `@cuna_labs/cli@preview` or an exact version; a bare
`npm install @cuna_labs/cli` does not resolve to it.

## Recovery, in order of preference

1. **Move the tag.** The blast radius of a bad preview is the set of consumers
   who asked for `@preview`. Point it at a known-good version:
   `npm dist-tag add @cuna_labs/cli@<good-version> preview`.
   This is the primary path, is reversible, and does not mutate any published
   version's bytes.

2. **Remove the tag.** If no good version exists — the first publish is the bad
   one — remove the tag rather than leave it pointing at a defect:
   `npm dist-tag rm @cuna_labs/cli preview`.
   Consumers on `@preview` then fail to resolve, which is the correct outcome:
   a resolution failure is recoverable, a silently installed bad build is not.

3. **Fix forward.** Land the repair on protected `main`, let CI produce a new
   immutable candidate, take a new approval, publish the next version and move
   `preview` to it. Every published version stays published.

## What recovery does not include

- **No unpublish as a routine step.** npm permits unpublishing a version within
  72 hours, but doing so deletes bytes that a consumer's lockfile may already
  reference by integrity digest, converting a bad install into an unresolvable
  one for everybody who pinned it. Unpublish is reserved for a disclosed secret
  or a licence violation in the published bytes, and it is an owner decision
  taken deliberately, not a rollback button.

- **No version reuse.** npm refuses to republish a version number that has ever
  existed. Recovery always moves forward in version space.

- **No silent retry.** If a publication's outcome is unknown — the workflow died
  between `npm publish` and `scripts/verify-postpublish.mjs` — the state is
  reconciled by reading the registry, never by publishing again. The approval
  nonce is single-use precisely so that an uncertain publication cannot be
  blindly replayed under the same authorization.

## Preconditions this plan assumes

- The `preview` dist-tag is the only tag this pipeline writes.
- `scripts/verify-registry-version-absent.mjs` has confirmed the exact version
  is absent immediately before publication, so a publication never overwrites.
- `scripts/verify-postpublish.mjs` re-downloads the published bytes and compares
  their SHA-256 against the admitted candidate, so "published" is established by
  reading the registry back rather than by the publish command's exit code.
