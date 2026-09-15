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
