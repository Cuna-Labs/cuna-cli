import { decideCapability, type CunaApiClient } from "../api/client.js";
import type { AgentSession, Machine } from "../api/contracts.js";
import { sanitizeHumanTerminalOutput } from "../cli/output.js";
import { CunaError } from "../core/errors.js";
import { CredentialBoundaryError } from "../credentials/errors.js";
import { createNodeForegroundTerminalHost } from "../pty/node-host-terminal.js";
import type { ForegroundTerminalHost } from "../terminal/foreground.js";
import { terminalCellWidth, truncateTerminalLine } from "../terminal/cell-width.js";
import { listAllMachines } from "./pagination.js";
import { machineProviderAvailability, providerDisplayName, type ActionableProvider } from "./provider-availability.js";
import { classifySessionActionability, displaySessionActionability } from "./session-actionability.js";
import { isAgentSessionIntendedActive } from "./session-visibility.js";
import {
  INITIAL_MACHINE_FIRST_STATE,
  reduceMachineFirstNavigation,
  resolveMachineContextActions,
  resolveProviderContextActions,
  type MachineContextAction,
  type MachineFirstNavigationState,
  type ProviderContextAction,
} from "./machine-first.js";

const encoder = new TextEncoder();
const SPINNER = Object.freeze(["◐", "◓", "◑", "◒"]);
const PROGRESS = Object.freeze(["━╺━━━━", "━━╺━━━", "━━━╺━━", "━━━━╺━", "━━━━━╺", "━━━━╸━", "━━━╸━━", "━━╸━━━"]);
const LIVE_REFRESH_MS = 10_000;
const ESCAPE_SEQUENCE_TIMEOUT_MS = 150;
const CLOSE_FRAME_MS = 90;
const CLOSE_FRAMES = Object.freeze(["✦ Closing Cuna...", "✧ Closing Cuna...", "✓ Closed."]);

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
  readonly sessionsError?: string;
  readonly canCreateSession?: boolean;
}

type SelectionKey =
  | `machine:${string}`
  | `session:${string}`
  | `machine-provider:${ActionableProvider}`
  | `machine-create:${ActionableProvider}`
  | `machine-lifecycle:${"start" | "stop"}`
  | `provider-session:${string}`
  | `create:${ActionableProvider}`;
type LoadingPhase = "machines" | "sessions" | undefined;

export interface MachinesExplorerInput {
  readonly client: CunaApiClient;
  readonly signal?: AbortSignal;
  readonly color?: boolean;
  readonly opencodeEnabled?: boolean;
  readonly onBeforeTerminalOwnership?: () => void;
}

export interface MachinesExplorerDependencies {
  readonly host?: ForegroundTerminalHost;
  readonly now?: () => number;
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
  readonly kind: "lifecycle";
  readonly action: "start" | "stop";
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
  let refreshError: string | undefined;
  let interactionNotice: string | undefined;
  let closingNotice: string | undefined;
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
            opencodeEnabled: input.opencodeEnabled === true,
            refreshError,
            interactionNotice,
            closingNotice,
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
      interactionNotice = undefined;
      const loaded = machines.map((machine): MachineRow => {
        const previous = previousRows.get(machine.id);
        return Object.freeze({
          machine,
          sessions: previous?.sessions ?? Object.freeze([]),
          sessionsLoading: true,
          canCreateSession: previous?.canCreateSession ?? false,
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
      const visibleKeys = selectableKeys(rows, expanded, snapshotObservedAt, navigation, input.opencodeEnabled === true);
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
        try {
          const [observedSessions, capability] = await Promise.all([
            listAllAgentSessions(input.client, machine.id, requestSignal),
            observeSessionCreateCapability(input.client, machine.id, dependencies.now?.() ?? Date.now(), requestSignal),
          ]);
          if (stopped || closingNotice !== undefined) return;
          const previous = rows.find((row) => row.machine.id === machine.id)?.sessions ?? Object.freeze([]);
          const sessions = mergeAgentSessionObservations(previous, observedSessions)
            .filter(isAgentSessionIntendedActive)
            .sort((left, right) => left.agent.localeCompare(right.agent) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
          updateMachineRow(machine.id, { sessions: Object.freeze(sessions), sessionsLoading: false, canCreateSession: capability });
        } catch {
          if (stopped || closingNotice !== undefined) return;
          const confirmed = rows.find((row) => row.machine.id === machine.id)?.sessions ?? Object.freeze([]);
          updateMachineRow(machine.id, {
            // A failed child read is not an authoritative empty membership
            // observation. Retain the last confirmed list and make the partial
            // failure explicit until a successful refresh replaces it.
            sessions: confirmed,
            sessionsLoading: false,
            sessionsError: "sessions unavailable",
          });
        }
        const keys = selectableKeys(rows, expanded, snapshotObservedAt, navigation, input.opencodeEnabled === true);
        if (selectedKey === undefined || !keys.includes(selectedKey)) selectedKey = keys[0];
        render();
      }));
    } catch (error) {
      if (!initialized || rows.length === 0 || !isRetryableExplorerRefreshError(error)) throw error;
      // A transient bearer re-exchange or read failure is not evidence that
      // the last confirmed inventory disappeared. Keep navigation alive; the
      // next manual/automatic refresh gets a fresh acquisition attempt.
      refreshError = "refresh unavailable; showing last confirmed machines";
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
    const keys = selectableKeys(rows, expanded, snapshotObservedAt, navigation, input.opencodeEnabled === true);
    if (keys.length === 0) return;
    const currentIndex = selectedKey === undefined ? -1 : keys.indexOf(selectedKey);
    const origin = currentIndex < 0 ? (delta > 0 ? -1 : keys.length) : currentIndex;
    selectedKey = keys[Math.min(keys.length - 1, Math.max(0, origin + delta))];
    navigation = reduceMachineFirstNavigation(navigation, { type: "move", delta, itemCount: keys.length });
    render();
  };

  const goBack = (): void => {
    interactionNotice = undefined;
    const previous = navigation;
    const previousScreen = previous.screen;
    navigation = reduceMachineFirstNavigation(navigation, { type: "back" });
    if (navigation !== previous) {
      const keys = selectableKeys(rows, expanded, snapshotObservedAt, navigation, input.opencodeEnabled === true);
      if (previousScreen.kind === "machine" && navigation.screen.kind === "machines") {
        const parentKey: SelectionKey = `machine:${previousScreen.machineId}`;
        selectedKey = keys.includes(parentKey) ? parentKey : keys[0];
      } else if (previousScreen.kind === "provider" && navigation.screen.kind === "machine") {
        const row = rows.find((candidate) => candidate.machine.id === previousScreen.machineId);
        const providerAction = row === undefined
          ? undefined
          : machineContextActions(row, snapshotObservedAt, input.opencodeEnabled === true).find(
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
    if (row === undefined || session === undefined || !isActionableProvider(session.agent, input.opencodeEnabled === true)) return false;
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
    interactionNotice = `Session ended. Open ${safeLine(row.machine.name)} to start a new ${providerDisplayName(session.agent)} session.`;
    render();
    return false;
  };

  const goForward = (): void => {
    if (selectedKey?.startsWith("machine:") === true && navigation.screen.kind === "machines") {
      const machineId = selectedKey.slice("machine:".length);
      navigation = reduceMachineFirstNavigation(navigation, { type: "open-machine", machineId });
      selectedKey = selectableKeys(rows, expanded, snapshotObservedAt, navigation, input.opencodeEnabled === true)[0];
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
        : machineContextActions(row, snapshotObservedAt, input.opencodeEnabled === true).find((candidate) => machineActionSelectionKey(candidate) === selectedKey);
      if (action?.kind === "provider") {
        navigation = reduceMachineFirstNavigation(navigation, {
          type: "open-provider",
          machineId: action.machineId,
          provider: action.provider,
        });
        selectedKey = selectableKeys(rows, expanded, snapshotObservedAt, navigation, input.opencodeEnabled === true)[0];
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
    if (byte === 0x03 || byte === 0x71) {
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
    if (byte === 0x6b) moveSelection(-1);
    else if (byte === 0x6a) moveSelection(1);
    else if (byte === 0x08 || byte === 0x7f || byte === 0x62) goBack();
    else if (byte === 0x0d || byte === 0x0a || byte === 0x20) {
      if (selectedKey?.startsWith("machine:") === true) {
        const id = selectedKey.slice("machine:".length);
        const row = rows.find((candidate) => candidate.machine.id === id);
        const directSession = row === undefined ? undefined : uniqueOpenableSession(row, snapshotObservedAt, input.opencodeEnabled === true);
        if (directSession !== undefined) {
          selection = Object.freeze({
            kind: "attach",
            agentSessionId: directSession.id,
            agent: directSession.agent as ActionableProvider,
          });
          stop();
          return true;
        }
        navigation = reduceMachineFirstNavigation(navigation, { type: "open-machine", machineId: id });
        selectedKey = selectableKeys(rows, expanded, snapshotObservedAt, navigation, input.opencodeEnabled === true)[0];
        render();
      } else if (selectedKey?.startsWith("session:") === true && navigation.screen.kind === "machines") {
        return activateOverviewSession(selectedKey.slice("session:".length));
      } else if ((selectedKey?.startsWith("machine-provider:") === true || selectedKey?.startsWith("machine-create:") === true
        || selectedKey?.startsWith("machine-lifecycle:") === true)
        && navigation.screen.kind === "machine") {
        const screen = navigation.screen;
        const row = rows.find((candidate) => candidate.machine.id === screen.machineId);
        const action = row === undefined
          ? undefined
          : machineContextActions(row, snapshotObservedAt, input.opencodeEnabled === true).find((candidate) => machineActionSelectionKey(candidate) === selectedKey);
        if (action?.kind === "provider") {
          navigation = reduceMachineFirstNavigation(navigation, {
            type: "open-provider",
            machineId: action.machineId,
            provider: action.provider,
          });
          selectedKey = selectableKeys(rows, expanded, snapshotObservedAt, navigation, input.opencodeEnabled === true)[0];
          render();
        } else if (action?.kind === "start" || action?.kind === "stop") {
          selection = Object.freeze({ kind: "lifecycle", action: action.kind, machineId: action.machineId });
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
          if (actionability.recoveryAction === "refresh") void refresh().catch((error) => { failure ??= error; stop(); });
          else render();
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
        if (session !== undefined && isActionableProvider(session.agent, input.opencodeEnabled === true) && actionability?.canAttach === true) {
          selection = Object.freeze({ kind: "attach", agentSessionId: session.id, agent: session.agent });
          stop();
          return true;
        }
        if (actionability?.recoveryAction === "refresh") {
          void refresh().catch((error) => { failure ??= error; stop(); });
        } else if (actionability?.recoveryAction === "authenticate") {
          // Authentication owns the same provider PTY, but remains distinct
          // from an already-attachable base state in the policy.
          if (session !== undefined && isActionableProvider(session.agent, input.opencodeEnabled === true)) {
            selection = Object.freeze({ kind: "attach", agentSessionId: session.id, agent: session.agent });
            stop();
            return true;
          }
        } else {
          // A visible but non-attachable supported session is still a useful
          // navigation target. Open its provider context instead of making
          // Enter appear broken; no attach or mutation is attempted.
          if (session !== undefined && isActionableProvider(session.agent, input.opencodeEnabled === true)) goForward();
          else render();
        }
      }
    } else if (byte === 0x72) {
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
): Promise<boolean> {
  if (typeof client.discoverCapabilities !== "function") return false;
  try {
    const snapshot = await client.discoverCapabilities("machine", machineId, signal);
    return decideCapability(snapshot, "agent_sessions.create", now).status === "supported";
  } catch {
    return false;
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
  readonly opencodeEnabled: boolean;
  readonly refreshError?: string | undefined;
  readonly interactionNotice?: string | undefined;
  readonly closingNotice?: string | undefined;
}): MachinesExplorerFrame {
  if (input.closingNotice !== undefined) {
    return {
      lines: [machineHeader("Machines"), "", ` ${input.closingNotice}`, " Returning to your terminal."],
    };
  }
  if (input.navigation.screen.kind !== "machines") return renderContextScreen(input);
  const lines = [machineHeader("Machines"), " Your machines and the agents running inside them.", ""];
  let selectedLine: number | undefined;
  const offerGlobalCreation = shouldOfferGlobalCreation(input.rows, input.now, input.opencodeEnabled);
  if (input.loadingPhase === "machines" && input.rows.length === 0) {
    lines.push(loaderLine("Discovering machines", input.animationFrame));
  } else if (input.rows.length === 0) {
    lines.push("No machines yet. Choose a supported configuration:");
    for (const agent of providerCreationOrder(input.opencodeEnabled)) {
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
    const counts = row.sessionsLoading === true && row.sessions.length === 0
      ? input.opencodeEnabled
        ? "OpenCode … · Claude … · Codex …"
        : "Claude … · Codex … · OpenCode …"
      : row.sessionsError === undefined
        ? providerSummaryOrder(input.opencodeEnabled).map((agent) => agentSummary(row, agent, input.now)).join(" · ")
        : input.opencodeEnabled
          ? "OpenCode ? · Claude ? · Codex ?"
          : "Claude ? · Codex ? · OpenCode ?";
    lines.push(`${machineSelected ? "❯" : " "} ${open ? "▾" : "▸"} ${safeLine(row.machine.name)}  ${safeLine(row.machine.state)}  ${provider.displayName} ${provider.usability}  ${counts}`);
    if (!open) continue;
    if (row.sessionsLoading === true && row.sessions.length === 0) {
      lines.push(`    ${loaderLine("Loading AgentSessions", input.animationFrame)}`);
      continue;
    }
    if (row.sessionsError !== undefined) lines.push(`    ├─ ${row.sessionsError}; showing last confirmed sessions`);
    if (row.sessions.length === 0) {
      if (row.sessionsError === undefined) lines.push("    └─ No AgentSessions");
      continue;
    }
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
  }
  if (input.rows.length > 0 && offerGlobalCreation) {
    lines.push("", "No available machine can open an AgentSession. Create a supported machine:");
    for (const agent of providerCreationOrder(input.opencodeEnabled)) {
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
  lines.push("", overviewFooter(input.rows, input.selectedKey, input.now, input.opencodeEnabled));
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
  readonly opencodeEnabled: boolean;
  readonly refreshError?: string | undefined;
  readonly interactionNotice?: string | undefined;
}): MachinesExplorerFrame {
  const screen = input.navigation.screen;
  if (screen.kind === "machines") return Object.freeze({ lines: Object.freeze([]) });
  const row = input.rows.find((candidate) => candidate.machine.id === screen.machineId);
  const lines = [machineHeader("Machine"), ""];
  if (row === undefined) {
    lines.push("Machine observation is no longer available.", "", " ←/Esc/Backspace back  ·  q quit");
    return Object.freeze({ lines: Object.freeze(lines.map((line) => truncateTerminalLine(line, input.columns))) });
  }
  lines[0] = machineHeader(screen.kind === "provider"
    ? `${safeLine(row.machine.name)} / ${providerDisplayName(screen.provider)} sessions`
    : safeLine(row.machine.name));
  lines[1] = ` ${safeLine(row.machine.state)} · observation ${safeLine(row.machine.updatedAt ?? "unversioned")}`;
  lines.push("");
  const actions = screen.kind === "machine"
    ? machineContextActions(row, input.now, input.opencodeEnabled)
    : resolveProviderContextActions({
        machine: row.machine,
        provider: screen.provider,
        sessions: row.sessions,
        now: input.now,
      });
  let selectedLine: number | undefined;
  if (actions.length === 0) lines.push(" No available actions for this observation.");
  for (const action of actions) {
    const key = screen.kind === "machine"
      ? machineActionSelectionKey(action as MachineContextAction)
      : providerActionSelectionKey(action as ProviderContextAction);
    const selected = input.selectedKey === key;
    if (selected) selectedLine = lines.length;
    const detail = action.kind === "session"
      ? displaySessionActionability(classifySessionActionability({ session: action.session, machine: row.machine, now: input.now }))
      : action.kind === "provider" ? "sessions" : "";
    const label = action.kind === "start" || action.kind === "stop" ? `${action.label} machine` : action.label;
    lines.push(`${selected ? "❯" : " "} ${label}${detail === "" ? "" : `  ${detail}`}`);
  }
  if (input.loadingPhase !== undefined) lines.push("", loaderLine("Refreshing machine", input.animationFrame));
  if (input.refreshError !== undefined) lines.push("", input.refreshError);
  if (input.interactionNotice !== undefined) lines.push("", input.interactionNotice);
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

function machineContextActions(row: MachineRow, now: number, opencodeEnabled: boolean): readonly MachineContextAction[] {
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
  }).filter((action) => action.kind === "start" || action.kind === "stop" ||
    action.provider !== "opencode" || opencodeEnabled);
}

function uniqueOpenableSession(row: MachineRow, now: number, opencodeEnabled: boolean): AgentSession | undefined {
  const openable = row.sessions.filter((session) => {
    if (!isActionableProvider(session.agent, opencodeEnabled)) return false;
    const actionability = classifySessionActionability({ session, machine: row.machine, now });
    return actionability.canAttach || actionability.recoveryAction === "authenticate";
  });
  return openable.length === 1 ? openable[0] : undefined;
}

function shouldOfferGlobalCreation(
  rows: readonly MachineRow[],
  now: number,
  opencodeEnabled: boolean,
): boolean {
  if (rows.length === 0) return true;
  return rows.every((row) => {
    if (row.sessionsLoading === true) return false;
    return !machineContextActions(row, now, opencodeEnabled).some(
      (action) => action.kind === "start" || action.kind === "provider" || action.kind === "new-session",
    ) && uniqueOpenableSession(row, now, opencodeEnabled) === undefined;
  });
}

function overviewFooter(
  rows: readonly MachineRow[],
  selectedKey: SelectionKey | undefined,
  now: number,
  opencodeEnabled: boolean,
): string {
  if (selectedKey?.startsWith("machine:") === true) {
    const row = rows.find((candidate) => candidate.machine.id === selectedKey.slice("machine:".length));
    const directSession = row === undefined ? undefined : uniqueOpenableSession(row, now, opencodeEnabled);
    return directSession === undefined
      ? " ↑↓ move  ·  Enter/→ manage machine  ·  r refresh  ·  q quit"
      : ` ↑↓ move  ·  Enter attach ${providerDisplayName(directSession.agent)}  ·  → manage machine  ·  r refresh  ·  q quit`;
  }
  if (selectedKey?.startsWith("session:") === true) {
    const sessionId = selectedKey.slice("session:".length);
    const row = rows.find((candidate) => candidate.sessions.some((session) => session.id === sessionId));
    const session = row?.sessions.find((candidate) => candidate.id === sessionId);
    if (row !== undefined && session !== undefined && isActionableProvider(session.agent, opencodeEnabled)) {
      const actionability = classifySessionActionability({ session, machine: row.machine, now });
      if (actionability.canAttach || actionability.recoveryAction === "authenticate") {
        return ` ↑↓ move  ·  Enter/→ attach ${providerDisplayName(session.agent)}  ·  r refresh  ·  q quit`;
      }
      if (actionability.recoveryAction === "refresh") {
        return " ↑↓ move  ·  Enter refresh session  ·  ← back  ·  r refresh  ·  q quit";
      }
      return " ↑↓ move  ·  Enter session details  ·  ← back  ·  r refresh  ·  q quit";
    }
  }
  if (selectedKey?.startsWith("create:") === true) {
    return " ↑↓ move  ·  Enter create machine  ·  r refresh  ·  q quit";
  }
  return " ↑↓ move  ·  ←→ navigate  ·  Enter open  ·  r refresh  ·  q quit";
}

function selectableKeys(
  rows: readonly MachineRow[],
  expanded: ReadonlySet<string>,
  now: number,
  navigation: MachineFirstNavigationState,
  opencodeEnabled: boolean,
): readonly SelectionKey[] {
  if (navigation.screen.kind === "machine") {
    const screen = navigation.screen;
    const row = rows.find((candidate) => candidate.machine.id === screen.machineId);
    return row === undefined
      ? Object.freeze([])
      : Object.freeze(machineContextActions(row, now, opencodeEnabled).map(machineActionSelectionKey));
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
          .filter((session) => isActionableProvider(session.agent, opencodeEnabled))
          .map((session): SelectionKey => `session:${session.id}`)
      : []),
  ]);
  const creationKeys = shouldOfferGlobalCreation(rows, now, opencodeEnabled)
    ? providerCreationOrder(opencodeEnabled).map((agent): SelectionKey => `create:${agent}`)
    : [];
  return Object.freeze([...machineKeys, ...creationKeys]);
}

function machineActionSelectionKey(action: MachineContextAction): SelectionKey {
  return action.kind === "provider"
    ? `machine-provider:${action.provider}`
    : action.kind === "new-session"
      ? `machine-create:${action.provider}`
      : `machine-lifecycle:${action.kind}`;
}

function providerActionSelectionKey(action: ProviderContextAction): SelectionKey {
  return `provider-session:${action.session.id}`;
}

function isActionableProvider(provider: AgentSession["agent"], opencodeEnabled: boolean): provider is ActionableProvider {
  return provider === "claude-code" || provider === "codex" || (provider === "opencode" && opencodeEnabled);
}

function providerCreationOrder(opencodeEnabled: boolean): readonly ActionableProvider[] {
  return opencodeEnabled
    ? Object.freeze(["opencode", "claude-code", "codex"])
    : Object.freeze(["claude-code", "codex"]);
}

function providerSummaryOrder(opencodeEnabled: boolean): readonly ActionableProvider[] {
  return opencodeEnabled
    ? providerCreationOrder(true)
    : Object.freeze(["claude-code", "codex", "opencode"]);
}

function isRetryableExplorerRefreshError(error: unknown): boolean {
  return (error instanceof CredentialBoundaryError || error instanceof CunaError) && error.retryable;
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

function agentSummary(row: MachineRow, agent: ActionableProvider, now: number): string {
  const matching = row.sessions.filter((session) => session.agent === agent);
  const running = matching.filter((session) => session.processState === "running" && classifySessionActionability({
      session,
      machine: row.machine,
      now,
      refreshStatus: row.sessionsLoading === true ? "pending" : "idle",
    }).canAttach).length;
  return `${providerDisplayName(agent)} ${running}/${matching.length} live`;
}

function safeLine(value: string): string {
  return sanitizeHumanTerminalOutput(value).replaceAll("\n", " ").replaceAll("\t", " ");
}
