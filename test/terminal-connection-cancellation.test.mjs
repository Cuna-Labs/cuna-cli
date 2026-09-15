import assert from "node:assert/strict";
import test from "node:test";
import { createCunaApiClient } from "../dist/api/client.js";
import { decodeTerminalConnectionCancellation, TERMINAL_PROTOCOL } from "../dist/api/contracts.js";
import { createApiTerminalControlPlane } from "../dist/runtime/api-terminal-control-plane.js";

test("issuance recovery forwards the original scope, key, and body without a new capability dependency", async () => {
  const calls = [];
  const client = createCunaApiClient({ async request(request) { calls.push(request); return { cancelled: true }; } });
  const control = createApiTerminalControlPlane({ client: { ...client, discoverCapabilities: async () => { throw new Error("capability read must not block recovery"); } } });
  const subject = "11111111-1111-4111-8111-111111111111";
  const request = { agentSessionId: subject, protocol: TERMINAL_PROTOCOL, clientInstanceId: "owned-client", idempotencyKey: "owned-terminal-issuance-key", accessMode: "observer", resumeHandle: "22222222-2222-4222-8222-222222222222", expectedWriterEpoch: 7,
    capabilityEvidence: { scope: "agent_session", subjectId: subject, expiresAt: 0 } };
  assert.deepEqual(await control.cancelTerminalConnection(request), { cancelled: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, `/v1/agent-sessions/${subject}/terminal-connections/cancel`);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].idempotencyKey, request.idempotencyKey);
  assert.deepEqual(calls[0].body, { protocol: TERMINAL_PROTOCOL, client_instance_id: "owned-client", access_mode: "observer", resume_handle: request.resumeHandle, expected_writer_epoch: 7 });
  for (const value of [{}, { cancelled: false }, { cancelled: true, extra: 1 }, null]) assert.throws(() => decodeTerminalConnectionCancellation(value));
});
