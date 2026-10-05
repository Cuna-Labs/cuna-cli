import { CunaError } from "../core/errors.js";

/**
 * The server's refusals of an AgentSession create that are final for the
 * request that received them, keyed by the Problem `code` the server sent.
 *
 * Each is emitted by the create routes BEFORE any session intent is written,
 * with `retryable: false`, so repeating the request unchanged repeats the
 * answer (infra a6e6f8c: `edge/src/supervisor-control-admission.ts` for the
 * three supervisor codes, `edge/src/api.ts` for the rest). Classification is by
 * code and the server's own `retryable`, never by HTTP status: a 409 also
 * carries `provider_session_v2_*`, whose detail says creation "could not be
 * confirmed", and `agent_session_agent_preparing`, which is retryable.
 *
 * Deliberately NOT here, each for its own reason:
 *   agent_session_memory_capacity      its own typed error, identity preserved
 *   agent_session_agent_preparing      retryable; the install wait owns it
 *   agent_session_machine_not_running  retryable
 *   provider_session_v2_*              the server says the outcome is unconfirmed
 *   agent_session_authority_unavailable, agent_session_agent_readiness_unavailable
 *                                      503, retryable
 *
 * Measured live 2026-09-30 on Edge v241 (C4.8), Machine cd0696a7: the journey
 * wrapped `machine_supervisor_control_expired` as
 * `agent_session_create_outcome_unreconcilable`, exit 7, "Retry recovery with
 * the original journey identity", for a refusal the server had made final.
 */
export const DEFINITIVE_CREATE_REFUSALS: ReadonlySet<string> = new Set([
  "machine_supervisor_control_expired",
  "machine_supervisor_control_revoked",
  "machine_supervisor_control_absent",
  "agent_session_provider_unavailable",
  "agent_session_agent_unsupported",
  "agent_session_machine_not_found",
]);

/**
 * True for a server answer in `DEFINITIVE_CREATE_REFUSALS` that the server
 * did not mark retryable. `http_status` is required so a locally minted error
 * that happens to carry the same reason cannot pass as the server's word.
 */
export function isDefinitiveCreateRefusal(error: unknown): error is CunaError {
  return error instanceof CunaError && !error.retryable &&
    typeof error.details?.http_status === "number" &&
    typeof error.details.reason === "string" && DEFINITIVE_CREATE_REFUSALS.has(error.details.reason);
}

/**
 * The same refusal, received by a re-sent launch identity. It is still the
 * server's final word on THIS request, but not on the earlier one: an Edge
 * that checks the refusal before idempotent replay (C4.8) hides a create that
 * did commit. So the refusal keeps its words and exit code and adds where to
 * look.
 *
 *   `unanswered`  the earlier attempt of this identity got no answer.
 *   `recorded`    this folder's recorded launch, which did start a session.
 */
export function replayedLaunchRefusal(
  error: CunaError,
  machineId: string,
  earlier: "unanswered" | "recorded",
): CunaError {
  if (error.details?.replayed_launch === true) return error;
  const list = `\`cuna agent-sessions list --machine ${machineId}\``;
  const look = earlier === "unanswered"
    ? `An earlier attempt of this launch got no answer and may have started a session; ${list} shows it.`
    : `The session this folder launched before may still be running; ${list} shows it.`;
  return new CunaError({
    code: error.code,
    message: error.message,
    exitCode: error.exitCode,
    retryable: error.retryable,
    hint: error.hint === undefined ? look : `${error.hint} ${look}`,
    details: { ...error.details, replayed_launch: true },
    cause: error,
  });
}
