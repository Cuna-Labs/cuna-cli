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
  CapabilitySnapshot,
  Machine,
} from "../api/contracts.js";
import type { EffectiveConfig } from "../config/config.js";
import { DEFAULT_BASE_URL, environmentCredentialState, publicConfig } from "../config/config.js";
import { assertOpenCodeExecutionEnabled } from "../config/opencode-feature-gate.js";
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
  integerArgument,
} from "../core/validation.js";
import { preflightAgentJourneyInvocation } from "../journey/intent.js";
import { listAllMachines } from "../machines/pagination.js";
import { machineProviderAvailability, machineSupportsProvider, providerDisplayName } from "../machines/provider-availability.js";
import { classifySessionActionability, displaySessionActionability } from "../machines/session-actionability.js";
import { isAgentSessionIntendedActive } from "../machines/session-visibility.js";
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
  readonly credentialMode?: "automation" | "interactive";
  readonly runtimeFeatures?: readonly RuntimeFeatureGate[];
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

function agentSessionTerminationConfirmed(session: AgentSession): boolean {
  return session.desiredState === "terminated" &&
    session.requestState === "terminal" &&
    session.processState === "terminated";
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

interface MachineOverviewRow {
  readonly machine: Machine;
  readonly sessions: readonly AgentSession[];
  readonly sessionsError?: "sessions_unavailable";
}

function renderMachineOverview(
  items: readonly MachineOverviewRow[],
  now: number,
  opencodePreferred: boolean,
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
    const providerCounts = opencodePreferred ? `${opencode} · ${claude} · ${codex}` : `${claude} · ${codex} · ${opencode}`;
    const header = `▾ ${machine.name}  ${machine.state}  ${provider.displayName} ${provider.usability}  ${providerCounts}`;
    if (sessionsError !== undefined) return [header, "  └─ AgentSessions unavailable"];
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
): void {
  assertRegisteredCliRoute(parsed);
  switch (parsed.command) {
    case "config":
      rejectUnknownOptions(parsed, []);
      if (parsed.operands.length !== 1 || parsed.operands[0] !== "get") {
        throw unsupportedError("configuration mutation", "config_writes_not_implemented");
      }
      return;
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
      if (scope !== "account") assertPublicId(resourceId ?? "", "resource ID");
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
      assertCanonicalUuid(stringOption(parsed, "machine") ?? "", "machine ID");
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
        assertCanonicalUuid(parsed.operands[1] ?? "", "API key ID");
        return;
      }
      if (action === "create") {
        rejectUnknownOptions(parsed, ["name", "expires-at", "yes"]);
        if (parsed.operands.length !== 1) throw usageError("api-keys create accepts no operands.");
        requireConfirmation(parsed, "api-keys.create");
        apiKeyCreateInput(parsed);
        return;
      }
      throw usageError(`Unknown api-keys action ${action}.`);
    }
    case "agent-sessions":
      preflightAgentSessions(parsed);
      return;
    case "agent": {
      rejectUnknownOptions(parsed, ["agent-session", "yes"]);
      if (parsed.operands.length !== 1 || parsed.operands[0] !== "logout") {
        throw usageError("agent requires the logout action.");
      }
      requireConfirmation(parsed, "agent.logout");
      assertCanonicalUuid(
        stringOption(parsed, "agent-session") ?? "",
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
    assertMachineId(stringOption(parsed, "machine") ?? "");
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
    assertMachineId(stringOption(parsed, "machine") ?? "");
    assertCanonicalUuid(
      stringOption(parsed, "workspace-binding-id") ?? "",
      "workspace binding ID",
    );
    if (integerOption(parsed, "workspace-generation", 1, Number.MAX_SAFE_INTEGER) === undefined) {
      throw usageError("Option --workspace-generation is required.");
    }
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
      return Object.freeze({ command: "config.get", data, human: JSON.stringify(data, null, 2) });
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
      const machineId = assertCanonicalUuid(stringOption(parsed, "machine") ?? "", "machine ID");
      await requireCapability({
        client,
        scope: "machine",
        resourceId: machineId,
        capabilityId: "authorizations.list",
        now: context.capabilityClock ?? context.now,
        allowedInteractions: ["read_only"],
      });
      const rules = await client.listAuthorizations(machineId);
      const data = Object.freeze({
        machine_id: machineId,
        items: rules.map((rule) => Object.freeze({
          id: rule.id,
          host: rule.host,
          path: rule.path,
          credential: rule.credential,
          target: Object.freeze({
            kind: rule.target.kind,
            name: rule.target.name,
            format: rule.target.format,
          }),
          cache_ttl_seconds: rule.cacheTtlSeconds,
        })),
      });
      return Object.freeze({
        command: "authorizations.list",
        data,
        human: rules.length === 0
          ? "No injection authorizations are active for this machine."
          : rules.map((rule) => `${rule.id}\t${rule.host}${rule.path}\t${rule.target.kind}:${rule.target.name}\t${rule.credential}`).join("\n"),
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
        throw unsupportedError("workspace usage", "workspace_usage_unavailable");
      }
      const data = Object.freeze({
        estimated_spend_usd: identity.workspaceUsage.estimatedSpendUsd,
        estimated_remaining_usd: identity.workspaceUsage.estimatedRemainingUsd,
        note: identity.workspaceUsage.note,
      });
      return Object.freeze({
        command: "usage.show",
        data,
        human: `$${identity.workspaceUsage.estimatedSpendUsd.toFixed(2)} estimated spend; ` +
          `$${identity.workspaceUsage.estimatedRemainingUsd.toFixed(2)} estimated remaining. ${identity.workspaceUsage.note}`,
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
            : keys.map((key) => `${key.id}\t${key.name}\t${key.prefix}…${key.lastFour}\t${key.revokedAt === null ? "active" : "revoked"}`).join("\n"),
        });
      }
      if (action === "revoke") {
        const id = assertCanonicalUuid(parsed.operands[1] ?? "", "API key ID");
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
    case "agent": {
      requireCredential(context);
      rejectUnknownOptions(parsed, ["agent-session", "yes"]);
      if (parsed.operands.length !== 1 || parsed.operands[0] !== "logout") {
        throw usageError("agent requires the logout action.");
      }
      requireConfirmation(parsed, "agent.logout");
      const id = assertCanonicalUuid(
        stringOption(parsed, "agent-session") ?? "",
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
      if (
        observedAuth.agentSessionId !== id ||
        observedAuth.processEpoch !== session.processEpoch ||
        observedAuth.state !== "login_required"
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
        }),
        human: `Signed out ${session.agent} in AgentSession ${session.id}.`,
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
      const data = Object.freeze({
        platform: process.platform,
        node: process.version,
        environment_credential: environmentCredentialState(config),
        environment_credential_variable: config.apiKeyVariable ?? null,
        runtime_features: context.runtimeFeatures ?? INITIAL_RUNTIME_GATES,
      });
      return Object.freeze({ command: "doctor", data, human: JSON.stringify(data, null, 2) });
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
      } catch {
        return Object.freeze({
          machine,
          sessions: Object.freeze([]),
          sessionsError: "sessions_unavailable" as const,
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
      human: renderMachineOverview(overview, now, context.config.opencodeFeatureGate.state === "enabled"),
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
      human: items.length === 0
        ? "No machines found."
        : page.items.map((machine) => `${machine.id}\t${machine.name}\t${machine.state}`).join("\n"),
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
    if (agent === "opencode") assertOpenCodeExecutionEnabled(context.config.opencodeFeatureGate);
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
    const machine = await client.transitionMachine(id, action);
    if (machine.id !== id) {
      // An identity contradiction: the producer answered about a different
      // machine. No amount of waiting converges that.
      postconditionUnverified(`machine ${action}`, { machine_id: id, observed_id: machine.id });
    }
    const expectedState = action === "pause" ? "paused" : action === "stop" ? "stopped" : "running";
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
      data: machineRecord(observed),
      human: `Machine ${observed.name} is ${observed.state}.`,
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

async function executeAgentSessions(context: CommandContext): Promise<CommandResult> {
  const { parsed, client, now } = context;
  requireCredential(context);
  const action = requireOperand(parsed.operands, 0, "agent-sessions action");
  if (action === "list") {
    rejectUnknownOptions(parsed, ["machine", "limit", "cursor"]);
    if (parsed.operands.length !== 1) throw usageError("agent-sessions list accepts no operands.");
    const machineId = assertMachineId(stringOption(parsed, "machine") ?? "");
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
      human: items.length === 0
        ? "No AgentSessions found."
        : page.items.map((item) => `${item.id}\t${item.name}\t${item.agent}\t${item.processState}\t${item.cwd}`).join("\n"),
    });
  }
  if (action === "get") {
    rejectUnknownOptions(parsed, []);
    if (parsed.operands.length !== 2) throw usageError("agent-sessions get requires exactly one AgentSession ID.");
    const id = assertCanonicalUuid(requireOperand(parsed.operands, 1, "AgentSession ID"), "AgentSession ID");
    const session = await client.getAgentSession(id);
    return Object.freeze({ command: "agent-sessions.get", data: agentSessionRecord(session), human: `${session.id}\t${session.name}\t${session.agent}\t${session.processState}\t${session.cwd}` });
  }
  if (action === "create") {
    rejectUnknownOptions(parsed, [
      "machine", "workspace-binding-id", "workspace-generation", "name", "agent", "cwd",
      "auth-mode", "credential-binding", "yes", "idempotency-key",
    ]);
    if (parsed.operands.length !== 1) throw usageError("agent-sessions create accepts no operands.");
    requireConfirmation(parsed, "agent-sessions.create");
    const machineId = assertMachineId(stringOption(parsed, "machine") ?? "");
    const workspaceBindingId = assertCanonicalUuid(
      stringOption(parsed, "workspace-binding-id") ?? "",
      "workspace binding ID",
    );
    const workspaceGeneration = integerOption(
      parsed,
      "workspace-generation",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (workspaceGeneration === undefined) {
      throw usageError("Option --workspace-generation is required.");
    }
    const agent = agentOption(parsed, true);
    if (agent === undefined) throw usageError("Option --agent is required.");
    if (agent === "opencode") assertOpenCodeExecutionEnabled(context.config.opencodeFeatureGate);
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
    await requireCapability({ client, scope: "machine", resourceId: machineId, capabilityId: "agent_sessions.create", now: context.capabilityClock ?? now });
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
