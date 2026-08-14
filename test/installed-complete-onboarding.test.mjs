import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "20000000-0000-4000-8000-000000000002";
const WORKSPACE_ID = "30000000-0000-4000-8000-000000000003";
const API_KEY_ID = "40000000-0000-4000-8000-000000000004";
const AGENT_SESSION_ID = "50000000-0000-4000-8000-000000000005";
const WORKSPACE_BINDING_ID = "60000000-0000-4000-8000-000000000006";
const PROCESS_EPOCH = "70000000-0000-4000-8000-000000000007";
const LOGIN_CODE = `cuna_login_${"l".repeat(43)}`;
const LOGIN_CODE_2 = `cuna_login_${"m".repeat(43)}`;
const EXPIRED_LOGIN_CODE = `cuna_login_${"e".repeat(43)}`;

test("the build-once tarball installs outside the checkout and completes signup/login/API-key/logout against a local contract server", { timeout: 300_000 }, async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "cuna-installed-onboarding-"));
  const candidate = path.join(sandbox, "candidate");
  const prefix = path.join(sandbox, "npm-prefix");
  const user = path.join(sandbox, "user");
  const configFile = path.join(user, "config.json");
  const authority = createContractAuthority();
  const server = createServer(authority.handle);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await mkdir(user, { recursive: true });
    await writeFile(configFile, `${JSON.stringify({
      schema_version: 1,
      selected_profile: "installed-e2e",
      profiles: { "installed-e2e": { development: true, base_url: baseUrl } },
    })}\n`);

    const suppliedCandidate = process.env.CUNA_E2E_CANDIDATE_DIR;
    let manifest;
    let tarball;
    if (suppliedCandidate !== undefined) {
      manifest = JSON.parse(await readFile(path.join(suppliedCandidate, "release-envelope.json"), "utf8"));
      tarball = path.join(suppliedCandidate, manifest.tarball.file);
    } else {
      await mkdir(candidate, { recursive: false });
      const packed = await runNpm(["pack", root, "--ignore-scripts", "--json", "--pack-destination", candidate], { cwd: sandbox, timeout: 120_000 });
      assert.equal(packed.code, 0, "installed E2E npm pack failed");
      const packRecord = JSON.parse(packed.stdout)[0];
      manifest = { version: packRecord.version, tarball: { file: packRecord.filename } };
      tarball = path.join(candidate, packRecord.filename);
    }
    await stat(tarball);
    await runNpm(["install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix, tarball], { cwd: sandbox, timeout: 120_000 });

    const installedEntrypoint = path.join(prefix, "node_modules", "@cuna_labs", "cli", "dist", "bin", "cuna.js");
    const installedRoot = path.join(prefix, "node_modules", "@cuna_labs", "cli");
    await stat(installedEntrypoint);
    assert.equal(path.resolve(installedEntrypoint).startsWith(path.resolve(prefix)), true);
    assert.equal(path.resolve(installedEntrypoint).startsWith(path.resolve(root)), false);
    const installedCredentialFiles = await readdir(path.join(installedRoot, "dist", "credentials"));
    assert.equal(
      installedCredentialFiles.some((file) => file.startsWith("index.") || file.startsWith("native-") || file.startsWith("platform.")),
      false,
      "pure-JavaScript tarball shipped a dormant native credential loader",
    );
    const installedPackageJson = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8"));
    assert.equal(installedPackageJson.optionalDependencies, undefined, "pure-JavaScript tarball declared a native optional dependency");
    const installedHelpTopics = (await import(pathToFileURL(path.join(installedRoot, "dist", "cli", "command-help.js")).href)).HELP_TOPICS;
    assert.deepEqual([...installedHelpTopics].sort(), [...INSTALLED_HELP_TOPICS].sort(), "a new installed command lacks matrix classification");
    const leafTopics = installedHelpTopics.filter((topic) => !installedHelpTopics.some((candidate) => candidate.startsWith(`${topic} `)));
    assert.deepEqual([...leafTopics].sort(), [...SUPPORTED_SUCCESS_TOPICS, ...DELIBERATE_UNSUPPORTED_TOPICS].sort(), "a leaf command lacks success or deliberate-unsupported evidence");
    const env = {
      ...process.env,
      APPDATA: path.join(user, "appdata"),
      LOCALAPPDATA: path.join(user, "localappdata"),
      USERPROFILE: user,
      HOME: user,
      CUNA_CONFIG_FILE: configFile,
      CUNA_PROFILE: "installed-e2e",
      CUNA_TEST_INSTALLED_ROOT: installedRoot,
      NO_COLOR: "1",
    };
    delete env.CUNA_API_KEY;
    delete env.RUNA_API_KEY;

    const version = await invokeInstalled(installedEntrypoint, ["version", "--json"], env, sandbox);
    assert.equal(version.code, 0);
    assert.equal(JSON.parse(version.stdout).data.version, manifest.version);
    for (const topic of INSTALLED_HELP_TOPICS) {
      const help = await invokeInstalled(installedEntrypoint, [...topic.split(" "), "--help", "--json"], env, sandbox);
      assert.equal(help.code, 0, `installed help failed for ${topic}`);
      assert.equal(JSON.parse(help.stdout).type, "result", topic);
    }
    for (const entry of INSTALLED_FAILURE_MATRIX) {
      const result = await invokeInstalled(installedEntrypoint, entry.argv, env, sandbox);
      assert.equal(result.code, entry.exit, `installed failure mode drifted for ${entry.id}`);
      const record = JSON.parse(result.stderr);
      assert.equal(record.error.code, entry.code, entry.id);
    }
    const doctor = await invokeInstalled(installedEntrypoint, ["doctor", "--json"], env, sandbox);
    assert.equal(doctor.code, 0);
    const doctorRecord = JSON.parse(doctor.stdout);
    assert.equal(doctorRecord.command, "doctor");
    const credentialVault = doctorRecord.data.runtime_features.find((feature) => feature.feature === "credential_vault");
    assert.equal(credentialVault.implementation, "available");

    const signup = await invokeInstalledAuth(["signup"], env, sandbox, LOGIN_CODE);
    assert.equal(signup.code, 0, `installed signup failed: ${safeErrorCode(signup.stderr)}`);
    const signupWhoami = await invokeInstalled(installedEntrypoint, ["whoami", "--json"], env, sandbox);
    assert.equal(signupWhoami.code, 0, `installed signup whoami failed: ${safeErrorCode(signupWhoami.stderr)}`);
    assert.equal(JSON.parse(signupWhoami.stdout).data.admission, "waitlisted");
    assert.equal((await invokeInstalled(installedEntrypoint, ["logout", "--json"], env, sandbox)).code, 0);

    const login = await invokeInstalledAuth(["login"], env, sandbox, LOGIN_CODE_2);
    assert.equal(login.code, 0, "installed login failed");
    const whoami = await invokeInstalled(installedEntrypoint, ["whoami", "--json"], env, sandbox);
    assert.equal(whoami.code, 0, "installed whoami failed");
    assert.equal(JSON.parse(whoami.stdout).data.workspace.state, "assigned");
    assert.equal(JSON.parse(whoami.stdout).data.storage_mode, "encrypted-local");
    const successMatrix = [
      ["access", ["access", "status", "--json"]],
      ["capabilities", ["capabilities", "--json"]],
      ["machines.list", ["machines", "list", "--json"]],
      ["machines.create", ["machines", "create", "--name", "matrix-machine", "--yes", "--json"]],
      ["machines.start", ["machines", "start", ID, "--yes", "--json"]],
      ["machines.pause", ["machines", "pause", ID, "--yes", "--json"]],
      ["machines.resume", ["machines", "resume", ID, "--yes", "--json"]],
      ["machines.stop", ["machines", "stop", ID, "--yes", "--json"]],
      ["records.list", ["records", "list", "--json"]],
      ["authorizations.list", ["authorizations", "list", "--machine", ID, "--json"]],
      ["account.show", ["account", "show", "--json"]],
      ["workspace.show", ["workspace", "show", "--json"]],
      ["usage.show", ["usage", "show", "--json"]],
      ["config.get", ["config", "get", "--json"]],
      ["self-test.offline", ["self-test", "--offline", "--json"]],
      ["agent-sessions.create", ["agent-sessions", "create", "--machine", ID, "--workspace-binding-id", WORKSPACE_BINDING_ID, "--workspace-generation", "1", "--agent", "codex", "--yes", "--json"]],
      ["agent-sessions.list", ["agent-sessions", "list", "--machine", ID, "--json"]],
      ["agent-sessions.get", ["agent-sessions", "get", AGENT_SESSION_ID, "--json"]],
      ["agent-sessions.rename", ["agent-sessions", "rename", AGENT_SESSION_ID, "--name", "renamed-agent", "--yes", "--json"]],
      ["agent.logout", ["agent", "logout", "--agent-session", AGENT_SESSION_ID, "--yes", "--json"]],
      ["agent-sessions.terminate", ["agent-sessions", "terminate", AGENT_SESSION_ID, "--yes", "--json"]],
      ["machines.delete", ["machines", "delete", ID, "--yes", "--json"]],
    ];
    for (const [id, argv] of successMatrix) {
      const result = await invokeInstalled(installedEntrypoint, argv, env, sandbox);
      assert.equal(result.code, 0, `installed success matrix failed for ${id}: ${safeErrorCode(result.stderr)}`);
    }
    for (const [id, argv] of [
      ["connect", ["connect", AGENT_SESSION_ID]],
      ["agent-sessions.attach", ["agent-sessions", "attach", AGENT_SESSION_ID]],
      ["claude", ["claude", "--agent-session", AGENT_SESSION_ID]],
      ["codex", ["codex", "--agent-session", AGENT_SESSION_ID]],
      ["openclaw", ["openclaw", "--agent-session", AGENT_SESSION_ID]],
    ]) {
      const result = await invokeInstalledForeground(argv, env, sandbox);
      assert.equal(result.code, 0, `installed foreground matrix failed for ${id}: ${safeErrorCode(result.stderr)}`);
    }
    await authority.assertLoginCodeNegatives(baseUrl);

    const sessionFiles = await findSessionFiles(path.join(user, "appdata"));
    assert.equal(sessionFiles.length, 2, "encrypted session must use separate key and ciphertext files");
    const sessionFile = sessionFiles.find((file) => file.endsWith(".json"));
    const keyFile = sessionFiles.find((file) => file.endsWith(".key"));
    assert.ok(sessionFile && keyFile);
    const originalSession = await readFile(sessionFile);
    assert.equal(originalSession.includes(Buffer.from(LOGIN_CODE_2)), false, "login code must not persist in plaintext");
    if (process.platform !== "win32") {
      assert.equal((await stat(sessionFile)).mode & 0o077, 0);
      assert.equal((await stat(keyFile)).mode & 0o077, 0);
    }
    await writeFile(sessionFile, "{\"corrupt\":true}\n");
    const corrupt = await invokeInstalled(installedEntrypoint, ["whoami", "--json"], env, sandbox);
    assert.equal(corrupt.code, 3);
    await writeFile(sessionFile, originalSession);
    const recovered = await invokeInstalled(installedEntrypoint, ["whoami", "--json"], env, sandbox);
    assert.equal(recovered.code, 0);

    const created = await invokeInstalled(installedEntrypoint, [
      "api-keys", "create", "--name", "installed e2e", "--yes", "--json",
    ], env, sandbox);
    assert.equal(created.code, 0, "installed API-key create failed");
    const createdRecord = JSON.parse(created.stdout);
    assert.equal(createdRecord.data.id, API_KEY_ID);
    assert.equal(created.stdout.split(createdRecord.data.key).length - 1, 1);
    assert.equal(created.stderr.includes(createdRecord.data.key), false);
    const listed = await invokeInstalled(installedEntrypoint, ["api-keys", "list", "--json"], env, sandbox);
    assert.equal(listed.code, 0, "installed API-key list failed");
    assert.equal(JSON.parse(listed.stdout).data.items[0].id, API_KEY_ID);
    const revoked = await invokeInstalled(installedEntrypoint, [
      "api-keys", "revoke", API_KEY_ID, "--yes", "--json",
    ], env, sandbox);
    assert.equal(revoked.code, 0, "installed API-key revoke failed");
    assert.equal(JSON.parse(revoked.stdout).data.revoked, true);
    assert.equal((await invokeInstalled(installedEntrypoint, ["logout", "--json"], env, sandbox)).code, 0);
    for (const file of sessionFiles) await assert.rejects(stat(file), (error) => error?.code === "ENOENT");

    const afterLogout = await invokeInstalled(installedEntrypoint, ["whoami", "--json"], env, sandbox);
    assert.notEqual(afterLogout.code, 0);
    assert.equal(JSON.parse(afterLogout.stderr).error.code, "cuna.auth.required");
    assert.equal(authority.state.createdApiKeys, 1);
    assert.equal(authority.state.revokedApiKeys, 1);
    assert.equal(authority.state.logoutReceipts, 2);
    assert.equal(authority.state.machineDeleted, true, "machine sandbox cleanup was not verified");
    assert.equal(authority.state.agentTerminated, true, "AgentSession sandbox cleanup was not verified");
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(sandbox, { recursive: true, force: true });
  }
});

const INSTALLED_HELP_TOPICS = Object.freeze([
  "signup", "login", "logout", "whoami", "access", "capabilities",
  "machines", "machines list", "machines create", "machines start", "machines pause",
  "machines resume", "machines stop", "machines delete", "records", "authorizations",
  "account", "workspace", "usage", "api-keys", "api-keys create", "api-keys list",
  "api-keys revoke", "agent-sessions", "agent-sessions list", "agent-sessions get",
  "agent-sessions create", "agent-sessions rename", "agent-sessions terminate",
  "agent-sessions attach", "agent", "connect", "config", "doctor", "self-test",
  "version", "claude", "codex", "openclaw",
]);

const SUPPORTED_SUCCESS_TOPICS = Object.freeze([
  "signup", "login", "logout", "whoami", "access", "capabilities",
  "machines list", "machines create", "machines start", "machines pause", "machines resume", "machines stop", "machines delete",
  "records", "authorizations", "account", "workspace", "usage",
  "api-keys create", "api-keys list", "api-keys revoke",
  "agent-sessions list", "agent-sessions get", "agent-sessions create", "agent-sessions rename", "agent-sessions terminate", "agent-sessions attach",
  "agent", "connect", "config", "doctor", "self-test", "version", "claude", "codex", "openclaw",
]);
const DELIBERATE_UNSUPPORTED_TOPICS = Object.freeze([]);

const INSTALLED_FAILURE_MATRIX = Object.freeze([
  { id: "signup/usage", argv: ["signup", "extra", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "login/usage", argv: ["login", "extra", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "logout/usage", argv: ["logout", "extra", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "whoami/usage", argv: ["whoami", "extra", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "access/usage", argv: ["access", "wrong", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "capabilities/usage", argv: ["capabilities", "--scope", "wrong", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "machines/usage", argv: ["machines", "wrong", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "records/usage", argv: ["records", "wrong", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "authorizations/usage", argv: ["authorizations", "list", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "account/usage", argv: ["account", "wrong", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "workspace/usage", argv: ["workspace", "wrong", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "usage/usage", argv: ["usage", "wrong", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "api-keys/usage", argv: ["api-keys", "wrong", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "agent-sessions/usage", argv: ["agent-sessions", "wrong", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "agent/usage", argv: ["agent", "wrong", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "connect/non-tty", argv: ["connect", ID, "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "config/reserved", argv: ["config", "set", "--json"], exit: 8, code: "cuna.capability.unsupported" },
  { id: "doctor/usage", argv: ["doctor", "extra", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "self-test/usage", argv: ["self-test", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "version/usage", argv: ["version", "extra", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "claude/non-tty", argv: ["claude", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "codex/non-tty", argv: ["codex", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "openclaw/non-tty", argv: ["openclaw", "--json"], exit: 2, code: "cuna.usage.invalid" },
  { id: "sync/reserved", argv: ["sync", "--json"], exit: 8, code: "cuna.capability.unsupported" },
  { id: "shell/reserved", argv: ["shell", "--json"], exit: 8, code: "cuna.capability.unsupported" },
  { id: "companion/reserved", argv: ["companion", "--json"], exit: 8, code: "cuna.capability.unsupported" },
]);

function createContractAuthority() {
  const continuations = new Map();
  const accessContexts = new Map();
  const state = { continuationCounter: 0, tokenCounter: 0, createdApiKeys: 0, revokedApiKeys: 0, logoutReceipts: 0, idempotencyKeys: [], loginRevoked: false, machineDeleted: false, agentTerminated: false };
  const machine = (status = "running") => ({ id: ID, name: "matrix-machine", status, memory_mib: 512, vcpus: 1, url: "https://machine.invalid" });
  const agentSession = (terminated = false) => ({ id: AGENT_SESSION_ID, machine_id: ID, workspace_binding_id: WORKSPACE_BINDING_ID, workspace_generation: 1, name: "matrix-agent", agent: "codex", cwd: "/workspace", auth_mode: "interactive_login", desired_state: terminated ? "terminated" : "running", request_state: terminated ? "terminal" : "launched", process_state: terminated ? "terminated" : "running", process_epoch: PROCESS_EPOCH, runtime_observed_at: "2026-08-14T00:00:01.000Z", runtime_expires_at: "2030-08-14T00:00:01.000Z", row_version: terminated ? 1 : 0, created_at: "2026-08-14T00:00:00.000Z", updated_at: "2026-08-14T00:00:00.000Z" });
  const waitlisted = () => ({
    required_terms_version: "2026-08",
    identity: "active",
    admission: "waitlisted",
    workspace: { state: "unavailable" },
    waitlist_position: 7,
  });
  const admitted = () => ({
    required_terms_version: "2026-08",
    identity: "active",
    admission: "admitted",
    workspace: { state: "assigned", id: WORKSPACE_ID },
  });
  const issueTokens = (context, loginCodeExpiresAt) => {
    state.tokenCounter += 1;
    const access = `cuna_at_${String(state.tokenCounter).padStart(43, "a")}`;
    const now = Date.now();
    accessContexts.set(access, context);
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: 600,
      access_expires_at: new Date(now + 600_000).toISOString(),
      ...(loginCodeExpiresAt === undefined ? {} : { login_code_expires_at: loginCodeExpiresAt }),
      session_id: SESSION_ID,
      context,
    };
  };
  return {
    state,
    async assertLoginCodeNegatives(baseUrl) {
      const [id, record] = [...continuations.entries()].at(-1);
      assert.ok(id && record);
      const exchangeUrl = `${baseUrl}/v1/cli-auth/continuations/${id}/exchange`;
      const exactBody = (loginCode, codeVerifier = record.verifier) => ({
        login_code: loginCode, client_instance_id: record.clientInstanceId, profile: record.profile,
        state: record.state, code_verifier: codeVerifier, redirect_uri: record.redirectUri,
      });
      const wrong = await fetch(exchangeUrl, {
        method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": `refresh-${"w".repeat(43)}` },
        body: JSON.stringify(exactBody(`cuna_login_${"z".repeat(43)}`)),
      });
      assert.equal(wrong.status, 401, "wrong durable login code must fail");
      const expired = await fetch(exchangeUrl, {
        method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": `refresh-${"e".repeat(43)}` },
        body: JSON.stringify(exactBody(EXPIRED_LOGIN_CODE)),
      });
      assert.equal(expired.status, 401, "expired durable login code must fail");
      const reusable = await fetch(exchangeUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": `refresh-${"r".repeat(43)}` },
        body: JSON.stringify(exactBody(record.loginCode)),
      });
      assert.equal(reusable.status, 200, `durable login code must remain reusable until revoke/expiry: ${await reusable.clone().text()}`);
      assert.equal(Object.hasOwn(await reusable.json(), "login_code_expires_at"), false, "reuse must not reemit durable expiry");

      const verifier = "v".repeat(64);
      const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
      const issued = await fetch(`${baseUrl}/v1/cli-auth/continuations`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "s".repeat(43), code_challenge: challenge, redirect_uri: "http://127.0.0.1:54321/callback", client_instance_id: ID, profile: "installed-e2e", intent_class: "login" }),
      }).then((response) => response.json());
      const wrongVerifier = await fetch(`${baseUrl}/v1/cli-auth/continuations/${issued.id}/exchange`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ login_code: LOGIN_CODE_2, client_instance_id: ID, profile: "installed-e2e", state: "s".repeat(43), code_verifier: "w".repeat(64), redirect_uri: "http://127.0.0.1:54321/callback" }),
      });
      assert.equal(wrongVerifier.status, 401, "wrong PKCE verifier must fail without consuming success authority");
    },
    async handle(request, response) {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const body = await readJsonBody(request);
        const send = (status, value) => {
          const text = JSON.stringify(value);
          response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
          response.end(text);
        };
        if (request.method === "GET" && url.pathname === "/v1/cli-auth/bootstrap") {
          return send(200, { enabled: true, completion_mode: "poll", pkce_method: "S256", continuation_ttl_seconds: 600, poll_after_ms: 2000, poll_limit: 3, access_token_ttl_seconds: 600, refresh_family_ttl_seconds: 2592000, browser_origin: "https://app.getcuna.com" });
        }
        if (request.method === "GET" && url.pathname === "/v1/cli-auth/signup-capability") {
          return send(200, { enabled: true, enrollment: "waitlist_only", identity_methods: ["email_password", "oauth"] });
        }
        if (request.method === "POST" && url.pathname === "/v1/cli-auth/continuations") {
          state.continuationCounter += 1;
          const id = ID.slice(0, -1) + String(state.continuationCounter);
          const secret = `cuna_ct_${"c".repeat(42)}${state.continuationCounter}`;
          const expiresAt = new Date(Date.now() + 600_000).toISOString();
          const context = body.intent_class === "signup" ? waitlisted() : admitted();
          const loginCode = state.continuationCounter === 1 ? LOGIN_CODE : LOGIN_CODE_2;
          continuations.set(id, { secret, state: body.state, challenge: body.code_challenge, redirectUri: body.redirect_uri, clientInstanceId: body.client_instance_id, profile: body.profile, expiresAt, loginCodeExpiresAt: new Date(Date.now() + 2_592_000_000).toISOString(), context, loginCode, exchangeCount: 0 });
          return send(201, { id, continuation_secret: secret, browser_url: `https://app.getcuna.com/cli/continue#continuation=${id}&nonce=cuna_cb_${"n".repeat(43)}&state=${body.state}`, expires_at: expiresAt, poll_after_ms: 2000, completion_mode: "poll" });
        }
        const continuation = /^\/v1\/cli-auth\/continuations\/([^/]+)(\/exchange)?$/u.exec(url.pathname);
        if (continuation !== null) {
          const record = continuations.get(continuation[1]);
          if (record === undefined) return send(404, { error: "not_found" });
          const continuationHeader = request.headers["x-cuna-continuation"];
          if (request.method === "GET" && continuation[2] === undefined) {
            if (continuationHeader !== record.secret) return send(401, { error: "continuation_rejected" });
            return send(200, { id: continuation[1], phase: "completed", expires_at: record.expiresAt, context: record.context, required_terms_version: "2026-08" });
          }
          if (request.method === "POST" && continuation[2] === "/exchange") {
            if (body.login_code === EXPIRED_LOGIN_CODE) return send(401, { error: "cli_login_code_expired" });
            if (record.exchangeCount > 0 && state.loginRevoked) return send(401, { error: "cli_auth_rejected" });
            if (record.exchangeCount > 0) assert.match(request.headers["idempotency-key"] ?? "", /^refresh-[A-Za-z0-9_-]{43}$/u);
            if (body.state !== record.state || body.redirect_uri !== record.redirectUri || body.client_instance_id !== record.clientInstanceId || body.profile !== record.profile ||
                !/^[A-Za-z0-9_-]{43,128}$/u.test(body.code_verifier) ||
                createHash("sha256").update(body.code_verifier, "ascii").digest("base64url") !== record.challenge ||
                body.login_code !== record.loginCode) return send(401, { error: "login_code_binding_rejected" });
            record.verifier = body.code_verifier;
            state.loginRevoked = false;
            const initial = record.exchangeCount === 0;
            record.exchangeCount += 1;
            return send(200, issueTokens(record.context, initial ? record.loginCodeExpiresAt : undefined));
          }
        }
        const authorization = request.headers.authorization?.replace(/^Bearer /u, "");
        if (request.method === "GET" && url.pathname === "/v1/cli-auth/context") return send(200, accessContexts.get(authorization));
        if (request.method === "POST" && url.pathname === "/v1/cli-auth/logout") { state.logoutReceipts += 1; state.loginRevoked = true; return send(200, { revoked: true }); }
        if (request.method === "GET" && url.pathname === "/v1/capabilities") {
          const now = Date.now();
          const scope = url.searchParams.get("scope") ?? "account";
          const resourceId = url.searchParams.get("resource_id");
          return send(200, { schema_version: "1.0", subject_scope: scope, ...(resourceId === null ? {} : { subject_id: resourceId }), observed_at: new Date(now - 100).toISOString(), expires_at: new Date(now + 30_000).toISOString(), etag: "installed-e2e", capabilities: [
            { id: "api_keys.manage", availability: "supported", interaction: "native", mutation_class: "secret_revealing", surfaces: ["cli"], required_permissions: ["api_keys:manage", "auth:interactive"] },
            { id: "records.list", availability: "supported", interaction: "read_only", mutation_class: "none", surfaces: ["cli"], required_permissions: ["records:read"] },
            { id: "authorizations.list", availability: "supported", interaction: "read_only", mutation_class: "none", surfaces: ["cli"], required_permissions: ["authorizations:read"] },
            { id: "machines.create", availability: "supported", interaction: "native", mutation_class: "reversible", surfaces: ["cli"], required_permissions: ["machines:write"] },
            { id: "machines.lifecycle", availability: "supported", interaction: "native", mutation_class: "reversible", surfaces: ["cli"], required_permissions: ["machines:write"] },
            { id: "machines.delete", availability: "supported", interaction: "native", mutation_class: "destructive", surfaces: ["cli"], required_permissions: ["machines:write"] },
            { id: "agent_sessions.create", availability: "supported", interaction: "native", mutation_class: "reversible", surfaces: ["cli"], required_permissions: ["agent_sessions:write"] },
            { id: "agent_sessions.terminate", availability: "supported", interaction: "native", mutation_class: "destructive", surfaces: ["cli"], required_permissions: ["agent_sessions:write"] },
            { id: "agent_sessions.rename", availability: "supported", interaction: "native", mutation_class: "reversible", surfaces: ["cli"], required_permissions: ["agent_sessions:write"] },
            { id: "agent_sessions.auth_logout", availability: "supported", interaction: "native", mutation_class: "reversible", surfaces: ["cli"], required_permissions: ["agent_sessions:write"] },
          ] });
        }
        if (request.method === "GET" && url.pathname === "/v1/me") return send(200, { id: ID, email: "installed@example.test", workspace: { assigned: true, id: WORKSPACE_ID, usage: { est_spend_usd: 1, est_remaining_usd: 49, note: "contract fixture" } } });
        if (request.method === "GET" && url.pathname === "/v1/sessions") return send(200, state.machineDeleted ? [] : [machine()]);
        if (request.method === "POST" && url.pathname === "/v1/sessions") { state.machineDeleted = false; return send(201, machine("created")); }
        if (request.method === "POST" && url.pathname === `/v1/sessions/${ID}/start`) return send(200, machine("running"));
        if (request.method === "POST" && url.pathname === `/v1/sessions/${ID}/pause`) return send(200, machine("paused"));
        if (request.method === "POST" && url.pathname === `/v1/sessions/${ID}/resume`) return send(200, machine("running"));
        if (request.method === "POST" && url.pathname === `/v1/sessions/${ID}/stop`) return send(200, machine("stopped"));
        if (request.method === "DELETE" && url.pathname === `/v1/sessions/${ID}`) { state.machineDeleted = true; return send(202, { acknowledged: true }); }
        if (request.method === "GET" && url.pathname === "/v1/records") return send(200, []);
        if (request.method === "GET" && url.pathname === `/v1/sessions/${ID}/authorizations`) return send(200, []);
        if (request.method === "POST" && url.pathname === `/v1/sessions/${ID}/agent-sessions`) { state.agentTerminated = false; return send(201, agentSession()); }
        if (request.method === "GET" && url.pathname === `/v1/sessions/${ID}/agent-sessions`) return send(200, { items: state.agentTerminated ? [] : [agentSession()] });
        if (request.method === "GET" && url.pathname === `/v1/agent-sessions/${AGENT_SESSION_ID}`) return send(200, agentSession(state.agentTerminated));
        if (request.method === "PATCH" && url.pathname === `/v1/agent-sessions/${AGENT_SESSION_ID}`) return send(200, { ...agentSession(), name: body.name, row_version: 1 });
        if (request.method === "POST" && url.pathname === `/v1/agent-sessions/${AGENT_SESSION_ID}/terminate`) { state.agentTerminated = true; return send(200, agentSession(true)); }
        if (request.method === "POST" && url.pathname === `/v1/agent-sessions/${AGENT_SESSION_ID}/agent-auth/logout`) return send(200, { observation_id: "80000000-0000-4000-8000-000000000008", agent_session_id: AGENT_SESSION_ID, process_epoch: PROCESS_EPOCH, auth_mode: "interactive_login", agent: "codex", agent_version: "1.0.0", adapter_version: "runa.agent-auth.v1", observed_at: "2026-08-14T00:00:02.000Z", outcome: "logout_confirmed" });
        if (request.method === "POST" && url.pathname === "/v1/api-keys") {
          assert.match(request.headers["idempotency-key"] ?? "", /^cuna-api-key-create-[0-9a-f-]{36}$/u);
          state.idempotencyKeys.push(request.headers["idempotency-key"]);
          state.createdApiKeys += 1;
          return send(201, { id: API_KEY_ID, name: body.name, prefix: "cuna_sk_", last_four: "WXYZ", created_at: new Date().toISOString(), expires_at: null, last_used_at: null, revoked_at: null, idempotency_replayed: false, key: `cuna_sk_${"k".repeat(16)}WXYZ` });
        }
        if (request.method === "GET" && url.pathname === "/v1/api-keys") {
          return send(200, [{ id: API_KEY_ID, name: "installed e2e", prefix: "cuna_sk_", last_four: "WXYZ", created_at: new Date().toISOString(), expires_at: null, last_used_at: null, revoked_at: null }]);
        }
        if (request.method === "DELETE" && url.pathname === `/v1/api-keys/${API_KEY_ID}`) { state.revokedApiKeys += 1; return send(200, { ok: true }); }
        return send(404, { error: "unexpected_route" });
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "fixture_failure", message: error instanceof Error ? error.message : "unknown" }));
      }
    },
  };
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function invokeInstalledAuth(args, env, cwd, loginCode) {
  return runNode([path.join(root, "test", "fixtures", "installed-auth-driver.mjs"), ...args], {
    env: { ...env, CUNA_TEST_LOGIN_CODE: loginCode }, cwd, timeout: 30_000,
  });
}

function invokeInstalledForeground(args, env, cwd) {
  return runNode([path.join(root, "test", "fixtures", "installed-foreground-driver.mjs"), ...args], {
    env, cwd, timeout: 30_000,
  });
}

async function findSessionFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await findSessionFiles(file));
    else if (/^session-[0-9a-f]{32}\.(?:json|key)$/u.test(entry.name)) result.push(file);
  }
  return result.sort();
}

function invokeInstalled(entrypoint, args, env, cwd, terminalStderr = false, input) {
  const preload = terminalStderr
    ? ["--import", `data:text/javascript;base64,${Buffer.from('for(const stream of [process.stdin,process.stdout,process.stderr])Object.defineProperty(stream,"isTTY",{configurable:true,value:true});').toString("base64")}`]
    : [];
  return runNode([...preload, entrypoint, ...args], { env, cwd, timeout: 30_000, input });
}

function safeErrorCode(stderr) {
  const line = stderr.split(/\r?\n/u).at(-1);
  try {
    const error = JSON.parse(line).error;
    return `${error?.code ?? "unknown"}:${error?.details?.reason ?? error?.message ?? "unknown"}`;
  } catch { return "non-json"; }
}

function runNode(args, options) {
  return run(process.execPath, args, options);
}

async function runNpm(args, options) {
  const npmCommand = process.platform === "win32" ? "where.exe" : "which";
  const located = await run(npmCommand, [process.platform === "win32" ? "npm.cmd" : "npm"], { cwd: options.cwd, timeout: 10_000 });
  const npm = located.stdout.split(/\r?\n/u).map((value) => value.trim()).find(Boolean);
  assert.ok(npm);
  const npmCli = path.join(path.dirname(npm), "node_modules", "npm", "bin", "npm-cli.js");
  return run(process.execPath, [npmCli, ...args], options);
}

function run(command, args, { cwd, env = process.env, timeout, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (input !== undefined) child.stdin.end(input);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout: stdout.trim(), stderr: stderr.trim() }); });
  });
}
