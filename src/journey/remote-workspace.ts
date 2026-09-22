import type { ProviderPreset } from "../api/provider-v2.js";
import {withProviderLaunchIntent} from "./provider-launch-intent.js";
import { sessionFailure } from "./session-failure.js";
import { setTimeout as delay } from "node:timers/promises";
import { requireCapability, type CunaApiClient } from "../api/client.js";
import type { AgentSession } from "../api/contracts.js";
import type { MachineDefaultWorkspace } from "../api/remote-workspace.js";
import { CunaError, EXIT_CODES } from "../core/errors.js";
import { isObservationBudgetCode, observationBudgetElapsed, REMOTE_CONVERGENCE_BUDGET_MS, REMOTE_CONVERGENCE_POLL_INTERVAL_MS } from "../core/observation-budget.js";
import { settledAgentSessionDisposition, type SettledAgentSession } from "./session-disposition.js";
import {
  reissueIdempotentRead,
  startJourneyDeadline,
  type JourneyDeadline,
  type JourneyDeadlineElapsed,
  type JourneyWaitReporter,
} from "./wait-policy.js";

/**
 * The noun phrases this path puts on screen, completing "Still waiting for ___".
 *
 * They are its own rather than the local-path journey's because the subjects
 * differ: nothing here is synchronized from a local folder, so a person reading
 * the row should not be told the CLI is waiting on a Workspace they have a copy
 * of. Each one is a state this function already distinguishes internally and,
 * before this, never said out loud — the two loops below held
 * `Preparing remote workspace · no local sync` and `Waiting for Claude
 * remotely · no local sync` unchanged for their entire duration.
 */
const WAITING_FOR = Object.freeze({
  workspaceRead: "Cuna to answer the remote Workspace read",
  publication: "the machine to publish its remote Workspace",
  sessionRead: "Cuna to answer the remote session read",
  sessionStart: "the remote session to start",
});

/** A remote-only launch never creates a local workspace binding. */
export async function launchRemoteWorkspaceSession(input: {
  readonly client: CunaApiClient;
  readonly preset: ProviderPreset;
  readonly machineId: string;
  readonly workspaceId: string;
  readonly agent: "claude-code" | "codex" | "opencode";
  readonly signal?: AbortSignal;
  readonly onProgress?: (message: string) => void;
  /** Where a declared wait goes on screen; see `journey/wait-policy.ts`. */
  readonly onWait?: JourneyWaitReporter;
  /**
   * Called once, as soon as the remote admits a session and before its
   * readiness is waited on — the moment the row exists. Measured 2026-09-22
   * (§ 2, finding (ii)): the row was created at t+11 446 ms and no line named
   * it for the rest of the run, because no such line existed.
   */
  readonly onAgentSession?: (settled: SettledAgentSession) => void;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly providerLaunchState: {stateDirectory:string;ownerId:string};
  readonly confirmNew?:()=>Promise<boolean>;
}): Promise<string> {
  requireMatchingPreset(input.agent,input.preset);
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  const signal = input.signal ?? new AbortController().signal;

  const gate = async (capabilityId: string, readOnly = false) => {
    signal.throwIfAborted();
    await requireCapability({ client: input.client, scope: "machine", resourceId: input.machineId,
      capabilityId, now, signal, allowedInteractions: readOnly ? ["read_only"] : ["native"] });
  };
  const mismatch = () => new CunaError({ code: "cuna.journey.remote_workspace_authority_mismatch",
    message: "The remote session or Workspace no longer matches the selected Machine and account.", exitCode: EXIT_CODES.conflict });
  /**
   * The refusal this path mints when a phase runs out of its own time.
   *
   * It stays `observationBudgetElapsed`, so it keeps saying the one true thing
   * about a wait the CLI ended itself: `remote_outcome: unobserved`, retryable,
   * and never a claim that the remote failed. What is new is `waiting_for` and
   * `elapsed_ms`, the two figures the screen was already showing, so a
   * transcript and an error record cannot disagree about what was waited for —
   * plus `read_reissues`, which was never on screen and says how often the CLI
   * chose to ask again. The deadline reaches the record as `budget_ms`, minted
   * below from the same `REMOTE_CONVERGENCE_BUDGET_MS`.
   */
  const timeout = (operation: string) => (elapsed: JourneyDeadlineElapsed): CunaError => observationBudgetElapsed({
    kind: "response", operation,
    budgetMs: REMOTE_CONVERGENCE_BUDGET_MS, settleWith: `cuna agent-sessions list --machine ${input.machineId}`,
    details: { waiting_for: elapsed.waitingFor, elapsed_ms: elapsed.elapsedMs, read_reissues: elapsed.readReissues },
    ...(elapsed.cause === undefined ? {} : { cause: elapsed.cause }),
  });
  /**
   * Run one idempotent read under a phase deadline, re-issuing it if the CLI's
   * own per-request budget elapses.
   *
   * WHY THIS PATH NEEDS IT TOO. Measured 2026-09-22
   * (`prds/cuna-cli-latency-before-20260922.md` § 2, run `cold1`): one
   * `GET /v1/agent-sessions/<id>` burned the 15 000 ms per-request budget and
   * ended a journey that had plenty of its own time left, for a session that
   * was healthy fifteen minutes later. That was the local-path journey, and
   * `journey/api-effects.ts` now re-issues there — but this function polls the
   * SAME idempotent route for the same reason, so without this it keeps the
   * defect the other path no longer has.
   */
  const readWithin = <T>(context: {
    readonly waitingFor: string;
    readonly deadline: JourneyDeadline;
    readonly deadlineFailure: (elapsed: JourneyDeadlineElapsed) => Error;
    readonly read: () => Promise<T>;
  }): Promise<T> => reissueIdempotentRead({
    waitingFor: context.waitingFor, read: context.read, deadline: context.deadline, signal, sleep,
    deadlineFailure: context.deadlineFailure,
    ...(input.onWait === undefined ? {} : { onWait: input.onWait }),
  });
  const reportWait = (deadline: JourneyDeadline, waitingFor: string): void => {
    input.onWait?.(Object.freeze({ waitingFor, elapsedMs: deadline.elapsedMs(), deadlineMs: deadline.deadlineMs }));
  };
  const outOfTime = (deadline: JourneyDeadline, waitingFor: string): JourneyDeadlineElapsed => Object.freeze({
    waitingFor, elapsedMs: deadline.elapsedMs(), deadlineMs: deadline.deadlineMs, readReissues: 0, cause: undefined,
  });
  // Whether this launch re-dispatched a recorded identity, reported by the
  // branch that did it rather than inferred from the answer — with no
  // `confirmNew` wired, that branch is taken without anyone being asked.
  let resumedRecordedLaunch = false;
  await gate("machines.default_workspace.read", true);
  input.onProgress?.("Preparing remote workspace · no local sync");
  const publication = startJourneyDeadline(REMOTE_CONVERGENCE_BUDGET_MS, now);
  const publicationFailure = timeout("remote Workspace publication");
  let workspace: MachineDefaultWorkspace;
  for (;;) {
    signal.throwIfAborted();
    workspace = await readWithin({
      waitingFor: WAITING_FOR.workspaceRead, deadline: publication, deadlineFailure: publicationFailure,
      read: () => input.client.getMachineDefaultWorkspace(input.machineId, signal),
    });
    if (workspace.machineId !== input.machineId || workspace.workspaceId !== input.workspaceId) throw mismatch();
    if (workspace.publicationStatus === "ready") break;
    if (workspace.publicationStatus !== "pending") throw new CunaError({
      code: "cuna.journey.remote_workspace_publication_failed", message: "The runtime could not publish this remote Workspace.",
      exitCode: EXIT_CODES.remote, details: { reason: workspace.reason ?? "unknown" } });
    if (publication.elapsed()) throw publicationFailure(outOfTime(publication, WAITING_FOR.publication));
    reportWait(publication, WAITING_FOR.publication);
    await sleep(REMOTE_CONVERGENCE_POLL_INTERVAL_MS, signal);
  }
  const agentName = input.agent === "opencode" ? "OpenCode" : input.agent === "codex" ? "Codex" : "Claude";
  input.onProgress?.(`Starting ${agentName} with the selected profile`);
  let session = await withProviderLaunchIntent({...input.providerLaunchState,workspaceId:input.workspaceId,machineId:input.machineId,executionWorkspaceId:workspace.executionWorkspaceId,...(input.confirmNew?{confirmNew:input.confirmNew}:{}),onResume:()=>{resumedRecordedLaunch=true;},intent:{executionWorkspaceId:workspace.executionWorkspaceId,generation:workspace.workspaceGeneration,cwd:workspace.remoteRoot,profileId:input.preset.profile_id,profileRevision:input.preset.profile_revision,agent:input.agent,authMode:"interactive_login"},create:operationId=>createPublishedProviderSessionV2({client:input.client,machineId:input.machineId,agent:input.agent,preset:input.preset,operationId,executionWorkspaceId:workspace.executionWorkspaceId,generation:workspace.workspaceGeneration,cwd:workspace.remoteRoot,signal})});
  const sessionId = session.id;
  const validate = (value: AgentSession) => {
    if (value.id !== sessionId || value.machineId !== input.machineId || value.agent !== input.agent ||
        value.cwd !== workspace.remoteRoot || value.authMode !== "interactive_login" ||
        value.workspaceBindingId !== undefined || value.workspaceGeneration !== undefined) throw mismatch();
  };
  validate(session);
  // Announced before readiness is waited on, and only after `validate` has
  // agreed the row is the one this launch asked for: a line naming a session
  // the CLI is about to refuse as foreign would be worse than no line.
  input.onAgentSession?.(Object.freeze({
    agentSessionId: sessionId, machineId: input.machineId,
    disposition: settledAgentSessionDisposition({ planned: "created", resumedRecordedLaunch }),
  }));
  input.onProgress?.(`Waiting for ${agentName} remotely · no local sync`);
  const admitted = startJourneyDeadline(REMOTE_CONVERGENCE_BUDGET_MS, now);
  const readinessFailure = timeout("remote session readiness");
  for (;;) {
    signal.throwIfAborted();
    session = await readWithin({
      waitingFor: WAITING_FOR.sessionRead, deadline: admitted, deadlineFailure: readinessFailure,
      read: () => input.client.getAgentSession(sessionId, signal),
    });
    validate(session);
    if (session.requestState === "failed" || ["exited", "failed", "terminated"].includes(session.processState)) {
      throw sessionFailure(session, "The remote session ended before attachment.");
    }
    if (session.processState === "ready" || session.processState === "running") return sessionId;
    if (admitted.elapsed()) throw readinessFailure(outOfTime(admitted, WAITING_FOR.sessionStart));
    reportWait(admitted, WAITING_FOR.sessionStart);
    await sleep(REMOTE_CONVERGENCE_POLL_INTERVAL_MS, signal);
  }
}

/** Shared canonical admission for already published remote or synchronized Workspaces. */
export async function createPublishedProviderSessionV2(input:{client:CunaApiClient;machineId:string;agent:"opencode"|"codex"|"claude-code";preset:ProviderPreset;operationId:string;executionWorkspaceId:string;generation:number;cwd:string;signal:AbortSignal}):Promise<AgentSession>{
 requireMatchingPreset(input.agent,input.preset);
 const request={agent:input.agent,operation_id:input.operationId,cwd:input.cwd,execution_workspace_id:input.executionWorkspaceId,workspace_generation:input.generation,profile_id:input.preset.profile_id,profile_revision:input.preset.profile_revision};
 const create=async()=>(await input.client.createProviderSessionV2(input.machineId,request,input.signal)).agentSession;
 let session:AgentSession;
 try{session=await create();}catch(error){if(!(error instanceof CunaError)||!(isObservationBudgetCode(error.code)||error.code==='cuna.network.failed')||input.signal.aborted)throw error;session=await create();}
 if(session.machineId!==input.machineId||session.agent!==input.agent||session.cwd!==input.cwd||session.authMode!=='interactive_login'||session.workspaceBindingId!==undefined||session.workspaceGeneration!==undefined)throw new CunaError({code:'cuna.journey.agent_session_create_authority_mismatch',message:'The admitted session does not match the selected published Workspace.',exitCode:EXIT_CODES.conflict});
 return session;
}

export function requireMatchingPreset(agent:string,preset:ProviderPreset):void {
 if(preset.agent!==agent || (agent==='opencode' ? preset.kind!=='provider_preset' : preset.kind!=='native_interactive'))throw new CunaError({code:'cuna.provider.profile_agent_mismatch',message:'Select a profile for the requested agent.',exitCode:EXIT_CODES.usage});
}
