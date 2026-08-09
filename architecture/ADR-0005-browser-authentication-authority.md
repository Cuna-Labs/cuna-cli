# ADR-0005: Browser Authentication Authority

**Status:** Accepted  
**Decision owners:** Identity, Website, CLI Security  
**PRDs:** 005, 036

## Decision

The official Runa website and identity service own signup, invitation,
verification, waitlist, onboarding, workspace admission, and browser consent.
The CLI starts a one-use PKCE-bound continuation and opens the exact official
HTTPS URL. Browser cookies and provider credentials never enter the CLI.

The browser success page is not an authorization oracle. The CLI resumes only
after exchanging the one-use result and independently verifying current account,
workspace, eligibility, membership revision, requested continuation, and server
session state. Headless operation uses an explicit bounded device flow when the
server advertises support; otherwise it returns unsupported.

## Consequences

- A different browser account, replay, wrong verifier, expired transaction,
  changed membership, or waitlist state cannot resume a mutation.
- Authentication, product admission, workspace assignment, and onboarding are
  separate state machines.
- Logout reports local deletion and server revocation separately; partial
  revocation is never rendered as success.

