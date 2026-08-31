import type { AgentAuthMode, AgentKind, AgentSessionProcessState } from "../api/contracts.js";

export type AuthorityFreshness = "fresh" | "stale" | "unknown";
export type OwnershipStatus = "owned" | "foreign" | "unknown";
export type RecencyStatus = "recent" | "not_recent" | "unknown";
export type MachineSelectionState =
  | "creating"
  | "running"
  | "paused"
  | "suspended"
  | "stopped"
  | "deleted"
  | "error"
  | "unknown";
export type MachineCostStatus = "known" | "unknown" | "unavailable";
export type AttachmentStatus = "detached" | "attached" | "unknown";
/** A producer-proven condition that blocks automatic machine creation. */
export type RequestedAgentBlocker = "opencode-supervisor-update-required";

export interface MachineSelectionObservation {
  readonly id: string;
  readonly name: string;
  /** Legacy initial-agent projection. Display-only; never a compatibility oracle. */
  readonly agent: AgentKind | "unknown";
  /** Fresh machine-scoped producer evidence for creating the requested child agent. */
  readonly requestedAgentSupport: "supported" | "unsupported" | "unknown";
  /**
   * A narrow, human-actionable blocker preserved from fresh capability
   * evidence. It is not provider inventory and it must never be guessed from
   * `machine.agent` or terminal text.
   */
  readonly requestedAgentBlocker?: RequestedAgentBlocker;
  readonly state: MachineSelectionState;
  readonly ownership: OwnershipStatus;
  readonly freshness: AuthorityFreshness;
  readonly recency: RecencyStatus;
  readonly resources: {
    readonly vcpus?: number;
    readonly memoryMiB?: number;
  };
  readonly costStatus: MachineCostStatus;
}

export interface ProjectMachineBinding {
  readonly machineId: string;
  readonly freshness: AuthorityFreshness;
}

export interface AgentSessionSelectionObservation {
  readonly id: string;
  readonly machineId: string;
  readonly name: string;
  readonly agent: AgentKind;
  readonly workspaceIdentity: string;
  readonly workspaceGeneration: number;
  readonly cwd: string;
  readonly authMode: AgentAuthMode;
  readonly processState: AgentSessionProcessState;
  readonly attachment: AttachmentStatus;
  readonly freshness: AuthorityFreshness;
  readonly createdAt: string;
}

export interface SafeMachineCandidate {
  readonly id: string;
  readonly name: string;
  /** Legacy initial-agent projection retained only for safe display. */
  readonly agent: AgentKind | "unknown";
  readonly state: Exclude<MachineSelectionState, "unknown">;
  readonly resources: {
    readonly vcpus?: number;
    readonly memoryMiB?: number;
  };
  readonly costStatus: MachineCostStatus;
}

export interface SafeAgentSessionCandidate {
  readonly id: string;
  readonly name: string;
  readonly agent: AgentKind;
  readonly cwd: string;
  readonly state: "ready" | "running";
  readonly createdAt: string;
}

export interface SelectMachinePlan {
  readonly kind: "select";
  readonly target: "machine";
  readonly source: "explicit" | "project-binding" | "unique-compatible";
  readonly machineId: string;
  readonly machine: SafeMachineCandidate;
}

export interface SelectAgentSessionPlan {
  readonly kind: "select";
  readonly target: "agent-session";
  readonly source: "explicit" | "unique-compatible";
  readonly machineId: string;
  readonly agentSessionId: string;
  readonly agentSession: SafeAgentSessionCandidate;
}

export interface CreateRequiredPlan {
  readonly kind: "create-required";
  readonly target: "machine" | "agent-session";
  readonly machineId?: string;
  readonly reason: "forced" | "no-compatible-candidate";
}

export interface AmbiguousMachinePlan {
  readonly kind: "ambiguous";
  readonly target: "machine";
  readonly reason: "duplicate-name" | "multiple-compatible-candidates";
  readonly candidates: readonly SafeMachineCandidate[];
}

export interface AmbiguousAgentSessionPlan {
  readonly kind: "ambiguous";
  readonly target: "agent-session";
  readonly machineId: string;
  readonly reason: "multiple-compatible-candidates";
  readonly candidates: readonly SafeAgentSessionCandidate[];
}

export interface StaleBindingPlan {
  readonly kind: "stale-binding";
  readonly target: "machine";
  readonly machineId: string;
  readonly reason:
    | "binding-observation-stale"
    | "machine-missing"
    | "machine-observation-stale"
    | "ownership-changed";
}

export interface IncompatiblePlan {
  readonly kind: "incompatible";
  readonly target: "machine" | "agent-session";
  readonly targetId: string;
  readonly reason:
    | "agent-mismatch"
    | "auth-mode-mismatch"
    | "cwd-mismatch"
    | "machine-mismatch"
    | "workspace-generation-mismatch"
    | "workspace-identity-mismatch";
}

export interface UnavailablePlan {
  readonly kind: "unavailable";
  readonly target: "machine" | "agent-session";
  readonly targetId?: string;
  readonly reason:
    | "already-attached"
    | "attachment-unobservable"
    | "authority-data-invalid"
    | "authority-observation-stale"
    | "contradictory-selection"
    | "duplicate-id"
    | "not-found"
    | "ownership-unverified"
    | "opencode-supervisor-update-required"
    | "state-not-reusable"
    | "state-unknown";
}

export type MachineSelectionPlan =
  | SelectMachinePlan
  | CreateRequiredPlan
  | AmbiguousMachinePlan
  | StaleBindingPlan
  | IncompatiblePlan
  | UnavailablePlan;

export type AgentSessionSelectionPlan =
  | SelectAgentSessionPlan
  | CreateRequiredPlan
  | AmbiguousAgentSessionPlan
  | IncompatiblePlan
  | UnavailablePlan;

export type JourneySelectionPlan = MachineSelectionPlan | AgentSessionSelectionPlan;

export interface MachineSelector {
  readonly kind: "id" | "name";
  readonly value: string;
}

export interface MachineSelectionInput {
  readonly requestedAgent: AgentKind;
  readonly forceNew: boolean;
  readonly selector?: MachineSelector;
  readonly projectBinding?: ProjectMachineBinding;
  readonly collectionFreshness: AuthorityFreshness;
  readonly machines: readonly MachineSelectionObservation[];
}

export interface AgentSessionSelectionInput {
  readonly machineId: string;
  readonly requestedAgent: AgentKind;
  readonly workspaceIdentity: string;
  readonly workspaceGeneration: number;
  readonly cwd: string;
  readonly authMode: AgentAuthMode;
  readonly forceNewSession: boolean;
  readonly agentSessionId?: string;
  readonly collectionFreshness: AuthorityFreshness;
  readonly agentSessions: readonly AgentSessionSelectionObservation[];
}

export interface JourneySelectionInput {
  readonly machine: MachineSelectionInput;
  readonly agentSession: Omit<AgentSessionSelectionInput, "machineId">;
}

const MACHINE_STATES = new Set<MachineSelectionState>([
  "creating",
  "running",
  "paused",
  "suspended",
  "stopped",
  "deleted",
  "error",
  "unknown",
]);
const REUSABLE_MACHINE_STATES = new Set<MachineSelectionState>([
  "creating",
  "running",
  "paused",
  "suspended",
  "stopped",
]);
const AGENTS = new Set<AgentKind>(["claude-code", "codex", "openclaw", "opencode"]);
const AUTH_MODES = new Set<AgentAuthMode>(["interactive_login", "credential_binding"]);
const PROCESS_STATES = new Set<AgentSessionProcessState>([
  "unknown",
  "starting",
  "ready",
  "running",
  "exited",
  "failed",
  "terminating",
  "terminated",
]);
const SAFE_PUBLIC_ID = /^[0-9a-z][0-9a-z._:-]{0,127}$/u;

function freezePlan<const T extends object>(plan: T): Readonly<T> {
  return Object.freeze(plan);
}

function unavailable(
  target: "machine" | "agent-session",
  reason: UnavailablePlan["reason"],
  targetId?: string,
): UnavailablePlan {
  return freezePlan({
    kind: "unavailable",
    target,
    ...(targetId === undefined ? {} : { targetId }),
    reason,
  });
}

function isSafePublicId(value: unknown): value is string {
  return typeof value === "string" && SAFE_PUBLIC_ID.test(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function isSafeDisplay(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !hasControlCharacter(value)
  );
}

function isSafeRelativeCwd(value: unknown): value is string {
  if (!isSafeDisplay(value) || value.startsWith("/") || value.startsWith("\\")) return false;
  const normalized = value.replaceAll("\\", "/");
  return !normalized.split("/").some((segment) => segment.length === 0 || segment === "..");
}

function hasDuplicateIds(items: readonly { readonly id: string }[]): boolean {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) return true;
    ids.add(item.id);
  }
  return false;
}

function validResources(resources: MachineSelectionObservation["resources"]): boolean {
  return (
    typeof resources === "object" &&
    resources !== null &&
    (resources.vcpus === undefined ||
      (Number.isSafeInteger(resources.vcpus) && resources.vcpus > 0)) &&
    (resources.memoryMiB === undefined ||
      (Number.isSafeInteger(resources.memoryMiB) && resources.memoryMiB > 0))
  );
}

function validMachine(machine: MachineSelectionObservation): boolean {
  return (
    isSafePublicId(machine.id) &&
    isSafeDisplay(machine.name) &&
    (machine.agent === "unknown" || AGENTS.has(machine.agent)) &&
    (machine.requestedAgentSupport === "supported" ||
      machine.requestedAgentSupport === "unsupported" ||
      machine.requestedAgentSupport === "unknown") &&
    (machine.requestedAgentBlocker === undefined ||
      machine.requestedAgentBlocker === "opencode-supervisor-update-required") &&
    MACHINE_STATES.has(machine.state) &&
    (machine.ownership === "owned" || machine.ownership === "foreign" || machine.ownership === "unknown") &&
    (machine.freshness === "fresh" || machine.freshness === "stale" || machine.freshness === "unknown") &&
    (machine.recency === "recent" || machine.recency === "not_recent" || machine.recency === "unknown") &&
    validResources(machine.resources) &&
    (machine.costStatus === "known" || machine.costStatus === "unknown" || machine.costStatus === "unavailable")
  );
}

function safeMachine(machine: MachineSelectionObservation): SafeMachineCandidate {
  if (machine.requestedAgentSupport !== "supported" || machine.state === "unknown") {
    throw new TypeError("A machine with unknown compatibility cannot become a selection candidate.");
  }
  const resources = Object.freeze({
    ...(machine.resources.vcpus === undefined ? {} : { vcpus: machine.resources.vcpus }),
    ...(machine.resources.memoryMiB === undefined ? {} : { memoryMiB: machine.resources.memoryMiB }),
  });
  return Object.freeze({
    id: machine.id,
    name: machine.name,
    agent: machine.agent,
    state: machine.state,
    resources,
    costStatus: machine.costStatus,
  });
}

function sortMachines(machines: readonly MachineSelectionObservation[]): readonly SafeMachineCandidate[] {
  return Object.freeze(
    [...machines]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((machine) => safeMachine(machine)),
  );
}

function validateSelectedMachine(
  machine: MachineSelectionObservation,
): IncompatiblePlan | UnavailablePlan | undefined {
  if (machine.ownership === "foreign") return unavailable("machine", "not-found", machine.id);
  if (machine.ownership === "unknown") return unavailable("machine", "ownership-unverified", machine.id);
  if (machine.freshness !== "fresh") {
    return unavailable("machine", "authority-observation-stale", machine.id);
  }
  if (machine.requestedAgentBlocker === "opencode-supervisor-update-required") {
    return unavailable("machine", "opencode-supervisor-update-required", machine.id);
  }
  if (machine.requestedAgentSupport === "unknown") {
    return unavailable("machine", "state-unknown", machine.id);
  }
  if (machine.requestedAgentSupport === "unsupported") {
    return freezePlan({
      kind: "incompatible",
      target: "machine",
      targetId: machine.id,
      reason: "agent-mismatch",
    });
  }
  if (machine.state === "unknown") return unavailable("machine", "state-unknown", machine.id);
  if (!REUSABLE_MACHINE_STATES.has(machine.state)) {
    return unavailable("machine", "state-not-reusable", machine.id);
  }
  return undefined;
}

function selectedMachine(
  machine: MachineSelectionObservation,
  source: SelectMachinePlan["source"],
): SelectMachinePlan {
  return freezePlan({
    kind: "select",
    target: "machine",
    source,
    machineId: machine.id,
    machine: safeMachine(machine),
  });
}

export function planMachineSelection(input: MachineSelectionInput): MachineSelectionPlan {
  if (
    !AGENTS.has(input.requestedAgent) ||
    (input.collectionFreshness !== "fresh" &&
      input.collectionFreshness !== "stale" &&
      input.collectionFreshness !== "unknown") ||
    !Array.isArray(input.machines) ||
    (input.selector !== undefined &&
      input.selector.kind !== "id" &&
      input.selector.kind !== "name") ||
    (input.projectBinding !== undefined &&
      input.projectBinding.freshness !== "fresh" &&
      input.projectBinding.freshness !== "stale" &&
      input.projectBinding.freshness !== "unknown")
  ) {
    return unavailable("machine", "authority-data-invalid");
  }
  if (input.forceNew) {
    if (input.selector !== undefined || input.projectBinding !== undefined) {
      return unavailable("machine", "contradictory-selection");
    }
    return freezePlan({ kind: "create-required", target: "machine", reason: "forced" });
  }
  if (input.collectionFreshness !== "fresh") {
    if (input.projectBinding !== undefined) {
      return freezePlan({
        kind: "stale-binding",
        target: "machine",
        machineId: input.projectBinding.machineId,
        reason: "machine-observation-stale",
      });
    }
    return unavailable("machine", "authority-observation-stale");
  }
  if (input.machines.some((machine) => !validMachine(machine))) {
    return unavailable("machine", "authority-data-invalid");
  }
  if (hasDuplicateIds(input.machines)) return unavailable("machine", "duplicate-id");

  if (input.selector !== undefined) {
    if (!isSafeDisplay(input.selector.value)) return unavailable("machine", "authority-data-invalid");
    const matches = input.machines.filter((machine) =>
      input.selector?.kind === "id"
        ? machine.id === input.selector.value
        : machine.name === input.selector?.value,
    );
    if (matches.length === 0) return unavailable("machine", "not-found", input.selector.value);
    if (matches.length > 1) {
      if (matches.some((machine) => machine.ownership !== "owned" || machine.freshness !== "fresh")) {
        return unavailable("machine", "ownership-unverified");
      }
      const compatible = matches.filter(
        (machine) =>
          machine.requestedAgentSupport === "supported" &&
          machine.state !== "unknown" &&
          REUSABLE_MACHINE_STATES.has(machine.state),
      );
      if (compatible.length !== matches.length) return unavailable("machine", "state-not-reusable");
      return freezePlan({
        kind: "ambiguous",
        target: "machine",
        reason: "duplicate-name",
        candidates: sortMachines(compatible),
      });
    }
    const match = matches[0];
    if (match === undefined) return unavailable("machine", "not-found", input.selector.value);
    const rejection = validateSelectedMachine(match);
    return rejection ?? selectedMachine(match, "explicit");
  }

  if (input.projectBinding !== undefined) {
    const binding = input.projectBinding;
    if (!isSafePublicId(binding.machineId)) return unavailable("machine", "authority-data-invalid");
    if (binding.freshness !== "fresh") {
      return freezePlan({
        kind: "stale-binding",
        target: "machine",
        machineId: binding.machineId,
        reason: "binding-observation-stale",
      });
    }
    const machine = input.machines.find((candidate) => candidate.id === binding.machineId);
    if (machine === undefined) {
      return freezePlan({
        kind: "stale-binding",
        target: "machine",
        machineId: binding.machineId,
        reason: "machine-missing",
      });
    }
    if (machine.ownership !== "owned") {
      return freezePlan({
        kind: "stale-binding",
        target: "machine",
        machineId: binding.machineId,
        reason: "ownership-changed",
      });
    }
    if (machine.freshness !== "fresh") {
      return freezePlan({
        kind: "stale-binding",
        target: "machine",
        machineId: binding.machineId,
        reason: "machine-observation-stale",
      });
    }
    const rejection = validateSelectedMachine(machine);
    return rejection ?? selectedMachine(machine, "project-binding");
  }

  const plausiblyCompatible = input.machines.filter(
    (machine) => machine.ownership !== "foreign" && machine.requestedAgentSupport === "supported",
  );
  if (
    input.machines.some(
      (machine) =>
        machine.ownership !== "foreign" &&
        machine.requestedAgentSupport === "unknown" &&
        (machine.state === "unknown" || REUSABLE_MACHINE_STATES.has(machine.state)),
    ) ||
    plausiblyCompatible.some(
      (machine) =>
        machine.ownership === "unknown" ||
        machine.freshness !== "fresh" ||
        machine.state === "unknown" ||
        (REUSABLE_MACHINE_STATES.has(machine.state) && machine.recency === "unknown"),
    )
  ) {
    return unavailable("machine", "authority-observation-stale");
  }
  const eligible = plausiblyCompatible.filter(
    (machine) =>
      machine.ownership === "owned" &&
      machine.freshness === "fresh" &&
      machine.state !== "unknown" &&
      REUSABLE_MACHINE_STATES.has(machine.state) &&
      machine.recency === "recent",
  );
  if (eligible.length === 1 && eligible[0] !== undefined) {
    return selectedMachine(eligible[0], "unique-compatible");
  }
  if (eligible.length > 1) {
    return freezePlan({
      kind: "ambiguous",
      target: "machine",
      reason: "multiple-compatible-candidates",
      candidates: sortMachines(eligible),
    });
  }
  // A current OpenCode-specific repair condition is a reason to stop and
  // explain—not a license to allocate another paid machine. `--new` returned
  // above intentionally remains an explicit user choice.
  const repairBlocked = input.machines.find(
    (machine) =>
      machine.ownership === "owned" &&
      machine.freshness === "fresh" &&
      machine.requestedAgentBlocker === "opencode-supervisor-update-required" &&
      REUSABLE_MACHINE_STATES.has(machine.state),
  );
  if (repairBlocked !== undefined) {
    return unavailable("machine", "opencode-supervisor-update-required", repairBlocked.id);
  }
  return freezePlan({
    kind: "create-required",
    target: "machine",
    reason: "no-compatible-candidate",
  });
}

function validAgentSession(session: AgentSessionSelectionObservation): boolean {
  return (
    isSafePublicId(session.id) &&
    isSafePublicId(session.machineId) &&
    isSafeDisplay(session.name) &&
    AGENTS.has(session.agent) &&
    isSafePublicId(session.workspaceIdentity) &&
    Number.isSafeInteger(session.workspaceGeneration) &&
    session.workspaceGeneration >= 0 &&
    isSafeRelativeCwd(session.cwd) &&
    AUTH_MODES.has(session.authMode) &&
    PROCESS_STATES.has(session.processState) &&
    (session.attachment === "detached" ||
      session.attachment === "attached" ||
      session.attachment === "unknown") &&
    (session.freshness === "fresh" || session.freshness === "stale" || session.freshness === "unknown") &&
    Number.isFinite(Date.parse(session.createdAt))
  );
}

function isExactSessionKey(
  session: AgentSessionSelectionObservation,
  input: AgentSessionSelectionInput,
): boolean {
  return (
    session.machineId === input.machineId &&
    session.agent === input.requestedAgent &&
    session.workspaceIdentity === input.workspaceIdentity &&
    session.workspaceGeneration === input.workspaceGeneration &&
    session.cwd === input.cwd &&
    session.authMode === input.authMode
  );
}

function safeAgentSession(session: AgentSessionSelectionObservation): SafeAgentSessionCandidate {
  if (session.processState !== "ready" && session.processState !== "running") {
    throw new TypeError("A non-resumable agent session cannot become a selection candidate.");
  }
  return Object.freeze({
    id: session.id,
    name: session.name,
    agent: session.agent,
    cwd: session.cwd,
    state: session.processState,
    createdAt: session.createdAt,
  });
}

function sortAgentSessions(
  sessions: readonly AgentSessionSelectionObservation[],
): readonly SafeAgentSessionCandidate[] {
  return Object.freeze(
    [...sessions]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((session) => safeAgentSession(session)),
  );
}

function selectedAgentSession(
  session: AgentSessionSelectionObservation,
  source: SelectAgentSessionPlan["source"],
): SelectAgentSessionPlan {
  return freezePlan({
    kind: "select",
    target: "agent-session",
    source,
    machineId: session.machineId,
    agentSessionId: session.id,
    agentSession: safeAgentSession(session),
  });
}

function incompatibleSession(
  session: AgentSessionSelectionObservation,
  input: AgentSessionSelectionInput,
): IncompatiblePlan | undefined {
  let reason: IncompatiblePlan["reason"] | undefined;
  if (session.machineId !== input.machineId) reason = "machine-mismatch";
  else if (session.agent !== input.requestedAgent) reason = "agent-mismatch";
  else if (session.workspaceIdentity !== input.workspaceIdentity) reason = "workspace-identity-mismatch";
  else if (session.workspaceGeneration !== input.workspaceGeneration) reason = "workspace-generation-mismatch";
  else if (session.cwd !== input.cwd) reason = "cwd-mismatch";
  else if (session.authMode !== input.authMode) reason = "auth-mode-mismatch";
  if (reason === undefined) return undefined;
  return freezePlan({
    kind: "incompatible",
    target: "agent-session",
    targetId: session.id,
    reason,
  });
}

function sessionAvailabilityRejection(
  session: AgentSessionSelectionObservation,
): UnavailablePlan | undefined {
  if (session.freshness !== "fresh") {
    return unavailable("agent-session", "authority-observation-stale", session.id);
  }
  if (session.processState === "unknown") return unavailable("agent-session", "state-unknown", session.id);
  if (session.processState !== "ready" && session.processState !== "running") {
    return unavailable("agent-session", "state-not-reusable", session.id);
  }
  if (session.attachment === "unknown") return unavailable("agent-session", "state-unknown", session.id);
  if (session.attachment === "attached") return unavailable("agent-session", "already-attached", session.id);
  return undefined;
}

export function planAgentSessionSelection(
  input: AgentSessionSelectionInput,
): AgentSessionSelectionPlan {
  if (
    !isSafePublicId(input.machineId) ||
    !isSafePublicId(input.workspaceIdentity) ||
    !Number.isSafeInteger(input.workspaceGeneration) ||
    input.workspaceGeneration < 0 ||
    !isSafeRelativeCwd(input.cwd) ||
    !AGENTS.has(input.requestedAgent) ||
    !AUTH_MODES.has(input.authMode) ||
    (input.collectionFreshness !== "fresh" &&
      input.collectionFreshness !== "stale" &&
      input.collectionFreshness !== "unknown") ||
    !Array.isArray(input.agentSessions)
  ) {
    return unavailable("agent-session", "authority-data-invalid");
  }
  if (input.forceNewSession) {
    if (input.agentSessionId !== undefined) {
      return unavailable("agent-session", "contradictory-selection", input.agentSessionId);
    }
    return freezePlan({
      kind: "create-required",
      target: "agent-session",
      machineId: input.machineId,
      reason: "forced",
    });
  }
  if (input.collectionFreshness !== "fresh") {
    return unavailable("agent-session", "authority-observation-stale");
  }
  if (input.agentSessions.some((session) => !validAgentSession(session))) {
    return unavailable("agent-session", "authority-data-invalid");
  }
  if (hasDuplicateIds(input.agentSessions)) return unavailable("agent-session", "duplicate-id");

  if (input.agentSessionId !== undefined) {
    if (!isSafePublicId(input.agentSessionId)) {
      return unavailable("agent-session", "authority-data-invalid");
    }
    const session = input.agentSessions.find((candidate) => candidate.id === input.agentSessionId);
    if (session === undefined) return unavailable("agent-session", "not-found", input.agentSessionId);
    const incompatibility = incompatibleSession(session, input);
    if (incompatibility !== undefined) return incompatibility;
    const rejection = sessionAvailabilityRejection(session);
    return rejection ?? selectedAgentSession(session, "explicit");
  }

  const exact = input.agentSessions.filter((session) => isExactSessionKey(session, input));
  /*
   * Separate "the observation is old" from "this fact is not published at all".
   *
   * Both used to answer `authority-observation-stale`, and only one of them was
   * ever true. `attachment` is a hardcoded `"unknown"` (`api-effects.ts:76`)
   * because no per-AgentSession attachment authority exists yet, so EVERY exact
   * match reaches this branch and is refused as stale. Measured in production
   * 2026-08-30: three runs against machine 20ea0900 refused with
   * `authority-observation-stale` while the matched session's observation was
   * five seconds old with a valid runtime lease and a running process. Nothing
   * was stale; the CLI simply cannot see who is attached, and said the wrong
   * thing about it.
   *
   * The distinction is not cosmetic. Stale is transient and a retry is the
   * right advice; unobservable is a missing prerequisite, and telling someone
   * to retry it is telling them to wait for something that cannot arrive.
   */
  if (exact.some((session) => session.attachment === "unknown")) {
    return unavailable("agent-session", "attachment-unobservable");
  }
  if (
    exact.some(
      (session) =>
        session.freshness !== "fresh" ||
        session.processState === "unknown" ||
        session.processState === "starting" ||
        session.processState === "terminating",
    )
  ) {
    return unavailable("agent-session", "authority-observation-stale");
  }
  const reusable = exact.filter(
    (session) =>
      session.freshness === "fresh" &&
      (session.processState === "ready" || session.processState === "running") &&
      session.attachment === "detached",
  );
  if (reusable.length === 1 && reusable[0] !== undefined) {
    return selectedAgentSession(reusable[0], "unique-compatible");
  }
  if (reusable.length > 1) {
    return freezePlan({
      kind: "ambiguous",
      target: "agent-session",
      machineId: input.machineId,
      reason: "multiple-compatible-candidates",
      candidates: sortAgentSessions(reusable),
    });
  }
  return freezePlan({
    kind: "create-required",
    target: "agent-session",
    machineId: input.machineId,
    reason: "no-compatible-candidate",
  });
}

export function planJourneySelection(input: JourneySelectionInput): JourneySelectionPlan {
  const machinePlan = planMachineSelection(input.machine);
  if (machinePlan.kind !== "select" || machinePlan.target !== "machine") return machinePlan;
  return planAgentSessionSelection({
    ...input.agentSession,
    machineId: machinePlan.machineId,
  });
}
