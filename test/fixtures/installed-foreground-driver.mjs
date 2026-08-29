// Test-only installed-artifact boundary. It runs the production foreground
// coordinator with a deterministic control plane and a real bounded child
// process standing in for the terminal transport. This proves acquisition,
// detach, close, child termination, and host restoration without contacting a
// live machine.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const installedRoot = process.env.CUNA_TEST_INSTALLED_ROOT;
const receiptPath = process.env.CUNA_TEST_FOREGROUND_RECEIPT;
if (!installedRoot || !receiptPath) throw new Error("installed root and foreground receipt are required");
const { runCli } = await import(pathToFileURL(path.join(installedRoot, "dist/cli/run.js")).href);
const { runNodeForegroundSessions } = await import(pathToFileURL(path.join(installedRoot, "dist/runtime/node-foreground-session.js")).href);
const { TERMINAL_PROTOCOL } = await import(pathToFileURL(path.join(installedRoot, "dist/terminal/codec.js")).href);

for (const stream of [process.stdin, process.stdout, process.stderr]) {
  Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
}

const events = [];
let childPid;
let childClosed = false;
let childExitCode;
let childSignal;
let inputListener;
let resizeListener;
const automatic = { phases: [], agent: undefined, attached: undefined };

class AsyncByteQueue {
  values = []; waiters = []; closed = false;
  push(value) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }
  close() { this.closed = true; for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined }); }
  [Symbol.asyncIterator]() { return this; }
  next() {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

const host = {
  dimensions: () => ({ columns: 80, rows: 24 }),
  async acquire() { events.push("host:acquire"); return { restore: async () => events.push("host:restore") }; },
  async write() {},
  onInput(listener) {
    inputListener = listener;
    return () => { inputListener = undefined; };
  },
  onResize(listener) { resizeListener = listener; return () => { resizeListener = undefined; }; },
};

const authorityScenario = process.env.CUNA_TEST_FOREGROUND_AUTHORITY_SCENARIO ?? "fresh";
if (authorityScenario !== "fresh" && authorityScenario !== "stale-supervisor-evidence") {
  throw new Error("installed foreground authority scenario is not recognized");
}

function freshAuthorityWindow(ttlMs) {
  const observedAt = Date.now();
  return {
    observedAt: new Date(observedAt - 100).toISOString(),
    expiresAt: new Date(observedAt + ttlMs).toISOString(),
  };
}

function supervisorAuthorityWindow() {
  const observedAt = Date.now();
  if (authorityScenario === "stale-supervisor-evidence") {
    return {
      observedAt: new Date(observedAt - 30_000).toISOString(),
      expiresAt: new Date(observedAt - 1).toISOString(),
    };
  }
  return {
    observedAt: new Date(observedAt - 100).toISOString(),
    expiresAt: new Date(observedAt + 20_000).toISOString(),
  };
}

const processEpoch = "70000000-0000-4000-8000-000000000007";
const controlPlane = {
  async discoverCapabilities(_scope, id) {
    const freshness = freshAuthorityWindow(30_000);
    return { schemaVersion: "1.0", subjectScope: "agent_session", subjectId: id, ...freshness, etag: "installed-foreground", capabilities: [{ id: "terminal_connections.create", availability: "supported", interaction: "native", mutationClass: "reversible", surfaces: ["cli"], requiredPermissions: ["terminal.connect"] }] };
  },
  async observeAgentSession(id) {
    const freshness = supervisorAuthorityWindow();
    return { authority: "cuna_agent_session_supervisor", userId: "installed-user", machineId: "10000000-0000-4000-8000-000000000001", agentSessionId: id, processEpoch, state: "running", ...freshness, evidenceRevision: "installed-foreground-revision" };
  },
  async createTerminalConnection(input) {
    const freshness = freshAuthorityWindow(20_000);
    return { terminalSessionId: "77777777-7777-4777-8777-777777777777", resumeHandle: "66666666-6666-4666-8666-666666666666", connectUrl: "wss://api.getcuna.com/v1/terminal-connections/77777777-7777-4777-8777-777777777777/stream", connectToken: `runa_tc_${"A".repeat(43)}`, protocol: TERMINAL_PROTOCOL, capabilities: [{ name: "acknowledgement", availability: "supported" }, { name: "heartbeat", availability: "supported" }, { name: "live_resize", availability: "supported" }, { name: "resume", availability: "supported" }, { name: "signals", availability: "supported" }], expiresAt: freshness.expiresAt, agentSessionId: input.agentSessionId, processEpoch, attachmentGeneration: 1 };
  },
};

const terminalConnector = {
  async connect() {
    const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "installed-terminal-child.mjs"), installedRoot, process.env.CUNA_TEST_AGENT_SESSION_ID, processEpoch, process.env.CUNA_TEST_FOREGROUND_SCENARIO ?? "clean"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    childPid = child.pid;
    events.push("child:spawn");
    const queue = new AsyncByteQueue();
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      const record = JSON.parse(stdout.slice(0, newline));
      if (record.event !== "ready") throw new Error("terminal child emitted an unexpected event");
      queue.push(Buffer.from(record.frame, "base64"));
      events.push("child:ready");
      setTimeout(() => inputListener?.(Uint8Array.of(0x1d, 0x64)), 20);
    });
    child.once("close", (code, signal) => {
      childExitCode = code;
      childSignal = signal;
      events.push(`child:exit:${code ?? "signal"}`);
      queue.close();
    });
    return {
      connectionId: "77777777-7777-4777-8777-777777777777",
      receive: () => queue,
      async send() {},
      async close() {
        events.push("wire:close");
        queue.close();
        if (child.exitCode === null) child.stdin.end("close\n");
        if (child.exitCode === null) {
          await Promise.race([
            new Promise((resolve) => child.once("close", resolve)),
            new Promise((resolve) => setTimeout(resolve, 1_000)),
          ]);
        }
        if (child.exitCode === null) child.kill();
        if (child.exitCode === null) await new Promise((resolve) => child.once("close", resolve));
        childClosed = true;
      },
    };
  },
};

let exitCode = 1;
try {
  const foregroundTerminalRunner = (input) => runNodeForegroundSessions({ ...input, baseUrl: "https://api.getcuna.com", presentationMode: "plain", hostPlatform: "linux", terminalKind: "dumb" }, { host, controlPlane, terminalConnector, clock: () => Date.now(), platform: "linux", environment: {} });
  exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    foregroundTerminalRunner,
    automaticJourneyEffectsFactory: ({ intent, client, config }) => {
      automatic.agent = intent.agent;
      const automaticSessionId = process.env.CUNA_TEST_AGENT_SESSION_ID;
      return {
        onPhase(event) { if (event.type === "started") automatic.phases.push(event.phase); },
        async inspectWorkspace() { return { canonicalLocalRoot: process.cwd() }; },
        async observeMachines() { return [{ id: "10000000-0000-4000-8000-000000000001", name: "matrix-machine", agent: "unknown", requestedAgentSupport: "supported", state: "running", ownership: "owned", freshness: "fresh", recency: "recent", resources: {}, costStatus: "known" }]; },
        async createMachine() { return { id: "10000000-0000-4000-8000-000000000001", state: "running" }; },
        async reconcileMachineCreate() { return "unreconcilable"; },
        async ensureMachineReady({ machineId }) { return { id: machineId, state: "running" }; },
        async synchronizeWorkspace() { return { bindingId: "60000000-0000-4000-8000-000000000006", workspaceIdentity: "60000000-0000-4000-8000-000000000006", generation: 1, remoteCwd: "/workspace" }; },
        async observeAgentSessions() { return []; },
        async createAgentSession({ machineId }) { return { id: automaticSessionId, machineId }; },
        async ensureAgentSessionReady() { return { id: automaticSessionId, machineId: "10000000-0000-4000-8000-000000000001" }; },
        async attach(input) {
          automatic.attached = { id: input.agentSessionId, agent: input.expectedAgent };
          await foregroundTerminalRunner({ client, baseUrl: config.baseUrl, agentSessionIds: [input.agentSessionId], expectedAgentKinds: [input.expectedAgent], presentationMode: "plain" });
        },
        async reconcileCancellation() {},
      };
    },
  });
} finally {
  await writeFile(receiptPath, JSON.stringify({ child_pid: childPid, child_closed: childClosed, child_exit_code: childExitCode, child_signal: childSignal, input_listener_removed: inputListener === undefined, resize_listener_removed: resizeListener === undefined, events, automatic }) + "\n", "utf8");
}
process.exitCode = exitCode;
