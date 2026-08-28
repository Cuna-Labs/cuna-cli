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
  admitForegroundDimensions,
  admitForegroundSessionIds,
  type ForegroundTabIntent,
  type ForegroundTerminalCoordinatorOptions,
  type ForegroundTerminalHost,
} from "../terminal/foreground.js";
import {
  PassthroughTerminalCoordinator,
  admitPassthroughDimensions,
} from "../terminal/passthrough.js";

import { createApiTerminalControlPlane } from "./api-terminal-control-plane.js";
import { CunaRuntimeBoundary } from "./boundary.js";
import { admitCapability } from "./capability-gate.js";
import { RuntimeBoundaryError, runtimeFailure } from "./errors.js";
import { createNodeWebSocketConnector } from "./node-websocket-connector.js";
import {
  assertRemoteAgentSessionEvidence,
  type TerminalConnector,
  type TerminalControlPlane,
} from "./terminal-transport.js";

const TERMINAL_CAPABILITY_ID = "terminal_connections.create";
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
  /** OpenCode effects are admitted only after the local producer witness gate. */
  readonly opencodeEnabled?: boolean;
  readonly browser?: BrowserOpener;
  /** Clears caller-owned progress UI before raw/alternate-screen terminal ownership. */
  readonly onBeforeTerminalOwnership?: () => void;
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
}

export async function runNodeForegroundSessions(
  input: ForegroundSessionRunnerInput,
  dependencies: NodeForegroundSessionDependencies = {},
): Promise<void> {
  try {
    await runNodeForegroundSessionsOnce(input, dependencies);
  } catch (error) {
    if (!retryableEarlyTerminalFailure(error) || input.signal?.aborted) throw error;
    // A newly issued one-use ticket can reach the public gateway just before
    // the machine supervisor observes it. Retry the complete, already-cleaned
    // foreground composition exactly once; this mints fresh one-use authority
    // and never repeats user input or an established terminal interaction.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await runNodeForegroundSessionsOnce(input, dependencies);
  }
}

function retryableEarlyTerminalFailure(error: unknown): boolean {
  if (!(error instanceof RuntimeBoundaryError) || error.code !== "terminal_disconnected") return false;
  return (error.retryable && /before negotiation completed/u.test(error.message)) ||
    error.message === "The passthrough terminal connection ended." ||
    error.message === "The terminal tab is not connected.";
}

async function runNodeForegroundSessionsOnce(
  input: ForegroundSessionRunnerInput,
  dependencies: NodeForegroundSessionDependencies,
): Promise<void> {
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
  const allowedOrigin = admitApiOrigin(input.baseUrl);
  const host = dependencies.host ?? createNodeForegroundTerminalHost();
  const clientInstanceId = dependencies.clientInstanceId?.() ?? `cli:${randomUUID()}`;

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
  for (let index = 0; index < sessionIds.length; index += 1) {
    const agentSessionId = sessionIds[index];
    if (agentSessionId === undefined) continue;
    throwIfAborted(input.signal);
    const session = await input.client.getAgentSession(agentSessionId, input.signal);
    if (session.agent === "opencode" && input.opencodeEnabled !== true) {
      throw runtimeFailure(
        "capability_unsupported",
        "OpenCode is not enabled by this CLI's producer contract witness.",
      );
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
    const capabilitySnapshot = await controlPlane.discoverCapabilities(
      "agent_session",
      agentSessionId,
      input.signal,
    );
    throwIfAborted(input.signal);
    const capability = admitCapability(capabilitySnapshot, {
      id: TERMINAL_CAPABILITY_ID,
      scope: "agent_session",
      subjectId: agentSessionId,
      surface: "cli",
      interaction: "native",
    }, clock());
    const observation = assertRemoteAgentSessionEvidence({
      evidence: await controlPlane.observeAgentSession(agentSessionId, input.signal),
      expectedAgentSessionId: agentSessionId,
      now: clock(),
    });
    throwIfAborted(input.signal);
    admitSessionIdentity(session, observation, agentSessionId);
    const providerAuthentication = await observeProviderAuthentication({
      client: input.client,
      session,
      observation,
      now: clock,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    throwIfAborted(input.signal);
    if (capability.expiresAt <= clock()) {
      throw runtimeFailure("capability_snapshot_expired", "Terminal capability authority expired during preflight.");
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

  input.onBeforeTerminalOwnership?.();
  const coordinator = presentationMode === "rich"
    ? new ForegroundTerminalCoordinator({
        ...dependencies.coordinatorOptions,
        host,
        ...(input.browser === undefined ? {} : { browser: input.browser }),
        clock,
        color: input.color ?? true,
        deviceId: clientInstanceId,
      })
    : new PassthroughTerminalCoordinator({
        host,
        ...(dependencies.coordinatorOptions?.resizeCoalesceMs === undefined
          ? {}
          : { resizeCoalesceMs: dependencies.coordinatorOptions.resizeCoalesceMs }),
      });
  const callbacks = coordinator.runtimeCallbacks();
  const runtime = new CunaRuntimeBoundary({
    mode: "foreground",
    controlPlane,
    terminalConnector: dependencies.terminalConnector ?? createNodeWebSocketConnector(),
    allowedCunaOrigins: [allowedOrigin],
    terminalCapabilityId: TERMINAL_CAPABILITY_ID,
    clientInstanceId,
    clock,
    ...callbacks,
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
  try {
    await runtime.shutdown();
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (failure !== undefined && cleanupFailures.length > 0) {
    throw new AggregateError([failure, ...cleanupFailures], "Foreground terminal execution and cleanup both failed.");
  }
  if (failure !== undefined) throw failure;
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "Foreground terminal cleanup was incomplete.");
  }
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
}>): Promise<ForegroundTabIntent["providerAuthentication"]> {
  let status: AgentSessionAuth;
  try {
    status = await input.client.getAgentSessionAuth(input.session.id, input.signal);
  } catch (error) {
    throwIfAborted(input.signal);
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
