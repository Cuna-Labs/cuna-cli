import type { AgentSession } from "../api/contracts.js";
import { isTerminalReason, type TerminalReason } from "../api/terminal-reason.js";
import { CunaError, EXIT_CODES } from "../core/errors.js";

const MESSAGES: Record<TerminalReason, string> = {
  process_exited: "The agent process exited before attachment.",
  process_not_observed: "The runtime could not observe the previous agent process. Its exit cause is unknown.",
  owner_unrecoverable: "The runtime could not recover this session's terminal owner.",
  opencode_server_exited: "The OpenCode server exited before attachment.",
  terminal_model_terminated_unobserved: "The terminal process ended without an observed exit status.",
  session_executable_allowlist: "The runtime refused an agent executable outside its allowlist.",
  session_executable_unavailable: "The agent executable is unavailable on this Machine.",
  session_executable_permissions: "The runtime refused the agent executable's permissions.",
  session_executable_owner: "The runtime refused the agent executable's ownership.",
  session_executable_location: "The runtime refused the agent executable's location.",
  session_capacity_memory: "The Machine does not have enough free memory to start this agent.",
  canonical_launch_interrupted: "The runtime could not complete the agent launch.",
  machine_restarted: "The Machine restarted before this session could be recovered.",
};

export function sessionFailure(session: AgentSession, fallback: string): CunaError {
  const reason = ["exited", "failed", "terminated"].includes(session.processState)
    && isTerminalReason(session.terminalReason) ? session.terminalReason : undefined;
  return new CunaError({
    code: "cuna.journey.agent_session_failed",
    message: reason === undefined ? fallback : MESSAGES[reason],
    exitCode: EXIT_CODES.remote,
    hint: `Inspect the existing session before starting another: cuna agent-sessions get ${session.id}`,
    details: { agent_session_id: session.id, ...(reason === undefined ? {} : { reason }) },
  });
}

/** The readiness reasons that are not also terminal reasons (migration 0233). */
const READINESS_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  deadline_unattested: "Cuna's startup deadline passed and no supervisor attested this session's process.",
  runtime_ended_unattested: "The session process ended before Cuna could attest it.",
  request_settled_unattested: "The session request settled before Cuna could attest its process.",
  workspace_materialization_failed: "The runtime could not prepare this Workspace.",
  cancelled_before_dispatch: "The launch was cancelled before it reached the Machine.",
});

/**
 * The failure the SERVER has already settled on, if it has settled on one.
 *
 * Measured 2026-09-29 (CLI 8df1553, Edge v240): the server settled session
 * a84513bb as `reconciliation_required / deadline_unattested` at +141 s and the
 * CLI kept printing a bare countdown for 60 s more, then exited with its own
 * timeout. A wait loop that reads a session calls this on every read, so the
 * server's verdict ends the wait on the first read that carries it.
 *
 * `reconciliation_required` never says the process is gone: the producer keeps
 * the child and its identity, and a late attestation can still promote it. So
 * the message says nothing was ended, and the next step reads before it ends.
 */
export function readinessFailure(session: AgentSession): CunaError | undefined {
  const readiness = session.readiness;
  if (readiness?.reason === undefined) return undefined;
  const refused = readiness.outcome === "refused";
  const reason = readiness.reason;
  const known = isTerminalReason(reason) ? MESSAGES[reason] : READINESS_MESSAGES[reason];
  const message = known ?? (refused
    ? "Cuna refused to start this session."
    : "Cuna could not attest that this session started.");
  const inspect = `cuna agent-sessions get ${session.id}`;
  return new CunaError({
    code: refused
      ? "cuna.journey.agent_session_readiness_refused"
      : "cuna.journey.agent_session_readiness_reconciliation_required",
    message: refused ? message : `${message} The process may still be running; nothing was ended.`,
    exitCode: EXIT_CODES.remote,
    retryable: false,
    hint: refused
      ? reason === "session_capacity_memory"
        ? `End an AgentSession you no longer need on this Machine, then run the same command again. Inspect this one: ${inspect}`
        : `Inspect it before starting another: ${inspect}`
      : `Inspect it: ${inspect}. To end it before starting another: cuna agent-sessions terminate ${session.id} --yes`,
    details: {
      agent_session_id: session.id,
      readiness_outcome: readiness.outcome,
      readiness_reason: reason,
      readiness_deadline_at: readiness.deadlineAt,
      ...(readiness.settledAt === undefined ? {} : { readiness_settled_at: readiness.settledAt }),
    },
  });
}

/**
 * What the server says is holding a session up, as a clause for the wait line,
 * or `undefined` when it says nothing. Built only from positive facts: an
 * absent `runtimeEvidence` is not "no report", because a server older than the
 * opt-in answers without it.
 *
 * `launch_pending` becomes `runtime_claimed` only when a supervisor claims the
 * dispatch (migrations 0059, 0092), so it is the one row-level trace of a
 * Machine whose supervisor is not taking work. It is not the stronger claim
 * "the supervisor is disconnected": no public read carries that (Edge v240).
 */
export function supervisorWaitCause(session: AgentSession): string | undefined {
  if (session.requestState === "launch_pending") return "no supervisor has claimed the launch";
  if (session.requestState === "runtime_claimed") return "launch claimed, no process report yet";
  const evidence = session.runtimeEvidence;
  return evidence === undefined ? undefined : `last supervisor report ${evidence.ageSeconds}s ago`;
}
