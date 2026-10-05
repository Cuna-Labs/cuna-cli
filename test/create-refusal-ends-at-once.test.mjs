import assert from "node:assert/strict";
import test from "node:test";

import { createCunaApiClient, createHttpTransport, EXIT_CODES } from "../dist/index.js";
import { createPublishedProviderSessionV2 } from "../dist/journey/remote-workspace.js";

/*
 * The fast refusal the supervisor-lockout lane is adding server-side
 * (infra 66d44a2 on fix/supervisor-lockout-20260929, a local candidate, NOT
 * deployed, and its shape may change in review): a create on a running
 * Machine whose supervisor control is expired, revoked or absent answers 409
 * with one of three Problem codes, `retryable: false`, and the expiry instant
 * only inside `detail` prose. There is no `details` object and no timestamp
 * field to read.
 *
 * Nothing in the CLI is keyed on those codes. This guard pins the generic
 * path they travel, so the refusal ends the launch on the first POST and
 * shows the server's own title and detail: no install wait, no unknown-outcome
 * replay, no readiness wait. Boundary modelled: the real HTTP transport and
 * `createPublishedProviderSessionV2` over a fake `fetch`; the Problem bodies
 * are the lane's stated shape, not an observed response.
 */

const uuid = (n) => `${n}0000000-0000-4000-8000-000000000001`;
const MACHINE_ID = uuid(1);

for (const [code, title, action] of [
  ["machine_supervisor_control_expired", "Machine supervisor locked out", "contact_support"],
  ["machine_supervisor_control_revoked", "Machine supervisor revoked", "none"],
  ["machine_supervisor_control_absent", "Machine supervisor not enrolled", "none"],
]) {
  test(`a create refused with ${code} ends at the first POST with the server's words`, async () => {
    const detail = `This Machine's supervisor cannot take work (${code}).`;
    const posts = [];
    const client = createCunaApiClient(createHttpTransport({
      baseUrl: "https://api.getcuna.com",
      apiKey: "cuna_sk_abcdefghijklmnop",
      fetch: async (url, init) => {
        posts.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
        return new Response(JSON.stringify({
          type: `https://api.getcuna.com/problems/${code}`, title, status: 409, code, detail, retryable: false, action,
          request_id: "99999999-9999-4999-8999-999999999999",
        }), { status: 409, headers: { "content-type": "application/problem+json" } });
      },
    }));
    await assert.rejects(createPublishedProviderSessionV2({
      client, machineId: MACHINE_ID, agent: "opencode",
      preset: { kind: "provider_preset", agent: "opencode", label: "OpenCode Zen", profile_id: uuid(7), profile_revision: 1 },
      operationId: uuid(6), executionWorkspaceId: uuid(3), generation: 1, cwd: `/workspace/workspaces/${uuid(3)}`,
      signal: new AbortController().signal,
      now: () => 0,
      sleep: async () => assert.fail("a final refusal is never waited on"),
    }), (error) => {
      assert.equal(error.code, "cuna.remote.conflict");
      assert.equal(error.exitCode, EXIT_CODES.conflict);
      assert.equal(error.retryable, false);
      assert.equal(error.message, title);
      assert.equal(error.hint, detail);
      assert.equal(error.details.reason, code);
      return true;
    });
    assert.deepEqual(posts, [`POST /v1/collaboration/2/sessions/${MACHINE_ID}/workspace-agent-sessions`]);
  });
}
