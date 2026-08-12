import { randomUUID } from "node:crypto";

import {
  AGENT_SESSION_AUTH_MAX_FUTURE_SKEW_MS,
  AGENT_SESSION_AUTH_MAX_TTL_MS,
  type AgentSession,
  type AgentSessionAuth,
} from "../api/contracts.js";
import type { CunaApiClient } from "../api/client.js";
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
import { runtimeFailure } from "./errors.js";
import { createNodeWebSocketConnector } from "./node-websocket-connector.js";
import {
  assertRemoteAgentSessionEvidence,
  type TerminalConnector,
  type TerminalControlPlane,
} from "./terminal-transport.js";

const TERMINAL_CAPABILITY_ID = "terminal_connections.create";

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

  const coordinator = presentationMode === "rich"
    ? new ForegroundTerminalCoordinator({
        ...dependencies.coordinatorOptions,
        host,
        clock,
        color: input.color ?? true,
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
    clientInstanceId: dependencies.clientInstanceId?.() ?? `cli:${randomUUID()}`,
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
  if (
    session.id !== expectedAgentSessionId ||
    session.machineId !== observation.machineId ||
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
  } catch {
    throwIfAborted(input.signal);
    return undefined;
  }
  const observedAt = Date.parse(status.observedAt);
  const validUntil = Date.parse(status.validUntil);
  const now = input.now();
  if (
    status.agentSessionId !== input.session.id ||
    status.authMode !== input.session.authMode ||
    status.processEpoch === null ||
    status.processEpoch !== input.session.processEpoch ||
    status.processEpoch !== input.observation.processEpoch ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(validUntil) ||
    observedAt > now + AGENT_SESSION_AUTH_MAX_FUTURE_SKEW_MS ||
    validUntil - observedAt > AGENT_SESSION_AUTH_MAX_TTL_MS ||
    validUntil <= now
  ) {
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
