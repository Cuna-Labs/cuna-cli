import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SESSION = "10000000-0000-4000-8000-000000000001";
const MACHINE = "20000000-0000-4000-8000-000000000001";
const EPOCH = "30000000-0000-4000-8000-000000000001";
const entrypoint = fileURLToPath(new URL("../dist/bin/cuna.js", import.meta.url));

function runArtifact(args, { preload } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      ...(preload === undefined
        ? []
        : ["--import", `data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`]),
      entrypoint,
      ...args,
    ], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        CUNA_API_KEY: "cuna_sk_abcdefghijklmnop",
        TERM: "xterm-256color",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("built public entrypoint reports composed local journey availability", async () => {
  const result = await runArtifact(["doctor", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const record = JSON.parse(result.stdout.trim());
  const byName = new Map(record.data.runtime_features.map((item) => [item.feature, item]));
  assert.equal(byName.get("terminal_workspace")?.implementation, "available");
  assert.equal(byName.get("workspace_sync")?.implementation, "available");
  assert.match(byName.get("terminal_workspace")?.reason ?? "", /live_producer_required/u);
  assert.match(byName.get("workspace_sync")?.reason ?? "", /live_producer_required/u);
});

test("built public codex path reaches fresh producer capability admission and fails closed", async () => {
  const now = Date.now();
  const preload = `
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "setRawMode", { configurable: true, value: () => process.stdin });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 120 });
    Object.defineProperty(process.stdout, "rows", { configurable: true, value: 40 });
    const session = ${JSON.stringify({
      id: SESSION,
      machine_id: MACHINE,
      name: "owner-test-codex",
      agent: "codex",
      cwd: "/workspace",
      auth_mode: "interactive_login",
      desired_state: "running",
      request_state: "launched",
      process_state: "running",
      process_epoch: EPOCH,
      row_version: 1,
      created_at: new Date(now - 1_000).toISOString(),
      updated_at: new Date(now - 500).toISOString(),
    })};
    const capability = ${JSON.stringify({
      schema_version: "1.0",
      subject_scope: "agent_session",
      subject_id: SESSION,
      observed_at: new Date(now - 500).toISOString(),
      expires_at: new Date(now + 30_000).toISOString(),
      etag: "fake-producer-v1",
      capabilities: [{
        id: "terminal_connections.create",
        availability: "unsupported",
        interaction: "native",
        mutation_class: "none",
        surfaces: ["cli"],
        required_permissions: [],
        reason_code: "negative_control",
      }],
    })};
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      const body = url.pathname === "/v1/agent-sessions/${SESSION}"
        ? session
        : url.pathname === "/v1/capabilities"
          ? capability
          : (() => { throw new Error("unexpected fake-producer operation: " + url.pathname); })();
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  `;
  const result = await runArtifact(["codex", "--agent-session", SESSION], { preload });
  assert.equal(result.code, 8, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /required capability is unsupported/iu);
  assert.doesNotMatch(result.stderr, /cuna_sk_/u);
});
