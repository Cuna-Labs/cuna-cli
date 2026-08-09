# ADR-0006: Local Capability Bridge

**Status:** Accepted for preview only  
**Decision owners:** Security, CLI Runtime, Product  
**PRDs:** 002, 026, 035, 041, 042

## Decision

Local browser or MCP capabilities use an opt-in companion that establishes an
outbound-only authenticated channel to Runa. It exposes typed semantic tools,
not raw TCP, arbitrary localhost, shell, filesystem, generic CDP, cookies,
browser storage, or passwords.

Every effect requires a current grant bound to user, device, workspace,
Machine, AgentSession, tool schema, arguments, tab/origin, policy revision,
presence tier, expiry, nonce, and fencing generation. Web pages, repositories,
models, terminal output, and tool results are untrusted data. They never grant
or expand authority.

## Consequences

- Chrome integration begins disabled and preview-only.
- High-risk mutations require fresh local consent; remembered consent is
  bounded to low-risk scopes with visible expiry.
- Disconnect after dispatch yields `unknown` and postcondition reconciliation,
  not blind retry.
- Windows, macOS, and Linux companions must preserve identical policy semantics
  before the feature may leave preview.

