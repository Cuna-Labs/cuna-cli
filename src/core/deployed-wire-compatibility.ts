/**
 * Earlier-brand identifiers retained solely because a deployed producer or
 * stored credential still emits them. These are wire acceptors, never public
 * TypeScript names, local paths, environment variables, or new durable mints.
 */
export const DEPLOYED_WIRE_COMPATIBILITY = Object.freeze({
  terminalProtocol: "runa.terminal.v1",
  agentSessionAuthAdapterVersion: "runa.agent-auth.v1",
  websocketAuthPrefix: "runa.auth.",
  continuationHeader: "X-Runa-Continuation",
  credentialBrand: "runa",
  apiOrigin: "https://api.runacode.io",
} as const);
