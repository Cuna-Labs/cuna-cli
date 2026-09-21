import { randomUUID } from "node:crypto";

import {
  requireCapability,
  type MachineCreateInput,
  type CunaApiClient,
} from "../api/client.js";
import { ARTIFACT_CHANNEL, packageBuildDigest, PROTOCOL_RANGE } from "../build-identity.js";
import type {
  AgentAuthMode,
  AgentKind,
  AgentSession,
  ApiKeyMetadata,
  CapabilitySnapshot,
  Machine,
} from "../api/contracts.js";
import type { EffectiveConfig } from "../config/config.js";
import { DEFAULT_BASE_URL, environmentCredentialState, publicConfig } from "../config/config.js";
import { EXIT_CODES, CunaError, unsupportedError, usageError, type SafeErrorDetails } from "../core/errors.js";
import {
  REMOTE_CONVERGENCE_BUDGET_MS,
  REMOTE_CONVERGENCE_POLL_INTERVAL_MS,
  observationBudgetElapsed,
} from "../core/observation-budget.js";
import { OFF_CONTRACT_RESPONSE_HINT, SUPPORT_URL, automationCredentialHint } from "../core/product-web.js";
import {
  assertCanonicalUuid,
  assertIdempotencyKey,
  assertMachineId,
  assertPublicId,
  assertSafeDisplayText,
  ContractViolation,
  integerArgument,
} from "../core/validation.js";
import { preflightAgentJourneyInvocation } from "../journey/intent.js";
import type { ManagedExecution } from "../api/managed-executions.js";
import { listAllMachines } from "../machines/pagination.js";
import {
  classifyLiveSupervisorUpdateFailure,
  liveSupervisorInstallationEvidenceLabel,
  liveSupervisorInstallerOutcomeLabel,
  liveSupervisorInstallerReachLines,
  liveSupervisorSessionOutcomeLabel,
  liveSupervisorUpdateNotes,
  liveSupervisorUpdatePhaseLabel,
  liveSupervisorUpdateRecordSurvives,
  readLiveSupervisorUpdateOperation,
  summarizeLiveSupervisorUpdate,
  type LiveSupervisorUpdateIdentityOrigin,
  type LiveSupervisorUpdateNotes,
  type LiveSupervisorUpdateReading,
} from "../machines/live-supervisor-update.js";
import type {
  SupervisorLiveUpdate,
  SupervisorLiveUpdateOperation,
} from "../api/supervisor-live-update.js";
import type { PlatformAdapter } from "../platform/adapter.js";
import {
  isOpenCodeRuntimeUnverifiedCapabilityRejection,
  isOpenCodeSupervisorRepairCapabilityRejection,
  isOpenCodeSupervisorUpgradeCapabilityRejection,
  openCodeRuntimeUnverified,
  openCodeSupervisorUpgradeRequired,
} from "../machines/opencode-supervisor.js";
import {
  machineProviderAvailability,
  machineSupportsProvider,
  providerDisplayName,
  providerVerdict,
} from "../machines/provider-availability.js";
import { classifySessionActionability, displaySessionActionability } from "../machines/session-actionability.js";
import {
  agentSessionProcessObservation,
  AGENT_SESSION_OBSERVATION_NOTE,
  isAgentSessionIntendedActive,
} from "../machines/session-visibility.js";
import { loadWorkspaceBindingIntent } from "../workspace/binding-store.js";
import { INITIAL_RUNTIME_GATES, type RuntimeFeatureGate } from "../runtime/contracts.js";
import { evaluateRuntimeSupport } from "../platform/support.js";
import { CLI_VERSION } from "../version.js";
import {
  assertRegisteredCliRoute,
  booleanOption,
  rejectUnknownOptions,
  stringOption,
  type ParsedInvocation,
} from "../cli/parser.js";

export interface CommandResult {
  readonly command: string;
  readonly data: unknown;
  readonly human: string;
}

/**
 * The clock a bounded read-back runs on.
 *
 * WHY IT IS ONE SEAM AND NOT SEVERAL. The API accepts a durable intent before an
 * independent producer can publish the matching observation — that is true of an
 * AgentSession termination, and it is equally true of a machine deletion and of
 * every machine lifecycle transition. This used to be
 * `AgentSessionTerminationPoller`, wired into exactly one command, while the
 * three others read back ONCE, immediately, and called the answer a failed
 * postcondition. Measured 2026-08-19: a deleted machine was still `present` on
 * that immediate read and gone from `cuna machines list` six seconds later.
 */
export interface ConvergencePoller {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export interface CommandContext {
  readonly parsed: ParsedInvocation;
  readonly config: EffectiveConfig;
  readonly client: CunaApiClient;
  readonly now: number;
  /** Sampled by capability admission only after its HTTP response arrives. */
  readonly capabilityClock?: () => number;
  /** Test seam; production uses the real wall-clock wait below. */
  readonly convergencePoller?: ConvergencePoller;
  /**
   * Where to start looking for `.cuna/workspace.json`. Production passes the
   * process's working directory; tests pass a scratch folder, so no test can
   * accidentally read the developer's own binding.
   */
  readonly workspaceRoot?: string;
  readonly credentialMode?: "automation" | "interactive";
  readonly runtimeFeatures?: readonly RuntimeFeatureGate[];
  /**
   * Where `machines live-update-supervisor` keeps its local note about an
   * update whose outcome it never saw. Optional so every existing caller and
   * test is unchanged; the command refuses rather than proceeding without it,
   * because dispatching a mutation it cannot record is the one thing the
   * requirement forbids.
   */
  readonly platform?: PlatformAdapter;
}

function productionConvergencePoller(): ConvergencePoller {
  return Object.freeze({
    now: () => Date.now(),
    sleep: (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  });
}

interface ConvergenceProbe<T> {
  /** True once the observation satisfies the postcondition. */
  readonly settled: boolean;
  readonly observation: T;
  /** What to report if the budget elapses first. Never a secret. */
  readonly details: SafeErrorDetails;
}

/**
 * Read back until an accepted mutation is visible, or until OUR budget elapses.
 *
 * D2, and the whole difference between the two answers this fixes. A single
 * immediate read cannot distinguish "the change did not happen" from "the change
 * has not arrived yet", and the CLI was reporting the first for the second with
 * `retryable: false` — telling the user not to retry AND implying the mutation
 * had not landed, both false, for a deletion that had already succeeded.
 *
 * On elapse this raises the budget refusal from `core/observation-budget.ts`,
 * which is retryable and names the read-only command that settles it. It is NOT
 * `postcondition_unverified`: that code is reserved for an observation that
 * CONTRADICTS the write and that no amount of waiting repairs.
 */
async function convergeOnRemoteState<T>(
  context: CommandContext,
  input: {
    readonly operation: string;
    readonly settleWith: string;
    readonly probe: () => Promise<ConvergenceProbe<T>>;
  },
): Promise<T> {
  const poller = context.convergencePoller ?? productionConvergencePoller();
  const deadline = poller.now() + REMOTE_CONVERGENCE_BUDGET_MS;
  let probe = await input.probe();
  while (!probe.settled) {
    const remaining = deadline - poller.now();
    if (remaining <= 0) {
      throw observationBudgetElapsed({
        kind: "convergence",
        operation: input.operation,
        settleWith: input.settleWith,
        budgetMs: REMOTE_CONVERGENCE_BUDGET_MS,
        details: probe.details,
      });
    }
    await poller.sleep(Math.min(REMOTE_CONVERGENCE_POLL_INTERVAL_MS, remaining));
    probe = await input.probe();
  }
  return probe.observation;
}

/**
 * The process states in which the child is no longer running. The producer
 * chooses among all three: a signalled exit, an exit of the process's own
 * accord, and an ending it could not classify.
 */
const AGENT_SESSION_ENDED_PROCESS_STATES: ReadonlySet<AgentSession["processState"]> =
  new Set(["terminated", "exited", "failed"]);

/**
 * Whether a termination has actually landed.
 *
 * Matching one value of a vocabulary the producer chooses from cannot settle:
 * any ended process state satisfies this. The conjunction over the other two
 * fields stays, so a process that merely died on its own is not read as a
 * completed termination.
 */
function agentSessionTerminationConfirmed(session: AgentSession): boolean {
  return session.desiredState === "terminated" &&
    session.requestState === "terminal" &&
    AGENT_SESSION_ENDED_PROCESS_STATES.has(session.processState);
}

/**
 * An AgentSession carries three states and this CLI's own invariants are
 * conjunctions of all three — see `agentSessionTerminationConfirmed` above, and
 * the termination timeout, which reports all three because one is not enough to
 * explain anything.
 *
 * The human rendering used to print `processState` alone, so a session that was
 * `terminated / termination_pending / running` displayed as plain `running`:
 * exactly the disagreement a person needs to see, replaced by the one word that
 * hides it. Settled sessions still show a single word, because a triple on every
 * healthy row is noise; anything unsettled shows all three, in the fixed order
 * desired/request/process.
 *
 * The provenance of `processState` is the second thing this line hid. Every
 * authority above is a CLAIM, and the producer publishes who established the
 * process one; a row whose runtime lease kept moving while nothing observed the
 * child printed the byte-identical line to a row a supervisor had just looked
 * at. So whenever the state asserts a live process, the note from
 * `session-visibility.ts` is printed beside it — `observed` adds nothing, which
 * is why it has no note. It qualifies the state and never replaces it: a
 * confirmed termination returns above this and can never acquire one.
 */
function agentSessionStateLabel(session: AgentSession): string {
  if (agentSessionTerminationConfirmed(session)) return "terminated";
  const note = session.processState === "running"
    ? AGENT_SESSION_OBSERVATION_NOTE[agentSessionProcessObservation(session)]
    : undefined;
  const qualifier = note === undefined ? "" : ` (${note})`;
  if (
    session.desiredState === "running" &&
    session.requestState === "launched" &&
    session.processState === "running"
  ) {
    return `running${qualifier}`;
  }
  return `${session.desiredState}/${session.requestState}/${session.processState}${qualifier}`;
}

function requireCredential(context: CommandContext): void {
  if (context.credentialMode !== undefined) return;
  throw new CunaError({
    code: "cuna.auth.required",
    message: "This command requires a Cuna credential.",
    exitCode: EXIT_CODES.auth,
    hint: `Run \`cuna login\` for interactive use, or use an automation credential. ${automationCredentialHint()}`,
  });
}

function requireOperand(operands: readonly string[], index: number, label: string): string {
  const value = operands[index];
  if (value === undefined) throw usageError(`Missing ${label}.`);
  return value;
}

/**
 * A required option's value, or a refusal that says the option is missing.
 * Absent and malformed are different mistakes: reading an absent option as `""`
 * and handing it to a shape validator reports the wrong one.
 */
/**
 * The workspace binding this folder is already bound to, for the account this
 * invocation authenticates as. Read-only: creating a binding means choosing a
 * local root, an exclusion policy and a project identity, which are the
 * journey's decisions, so an unbound folder is refused rather than bound here.
 */
async function resolveLocalWorkspaceBinding(
  context: CommandContext,
): Promise<{ readonly bindingId: string; readonly generation: number }> {
  const identity = await context.client.getIdentity();
  const workspaceId = identity.workspaceId;
  const unbound = (reason: string, hint: string): CunaError => new CunaError({
    code: "cuna.workspace.binding_required",
    message: "This folder is not bound to a Cuna Machine.",
    exitCode: EXIT_CODES.usage,
    hint,
    details: { reason, folder: context.workspaceRoot ?? "." },
  });
  if (workspaceId === undefined) {
    throw unbound(
      "workspace_unassigned",
      "No Cuna workspace is assigned to this account yet. Run `cuna workspace show` to see where you stand.",
    );
  }
  const loaded = await loadWorkspaceBindingIntent({
    startPath: context.workspaceRoot ?? ".",
    profileId: context.config.profile,
    userId: identity.id,
    workspaceId,
  });
  if (loaded === undefined) {
    throw unbound(
      "folder_not_bound",
      "Run `cuna opencode` (or `cuna claude`, `cuna codex`) in this folder once: that binds the folder to a Machine and records the workspace binding this command needs. Or pass --workspace-binding-id and --workspace-generation yourself.",
    );
  }
  const record = loaded.record;
  // A folder that has moved is bound to a path that is no longer this one. The
  // journey knows how to relocate it; a batch mutation must not pretend the
  // binding still describes where it is running.
  if (loaded.relocationRequired) {
    throw unbound(
      "relocation_required",
      "This folder has moved since it was bound. Run `cuna opencode` in it once so Cuna can relocate the binding.",
    );
  }
  if (record.generation < 1) {
    throw unbound(
      "generation_uncommitted",
      "This folder is bound but has no committed workspace generation yet. Run `cuna opencode` in this folder once to commit one.",
    );
  }
  return Object.freeze({ bindingId: record.bindingId, generation: record.generation });
}

function requireOption(parsed: ParsedInvocation, name: string, hint?: string): string {
  const value = stringOption(parsed, name);
  if (value === undefined) {
    throw usageError(`Option --${name} is required.`, hint);
  }
  return value;
}

function integerOption(
  parsed: ParsedInvocation,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const raw = stringOption(parsed, name);
  if (raw === undefined) return undefined;
  return integerArgument(raw, name, minimum, maximum);
}

function agentOption(parsed: ParsedInvocation, required: boolean): AgentKind | undefined {
  const raw = stringOption(parsed, "agent");
  if (raw === undefined) {
    if (required) throw usageError("Option --agent is required.");
    return undefined;
  }
  if (raw !== "claude-code" && raw !== "codex" && raw !== "opencode") {
    throw usageError("Option --agent must be claude-code, codex, or opencode.");
  }
  return raw;
}

function normalizedAgentSessionAuthMode(
  rawAuthMode: string | undefined,
  credentialBinding: string | undefined,
): AgentAuthMode | undefined {
  let authMode: AgentAuthMode | undefined;
  if (rawAuthMode === undefined) {
    authMode = undefined;
  } else if (rawAuthMode === "interactive_login" || rawAuthMode === "credential_binding") {
    authMode = rawAuthMode;
  } else {
    throw usageError("Option --auth-mode must be interactive_login or credential_binding.");
  }

  if (authMode === "credential_binding" && credentialBinding === undefined) {
    throw usageError("Option --credential-binding is required for credential_binding auth mode.");
  }
  if (authMode !== "credential_binding" && credentialBinding !== undefined) {
    throw usageError("Option --credential-binding requires --auth-mode credential_binding.");
  }
  return authMode;
}

function requireConfirmation(parsed: ParsedInvocation, command: string): void {
  if (booleanOption(parsed, "yes")) return;
  throw new CunaError({
    code: "cuna.confirmation.required",
    message: `The ${command} mutation requires explicit confirmation in this initial build.`,
    exitCode: EXIT_CODES.policy,
    hint: `Review the target and repeat with --yes.`,
  });
}

/**
 * The read-back CONTRADICTED the write, and waiting will not repair it.
 *
 * Narrowed 2026-08-19. This used to be raised for two unrelated observations:
 * a genuine contradiction (a rename that observed a different name, a create
 * that observed a different id — an identity the producer can never converge
 * to), and a state that had simply not arrived yet. Only the first belongs
 * here. The second goes through `convergeOnRemoteState` and, if the CLI's own
 * budget runs out first, reports that as the CLI's budget rather than as the
 * server's failure.
 */
function postconditionUnverified(operation: string, details: SafeErrorDetails): never {
  throw new CunaError({
    code: "cuna.remote.postcondition_unverified",
    message: `Cuna accepted ${operation}, but the CLI could not verify the resulting remote state.`,
    exitCode: EXIT_CODES.conflict,
    hint: "Inspect the target with a read-only command before retrying the mutation.",
    details,
  });
}

function apiKeyCreateInput(parsed: ParsedInvocation, now = Date.now()): { readonly name: string; readonly expiresAt?: string } {
  const rawName = stringOption(parsed, "name");
  if (rawName === undefined || rawName.length < 1 || rawName.length > 80 || rawName.trim() !== rawName) {
    throw usageError("Option --name is required and must contain 1 through 80 non-padding characters.");
  }
  const name = assertSafeDisplayText(rawName, "API key name");
  const expiresAt = stringOption(parsed, "expires-at");
  if (expiresAt !== undefined) {
    const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
    const expiryMs = Date.parse(expiresAt);
    const oneHour = 60 * 60 * 1_000;
    const oneYear = 365 * 24 * oneHour;
    if (!utc.test(expiresAt) || !Number.isFinite(expiryMs) || expiryMs < now + oneHour || expiryMs > now + oneYear) {
      throw usageError("Option --expires-at must be a UTC instant between 1 hour and 365 days from now.");
    }
    return Object.freeze({ name, expiresAt: new Date(expiryMs).toISOString() });
  }
  return Object.freeze({ name });
}

/**
 * Whether the key on this row still opens the door, from both timestamps.
 *
 * `expiresAt` and `revokedAt` are independent nullable instants
 * (`ApiKeyMetadata`), and `--expires-at` mints keys up to 365 days out. The
 * human line derived one word from `revokedAt` alone, so a key past its expiry
 * but never revoked printed `active` while the JSON on the same invocation said
 * otherwise. Expiry is now a state the word can carry, and the instant it turns
 * on is printed rather than left to a second command.
 */
function apiKeyStatusLabel(key: ApiKeyMetadata, now: number): string {
  if (key.revokedAt !== null) return `revoked ${key.revokedAt}`;
  if (key.expiresAt === null) return "active (no expiry)";
  const expiryMs = Date.parse(key.expiresAt);
  if (!Number.isFinite(expiryMs)) return `active until ${key.expiresAt}`;
  return expiryMs <= now ? `expired ${key.expiresAt}` : `active until ${key.expiresAt}`;
}

/**
 * The reconciliation key for one create operation.
 *
 * Demanding this from the user made every `machines create` fail until they
 * discovered a flag whose purpose only matters when a create outcome is
 * uncertain — and the layer below already defaulted it, so the requirement
 * bought nothing. It is now generated per invocation and the flag remains as an
 * override, which is the case that actually needs a caller-known value: reusing
 * the same key to reconcile a create whose result was never observed.
 */
function idempotencyKey(parsed: ParsedInvocation): string {
  const value = stringOption(parsed, "idempotency-key");
  return value === undefined ? randomUUID() : assertIdempotencyKey(value);
}

function machineRecord(machine: Machine): Readonly<Record<string, unknown>> {
  const provider = machineProviderAvailability(machine);
  return Object.freeze({
    id: machine.id,
    name: machine.name,
    state: machine.state,
    ...(machine.agent === undefined ? {} : { agent: machine.agent }),
    ...(machine.vcpus === undefined ? {} : { vcpus: machine.vcpus }),
    ...(machine.memoryMiB === undefined ? {} : { memory_mib: machine.memoryMiB }),
    ...(machine.createdAt === undefined ? {} : { created_at: machine.createdAt }),
    ...(machine.updatedAt === undefined ? {} : { updated_at: machine.updatedAt }),
    provider_availability: Object.freeze({
      ...(provider.declaredId === undefined ? {} : { declared_id: provider.declaredId }),
      display_name: provider.displayName,
      usability: provider.usability,
      actionable: provider.actionable,
      ...(provider.reasonCode === undefined ? {} : { reason_code: provider.reasonCode }),
      ...(provider.observationVersion === undefined ? {} : { observation_version: provider.observationVersion }),
    }),
  });
}

function agentSessionRecord(session: AgentSession, machine?: Machine, now?: number): Readonly<Record<string, unknown>> {
  const actionability = machine === undefined || now === undefined
    ? undefined
    : classifySessionActionability({ session, machine, now });
  return Object.freeze({
    id: session.id,
    machine_id: session.machineId,
    ...(session.workspaceBindingId === undefined
      ? {}
      : {
          workspace_binding_id: session.workspaceBindingId,
          workspace_generation: session.workspaceGeneration,
        }),
    name: session.name,
    agent: session.agent,
    cwd: session.cwd,
    auth_mode: session.authMode,
    desired_state: session.desiredState,
    request_state: session.requestState,
    process_state: session.processState,
    // The provenance of the line above, and never omitted. A caller reading
    // `--json` must not have to infer it from a lease: absence on the wire is
    // folded to `unknown` once, in `session-visibility.ts`, and emitted here so
    // that "no supervisor established this" is a value rather than a silence.
    process_observation: agentSessionProcessObservation(session),
    ...(session.terminalReason === undefined ? {} : { terminal_reason: session.terminalReason }),
    ...(session.processEpoch === undefined ? {} : { process_epoch: session.processEpoch }),
    ...(session.runtimeObservedAt === undefined ? {} : { runtime_observed_at: session.runtimeObservedAt }),
    ...(session.runtimeExpiresAt === undefined ? {} : { runtime_expires_at: session.runtimeExpiresAt }),
    ...(session.terminationRequestedAt === undefined
      ? {}
      : { termination_requested_at: session.terminationRequestedAt }),
    row_version: session.rowVersion,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    ...(actionability === undefined ? {} : {
      base_state: actionability.baseState,
      refresh_status: actionability.refreshStatus,
      can_attach: actionability.canAttach,
      recovery_action: actionability.recoveryAction,
      reason_code: actionability.reasonCode,
      observation_revision: actionability.observationRevision,
    }),
  });
}

function agentDisplayName(agent: AgentKind): string {
  return providerDisplayName(agent);
}

function machineSessionCounts(machine: Machine, sessions: readonly AgentSession[], now: number): Readonly<Record<string, unknown>> {
  const count = (agent: AgentKind): Readonly<Record<string, number>> => {
    const matching = sessions.filter((session) => session.agent === agent);
    return Object.freeze({
      running: matching.filter((session) => session.processState === "running" &&
        classifySessionActionability({ session, machine, now }).canAttach).length,
      total: matching.length,
    });
  };
  return Object.freeze({
    claude: count("claude-code"),
    codex: count("codex"),
    opencode: count("opencode"),
  });
}

async function listAllMachineAgentSessions(
  client: CunaApiClient,
  machineId: string,
): Promise<readonly AgentSession[]> {
  const items: AgentSession[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listAgentSessions(machineId, {
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== undefined && cursors.has(cursor)) {
      throw new Error("AgentSession pagination repeated a cursor.");
    }
    if (cursor !== undefined) cursors.add(cursor);
  } while (cursor !== undefined);
  return Object.freeze(items);
}

/**
 * One flat record as one `key\tvalue` line per field.
 *
 * `config get` had no human rendering at all: a person at a terminal got the
 * JSON record pretty-printed, braces and quotes included, for nine scalar
 * fields. Nothing was hidden, which is why this is a rendering and not a new
 * projection — every key and every value survives, in declaration order.
 */
function renderScalarRecord(record: Readonly<Record<string, unknown>>): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}\t${value === null || value === undefined ? "null" : String(value)}`)
    .join("\n");
}

/**
 * A page footer that exists only when the page is not the whole answer.
 *
 * Without it "no such session" and "that session is on page 2" print the same
 * bytes. The continuation is named as the exact next command option, because a
 * truncation notice that does not say how to continue is only half the fact.
 */
function truncationFooter(nextCursor: string | undefined): readonly string[] {
  return nextCursor === undefined ? [] : [`-- more results; continue with --cursor ${nextCursor}`];
}

interface MachineOverviewRow {
  readonly machine: Machine;
  readonly sessions: readonly AgentSession[];
  readonly sessionsError?: string;
}

/**
 * A bounded, safe token naming WHY a machine's AgentSessions could not be read.
 *
 * The overview used to report the constant `sessions_unavailable` for every
 * cause. On 2026-09-07 an Edge release added a field this CLI's decoder did not
 * know, so every read failed `no_unknown_fields` — and the overview said only
 * "unavailable", which named nothing and pointed nowhere. Diagnosing it needed a
 * different command. A refusal that cannot be told apart from any other refusal
 * is not a report.
 *
 * Only vocabulary the CLI itself mints is rendered: an error code, or a
 * contract predicate and the key path that failed. No message text, no server
 * body, no field values — the reason must never become a channel for data the
 * server chose. The result is capped so a hostile or absurd token cannot flood
 * a terminal row.
 */
function safeSessionsErrorReason(error: unknown): string {
  const bound = (value: string) => value.slice(0, 64);
  if (error instanceof ContractViolation) {
    return bound(error.field === undefined
      ? `contract:${error.predicate}`
      : `contract:${error.predicate}:${error.field}`);
  }
  if (error instanceof CunaError) return bound(error.code);
  return "unknown";
}

function renderMachineOverview(
  items: readonly MachineOverviewRow[],
  now: number,
): string {
  if (items.length === 0) return "No machines found.";
  return items.flatMap(({ machine, sessions, sessionsError }) => {
    const counts = machineSessionCounts(machine, sessions, now) as {
      readonly claude: { readonly running: number; readonly total: number };
      readonly codex: { readonly running: number; readonly total: number };
      readonly opencode: { readonly running: number; readonly total: number };
    };
    const provider = machineProviderAvailability(machine);
    const claude = `Claude ${counts.claude.running}/${counts.claude.total} running`;
    const codex = `Codex ${counts.codex.running}/${counts.codex.total} running`;
    const opencode = `OpenCode ${counts.opencode.running}/${counts.opencode.total} running`;
    const providerCounts = `${opencode} · ${claude} · ${codex}`;
    const header = `▾ ${machine.name}  ${machine.state}  ${provider.displayName} ${providerVerdict(provider)}  ${providerCounts}`;
    if (sessionsError !== undefined) return [header, `  └─ AgentSessions unavailable (${sessionsError})`];
    if (sessions.length === 0) return [header, "  └─ No AgentSessions"];
    return [
      header,
      ...sessions.map((session, index) => {
        const branch = index === sessions.length - 1 ? "└─" : "├─";
        const actionability = classifySessionActionability({ session, machine, now });
        return `  ${branch} ${agentDisplayName(session.agent)}  ${session.name}  ${displaySessionActionability(actionability)}  ${session.id}`;
      }),
    ];
  }).join("\n");
}

function capabilityRecord(snapshot: CapabilitySnapshot): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema_version: snapshot.schemaVersion,
    subject_scope: snapshot.subjectScope,
    ...(snapshot.subjectId === undefined ? {} : { subject_id: snapshot.subjectId }),
    observed_at: snapshot.observedAt,
    expires_at: snapshot.expiresAt,
    etag: snapshot.etag,
    capabilities: snapshot.capabilities.map((capability) => ({
      id: capability.id,
      availability: capability.availability,
      interaction: capability.interaction,
      mutation_class: capability.mutationClass,
      surfaces: capability.surfaces,
      required_permissions: capability.requiredPermissions,
      ...(capability.reasonCode === undefined ? {} : { reason_code: capability.reasonCode }),
    })),
  });
}

export function preflightInvocation(
  parsed: ParsedInvocation,
  now: number = Date.now(),
): void {
  assertRegisteredCliRoute(parsed);
  switch (parsed.command) {
    case "config":
      rejectUnknownOptions(parsed, []);
      if (parsed.operands.length !== 1 || parsed.operands[0] !== "get") {
        throw unsupportedError("configuration mutation", "config_writes_not_implemented");
      }
      return;
    case "observe":
      rejectUnknownOptions(parsed,["project"]);
      if(parsed.operands.length!==0)throw usageError("observe accepts no operands.");
      assertCanonicalUuid(stringOption(parsed,"project")??"","Project ID");return;
    case "share":{
      rejectUnknownOptions(parsed,["project","grant"]);
      if(parsed.operands.length!==0)throw usageError("share accepts no operands.");
      assertCanonicalUuid(stringOption(parsed,"project")??"","Project ID");
      const grant=stringOption(parsed,"grant");if(grant!==undefined)assertCanonicalUuid(grant,"Grant ID");return;
    }
    case "capabilities": {
      rejectUnknownOptions(parsed, ["scope", "resource-id"]);
      if (parsed.operands.length !== 0) throw usageError("capabilities accepts no operands.");
      const scope = stringOption(parsed, "scope") ?? "account";
      if (scope !== "account" && scope !== "machine" && scope !== "agent_session") {
        throw usageError("Option --scope must be account, machine, or agent_session.");
      }
      const resourceId = stringOption(parsed, "resource-id");
      if (scope === "account" && resourceId !== undefined) {
        throw usageError("Option --resource-id is not valid for account scope.");
      }
      if (scope !== "account") {
        // A resource-scoped query names a Machine or an AgentSession, and both
        // are canonical UUIDs. Refusing the shape here keeps a typo from
        // travelling to the server and coming back as a contract complaint.
        assertCanonicalUuid(
          requireOption(parsed, "resource-id", `A ${scope} capability query is scoped to one resource.`),
          scope === "machine" ? "machine ID" : "AgentSession ID",
        );
      }
      return;
    }
    case "machines":
      preflightMachines(parsed);
      return;
    case "records":
      rejectUnknownOptions(parsed, []);
      if (parsed.operands.length !== 1 || parsed.operands[0] !== "list") {
        throw usageError("records requires the list action.");
      }
      return;
    case "authorizations":
      rejectUnknownOptions(parsed, ["machine"]);
      if (parsed.operands.length !== 1 || parsed.operands[0] !== "list") {
        throw usageError("authorizations requires the list action.");
      }
      assertCanonicalUuid(requireOption(parsed, "machine", "Run `cuna machines list` to find a machine ID."), "machine ID");
      return;
    case "account":
    case "workspace": {
      rejectUnknownOptions(parsed, []);
      const action = requireOperand(parsed.operands, 0, `${parsed.command} action`);
      if (action !== "show" || parsed.operands.length !== 1) {
        throw usageError(`${parsed.command} requires the show action.`);
      }
      return;
    }
    case "usage":
      rejectUnknownOptions(parsed, []);
      if (parsed.operands.length !== 1 || parsed.operands[0] !== "show") {
        throw usageError("usage requires the show action.");
      }
      return;
    case "api-keys": {
      const action = requireOperand(parsed.operands, 0, "api-keys action");
      if (action === "list") {
        rejectUnknownOptions(parsed, []);
        if (parsed.operands.length !== 1) throw usageError("api-keys list accepts no operands.");
        return;
      }
      if (action === "revoke") {
        rejectUnknownOptions(parsed, ["yes"]);
        if (parsed.operands.length !== 2) throw usageError("api-keys revoke requires exactly one API key ID.");
        requireConfirmation(parsed, "api-keys.revoke");
        assertCanonicalUuid(requireOperand(parsed.operands, 1, "API key ID"), "API key ID");
        return;
      }
      if (action === "create") {
        rejectUnknownOptions(parsed, ["name", "expires-at", "yes"]);
        if (parsed.operands.length !== 1) throw usageError("api-keys create accepts no operands.");
        requireConfirmation(parsed, "api-keys.create");
        // Preflight and execution must read one clock; validating here with
        // the wall clock while execution used the injected one let a fixed
        // test date turn red the day the calendar caught up with it.
        apiKeyCreateInput(parsed, now);
        return;
      }
      throw usageError(`Unknown api-keys action ${action}.`);
    }
    case "agent-sessions":
      preflightAgentSessions(parsed);
      return;
    case "executions":
      preflightExecutions(parsed);
      return;
    case "agent": {
      rejectUnknownOptions(parsed, ["agent-session", "yes"]);
      if (parsed.operands.length !== 1 || parsed.operands[0] !== "logout") {
        throw usageError("agent requires the logout action.");
      }
      requireConfirmation(parsed, "agent.logout");
      assertCanonicalUuid(
        requireOption(parsed, "agent-session", "Run `cuna agent-sessions list --machine <id>` to find an AgentSession ID."),
        "AgentSession ID",
      );
      return;
    }
    case "login":
    case "logout":
    case "whoami":
      rejectUnknownOptions(parsed, []);
      if (parsed.operands.length !== 0) throw usageError(`${parsed.command} accepts no operands.`);
      return;
    case "access":
      rejectUnknownOptions(parsed, []);
      if (parsed.operands.length !== 1 || parsed.operands[0] !== "status") {
        throw usageError("access requires the status action.");
      }
      return;
    case "signup":
      rejectUnknownOptions(parsed, []);
      if (parsed.operands.length !== 0) throw usageError("signup accepts no operands.");
      return;
    case "claude":
    case "codex":
    case "opencode": {
      preflightAgentJourneyInvocation(parsed);
      return;
    }
    case "shell":
    case "sync":
    case "companion":
      rejectUnknownOptions(parsed, []);
      if (parsed.operands.length !== 0) throw usageError(`${parsed.command} accepts no operands in this build.`);
      return;
    case "connect":
      rejectUnknownOptions(parsed, []);
      if (parsed.operands.length < 1 || parsed.operands.length > 4) {
        throw usageError("connect requires one through four explicit AgentSession IDs.");
      }
      if (new Set(parsed.operands).size !== parsed.operands.length) {
        throw usageError("connect requires distinct AgentSession IDs.");
      }
      for (const agentSessionId of parsed.operands) assertCanonicalUuid(agentSessionId, "AgentSession ID");
      return;
    case "doctor":
      rejectUnknownOptions(parsed, ["check-browser-login"]);
      if (parsed.operands.length !== 0) throw usageError("doctor accepts no operands.");
      return;
    case "self-test":
      rejectUnknownOptions(parsed, ["offline"]);
      if (parsed.operands.length !== 0) throw usageError("self-test accepts no operands.");
      if (!booleanOption(parsed, "offline")) {
        throw usageError("self-test requires --offline in this release.", "Run `cuna self-test --offline --json`.");
      }
      return;
    case "version":
      rejectUnknownOptions(parsed, ["help", "version"]);
      if (parsed.operands.length !== 0) throw usageError("version accepts no operands.");
      return;
    case "help":
      rejectUnknownOptions(parsed, ["help"]);
      if (parsed.operands.length !== 0) throw usageError("help accepts no operands.");
      return;
    default:
      throw usageError(`Unknown command ${parsed.command ?? "<none>"}.`, "Run `cuna --help`.");
  }
}

/**
 * `machines live-update-supervisor` admits three disjoint intents, and one
 * shared `--yes` would have made them one.
 *
 * `--yes` starts a NEW operation: it mints an identity, records it, and sends
 * it. `--resume` re-sends the identity already recorded — the producer's own
 * recovery for a lost answer, and the only repetition that never rotates this
 * Machine's control twice. `--forget-unknown` sends no mutation at all: it
 * clears this installation's record, and only once an authoritative read says
 * the operation settled.
 *
 * They are mutually exclusive because collapsing them would let "confirm the
 * update" read as "and clear whatever is outstanding first", which is precisely
 * the silent resolution-by-repetition this command must not perform — and would
 * let a resume be mistaken for a new decision, which is the one mistake the
 * producer cannot protect a caller from, because a NEW identity is exactly what
 * it refuses to treat as a repeat.
 */
export type LiveUpdateSupervisorIntent = "start" | "resume" | "forget-unknown";

function preflightLiveUpdateSupervisor(
  parsed: ParsedInvocation,
): { readonly intent: LiveUpdateSupervisorIntent } {
  rejectUnknownOptions(parsed, ["yes", "resume", "forget-unknown", "operation"]);
  if (parsed.operands.length !== 2) {
    throw usageError("machines live-update-supervisor requires exactly one machine ID.");
  }
  const chosen = (["yes", "resume", "forget-unknown"] as const)
    .filter((option) => booleanOption(parsed, option));
  if (chosen.length > 1) {
    throw usageError(
      "machines live-update-supervisor accepts exactly one of --yes, --resume or --forget-unknown.",
      "Starting a new update, repeating the one this computer already recorded, and clearing that record are three different decisions. Read `cuna machines live-update-status MACHINE_ID` first; it sends nothing.",
    );
  }
  const intent: LiveUpdateSupervisorIntent = chosen[0] === "forget-unknown"
    ? "forget-unknown"
    : chosen[0] === "resume" ? "resume" : "start";
  // `--resume` is its own explicit decision and carries the identity it will
  // re-send in its own name, so it is not additionally gated on `--yes`.
  if (intent === "start") requireConfirmation(parsed, "machines.live-update-supervisor");
  assertMachineId(requireOperand(parsed.operands, 1, "machine ID"));
  const operation = stringOption(parsed, "operation");
  if (operation !== undefined) {
    // Only the repeat can take an identity. Naming one alongside "start a new
    // update" or "clear the record" would be two decisions in one flag.
    if (intent !== "resume") {
      throw usageError(
        "machines live-update-supervisor accepts --operation only with --resume.",
        `--operation names an update to finish, which is what --resume does. To read one without sending anything, use \`cuna machines live-update-status MACHINE_ID --operation ${operation}\`.`,
      );
    }
    assertCanonicalUuid(operation, "supervisor update operation ID");
  }
  return Object.freeze({ intent });
}

/**
 * `machines live-update-status` — the read that recovers a lost answer.
 *
 * No confirmation, because it confirms nothing: the producer states that this
 * route dispatches no installer, sends nothing to the Machine and changes no
 * state. `--operation` is optional; without it the command reads the identity
 * this computer recorded, which is the whole point of having recorded it.
 */
function preflightLiveUpdateStatus(parsed: ParsedInvocation): void {
  rejectUnknownOptions(parsed, ["operation"]);
  if (parsed.operands.length !== 2) {
    throw usageError("machines live-update-status requires exactly one machine ID.");
  }
  assertMachineId(requireOperand(parsed.operands, 1, "machine ID"));
  const operation = stringOption(parsed, "operation");
  if (operation !== undefined) assertCanonicalUuid(operation, "supervisor update operation ID");
}

function preflightMachines(parsed: ParsedInvocation): void {
  if (parsed.operands.length === 0) {
    rejectUnknownOptions(parsed, []);
    return;
  }
  const action = requireOperand(parsed.operands, 0, "machines action");
  if (action === "list") {
    rejectUnknownOptions(parsed, []);
    if (parsed.operands.length !== 1) throw usageError("machines list accepts no operands.");
    return;
  }
  if (action === "create") {
    rejectUnknownOptions(parsed, ["name", "agent", "vcpus", "memory-mib", "background", "yes", "idempotency-key"]);
    if (parsed.operands.length !== 1) throw usageError("machines create accepts no operands.");
    requireConfirmation(parsed, "machines.create");
    idempotencyKey(parsed);
    const rawName = stringOption(parsed, "name");
    if (rawName === undefined) throw usageError("Option --name is required.");
    const name = assertSafeDisplayText(rawName, "machine name");
    if (name.length < 1 || name.length > 80) throw usageError("Option --name must contain 1 through 80 characters.");
    agentOption(parsed, false);
    integerOption(parsed, "vcpus", 1, 8);
    integerOption(parsed, "memory-mib", 512, 16_384);
    return;
  }
  if (action === "update-supervisor") {
    rejectUnknownOptions(parsed, ["yes"]);
    if (parsed.operands.length !== 2) throw usageError("machines update-supervisor requires exactly one machine ID.");
    requireConfirmation(parsed, "machines.update-supervisor");
    assertMachineId(requireOperand(parsed.operands, 1, "machine ID"));
    return;
  }
  if (action === "live-update-supervisor") {
    preflightLiveUpdateSupervisor(parsed);
    return;
  }
  if (action === "live-update-status") {
    preflightLiveUpdateStatus(parsed);
    return;
  }
  if (action === "start" || action === "pause" || action === "resume" || action === "stop" || action === "delete") {
    rejectUnknownOptions(parsed, ["yes"]);
    if (parsed.operands.length !== 2) throw usageError(`machines ${action} requires exactly one machine ID.`);
    requireConfirmation(parsed, `machines.${action}`);
    assertMachineId(requireOperand(parsed.operands, 1, "machine ID"));
    return;
  }
  throw usageError(`Unknown machines action ${action}.`);
}

function preflightAgentSessions(parsed: ParsedInvocation): void {
  const action = requireOperand(parsed.operands, 0, "agent-sessions action");
  if (action === "list") {
    rejectUnknownOptions(parsed, ["machine", "limit", "cursor"]);
    if (parsed.operands.length !== 1) throw usageError("agent-sessions list accepts no operands.");
    assertMachineId(requireOption(parsed, "machine", "Run `cuna machines list` to find a machine ID."));
    integerOption(parsed, "limit", 1, 100);
    const cursor = stringOption(parsed, "cursor");
    if (cursor !== undefined && (cursor.length > 512 || /[\p{Cc}\p{Cf}]/u.test(cursor))) {
      throw usageError("Option --cursor is malformed.");
    }
    return;
  }
  if (action === "get") {
    rejectUnknownOptions(parsed, []);
    if (parsed.operands.length !== 2) throw usageError("agent-sessions get requires exactly one AgentSession ID.");
    assertCanonicalUuid(requireOperand(parsed.operands, 1, "AgentSession ID"), "AgentSession ID");
    return;
  }
  if (action === "create") {
    rejectUnknownOptions(parsed, [
      "machine", "workspace-binding-id", "workspace-generation", "name", "agent", "cwd",
      "auth-mode", "credential-binding", "yes", "idempotency-key",
    ]);
    if (parsed.operands.length !== 1) throw usageError("agent-sessions create accepts no operands.");
    requireConfirmation(parsed, "agent-sessions.create");
    assertMachineId(requireOption(parsed, "machine", "Run `cuna machines list` to find a machine ID."));
    // Both workspace options are optional here: absent, they are resolved from
    // the folder's own binding at execution. Preflight still validates the
    // shape of whatever WAS supplied, so a malformed value is refused before
    // any network work — it just no longer refuses their absence.
    const givenBinding = stringOption(parsed, "workspace-binding-id");
    if (givenBinding !== undefined) assertCanonicalUuid(givenBinding, "workspace binding ID");
    integerOption(parsed, "workspace-generation", 1, Number.MAX_SAFE_INTEGER);
    const agent = agentOption(parsed, true);
    if (agent === undefined) throw usageError("Option --agent is required.");
    const cwd = assertSafeDisplayText(stringOption(parsed, "cwd") ?? "/workspace", "workspace path");
    if (!cwd.startsWith("/workspace") || cwd.split("/").includes("..") || cwd.length > 1024) {
      throw usageError("Option --cwd must be a safe absolute path inside /workspace.");
    }
    const name = stringOption(parsed, "name");
    if (name !== undefined && (assertSafeDisplayText(name, "AgentSession name").length < 1 || name.length > 80)) {
      throw usageError("Option --name must contain 1 through 80 characters.");
    }
    const binding = stringOption(parsed, "credential-binding");
    const rawAuthMode = stringOption(parsed, "auth-mode");
    if (agent === "opencode" && (rawAuthMode === "credential_binding" || binding !== undefined)) {
      throw usageError(
        "OpenCode supports interactive_login only; credential bindings are not accepted.",
        "Use OpenCode's interactive provider flow and omit --credential-binding.",
      );
    }
    normalizedAgentSessionAuthMode(rawAuthMode, binding);
    if (binding !== undefined) assertPublicId(binding, "credential binding ID");
    idempotencyKey(parsed);
    return;
  }
  if (action === "terminate" || action === "rename") {
    rejectUnknownOptions(parsed, action === "rename" ? ["name", "yes"] : ["yes"]);
    if (parsed.operands.length !== 2) throw usageError(`agent-sessions ${action} requires exactly one AgentSession ID.`);
    requireConfirmation(parsed, `agent-sessions.${action}`);
    assertCanonicalUuid(requireOperand(parsed.operands, 1, "AgentSession ID"), "AgentSession ID");
    if (action === "rename") {
      const name = stringOption(parsed, "name");
      if (name === undefined || assertSafeDisplayText(name, "AgentSession name").length < 1 || name.length > 80) {
        throw usageError("Option --name must contain 1 through 80 characters.");
      }
    }
    return;
  }
  if (action === "attach") {
    rejectUnknownOptions(parsed, []);
    if (parsed.operands.length !== 2) throw usageError("agent-sessions attach requires exactly one AgentSession ID.");
    assertCanonicalUuid(requireOperand(parsed.operands, 1, "AgentSession ID"), "AgentSession ID");
    return;
  }
  throw usageError(`Unknown agent-sessions action ${action}.`);
}

export async function executeCommand(context: CommandContext): Promise<CommandResult> {
  const { parsed, config, client } = context;
  switch (parsed.command) {
    case "config": {
      rejectUnknownOptions(parsed, []);
      if (parsed.operands.length !== 1 || parsed.operands[0] !== "get") {
        throw unsupportedError("configuration mutation", "config_writes_not_implemented");
      }
      const data = publicConfig(config);
      return Object.freeze({ command: "config.get", data, human: renderScalarRecord(data) });
    }
    case "capabilities": {
      rejectUnknownOptions(parsed, ["scope", "resource-id"]);
      requireCredential(context);
      const scope = stringOption(parsed, "scope") ?? "account";
      if (scope !== "account" && scope !== "machine" && scope !== "agent_session") {
        throw usageError("Option --scope must be account, machine, or agent_session.");
      }
      const resourceId = stringOption(parsed, "resource-id");
      if (scope !== "account" && resourceId === undefined) {
        throw usageError("Option --resource-id is required for a resource-scoped capability query.");
      }
      const snapshot = await client.discoverCapabilities(scope, resourceId);
      const data = capabilityRecord(snapshot);
      return Object.freeze({
        command: "capabilities",
        data,
        human: snapshot.capabilities.length === 0
          ? "No capabilities were advertised for this context."
          : snapshot.capabilities
              .map((capability) => `${capability.id}\t${capability.availability}\t${capability.interaction}`)
              .join("\n"),
      });
    }
    case "machines":
      return executeMachines(context);
    case "records": {
      requireCredential(context);
      await requireCapability({
        client,
        scope: "account",
        capabilityId: "records.list",
        now: context.capabilityClock ?? context.now,
        allowedInteractions: ["read_only"],
      });
      const records = await client.listRecords();
      const data = Object.freeze({
        items: records.map((record) => Object.freeze({
          id: record.id,
          machine_id: record.machineId,
          kind: record.kind,
          summary: record.summary,
          detail: record.detail,
          created_at: record.createdAt,
        })),
      });
      return Object.freeze({
        command: "records.list",
        data,
        human: records.length === 0
          ? "No records found."
          : records.map((record) => `${record.createdAt}\t${record.machineId}\t${record.kind}\t${record.summary}`).join("\n"),
      });
    }
    case "authorizations": {
      requireCredential(context);
      const machineId = assertCanonicalUuid(requireOption(parsed, "machine", "Run `cuna machines list` to find a machine ID."), "machine ID");
      await requireCapability({
        client,
        scope: "machine",
        resourceId: machineId,
        capabilityId: "authorizations.list",
        now: context.capabilityClock ?? context.now,
        allowedInteractions: ["read_only"],
      });
      const authorizations = await client.listAuthorizations(machineId);
      const data = Object.freeze({
        machine_id: machineId,
        ...authorizations,
      });
      const lines = authorizations.secret_configuration.flatMap((configuration) => {
        const binding = `secret:${configuration.secret_id}`;
        const items = [
          ...configuration.environment.map((item) => `environment\t${item.name}\t${JSON.stringify(item.value_template)}\t${binding}`),
          ...configuration.egress_rules.map((item) => `egress:${item.action}\t${item.host_pattern}\tpath:${JSON.stringify(item.path_pattern) ?? "unspecified"}\t${item.name}\t${JSON.stringify(item.value_template)}\t${binding}`),
          ...configuration.files.map((item) => `file\t${item.path}\t${JSON.stringify(item.value_template)}\t${binding}`),
        ];
        return items.length === 0 ? [`${binding}\tNo injection entries configured.`] : items;
      });
      return Object.freeze({
        command: "authorizations.list",
        data,
        human: `Configuration revision ${authorizations.revision}\n${lines.length === 0
          ? "No inline secret configuration is set for this machine."
          : lines.join("\n")}`,
      });
    }
    case "account": {
      requireCredential(context);
      const identity = await client.getIdentity();
      const data = Object.freeze({ id: identity.id, email: identity.email });
      return Object.freeze({ command: "account.show", data, human: `${identity.id}\t${identity.email}` });
    }
    case "workspace": {
      requireCredential(context);
      const identity = await client.getIdentity();
      const data = Object.freeze({
        assigned: identity.workspaceAssigned,
        ...(identity.waitlistPosition === undefined
          ? {}
          : { waitlist_position: identity.waitlistPosition }),
      });
      return Object.freeze({
        command: "workspace.show",
        data,
        human: identity.workspaceAssigned
          ? "A Cuna workspace is assigned to this account."
          : `No Cuna workspace is assigned. Waitlist position: ${identity.waitlistPosition ?? "unknown"}.`,
      });
    }
    case "usage": {
      requireCredential(context);
      const identity = await client.getIdentity();
      if (identity.workspaceUsage === undefined) {
        // The refusal lives here, where the figure is read, and nowhere else.
        // A usage payload this build does not recognise stops this one command;
        // every other command still gets its identity.
        if (identity.workspaceUsageProblem !== undefined) {
          throw new CunaError({
            code: "cuna.remote.malformed_response",
            message: "Cuna reported spend in a shape this CLI does not accept.",
            exitCode: EXIT_CODES.remote,
            hint: "No figure is shown rather than a wrong one. Every other command is unaffected. " +
              "Run `cuna version --json` and report it with the details above at " +
              "https://github.com/Cuna-Labs/cuna-cli/issues.",
            details: { reason: "workspace_usage_off_contract", detail: identity.workspaceUsageProblem },
          });
        }
        throw unsupportedError("workspace usage", "workspace_usage_unavailable");
      }
      const usage = identity.workspaceUsage;
      const data = Object.freeze({
        estimated_spend_usd: usage.estimatedSpendUsd,
        estimated_spend_is_lower_bound: usage.estimatedSpendIsLowerBound,
        balance_status: usage.balanceStatus,
        balance_usd: usage.balanceUsd,
        ...(usage.balanceUnavailableReason === undefined
          ? {}
          : { balance_unavailable_reason: usage.balanceUnavailableReason }),
        note: usage.note,
      });
      // "At least" is the whole claim and the sentence carries it. A balance is
      // printed only when the producer says it read one: an unavailable balance
      // is not zero.
      return Object.freeze({
        command: "usage.show",
        data,
        human: [
          `At least $${usage.estimatedSpendUsd.toFixed(2)} spent.`,
          usage.balanceStatus === "available" && usage.balanceUsd !== null
            ? `Balance $${usage.balanceUsd.toFixed(2)}.`
            : "No balance available.",
          usage.note,
        ].join(" "),
      });
    }
    case "api-keys": {
      requireCredential(context);
      const action = requireOperand(parsed.operands, 0, "api-keys action");
      if (context.credentialMode !== "interactive") {
        throw new CunaError({
          code: "cuna.auth.interactive_required",
          message: "API-key management requires an interactive Cuna session.",
          exitCode: EXIT_CODES.auth,
          hint: "Unset the automation credential, run `cuna login`, then repeat this command.",
        });
      }
      await requireCapability({ client, scope: "account", capabilityId: "api_keys.manage", now: context.capabilityClock ?? context.now });
      if (action === "list") {
        const keys = await client.listApiKeys();
        const data = Object.freeze({
          items: keys.map((key) => Object.freeze({
            id: key.id,
            name: key.name,
            prefix: key.prefix,
            last_four: key.lastFour,
            created_at: key.createdAt,
            expires_at: key.expiresAt,
            last_used_at: key.lastUsedAt,
            revoked_at: key.revokedAt,
          })),
        });
        return Object.freeze({
          command: "api-keys.list",
          data,
          human: keys.length === 0
            ? "No API keys found."
            : keys.map((key) => `${key.id}\t${key.name}\t${key.prefix}…${key.lastFour}\t${apiKeyStatusLabel(key, context.now)}`).join("\n"),
        });
      }
      if (action === "revoke") {
        const id = assertCanonicalUuid(requireOperand(parsed.operands, 1, "API key ID"), "API key ID");
        await client.revokeApiKey(id);
        const observed = (await client.listApiKeys()).find((key) => key.id === id);
        if (observed !== undefined && observed.revokedAt === null) {
          postconditionUnverified("API-key revocation", { api_key_id: id, observed_state: "active" });
        }
        return Object.freeze({
          command: "api-keys.revoke",
          data: Object.freeze({ id, revoked: true }),
          human: `Revoked API key ${id}.`,
        });
      }
      if (action === "create") {
        const input = apiKeyCreateInput(parsed, context.now);
        const prior = await client.listApiKeys();
        const priorIds = new Set(prior.map((key) => key.id));
        const operationKey = `cuna-api-key-create-${randomUUID()}`;
        let created;
        let createFailure: unknown;
        try {
          created = await client.createApiKey(input, operationKey);
        } catch (error) {
          createFailure = error;
        }
        if (created?.idempotencyReplayed === true) {
          createFailure = new Error("API-key creation replay did not return one-time secret material.");
        }
        if (createFailure !== undefined) {
          // Reuse the same operation authority once. This can recover the exact
          // committed ID after a timeout or malformed first response without
          // creating a sibling key. The replay secret, if any, is never used:
          // after an uncertain response the only safe outcome is reconciliation.
          let replayed;
          try { replayed = await client.createApiKey(input, operationKey); } catch { /* post-list remains authoritative */ }
          const observedAt = context.now + 120_000;
          const candidates = (await client.listApiKeys()).filter((key) => {
            const createdAt = Date.parse(key.createdAt);
            return !priorIds.has(key.id) && key.name === input.name && key.revokedAt === null &&
              key.expiresAt === (input.expiresAt ?? null) && Number.isFinite(createdAt) &&
              createdAt >= context.now - 5_000 && createdAt <= observedAt + 5_000;
          });
          if (candidates.length === 1) {
            await client.revokeApiKey(candidates[0]!.id);
            const remaining = (await client.listApiKeys()).filter(
              (key) => key.id === candidates[0]!.id && key.revokedAt === null,
            );
            if (remaining.length !== 0) {
              throw new CunaError({
                code: "cuna.api_keys.create_cleanup_unverified",
                message: "Cuna could not verify cleanup of an API key created during an uncertain response.",
                exitCode: EXIT_CODES.conflict,
                hint: "Revoke the listed API key ID in the Cuna dashboard before retrying.",
                details: { manual_cleanup_ids: [candidates[0]!.id], idempotency_key: operationKey },
                cause: createFailure,
              });
            }
            throw new CunaError({
              code: "cuna.api_keys.create_secret_unobserved",
              message: "Cuna created the API key, but its one-time secret response was not observed; the CLI revoked it safely.",
              exitCode: EXIT_CODES.network,
              hint: "Retry creation with a new name. The unobserved key was revoked and cannot authenticate.",
              retryable: true,
              details: { api_key_id: candidates[0]!.id, reconciled: true, revoked: true, cleanup_verified: true, idempotency_replayed: replayed?.idempotencyReplayed ?? null },
              cause: createFailure,
            });
          }
          if (candidates.length === 0) {
            throw new CunaError({
              code: "cuna.api_keys.create_failed_no_commit",
              message: "API-key creation failed and reconciliation found no newly created key.",
              exitCode: EXIT_CODES.network,
              hint: "No cleanup is required. Retry creation with the same name when connectivity is stable.",
              retryable: true,
              details: { reconciled: true, created: false, idempotency_key: operationKey },
              cause: createFailure,
            });
          }
          throw new CunaError({
            code: "cuna.api_keys.create_reconciliation_ambiguous",
            message: "API-key creation failed and reconciliation found multiple possible new keys.",
            exitCode: EXIT_CODES.conflict,
            hint: "Review and revoke the listed API key IDs in the Cuna dashboard before retrying.",
            details: { reconciled: false, manual_cleanup_ids: candidates.map((key) => key.id), idempotency_key: operationKey },
            cause: createFailure,
          });
        }
        if (created === undefined || created.idempotencyReplayed) throw new Error("API-key creation reconciliation invariant failed.");
        const data = Object.freeze({
          id: created.id,
          name: created.name,
          prefix: created.prefix,
          last_four: created.lastFour,
          created_at: created.createdAt,
          expires_at: created.expiresAt,
          key: created.key,
        });
        return Object.freeze({
          command: "api-keys.create",
          data,
          human: `Created API key ${created.name}. Copy it now; Cuna will not show it again.\n${created.key}`,
        });
      }
      throw usageError(`Unknown api-keys action ${action}.`);
    }
    case "agent-sessions":
      return executeAgentSessions(context);
    case "executions":
      return executeExecutions(context);
    case "agent": {
      requireCredential(context);
      rejectUnknownOptions(parsed, ["agent-session", "yes"]);
      if (parsed.operands.length !== 1 || parsed.operands[0] !== "logout") {
        throw usageError("agent requires the logout action.");
      }
      requireConfirmation(parsed, "agent.logout");
      const id = assertCanonicalUuid(
        requireOption(parsed, "agent-session", "Run `cuna agent-sessions list --machine <id>` to find an AgentSession ID."),
        "AgentSession ID",
      );
      const session = await client.getAgentSession(id);
      if (
        session.processEpoch === undefined ||
        session.authMode !== "interactive_login" ||
        (session.agent !== "claude-code" && session.agent !== "codex")
      ) {
        throw new CunaError({
          code: "cuna.agent.auth_logout_unavailable",
          message: "Provider sign-out is unavailable for this AgentSession.",
          exitCode: EXIT_CODES.policy,
          hint: "Select a running Claude Code or Codex AgentSession using interactive sign-in.",
        });
      }
      await requireCapability({
        client,
        scope: "agent_session",
        resourceId: id,
        capabilityId: "agent_sessions.auth_logout",
        now: context.capabilityClock ?? context.now,
      });
      const receipt = await client.logoutAgentSessionAuth(id, session.processEpoch);
      if (
        receipt.agentSessionId !== session.id ||
        receipt.processEpoch !== session.processEpoch ||
        receipt.authMode !== session.authMode ||
        receipt.agent !== session.agent
      ) {
        throw new CunaError({
          code: "cuna.remote.malformed_response",
          message: "Cuna returned a provider sign-out receipt for another AgentSession authority.",
          exitCode: EXIT_CODES.remote,
          hint: OFF_CONTRACT_RESPONSE_HINT,
          details: {
            operation: "POST /v1/agent-sessions/{id}/agent-auth/logout",
            // The first field that disagreed, not all four: a list of every
            // compared field says nothing about which one was wrong.
            field: receipt.agentSessionId !== session.id
              ? "agent_session_id"
              : receipt.processEpoch !== session.processEpoch
                ? "process_epoch"
                : receipt.authMode !== session.authMode
                  ? "auth_mode"
                  : "agent",
            predicate: "matches_requested_resource",
          },
        });
      }
      const observedAuth = await client.getAgentSessionAuth(id);
      const observationIsAboutThisSession =
        observedAuth.agentSessionId === id &&
        observedAuth.agent === session.agent &&
        observedAuth.processEpoch === session.processEpoch;
      // Absence of evidence is not a contradiction. Some providers abstain from
      // reporting a login state at all — the Edge does exactly that for Codex,
      // because a successful `codex login status` proves credentials exist and
      // not that the account would be accepted. That abstention arrives as
      // `state: "unavailable"`, and treating it as a failed postcondition
      // turned a sign-out the server had CONFIRMED into an error the person
      // could do nothing about. `postconditionUnverified` is reserved, by its
      // own contract above, for an observation that CONTRADICTS the write.
      const providerAbstains = observedAuth.state === "unavailable";
      if (
        !observationIsAboutThisSession ||
        (!providerAbstains && observedAuth.state !== "login_required")
      ) {
        postconditionUnverified("AgentSession provider logout", {
          agent_session_id: id,
          observed_state: observedAuth.state,
        });
      }
      return Object.freeze({
        command: "agent.logout",
        data: Object.freeze({
          observation_id: receipt.observationId,
          agent_session_id: receipt.agentSessionId,
          process_epoch: receipt.processEpoch,
          auth_mode: receipt.authMode,
          agent: receipt.agent,
          agent_version: receipt.agentVersion,
          adapter_version: receipt.adapterVersion,
          observed_at: receipt.observedAt,
          outcome: receipt.outcome,
          // Say which of the two happened. The sign-out is confirmed either
          // way; only one of them was independently observed afterwards.
          post_state: providerAbstains ? "unobserved" : "login_required",
        }),
        human: providerAbstains
          ? `Signed out ${session.agent} in AgentSession ${session.id}. ${agentDisplayName(session.agent)} does not report a login state, so this was not independently re-checked.`
          : `Signed out ${session.agent} in AgentSession ${session.id}.`,
      });
    }
    case "signup":
    case "login":
    case "logout":
    case "whoami":
    case "access":
      throw unsupportedError("browser authentication", "browser_auth_dispatch_unavailable");
    case "claude":
    case "codex":
    case "opencode":
    case "connect":
      // Public process dispatch is owned by runCli, which composes exact attach
      // and the automatic journey before this generic command dispatcher. A
      // direct executeCommand call has no TTY, sync lifecycle or credential
      // composition authority, so it must fail closed without claiming that
      // the shipped runtime itself is absent.
      throw unsupportedError("terminal workspace", "run_cli_composition_required");
    case "shell":
      throw unsupportedError("terminal workspace", "terminal_runtime_unavailable");
    case "sync":
      throw unsupportedError("workspace synchronization", "workspace_sync_runtime_unavailable");
    case "companion":
      throw unsupportedError("local companion", "local_companion_unavailable");
    case "doctor": {
      rejectUnknownOptions(parsed, ["check-browser-login"]);
      // `doctor` reads no credential, so an unusable one must not stop it —
      // that is the whole reason the refusal moved out of `resolveConfig`. It
      // reports the state instead, because a diagnostic that survives a broken
      // environment and then says nothing about it is no better than dying.
      const features = context.runtimeFeatures ?? INITIAL_RUNTIME_GATES;
      const data = Object.freeze({
        platform: process.platform,
        node: process.version,
        environment_credential: environmentCredentialState(config),
        environment_credential_variable: config.apiKeyVariable ?? null,
        runtime_features: features,
      });
      // `doctor` is the command the help text sends a stuck user to first, and
      // it answered with a JSON dump on a TTY. Every field the record carries is
      // still here; each feature now states its implementation AND the reason
      // code that names the prerequisite, on the line that reports it.
      return Object.freeze({
        command: "doctor",
        data,
        human: [
          `platform\t${data.platform}`,
          `node\t${data.node}`,
          `environment_credential\t${data.environment_credential}`,
          `environment_credential_variable\t${data.environment_credential_variable ?? "null"}`,
          "runtime_features",
          ...features.map((gate) => `  ${gate.feature}\t${gate.implementation}\t${gate.reason}`),
        ].join("\n"),
      });
    }
    case "self-test": {
      rejectUnknownOptions(parsed, ["offline"]);
      if (parsed.operands.length !== 0) throw usageError("self-test accepts no operands.");
      if (!booleanOption(parsed, "offline")) {
        throw usageError(
          "self-test requires --offline in this release.",
          "Run `cuna self-test --offline --json`.",
        );
      }
      const runtimeSupport = evaluateRuntimeSupport({
        nodeVersion: process.versions.node,
        platform: process.platform,
        architecture: process.arch,
      });
      const buildDigest = await packageBuildDigest();
      const virtualTerminal = await verifyVirtualTerminalInterop();
      // `canonical_api_origin` used to live in `checks` as
      // `config.baseUrl === DEFAULT_BASE_URL || config.developmentProfile`.
      // That condition cannot be false: `normalizeBaseUrl` (config/config.ts)
      // returns `DEFAULT_BASE_URL` or throws unless a development profile is
      // active, so the check restated its own precondition. It is now reported
      // as what it always was — a configuration fact, not an integrity gate —
      // and `apiOriginIsCanonical` can and does read `false`.
      const checks = Object.freeze({
        node_runtime: runtimeSupport.nodeRuntime,
        supported_platform: runtimeSupport.platform,
        supported_architecture: runtimeSupport.architecture,
        package_identity: /^[0-9a-f]{64}$/u.test(buildDigest),
        virtual_terminal: virtualTerminal,
        network_requests: 0,
      });
      const ok = Object.values(checks).every((value) => value === true || value === 0);
      const data = Object.freeze({
        ok,
        mode: "offline",
        // `ok` answers one question: is the installed artifact intact and
        // admissible on this host? It said nothing about the six runtime
        // feature gates `doctor` reports, every one of which is currently
        // `unsupported` — so "Offline self-test passed." read as a verdict on
        // the product while covering only the installation.
        scope: "installation_integrity",
        notChecked: Object.freeze([
          "runtime_features",
          "server_contract",
          "credential_state",
        ]),
        version: CLI_VERSION,
        buildDigest,
        platform: process.platform,
        architecture: process.arch,
        apiOrigin: config.baseUrl,
        apiOriginSource: config.baseUrlSource,
        apiOriginIsCanonical: config.baseUrl === DEFAULT_BASE_URL,
        updateChannel: ARTIFACT_CHANNEL,
        artifactChannel: ARTIFACT_CHANNEL,
        protocolRange: PROTOCOL_RANGE,
        checks,
      });
      if (!ok) {
        throw new CunaError({
          code: "cuna.self_test.failed",
      hint: `The installed CLI does not match its own build record. Reinstall the local Cuna .tgz package, and report it at ${SUPPORT_URL} if it recurs.`,
          message: "The installed Cuna CLI failed an offline integrity check.",
          exitCode: EXIT_CODES.internal,
          details: {
            failed_checks: Object.entries(checks)
              .filter(([, value]) => value !== true && value !== 0)
              .map(([name]) => name)
              .join(","),
          },
        });
      }
      return Object.freeze({
        command: "self-test",
        data,
        human: "Offline self-test passed: installation integrity only. It does not check runtime feature availability — run `cuna doctor` for that.",
      });
    }
    default:
      throw usageError(`Unknown command ${parsed.command ?? "<none>"}.`, "Run `cuna --help`.");
  }
}

async function verifyVirtualTerminalInterop(): Promise<boolean> {
  let viewport: import("../terminal/xterm-vte.js").XtermViewportAdapter | undefined;
  try {
    const [{ ViewportRegistry }, { XtermViewportAdapter }] = await Promise.all([
      import("../terminal/viewport.js"),
      import("../terminal/xterm-vte.js"),
    ]);
    const registry = new ViewportRegistry();
    viewport = new XtermViewportAdapter({
      tabId: "offline-self-test",
      binding: {
        userId: "offline",
        machineId: "offline",
        agentSessionId: "offline",
        processEpoch: "offline",
        fencingGeneration: 1,
      },
      columns: 20,
      rows: 2,
      scrollback: 0,
      registry,
    });
    const snapshot = await viewport.write(new TextEncoder().encode("cuna"), 1n, 1n);
    return snapshot.cells[0] === "cuna";
  } catch {
    return false;
  } finally {
    viewport?.dispose();
  }
}

/**
 * Where this installation keeps its note about an in-place update it dispatched
 * and never saw settle.
 *
 * The adapter is optional on `CommandContext`, and its absence is a refusal
 * rather than a silent fall-through: dispatching a mutation this command could
 * not record would leave the next invocation free to repeat it.
 */
function liveUpdateNotesFor(
  context: CommandContext,
  platform: PlatformAdapter | undefined,
): LiveSupervisorUpdateNotes {
  // Two conditions, one refusal. The adapter may be absent entirely, or it may
  // predate the exclusive-create primitive the reservation is built on — and a
  // store that can only read-then-write is not a reservation at all.
  if (platform === undefined || typeof platform.createExclusiveConfig !== "function") {
    throw new CunaError({
      code: "cuna.machine.live_supervisor_update_unrecordable",
      message: "Cuna cannot record an in-place supervisor update on this host.",
      exitCode: EXIT_CODES.internal,
      hint: "Nothing was sent. This command reserves a local record before it dispatches, so that a second invocation cannot repeat an update whose outcome is unknown, and it will not start one it cannot reserve.",
      details: { reason: platform === undefined ? "no_platform_adapter" : "no_exclusive_reservation" },
    });
  }
  // Scoped by the API origin alone. The profile is deliberately absent: the
  // suppression protects a Machine, and selecting a different local profile
  // against the same API must not clear it.
  return liveSupervisorUpdateNotes(platform, { baseUrl: context.config.baseUrl });
}

function outstandingLiveUpdate(
  machineId: string,
  operationId: string,
  dispatchedAt: string,
): CunaError {
  return new CunaError({
    code: "cuna.machine.live_supervisor_update_outcome_unknown",
    message: `An in-place supervisor update for Machine ${machineId} dispatched at ${dispatchedAt} has no known outcome on this computer.`,
    exitCode: EXIT_CODES.conflict,
    // The authoritative read comes first now, because one exists. It sends
    // nothing to the Machine and is the only thing that can say what this
    // operation did. Starting a NEW update is still absent from this list, and
    // so is switching profiles: the record covers this Machine on this API for
    // every profile.
    hint: `Read it with \`cuna machines live-update-status ${machineId}\`, which sends nothing to the Machine. If it reports next_action repeat_same_operation, resolve it with \`cuna machines live-update-supervisor ${machineId} --resume\`, which re-sends this same operation ${operationId} and never rotates control a second time. Cuna will not start a different update to find out, and another profile on this computer will not either.`,
    retryable: false,
    details: {
      machine_id: machineId,
      operation_id: operationId,
      dispatched_at: dispatchedAt,
      outcome: "unknown",
    },
  });
}

/**
 * What the producer's own record says about an operation whose answer was lost.
 *
 * Called only from the refusal path, and deliberately best-effort: it is one
 * bounded read that dispatches no installer, and a read that itself fails must
 * never replace the refusal the caller is owed with a story about a second
 * request. `undefined` means "this CLI could not ask", which is not "nothing
 * happened".
 */
async function reconcileLiveUpdateOperation(
  client: CommandContext["client"],
  machineId: string,
  operationId: string,
): Promise<SupervisorLiveUpdateOperation | undefined> {
  const answer = await readLiveUpdateOperationAnswer(client, machineId, operationId);
  return answer.state === "read" ? answer.operation : undefined;
}

/**
 * The three answers the recovery read can give, kept apart.
 *
 * `absent` used to be folded into "could not read", and that single fact is the
 * difference between two opposite conclusions: for an identity this process
 * just minted it PROVES the producer journalled nothing, while for a recorded
 * one it may only mean the signed-in account cannot see it. A caller that
 * cannot tell them apart can only ever refuse both, which is what stranded the
 * record.
 */
type LiveUpdateOperationAnswer =
  | Readonly<{ state: "read"; operation: SupervisorLiveUpdateOperation }>
  /** The producer has no operation with this identity, for this owner. */
  | Readonly<{ state: "absent" }>
  /** This CLI could not ask. Never read as either of the above. */
  | Readonly<{ state: "unavailable" }>;

async function readLiveUpdateOperationAnswer(
  client: CommandContext["client"],
  machineId: string,
  operationId: string,
): Promise<LiveUpdateOperationAnswer> {
  try {
    return Object.freeze({
      state: "read" as const,
      operation: await client.readMachineSupervisorInPlaceUpdate(machineId, operationId),
    });
  } catch (error) {
    const reason = error instanceof CunaError ? error.details?.["reason"] : undefined;
    if (reason === "resource_not_found") return Object.freeze({ state: "absent" as const });
    return Object.freeze({ state: "unavailable" as const });
  }
}

/** The per-AgentSession rows a record and a human line are both built from. */
function liveUpdateSessionRecords(
  sessions: readonly { readonly agentSessionId: string; readonly processEpoch: string; readonly outcome?: string }[],
): readonly Record<string, unknown>[] {
  return Object.freeze(sessions.map((session) => Object.freeze({
    agent_session_id: session.agentSessionId,
    process_epoch: session.processEpoch,
    ...(session.outcome === undefined ? {} : { outcome: session.outcome }),
  })));
}

/**
 * One operation, as a record and as prose.
 *
 * Two rules it holds and a renderer would otherwise be free to break: a
 * withheld per-session account is stated as withheld rather than expanded into
 * `unknown` outcomes, and `installed_at` is described by its evidence, because
 * `reconciled` says when Cuna LOOKED and not when the artifact arrived.
 */
function liveUpdateOperationReport(
  operation: SupervisorLiveUpdateOperation,
  machineId: string,
): { readonly data: Record<string, unknown>; readonly lines: readonly string[] } {
  const reading = readLiveSupervisorUpdateOperation(operation);
  const data: Record<string, unknown> = {
    machine_id: machineId,
    operation_id: operation.operationId,
    phase: operation.phase,
    control_rotated: operation.controlRotated,
    installer_outcome: operation.installerOutcome,
    ...(operation.controlGeneration === undefined
      ? {}
      : { control_generation: operation.controlGeneration }),
    ...(operation.artifactSha256 === undefined ? {} : { artifact_sha256: operation.artifactSha256 }),
    ...(operation.installedAt === undefined ? {} : { installed_at: operation.installedAt }),
    ...(operation.installationEvidence === undefined
      ? {}
      : { installation_evidence: operation.installationEvidence }),
    declared_sessions: liveUpdateSessionRecords(operation.declaredSessions),
    agent_sessions: liveUpdateSessionRecords(operation.sessions),
    session_account_withheld: reading.accountWithheld,
    ...(operation.failure === undefined
      ? {}
      : {
        failure: Object.freeze({
          status: operation.failure.status,
          code: operation.failure.code,
          title: operation.failure.title,
          detail: operation.failure.detail,
          retryable: operation.failure.retryable,
          action: operation.failure.action,
        }),
      }),
    next_action: operation.nextAction,
    claimed_at: operation.claimedAt,
    updated_at: operation.updatedAt,
    ...(operation.settledAt === undefined ? {} : { settled_at: operation.settledAt }),
    ...(operation.retiredAt === undefined ? {} : { retired_at: operation.retiredAt }),
    ...(operation.retirementOutcome === undefined
      ? {}
      : { retirement_outcome: operation.retirementOutcome }),
    // The fence, as a decided value rather than two nullable fields a caller
    // has to combine. `installer_can_still_act` is the one an automated caller
    // needs before touching this Machine, and it is false ONLY on the producer's
    // own evidence -- never inferred from the phase or from a running Machine.
    installer_reach: reading.installerReach,
    installer_can_still_act: reading.installerCanStillAct,
    // Stated in the record because a caller reading only `--json` gets no prose,
    // and because this is the sentence the producer is most emphatic about.
    machine_running_implies_installed: false,
    // The same rule one layer out: the fence's record of an admitted installer
    // that finished is not Cuna's observation of an installation, and only
    // `installer_outcome` is that.
    retirement_outcome_implies_installed: false,
  };
  const lines = [
    `Operation ${operation.operationId} on Machine ${machineId}.`,
    `Phase ${liveSupervisorUpdatePhaseLabel(operation.phase)}.`,
    `Installer ${liveSupervisorInstallerOutcomeLabel(operation.installerOutcome, reading.installerReach)}.`,
    operation.controlRotated
      ? "This Machine's supervisor control HAS rotated for this update. That is irreversible and stays true even if nothing was installed."
      : "This Machine's supervisor control has not rotated for this update.",
    ...(operation.artifactSha256 === undefined
      ? ["No supervisor artifact is bound to this operation yet."]
      : [`Target artifact ${operation.artifactSha256}.`]),
    ...(operation.controlGeneration === undefined
      ? []
      : [`Control generation ${operation.controlGeneration}.`]),
    ...(operation.installedAt === undefined || operation.installationEvidence === undefined
      ? []
      : [`Installation established ${operation.installedAt} by ${liveSupervisorInstallationEvidenceLabel(operation.installationEvidence)}.`]),
    reading.declared === 0
      ? "This operation has not bound the AgentSessions it is accountable for."
      : `It measured ${reading.declared} AgentSession${reading.declared === 1 ? "" : "s"}:`,
    ...operation.declaredSessions.map((session) =>
      `  ${session.agentSessionId} process epoch ${session.processEpoch}`),
    ...(reading.accountWithheld
      ? ["Cuna has settled no per-AgentSession account for this operation. That is an answer it has not given, not a set of unknown outcomes."]
      : reading.accounted === 0
        ? []
        : [
          `Per-AgentSession account, ${reading.accounted} of ${reading.declared} measured:`,
          ...operation.sessions.map((session) =>
            `  ${session.agentSessionId} ${liveSupervisorSessionOutcomeLabel(session.outcome)}`),
        ]),
    ...(operation.failure === undefined
      ? []
      : [`Recorded refusal ${operation.failure.code} (HTTP ${operation.failure.status}): ${operation.failure.title}. ${operation.failure.detail}`]),
    "A running Machine is not evidence that this update did or did not apply. This read is.",
    // The install fence, ordered after the refusal and before the next action:
    // it is what decides whether "nothing further will change it" also means
    // "nothing further will change this Machine because of it".
    ...(operation.retiredAt === undefined
      ? []
      : [`Installer retired on the Machine ${operation.retiredAt}.`]),
    ...liveSupervisorInstallerReachLines(reading, machineId),
    reading.mayRepeatSameOperation
      ? `Next action: repeat this same operation. Run \`cuna machines live-update-supervisor ${machineId} --resume\`. Starting a different update is refused while this one is open.`
      : "Next action: none. This operation is settled and nothing further will change it.",
  ];
  return Object.freeze({ data, lines: Object.freeze(lines) });
}

/**
 * `machines live-update-supervisor` — the running-Machine supervisor update.
 *
 * The three rules that shape this function, in the order they bind:
 *
 *   1. Preservation is conditional on the SERVER's preflight, never on anything
 *      read here. The local state check below is a cheap refusal that names the
 *      other command; it is not the authority and does not weaken one.
 *   2. A 200 is an account, not a success. Every AgentSession outcome is
 *      reported, and anything other than `preserved` is said plainly.
 *   3. An outcome this process did not learn is `unknown`. It is never retried,
 *      never reconciled with a second mutation, and never resolved by falling
 *      back to the stopped-Machine replacement.
 */
async function executeLiveUpdateSupervisor(context: CommandContext): Promise<CommandResult> {
  const { parsed, client, now } = context;
  const { intent } = preflightLiveUpdateSupervisor(parsed);
  const id = assertMachineId(requireOperand(parsed.operands, 1, "machine ID"));
  const notes = liveUpdateNotesFor(context, context.platform);

  if (intent === "forget-unknown") return clearLiveUpdateRecord(context, notes, id);

  const reading = await notes.read(id);
  if (reading.state === "unreadable") {
    // Fail closed and name the way out, for both sending intents. The record may
    // describe a dispatch that is still in flight, so this is not a corrupt file
    // to step over -- and Cuna cannot read an operation identity out of it, so
    // there is nothing to resume either.
    throw new CunaError({
      code: "cuna.machine.live_supervisor_update_record_unreadable",
      message: `This computer holds a supervisor update record for Machine ${id} that Cuna cannot read.`,
      exitCode: EXIT_CODES.conflict,
      hint: `Nothing was sent. That record may describe an update whose outcome is still unknown, and Cuna cannot read the operation identity out of it to ask. Clear it with \`cuna machines live-update-supervisor ${id} --forget-unknown\`, which works on an unreadable record, and read \`cuna machines list\` and \`cuna agent-sessions list --machine ${id}\` before starting another update.`,
      retryable: false,
      details: {
        machine_id: id,
        record_path: reading.path,
        reason: reading.reason,
        outcome: "unknown",
      },
    });
  }

  if (intent === "resume") {
    // A caller-known identity, for an update this computer never recorded. The
    // cross-client half of recovery: an owner who started one in the console, or
    // on another computer, holds its id and nothing else.
    const named = stringOption(parsed, "operation");
    if (named === undefined && reading.state === "none") {
      throw new CunaError({
        code: "cuna.machine.live_supervisor_update_nothing_to_resume",
        message: `This computer holds no in-place supervisor update record for Machine ${id}.`,
        exitCode: EXIT_CODES.conflict,
        hint: `Nothing was sent. --resume re-sends an operation identity, and there is none recorded for ${id} on ${context.config.baseUrl}. An update started from another computer or from the web console has an identity this CLI never held: name it with \`cuna machines live-update-supervisor ${id} --resume --operation UUID\`, or read it first with \`cuna machines live-update-status ${id} --operation UUID\`. To start a new update, run \`cuna machines live-update-supervisor ${id} --yes\`.`,
        retryable: false,
        details: { machine_id: id, outcome: "not_sent" },
      });
    }
    if (named !== undefined && reading.state === "outstanding" && reading.note.operationId !== named) {
      // A live reservation for a different identity. It is not this command's
      // to overwrite, and the exclusive create below would refuse anyway.
      throw new CunaError({
        code: "cuna.machine.live_supervisor_update_already_reserved",
        message: `This computer is already holding in-place supervisor update ${reading.note.operationId} for Machine ${id}.`,
        exitCode: EXIT_CODES.conflict,
        hint: `Nothing was sent. Resolve the update this computer recorded before taking on another: read it with \`cuna machines live-update-status ${id}\`. Two updates must never rotate one Machine's control at once.`,
        retryable: false,
        details: {
          machine_id: id,
          operation_id: reading.note.operationId,
          requested_operation_id: named,
          outcome: "not_sent",
        },
      });
    }
    const operationId = named ?? (reading as Extract<LiveSupervisorUpdateReading, { state: "outstanding" }>).note.operationId;

    /* Read the authoritative status BEFORE repeating anything. Two reasons, and
       the second is the one a reviewer drove out:
         - the producer's own `next_action` is what says a repeat resolves this,
           so offering one without asking would be the client deciding;
         - a repeat of an identity the producer never journalled is that
           identity's FIRST admission and runs a whole update. Calling that a
           "repeat" was true of the command and false of the effect. */
    const status = await readLiveUpdateOperationAnswer(client, id, operationId);
    if (status.state === "absent") {
      /* A not-found is two facts, and only the record's own account label tells
         them apart. The SAME account can see its own operations, so this really
         is "never admitted". A different account, or a record that names none,
         and a caller-supplied identity that no record backs, are all cases where
         the operation may exist and simply be out of view -- and saying it was
         never admitted there would be the false half of the same coin the
         reviewer caught on the other side. */
      const recordAccount = reading.state === "outstanding" ? reading.note.account : undefined;
      const signedIn = await liveUpdateAccountLabel(client);
      const neverAdmitted =
        named === undefined && recordAccount !== undefined && signedIn !== undefined &&
        recordAccount === signedIn;
      throw new CunaError({
        code: neverAdmitted
          ? "cuna.machine.live_supervisor_update_nothing_to_resume"
          : "cuna.machine.live_supervisor_update_operation_inaccessible",
        message: neverAdmitted
          ? `Cuna has no in-place supervisor update ${operationId} for Machine ${id} under this account, which is the account that recorded it.`
          : `The signed-in account cannot read in-place supervisor update ${operationId} on Machine ${id}.`,
        exitCode: EXIT_CODES.conflict,
        hint: neverAdmitted
          ? `Nothing was sent. There is nothing to resume: this identity was never admitted, so re-sending it would be a NEW update's first admission rather than finishing one -- and Cuna will not do that under a flag that says "resume". Clear the record with \`cuna machines live-update-supervisor ${id} --forget-unknown\`, then start one with \`--yes\`.`
          : `Nothing was sent, and this is NOT evidence that the operation never existed: Cuna answers an operation outside this account's view exactly as it answers one that never existed. ${
            recordAccount === undefined
              ? "This computer's record does not name the account that filed it."
              : `This computer's record was filed under account ${recordAccount}.`
          } Check the signed-in account with \`cuna whoami\`, sign in as the Machine's owner, then read it with \`cuna machines live-update-status ${id}${named === undefined ? "" : ` --operation ${operationId}`}\`.`,
        retryable: false,
        details: {
          machine_id: id,
          operation_id: operationId,
          outcome: neverAdmitted ? "not_sent" : "inaccessible",
          local_record_cleared: false,
          ...(neverAdmitted ? { operation_admitted: false } : {}),
          ...(recordAccount === undefined ? {} : { record_account: recordAccount }),
          ...(signedIn === undefined ? {} : { signed_in_account: signedIn }),
        },
      });
    }
    if (status.state === "read" && status.operation.nextAction === "none") {
      const report = liveUpdateOperationReport(status.operation, id);
      // Settled: repeating returns this same recorded answer, so the honest
      // action is to show it and release the record rather than re-send.
      if (reading.state === "outstanding" && reading.note.operationId === operationId) {
        await notes.settle(id, operationId);
      }
      return Object.freeze({
        command: "machines.live-update-status",
        data: Object.freeze({
          ...report.data,
          operation_id_source: named === undefined ? "local_record" : "named",
          dispatched_installer: false,
          server_state_changed: false,
          resumed: false,
        }),
        human: [
          "Nothing was re-sent: this update is settled, and repeating it would return this same recorded answer.",
          ...report.lines,
        ].join("\n"),
      });
    }

    /* A caller-known identity needs the same reservation every dispatch takes,
       so a concurrent invocation cannot send it at the same moment. An identity
       this computer already records IS the reservation, and re-reserving it
       would lose to itself. */
    let recordedAccount = reading.state === "outstanding" ? reading.note.account : undefined;
    if (reading.state === "none") {
      const account = await liveUpdateAccountLabel(client);
      const reserved = await notes.reserve(id, operationId, new Date(now).toISOString(), account);
      if (reserved === undefined) {
        throw new CunaError({
          code: "cuna.machine.live_supervisor_update_already_reserved",
          message: `Another Cuna process on this computer is already updating the supervisor of Machine ${id}.`,
          exitCode: EXIT_CODES.conflict,
          hint: "Nothing was sent. Let that invocation finish and read its answer; two in-place updates of one Machine must not run together.",
          retryable: false,
          details: { machine_id: id, operation_id: operationId, outcome: "not_sent" },
        });
      }
      recordedAccount = account;
    }
    // No fresh identity: the whole point of this path is that it does not
    // change. The producer fences concurrent advances of one identity itself,
    // and refuses outright to issue a second enrollment under it.
    return dispatchLiveUpdate(context, notes, id, {
      operationId,
      dispatchedAt: reading.state === "outstanding" ? reading.note.dispatchedAt : new Date(now).toISOString(),
      origin: "recorded_identity",
      ...(recordedAccount === undefined ? {} : { recordedAccount }),
    });
  }

  if (reading.state === "outstanding") {
    throw outstandingLiveUpdate(id, reading.note.operationId, reading.note.dispatchedAt);
  }

  // The same `machines:update` authority the stopped-boundary replacement takes.
  // The deliberately unsupported AgentSession-create capability is NOT
  // substituted for it: this operation is not an OpenCode remediation.
  await requireCapability({
    client, scope: "machine", resourceId: id, capabilityId: "machines.lifecycle",
    now: context.capabilityClock ?? now,
  });
  const current = await client.getMachine(id);
  if (current.state !== "running") {
    throw new CunaError({
      code: "cuna.machine.live_supervisor_update_requires_running",
      message: "The in-place supervisor update replaces the supervisor while the Machine keeps running.",
      exitCode: EXIT_CODES.conflict,
      hint: `Cuna will not start ${current.name} to satisfy this command. For a stopped Machine use \`cuna machines update-supervisor ${id} --yes\`, which is the separate stopped-boundary action.`,
      details: { machine_id: id, observed_state: current.state },
    });
  }

  // Chosen HERE, before anything is sent, because a caller that learns its
  // operation identity from the response cannot use it when the response is the
  // thing that was lost.
  const operationId = randomUUID();
  const dispatchedAt = new Date(now).toISOString();
  // A label, recorded only because the two reads above already established that
  // the API is answering, and never consulted to admit anything. It exists for
  // one sentence: when a later read of this record is refused as not-found, the
  // owner is told the record was filed under a different account rather than
  // that the operation never existed.
  const account = await liveUpdateAccountLabel(client);
  // The reservation is the gate, not the read above. Between that read and this
  // line another process on this computer may have taken the slot, and only an
  // exclusive create can say which of them did. `undefined` means it lost.
  const reserved = await notes.reserve(id, operationId, dispatchedAt, account);
  if (reserved === undefined) {
    const rival = await notes.read(id);
    throw rival.state === "outstanding"
      ? outstandingLiveUpdate(id, rival.note.operationId, rival.note.dispatchedAt)
      : new CunaError({
        code: "cuna.machine.live_supervisor_update_already_reserved",
        message: `Another Cuna process on this computer is already updating the supervisor of Machine ${id}.`,
        exitCode: EXIT_CODES.conflict,
        hint: "Nothing was sent. Let that invocation finish and read its answer; two in-place updates of one Machine must not run together.",
        retryable: false,
        details: { machine_id: id, outcome: "not_sent" },
      });
  }
  return dispatchLiveUpdate(context, notes, id, {
    operationId,
    dispatchedAt,
    origin: "new_identity",
    ...(account === undefined ? {} : { recordedAccount: account }),
  });
}

/**
 * The account this dispatch is filed under, when asking costs nothing.
 *
 * Best effort on purpose. A label that cannot be fetched is omitted, never
 * waited for and never a reason to refuse: the record must stay writable in
 * exactly the state it exists for, and this runs only after two successful
 * reads have already established that the API is answering.
 */
async function liveUpdateAccountLabel(
  client: CommandContext["client"],
): Promise<string | undefined> {
  try {
    return (await client.getIdentity()).id;
  } catch {
    return undefined;
  }
}

type LiveUpdateDispatch = Readonly<{
  operationId: string;
  dispatchedAt: string;
  origin: LiveSupervisorUpdateIdentityOrigin;
  /** The account the record names, when it names one. Evidence, never authority. */
  recordedAccount?: string;
}>;

/**
 * Send one in-place update under an identity that is already recorded.
 *
 * Shared by the two intents that send, because the only difference between them
 * is where the identity came from -- and that difference is carried explicitly
 * in `origin` rather than re-derived, because it decides whether a not-found
 * answer means "nothing was admitted" or "this account cannot see it".
 */
async function dispatchLiveUpdate(
  context: CommandContext,
  notes: LiveSupervisorUpdateNotes,
  id: string,
  dispatch: LiveUpdateDispatch,
): Promise<CommandResult> {
  const { client } = context;
  const { operationId, origin } = dispatch;
  const repeat = origin === "recorded_identity";
  let result: SupervisorLiveUpdate;
  try {
    result = await client.updateMachineSupervisorInPlace(id, operationId);
  } catch (error) {
    let disposition = classifyLiveSupervisorUpdateFailure(error, origin);
    // Dropping the note is bookkeeping; the outcome is the answer. A local
    // filesystem fault must never replace the producer's own refusal with a
    // story about this computer's state directory, and a note that survives
    // fails in the safe direction.
    //
    // Bound to THIS identity: `settle` removes the record only when the record
    // names the operation this invocation sent. A record another process wrote
    // is not ours to remove.
    const drop = async (): Promise<void> => {
      try { await notes.settle(id, operationId); } catch { /* the outcome below is the answer */ }
    };
    if (disposition === "not_admitted_machine_busy") {
      /* The producer's claim ordering says nothing was journalled under this
         identity, and the producer itself can confirm it. One bounded read that
         dispatches no installer and changes no state turns a reading of the
         ordering into an answer before a record is released. Only `absent` is
         that answer; a row, or a read that could not ask, keeps the record. */
      const answer = await readLiveUpdateOperationAnswer(client, id, operationId);
      if (answer.state !== "absent") disposition = "operation_conflict";
    }
    if (!liveSupervisorUpdateRecordSurvives(disposition, origin)) {
      await drop();
      // Nothing was admitted under an identity this process had just minted, so
      // the producer's own words are already the best available explanation.
      if (disposition === "not_admitted") throw error;
      if (disposition === "not_admitted_machine_busy") {
        throw new CunaError({
          code: "cuna.machine.live_supervisor_update_machine_busy",
          message: `Another in-place supervisor update is already running on Machine ${id}.`,
          exitCode: EXIT_CODES.conflict,
          hint: `Nothing was sent to this Machine and Cuna recorded no update for you: it refused before admitting one, and confirmed by reading that it has no operation ${operationId}. Two updates must never rotate one Machine's control at once. Read the one that is running with \`cuna machines live-update-status ${id} --operation UUID\` if you know its identity, and start yours again once it settles.`,
          retryable: true,
          details: { machine_id: id, operation_id: operationId, outcome: "not_admitted", local_record_cleared: true },
          cause: error,
        });
      }
      throw new CunaError({
        code: disposition === "applied_with_ended_sessions"
          ? "cuna.machine.live_supervisor_update_ended_sessions"
          : "cuna.machine.live_supervisor_update_control_rotated",
        message: disposition === "applied_with_ended_sessions"
          ? `The in-place supervisor update on Machine ${id} was installed and ended AgentSessions.`
          : `The in-place supervisor update on Machine ${id} rotated its supervisor control and installed nothing.`,
        exitCode: EXIT_CODES.conflict,
        hint: `${error instanceof CunaError && error.hint !== undefined ? error.hint : "The update cannot be undone."} This operation is settled, so repeating this identity returns this same answer. Read \`cuna agent-sessions list --machine ${id}\`.`,
        retryable: false,
        details: { machine_id: id, operation_id: operationId, outcome: disposition },
        cause: error,
      });
    }
    // The record stays. Before reporting an unknown effect, ask the one thing
    // that can answer: a read that dispatches no installer and changes no state.
    // "Reconcile uncertain mutations before retrying" is the rule; this is the
    // reconciliation, and it is bounded to a single request.
    const reconciled = await reconcileLiveUpdateOperation(client, id, operationId);
    if (reconciled !== undefined) {
      const report = liveUpdateOperationReport(reconciled, id);
      const settled = reconciled.phase === "settled";
      if (settled) await drop();
      throw new CunaError({
        code: settled
          ? "cuna.machine.live_supervisor_update_settled_refusal"
          : "cuna.machine.live_supervisor_update_outcome_unknown",
        message: settled
          ? `In-place supervisor update ${operationId} on Machine ${id} is settled, and its recorded answer is a refusal.`
          : `In-place supervisor update ${operationId} on Machine ${id} has not settled.`,
        exitCode: EXIT_CODES.conflict,
        hint: `${report.lines.join(" ")} ${settled
          ? "This computer's record was cleared because the operation is terminal."
          : "This computer keeps the record, so the identity survives."}`,
        retryable: false,
        details: {
          operation_outcome: settled ? "settled" : "open",
          local_record_cleared: settled,
          ...report.data,
        },
        cause: error,
      });
    }
    if (disposition === "operation_inaccessible") {
      throw new CunaError({
        code: "cuna.machine.live_supervisor_update_operation_inaccessible",
        message: `The signed-in account cannot read in-place supervisor update ${operationId} on Machine ${id}.`,
        exitCode: EXIT_CODES.conflict,
        hint: `Nothing on this Machine was changed by this attempt, and this is NOT evidence that the operation never existed: Cuna answers an unowned Machine and an operation outside this account's view with the same not-found. ${
          dispatch.recordedAccount === undefined
            ? "This computer's record does not name the account that filed it."
            : `This computer's record was filed under account ${dispatch.recordedAccount}.`
        } Check the signed-in account with \`cuna whoami\`, sign in as the owner, then read it with \`cuna machines live-update-status ${id}\`. The record is kept, so the identity survives.`,
        retryable: false,
        details: {
          machine_id: id,
          operation_id: operationId,
          outcome: "inaccessible",
          local_record_cleared: false,
          ...(dispatch.recordedAccount === undefined ? {} : { record_account: dispatch.recordedAccount }),
        },
        cause: error,
      });
    }
    // The read did not answer either. The record stays exactly where it is.
    throw outstandingLiveUpdate(id, operationId, dispatch.dispatchedAt);
  }

  const summary = summarizeLiveSupervisorUpdate(result);
  // A 200 the producer only emits with every session decided. If a deployment
  // ever answers 200 with an `unknown` in it, that is still an outcome this
  // computer does not know, so the note survives and the result says so.
  if (!summary.anyUnknown) await notes.settle(id, operationId);

  const sessions = result.sessions.map((session) => Object.freeze({
    agent_session_id: session.agentSessionId,
    process_epoch: session.processEpoch,
    outcome: session.outcome,
  }));
  const lines = result.sessions.map((session) =>
    `  ${session.agentSessionId} ${liveSupervisorSessionOutcomeLabel(session.outcome)}`);
  const subject = repeat
    ? `Cuna resolved the in-place supervisor update it had already sent for ${result.machine.name}`
    : `Cuna installed a new terminal supervisor on ${result.machine.name} without stopping it`;
  const headline = summary.total === 0
    ? `${subject}. No AgentSession existed on it, so nothing was preserved or lost.`
    : summary.allPreserved
      ? `${subject}, and all ${summary.total} AgentSessions were preserved.`
      : `${subject}. ${summary.preserved} of ${summary.total} AgentSessions were preserved; this update is not complete.`;
  return Object.freeze({
    command: "machines.live-update-supervisor",
    data: Object.freeze({
      machine: machineRecord(result.machine),
      operation_id: result.operationId,
      // What this invocation did with the identity, which a caller reading only
      // `--json` cannot otherwise tell apart -- and which is the difference
      // between spending a control generation and not spending one.
      dispatch: repeat ? "repeat_same_operation" : "new_operation",
      control_generation: result.controlGeneration,
      artifact_sha256: result.artifactSha256,
      installed_at: result.installedAt,
      agent_sessions: Object.freeze(sessions),
      summary: Object.freeze({
        total: summary.total,
        preserved: summary.preserved,
        exited: summary.exited,
        ended: summary.ended,
        unknown: summary.unknown,
        all_preserved: summary.allPreserved,
      }),
      // An installed supervisor is software, not an authorization. Stated in the
      // record because a caller reading only `--json` gets no prose.
      grants_observation_or_control: false,
      establishes_provider_login: false,
    }),
    human: [
      headline,
      ...(repeat
        ? [`This re-sent operation ${result.operationId}, the one this computer had already recorded. It did not start a second update and did not rotate this Machine's control again.`]
        : [`Operation ${result.operationId}.`]),
      `Control generation ${result.controlGeneration}, artifact ${result.artifactSha256}, installed ${result.installedAt}.`,
      ...(lines.length === 0 ? [] : ["AgentSession custody:", ...lines]),
      "This installed software only. It grants no observation or control of any AgentSession and signs no provider in.",
      ...(summary.anyUnknown
        ? [`Cuna could not re-read ${summary.unknown} of ${summary.total} AgentSessions, so this computer's record of this update stays open. Read it with \`cuna machines live-update-status ${id}\`.`]
        : []),
    ].join("\n"),
  });
}

/**
 * `--forget-unknown`, and why it now asks before it forgets.
 *
 * It used to be a person saying "I have looked and I am done with this record",
 * and that was honest while the record held nothing but a timestamp: there was
 * no identity to lose and no read that could resolve it.
 *
 * The record now holds the operation identity, and that changes what discarding
 * it costs. An unsettled operation still holds the Machine on the producer's
 * side -- every DIFFERENT identity is refused until it settles, and the only
 * thing that settles it is a repeat of the identity in this file. Clearing it
 * while it is open does not free the Machine; it strands it, with no way to
 * resume and no way to start afresh. So this path reads the operation first and
 * clears only what is terminal.
 *
 * That read is also what prevents clearing an ACTIVELY EXECUTING reservation,
 * without inventing an age threshold or a liveness file that could go stale: an
 * attempt in flight is by construction not settled, and a settled operation has
 * no attempt whose effect is still open.
 *
 * Two things it still clears without asking anyone: bytes that carry no
 * identity to ask about, and nothing at all.
 */
async function clearLiveUpdateRecord(
  context: CommandContext,
  notes: LiveSupervisorUpdateNotes,
  id: string,
): Promise<CommandResult> {
  const { client } = context;
  const reading = await notes.read(id);
  const unchanged = "Nothing was sent to the Machine by this command, and clearing a record is not a cancellation.";
  if (reading.state === "none") {
    return Object.freeze({
      command: "machines.live-update-supervisor",
      data: Object.freeze({
        machine_id: id,
        local_record_cleared: false,
        record_readable: true,
        server_state_changed: false,
        scope: "api_origin_and_machine",
      }),
      human: `No local record of an in-place supervisor update exists for Machine ${id} on ${context.config.baseUrl}. Nothing was sent and nothing changed.`,
    });
  }
  if (reading.state === "unreadable") {
    const removed = await notes.discard(id);
    return Object.freeze({
      command: "machines.live-update-supervisor",
      data: Object.freeze({
        machine_id: id,
        local_record_cleared: removed,
        record_readable: false,
        unreadable_reason: reading.reason,
        server_state_changed: false,
        scope: "api_origin_and_machine",
      }),
      human: `Cleared an unreadable local record for Machine ${id} (${reading.reason}). It carried no operation identity, so there is nothing Cuna could have read about it and nothing an update could still have been resumed with. ${unchanged}`,
    });
  }

  const { operationId, dispatchedAt } = reading.note;
  const answer = await readLiveUpdateOperationAnswer(client, id, operationId);
  if (answer.state === "absent") {
    /* The producer has no operation with this identity. That is two different
       facts depending on WHO asked, and the record's own account label is what
       tells them apart -- evidence, never authority, exactly as it has always
       been used here.
         Same account: this owner can see their own operations, so there is
       genuinely none under this identity. Nothing was admitted, nothing can be
       resumed, and refusing to clear it would strand the Machine for no reason.
         Different or unrecorded account: the producer answers an operation
       outside the caller's view exactly as it answers one that never existed,
       so this says nothing about whether the owner's operation exists. The
       record stays. */
    const signedIn = await liveUpdateAccountLabel(client);
    const sameAccount =
      reading.note.account !== undefined && signedIn !== undefined && reading.note.account === signedIn;
    if (!sameAccount) {
      throw new CunaError({
        code: "cuna.machine.live_supervisor_update_record_unresolved",
        message: `The signed-in account cannot see in-place supervisor update ${operationId} on Machine ${id}, so Cuna kept this computer's record of it.`,
        exitCode: EXIT_CODES.conflict,
        hint: `The record was NOT cleared, and that is the safe direction: a not-found answer here does not mean the operation is gone, because Cuna answers an unowned Machine and an operation outside this account's view the same way. ${
          reading.note.account === undefined
            ? "This record does not name the account that filed it, so Cuna cannot tell the two apart."
            : `This record was filed under account ${reading.note.account}.`
        } Check the signed-in account with \`cuna whoami\`, sign in as the owner, then read it with \`cuna machines live-update-status ${id}\`.`,
        retryable: false,
        details: {
          machine_id: id,
          operation_id: operationId,
          dispatched_at: dispatchedAt,
          local_record_cleared: false,
          ...(reading.note.account === undefined ? {} : { record_account: reading.note.account }),
          ...(signedIn === undefined ? {} : { signed_in_account: signedIn }),
        },
      });
    }
    const removedAbsent = await notes.settle(id, operationId);
    return Object.freeze({
      command: "machines.live-update-supervisor",
      data: Object.freeze({
        machine_id: id,
        operation_id: operationId,
        local_record_cleared: removedAbsent === "settled",
        record_readable: true,
        dispatched_at: dispatchedAt,
        account: reading.note.account,
        operation_admitted: false,
        server_state_changed: false,
        scope: "api_origin_and_machine",
      }),
      human: [
        `Cuna has no in-place supervisor update ${operationId} for Machine ${id} under this account, which is the account this record was filed by, so the record was cleared.`,
        "That identity was never admitted: nothing was installed, no supervisor control was issued, and nothing on this Machine was changed by it. Starting a new update is now possible again.",
        unchanged,
      ].join("\n"),
    });
  }
  if (answer.state === "unavailable") {
    throw new CunaError({
      code: "cuna.machine.live_supervisor_update_record_unresolved",
      message: `Cuna could not read in-place supervisor update ${operationId} on Machine ${id}, so it kept this computer's record of it.`,
      exitCode: EXIT_CODES.conflict,
      hint: `The record was NOT cleared, and that is the safe direction: while that operation is open the producer refuses every different update identity for this Machine, so clearing this would leave nothing able to resume it and nothing able to replace it. Read it again with \`cuna machines live-update-status ${id}\`.`,
      retryable: true,
      details: {
        machine_id: id,
        operation_id: operationId,
        dispatched_at: dispatchedAt,
        local_record_cleared: false,
        ...(reading.note.account === undefined ? {} : { record_account: reading.note.account }),
      },
    });
  }
  const operation = answer.operation;
  const report = liveUpdateOperationReport(operation, id);
  if (operation.phase !== "settled") {
    throw new CunaError({
      code: "cuna.machine.live_supervisor_update_not_settled",
      message: `In-place supervisor update ${operationId} on Machine ${id} has not settled, so this computer's record of it was kept.`,
      exitCode: EXIT_CODES.conflict,
      hint: `${report.lines.join(" ")} The record was NOT cleared: it holds the only identity that can resolve this operation, and the producer refuses every different one until it does.`,
      retryable: false,
      details: { local_record_cleared: false, ...report.data },
    });
  }
  const removed = await notes.settle(id, operationId);
  return Object.freeze({
    command: "machines.live-update-supervisor",
    data: Object.freeze({
      local_record_cleared: removed === "settled",
      record_readable: true,
      dispatched_at: dispatchedAt,
      // Present only if the note carried the label. It is shown, never used.
      ...(reading.note.account === undefined ? {} : { account: reading.note.account }),
      server_state_changed: false,
      // The exclusion is keyed by API origin and Machine, so this is what was
      // cleared -- not "this profile's" record.
      scope: "api_origin_and_machine",
      ...report.data,
    }),
    human: [
      `Cuna read in-place supervisor update ${operationId} on Machine ${id} and it is settled, so this computer's record of it was cleared. That record covered every profile on this computer.`,
      ...report.lines,
      unchanged,
    ].join("\n"),
  });
}

/**
 * `machines live-update-status` -- the authoritative read, and the only thing
 * that can say what one in-place update did.
 *
 * It sends no mutation. The producer states that this route dispatches no
 * installer, sends nothing to the Machine and writes nothing, which is exactly
 * why it is safe to reach for after an interruption and why a second POST with
 * a new identity is not.
 */
async function executeLiveUpdateStatus(context: CommandContext): Promise<CommandResult> {
  const { parsed, client } = context;
  preflightLiveUpdateStatus(parsed);
  const id = assertMachineId(requireOperand(parsed.operands, 1, "machine ID"));
  const notes = liveUpdateNotesFor(context, context.platform);
  const named = stringOption(parsed, "operation");
  const reading = named === undefined ? await notes.read(id) : undefined;
  if (reading !== undefined && reading.state !== "outstanding") {
    throw new CunaError({
      code: "cuna.machine.live_supervisor_update_operation_unnamed",
      message: `Cuna does not know which in-place supervisor update to read for Machine ${id}.`,
      exitCode: EXIT_CODES.usage,
      hint: reading.state === "unreadable"
        ? `This computer holds a record for this Machine that Cuna cannot read (${reading.reason}), so it carries no operation identity. Name one with --operation UUID, or clear the record with \`cuna machines live-update-supervisor ${id} --forget-unknown\`.`
        : `This computer holds no record of an update for this Machine on ${context.config.baseUrl}. Name the operation with --operation UUID: an update started from another computer or from the web console has an identity this CLI never held.`,
      retryable: false,
      details: {
        machine_id: id,
        ...(reading.state === "unreadable" ? { record_path: reading.path, reason: reading.reason } : {}),
      },
    });
  }
  const operationId = named ?? (reading as Extract<LiveSupervisorUpdateReading, { state: "outstanding" }>).note.operationId;
  const operation = await client.readMachineSupervisorInPlaceUpdate(id, operationId);
  const report = liveUpdateOperationReport(operation, id);
  return Object.freeze({
    command: "machines.live-update-status",
    data: Object.freeze({
      ...report.data,
      operation_id_source: named === undefined ? "local_record" : "named",
      // Said in the record as well as in the prose: this command is a read, and
      // a caller consuming only `--json` must not have to infer that.
      dispatched_installer: false,
      server_state_changed: false,
    }),
    human: report.lines.join("\n"),
  });
}

async function executeMachines(context: CommandContext): Promise<CommandResult> {
  const { parsed, client, now } = context;
  requireCredential(context);
  const action = parsed.operands[0] ?? "overview";
  if (action === "overview") {
    rejectUnknownOptions(parsed, []);
    const machines = await listAllMachines(client);
    const overview = await Promise.all(machines.map(async (machine): Promise<MachineOverviewRow> => {
      try {
        const sessions = (await listAllMachineAgentSessions(client, machine.id))
          .filter(isAgentSessionIntendedActive)
          .slice()
          .sort((left, right) => left.agent.localeCompare(right.agent) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
        return Object.freeze({ machine, sessions: Object.freeze(sessions) });
      } catch (error) {
        return Object.freeze({
          machine,
          sessions: Object.freeze([]),
          sessionsError: safeSessionsErrorReason(error),
        });
      }
    }));
    overview.sort((left, right) => left.machine.name.localeCompare(right.machine.name) || left.machine.id.localeCompare(right.machine.id));
    return Object.freeze({
      command: "machines.overview",
      data: Object.freeze({
        items: Object.freeze(overview.map(({ machine, sessions, sessionsError }) => Object.freeze({
          ...machineRecord(machine),
          session_counts: machineSessionCounts(machine, sessions, now),
          agent_sessions: Object.freeze(sessions.map((session) => agentSessionRecord(session, machine, now))),
          ...(sessionsError === undefined ? {} : { agent_sessions_error: sessionsError }),
        }))),
      }),
      human: renderMachineOverview(overview, now),
    });
  }
  if (action === "list") {
    rejectUnknownOptions(parsed, []);
    if (parsed.operands.length !== 1) throw usageError("machines list accepts no operands.");
    const page = await client.listMachines();
    const items = page.items.map(machineRecord);
    return Object.freeze({
      command: "machines.list",
      data: Object.freeze({ items, ...(page.nextCursor === undefined ? {} : { next_cursor: page.nextCursor }) }),
      // The provider verdict is what decides whether the ID on this row can host
      // a session at all. Without it a machine declaring `opencode` and a machine
      // declaring nothing printed byte-identically, and the person picked an ID
      // the very next command refuses. `machines list` takes no `--cursor`, so a
      // truncated page says so without promising an option that does not exist.
      human: [
        ...(items.length === 0
          ? ["No machines found."]
          : page.items.map((machine) => {
              const provider = machineProviderAvailability(machine);
              return `${machine.id}\t${machine.name}\t${machine.state}\t${provider.displayName} ${providerVerdict(provider)}`;
            })),
        ...(page.nextCursor === undefined
          ? []
          : ["-- truncated; more machines exist beyond this page"]),
      ].join("\n"),
    });
  }
  if (action === "create") {
    rejectUnknownOptions(parsed, ["name", "agent", "vcpus", "memory-mib", "background", "yes", "idempotency-key"]);
    if (parsed.operands.length !== 1) throw usageError("machines create accepts no operands.");
    requireConfirmation(parsed, "machines.create");
    const key = idempotencyKey(parsed);
    const rawName = stringOption(parsed, "name");
    if (rawName === undefined) throw usageError("Option --name is required.");
    const name = assertSafeDisplayText(rawName, "machine name");
    if (name.length < 1 || name.length > 80) {
      throw usageError("Option --name must contain 1 through 80 characters.");
    }
    const agent = agentOption(parsed, false);
    const vcpus = integerOption(parsed, "vcpus", 1, 8);
    const memoryMiB = integerOption(parsed, "memory-mib", 512, 16_384);
    await requireCapability({ client, scope: "account", capabilityId: "machines.create", now: context.capabilityClock ?? now });
    const input: MachineCreateInput = {
      name,
      ...(agent === undefined ? {} : { agent }),
      ...(vcpus === undefined ? {} : { vcpus }),
      ...(memoryMiB === undefined ? {} : { memoryMiB }),
      ...(booleanOption(parsed, "background") ? { background: true } : {}),
    };
    const machine = await client.createMachine(input, key);
    const observed = await client.getMachine(machine.id);
    if (
      observed.id !== machine.id || observed.name !== name ||
      (agent !== undefined && observed.agent !== agent) ||
      (vcpus !== undefined && observed.vcpus !== vcpus) ||
      (memoryMiB !== undefined && observed.memoryMiB !== memoryMiB)
    ) {
      postconditionUnverified("machine creation", {
        machine_id: machine.id,
        observed_id: observed.id,
        observed_name: observed.name,
      });
    }
    return Object.freeze({
      command: "machines.create",
      data: machineRecord(observed),
      human: `Created machine ${observed.name} (${observed.id}) in state ${observed.state}.`,
    });
  }
  if (action === "update-supervisor") {
    rejectUnknownOptions(parsed, ["yes"]);
    if (parsed.operands.length !== 2) throw usageError("machines update-supervisor requires exactly one machine ID.");
    requireConfirmation(parsed, "machines.update-supervisor");
    const id = assertMachineId(requireOperand(parsed.operands, 1, "machine ID"));

    // Preserve OpenCode's explicit repair signals. Other providers can keep
    // creation supported even when their machine control lease needs repair.
    let updateRequired = false;
    let stoppedRuntimeUnverified: CunaError | undefined;
    try {
      await requireCapability({
        client,
        scope: "machine",
        resourceId: id,
        capabilityId: "agent_sessions.create",
        now: context.capabilityClock ?? now,
      });
    } catch (error) {
      if (isOpenCodeSupervisorRepairCapabilityRejection(error)) {
        updateRequired = true;
      } else if (isOpenCodeRuntimeUnverifiedCapabilityRejection(error)) {
        // A stopped Machine cannot run the OpenCode binary probe.  That is the
        // required precondition for this explicit repair, not evidence that
        // the supervisor update itself is forbidden.  Re-read the exact
        // Machine below; the endpoint remains the authority for whether a
        // compatible supervisor already exists.
        stoppedRuntimeUnverified = error;
      } else {
        throw error;
      }
    }

    // The replacement route has the same `machines:update` authority as a
    // start. Do not substitute the deliberately unsupported create capability
    // for the authorization that permits the remediation.
    await requireCapability({
      client,
      scope: "machine",
      resourceId: id,
      capabilityId: "machines.lifecycle",
      now: context.capabilityClock ?? now,
    });
    const current = await client.getMachine(id);
    if (current.state !== "stopped") {
      throw new CunaError({
        code: "cuna.machine.supervisor_update_requires_stopped",
        message: "The Machine must be stopped before its terminal supervisor can be updated.",
        exitCode: EXIT_CODES.conflict,
        hint: `Cuna will not stop ${current.name} or terminate any AgentSessions. End only the sessions you intend to end, then run \`cuna machines stop ${id} --yes\`.`,
        details: { machine_id: id, observed_state: current.state },
      });
    }
    if (stoppedRuntimeUnverified !== undefined) {
      if (current.agent !== "opencode") throw stoppedRuntimeUnverified;
      updateRequired = true;
    }
    // Claude/Codex creation can remain supported while the machine's control
    // lease has expired. The stopped replacement endpoint validates that lease
    // and all child-session blockers; OpenCode discovery is not its authority.
    if (!updateRequired && current.agent === "opencode") {
      throw new CunaError({
        code: "cuna.machine.supervisor_update_not_required",
        message: "Cuna does not report that this Machine needs an OpenCode terminal-supervisor update.",
        exitCode: EXIT_CODES.unsupported,
        hint: "Create an OpenCode AgentSession normally. This action is available only after Cuna reports the exact supervisor prerequisite.",
        details: { machine_id: id },
      });
    }
    const updated = await client.replaceMachineSupervisor(id);
    if (updated.id !== id) {
      postconditionUnverified("terminal supervisor update", { machine_id: id, observed_id: updated.id });
    }
    return Object.freeze({
      command: "machines.update-supervisor",
      data: machineRecord(updated),
      human: `Cuna confirmed a new terminal supervisor for ${updated.name}; the Machine is ${updated.state}.`,
    });
  }
  if (action === "live-update-supervisor") {
    return executeLiveUpdateSupervisor(context);
  }
  if (action === "live-update-status") {
    return executeLiveUpdateStatus(context);
  }
  if (action === "start" || action === "pause" || action === "resume" || action === "stop") {
    rejectUnknownOptions(parsed, ["yes"]);
    if (parsed.operands.length !== 2) throw usageError(`machines ${action} requires exactly one machine ID.`);
    requireConfirmation(parsed, `machines.${action}`);
    const id = assertMachineId(requireOperand(parsed.operands, 1, "machine ID"));
    // The public capability registry deliberately groups the four reversible
    // lifecycle transitions under one semantic authority. The operation path
    // still binds the exact action; discovery must not invent per-action IDs
    // that the producer never advertises.
    await requireCapability({ client, scope: "machine", resourceId: id, capabilityId: "machines.lifecycle", now: context.capabilityClock ?? now });
    const expectedState = action === "pause" ? "paused" : action === "stop" ? "stopped" : "running";
    // Read the state first so the result can say whether anything moved. The
    // transition is still requested either way: this side's idea of the state
    // and the provider's can diverge, so a start against a Machine we already
    // call running may be a real repair.
    const before = await client.getMachine(id);
    const alreadyInState = before.id === id && before.state === expectedState;
    const machine = await client.transitionMachine(id, action);
    if (machine.id !== id) {
      // An identity contradiction: the producer answered about a different
      // machine. No amount of waiting converges that.
      postconditionUnverified(`machine ${action}`, { machine_id: id, observed_id: machine.id });
    }
    // A lifecycle transition is asynchronous on the producer, so the state the
    // very next read returns is usually the state BEFORE the transition. Read
    // back until it converges or until the CLI's own budget elapses.
    const observed = await convergeOnRemoteState(context, {
      operation: `machine ${action}`,
      settleWith: "cuna machines list",
      probe: async () => {
        const machineNow = await client.getMachine(id);
        return Object.freeze({
          settled: machineNow.id === id && machineNow.state === expectedState,
          observation: machineNow,
          details: Object.freeze({
            machine_id: id,
            expected_state: expectedState,
            observed_state: machineNow.state,
          }),
        });
      },
    });
    return Object.freeze({
      command: `machines.${action}`,
      data: Object.freeze({ ...machineRecord(observed), state_changed: !alreadyInState }),
      human: alreadyInState
        ? `Machine ${observed.name} was already ${observed.state}; nothing changed.`
        : `Machine ${observed.name} is ${observed.state}.`,
    });
  }
  if (action === "delete") {
    rejectUnknownOptions(parsed, ["yes"]);
    if (parsed.operands.length !== 2) throw usageError("machines delete requires exactly one machine ID.");
    requireConfirmation(parsed, "machines.delete");
    const id = assertMachineId(requireOperand(parsed.operands, 1, "machine ID"));
    await requireCapability({ client, scope: "machine", resourceId: id, capabilityId: "machines.delete", now: context.capabilityClock ?? now });
    await client.deleteMachine(id);
    // MEASURED 2026-08-19: the immediate read that used to stand here saw
    // `present` and the command reported `cuna.remote.postcondition_unverified`,
    // `retryable: false`, for a machine that `cuna machines list` showed gone six
    // seconds later. The producer accepts a durable delete before the resource
    // disappears from reads; the CLI has to let it.
    await convergeOnRemoteState(context, {
      operation: "machine deletion",
      settleWith: "cuna machines list",
      probe: async () => {
        try {
          const observed = await client.getMachine(id);
          return Object.freeze({
            settled: observed.state === "deleted",
            observation: undefined,
            details: Object.freeze({ machine_id: id, observed_state: observed.state }),
          });
        } catch (error) {
          if (error instanceof CunaError && error.code === "cuna.remote.not_found") {
            return Object.freeze({
              settled: true,
              observation: undefined,
              details: Object.freeze({ machine_id: id, observed_state: "absent" }),
            });
          }
          throw error;
        }
      },
    });
    return Object.freeze({ command: "machines.delete", data: { id, acknowledged: true }, human: `Delete acknowledged for ${id}.` });
  }
  throw usageError(`Unknown machines action ${action}.`);
}

function preflightExecutions(parsed: ParsedInvocation): void {
  const action = parsed.operands[0];
  rejectUnknownOptions(parsed, action === "list" ? ["machine", "execution-workspace-id", "after"] :
    action === "cancel" ? ["machine", "yes"] : ["machine"]);
  assertMachineId(requireOption(parsed, "machine", "Run `cuna machines list` to find a Machine ID."));
  if (action === "list") {
    if (parsed.operands.length !== 1) throw usageError("executions list accepts no operands.");
    for (const name of ["execution-workspace-id", "after"]) {
      const value = stringOption(parsed, name);
      if (value !== undefined) assertCanonicalUuid(value, name);
    }
    return;
  }
  if ((action !== "get" && action !== "cancel") || parsed.operands.length !== 2) {
    throw usageError("executions requires list, get EXECUTION_ID, or cancel EXECUTION_ID.");
  }
  assertCanonicalUuid(requireOperand(parsed.operands, 1, "execution ID"), "execution ID");
  if (action === "cancel") requireConfirmation(parsed, "executions.cancel");
}

function executionRecord(item: ManagedExecution): Readonly<Record<string, unknown>> {
  return Object.freeze({ operation_id: item.operationId, machine_id: item.machineId,
    execution_workspace_id: item.executionWorkspaceId, leader_state: item.leaderState, ownership_state: item.ownershipState,
    cancel_requested: item.cancelRequested, exit_code: item.exitCode, duration_ms: item.durationMs,
    reason: item.reason, created_at: item.createdAt, observed_at: item.observedAt });
}

function executionLine(item: ManagedExecution): string {
  return `${item.operationId}\tleader=${item.leaderState}\townership=${item.ownershipState}` +
    `\tworkspace=${item.executionWorkspaceId ?? "legacy"}` +
    (item.exitCode === null ? "" : `\texit=${item.exitCode}`) +
    (item.cancelRequested ? "\tcancellation requested" : "") +
    (item.reason === null ? "" : `\t${item.reason}`);
}

async function executeExecutions(context: CommandContext): Promise<CommandResult> {
  preflightExecutions(context.parsed);
  requireCredential(context);
  const { parsed, client } = context;
  const machineId = requireOption(parsed, "machine");
  const action = parsed.operands[0];
  // Recovery reads and cancellation remain usable without a live supervisor.
  // The server authorizes exact ownership; machines.exec availability describes
  // new admission and must not hide an outstanding operation during an outage.
  if (action === "list") {
    const executionWorkspaceId = stringOption(parsed, "execution-workspace-id");
    const after = stringOption(parsed, "after");
    const page = await client.listManagedExecutions(machineId, {
      ...(executionWorkspaceId === undefined ? {} : { executionWorkspaceId }), ...(after === undefined ? {} : { after }),
    });
    return Object.freeze({ command: "executions.list", data: { machine_id: page.machineId,
      items: page.items.map(executionRecord), next_cursor: page.nextCursor },
      human: `Remote executions on Machine ${machineId}\n` +
        (page.items.length === 0 ? "No executions in this page." : page.items.map(executionLine).join("\n")) +
        (page.nextCursor === null ? "" : `\nNext: cuna executions list --machine ${machineId}` +
          (executionWorkspaceId === undefined ? "" : ` --execution-workspace-id ${executionWorkspaceId}`) + ` --after ${page.nextCursor}`),
    });
  }
  const operationId = requireOperand(parsed.operands, 1, "execution ID");
  const item = action === "cancel" ? await client.cancelManagedExecution(machineId, operationId) :
    await client.getManagedExecution(machineId, operationId);
  const followup = `cuna executions get ${operationId} --machine ${machineId}`;
  return Object.freeze({ command: `executions.${action}`, data: executionRecord(item),
    human: (action === "cancel" ? "Cancellation accepted.\n" : "") + executionLine(item) +
      (item.ownershipState === "cleared" ? "\nProcess ownership is cleared." :
        `\nProcess cleanup is not confirmed. Inspect: ${followup}`),
  });
}

async function executeAgentSessions(context: CommandContext): Promise<CommandResult> {
  const { parsed, client, now } = context;
  requireCredential(context);
  const action = requireOperand(parsed.operands, 0, "agent-sessions action");
  if (action === "list") {
    rejectUnknownOptions(parsed, ["machine", "limit", "cursor"]);
    if (parsed.operands.length !== 1) throw usageError("agent-sessions list accepts no operands.");
    const machineId = assertMachineId(requireOption(parsed, "machine", "Run `cuna machines list` to find a machine ID."));
    const limit = integerOption(parsed, "limit", 1, 100);
    const cursor = stringOption(parsed, "cursor");
    const page = await client.listAgentSessions(machineId, {
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    const items = page.items.map((session) => agentSessionRecord(session));
    return Object.freeze({
      command: "agent-sessions.list",
      data: { items, ...(page.nextCursor === undefined ? {} : { next_cursor: page.nextCursor }) },
      human: [
        ...(items.length === 0
          ? ["No AgentSessions found."]
          : page.items.map((item) => `${item.id}\t${item.name}\t${item.agent}\t${agentSessionStateLabel(item)}\t${item.cwd}`)),
        ...truncationFooter(page.nextCursor),
      ].join("\n"),
    });
  }
  if (action === "get") {
    rejectUnknownOptions(parsed, []);
    if (parsed.operands.length !== 2) throw usageError("agent-sessions get requires exactly one AgentSession ID.");
    const id = assertCanonicalUuid(requireOperand(parsed.operands, 1, "AgentSession ID"), "AgentSession ID");
    const session = await client.getAgentSession(id);
    return Object.freeze({ command: "agent-sessions.get", data: agentSessionRecord(session), human: `${session.id}\t${session.name}\t${session.agent}\t${agentSessionStateLabel(session)}\t${session.cwd}` });
  }
  if (action === "create") {
    rejectUnknownOptions(parsed, [
      "machine", "workspace-binding-id", "workspace-generation", "name", "agent", "cwd",
      "auth-mode", "credential-binding", "yes", "idempotency-key",
    ]);
    if (parsed.operands.length !== 1) throw usageError("agent-sessions create accepts no operands.");
    requireConfirmation(parsed, "agent-sessions.create");
    const machineId = assertMachineId(requireOption(parsed, "machine", "Run `cuna machines list` to find a machine ID."));
    // Nothing in the product publishes a binding id, so both options are
    // resolved from `.cuna/workspace.json`, which the journey commands write.
    // An explicit flag still wins, so a caller who knows better decides.
    const givenBindingId = stringOption(parsed, "workspace-binding-id");
    const givenGeneration = integerOption(parsed, "workspace-generation", 1, Number.MAX_SAFE_INTEGER);
    // Read the folder only when something is missing: a fully specified
    // invocation costs no extra round trip.
    const localBinding = givenBindingId !== undefined && givenGeneration !== undefined
      ? undefined
      : await resolveLocalWorkspaceBinding(context);
    const workspaceBindingId = assertCanonicalUuid(
      givenBindingId ?? localBinding?.bindingId ?? "",
      "workspace binding ID",
    );
    const workspaceGeneration = givenGeneration ?? localBinding?.generation;
    if (workspaceGeneration === undefined) {
      throw usageError("Option --workspace-generation is required.");
    }
    const agent = agentOption(parsed, true);
    if (agent === undefined) throw usageError("Option --agent is required.");
    const cwd = assertSafeDisplayText(stringOption(parsed, "cwd") ?? "/workspace", "workspace path");
    if (!cwd.startsWith("/workspace") || cwd.split("/").includes("..") || cwd.length > 1024) {
      throw usageError("Option --cwd must be a safe absolute path inside /workspace.");
    }
    const rawName = stringOption(parsed, "name");
    const name = rawName === undefined ? undefined : assertSafeDisplayText(rawName, "AgentSession name");
    if (name !== undefined && (name.length < 1 || name.length > 80)) {
      throw usageError("Option --name must contain 1 through 80 characters.");
    }
    const credentialBinding = stringOption(parsed, "credential-binding");
    const rawAuthMode = stringOption(parsed, "auth-mode");
    if (
      agent === "opencode" &&
      (rawAuthMode === "credential_binding" || credentialBinding !== undefined)
    ) {
      throw usageError(
        "OpenCode supports interactive_login only; credential bindings are not accepted.",
        "Use OpenCode's interactive provider flow and omit --credential-binding.",
      );
    }
    const requestedAuthMode = normalizedAgentSessionAuthMode(rawAuthMode, credentialBinding);
    const authMode = agent === "opencode" ? "interactive_login" : requestedAuthMode;
    const machine = await client.getMachine(machineId);
    if (!machineSupportsProvider(machine, agent)) {
      const installed = machineProviderAvailability(machine);
      throw new CunaError({
        code: "cuna.agent.provider_not_installed",
        message: `${providerDisplayName(agent)} is unavailable on machine ${machine.name}. Declared installed provider: ${installed.displayName}.`,
        exitCode: EXIT_CODES.unsupported,
        hint: `Choose a machine whose installed provider is ${providerDisplayName(agent)}, or create one with \`cuna machines create --agent ${agent} ...\`.`,
        details: {
          machine_id: machine.id,
          requested_provider: agent,
          installed_provider: installed.declaredId ?? "unknown",
        },
      });
    }
    try {
      await requireCapability({ client, scope: "machine", resourceId: machineId, capabilityId: "agent_sessions.create", now: context.capabilityClock ?? now });
    } catch (error) {
      if (agent === "opencode" && isOpenCodeSupervisorUpgradeCapabilityRejection(error)) {
        throw openCodeSupervisorUpgradeRequired({
          ...(error.details === undefined ? {} : { details: error.details }),
          machineId,
          cause: error,
        });
      }
      if (agent === "opencode" && isOpenCodeRuntimeUnverifiedCapabilityRejection(error)) {
        throw openCodeRuntimeUnverified({
          ...(error.details === undefined ? {} : { details: error.details }),
          machineId,
          cause: error,
        });
      }
      throw error;
    }
    const session = await client.createAgentSession(machineId, {
      ...(name === undefined ? {} : { name }),
      agent,
      cwd,
      workspaceBindingId,
      workspaceGeneration,
      ...(authMode === undefined ? {} : { authMode }),
      ...(credentialBinding === undefined
        ? {}
        : { credentialBindingId: assertCanonicalUuid(credentialBinding, "credential binding ID") }),
    }, idempotencyKey(parsed));
    const observed = await client.getAgentSession(session.id);
    if (
      observed.id !== session.id || observed.machineId !== machineId || observed.agent !== agent ||
      observed.cwd !== cwd || observed.workspaceBindingId !== workspaceBindingId ||
      observed.workspaceGeneration !== workspaceGeneration ||
      (name !== undefined && observed.name !== name) ||
      (authMode !== undefined && observed.authMode !== authMode)
    ) {
      postconditionUnverified("AgentSession creation", {
        agent_session_id: session.id,
        machine_id: machineId,
        observed_agent: observed.agent,
      });
    }
    return Object.freeze({ command: "agent-sessions.create", data: agentSessionRecord(observed), human: `Created ${observed.agent} AgentSession ${observed.id}.` });
  }
  if (action === "terminate") {
    rejectUnknownOptions(parsed, ["yes"]);
    if (parsed.operands.length !== 2) throw usageError("agent-sessions terminate requires exactly one AgentSession ID.");
    requireConfirmation(parsed, "agent-sessions.terminate");
    const id = assertCanonicalUuid(requireOperand(parsed.operands, 1, "AgentSession ID"), "AgentSession ID");
    await requireCapability({ client, scope: "agent_session", resourceId: id, capabilityId: "agent_sessions.terminate", now: context.capabilityClock ?? now });
    await client.terminateAgentSession(id);
    const observed = await convergeOnRemoteState(context, {
      operation: "AgentSession termination",
      settleWith: `cuna agent-sessions get ${id}`,
      probe: async () => {
        const session = await client.getAgentSession(id);
        return Object.freeze({
          settled: session.id === id && agentSessionTerminationConfirmed(session),
          observation: session,
          details: Object.freeze({
            agent_session_id: id,
            observed_desired_state: session.desiredState,
            observed_request_state: session.requestState,
            observed_process_state: session.processState,
          }),
        });
      },
    });
    return Object.freeze({ command: "agent-sessions.terminate", data: agentSessionRecord(observed), human: `AgentSession ${observed.id} is ${observed.requestState}/${observed.processState}.` });
  }
  if (action === "rename") {
    rejectUnknownOptions(parsed, ["name", "yes"]);
    if (parsed.operands.length !== 2) throw usageError("agent-sessions rename requires exactly one AgentSession ID.");
    requireConfirmation(parsed, "agent-sessions.rename");
    const id = assertCanonicalUuid(requireOperand(parsed.operands, 1, "AgentSession ID"), "AgentSession ID");
    const rawName = stringOption(parsed, "name");
    const name = rawName === undefined ? undefined : assertSafeDisplayText(rawName, "AgentSession name");
    if (name === undefined || name.length < 1 || name.length > 80) {
      throw usageError("Option --name must contain 1 through 80 characters.");
    }
    await requireCapability({ client, scope: "agent_session", resourceId: id, capabilityId: "agent_sessions.rename", now: context.capabilityClock ?? now });
    await client.renameAgentSession(id, name);
    const observed = await client.getAgentSession(id);
    if (observed.id !== id || observed.name !== name) {
      postconditionUnverified("AgentSession rename", { agent_session_id: id, expected_name: name, observed_name: observed.name });
    }
    return Object.freeze({
      command: "agent-sessions.rename",
      data: agentSessionRecord(observed),
      human: `Renamed AgentSession ${observed.id} to ${observed.name}.`,
    });
  }
  if (action === "attach") {
    // See the root command arm above: runCli intercepts this public path after
    // exact identity and TTY admission. The generic dispatcher cannot attach.
    throw unsupportedError("AgentSession attach", "run_cli_composition_required");
  }
  throw usageError(`Unknown agent-sessions action ${action}.`);
}
