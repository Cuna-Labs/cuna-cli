import { randomUUID } from "node:crypto";

import {
  AGENT_SESSION_AUTH_MAX_FUTURE_SKEW_MS,
  AGENT_SESSION_AUTH_MAX_TTL_MS,
  type AgentSession,
  type AgentSessionAuth,
} from "../api/contracts.js";
import type { CunaApiClient } from "../api/client.js";
import type { BrowserOpener } from "../auth/browser.js";
import { createNodeForegroundTerminalHost } from "../pty/node-host-terminal.js";
import {
  ForegroundTerminalCoordinator,
  SWITCH_INPUT_NOTICE,
  admitForegroundDimensions,
  admitForegroundSessionIds,
  type DetachedForegroundSession,
  type ForegroundSwitchRequest,
  type ForegroundTabIntent,
  type ForegroundTerminalCoordinatorOptions,
  type ForegroundTerminalHost,
} from "../terminal/foreground.js";
import type { HostTerminalLease } from "../terminal/mode.js";
import { PollingSessionRoster, type SessionRosterEntry } from "../terminal/session-roster.js";
import {
  PassthroughTerminalCoordinator,
  admitPassthroughDimensions,
} from "../terminal/passthrough.js";
import { predictiveEchoModeFromEnvironment, type PredictiveEchoMode } from "../terminal/predictive-echo.js";

import { createApiTerminalControlPlane } from "./api-terminal-control-plane.js";
import { CunaRuntimeBoundary } from "./boundary.js";
import { admitCapability } from "./capability-gate.js";
import { RuntimeBoundaryError, runtimeFailure } from "./errors.js";
import { createNodeWebSocketConnector } from "./node-websocket-connector.js";
import {
  claimTerminalClientIdentity,
  forgetTerminalClientIdentity,
  isAgentSessionGone,
  type TerminalClientIdentity,
  type TerminalClientScope,
} from "./terminal-client-identity.js";
import {
  assertRemoteAgentSessionEvidence,
  type TerminalConnector,
  type TerminalControlPlane,
} from "./terminal-transport.js";

const TERMINAL_CAPABILITY_ID = "terminal_connections.create";
const OPENCODE_AUTH_ADVISORY_TIMEOUT_MS = 250;
const SWITCH_AUTH_ADVISORY_TIMEOUT_MS = 2_000;
// A first interactive OpenCode session has no credential state yet. Provider
// auth is an advisory display observation: it may be absent, temporarily
// unreachable, or unavailable on an older deployment. A fresh supervisor
// process plus the one-use terminal grant remain the attach authority. This
// fallback never asserts that the provider is configured; it only permits the
// provider's own login TUI to ask the person to authenticate.

export interface ForegroundSessionRunnerInput {
  readonly client: CunaApiClient;
  readonly baseUrl: string;
  readonly agentSessionIds: readonly string[];
  readonly expectedAgentKinds?: readonly AgentSession["agent"][];
  readonly signal?: AbortSignal;
  readonly color?: boolean;
  readonly terminalKind?: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly presentationMode?: ForegroundPresentationMode;
  readonly browser?: BrowserOpener;
  /**
   * Foreground startup performs several deliberate authority fences.  Surface
   * the current local phase while the caller still owns an inline progress UI;
   * never emit this after raw/alternate-screen terminal ownership begins.
   */
  readonly onProgress?: (label: string) => void;
  /** Clears caller-owned progress UI before raw/alternate-screen terminal ownership. */
  readonly onBeforeTerminalOwnership?: () => void;
  /**
   * Where this computer remembers which terminal client it is for one
   * AgentSession, so a re-attach resumes its own writer seat instead of
   * taking it over; see `runtime/terminal-client-identity.ts`. Absent, every
   * run is a new client, as before.
   */
  readonly terminalClients?: TerminalClientScope;
  /** One durable line for the person, delivered before terminal ownership begins. */
  readonly onNotice?: (line: string) => void;
}

export type ForegroundPresentationMode = "rich" | "plain";

export type ForegroundSessionRunner = (input: ForegroundSessionRunnerInput) => Promise<void>;

export interface NodeForegroundSessionDependencies {
  readonly host?: ForegroundTerminalHost;
  readonly terminalConnector?: TerminalConnector;
  readonly controlPlane?: TerminalControlPlane;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly clock?: () => number;
  readonly clientInstanceId?: () => string;
  readonly tabId?: (index: number) => string;
  readonly coordinatorOptions?: Pick<
    ForegroundTerminalCoordinatorOptions,
    "reconnectAttempts" | "reconnectBaseDelayMs" | "resizeCoalesceMs"
  >;
  /** `false` turns the Machine session tabs off. */
  readonly sessionRoster?: false;
  readonly sessionRosterIntervalMs?: number;
  /** SGR mouse reports for the clickable bar; on by default for the real host only. */
  readonly mouseReporting?: boolean;
}

/** What one attached run ended with. */
interface ForegroundRunOutcome {
  readonly detached: readonly DetachedForegroundSession[];
  readonly switchTo?: ForegroundSwitchRequest;
}

/**
 * State shared by the attached runs of one command: the host terminal stays
 * owned across a switch, and the Machine roster keeps its numbers.
 */
interface ForegroundSwitchContext {
  readonly host: HeldForegroundHost;
  roster: PollingSessionRoster | undefined;
  /** Ctrl+C between two attachments: the run ends, nothing more is attached. */
  cancelled?: boolean;
  /** Set while a switch is between two attachments. */
  switching: {
    readonly title: string;
    readonly initialNotice?: string;
    notices: string[];
  } | undefined;
}

/**
 * Attach, and keep attaching whatever the person picks on the bar.
 *
 * A switch is a sequence of ordinary single-session runs, one runtime each,
 * because the writer seat belongs to a client id and this computer remembers
 * one id per AgentSession: going back to a session is the same client, and its
 * seat resumes without a takeover. The host terminal is acquired once and
 * restored once, so the shell never flashes between the two sessions.
 */
export async function runNodeForegroundSessions(
  input: ForegroundSessionRunnerInput,
  dependencies: NodeForegroundSessionDependencies = {},
): Promise<void> {
  const context: ForegroundSwitchContext = {
    host: holdForegroundHost(dependencies.host ?? createNodeForegroundTerminalHost()),
    roster: undefined,
    switching: undefined,
  };
  const detached = new Map<string, DetachedForegroundSession>();
  let failure: unknown;
  try {
    await runSwitchingForeground(input, dependencies, context, detached);
  } catch (error) {
    failure = error;
  }
  context.roster?.stop();
  const cleanupFailures: unknown[] = [];
  try {
    await context.host.release();
  } catch (error) {
    cleanupFailures.push(error);
  }
  // PRD-PM-008 E14-D6. Only after the host terminal is restored, and only for
  // detaches the person asked for and the runtime confirmed: one line per
  // session that survived and how to come back. A failed run says nothing
  // here; its error is the message. A session the roster saw end is not
  // announced as running.
  if (failure === undefined && cleanupFailures.length === 0) {
    const ended = new Set((context.roster?.entries() ?? []).filter((entry) => entry.ended).map((entry) => entry.agentSessionId));
    for (const session of detached.values()) {
      if (ended.has(session.agentSessionId)) continue;
      try {
        await context.host.write(new TextEncoder().encode(
          `Detached · ${session.label} keeps running · cuna connect ${session.agentSessionId}\n`,
        ));
      } catch {
        // The line is a courtesy after a completed detach. A host that cannot
        // take one more write must not turn a confirmed detach into a failure.
      }
    }
  }
  if (failure !== undefined && cleanupFailures.length > 0) {
    throw new AggregateError([failure, ...cleanupFailures], "Foreground terminal execution and cleanup both failed.");
  }
  if (failure !== undefined) throw failure;
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "Foreground terminal cleanup was incomplete.");
  }
}

async function runSwitchingForeground(
  input: ForegroundSessionRunnerInput,
  dependencies: NodeForegroundSessionDependencies,
  context: ForegroundSwitchContext,
  detached: Map<string, DetachedForegroundSession>,
): Promise<void> {
  let current: SwitchStep = { input, name: undefined };
  // The session a switch left, to come back to once if the target fails.
  let previous: SwitchStep | undefined;
  let switchFailure: unknown;
  for (;;) {
    let outcome: ForegroundRunOutcome;
    try {
      outcome = await runForgettingEndedSessions(current.input, dependencies, context);
    } catch (error) {
      if (context.cancelled === true) return;
      if (switchFailure !== undefined) {
        // R15: the way back failed too. End with both typed errors.
        throw new AggregateError([switchFailure, error], "Cuna could not switch sessions, nor return to the previous one.");
      }
      const origin = previous;
      if (origin === undefined || input.signal?.aborted) throw error;
      // R15: the target could not be attached. Go back, once, to the session
      // the person left; it was running a moment ago and this computer is
      // still its client, so its writer seat resumes.
      switchFailure = error;
      context.switching = {
        title: `RETURNING TO ${(origin.name ?? "the previous session").toUpperCase()}`,
        initialNotice: `Could not switch to ${current.name ?? "that session"}: ${typedFailureReason(error)}`,
        notices: [],
      };
      current = origin;
      previous = undefined;
      continue;
    }
    switchFailure = undefined;
    context.switching = undefined;
    for (const session of outcome.detached) {
      detached.delete(session.agentSessionId);
      detached.set(session.agentSessionId, session);
    }
    const target = outcome.switchTo;
    if (target === undefined) return;
    const leftId = current.input.agentSessionIds[0];
    const left = leftId === undefined ? undefined : context.roster?.entries().find((entry) => entry.agentSessionId === leftId);
    previous = { input: current.input, name: current.name ?? (left === undefined ? undefined : `${rosterAgentName(left.agent)} ${left.label}`.trim()) };
    const name = `${rosterAgentName(target.agent)} ${target.label}`.trim();
    context.switching = { title: `SWITCHING TO ${name.toUpperCase()}`, notices: [] };
    current = {
      name,
      input: Object.freeze({
        ...input,
        agentSessionIds: Object.freeze([target.agentSessionId]),
        expectedAgentKinds: Object.freeze([target.agent]),
      }),
    };
  }
}

interface SwitchStep {
  readonly input: ForegroundSessionRunnerInput;
  /** `Claude <label>`, known for every session reached through the bar. */
  readonly name: string | undefined;
}

function rosterAgentName(agent: SessionRosterEntry["agent"]): string {
  switch (agent) {
    case "claude-code": return "Claude";
    case "codex": return "Codex";
    case "opencode": return "OpenCode";
  }
}

/** A closed code, never remote text: what a switch failure is shown as. */
function typedFailureReason(error: unknown): string {
  if (error instanceof AggregateError) return typedFailureReason(error.errors.at(-1));
  if (error instanceof RuntimeBoundaryError) {
    const reason = error.safeDetails?.reason_code;
    const code = typeof reason === "string" && /^[a-z0-9_.]{1,64}$/u.test(reason) ? reason : error.code;
    return code.replace(/^cuna\./u, "").replace(/[._]+/gu, " ");
  }
  const code = (error as { readonly code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[a-z0-9_.]{1,64}$/u.test(code)
    ? code.replace(/^cuna\./u, "").replace(/[._]+/gu, " ")
    : "unexpected error";
}

async function runForgettingEndedSessions(
  input: ForegroundSessionRunnerInput,
  dependencies: NodeForegroundSessionDependencies,
  context: ForegroundSwitchContext,
): Promise<ForegroundRunOutcome> {
  try {
    return await runNodeForegroundSessionsWithRetry(input, dependencies, context);
  } catch (error) {
    // A refusal that says the session's process is gone for good ends the
    // remembered client with it, whichever step of the run it came from.
    if (input.terminalClients !== undefined && sessionEndedFailure(error)) {
      for (const agentSessionId of input.agentSessionIds) {
        try {
          await forgetTerminalClientIdentity(input.terminalClients, agentSessionId);
        } catch { /* the refusal is the message; a leftover record is only garbage */ }
      }
    }
    throw error;
  }
}

async function runNodeForegroundSessionsWithRetry(
  input: ForegroundSessionRunnerInput,
  dependencies: NodeForegroundSessionDependencies,
  context: ForegroundSwitchContext,
): Promise<ForegroundRunOutcome> {
  try {
    return await runNodeForegroundSessionsOnce(input, dependencies, context);
  } catch (error) {
    if (!retryableEarlyTerminalFailure(error) || input.signal?.aborted) throw error;
    // A newly issued one-use ticket can reach the public gateway just before
    // the machine supervisor observes it. Retry the complete, already-cleaned
    // foreground composition exactly once; this mints fresh one-use authority
    // and never repeats user input or an established terminal interaction.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    try {
      return await runNodeForegroundSessionsOnce(input, dependencies, context);
    } catch (retryError) {
      if (retryError instanceof RuntimeBoundaryError) {
        throw new RuntimeBoundaryError({
          code: retryError.code,
          message: retryError.message,
          retryable: retryError.retryable,
          safeDetails: { ...retryError.safeDetails, prior_attempt_code: error.code },
          cause: new AggregateError([error, retryError], "Both terminal attachment attempts failed."),
        });
      }
      throw retryError;
    }
  }
}

function retryableEarlyTerminalFailure(error: unknown): error is RuntimeBoundaryError {
  if (!(error instanceof RuntimeBoundaryError) || error.code !== "terminal_disconnected") return false;
  return (error.retryable && /before negotiation completed/u.test(error.message)) ||
    error.message === "The passthrough terminal connection ended." ||
    error.message === "The terminal tab is not connected.";
}

async function runNodeForegroundSessionsOnce(
  input: ForegroundSessionRunnerInput,
  dependencies: NodeForegroundSessionDependencies,
  context: ForegroundSwitchContext,
): Promise<ForegroundRunOutcome> {
  const switching = context.switching;
  if (switching === undefined) return await runNodeForegroundSessionsAdmitted(input, dependencies, context);
  // Between two attachments the host still shows Cuna's alternate screen and
  // nobody reads its input. Say what is happening, drop typed keys (R13), and
  // let Ctrl+C end the run (R16); both sessions keep running.
  const cancel = new AbortController();
  const removeInput = context.host.onInput((bytes) => {
    if (bytes.includes(0x03)) {
      context.cancelled = true;
      cancel.abort();
    }
  });
  let frame = 0;
  let step = "Checking the session";
  let painting = true;
  const startedAt = Date.now();
  const paint = (nextStep?: string): void => {
    if (!painting) return;
    if (nextStep !== undefined) step = nextStep;
    frame += 1;
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1_000);
    void context.host.write(switchingScreen(switching.title, step, frame, context.host.dimensions(), input.color ?? true, elapsedSeconds))
      .catch(() => undefined);
  };
  paint();
  const timer = setInterval(() => paint(), 1_000);
  timer.unref();
  try {
    return await runNodeForegroundSessionsAdmitted({
      ...input,
      signal: input.signal === undefined ? cancel.signal : AbortSignal.any([input.signal, cancel.signal]),
      onProgress: paint,
      onBeforeTerminalOwnership: () => {
        painting = false;
        clearInterval(timer);
        removeInput();
      },
      onNotice: (line) => { switching.notices.push(line); },
    }, dependencies, context);
  } finally {
    painting = false;
    clearInterval(timer);
    removeInput();
  }
}

async function runNodeForegroundSessionsAdmitted(
  input: ForegroundSessionRunnerInput,
  dependencies: NodeForegroundSessionDependencies,
  context: ForegroundSwitchContext,
): Promise<ForegroundRunOutcome> {
  const clock = dependencies.clock ?? Date.now;
  const sessionIds = admitForegroundSessionIds(input.agentSessionIds);
  if (
    input.expectedAgentKinds !== undefined &&
    input.expectedAgentKinds.length !== sessionIds.length
  ) {
    throw runtimeFailure(
      "remote_state_unproven",
      "Expected agent authority must bind every requested AgentSession.",
    );
  }
  const platform = input.hostPlatform ?? dependencies.platform ?? process.platform;
  const terminalKind = input.terminalKind ?? (
    platform === "win32" ? undefined : (dependencies.environment ?? process.env).TERM
  );
  const environment = dependencies.environment ?? process.env;
  const presentationMode = input.presentationMode ?? selectNodeForegroundPresentation({
    platform,
    environment,
    sessionCount: sessionIds.length,
    ...(terminalKind === undefined ? {} : { terminalKind }),
  });
  if (presentationMode === "rich") {
    admitForegroundTerminalEnvironment({
      platform,
      ...(terminalKind === undefined ? {} : { terminalKind }),
    });
  } else if (sessionIds.length !== 1) {
    throw runtimeFailure("capability_unsupported", "Plain passthrough mode binds exactly one AgentSession.");
  }
  // Plain passthrough forwards bytes untouched and never paints guesses.
  const predictiveEcho = presentationMode === "rich" ? predictiveEchoModeFromEnvironment(environment) : "off";
  const allowedOrigin = admitApiOrigin(input.baseUrl);
  const host = context.host;

  // TTY authority and dimensions are admitted before any control-plane read or
  // one-use terminal grant. Acquiring raw/alternate-screen ownership remains a
  // later coordinator step, after every requested AgentSession passes preflight.
  if (presentationMode === "rich") admitForegroundDimensions(host.dimensions());
  else admitPassthroughDimensions(host.dimensions());
  throwIfAborted(input.signal);

  const controlPlane = dependencies.controlPlane ?? createApiTerminalControlPlane({
    client: input.client,
    clock,
  });
  const intents: ForegroundTabIntent[] = [];
  const sessions: AgentSession[] = [];
  for (let index = 0; index < sessionIds.length; index += 1) {
    const agentSessionId = sessionIds[index];
    if (agentSessionId === undefined) continue;
    throwIfAborted(input.signal);
    input.onProgress?.("Checking selected AgentSession");
    const session = await input.client.getAgentSession(agentSessionId, input.signal);
    sessions.push(session);
    // A session in a typed terminal state takes its remembered client with it.
    if (input.terminalClients !== undefined && isAgentSessionGone(session)) {
      try {
        await forgetTerminalClientIdentity(input.terminalClients, agentSessionId);
      } catch { /* a record left behind is only garbage; the attach decides on its own */ }
    }
    if (session.agent !== "claude-code" && session.agent !== "codex" && session.agent !== "opencode") {
      throw runtimeFailure(
        "capability_unsupported",
        `The ${session.agent} provider is unavailable for direct CLI attachment.`,
      );
    }
    const expectedAgent = input.expectedAgentKinds?.[index];
    if (expectedAgent !== undefined && session.agent !== expectedAgent) {
      throw runtimeFailure(
        "remote_state_unproven",
        "The selected AgentSession does not match the requested agent command.",
      );
    }
    input.onProgress?.("Verifying terminal authority");
    const capabilitySnapshot = await controlPlane.discoverCapabilities(
      "agent_session",
      agentSessionId,
      input.signal,
    );
    throwIfAborted(input.signal);
    let capability = admitCapability(capabilitySnapshot, {
      id: TERMINAL_CAPABILITY_ID,
      scope: "agent_session",
      subjectId: agentSessionId,
      surface: "cli",
      interaction: "native",
    }, clock());
    input.onProgress?.("Checking live session status");
    let observation = assertRemoteAgentSessionEvidence({
      evidence: await controlPlane.observeAgentSession(agentSessionId, input.signal),
      expectedAgentSessionId: agentSessionId,
      now: clock(),
    });
    throwIfAborted(input.signal);
    admitSessionIdentity(session, observation, agentSessionId);
    input.onProgress?.("Checking provider sign-in");
    const providerAuthentication = await observeProviderAuthentication({
      client: input.client,
      session,
      observation,
      now: clock,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(context.switching === undefined ? {} : { advisoryTimeoutMs: SWITCH_AUTH_ADVISORY_TIMEOUT_MS }),
    });
    throwIfAborted(input.signal);
    if (capability.expiresAt <= clock()) {
      // Provider sign-in inspection can outlast the short authorization lease.
      // Renew read-only evidence once; never reuse an expired grant or retry effects.
      input.onProgress?.("Refreshing terminal authority");
      observation = assertRemoteAgentSessionEvidence({
        evidence: await controlPlane.observeAgentSession(agentSessionId, input.signal),
        expectedAgentSessionId: agentSessionId,
        now: clock(),
      });
      admitSessionIdentity(session, observation, agentSessionId);
      capability = admitCapability(await controlPlane.discoverCapabilities("agent_session", agentSessionId, input.signal), {
        id: TERMINAL_CAPABILITY_ID,
        scope: "agent_session",
        subjectId: agentSessionId,
        surface: "cli",
        interaction: "native",
      }, clock());
      throwIfAborted(input.signal);
    }
    intents.push(Object.freeze({
      tabId: dependencies.tabId?.(index) ?? `tab:${index + 1}`,
      agentSessionId,
      label: safeSessionLabel(session),
      agent: session.agent,
      ...(session.workspaceBindingId === undefined
        ? {}
        : {
            workspaceBindingId: session.workspaceBindingId,
            workspaceGeneration: session.workspaceGeneration,
          }),
      localBrowserActions: session.authMode === "interactive_login",
      attachmentAdmission: Object.freeze({
        observation: Object.freeze({ ...observation }),
        capability: Object.freeze({ ...capability }),
      }),
      agentSessionLifecycle: Object.freeze({
        value: observation.state,
        source: observation.authority,
        observedAt: Date.parse(observation.observedAt),
        expiresAt: Date.parse(observation.expiresAt),
        correlationId: observation.evidenceRevision,
      }),
      ...(providerAuthentication === undefined ? {} : { providerAuthentication }),
    }));
  }
  throwIfAborted(input.signal);

  // The bar lists the Machine's sessions only for a one-session rich run; the
  // same roster serves every switch of this command, so numbers stay put.
  const machineId = sessions[0]?.machineId;
  if (presentationMode === "rich" && sessions.length === 1 && machineId !== undefined &&
      context.roster === undefined && dependencies.sessionRoster !== false) {
    context.roster = new PollingSessionRoster({
      list: async (signal) => await listMachineAgentSessions(input.client, machineId, signal),
      ...(dependencies.sessionRosterIntervalMs === undefined ? {} : { intervalMs: dependencies.sessionRosterIntervalMs }),
    });
    context.roster.start();
  }

  const identity = await claimClientIdentity(input, dependencies, sessions);
  try {
    return await runClaimedForeground(input, dependencies, {
      clock,
      host,
      presentationMode,
      predictiveEcho,
      controlPlane,
      allowedOrigin,
      intents,
      clientInstanceId: identity?.clientInstanceId ?? dependencies.clientInstanceId?.() ?? `cli:${randomUUID()}`,
      ...(identity === undefined ? {} : { identity }),
      switchContext: context,
    });
  } finally {
    await identity?.release();
  }
}

/**
 * The client this run attaches as. Only a single-session run with a scope and
 * no injected id can reuse one: a runtime has one client id, and a remembered
 * id belongs to exactly one AgentSession. A record this computer cannot use
 * (an unsafe file, say) leaves the run a new client, exactly as before.
 */
async function claimClientIdentity(
  input: ForegroundSessionRunnerInput,
  dependencies: NodeForegroundSessionDependencies,
  sessions: readonly AgentSession[],
): Promise<TerminalClientIdentity | undefined> {
  const session = sessions[0];
  if (input.terminalClients === undefined || dependencies.clientInstanceId !== undefined ||
    sessions.length !== 1 || session === undefined || isAgentSessionGone(session)) return undefined;
  let identity: TerminalClientIdentity;
  try {
    identity = await claimTerminalClientIdentity(input.terminalClients, session);
  } catch {
    return undefined;
  }
  if (identity.notice !== undefined) input.onNotice?.(identity.notice);
  return identity;
}

/**
 * The refusal after which the AgentSession cannot be attached again: the owner
 * of that exact process is gone. (A process exit seen on the wire is the other
 * typed end; `runClaimedForeground` watches for it.)
 */
function sessionEndedFailure(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.some(sessionEndedFailure);
  return error instanceof RuntimeBoundaryError && error.safeDetails?.reason_code === "terminal_owner_unrecoverable";
}

async function runClaimedForeground(
  input: ForegroundSessionRunnerInput,
  dependencies: NodeForegroundSessionDependencies,
  context: {
    readonly clock: () => number;
    readonly host: ForegroundTerminalHost;
    readonly presentationMode: ForegroundPresentationMode;
    readonly predictiveEcho: PredictiveEchoMode;
    readonly controlPlane: TerminalControlPlane;
    readonly allowedOrigin: string;
    readonly intents: readonly ForegroundTabIntent[];
    readonly clientInstanceId: string;
    readonly identity?: TerminalClientIdentity;
    readonly switchContext: ForegroundSwitchContext;
  },
): Promise<ForegroundRunOutcome> {
  const { clock, host, presentationMode, predictiveEcho, controlPlane, allowedOrigin, intents, clientInstanceId } = context;
  input.onProgress?.("Preparing your cloud terminal");
  input.onBeforeTerminalOwnership?.();
  const switching = context.switchContext.switching;
  const initialNotice = [switching?.initialNotice, ...(switching?.notices ?? [])]
    .filter((line): line is string => line !== undefined).join(" · ");
  const roster = intents.length === 1 ? context.switchContext.roster : undefined;
  const coordinator = presentationMode === "rich"
    ? new ForegroundTerminalCoordinator({
        ...dependencies.coordinatorOptions,
        host,
        ...(input.browser === undefined ? {} : { browser: input.browser }),
        clock,
        color: input.color ?? true,
        deviceId: clientInstanceId,
        predictiveEcho,
        ...(roster === undefined ? {} : { sessionRoster: roster }),
        mouseReporting: dependencies.mouseReporting ?? dependencies.host === undefined,
        ...(switching === undefined ? {} : { attachingTitle: switching.title }),
        ...(initialNotice.length === 0 ? {} : { initialNotice }),
      })
    : new PassthroughTerminalCoordinator({
        host,
        ...(dependencies.coordinatorOptions?.resizeCoalesceMs === undefined
          ? {}
          : { resizeCoalesceMs: dependencies.coordinatorOptions.resizeCoalesceMs }),
      });
  const callbacks = coordinator.runtimeCallbacks();
  let processExited = false;
  const runtime = new CunaRuntimeBoundary({
    mode: "foreground",
    canonicalTerminalViews: presentationMode === "rich",
    controlPlane,
    terminalConnector: dependencies.terminalConnector ?? createNodeWebSocketConnector(),
    allowedCunaOrigins: [allowedOrigin],
    terminalCapabilityId: TERMINAL_CAPABILITY_ID,
    clientInstanceId,
    clock,
    ...callbacks,
    onTerminalState: (snapshot) => {
      if (snapshot.state === "closed" && snapshot.reason === "remote_process_exit") processExited = true;
      callbacks.onTerminalState?.(snapshot);
    },
  });
  coordinator.bindRuntime(runtime);
  runtime.startForeground();

  let failure: unknown;
  try {
    await coordinator.start(intents, input.signal);
    await coordinator.waitForStop();
    if (coordinator.failure !== undefined) throw coordinator.failure;
  } catch (error) {
    failure = error;
  }

  const cleanupFailures: unknown[] = [];
  try {
    await coordinator.stop();
  } catch (error) {
    cleanupFailures.push(error);
  }
  // The "keeps running" lines are written by `runNodeForegroundSessions` once
  // the host is restored; a switch keeps the host, so they cannot go here.
  const outcome: ForegroundRunOutcome = Object.freeze({
    detached: coordinator.detachedSessions,
    ...(coordinator instanceof ForegroundTerminalCoordinator && coordinator.switchRequest !== undefined &&
      !context.switchContext.cancelled
      ? { switchTo: coordinator.switchRequest }
      : {}),
  });
  try {
    await runtime.shutdown();
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (processExited) {
    try {
      await context.identity?.forget();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (failure !== undefined && cleanupFailures.length > 0) {
    throw new AggregateError([failure, ...cleanupFailures], "Foreground terminal execution and cleanup both failed.");
  }
  if (failure !== undefined) throw failure;
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "Foreground terminal cleanup was incomplete.");
  }
  return outcome;
}

/**
 * The host terminal for a whole command: acquired by the first attachment,
 * restored by `release()` only. A switch stops one coordinator and starts the
 * next without the shell ever showing through between them.
 */
interface HeldForegroundHost extends ForegroundTerminalHost {
  release(): Promise<void>;
}

function holdForegroundHost(host: ForegroundTerminalHost): HeldForegroundHost {
  let lease: HostTerminalLease | undefined;
  let mode: "rich" | "plain" | undefined;
  const held = Object.freeze({
    restore: async (): Promise<void> => undefined,
  }) as unknown as HostTerminalLease;
  return Object.freeze({
    dimensions: () => host.dimensions(),
    write: async (bytes: Uint8Array) => await host.write(bytes),
    onInput: (listener: (bytes: Uint8Array) => void) => host.onInput(listener),
    onResize: (listener: () => void) => host.onResize(listener),
    async acquire(requested?: "rich" | "plain"): Promise<HostTerminalLease> {
      if (lease === undefined) {
        lease = await host.acquire(requested);
        mode = requested ?? "rich";
      } else if (mode !== (requested ?? "rich")) {
        throw runtimeFailure("session_conflict", "The host terminal is already held in another presentation mode.");
      }
      return held;
    },
    async release(): Promise<void> {
      const current = lease;
      lease = undefined;
      mode = undefined;
      await current?.restore();
    },
  });
}

async function listMachineAgentSessions(
  client: CunaApiClient,
  machineId: string,
  signal: AbortSignal,
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

/** The two rows shown between two attachments, in the loader's own colors. */
function switchingScreen(
  title: string,
  step: string,
  frame: number,
  dimensions: { readonly columns: number; readonly rows: number },
  color: boolean,
  elapsedSeconds: number,
): Uint8Array {
  const spinner = ["◐", "◓", "◑", "◒"][frame % 4] ?? "◐";
  const pad = (text: string): string => {
    const characters = [...text.replace(/[\p{Cc}\p{Cf}]/gu, "")];
    return characters.length >= dimensions.columns
      ? characters.slice(0, dimensions.columns).join("")
      : `${characters.join("")}${" ".repeat(dimensions.columns - characters.length)}`;
  };
  return new TextEncoder().encode([
    "\u001b[?25l\u001b[H\u001b[2J",
    color ? "\u001b[48;2;235;86;37m\u001b[38;2;255;255;255m" : "",
    pad(` CUNA  ${title}`),
    color ? "\u001b[0m" : "",
    dimensions.rows > 1 ? "\r\n" : "",
    dimensions.rows > 1 && color ? "\u001b[48;2;121;48;25m\u001b[38;2;224;210;203m" : "",
    dimensions.rows > 1 ? pad(` ${spinner} ${step}${elapsedSeconds >= 3 ? ` · ${elapsedSeconds}s` : ""}  ·  ${SWITCH_INPUT_NOTICE}  ·  Ctrl-C closes`) : "",
    color ? "\u001b[0m" : "",
  ].join(""));
}

export function admitForegroundTerminalEnvironment(input: {
  readonly platform: NodeJS.Platform;
  readonly terminalKind?: string;
}): void {
  if (input.platform === "win32") return;
  const terminalKind = input.terminalKind?.trim().toLowerCase();
  if (terminalKind === undefined || terminalKind.length === 0 || terminalKind === "dumb") {
    throw runtimeFailure(
      "pty_unavailable",
      "Foreground cloud sessions require a terminal with cursor-addressing support.",
    );
  }
}

export function selectNodeForegroundPresentation(input: {
  readonly platform: NodeJS.Platform;
  readonly terminalKind?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly sessionCount?: number;
}): ForegroundPresentationMode {
  const requested = input.environment.CUNA_TERMINAL_MODE?.trim().toLowerCase();
  if (requested !== undefined && requested !== "" && requested !== "auto" && requested !== "rich" && requested !== "plain") {
    throw runtimeFailure(
      "pty_unavailable",
      "CUNA_TERMINAL_MODE must be auto, rich, or plain.",
    );
  }
  if (requested === "plain") return "plain";
  if (requested === "rich") {
    admitForegroundTerminalEnvironment({
      platform: input.platform,
      ...(input.terminalKind === undefined ? {} : { terminalKind: input.terminalKind }),
    });
    return "rich";
  }
  // A capable host gets the isolated workbench even for one AgentSession. The
  // remote PTY owns only the rows below Cuna's persistent chrome, so provider
  // redraws and SIGWINCH cannot erase or scroll the appbar. Explicit `plain`
  // and genuinely non-enriched/nested terminals retain byte passthrough.
  const terminalKind = input.terminalKind?.trim().toLowerCase();
  if (
    input.environment.TMUX !== undefined ||
    input.environment.SSH_TTY !== undefined ||
    input.environment.SSH_CONNECTION !== undefined ||
    (input.platform !== "win32" && (terminalKind === undefined || terminalKind === "" || terminalKind === "dumb"))
  ) {
    return "plain";
  }
  return "rich";
}

function admitApiOrigin(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw runtimeFailure("control_plane_unavailable", "The configured Cuna API URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw runtimeFailure("control_plane_unavailable", "Foreground terminals require an exact Cuna HTTPS API authority.");
  }
  return url.origin;
}

function admitSessionIdentity(
  session: AgentSession,
  observation: ReturnType<typeof assertRemoteAgentSessionEvidence>,
  expectedAgentSessionId: string,
): void {
  if (session.agent === "opencode" && session.authMode !== "interactive_login") {
    throw runtimeFailure(
      "remote_state_unproven",
      "OpenCode AgentSessions must use interactive_login before foreground terminal admission.",
    );
  }
  if (
    session.id !== expectedAgentSessionId ||
    session.machineId !== observation.machineId ||
    (session.workspaceBindingId ?? null) !== observation.workspaceBindingId ||
    (session.workspaceGeneration ?? null) !== observation.workspaceBindingGeneration ||
    session.processEpoch === undefined ||
    session.processEpoch !== observation.processEpoch ||
    session.processState !== observation.state
  ) {
    throw runtimeFailure(
      "remote_state_unproven",
      "The AgentSession changed while foreground terminal admission was being proven.",
    );
  }
}

async function observeProviderAuthentication(input: Readonly<{
  client: CunaApiClient;
  session: AgentSession;
  observation: ReturnType<typeof assertRemoteAgentSessionEvidence>;
  now: () => number;
  signal?: AbortSignal;
  /** Bound for a non-OpenCode probe; absent, the probe waits as long as the request does. */
  advisoryTimeoutMs?: number;
}>): Promise<ForegroundTabIntent["providerAuthentication"]> {
  let status: AgentSessionAuth;
  // OpenCode authentication is presentation-only at this point.  The exact
  // supervisor observation and one-use terminal grant already admitted the
  // process; holding the person behind a server-side auth probe (which may
  // wait for an older supervisor) does not add authority. Bound it so a first
  // `/connect` can reach the real OpenCode TUI promptly.
  // A switch between sessions bounds the probe for Claude and Codex too: it
  // is presentation-only for them (a failed read shows "auth unknown"), and on
  // qa6 it took 15 s of a 22 s switch (2026-09-23, session tabs witness).
  const advisoryTimeoutMs = mayEnterOpenCodeLogin(input.session, input.observation, input.now())
    ? OPENCODE_AUTH_ADVISORY_TIMEOUT_MS
    : input.advisoryTimeoutMs !== undefined && input.session.agent !== "opencode"
      ? input.advisoryTimeoutMs
      : undefined;
  const authProbeSignal = advisoryTimeoutMs === undefined
    ? input.signal
    : input.signal === undefined
      ? AbortSignal.timeout(advisoryTimeoutMs)
      : AbortSignal.any([input.signal, AbortSignal.timeout(advisoryTimeoutMs)]);
  try {
    status = await input.client.getAgentSessionAuth(input.session.id, authProbeSignal);
  } catch (error) {
    throwIfAborted(input.signal);
    // This proceeds for EVERY read failure, including an off-contract payload,
    // and that is a decided semantic rather than an oversight.
    //
    // Two suites demanded opposite things here. Three unit variants in
    // `test/node-foreground-session.test.mjs` — missing resource, off-contract
    // observation, transport fault — pin "enter the PTY". The installed E2E
    // asserted "fail closed" for the off-contract one; that case had never
    // executed, because an earlier phase aborted the suite before reaching it,
    // so it had never been reconciled with this behaviour.
    //
    // Resolved in favour of entering: the probe is presentation-only, and
    // admission was already granted by the exact supervisor observation and the
    // one-use terminal grant. Refusing here would withhold a terminal the
    // runtime had already admitted, on a signal that never authorized it.
    //
    // The obligation that survives is presentational, and it is enforced
    // below and in the E2E: an observation that cannot be decoded must never
    // be rendered as a signed-in provider — only as login-pending.
    if (mayEnterOpenCodeLogin(input.session, input.observation, input.now())) {
      return openCodeInteractiveLoginPending(input.observation);
    }
    if (input.session.agent === "opencode") {
      throw runtimeFailure(
        "remote_state_unproven",
        "OpenCode foreground admission requires current process evidence before interactive login.",
        { cause: error },
      );
    }
    return undefined;
  }
  const observedAt = Date.parse(status.observedAt);
  const validUntil = Date.parse(status.validUntil);
  const now = input.now();
  const providerSemanticsMatch = input.session.agent === "opencode"
    ? status.authMode === "interactive_login" &&
      status.evidenceClass === "provider_cli_credential_presence" &&
      (status.state === "login_required" || status.state === "configured")
    : status.evidenceClass !== "provider_cli_credential_presence";
  // `unavailable/insufficient` is an explicit server abstention: its zero TTL
  // makes it unusable as authentication evidence, but it is not proof that the
  // exact, freshly supervisor-observed OpenCode PTY is unsafe to open.  The
  // terminal-connection endpoint repeats the exact readiness check before it
  // mints a one-use grant.  Preserve the distinction by showing only the
  // conservative interactive-login-pending state, never configured/authenticated.
  if (isCurrentOpenCodeAuthenticationAbstention(
    input.session,
    input.observation,
    status,
    now,
  )) {
    return openCodeInteractiveLoginPending(input.observation);
  }
  if (
    status.agentSessionId !== input.session.id ||
    status.agent !== input.session.agent ||
    status.authMode !== input.session.authMode ||
    status.processEpoch === null ||
    status.processEpoch !== input.session.processEpoch ||
    status.processEpoch !== input.observation.processEpoch ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(validUntil) ||
    observedAt > now + AGENT_SESSION_AUTH_MAX_FUTURE_SKEW_MS ||
    validUntil - observedAt > AGENT_SESSION_AUTH_MAX_TTL_MS ||
    validUntil <= now ||
    !providerSemanticsMatch
  ) {
    if (input.session.agent === "opencode") {
      throw runtimeFailure(
        "remote_state_unproven",
        "OpenCode foreground admission received invalid provider credential evidence.",
      );
    }
    return undefined;
  }
  return Object.freeze({
    value: status.state,
    source: `cuna_agent_auth:${status.adapterVersion}:${status.evidenceClass}`,
    observedAt,
    expiresAt: validUntil,
    correlationId: status.observationId,
  });
}

function mayEnterOpenCodeLogin(
  session: AgentSession,
  observation: ReturnType<typeof assertRemoteAgentSessionEvidence>,
  now: number,
): boolean {
  const expiresAt = Date.parse(observation.expiresAt);
  return session.agent === "opencode" &&
    session.authMode === "interactive_login" &&
    (observation.state === "ready" || observation.state === "running") &&
    Number.isFinite(expiresAt) &&
    expiresAt > now;
}

function isCurrentOpenCodeAuthenticationAbstention(
  session: AgentSession,
  observation: ReturnType<typeof assertRemoteAgentSessionEvidence>,
  status: AgentSessionAuth,
  now: number,
): boolean {
  return mayEnterOpenCodeLogin(session, observation, now) &&
    status.agentSessionId === session.id &&
    status.agent === "opencode" &&
    status.authMode === "interactive_login" &&
    status.processEpoch !== null &&
    status.processEpoch === session.processEpoch &&
    status.processEpoch === observation.processEpoch &&
    status.state === "unavailable" &&
    status.evidenceClass === "insufficient";
}

function openCodeInteractiveLoginPending(
  observation: ReturnType<typeof assertRemoteAgentSessionEvidence>,
): ForegroundTabIntent["providerAuthentication"] {
  return Object.freeze({
    value: "login_required",
    source: `${observation.authority}:interactive_login_pending`,
    observedAt: Date.parse(observation.observedAt),
    expiresAt: Date.parse(observation.expiresAt),
    correlationId: observation.evidenceRevision,
  });
}

function safeSessionLabel(session: AgentSession): string {
  const label = session.name
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (label.length === 0 ? session.id : label).slice(0, 64);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw runtimeFailure("terminal_disconnected", "Foreground terminal startup was cancelled.");
  }
}
