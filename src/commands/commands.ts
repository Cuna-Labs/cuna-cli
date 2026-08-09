import {
  requireCapability,
  type MachineCreateInput,
  type RunaApiClient,
} from "../api/client.js";
import { packageBuildDigest, PROTOCOL_RANGE, UPDATE_CHANNEL } from "../build-identity.js";
import type {
  AgentKind,
  AgentSession,
  CapabilitySnapshot,
  Machine,
} from "../api/contracts.js";
import type { EffectiveConfig } from "../config/config.js";
import { publicConfig } from "../config/config.js";
import { EXIT_CODES, RunaError, unsupportedError, usageError } from "../core/errors.js";
import { assertIdempotencyKey, assertPublicId, assertSafeDisplayText } from "../core/validation.js";
import { INITIAL_RUNTIME_GATES } from "../runtime/contracts.js";
import { evaluateRuntimeSupport } from "../platform/support.js";
import { CLI_VERSION } from "../version.js";
import {
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

export interface CommandContext {
  readonly parsed: ParsedInvocation;
  readonly config: EffectiveConfig;
  readonly client: RunaApiClient;
  readonly now: number;
  readonly credentialMode?: "automation" | "interactive";
}

function requireCredential(context: CommandContext): void {
  if (context.credentialMode !== undefined) return;
  throw new RunaError({
    code: "runa.auth.required",
    message: "This command requires a Runa credential.",
    exitCode: EXIT_CODES.auth,
    hint: "Run `runa login` for interactive use or set RUNA_API_KEY for explicit automation.",
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
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw usageError(`Option --${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function agentOption(parsed: ParsedInvocation, required: boolean): AgentKind | undefined {
  const raw = stringOption(parsed, "agent");
  if (raw === undefined) {
    if (required) throw usageError("Option --agent is required.");
    return undefined;
  }
  if (raw !== "claude-code" && raw !== "codex" && raw !== "openclaw") {
    throw usageError("Option --agent must be claude-code, codex, or openclaw.");
  }
  return raw;
}

function requireConfirmation(parsed: ParsedInvocation, command: string): void {
  if (booleanOption(parsed, "yes")) return;
  throw new RunaError({
    code: "runa.confirmation.required",
    message: `The ${command} mutation requires explicit confirmation in this initial build.`,
    exitCode: EXIT_CODES.policy,
    hint: `Review the target and repeat with --yes.`,
  });
}

function idempotencyKey(parsed: ParsedInvocation): string {
  const value = stringOption(parsed, "idempotency-key");
  if (value === undefined) {
    throw usageError(
      "Option --idempotency-key is required for create operations.",
      "Reuse the same opaque key when reconciling an uncertain result.",
    );
  }
  return assertIdempotencyKey(value);
}

function machineRecord(machine: Machine): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: machine.id,
    name: machine.name,
    state: machine.state,
    ...(machine.agent === undefined ? {} : { agent: machine.agent }),
    ...(machine.vcpus === undefined ? {} : { vcpus: machine.vcpus }),
    ...(machine.memoryMiB === undefined ? {} : { memory_mib: machine.memoryMiB }),
    ...(machine.createdAt === undefined ? {} : { created_at: machine.createdAt }),
    ...(machine.updatedAt === undefined ? {} : { updated_at: machine.updatedAt }),
  });
}

function agentSessionRecord(session: AgentSession): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: session.id,
    machine_id: session.machineId,
    name: session.name,
    agent: session.agent,
    cwd: session.cwd,
    auth_mode: session.authMode,
    desired_state: session.desiredState,
    request_state: session.requestState,
    process_state: session.processState,
    ...(session.processEpoch === undefined ? {} : { process_epoch: session.processEpoch }),
    ...(session.runtimeObservedAt === undefined ? {} : { runtime_observed_at: session.runtimeObservedAt }),
    ...(session.terminationRequestedAt === undefined
      ? {}
      : { termination_requested_at: session.terminationRequestedAt }),
    row_version: session.rowVersion,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  });
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

export function preflightInvocation(parsed: ParsedInvocation): void {
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
    case "agent-sessions":
      preflightAgentSessions(parsed);
      return;
    case "login":
    case "logout":
    case "whoami":
      rejectUnknownOptions(parsed, []);
      if (parsed.operands.length !== 0) throw usageError(`${parsed.command} accepts no operands.`);
      return;
    case "signup":
    case "claude":
    case "codex":
    case "openclaw":
    case "shell":
    case "connect":
    case "sync":
    case "companion":
      rejectUnknownOptions(parsed, []);
      if (parsed.operands.length !== 0) throw usageError(`${parsed.command} accepts no operands in this build.`);
      return;
    case "doctor":
      rejectUnknownOptions(parsed, []);
      if (parsed.operands.length !== 0) throw usageError("doctor accepts no operands.");
      return;
    case "self-test":
      rejectUnknownOptions(parsed, ["offline"]);
      if (parsed.operands.length !== 0) throw usageError("self-test accepts no operands.");
      if (!booleanOption(parsed, "offline")) {
        throw usageError("self-test requires --offline in this release.", "Run `runa self-test --offline --json`.");
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
      throw usageError(`Unknown command ${parsed.command ?? "<none>"}.`, "Run `runa --help`.");
  }
}

function preflightMachines(parsed: ParsedInvocation): void {
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
    assertPublicId(requireOperand(parsed.operands, 1, "machine ID"), "machine ID");
    return;
  }
  throw usageError(`Unknown machines action ${action}.`);
}

function preflightAgentSessions(parsed: ParsedInvocation): void {
  const action = requireOperand(parsed.operands, 0, "agent-sessions action");
  if (action === "list") {
    rejectUnknownOptions(parsed, ["machine", "limit", "cursor"]);
    if (parsed.operands.length !== 1) throw usageError("agent-sessions list accepts no operands.");
    assertPublicId(stringOption(parsed, "machine") ?? "", "machine ID");
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
    assertPublicId(requireOperand(parsed.operands, 1, "AgentSession ID"), "AgentSession ID");
    return;
  }
  if (action === "create") {
    rejectUnknownOptions(parsed, [
      "machine", "name", "agent", "cwd", "auth-mode", "credential-binding", "yes", "idempotency-key",
    ]);
    if (parsed.operands.length !== 1) throw usageError("agent-sessions create accepts no operands.");
    requireConfirmation(parsed, "agent-sessions.create");
    assertPublicId(stringOption(parsed, "machine") ?? "", "machine ID");
    agentOption(parsed, true);
    const cwd = assertSafeDisplayText(stringOption(parsed, "cwd") ?? "/workspace", "workspace path");
    if (!cwd.startsWith("/workspace") || cwd.split("/").includes("..") || cwd.length > 1024) {
      throw usageError("Option --cwd must be a safe absolute path inside /workspace.");
    }
    const name = stringOption(parsed, "name");
    if (name !== undefined && (assertSafeDisplayText(name, "AgentSession name").length < 1 || name.length > 80)) {
      throw usageError("Option --name must contain 1 through 80 characters.");
    }
    const authMode = stringOption(parsed, "auth-mode");
    if (authMode !== undefined && authMode !== "interactive_login" && authMode !== "credential_binding") {
      throw usageError("Option --auth-mode must be interactive_login or credential_binding.");
    }
    const binding = stringOption(parsed, "credential-binding");
    if (authMode === "credential_binding" && binding === undefined) {
      throw usageError("Option --credential-binding is required for credential_binding auth mode.");
    }
    if (authMode !== "credential_binding" && binding !== undefined) {
      throw usageError("Option --credential-binding requires --auth-mode credential_binding.");
    }
    if (binding !== undefined) assertPublicId(binding, "credential binding ID");
    idempotencyKey(parsed);
    return;
  }
  if (action === "terminate" || action === "rename") {
    rejectUnknownOptions(parsed, action === "rename" ? ["name", "yes"] : ["yes"]);
    if (parsed.operands.length !== 2) throw usageError(`agent-sessions ${action} requires exactly one AgentSession ID.`);
    requireConfirmation(parsed, `agent-sessions.${action}`);
    assertPublicId(requireOperand(parsed.operands, 1, "AgentSession ID"), "AgentSession ID");
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
    assertPublicId(requireOperand(parsed.operands, 1, "AgentSession ID"), "AgentSession ID");
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
    case "agent-sessions":
      return executeAgentSessions(context);
    case "signup":
    case "login":
    case "logout":
    case "whoami":
      throw unsupportedError("browser authentication", "browser_auth_dispatch_unavailable");
    case "claude":
    case "codex":
    case "openclaw":
    case "shell":
    case "connect":
      throw unsupportedError("terminal workspace", "terminal_runtime_unavailable");
    case "sync":
      throw unsupportedError("workspace synchronization", "workspace_sync_runtime_unavailable");
    case "companion":
      throw unsupportedError("local companion", "local_companion_unavailable");
    case "doctor": {
      rejectUnknownOptions(parsed, []);
      const data = Object.freeze({
        platform: process.platform,
        node: process.version,
        runtime_features: INITIAL_RUNTIME_GATES,
      });
      return Object.freeze({ command: "doctor", data, human: JSON.stringify(data, null, 2) });
    }
    case "self-test": {
      rejectUnknownOptions(parsed, ["offline"]);
      if (parsed.operands.length !== 0) throw usageError("self-test accepts no operands.");
      if (!booleanOption(parsed, "offline")) {
        throw usageError(
          "self-test requires --offline in this release.",
          "Run `runa self-test --offline --json`.",
        );
      }
      const runtimeSupport = evaluateRuntimeSupport({
        nodeVersion: process.versions.node,
        platform: process.platform,
        architecture: process.arch,
      });
      const buildDigest = await packageBuildDigest();
      const virtualTerminal = await verifyVirtualTerminalInterop();
      const checks = Object.freeze({
        node_runtime: runtimeSupport.nodeRuntime,
        supported_platform: runtimeSupport.platform,
        supported_architecture: runtimeSupport.architecture,
        canonical_api_origin: config.baseUrl === "https://api.runacode.io" || config.developmentProfile,
        package_identity: /^[0-9a-f]{64}$/u.test(buildDigest),
        virtual_terminal: virtualTerminal,
        network_requests: 0,
      });
      const ok = Object.values(checks).every((value) => value === true || value === 0);
      const data = Object.freeze({
        ok,
        mode: "offline",
        version: CLI_VERSION,
        buildDigest,
        platform: process.platform,
        architecture: process.arch,
        updateChannel: UPDATE_CHANNEL,
        protocolRange: PROTOCOL_RANGE,
        checks,
      });
      if (!ok) {
        throw new RunaError({
          code: "runa.self_test.failed",
          message: "The installed Runa CLI failed an offline integrity check.",
          exitCode: EXIT_CODES.internal,
          details: {
            failed_checks: Object.entries(checks)
              .filter(([, value]) => value !== true && value !== 0)
              .map(([name]) => name)
              .join(","),
          },
        });
      }
      return Object.freeze({ command: "self-test", data, human: "Offline self-test passed." });
    }
    default:
      throw usageError(`Unknown command ${parsed.command ?? "<none>"}.`, "Run `runa --help`.");
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
    const snapshot = await viewport.write(new TextEncoder().encode("runa"), 1n, 1n);
    return snapshot.cells[0] === "runa";
  } catch {
    return false;
  } finally {
    viewport?.dispose();
  }
}

async function executeMachines(context: CommandContext): Promise<CommandResult> {
  const { parsed, client, now } = context;
  requireCredential(context);
  const action = requireOperand(parsed.operands, 0, "machines action");
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
    const vcpus = integerOption(parsed, "vcpus", 1, 8);
    const memoryMiB = integerOption(parsed, "memory-mib", 512, 16_384);
    await requireCapability({ client, scope: "account", capabilityId: "machines.create", now });
    const input: MachineCreateInput = {
      name,
      ...(agent === undefined ? {} : { agent }),
      ...(vcpus === undefined ? {} : { vcpus }),
      ...(memoryMiB === undefined ? {} : { memoryMiB }),
      ...(booleanOption(parsed, "background") ? { background: true } : {}),
    };
    const machine = await client.createMachine(input, key);
    return Object.freeze({
      command: "machines.create",
      data: machineRecord(machine),
      human: `Created machine ${machine.name} (${machine.id}) in state ${machine.state}.`,
    });
  }
  if (action === "start" || action === "pause" || action === "resume" || action === "stop") {
    rejectUnknownOptions(parsed, ["yes"]);
    if (parsed.operands.length !== 2) throw usageError(`machines ${action} requires exactly one machine ID.`);
    requireConfirmation(parsed, `machines.${action}`);
    const id = assertPublicId(requireOperand(parsed.operands, 1, "machine ID"), "machine ID");
    // The public capability registry deliberately groups the four reversible
    // lifecycle transitions under one semantic authority. The operation path
    // still binds the exact action; discovery must not invent per-action IDs
    // that the producer never advertises.
    await requireCapability({ client, scope: "machine", resourceId: id, capabilityId: "machines.lifecycle", now });
    const machine = await client.transitionMachine(id, action);
    return Object.freeze({
      command: `machines.${action}`,
      data: machineRecord(machine),
      human: `Machine ${machine.name} is ${machine.state}.`,
    });
  }
  if (action === "delete") {
    rejectUnknownOptions(parsed, ["yes"]);
    if (parsed.operands.length !== 2) throw usageError("machines delete requires exactly one machine ID.");
    requireConfirmation(parsed, "machines.delete");
    const id = assertPublicId(requireOperand(parsed.operands, 1, "machine ID"), "machine ID");
    await requireCapability({ client, scope: "machine", resourceId: id, capabilityId: "machines.delete", now });
    await client.deleteMachine(id);
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
    const machineId = assertPublicId(stringOption(parsed, "machine") ?? "", "machine ID");
    const limit = integerOption(parsed, "limit", 1, 100);
    const cursor = stringOption(parsed, "cursor");
    const page = await client.listAgentSessions(machineId, {
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    const items = page.items.map(agentSessionRecord);
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
    const session = await client.getAgentSession(requireOperand(parsed.operands, 1, "AgentSession ID"));
    return Object.freeze({ command: "agent-sessions.get", data: agentSessionRecord(session), human: `${session.id}\t${session.name}\t${session.agent}\t${session.processState}\t${session.cwd}` });
  }
  if (action === "create") {
    rejectUnknownOptions(parsed, [
      "machine", "name", "agent", "cwd", "auth-mode", "credential-binding", "yes", "idempotency-key",
    ]);
    if (parsed.operands.length !== 1) throw usageError("agent-sessions create accepts no operands.");
    requireConfirmation(parsed, "agent-sessions.create");
    const machineId = assertPublicId(stringOption(parsed, "machine") ?? "", "machine ID");
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
    const rawAuthMode = stringOption(parsed, "auth-mode");
    if (
      rawAuthMode !== undefined &&
      rawAuthMode !== "interactive_login" &&
      rawAuthMode !== "credential_binding"
    ) {
      throw usageError("Option --auth-mode must be interactive_login or credential_binding.");
    }
    const credentialBinding = stringOption(parsed, "credential-binding");
    if (rawAuthMode === "credential_binding" && credentialBinding === undefined) {
      throw usageError("Option --credential-binding is required for credential_binding auth mode.");
    }
    if (rawAuthMode !== "credential_binding" && credentialBinding !== undefined) {
      throw usageError("Option --credential-binding requires --auth-mode credential_binding.");
    }
    await requireCapability({ client, scope: "machine", resourceId: machineId, capabilityId: "agent_sessions.create", now });
    const session = await client.createAgentSession(machineId, {
      ...(name === undefined ? {} : { name }),
      agent,
      cwd,
      ...(rawAuthMode === undefined ? {} : { authMode: rawAuthMode }),
      ...(credentialBinding === undefined
        ? {}
        : { credentialBindingId: assertPublicId(credentialBinding, "credential binding ID") }),
    }, idempotencyKey(parsed));
    return Object.freeze({ command: "agent-sessions.create", data: agentSessionRecord(session), human: `Created ${session.agent} AgentSession ${session.id}.` });
  }
  if (action === "terminate") {
    rejectUnknownOptions(parsed, ["yes"]);
    if (parsed.operands.length !== 2) throw usageError("agent-sessions terminate requires exactly one AgentSession ID.");
    requireConfirmation(parsed, "agent-sessions.terminate");
    const id = assertPublicId(requireOperand(parsed.operands, 1, "AgentSession ID"), "AgentSession ID");
    await requireCapability({ client, scope: "agent_session", resourceId: id, capabilityId: "agent_sessions.terminate", now });
    const session = await client.terminateAgentSession(id);
    return Object.freeze({ command: "agent-sessions.terminate", data: agentSessionRecord(session), human: `AgentSession ${session.id} is ${session.requestState}/${session.processState}.` });
  }
  if (action === "rename") {
    rejectUnknownOptions(parsed, ["name", "yes"]);
    if (parsed.operands.length !== 2) throw usageError("agent-sessions rename requires exactly one AgentSession ID.");
    requireConfirmation(parsed, "agent-sessions.rename");
    const id = assertPublicId(requireOperand(parsed.operands, 1, "AgentSession ID"), "AgentSession ID");
    const rawName = stringOption(parsed, "name");
    const name = rawName === undefined ? undefined : assertSafeDisplayText(rawName, "AgentSession name");
    if (name === undefined || name.length < 1 || name.length > 80) {
      throw usageError("Option --name must contain 1 through 80 characters.");
    }
    await requireCapability({ client, scope: "agent_session", resourceId: id, capabilityId: "agent_sessions.rename", now });
    const session = await client.renameAgentSession(id, name);
    return Object.freeze({
      command: "agent-sessions.rename",
      data: agentSessionRecord(session),
      human: `Renamed AgentSession ${session.id} to ${session.name}.`,
    });
  }
  if (action === "attach") {
    throw unsupportedError("AgentSession attach", "terminal_runtime_missing");
  }
  throw usageError(`Unknown agent-sessions action ${action}.`);
}
