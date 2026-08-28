import type { AgentSession } from "../api/contracts.js";

const MAX_FUTURE_SKEW_MS = 5_000;

/**
 * A still-running process is not an active session once termination has been
 * requested. The machine overview is an operational view, not session history.
 */
export function isAgentSessionIntendedActive(session: AgentSession): boolean {
  return session.desiredState === "running" && session.requestState !== "termination_pending";
}

export function isAgentSessionRunningNow(session: AgentSession, now: number): boolean {
  if (!isAgentSessionIntendedActive(session) || session.processState !== "running") return false;
  if (session.runtimeObservedAt === undefined || session.runtimeExpiresAt === undefined) return false;
  const observedAt = Date.parse(session.runtimeObservedAt);
  const expiresAt = Date.parse(session.runtimeExpiresAt);
  return Number.isFinite(observedAt) && Number.isFinite(expiresAt) &&
    observedAt <= now + MAX_FUTURE_SKEW_MS &&
    expiresAt > observedAt &&
    expiresAt > now;
}
