/**
 * Earlier-brand identifiers retained solely because a deployed producer or
 * stored credential still emits them, or because the earlier CLI published the
 * configuration name. These are compatibility acceptors, never new durable
 * mints, public TypeScript names, or local paths.
 */
export const DEPLOYED_WIRE_COMPATIBILITY = Object.freeze({
  terminalProtocol: "runa.terminal.v1",
  agentSessionAuthAdapterVersion: "runa.agent-auth.v1",
  websocketAuthPrefix: "runa.auth.",
  continuationHeader: "X-Runa-Continuation",
  credentialBrand: "runa",
  apiOrigin: "https://api.runacode.io",
  apiKeyEnvironment: "RUNA_API_KEY",
} as const);
