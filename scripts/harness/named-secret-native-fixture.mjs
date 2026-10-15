import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

const marker = "NATIVE_CANARY_";
const fixtureReceipt = process.env.CUNA_NATIVE_RECEIPT;
let lifecycleReport = { pid: process.pid, run_id: process.env.CUNA_NATIVE_RUN_ID, stage: "starting" };
let receiptTask = Promise.resolve();
const saveLifecycle = () => { const text = JSON.stringify(lifecycleReport); receiptTask = receiptTask.then(() => writeFile(fixtureReceipt, text)); return receiptTask; };
await saveLifecycle();
for (const event of ["uncaughtException", "unhandledRejection"]) process.on(event, async (error) => {
  lifecycleReport.fatal = { event, stage: lifecycleReport.stage, class: ["Error", "TypeError", "RangeError", "AssertionError", "RuntimeBoundaryError"].includes(error?.name) ? error.name : "UnknownError",
    ...(error?.code === "grant_scope_mismatch" ? { code: "grant_scope_mismatch" } : {}) };
  try { await saveLifecycle(); } finally { process.exit(1); }
});
if (process.argv.includes("--sink")) {
  let received = Buffer.alloc(0); let counter = 0;
  process.stdin.setRawMode(true); process.stdin.resume();
  const save = () => {
    const text = JSON.stringify({ pid: process.pid, run_id: process.env.CUNA_NATIVE_RUN_ID, input_bytes: received.length, canary_seen: received.includes(marker), safe_after_seen: received.includes("SAFE_AFTER"), arrow_seen: received.includes("\x1b[A"), native_tty: process.stdin.isTTY });
    receiptTask = receiptTask.then(() => writeFile(fixtureReceipt, text)); return receiptTask;
  };
  process.stdin.on("data", (bytes) => { received = Buffer.concat([received, bytes]); void save(); });
  process.stdout.write(`NATIVE_SINK_READY ${process.pid}\r\n`);
  const timer = setInterval(() => process.stdout.write(`REMOTE_OUTPUT_${++counter}\r\n`), 100);
  process.on("SIGTERM", async () => { clearInterval(timer); await save(); process.exit(0); });
} else {
  const installed = process.env.CUNA_NATIVE_INSTALLED;
  const module = (relative) => import(pathToFileURL(path.join(installed, "dist", relative)).href);
  const [{ ForegroundTerminalCoordinator }, { createNodeForegroundTerminalHost }, { createCunaApiClient }, { createHttpTransport }, { createNamedSecretService }, { DEPLOYED_WIRE_COMPATIBILITY }] = await Promise.all([
    module("terminal/foreground.js"), module("pty/node-host-terminal.js"), module("api/client.js"), module("api/http.js"), module("named-secrets/service.js"), module("core/deployed-wire-compatibility.js"),
  ]);
  const ids = { user: "11111111-1111-4111-8111-111111111111", machine: "22222222-2222-4222-8222-222222222222", binding: "33333333-3333-4333-8333-333333333333", epoch: "44444444-4444-4444-8444-444444444444", connection: "55555555-5555-4555-8555-555555555555", workspace: "66666666-6666-4666-8666-666666666666", session: "77777777-7777-4777-8777-777777777777" };
  // Public test payload, matched exactly; this fixture stores no password verifier.
  const exactCanaryMatches = (value) => value === "NATIVE_CANARY_nativé界🔒\nsecond line";
  const receipts = new Map(); const report = lifecycleReport = { ...lifecycleReport, native_host_tty: process.stdin.isTTY, api_posts: 0, exact_canary_matched: null, operation_id: null, same_process_epoch: true, resize_calls: 0, fixture_api: "loopback-memory-only", stage: "fixture-ready" };
  const context = { agent_session_id: ids.session, machine_id: ids.machine, workspace_binding_id: ids.binding, process_epoch: ids.epoch, terminal_connection_id: ids.connection, connect_token: `${DEPLOYED_WIRE_COMPATIBILITY.credentialBrand}_tc_${"A".repeat(43)}`, writer_epoch: 1 };
  const server = createServer(async (request, response) => {
    const send = (status, row) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(row)); };
    if (request.headers.authorization !== "Bearer cuna_sk_NATIVE_FIXTURE_ONLY_123456") return send(401, {});
    if (request.url === "/v1/me") return send(200, { id: ids.user, email: "native@example.test", workspace: { assigned: true, id: ids.workspace, usage: {} } });
    if (request.url === `/v1/sessions/${ids.machine}`) return send(200, { id: ids.machine, name: "native-fixture", state: "running" });
    if (request.url === `/v1/agent-sessions/${ids.session}`) return send(200, { id: ids.session, machine_id: ids.machine, workspace_binding_id: ids.binding, workspace_generation: 1, name: "native", agent: "codex", cwd: "/workspace/native", auth_mode: "interactive_login", desired_state: "running", request_state: "launched", process_state: "running", process_epoch: ids.epoch, row_version: 1, created_at: "2026-10-12T12:00:00Z", updated_at: "2026-10-12T12:00:00Z" });
    if (request.method === "POST" && request.url === "/v1/named-secrets") {
      const parts = []; for await (const data of request) parts.push(data);
      const body = JSON.parse(Buffer.concat(parts).toString());
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(body.operation_id) || body.operation_id !== request.headers["idempotency-key"] ||
        typeof body.name !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(body.name) || typeof body.password !== "string" || Buffer.byteLength(body.password) > 4096 ||
        Object.keys(body).sort().join() !== "context,name,operation_id,password" || Object.keys(body.context ?? {}).sort().join() !== Object.keys(context).sort().join() ||
        Object.entries(context).some(([key, value]) => body.context[key] !== value)) return send(422, {});
      report.api_posts++; report.exact_canary_matched = exactCanaryMatches(body.password); report.operation_id = body.operation_id;
      const row = { operation_id: body.operation_id, state: "committed", secret_id: ids.connection, name: body.name, workspace_id: ids.workspace, committed_at: "2026-10-12T12:00:00Z" };
      receipts.set(body.operation_id, row); return send(201, row);
    }
    const op = request.url?.split("/v1/named-secrets/operations/")[1];
    return op !== undefined && receipts.has(op) ? send(200, receipts.get(op)) : send(404, {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = createCunaApiClient(createHttpTransport({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "cuna_sk_NATIVE_FIXTURE_ONLY_123456" }));
  const host = createNodeForegroundTerminalHost();
  const coordinator = new ForegroundTerminalCoordinator({ host, namedSecrets: createNamedSecretService(client), resizeCoalesceMs: 10, color: false });
  const callbacks = coordinator.runtimeCallbacks(); let sequence = 0n; let sink; let sinkExit; let acceptingOutput = true; let outputTail = Promise.resolve();
  const state = () => ({ tabId: "native", viewId: "native:1", userId: ids.user, machineId: ids.machine, workspaceBindingId: ids.binding, workspaceBindingGeneration: 1, agentSessionId: ids.session, processEpoch: ids.epoch, state: "active", fencingGeneration: 1, inputSequence: 0n, outputSequence: sequence, outputContinuity: "complete", resizeCapability: "live", accessMode: "writer", writerEpoch: 1, heartbeatObservedAt: Date.now(), heartbeatExpiresAt: Date.now() + 60000 });
  const output = (bytes) => {
    if (!acceptingOutput) return Promise.resolve();
    const operation = outputTail.then(async () => { const s = state(); await callbacks.onTerminalOutput({ provenance: "live", tabId: "native", agentSessionId: ids.session, binding: { userId: s.userId, machineId: s.machineId, agentSessionId: s.agentSessionId, processEpoch: s.processEpoch, fencingGeneration: 1 }, sequence: ++sequence, bytes, signal: new AbortController().signal }); });
    outputTail = operation.then(() => undefined, () => undefined); return operation;
  };
  const runtime = {
    async attach() {
      await callbacks.onTerminalReady(state());
      const sinkEnv = { ...process.env, CUNA_NATIVE_RECEIPT: process.env.CUNA_NATIVE_SINK_RECEIPT };
      if (process.platform === "win32") {
        const require = createRequire(process.env.CUNA_NATIVE_NODE_PTY);
        sink = require("node-pty").spawn(process.execPath, [process.argv[1], "--sink", `--native-run=${process.env.CUNA_NATIVE_RUN_ID}`], { cols: 80, rows: 24, useConpty: true, env: sinkEnv });
        report.sink_pid = sink.pid; await saveLifecycle();
        sink.onData((data) => { void output(new TextEncoder().encode(data)); }); sinkExit = new Promise((resolve) => sink.onExit(resolve));
      } else {
        const child = spawn("python3", [process.env.CUNA_NATIVE_UNIX_BRIDGE, process.execPath, process.argv[1], "--sink", `--native-run=${process.env.CUNA_NATIVE_RUN_ID}`], { env: sinkEnv, stdio: ["pipe", "pipe", "inherit"] });
        let carry = ""; child.stdout.on("data", (chunk) => { carry += chunk; const lines = carry.split("\n"); carry = lines.pop(); for (const line of lines) { const row = JSON.parse(line); if (row.kind === "started") { report.sink_pid = row.pid; void saveLifecycle(); } else if (row.kind === "data") void output(Buffer.from(row.data, "base64")); } });
        sink = { write: (text) => child.stdin.write(JSON.stringify({ kind: "input", data: Buffer.from(text).toString("base64") }) + "\n"), resize: (cols, rows) => child.stdin.write(JSON.stringify({ kind: "resize", cols, rows }) + "\n"), kill: () => child.stdin.write('{"kind":"kill"}\n') };
        sinkExit = new Promise((resolve) => child.on("exit", resolve));
      }
      return state();
    },
    // Stop callback delivery before the coordinator retires its viewport. The
    // synthetic provider process lives until explicit harness cleanup.
    async detach() { acceptingOutput = false; await outputTail; }, async reconnect() { return state(); }, async resize(cols, rows) { if (sink !== undefined) { sink.resize(cols, rows); report.resize_calls++; } },
    async sendInput(bytes) { sink.write(Buffer.from(bytes).toString()); }, switchActive() { return state(); }, async sendTerminalResponse() {},
    namedSecretContext() { return context; },
  };
  coordinator.bindRuntime(runtime);
  try {
    await coordinator.start([{ tabId: "native", agentSessionId: ids.session, label: "native fixture", agent: "codex", workspaceBindingId: ids.binding, workspaceGeneration: 1 }]);
    await coordinator.waitForStop();
  } finally {
    report.stage = "stopping"; await saveLifecycle(); await coordinator.stop(); report.failure_class = coordinator.failure?.name; await saveLifecycle();
    if (process.platform === "win32") process.kill(sink.pid); else sink.kill();
    await Promise.race([sinkExit, new Promise((resolve) => setTimeout(resolve, 2000))]);
    await new Promise((resolve) => server.close(resolve)); report.stage = "closed"; await saveLifecycle(); process.exit(coordinator.failure === undefined ? 0 : 1);
  }
}
