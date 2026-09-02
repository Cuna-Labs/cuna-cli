import { decideCapability, type CunaApiClient } from "../api/client.js";
import type { AgentSession, Machine } from "../api/contracts.js";
import { sanitizeHumanTerminalOutput } from "../cli/output.js";
import { CunaError } from "../core/errors.js";
import { OBSERVATION_BUDGET_CODES } from "../core/observation-budget.js";
import { CredentialBoundaryError } from "../credentials/errors.js";
import { createNodeForegroundTerminalHost } from "../pty/node-host-terminal.js";
import { reconnectDelay, type ReconnectPolicy } from "../runtime/backoff.js";
import type { ForegroundTerminalHost } from "../terminal/foreground.js";
import { terminalCellWidth, truncateTerminalLine } from "../terminal/cell-width.js";
import { listAllMachines } from "./pagination.js";
import {
  isOpenCodeRuntimeUnverifiedReason,
  isOpenCodeSupervisorProtocolUnavailableReason,
  isOpenCodeSupervisorUpgradeRequiredReason,
} from "./opencode-supervisor.js";
import { machineProviderAvailability, providerDisplayName, providerVerdict, type ActionableProvider } from "./provider-availability.js";
import { classifySessionActionability, displaySessionActionability } from "./session-actionability.js";
import { isAgentSessionIntendedActive } from "./session-visibility.js";
import {
  INITIAL_MACHINE_FIRST_STATE,
  reduceMachineFirstNavigation,
  resolveMachineContextActions,
  resolveProviderContextActions,
  type MachineContextAction,
  type MachineFirstNavigationState,
  type MachineFirstScreen,
  type ProviderContextAction,
} from "./machine-first.js";

const encoder = new TextEncoder();
const SPINNER = Object.freeze(["◐", "◓", "◑", "◒"]);
const PROGRESS = Object.freeze(["━╺━━━━", "━━╺━━━", "━━━╺━━", "━━━━╺━", "━━━━━╺", "━━━━╸━", "━━━╸━━", "━━╸━━━"]);
const LIVE_REFRESH_MS = 10_000;
const ESCAPE_SEQUENCE_TIMEOUT_MS = 150;
const CLOSE_FRAME_MS = 90;
const CLOSE_FRAMES = Object.freeze(["✦ Closing Cuna...", "✧ Closing Cuna...", "✓ Closed."]);
/**
 * PRD-PM-008 E13-R3. A lifecycle request that outlives the per-request
 * response budget is not an error inside the screen: the Machine usually
 * did start. Read it back until the state converges or this budget lapses.
 */
const LIFECYCLE_CONVERGENCE_BUDGET_MS = 180_000;
const LIFECYCLE_POLL_INTERVAL_MS = 2_500;
const MACHINE_NAME_MAX_LENGTH = 80;
/**
 * PRD-PM-008 E13-R7. A retryable machine-list failure (a 5xx while the edge
 * redeploys, a transport failure) keeps the screen alive and is retried with
 * the runtime's backoff until this window lapses; only then is the notice
 * final and `r` the only retry. 1 s, 2 s, 4 s, 8 s, 8 s fits inside 30 s.
 */
const LIST_RETRY_WINDOW_MS = 30_000;
const LIST_RETRY_POLICY: ReconnectPolicy = Object.freeze({
  maximumAttempts: 5,
  maximumElapsedMs: LIST_RETRY_WINDOW_MS,
  initialDelayMs: 1_000,
  maximumDelayMs: 8_000,
  jitterRatio: 0.2,
});

const ANSI = Object.freeze({
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  ground: "\u001b[38;5;232m",
  orange: "\u001b[38;5;208m",
  flareBackground: "\u001b[48;5;202m",
  emberBackground: "\u001b[48;5;52m",
  cream: "\u001b[38;5;223m",
  green: "\u001b[38;5;42m",
  red: "\u001b[38;5;196m",
  cyan: "\u001b[38;5;45m",
  gray: "\u001b[38;5;245m",
});

interface MachineRow {
  readonly machine: Machine;
  readonly sessions: readonly AgentSession[];
  readonly sessionsLoading?: boolean;
  readonly sessionsError?: string | undefined;
  readonly canCreateSession?: boolean;
  /**
   * A missing, stale, or failed capability read is not evidence that creating
   * another session or another machine is appropriate.  Keep that distinction
   * separate from a current, verified "unsupported" answer.
   */
  readonly sessionCreateCapabilityState: "checking" | "verified" | "unverified";
  readonly sessionCreateCapabilityReason?: string | undefined;
  /** Expiry of the last accepted capability snapshot; never inferred locally. */
  readonly sessionCreateCapabilityExpiresAt?: number | undefined;
  /** Present only for the exact, current OpenCode repair refusal. */
  readonly opencodeSupervisorRepairReason: string | undefined;
  /**
   * The supervisor has not announced its OpenCode protocol yet. This is a
   * retryable observation wait, not permission to tell a person to update or
   * restart the Machine.
   */
  readonly opencodeSupervisorProtocolUnavailable: boolean;
  /** Current capability evidence says OpenCode is still being verified. */
  readonly opencodeRuntimeUnverified: boolean;
  /** E13-R3: a Start/Stop/Delete issued from this screen that has not converged. */
  readonly pendingLifecycle?: LifecycleAction | undefined;
}

type SelectionKey =
  | `machine:${string}`
  | `session:${string}`
  | `machine-provider:${ActionableProvider}`
  | `machine-create:${ActionableProvider}`
  | `machine-lifecycle:${LifecycleAction}`
  | `machine-supervisor:${"blocked" | "update"}`
  | `provider-session:${string}`
  | `create:${ActionableProvider}`
  | `new-machine:${ActionableProvider}`
  | "new-machine-name";
type LoadingPhase = "machines" | "sessions" | undefined;
type LifecycleAction = "start" | "stop" | "delete";

/** What the screen knows about `n  New machine` right now. */
type NewMachineState =
  | Readonly<{ readonly capability: "checking" }>
  | Readonly<{ readonly capability: "available" }>
  | Readonly<{ readonly capability: "unavailable"; readonly reason: string }>;

export interface MachinesExplorerInput {
  readonly client: CunaApiClient;
  readonly signal?: AbortSignal;
  readonly color?: boolean;
  readonly onBeforeTerminalOwnership?: () => void;
}

export interface MachinesExplorerDependencies {
  readonly host?: ForegroundTerminalHost;
  readonly now?: () => number;
  /** Test seam for E13-R3; production keeps the 2.5 s / 180 s defaults. */
  readonly convergence?: Readonly<{
    readonly pollIntervalMs?: number;
    readonly budgetMs?: number;
  }>;
  /** Test seam for E13-R7; production keeps the 30 s window and 1 s… backoff. */
  readonly listRetry?: Readonly<{
    readonly policy?: ReconnectPolicy;
    readonly windowMs?: number;
    readonly random?: () => number;
  }>;
}

export interface MachinesExplorerSelection {
  readonly kind: "attach";
  readonly agentSessionId: string;
  readonly agent: ActionableProvider;
}

export type MachinesExplorerResult = MachinesExplorerSelection | Readonly<{
  readonly kind: "launch";
  readonly agent: ActionableProvider;
  readonly machineId?: string;
  readonly machineName?: string;
  readonly newSession?: boolean;
}> | Readonly<{
  /**
   * Retained for callers that run lifecycle actions as batch commands. The
   * interactive screen no longer emits it: PRD-PM-008 E13-R3 requires Start,
   * Stop and Delete to run in place and survive the response budget.
   */
  readonly kind: "lifecycle";
  readonly action: "start" | "stop";
  readonly machineId: string;
}> | Readonly<{
  /**
   * PRD-PM-008 E13-R1: the person chose a provider and a name. The caller
   * runs the existing `machines create` path, which owns the capability
   * gate, the idempotency key and the post-create read.
   */
  readonly kind: "create";
  readonly agent: ActionableProvider;
  readonly name: string;
}> | Readonly<{
  /**
   * Reached only after the person selected the stopped-Machine repair and
   * confirmed it in this foreground UI. The caller still performs the normal
   * capability/state fences before any replacement request.
   */
  readonly kind: "supervisor-update";
  readonly machineId: string;
}>;

export type MachinesExplorerRunner = (
  input: MachinesExplorerInput,
  dependencies?: MachinesExplorerDependencies,
) => Promise<MachinesExplorerResult | undefined>;

export async function runNodeMachinesExplorer(
  input: MachinesExplorerInput,
  dependencies: MachinesExplorerDependencies = {},
): Promise<MachinesExplorerResult | undefined> {
  if (input.signal?.aborted) return;
  const host = dependencies.host ?? createNodeForegroundTerminalHost();
  input.onBeforeTerminalOwnership?.();
  const lease = await host.acquire("rich");
  if (input.signal?.aborted) {
    await lease.restore();
    return;
  }
  let rows: readonly MachineRow[] = [];
  let selectedKey: SelectionKey | undefined;
  let loadingPhase: LoadingPhase = "machines";
  // A rendered inventory is one completed observation. Keep evaluating that
  // snapshot at the time it was received while a slower refresh is in flight;
  // otherwise the same cached lease can appear to expire and then revive when
  // the renewed response arrives.
  let snapshotObservedAt = dependencies.now?.() ?? Date.now();
  let animationFrame = 0;
  let stopped = false;
  let refreshInFlight = false;
  /**
   * E13-R7. The one-line notice for a failed machine list. It carries the
   * typed reason and says whether Cuna is still retrying by itself.
   */
  let refreshError: string | undefined;
  /** The current outage: when it began and how many list attempts failed in it. */
  let listFailure: Readonly<{ readonly since: number; readonly attempt: number }> | undefined;
  let listRetryTimer: ReturnType<typeof setTimeout> | undefined;
  const listRetryPolicy = dependencies.listRetry?.policy ?? LIST_RETRY_POLICY;
  const listRetryWindowMs = dependencies.listRetry?.windowMs ?? LIST_RETRY_WINDOW_MS;
  const listRetryRandom = dependencies.listRetry?.random ?? Math.random;
  let interactionNotice: string | undefined;
  /**
   * Outcome of an in-place lifecycle action. Kept apart from
   * `interactionNotice` because a refresh clears that one, and the typed
   * budget notice must outlive the automatic refresh that follows it.
   */
  let lifecycleNotice: string | undefined;
  let pendingSupervisorUpdateMachineId: string | undefined;
  let pendingDeleteMachineId: string | undefined;
  let newMachine: NewMachineState = Object.freeze({ capability: "checking" });
  let newMachineName = "";
  let closingNotice: string | undefined;
  const pollIntervalMs = dependencies.convergence?.pollIntervalMs ?? LIFECYCLE_POLL_INTERVAL_MS;
  const convergenceBudgetMs = dependencies.convergence?.budgetMs ?? LIFECYCLE_CONVERGENCE_BUDGET_MS;
  let failure: unknown;
  const lifetimeAbort = new AbortController();
  const requestSignal = input.signal === undefined
    ? lifetimeAbort.signal
    : AbortSignal.any([input.signal, lifetimeAbort.signal]);
  const expanded = new Set<string>();
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  let renderQueue = Promise.resolve();
  let renderInFlight = false;
  let renderRequested = false;
  let firstRender = true;
  let previousLineCount = 0;
  let previousColumns: number | undefined;
  let previousRows: number | undefined;
  let inputSequence: "none" | "escape" | "cursor" = "none";
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  let initialized = false;
  let selection: MachinesExplorerResult | undefined;
  let navigation: MachineFirstNavigationState = INITIAL_MACHINE_FIRST_STATE;

  // A local exit fences every in-flight read with this controller before the
  // close animation has rendered its first frame.  Treat that fence itself as
  // closing state: otherwise an aborted capability read can win the tiny
  // interval before `closingNotice` is assigned and leak a misleading
  // `cuna.network.cancelled` error after a normal q/Ctrl-C exit.
  const isClosing = (): boolean => stopped || closingNotice !== undefined || lifetimeAbort.signal.aborted;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    lifetimeAbort.abort(new Error("Machines explorer detached."));
    finish();
  };

  const render = (): void => {
    if (stopped) return;
    renderRequested = true;
    if (renderInFlight) return;
    renderInFlight = true;
    renderQueue = renderQueue
      .then(async () => {
        while (renderRequested && !stopped) {
          renderRequested = false;
          const { columns, rows: terminalRows } = host.dimensions();
          const frame = renderMachinesExplorer({
            rows,
            ...(selectedKey === undefined ? {} : { selectedKey }),
            expanded,
            loadingPhase,
            animationFrame,
            columns,
            now: snapshotObservedAt,
            navigation,
            machinesListed: initialized,
            refreshError,
            interactionNotice,
            lifecycleNotice,
            closingNotice,
            newMachine,
            newMachineName,
          });
          const visible = selectVisibleLines(frame, terminalRows);
          const painted = paintMachinesExplorer(visible, columns, input.color ?? false);
          const sizeChanged = previousColumns !== undefined && (previousColumns !== columns || previousRows !== terminalRows);
          const linesToClear = sizeChanged ? 0 : Math.max(0, previousLineCount - painted.length);
          const outputLines = [...painted, ...Array.from({ length: linesToClear }, () => "")];
          const initialClear = firstRender || sizeChanged ? "\u001b[2J" : "";
          firstRender = false;
          previousLineCount = painted.length;
          previousColumns = columns;
          previousRows = terminalRows;
          await host.write(encoder.encode(
            `\u001b[?2026h\u001b[?25l${initialClear}\u001b[H${outputLines.map((line) => `${line}\u001b[K`).join("\r\n")}\u001b[?2026l`,
          ));
        }
      })
      .catch((error) => {
        failure ??= error;
        stop();
      })
      .finally(() => {
        renderInFlight = false;
        // A state change can request a repaint after the render loop observes
        // `renderRequested === false` but before this finalizer releases the
        // in-flight flag. Do not strand that final frame (notably the
        // zero-machine actions that replace the initial loading frame).
        if (renderRequested && !stopped) render();
      });
  };

  const exitWithFeedback = async (): Promise<void> => {
    if (stopped || closingNotice !== undefined) return;
    loadingPhase = undefined;
    // Closing is immediate from the product's point of view: cancel remote
    // reads before spending the short grace period on visual feedback. A
    // transport that ignores AbortSignal is still fenced by closingNotice at
    // every post-await effect boundary below.
    lifetimeAbort.abort(new Error("Machines explorer is closing."));
    for (const [index, notice] of CLOSE_FRAMES.entries()) {
      if (stopped) return;
      closingNotice = notice;
      render();
      await renderQueue;
      if (index < CLOSE_FRAMES.length - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, CLOSE_FRAME_MS));
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, CLOSE_FRAME_MS));
    stop();
  };

  const updateMachineRow = (machineId: string, update: Partial<MachineRow>): void => {
    rows = Object.freeze(rows.map((row) => row.machine.id === machineId
      ? Object.freeze({ ...row, ...update })
      : row));
  };

  const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref();
  });

  /**
   * E13-R2/R3. Run Start, Stop or Delete in place: capability gate, one
   * request, then a bounded read-back. A lapsed response budget is treated
   * as "the answer did not arrive", never as "the action failed" — the
   * owner's Machine was `running` a moment after the screen used to die.
   */
  const runLifecycle = async (machineId: string, action: LifecycleAction): Promise<void> => {
    const row = rows.find((candidate) => candidate.machine.id === machineId);
    if (row === undefined || row.pendingLifecycle !== undefined) return;
    const name = safeLine(row.machine.name);
    const settle = (): void => updateMachineRow(machineId, { pendingLifecycle: undefined });
    updateMachineRow(machineId, { pendingLifecycle: action });
    lifecycleNotice = undefined;
    selectedKey = undefined;
    render();
    const capabilityId = action === "delete" ? "machines.delete" : "machines.lifecycle";
    const decision = await decideExplorerCapability(input.client, "machine", machineId, capabilityId, dependencies.now?.() ?? Date.now(), requestSignal);
    if (isClosing()) return;
    if (decision.status !== "supported") {
      settle();
      lifecycleNotice = `${capabilityId} is not available for ${name}: ${decision.reason ?? decision.status}. Nothing was requested.`;
      reconcileSelection();
      return;
    }
    try {
      if (action === "delete") await input.client.deleteMachine(machineId);
      else await input.client.transitionMachine(machineId, action, requestSignal);
    } catch (error) {
      if (isClosing()) return;
      if (!(error instanceof CunaError && error.code === OBSERVATION_BUDGET_CODES.response)) {
        settle();
        lifecycleNotice = typedLifecycleFailure(error, name, action);
        reconcileSelection();
        return;
      }
      // The request outlived the response budget. The Machine may well have
      // moved; only the read-back below can say.
    }
    const expectedState = action === "start" ? "running" : action === "stop" ? "stopped" : "deleted";
    const deadline = Date.now() + convergenceBudgetMs;
    for (;;) {
      if (isClosing()) return;
      let converged = false;
      try {
        const observed = await input.client.getMachine(machineId, requestSignal);
        if (isClosing()) return;
        if (observed.id === machineId) {
          updateMachineRow(machineId, { machine: observed });
          converged = observed.state === expectedState;
        }
      } catch (error) {
        if (isClosing()) return;
        if (action === "delete" && error instanceof CunaError && error.code === "cuna.remote.not_found") {
          converged = true;
        } else {
          settle();
          lifecycleNotice = typedLifecycleFailure(error, name, action);
          reconcileSelection();
          return;
        }
      }
      if (converged) {
        settle();
        if (action === "delete") {
          rows = Object.freeze(rows.filter((candidate) => candidate.machine.id !== machineId));
          expanded.delete(machineId);
          if (navigation.screen.kind !== "machines" && navigation.screen.kind !== "new-machine"
            && navigation.screen.kind !== "new-machine-name" && navigation.screen.machineId === machineId) {
            navigation = INITIAL_MACHINE_FIRST_STATE;
          }
          lifecycleNotice = `Deleted ${name}.`;
        } else {
          lifecycleNotice = `${name} is ${expectedState}.`;
        }
        reconcileSelection();
        void refresh().catch((error) => { failure ??= error; stop(); });
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        settle();
        lifecycleNotice = `${OBSERVATION_BUDGET_CODES.convergence}: ${name} had not reached ${expectedState} after ${Math.round(convergenceBudgetMs / 1000)} s. Run \`cuna machines list\` to see its current state.`;
        reconcileSelection();
        return;
      }
      await sleep(Math.min(pollIntervalMs, remaining));
    }
  };

  /** E13-R1. `n` from any overview: read the account capability, then offer providers. */
  const openNewMachine = (): void => {
    interactionNotice = undefined;
    lifecycleNotice = undefined;
    pendingSupervisorUpdateMachineId = undefined;
    pendingDeleteMachineId = undefined;
    navigation = reduceMachineFirstNavigation(navigation, { type: "open-new-machine" });
    newMachine = Object.freeze({ capability: "checking" });
    selectedKey = undefined;
    render();
    void decideExplorerCapability(input.client, "account", undefined, "machines.create", dependencies.now?.() ?? Date.now(), requestSignal)
      .then((decision) => {
        if (isClosing()) return;
        newMachine = decision.status === "supported"
          ? Object.freeze({ capability: "available" })
          : Object.freeze({ capability: "unavailable", reason: decision.reason ?? decision.status });
        if (navigation.screen.kind === "new-machine") reconcileSelection();
      });
  };

  const chooseNewMachineProvider = (provider: ActionableProvider): void => {
    // The capability answer, not the key press, admits the name step.
    if (newMachine.capability !== "available") return;
    navigation = reduceMachineFirstNavigation(navigation, { type: "choose-new-machine-provider", provider });
    newMachineName = defaultMachineName(provider, rows.map((row) => row.machine.name));
    selectedKey = "new-machine-name";
    render();
  };

  const clearListRetry = (): void => {
    if (listRetryTimer === undefined) return;
    clearTimeout(listRetryTimer);
    listRetryTimer = undefined;
  };

  /**
   * E13-R7. The delay before the next automatic list attempt, or `undefined`
   * once the outage has used up the policy's attempts or the bounded window.
   * The elapsed time is measured from the first failure of this outage, so a
   * slow server cannot stretch the window by answering late.
   */
  const nextListRetryDelay = (attempt: number, elapsedMs: number): number | undefined => {
    if (attempt > listRetryPolicy.maximumAttempts) return undefined;
    const delay = reconnectDelay(attempt, listRetryPolicy, listRetryRandom);
    return elapsedMs + delay > listRetryWindowMs ? undefined : delay;
  };

  const scheduleListRetry = (delayMs: number): void => {
    clearListRetry();
    listRetryTimer = setTimeout(() => {
      listRetryTimer = undefined;
      if (isClosing()) return;
      void refresh().catch((error) => { failure ??= error; stop(); });
    }, delayMs);
    listRetryTimer.unref();
  };

  const refresh = async (): Promise<void> => {
    if (refreshInFlight || stopped) return;
    refreshInFlight = true;
    loadingPhase = "machines";
    render();
    try {
      const previousIds = new Set(rows.map((row) => row.machine.id));
      const previousRows = new Map(rows.map((row) => [row.machine.id, row]));
      const machines = await listAllMachines(input.client, requestSignal);
      if (stopped || closingNotice !== undefined) return;
      refreshError = undefined;
      listFailure = undefined;
      clearListRetry();
      interactionNotice = undefined;
      // The delete prompt lives in `interactionNotice`; once a refresh has
      // taken it off the screen, the next Enter must ask again, not delete.
      pendingDeleteMachineId = undefined;
      const capabilityNow = dependencies.now?.() ?? Date.now();
      const loaded = machines.map((machine): MachineRow => {
        const previous = previousRows.get(machine.id);
        const retainCapability = previous?.sessionCreateCapabilityState === "verified" &&
          (previous.sessionCreateCapabilityExpiresAt ?? 0) > capabilityNow;
        return Object.freeze({
          machine,
          sessions: previous?.sessions ?? Object.freeze([]),
          sessionsLoading: true,
          canCreateSession: retainCapability && previous!.canCreateSession === true,
          sessionCreateCapabilityState: retainCapability ? "verified" : "checking",
          sessionCreateCapabilityReason: retainCapability ? previous!.sessionCreateCapabilityReason : undefined,
          sessionCreateCapabilityExpiresAt: retainCapability ? previous!.sessionCreateCapabilityExpiresAt : undefined,
          opencodeSupervisorRepairReason: previous?.opencodeSupervisorRepairReason,
          opencodeSupervisorProtocolUnavailable: previous?.opencodeSupervisorProtocolUnavailable ?? false,
          opencodeRuntimeUnverified: previous?.opencodeRuntimeUnverified ?? false,
          pendingLifecycle: previous?.pendingLifecycle,
        });
      });
      loaded.sort((left, right) => left.machine.name.localeCompare(right.machine.name) || left.machine.id.localeCompare(right.machine.id));
      rows = Object.freeze(loaded);
      const currentIds = new Set(rows.map((row) => row.machine.id));
      for (const id of expanded) if (!currentIds.has(id)) expanded.delete(id);
      for (const row of rows) {
        if (!initialized || !previousIds.has(row.machine.id)) expanded.add(row.machine.id);
      }
      initialized = true;
      const visibleKeys = selectableKeys(rows, expanded, snapshotObservedAt, navigation, initialized);
      // Input remains live while the network refresh is pending. Reconcile the
      // selection that is current when the response is applied, rather than a
      // stale value captured before awaiting the API. Otherwise an arrow press
      // during refresh appears to work and then jumps back to the machine row.
      const currentSelection = selectedKey;
      selectedKey = currentSelection !== undefined && visibleKeys.includes(currentSelection)
        ? currentSelection
        : visibleKeys[0];
      loadingPhase = rows.length === 0 ? undefined : "sessions";
      render();

      await Promise.all(rows.map(async ({ machine }) => {
        // Session inventory is the useful, non-mutating first answer.  Do not
        // hide it behind a slower capability read: that used to make bare
        // `cuna` look frozen and made an existing session appear absent for
        // the entire capability timeout.
        const sessionsTask = listAllAgentSessions(input.client, machine.id, requestSignal)
          .then((observedSessions) => {
            if (stopped || closingNotice !== undefined) return;
            const previous = rows.find((row) => row.machine.id === machine.id)?.sessions ?? Object.freeze([]);
            const sessions = mergeAgentSessionObservations(previous, observedSessions)
              .filter(isAgentSessionIntendedActive)
              .sort((left, right) => left.agent.localeCompare(right.agent) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
            updateMachineRow(machine.id, {
              sessions: Object.freeze(sessions),
              sessionsLoading: false,
              sessionsError: undefined,
            });
            reconcileSelection();
          })
          .catch(() => {
            if (stopped || closingNotice !== undefined) return;
            const confirmed = rows.find((row) => row.machine.id === machine.id)?.sessions ?? Object.freeze([]);
            updateMachineRow(machine.id, {
              // A failed child read is not an authoritative empty membership
              // observation. Retain the last confirmed list and make the
              // partial failure explicit until a successful refresh replaces it.
              sessions: confirmed,
              sessionsLoading: false,
              sessionsError: "sessions unavailable",
            });
            reconcileSelection();
          });
        const capabilityTask = observeSessionCreateCapability(
          input.client,
          machine.id,
          dependencies.now?.() ?? Date.now(),
          requestSignal,
        ).then((capability) => {
          if (stopped || closingNotice !== undefined) return;
          const provider = machineProviderAvailability(machine);
          const repairReason = provider.agent === "opencode" &&
            isOpenCodeSupervisorUpgradeRequiredReason(capability.reason)
            ? capability.reason
            : undefined;
          const supervisorProtocolUnavailable = provider.agent === "opencode" &&
            isOpenCodeSupervisorProtocolUnavailableReason(capability.reason);
          const runtimeUnverified = provider.agent === "opencode" &&
            isOpenCodeRuntimeUnverifiedReason(capability.reason);
          updateMachineRow(machine.id, {
            canCreateSession: capability.canCreateSession,
            sessionCreateCapabilityState: capability.state,
            sessionCreateCapabilityReason: capability.reason,
            sessionCreateCapabilityExpiresAt: capability.expiresAt,
            opencodeSupervisorRepairReason: repairReason,
            opencodeSupervisorProtocolUnavailable: supervisorProtocolUnavailable,
            opencodeRuntimeUnverified: runtimeUnverified,
          });
          reconcileSelection();
        });
        await Promise.all([sessionsTask, capabilityTask]);
      }));
    } catch (error) {
      if (isClosing()) return;
      // E13-R7. Only a non-retryable failure (auth, policy, usage) leaves the
      // screen, and it leaves with the typed error. A retryable one is not
      // evidence that the inventory disappeared, and before any inventory it
      // is not an empty list either: keep what is known, say why the list is
      // unavailable, and retry within the bounded window.
      if (!isRetryableExplorerRefreshError(error)) throw error;
      const failedAt = Date.now();
      const attempt = (listFailure?.attempt ?? 0) + 1;
      listFailure = Object.freeze({ since: listFailure?.since ?? failedAt, attempt });
      const retryDelayMs = nextListRetryDelay(attempt, failedAt - listFailure.since);
      refreshError = listFailureNotice(error, rows.length > 0, retryDelayMs);
      if (retryDelayMs !== undefined) scheduleListRetry(retryDelayMs);
      render();
    } finally {
      snapshotObservedAt = dependencies.now?.() ?? Date.now();
      loadingPhase = undefined;
      refreshInFlight = false;
      render();
    }
  };

  const moveSelection = (delta: -1 | 1): void => {
    interactionNotice = undefined;
    lifecycleNotice = undefined;
    pendingSupervisorUpdateMachineId = undefined;
    pendingDeleteMachineId = undefined;
    const keys = selectableKeys(rows, expanded, snapshotObservedAt, navigation, initialized);
    if (keys.length === 0) return;
    const currentIndex = selectedKey === undefined ? -1 : keys.indexOf(selectedKey);
    const origin = currentIndex < 0 ? (delta > 0 ? -1 : keys.length) : currentIndex;
    selectedKey = keys[Math.min(keys.length - 1, Math.max(0, origin + delta))];
    navigation = reduceMachineFirstNavigation(navigation, { type: "move", delta, itemCount: keys.length });
    render();
  };

  const reconcileSelection = (): void => {
    const keys = selectableKeys(rows, expanded, snapshotObservedAt, navigation, initialized);
    if (selectedKey === undefined || !keys.includes(selectedKey)) selectedKey = keys[0];
    render();
  };

  const goBack = (): void => {
    interactionNotice = undefined;
    lifecycleNotice = undefined;
    pendingSupervisorUpdateMachineId = undefined;
    pendingDeleteMachineId = undefined;
    const previous = navigation;
    const previousScreen = previous.screen;
    navigation = reduceMachineFirstNavigation(navigation, { type: "back" });
    if (navigation !== previous) {
      const keys = selectableKeys(rows, expanded, snapshotObservedAt, navigation, initialized);
      if (previousScreen.kind === "machine" && navigation.screen.kind === "machines") {
        const parentKey: SelectionKey = `machine:${previousScreen.machineId}`;
        selectedKey = keys.includes(parentKey) ? parentKey : keys[0];
      } else if (previousScreen.kind === "provider" && navigation.screen.kind === "machine") {
        const row = rows.find((candidate) => candidate.machine.id === previousScreen.machineId);
        const providerAction = row === undefined
          ? undefined
          : machineContextActions(row, snapshotObservedAt).find(
              (action) => action.kind === "provider" && action.provider === previousScreen.provider,
            );
        const parentKey = providerAction === undefined ? undefined : machineActionSelectionKey(providerAction);
        selectedKey = parentKey !== undefined && keys.includes(parentKey) ? parentKey : keys[0];
      } else {
        selectedKey = keys[0];
      }
      render();
    }
  };

  const activateOverviewSession = (sessionId: string): boolean => {
    const row = rows.find((candidate) => candidate.sessions.some((session) => session.id === sessionId));
    const session = row?.sessions.find((candidate) => candidate.id === sessionId);
    if (row === undefined || session === undefined || !isActionableProvider(session.agent)) return false;
    const actionability = classifySessionActionability({ session, machine: row.machine, now: snapshotObservedAt });
    if (actionability.canAttach) {
      selection = Object.freeze({ kind: "attach", agentSessionId: session.id, agent: session.agent });
      stop();
      return true;
    }
    if (actionability.recoveryAction === "refresh") {
      void refresh().catch((error) => { failure ??= error; stop(); });
      return false;
    }
    if (actionability.recoveryAction === "wait") {
      interactionNotice = hasLegacySupervisorBlockedOpenCodeSession(row) &&
        session.agent === "opencode" && isUnobservedLaunchedSession(session)
        ? legacySupervisorBlockedNotice()
        : waitingForSessionObservation(session);
      render();
      return false;
    }
    interactionNotice = `Session ended. Open ${safeLine(row.machine.name)} to start a new ${providerDisplayName(session.agent)} session.`;
    render();
    return false;
  };

  const goForward = (): void => {
    pendingSupervisorUpdateMachineId = undefined;
    pendingDeleteMachineId = undefined;
    if (selectedKey?.startsWith("new-machine:") === true && navigation.screen.kind === "new-machine") {
      chooseNewMachineProvider(selectedKey.slice("new-machine:".length) as ActionableProvider);
      return;
    }
    if (selectedKey?.startsWith("machine:") === true && navigation.screen.kind === "machines") {
      const machineId = selectedKey.slice("machine:".length);
      navigation = reduceMachineFirstNavigation(navigation, { type: "open-machine", machineId });
      selectedKey = selectableKeys(rows, expanded, snapshotObservedAt, navigation, initialized)[0];
      render();
      return;
    }
    if (selectedKey?.startsWith("session:") === true && navigation.screen.kind === "machines") {
      const sessionId = selectedKey.slice("session:".length);
      activateOverviewSession(sessionId);
      return;
    }
    if ((selectedKey?.startsWith("machine-provider:") === true || selectedKey?.startsWith("machine-lifecycle:") === true)
      && navigation.screen.kind === "machine") {
      const screen = navigation.screen;
      const row = rows.find((candidate) => candidate.machine.id === screen.machineId);
      const action = row === undefined
        ? undefined
        : machineContextActions(row, snapshotObservedAt).find((candidate) => machineActionSelectionKey(candidate) === selectedKey);
      if (action?.kind === "provider") {
        navigation = reduceMachineFirstNavigation(navigation, {
          type: "open-provider",
          machineId: action.machineId,
          provider: action.provider,
        });
        selectedKey = selectableKeys(rows, expanded, snapshotObservedAt, navigation, initialized)[0];
        render();
      }
    }
  };

  const applyCursorFinal = (byte: number): void => {
    if (byte === 0x41) moveSelection(-1);
    else if (byte === 0x42) moveSelection(1);
    else if (byte === 0x43) goForward();
    else if (byte === 0x44) goBack();
  };

  const applyKey = (byte: number): boolean => {
    if (closingNotice !== undefined) return true;
    // `q` is a letter inside the name field; Ctrl-C quits from anywhere.
    if (byte === 0x03 || (byte === 0x71 && navigation.screen.kind !== "new-machine-name")) {
      void exitWithFeedback().catch((error) => { failure ??= error; stop(); });
      return true;
    }
    if (inputSequence === "escape") {
      if (escapeTimer !== undefined) clearTimeout(escapeTimer);
      escapeTimer = undefined;
      inputSequence = "none";
      if (byte === 0x5b || byte === 0x4f) {
        inputSequence = "cursor";
        return false;
      }
      return applyKey(byte);
    }
    if (inputSequence === "cursor") {
      if ((byte >= 0x30 && byte <= 0x3f) || (byte >= 0x20 && byte <= 0x2f)) return false;
      inputSequence = "none";
      applyCursorFinal(byte);
      return false;
    }
    if (byte === 0x1b) {
      inputSequence = "escape";
      escapeTimer = setTimeout(() => {
        if (inputSequence !== "escape") return;
        inputSequence = "none";
        escapeTimer = undefined;
        goBack();
      }, ESCAPE_SEQUENCE_TIMEOUT_MS);
      escapeTimer.unref();
      return false;
    }
    if (navigation.screen.kind === "new-machine-name") {
      // A text field: every printable byte is a character, including the
      // letters that are hotkeys everywhere else. Only Ctrl-C, Esc and the
      // cursor sequences above keep their meaning.
      const provider = navigation.screen.provider;
      if (byte === 0x0d || byte === 0x0a) {
        const name = newMachineName.trim();
        if (name.length === 0) {
          interactionNotice = "Give the Machine a name, then press Enter.";
          render();
          return false;
        }
        selection = Object.freeze({ kind: "create", agent: provider, name });
        stop();
        return true;
      }
      if (byte === 0x08 || byte === 0x7f) {
        newMachineName = newMachineName.slice(0, -1);
      } else if (byte >= 0x20 && byte <= 0x7e && newMachineName.length < MACHINE_NAME_MAX_LENGTH) {
        newMachineName += String.fromCharCode(byte);
      }
      interactionNotice = undefined;
      render();
      return false;
    }
    if (byte === 0x6b) moveSelection(-1);
    else if (byte === 0x6a) moveSelection(1);
    else if (byte === 0x08 || byte === 0x7f || byte === 0x62) goBack();
    else if (byte === 0x6e && navigation.screen.kind === "machines") openNewMachine();
    else if (byte === 0x0d || byte === 0x0a || byte === 0x20) {
      if (navigation.screen.kind === "new-machine") {
        if (selectedKey?.startsWith("new-machine:") === true) {
          chooseNewMachineProvider(selectedKey.slice("new-machine:".length) as ActionableProvider);
        }
        return false;
      }
      if (selectedKey?.startsWith("machine:") === true) {
        const id = selectedKey.slice("machine:".length);
        // A Machine is a container, not a synonym for whichever session
        // happens to be unique right now.  Attaching is an explicit action on
        // a concrete AgentSession only; this keeps one-key navigation read-only
        // and prevents a stale/unique child from being opened by surprise.
        navigation = reduceMachineFirstNavigation(navigation, { type: "open-machine", machineId: id });
        selectedKey = selectableKeys(rows, expanded, snapshotObservedAt, navigation, initialized)[0];
        render();
      } else if (selectedKey?.startsWith("session:") === true && navigation.screen.kind === "machines") {
        return activateOverviewSession(selectedKey.slice("session:".length));
      } else if ((selectedKey?.startsWith("machine-provider:") === true || selectedKey?.startsWith("machine-create:") === true
        || selectedKey?.startsWith("machine-lifecycle:") === true || selectedKey?.startsWith("machine-supervisor:") === true)
        && navigation.screen.kind === "machine") {
        const screen = navigation.screen;
        const row = rows.find((candidate) => candidate.machine.id === screen.machineId);
        const action = row === undefined
          ? undefined
          : machineContextActions(row, snapshotObservedAt).find((candidate) => machineActionSelectionKey(candidate) === selectedKey);
        if (action?.kind === "provider") {
          navigation = reduceMachineFirstNavigation(navigation, {
            type: "open-provider",
            machineId: action.machineId,
            provider: action.provider,
          });
          selectedKey = selectableKeys(rows, expanded, snapshotObservedAt, navigation, initialized)[0];
          render();
        } else if (action?.kind === "start" || action?.kind === "stop") {
          pendingDeleteMachineId = undefined;
          void runLifecycle(action.machineId, action.kind).catch((error) => { failure ??= error; stop(); });
        } else if (action?.kind === "delete") {
          // E13-R2: double confirmation, like the supervisor repair, naming
          // the Machine and what disappears with it. No request before the
          // second Enter; any move or back re-arms it.
          if (pendingDeleteMachineId !== action.machineId) {
            pendingDeleteMachineId = action.machineId;
            const sessionCount = row?.sessions.length ?? 0;
            interactionNotice = `Press Enter again to delete ${safeLine(row?.machine.name ?? "this Machine")} and its ${sessionCount} AgentSession${sessionCount === 1 ? "" : "s"}. This cannot be undone.`;
            render();
            return false;
          }
          pendingDeleteMachineId = undefined;
          interactionNotice = undefined;
          void runLifecycle(action.machineId, "delete").catch((error) => { failure ??= error; stop(); });
        } else if (action?.kind === "supervisor-blocked") {
          pendingSupervisorUpdateMachineId = undefined;
          interactionNotice = row !== undefined && hasLegacySupervisorBlockedOpenCodeSession(row)
            ? legacySupervisorBlockedNotice()
            : row?.machine.state === "stopped"
            ? "OpenCode is ready for a terminal update. Select Update terminal supervisor, then press Enter again to confirm."
            : `Protected: Cuna will not stop ${safeLine(row?.machine.name ?? "this Machine")} or terminate AgentSessions. Stop it yourself when you are ready; the update will then be available here.`;
          render();
        } else if (action?.kind === "update-supervisor") {
          if (pendingSupervisorUpdateMachineId !== action.machineId) {
            pendingSupervisorUpdateMachineId = action.machineId;
            interactionNotice = "Press Enter again to update the terminal supervisor. Cuna will not stop the Machine or terminate AgentSessions.";
            render();
            return false;
          }
          selection = Object.freeze({ kind: "supervisor-update", machineId: action.machineId });
          stop();
          return true;
        } else if (action?.kind === "new-session") {
          selection = Object.freeze({
            kind: "launch",
            agent: action.provider,
            newSession: true,
            machineId: row!.machine.id,
            machineName: row!.machine.name,
          });
          stop();
          return true;
        }
      } else if (selectedKey?.startsWith("provider-session:") === true
        && navigation.screen.kind === "provider") {
        const screen = navigation.screen;
        const row = rows.find((candidate) => candidate.machine.id === screen.machineId);
        const action = row === undefined ? undefined : resolveProviderContextActions({
          machine: row.machine,
          provider: screen.provider,
          sessions: row.sessions,
          now: snapshotObservedAt,
        }).find((candidate) => providerActionSelectionKey(candidate) === selectedKey);
        if (action?.kind === "session") {
          const actionability = classifySessionActionability({ session: action.session, machine: row!.machine, now: snapshotObservedAt });
          if (actionability.canAttach) {
            selection = Object.freeze({ kind: "attach", agentSessionId: action.session.id, agent: action.session.agent as ActionableProvider });
            stop();
            return true;
          }
          if (actionability.recoveryAction === "refresh") {
            void refresh().catch((error) => { failure ??= error; stop(); });
          } else if (actionability.recoveryAction === "wait") {
            interactionNotice = row !== undefined && hasLegacySupervisorBlockedOpenCodeSession(row) &&
              action.session.agent === "opencode" && isUnobservedLaunchedSession(action.session)
              ? legacySupervisorBlockedNotice()
              : waitingForSessionObservation(action.session);
            render();
          } else {
            render();
          }
        }
      } else if (selectedKey?.startsWith("create:") === true) {
        const agent = selectedKey.slice("create:".length) as ActionableProvider;
        selection = Object.freeze({ kind: "launch", agent });
        stop();
        return true;
      } else if (selectedKey?.startsWith("session:") === true) {
        const id = selectedKey.slice("session:".length);
        const session = rows.flatMap((row) => row.sessions).find((candidate) => candidate.id === id);
        const row = rows.find((candidate) => candidate.sessions.some((item) => item.id === id));
        const actionability = session === undefined || row === undefined ? undefined : classifySessionActionability({
          session,
          machine: row.machine,
          now: snapshotObservedAt,
          refreshStatus: row.sessionsLoading === true ? "pending" : "idle",
        });
        if (session !== undefined && isActionableProvider(session.agent) && actionability?.canAttach === true) {
          selection = Object.freeze({ kind: "attach", agentSessionId: session.id, agent: session.agent });
          stop();
          return true;
        }
        if (actionability?.recoveryAction === "refresh") {
          void refresh().catch((error) => { failure ??= error; stop(); });
        } else if (actionability?.recoveryAction === "wait") {
          interactionNotice = row !== undefined && hasLegacySupervisorBlockedOpenCodeSession(row) &&
            session?.agent === "opencode" && isUnobservedLaunchedSession(session)
            ? legacySupervisorBlockedNotice()
            : waitingForSessionObservation(session!);
          render();
        } else if (actionability?.recoveryAction === "authenticate") {
          // Authentication owns the same provider PTY, but remains distinct
          // from an already-attachable base state in the policy.
          if (session !== undefined && isActionableProvider(session.agent)) {
            selection = Object.freeze({ kind: "attach", agentSessionId: session.id, agent: session.agent });
            stop();
            return true;
          }
        } else {
          // A visible but non-attachable supported session is still a useful
          // navigation target. Open its provider context instead of making
          // Enter appear broken; no attach or mutation is attempted.
          if (session !== undefined && isActionableProvider(session.agent)) goForward();
          else render();
        }
      }
    } else if (byte === 0x72) {
      // E13-R7: a person's retry opens a fresh bounded window; it is not one
      // more attempt charged against the automatic one.
      listFailure = undefined;
      clearListRetry();
      void refresh().catch((error) => { failure ??= error; stop(); });
    }
    return false;
  };

  const removeInput = host.onInput((bytes) => {
    for (const byte of bytes) {
      if (applyKey(byte)) break;
    }
  });
  const removeResize = host.onResize(render);
  const onAbort = (): void => {
    void exitWithFeedback().catch((error) => { failure ??= error; stop(); });
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const animationTimer = setInterval(() => {
    if (loadingPhase === undefined || stopped) return;
    animationFrame = (animationFrame + 1) % PROGRESS.length;
    render();
  }, 90);
  animationTimer.unref();
  const liveRefreshTimer = setInterval(() => {
    void refresh().catch((error) => { failure ??= error; stop(); });
  }, LIVE_REFRESH_MS);
  liveRefreshTimer.unref();

  try {
    try {
      await refresh();
    } catch (error) {
      if (!stopped && closingNotice === undefined) throw error;
    }
    if (!stopped) await done;
    await renderQueue;
    if (failure !== undefined) throw failure;
  } finally {
    clearInterval(animationTimer);
    clearInterval(liveRefreshTimer);
    clearListRetry();
    if (escapeTimer !== undefined) clearTimeout(escapeTimer);
    stopped = true;
    removeInput();
    removeResize();
    input.signal?.removeEventListener("abort", onAbort);
    await lease.restore();
  }
  return selection;
}

async function observeSessionCreateCapability(
  client: CunaApiClient,
  machineId: string,
  now: number,
  signal?: AbortSignal,
): Promise<Readonly<{
  readonly canCreateSession: boolean;
  readonly state: "verified" | "unverified";
  readonly reason?: string;
  readonly expiresAt?: number;
}>> {
  if (typeof client.discoverCapabilities !== "function") {
    return Object.freeze({
      canCreateSession: false,
      state: "unverified",
      reason: "capability_discovery_unavailable",
    });
  }
  try {
    const snapshot = await client.discoverCapabilities("machine", machineId, signal);
    const decision = decideCapability(snapshot, "agent_sessions.create", now);
    const expiresAt = Date.parse(snapshot.expiresAt);
    return Object.freeze({
      canCreateSession: decision.status === "supported",
      state: decision.status === "unknown" ? "unverified" : "verified",
      ...(decision.status === "supported" ? {} : { reason: decision.reason }),
      ...(decision.status === "unknown" ? {} : { expiresAt }),
    });
  } catch {
    return Object.freeze({
      canCreateSession: false,
      state: "unverified",
      reason: "capability_discovery_unavailable",
    });
  }
}

async function listAllAgentSessions(
  client: CunaApiClient,
  machineId: string,
  signal?: AbortSignal,
): Promise<readonly AgentSession[]> {
  const items: AgentSession[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listAgentSessions(machineId, {
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    }, signal);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== undefined && cursors.has(cursor)) throw new Error("AgentSession pagination repeated a cursor.");
    if (cursor !== undefined) cursors.add(cursor);
  } while (cursor !== undefined);
  return Object.freeze(items);
}

function mergeAgentSessionObservations(
  confirmed: readonly AgentSession[],
  candidates: readonly AgentSession[],
): readonly AgentSession[] {
  const prior = new Map(confirmed.map((session) => [session.id, session]));
  const merged = new Map<string, AgentSession>();
  for (const candidate of candidates) {
    const previous = prior.get(candidate.id);
    // Successful membership is authoritative: an omitted ID is removed. For
    // IDs still present, only a strictly newer revision may replace the last
    // confirmed observation.
    merged.set(candidate.id, previous === undefined || candidate.rowVersion > previous.rowVersion ? candidate : previous);
  }
  return Object.freeze([...merged.values()]);
}

interface MachinesExplorerFrame {
  readonly lines: readonly string[];
  readonly selectedLine?: number;
}

function renderMachinesExplorer(input: {
  readonly rows: readonly MachineRow[];
  readonly selectedKey?: SelectionKey | undefined;
  readonly expanded: ReadonlySet<string>;
  readonly loadingPhase: LoadingPhase;
  readonly animationFrame: number;
  readonly columns: number;
  readonly now: number;
  readonly navigation: MachineFirstNavigationState;
  /** E13-R7: at least one machine list has succeeded. Until then an empty `rows` is not an empty inventory. */
  readonly machinesListed: boolean;
  readonly refreshError?: string | undefined;
  readonly interactionNotice?: string | undefined;
  readonly lifecycleNotice?: string | undefined;
  readonly closingNotice?: string | undefined;
  readonly newMachine: NewMachineState;
  readonly newMachineName: string;
}): MachinesExplorerFrame {
  if (input.closingNotice !== undefined) {
    return {
      lines: [machineHeader("Machines"), "", ` ${input.closingNotice}`, " Returning to your terminal."],
    };
  }
  if (input.navigation.screen.kind === "new-machine" || input.navigation.screen.kind === "new-machine-name") {
    return renderNewMachineScreen(input, input.navigation.screen);
  }
  if (input.navigation.screen.kind !== "machines") return renderContextScreen(input);
  const lines = [machineHeader("Machines"), " Your machines and the agents running inside them.", ""];
  let selectedLine: number | undefined;
  const offerGlobalCreation = shouldOfferGlobalCreation(input.rows, input.now, input.machinesListed);
  if (input.loadingPhase === "machines" && input.rows.length === 0) {
    lines.push(loaderLine("Discovering machines", input.animationFrame));
  } else if (!input.machinesListed) {
    // E13-R7: no list has succeeded yet. This is an error state, not an
    // empty inventory; the notice below carries the typed reason.
    lines.push("Machines could not be listed.");
  } else if (input.rows.length === 0) {
    lines.push("No machines yet. Choose a supported configuration:");
    for (const agent of providerCreationOrder()) {
      const key: SelectionKey = `create:${agent}`;
      const selected = input.selectedKey === key;
      if (selected) selectedLine = lines.length;
      lines.push(`${selected ? "❯" : " "} Create ${providerDisplayName(agent)} machine`);
    }
  }
  for (const row of input.rows) {
    const open = input.expanded.has(row.machine.id);
    const machineKey: SelectionKey = `machine:${row.machine.id}`;
    const machineSelected = input.selectedKey === machineKey;
    if (machineSelected) selectedLine = lines.length;
    const provider = machineProviderAvailability(row.machine);
    // One fact the reader acts on: how many agents run here. The former
    // three-provider tally (`OpenCode 0/0 live · Claude 0/0 live · Codex 0/0
    // live`) repeated on every machine, including stopped and errored ones,
    // was the loudest line on the screen and answered nothing.
    const sessions = row.sessionsLoading === true && row.sessions.length === 0
      ? "…"
      : row.sessionsError !== undefined
        ? "sessions ?"
        : row.sessions.length === 0
          ? "no sessions"
          : `${row.sessions.length} session${row.sessions.length === 1 ? "" : "s"}`;
    // `usability` is the declaration, not the verdict. Printing it raw said
    // `declared-installed` — a word the reader cannot act on, and worse, one
    // that reads as usable on exactly the machines where the next command
    // fails closed. `providerVerdict` is the reconciliation the other surfaces
    // already use, which is what makes this row agree with `machines list`.
    //
    // E13-R4: the verdict is about a runtime, so it exists only while the
    // Machine is `running`. `OpenCode ready` on a stopped or errored Machine
    // was the declaration again, wearing the verdict's clothes. E13-R3: a
    // Machine mid-transition shows the transition, not the stale state.
    const pending = row.pendingLifecycle;
    const state = pending !== undefined
      ? lifecycleLabel(pending)
      : row.machine.state === "running"
        ? `${safeLine(row.machine.state)}  ${provider.displayName} ${providerVerdict(provider)}`
        : safeLine(row.machine.state);
    lines.push(`${machineSelected ? "❯" : " "} ${open ? "▾" : "▸"} ${safeLine(row.machine.name)}  ${state}  ${sessions}`);
    if (!open) continue;
    if (row.sessionsLoading === true && row.sessions.length === 0) {
      lines.push(`    ${loaderLine("Loading AgentSessions", input.animationFrame)}`);
      continue;
    }
    if (row.sessions.length === 0) {
      // E13-R5: decide the whole child list first, then assign glyphs, so
      // `├─` can only ever precede a sibling. The old per-line guesses
      // printed `├─ No AgentSessions` when the runtime line that would have
      // followed was itself suppressed on a non-running Machine.
      const children: string[] = [];
      if (row.sessionsError !== undefined) children.push(`${row.sessionsError}; showing last confirmed sessions`);
      else children.push("No AgentSessions");
      if (row.opencodeSupervisorRepairReason !== undefined) children.push(openCodeRepairSummary(row));
      if (row.opencodeSupervisorProtocolUnavailable) children.push(openCodeSupervisorProtocolWaitSummary());
      // Only a running machine can be verified; on a stopped or errored one
      // the line is noise the reader cannot act on.
      if (row.opencodeRuntimeUnverified && row.machine.state === "running") children.push("OpenCode runtime not verified yet");
      for (const [childIndex, child] of children.entries()) {
        lines.push(`    ${childIndex === children.length - 1 ? "└─" : "├─"} ${child}`);
      }
      continue;
    }
    if (row.sessionsError !== undefined) lines.push(`    ├─ ${row.sessionsError}; showing last confirmed sessions`);
    for (const [sessionIndex, session] of row.sessions.entries()) {
      const branch = sessionIndex === row.sessions.length - 1 ? "└─" : "├─";
      const sessionKey: SelectionKey = `session:${session.id}`;
      const sessionSelected = input.selectedKey === sessionKey;
      if (sessionSelected) selectedLine = lines.length;
      const actionability = classifySessionActionability({
        session,
        machine: row.machine,
        now: input.now,
        refreshStatus: row.sessionsLoading === true ? "pending" : "idle",
      });
      lines.push(`${sessionSelected ? "❯" : " "}   ${branch} ${providerDisplayName(session.agent)} · ${safeLine(session.name)}  ${displaySessionActionability(actionability)}`);
      lines.push(`       ${session.id} · ${safeLine(session.cwd)}`);
    }
    if (row.opencodeSupervisorRepairReason !== undefined) {
      lines.push(`     ${openCodeRepairSummary(row)}`);
      if (hasLegacySupervisorBlockedOpenCodeSession(row)) lines.push(`     ${legacySupervisorRecoveryRoute()}`);
    }
    if (row.opencodeSupervisorProtocolUnavailable) {
      lines.push(`     ${openCodeSupervisorProtocolWaitSummary()}`);
    }
    if (row.opencodeRuntimeUnverified && row.machine.state === "running") {
      lines.push("     OpenCode runtime not verified yet");
    }
  }
  const capacityNotice = overviewSessionCreateCapacityNotice(input.rows);
  if (capacityNotice !== undefined) lines.push("", capacityNotice);
  if (input.rows.length > 0 && offerGlobalCreation) {
    lines.push("", "No available machine can open an AgentSession. Create a supported machine:");
    for (const agent of providerCreationOrder()) {
      const key: SelectionKey = `create:${agent}`;
      const selected = input.selectedKey === key;
      if (selected) selectedLine = lines.length;
      lines.push(`${selected ? "❯" : " "} Create ${providerDisplayName(agent)} machine`);
    }
  }
  if (input.loadingPhase === "sessions" && input.rows.length > 0) {
    lines.push("", loaderLine("Refreshing live sessions", input.animationFrame));
  }
  if (input.refreshError !== undefined) lines.push("", input.refreshError);
  if (input.interactionNotice !== undefined) lines.push("", input.interactionNotice);
  if (input.lifecycleNotice !== undefined) lines.push("", ` ${input.lifecycleNotice}`);
  lines.push("", overviewFooter(input.rows, input.selectedKey, input.now));
  return Object.freeze({
    lines: Object.freeze(lines.map((line) => truncateTerminalLine(line, input.columns))),
    ...(selectedLine === undefined ? {} : { selectedLine }),
  });
}

function renderContextScreen(input: {
  readonly rows: readonly MachineRow[];
  readonly selectedKey?: SelectionKey | undefined;
  readonly loadingPhase: LoadingPhase;
  readonly animationFrame: number;
  readonly columns: number;
  readonly now: number;
  readonly navigation: MachineFirstNavigationState;
  readonly refreshError?: string | undefined;
  readonly interactionNotice?: string | undefined;
  readonly lifecycleNotice?: string | undefined;
}): MachinesExplorerFrame {
  const screen = input.navigation.screen;
  if (screen.kind !== "machine" && screen.kind !== "provider") return Object.freeze({ lines: Object.freeze([]) });
  const row = input.rows.find((candidate) => candidate.machine.id === screen.machineId);
  const lines = [machineHeader("Machine"), ""];
  if (row === undefined) {
    lines.push("Machine observation is no longer available.", "", " ←/Esc/Backspace back  ·  q quit");
    return Object.freeze({ lines: Object.freeze(lines.map((line) => truncateTerminalLine(line, input.columns))) });
  }
  const pending = row.pendingLifecycle;
  lines[0] = machineHeader(screen.kind === "provider"
    ? `${safeLine(row.machine.name)} / ${providerDisplayName(screen.provider)} sessions`
    : safeLine(row.machine.name));
  lines[1] = ` ${pending === undefined ? safeLine(row.machine.state) : lifecycleLabel(pending)} · observation ${safeLine(row.machine.updatedAt ?? "unversioned")}`;
  lines.push("");
  const actions = pending !== undefined
    ? []
    : screen.kind === "machine"
      ? machineContextActions(row, input.now)
      : resolveProviderContextActions({
          machine: row.machine,
          provider: screen.provider,
          sessions: row.sessions,
          now: input.now,
        });
  let selectedLine: number | undefined;
  if (pending !== undefined) {
    lines.push(` ${lifecycleLabel(pending)} Cuna is reading the Machine back until it settles; this screen stays open.`);
  } else if (actions.length === 0) {
    lines.push(" No available actions for this observation.");
  }
  for (const action of actions) {
    const key = screen.kind === "machine"
      ? machineActionSelectionKey(action as MachineContextAction)
      : providerActionSelectionKey(action as ProviderContextAction);
    const selected = input.selectedKey === key;
    if (selected) selectedLine = lines.length;
    const detail = action.kind === "session"
      ? displaySessionActionability(classifySessionActionability({ session: action.session, machine: row.machine, now: input.now }))
      : action.kind === "provider" ? "sessions" : "";
    const label = action.kind === "start" || action.kind === "stop" || action.kind === "delete" ? `${action.label} machine` : action.label;
    lines.push(`${selected ? "❯" : " "} ${label}${detail === "" ? "" : `  ${detail}`}`);
  }
  if (row.opencodeSupervisorRepairReason !== undefined) {
    lines.push("");
    lines.push(` ${openCodeRepairSummary(row)}`);
    if (row.machine.state === "stopped") {
      lines.push(" Select Update terminal supervisor, then press Enter again to confirm.");
    } else if (hasLegacySupervisorBlockedOpenCodeSession(row)) {
      lines.push(` ${legacySupervisorRecoveryRoute()}`);
    } else {
      lines.push(" Protected: stop this Machine yourself after ending only the sessions you no longer need.");
    }
  }
  if (row.opencodeSupervisorProtocolUnavailable) {
    lines.push("");
    lines.push(` ${openCodeSupervisorProtocolWaitSummary()}`);
    lines.push(" Keep this Machine running; Cuna refreshes status automatically. Press r to check now.");
  }
  if (row.opencodeRuntimeUnverified) {
    lines.push("");
    lines.push(" Checking OpenCode runtime. No new OpenCode session was requested.");
    lines.push(" Keep this Machine running; Cuna refreshes status automatically. Press r to check now.");
  }
  const capacityNotice = sessionCreateCapacityNotice(row);
  if (capacityNotice !== undefined) {
    lines.push("");
    lines.push(` ${capacityNotice}`);
  }
  if (input.loadingPhase !== undefined) lines.push("", loaderLine("Refreshing machine", input.animationFrame));
  if (input.refreshError !== undefined) lines.push("", input.refreshError);
  if (input.interactionNotice !== undefined) lines.push("", input.interactionNotice);
  if (input.lifecycleNotice !== undefined) lines.push("", ` ${input.lifecycleNotice}`);
  lines.push("", " ↑↓ move  ·  ←→ navigate  ·  Enter select  ·  Esc/Backspace back  ·  q quit");
  return Object.freeze({
    lines: Object.freeze(lines.map((line) => truncateTerminalLine(line, input.columns))),
    ...(selectedLine === undefined ? {} : { selectedLine }),
  });
}

function selectVisibleLines(frame: MachinesExplorerFrame, terminalRows: number): readonly string[] {
  const height = Number.isSafeInteger(terminalRows) ? Math.max(1, terminalRows) : 1;
  if (frame.lines.length <= height) return frame.lines;
  const selectedLine = frame.selectedLine;
  if (selectedLine === undefined) return Object.freeze(frame.lines.slice(0, height));
  if (height === 1) return Object.freeze([frame.lines[selectedLine] ?? ""]);
  const fixedCount = Math.min(3, height - 1);
  const bodyHeight = height - fixedCount;
  const bodyStart = 3;
  const latestStart = Math.max(bodyStart, frame.lines.length - bodyHeight);
  const windowStart = Math.min(Math.max(bodyStart, selectedLine - bodyHeight + 1), latestStart);
  return Object.freeze([
    ...frame.lines.slice(0, fixedCount),
    ...frame.lines.slice(windowStart, windowStart + bodyHeight),
  ]);
}

function machineContextActions(row: MachineRow, now: number): readonly MachineContextAction[] {
  // A Machine mid-transition accepts no second action until it settles.
  if (row.pendingLifecycle !== undefined) return Object.freeze([]);
  const provider = machineProviderAvailability(row.machine);
  const hasSessions = provider.actionable && provider.agent !== undefined
    ? resolveProviderContextActions({
        machine: row.machine,
        provider: provider.agent as ActionableProvider,
        sessions: row.sessions,
        now,
      }).length > 0
    : false;
  return resolveMachineContextActions(row.machine, {
    hasSessions,
    canCreateSession: row.canCreateSession === true,
    opencodeSupervisorRepairRequired: row.opencodeSupervisorRepairReason !== undefined,
  });
}

function hasOpenableSession(row: MachineRow, now: number): boolean {
  return row.sessions.some((session) => {
    if (!isActionableProvider(session.agent)) return false;
    const actionability = classifySessionActionability({ session, machine: row.machine, now });
    return actionability.canAttach || actionability.recoveryAction === "authenticate";
  });
}

function waitingForSessionObservation(session: AgentSession): string {
  return `${providerDisplayName(session.agent)} is starting. Waiting for its first process observation; refreshing automatically — r to refresh now.`;
}

function shouldOfferGlobalCreation(
  rows: readonly MachineRow[],
  now: number,
  machinesListed: boolean,
): boolean {
  // E13-R7: an empty list is a create affordance only once a list succeeded.
  if (!machinesListed) return false;
  if (rows.length === 0) return true;
  return rows.every((row) => {
    // `temporarily_unavailable` is not evidence that another Machine is
    // needed. Do not turn a runtime verification wait into a misleading
    // create affordance (and a possible extra billable resource).
    if (row.opencodeRuntimeUnverified) return false;
    // A current supervisor-repair prerequisite names the existing Machine
    // that needs attention. Offering a global OpenCode create beside it turns
    // a safe repair into an accidental extra Machine.
    if (row.opencodeSupervisorRepairReason !== undefined) return false;
    // An unannounced supervisor is a transient observation wait. It is not
    // proof that another Machine is needed or that this one should be changed.
    if (row.opencodeSupervisorProtocolUnavailable) return false;
    if (row.sessionsLoading === true) return false;
    if (row.sessionsError !== undefined) return false;
    if (row.sessionCreateCapabilityState !== "verified") return false;
    return !machineContextActions(row, now).some(
      (action) => action.kind === "start" || action.kind === "provider" || action.kind === "new-session",
    ) && !hasOpenableSession(row, now);
  });
}

function overviewFooter(
  rows: readonly MachineRow[],
  selectedKey: SelectionKey | undefined,
  now: number,
): string {
  // E13-R1: `n new machine` is on every overview footer, whatever is selected.
  const tail = "n new machine  ·  r refresh  ·  q quit";
  if (selectedKey?.startsWith("machine:") === true) {
    return ` ↑↓ move  ·  Enter/→ manage machine  ·  ${tail}`;
  }
  if (selectedKey?.startsWith("session:") === true) {
    const sessionId = selectedKey.slice("session:".length);
    const row = rows.find((candidate) => candidate.sessions.some((session) => session.id === sessionId));
    const session = row?.sessions.find((candidate) => candidate.id === sessionId);
    if (row !== undefined && session !== undefined && isActionableProvider(session.agent)) {
      const actionability = classifySessionActionability({ session, machine: row.machine, now });
      if (actionability.canAttach || actionability.recoveryAction === "authenticate") {
        return ` ↑↓ move  ·  Enter/→ attach ${providerDisplayName(session.agent)}  ·  ${tail}`;
      }
      if (actionability.recoveryAction === "refresh") {
        return ` ↑↓ move  ·  Enter refresh session  ·  ← back  ·  ${tail}`;
      }
      if (actionability.recoveryAction === "wait") {
        return hasLegacySupervisorBlockedOpenCodeSession(row) && session.agent === "opencode" &&
          isUnobservedLaunchedSession(session)
          ? ` ↑↓ move  ·  Legacy supervisor blocked  ·  ← back  ·  ${tail}`
          : ` ↑↓ move  ·  Waiting for process observation  ·  ← back  ·  ${tail}`;
      }
      return ` ↑↓ move  ·  Enter session details  ·  ← back  ·  ${tail}`;
    }
  }
  if (selectedKey?.startsWith("create:") === true) {
    return ` ↑↓ move  ·  Enter create machine  ·  ${tail}`;
  }
  return ` ↑↓ move  ·  ←→ navigate  ·  Enter open  ·  ${tail}`;
}

function renderNewMachineScreen(
  input: {
    readonly rows: readonly MachineRow[];
    readonly selectedKey?: SelectionKey | undefined;
    readonly animationFrame: number;
    readonly columns: number;
    readonly interactionNotice?: string | undefined;
    readonly newMachine: NewMachineState;
    readonly newMachineName: string;
  },
  screen: Extract<MachineFirstScreen, { readonly kind: "new-machine" | "new-machine-name" }>,
): MachinesExplorerFrame {
  const lines: string[] = [];
  let selectedLine: number | undefined;
  if (screen.kind === "new-machine") {
    lines.push(machineHeader("New machine"), " Choose the agent this Machine runs.", "");
    if (input.newMachine.capability === "checking") {
      lines.push(` ${loaderLine("Checking whether this account can create a Machine", input.animationFrame)}`);
    } else if (input.newMachine.capability === "unavailable") {
      // E13-R1 negative control: the reason is shown, never hidden, and
      // nothing below is selectable, so nothing can be created.
      lines.push(` New machine is not available for this account: ${safeLine(input.newMachine.reason)}`);
      lines.push(" Nothing was created.");
    } else {
      for (const agent of providerCreationOrder()) {
        const key: SelectionKey = `new-machine:${agent}`;
        const selected = input.selectedKey === key;
        if (selected) selectedLine = lines.length;
        lines.push(`${selected ? "❯" : " "} ${providerDisplayName(agent)}`);
      }
    }
    if (input.interactionNotice !== undefined) lines.push("", input.interactionNotice);
    lines.push("", " ↑↓ move  ·  Enter choose  ·  Esc/Backspace back  ·  q quit");
  } else {
    lines.push(machineHeader(`New machine / ${providerDisplayName(screen.provider)}`), " Name this Machine.", "");
    selectedLine = lines.length;
    lines.push(`❯ ${input.newMachineName}▏`);
    if (input.interactionNotice !== undefined) lines.push("", input.interactionNotice);
    lines.push("", " type to edit  ·  Backspace delete  ·  Enter create  ·  Esc back");
  }
  return Object.freeze({
    lines: Object.freeze(lines.map((line) => truncateTerminalLine(line, input.columns))),
    ...(selectedLine === undefined ? {} : { selectedLine }),
  });
}

function lifecycleLabel(action: LifecycleAction): string {
  return action === "start" ? "Starting…" : action === "stop" ? "Stopping…" : "Deleting…";
}

/**
 * The default name the console would suggest: `cuna-<provider>-<n>`, where
 * `n` is one more than the Machines already carrying that prefix.
 */
function defaultMachineName(provider: ActionableProvider, existingNames: readonly string[]): string {
  const slug = provider === "claude-code" ? "claude" : provider;
  const prefix = `cuna-${slug}-`;
  const count = existingNames.filter((name) => name.startsWith(prefix)).length;
  return `${prefix}${count + 1}`;
}

/**
 * One typed line for a lifecycle request the screen could not complete. The
 * code is the server's or the CLI's own; the message never invents a cause.
 */
function typedLifecycleFailure(error: unknown, name: string, action: LifecycleAction): string {
  const verb = action === "start" ? "start" : action === "stop" ? "stop" : "delete";
  if (error instanceof CunaError) {
    return `${error.code}: could not ${verb} ${name}. ${safeLine(error.message)}${error.hint === undefined ? "" : ` ${safeLine(error.hint)}`}`;
  }
  return `Could not ${verb} ${name}: unexpected error. Run \`cuna machines list\` to see its current state.`;
}

/**
 * Same question the batch commands ask (`requireCapability`), answered as a
 * value so the screen can render the refusal instead of throwing out of it.
 */
async function decideExplorerCapability(
  client: CunaApiClient,
  scope: "account" | "machine",
  resourceId: string | undefined,
  capabilityId: string,
  now: number,
  signal?: AbortSignal,
): Promise<Readonly<{ readonly status: "supported" | "unsupported" | "temporarily_unavailable" | "unknown"; readonly reason?: string }>> {
  if (typeof client.discoverCapabilities !== "function") {
    return Object.freeze({ status: "unknown", reason: "capability_discovery_unavailable" });
  }
  try {
    const snapshot = await client.discoverCapabilities(scope, resourceId, signal);
    if (snapshot.subjectScope !== scope || (scope !== "account" && snapshot.subjectId !== resourceId)) {
      return Object.freeze({ status: "unknown", reason: "subject_scope_mismatch" });
    }
    const decision = decideCapability(snapshot, capabilityId, now);
    return decision.status === "supported"
      ? Object.freeze({ status: "supported" })
      : Object.freeze({ status: decision.status, ...(decision.reason === undefined ? {} : { reason: decision.reason }) });
  } catch (error) {
    return Object.freeze({
      status: "unknown",
      reason: error instanceof CunaError ? error.code : "capability_discovery_unavailable",
    });
  }
}

function selectableKeys(
  rows: readonly MachineRow[],
  expanded: ReadonlySet<string>,
  now: number,
  navigation: MachineFirstNavigationState,
  machinesListed: boolean,
): readonly SelectionKey[] {
  if (navigation.screen.kind === "new-machine") {
    return Object.freeze(providerCreationOrder().map((agent): SelectionKey => `new-machine:${agent}`));
  }
  if (navigation.screen.kind === "new-machine-name") return Object.freeze(["new-machine-name"]);
  if (navigation.screen.kind === "machine") {
    const screen = navigation.screen;
    const row = rows.find((candidate) => candidate.machine.id === screen.machineId);
    return row === undefined
      ? Object.freeze([])
      : Object.freeze(machineContextActions(row, now).map(machineActionSelectionKey));
  }
  if (navigation.screen.kind === "provider") {
    const screen = navigation.screen;
    const row = rows.find((candidate) => candidate.machine.id === screen.machineId);
    return row === undefined
      ? Object.freeze([])
      : Object.freeze(resolveProviderContextActions({
          machine: row.machine,
          provider: screen.provider,
          sessions: row.sessions,
          now,
        }).map(providerActionSelectionKey));
  }
  const machineKeys = rows.flatMap((row): SelectionKey[] => [
    `machine:${row.machine.id}`,
    ...(expanded.has(row.machine.id)
      ? row.sessions
          .filter((session) => isActionableProvider(session.agent))
          .map((session): SelectionKey => `session:${session.id}`)
      : []),
  ]);
  const creationKeys = shouldOfferGlobalCreation(rows, now, machinesListed)
    ? providerCreationOrder().map((agent): SelectionKey => `create:${agent}`)
    : [];
  return Object.freeze([...machineKeys, ...creationKeys]);
}

function machineActionSelectionKey(action: MachineContextAction): SelectionKey {
  return action.kind === "provider"
    ? `machine-provider:${action.provider}`
    : action.kind === "new-session"
      ? `machine-create:${action.provider}`
      : action.kind === "supervisor-blocked"
        ? "machine-supervisor:blocked"
        : action.kind === "update-supervisor"
          ? "machine-supervisor:update"
      : `machine-lifecycle:${action.kind}`;
}

function providerActionSelectionKey(action: ProviderContextAction): SelectionKey {
  return `provider-session:${action.session.id}`;
}

function isActionableProvider(provider: AgentSession["agent"]): provider is ActionableProvider {
  return provider === "claude-code" || provider === "codex" || provider === "opencode";
}

function providerCreationOrder(): readonly ActionableProvider[] {
  return Object.freeze(["opencode", "claude-code", "codex"]);
}

function sessionCreateCapacityNotice(row: MachineRow): string | undefined {
  if (row.sessionCreateCapabilityState === "checking") {
    return "Checking whether this Machine can start a new session; existing sessions stay available.";
  }
  if (row.sessionCreateCapabilityState === "unverified") {
    return "New-session capacity cannot be verified; Cuna will not offer a create action.";
  }
  return undefined;
}

function overviewSessionCreateCapacityNotice(rows: readonly MachineRow[]): string | undefined {
  if (rows.some((row) => row.sessionCreateCapabilityState === "unverified")) {
    return "New-session capacity cannot be verified; Cuna will not offer a create action.";
  }
  if (rows.some((row) => row.sessionCreateCapabilityState === "checking")) {
    return "Checking whether these Machines can start a new session; existing sessions stay available.";
  }
  return undefined;
}

function isRetryableExplorerRefreshError(error: unknown): boolean {
  return (error instanceof CredentialBoundaryError || error instanceof CunaError) && error.retryable;
}

/**
 * E13-R7. One line: what is unavailable, the typed reason the client already
 * carries, and whether Cuna is still retrying by itself. The server's own
 * sentence is not repeated here; `cuna machines list` prints it in full.
 */
function listFailureNotice(error: unknown, hasRows: boolean, retryDelayMs: number | undefined): string {
  const code = error instanceof CunaError || error instanceof CredentialBoundaryError ? error.code : "unknown_failure";
  const status = error instanceof CunaError ? error.details?.http_status : undefined;
  const reason = typeof status === "number" ? `${code} (http ${status})` : code;
  // Kept short: the whole line must survive a 120-column truncation.
  const subject = hasRows
    ? "refresh failed; showing last confirmed machines"
    : "machines could not be listed";
  const retry = retryDelayMs === undefined
    ? "Press r to retry."
    : `Retrying in ${Math.max(1, Math.round(retryDelayMs / 1000))} s; r retries now.`;
  return ` ${reason}: ${subject}. ${retry}`;
}

function loaderLine(label: string, frame: number): string {
  return `${SPINNER[frame % SPINNER.length]} ${label}  ${PROGRESS[frame % PROGRESS.length]}`;
}

function machineHeader(title: string): string {
  return ` CUNA  ◆── ${title}`;
}

function paintMachinesExplorer(lines: readonly string[], columns: number, color: boolean): readonly string[] {
  if (!color) return lines;
  return Object.freeze(lines.map((line, index) => {
    if (index === 0 && line.startsWith(" CUNA ")) {
      const brand = line.slice(0, Math.min(6, line.length));
      const context = line.slice(brand.length);
      const padding = " ".repeat(Math.max(0, columns - terminalCellWidth(line)));
      return `${ANSI.flareBackground}${ANSI.ground}${ANSI.bold}${brand}${ANSI.reset}${ANSI.emberBackground}${ANSI.cream}${ANSI.bold}${context}${padding}${ANSI.reset}`;
    }
    if (line.startsWith("❯")) return `${ANSI.orange}${ANSI.bold}${paintStatus(line)}${ANSI.reset}`;
    if (line.startsWith("  ▾") || line.startsWith("  ▸") || line.startsWith(" ▾") || line.startsWith(" ▸")) {
      return `${ANSI.bold}${ANSI.orange}${paintStatus(line)}${ANSI.reset}`;
    }
    if (line.includes("Blocked by legacy supervisor")) {
      return `${ANSI.red}${ANSI.bold}${paintStatus(line)}${ANSI.reset}`;
    }
    if (line.includes("Route: end stale") || line.includes("Protected:") || line.includes("needs a terminal update")) {
      return `${ANSI.orange}${ANSI.bold}${paintStatus(line)}${ANSI.reset}`;
    }
    if (line.includes("Claude") || line.includes("Codex") || line.includes("OpenCode")) return `${ANSI.cyan}${paintStatus(line)}${ANSI.reset}`;
    if (line.includes("Discovering") || line.includes("Loading") || line.includes("Refreshing")) {
      return `${ANSI.orange}${line}${ANSI.reset}`;
    }
    if (line.includes("Closing Cuna")) return `${ANSI.orange}${ANSI.bold}${line}${ANSI.reset}`;
    if (line.includes("✓ Closed")) return `${ANSI.green}${ANSI.bold}${line}${ANSI.reset}`;
    if (/^[ ]{7}[0-9a-f-]{36}/u.test(line)) return `${ANSI.gray}${ANSI.dim}${line}${ANSI.reset}`;
    if (line.startsWith(" Your machines") || line.includes("↑↓ move")) return `${ANSI.gray}${line}${ANSI.reset}`;
    return paintStatus(line);
  }));
}

function paintStatus(line: string): string {
  return line
    .replaceAll("running", `${ANSI.green}running${ANSI.reset}`)
    .replaceAll("attachable", `${ANSI.green}attachable${ANSI.reset}`)
    .replaceAll("checking", `${ANSI.orange}checking${ANSI.reset}`)
    .replaceAll("starting", `${ANSI.orange}starting${ANSI.reset}`)
    .replaceAll("login-required", `${ANSI.orange}login-required${ANSI.reset}`)
    .replaceAll("stale", `${ANSI.orange}stale${ANSI.reset}`)
    .replaceAll("failed", `${ANSI.red}failed${ANSI.reset}`)
    .replaceAll("unsupported", `${ANSI.gray}unsupported${ANSI.reset}`);
}

function openCodeRepairSummary(row: MachineRow): string {
  // This capability is evaluated only for a new AgentSession. An existing
  // child can be unobserved for a different reason, so keep the two messages
  // distinct. A launched-but-unknown child plus a legacy capability is the
  // one proved deadlock: further refreshing cannot create its observation.
  return hasLegacySupervisorBlockedOpenCodeSession(row)
    ? "Blocked by legacy supervisor — waiting will not fix this"
    : "New OpenCode sessions are blocked until the terminal supervisor is updated";
}

function openCodeSupervisorProtocolWaitSummary(): string {
  return "Waiting for this Machine's OpenCode terminal supervisor; no new OpenCode session was requested";
}

function isUnobservedLaunchedSession(session: AgentSession): boolean {
  return session.agent === "opencode" && session.requestState === "launched" && session.processState === "unknown";
}

function hasLegacySupervisorBlockedOpenCodeSession(row: MachineRow): boolean {
  return row.opencodeSupervisorRepairReason !== undefined &&
    row.sessions.some(isUnobservedLaunchedSession);
}

function legacySupervisorRecoveryRoute(): string {
  return "Route: end stale OpenCode session → stop Machine → Update terminal supervisor.";
}

function legacySupervisorBlockedNotice(): string {
  return `${openCodeRepairSummaryForLegacy()}\n${legacySupervisorRecoveryRoute()}`;
}

function openCodeRepairSummaryForLegacy(): string {
  return "Blocked by legacy supervisor — waiting will not fix this.";
}

function safeLine(value: string): string {
  return sanitizeHumanTerminalOutput(value).replaceAll("\n", " ").replaceAll("\t", " ");
}
