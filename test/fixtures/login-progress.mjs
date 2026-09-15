import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";

export const SYNTHETIC_LOGIN_CODE = `cuna_login_${"z".repeat(43)}`;
const ID = "123e4567-e89b-42d3-a456-426614174000";
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Real command/auth/transport/vault, synthetic HTTP and memory storage only. */
export async function loginFixture(
  root,
  { phase = () => {}, hold = async () => {}, rejectExchange = false } = {},
) {
  const { runCli, memoryStreams } = await import(
    pathToFileURL(path.join(root, "dist/index.js")).href
  );
  const { CredentialVault, CREDENTIAL_BACKEND_PROTOCOL } = await import(
    pathToFileURL(path.join(root, "dist/credentials/index.js")).href
  );
  const values = new Map();
  const backend = {
    backendId: "login-progress-memory",
    platform: "linux",
    async probe() {
      return {
        protocol: CREDENTIAL_BACKEND_PROTOCOL,
        backendId: this.backendId,
        platform: this.platform,
        status: "verified",
        observedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        source: "live_round_trip",
      };
    },
    async read(key) {
      return values.has(key) ? Uint8Array.from(values.get(key)) : undefined;
    },
    async replace(key, bytes) {
      values.set(key, Uint8Array.from(bytes));
    },
    async delete(key) {
      return values.delete(key) ? "deleted" : "absent";
    },
    async compareAndSwap(key, expected, bytes) {
      phase("persistence_started");
      await hold("persistence");
      const current = values.get(key);
      if (
        (current === undefined
          ? null
          : createHash("sha256").update(current).digest("hex")) !== expected
      )
        return "conflict";
      values.set(key, Uint8Array.from(bytes));
      phase("persisted");
      return "replaced";
    },
    async compareAndDelete(key, expected) {
      const current = values.get(key);
      if (current === undefined) return "absent";
      if (createHash("sha256").update(current).digest("hex") !== expected)
        return "conflict";
      values.delete(key);
      phase("cleanup_deleted");
      return "deleted";
    },
  };
  const dependencies = {
    env: {},
    platform: {
      kind:
        process.platform === "win32"
          ? "windows"
          : process.platform === "darwin"
            ? "macos"
            : "linux",
      paths: {
        configDirectory: path.join(root, "fixture-config"),
        stateDirectory: path.join(root, "fixture-state"),
        runtimeDirectory: path.join(root, "fixture-runtime"),
      },
      async readSafeConfig() {
        return { exists: false };
      },
    },
    credentialVault: new CredentialVault({ backend, platform: "linux" }),
    browser: {
      async open() {
        phase("browser_suppressed");
      },
    },
    fetch: async (url, init = {}) => {
      const route = new URL(url).pathname;
      if (route === "/v1/cli-auth/bootstrap")
        return json({
          enabled: true,
          completion_mode: "paste_login_code",
          pkce_method: "S256",
          continuation_ttl_seconds: 600,
          access_token_ttl_seconds: 600,
          browser_origin: "https://app.getcuna.com",
        });
      if (route === "/v1/cli-auth/continuations") {
        const body = JSON.parse(init.body);
        return json({
          id: ID,
          browser_url: `https://app.getcuna.com/cli/continue#continuation=${ID}&nonce=cuna_cb_${"n".repeat(43)}&state=${body.state}`,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          completion_mode: "paste_login_code",
        });
      }
      if (route.endsWith("/exchange")) {
        phase("exchange_started");
        await hold("exchange", init.signal);
        if (rejectExchange)
          return json(
            {
              type: "https://api.getcuna.com/problems/cli_auth_rejected",
              title: "Rejected",
              status: 401,
              code: "cli_auth_rejected",
              detail: "Synthetic refusal",
            },
            401,
          );
        phase("exchange_finished");
        return json({
          access_token: `cuna_at_${"a".repeat(43)}`,
          token_type: "Bearer",
          expires_in: 600,
          access_expires_at: new Date(Date.now() + 600_000).toISOString(),
          login_code_expires_at: new Date(
            Date.now() + 86_400_000,
          ).toISOString(),
          session_id: ID,
          context: {
            required_terms_version: "2026-08",
            identity: "active",
            admission: "admitted",
            workspace: {
              state: "assigned",
              id: "22222222-2222-4222-8222-222222222222",
            },
          },
        });
      }
      if (route === "/v1/cli-auth/logout") {
        phase("revoked");
        return json({ revoked: true });
      }
      throw new Error("Unexpected synthetic auth route");
    },
  };
  return { runCli, memoryStreams, dependencies, values };
}
