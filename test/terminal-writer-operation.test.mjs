import assert from "node:assert/strict";
import test from "node:test";
import { decodeTerminalWriterState } from "../dist/api/contracts.js";
import { createCunaApiClient } from "../dist/api/client.js";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const state = (extra = {}) => ({ agent_session_id: id(1), process_epoch: id(2), writer_epoch: 2,
  writer_client_instance_id: "client-1", transfer_pending: false, operation_id: id(3), operation_state: "committed", ...extra });
test("writer operation success has a required exact committed identity", () => {
  const result = decodeTerminalWriterState(state());
  assert.equal(result.operationId, id(3)); assert.equal(result.operationState, "committed");
  for (const bad of [state({ operation_id: "invalid" }), state({ operation_state: "cancelled" }), state({ operation_state: "admitted" }), state({ extra: 1 })]) assert.throws(() => decodeTerminalWriterState(bad));
  for (const key of ["operation_id", "operation_state"]) { const missing = state(); delete missing[key]; assert.throws(() => decodeTerminalWriterState(missing)); }
});
test("writer operation client forwards optional caller identity and rejects substitution before local success", async () => {
  const calls = []; let body = state();
  const client = createCunaApiClient({ async request(request) { calls.push(request); return body; } });
  const result = await client.transferTerminalWriter(id(1), { clientInstanceId: "client-1", expectedWriterEpoch: 1, operationId: id(3) });
  assert.equal(result.operationId, id(3));
  assert.deepEqual(calls[0].body, { client_instance_id: "client-1", expected_writer_epoch: 1, operation_id: id(3) });
  await client.transferTerminalWriter(id(1), { clientInstanceId: "client-1" }); assert.equal("operation_id" in calls[1].body, false);
  const before = calls.length;
  await assert.rejects(client.transferTerminalWriter(id(1), { clientInstanceId: "client-1", operationId: "invalid" })); assert.equal(calls.length, before);
  for (const extra of [{ operation_id: id(4) }, { agent_session_id: id(4) }, { writer_client_instance_id: "client-9" }]) {
    body = state(extra); await assert.rejects(client.transferTerminalWriter(id(1), { clientInstanceId: "client-1", operationId: id(3) }));
  }
});
