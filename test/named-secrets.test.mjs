import test from "node:test";
import assert from "node:assert/strict";
import { NamedSecretOverlay, NamedSecretInputGate } from "../dist/named-secrets/overlay.js";
import { NamedSecretRequestError } from "../dist/api/named-secrets.js";
import { createHttpTransport } from "../dist/api/http.js";
import { createCunaApiClient } from "../dist/api/client.js";
const encoder = new TextEncoder();
const id = (digit) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const context = { agent_session_id: id("1"), machine_id: id("2"), workspace_binding_id: id("3"), process_epoch: id("4"), terminal_connection_id: id("5"), connect_token: `runa_tc_${"A".repeat(43)}`, writer_epoch: 2 };
const receipt = (operation, name = "Database", workspace = id("6")) => ({ operation_id: operation, state: "committed", secret_id: id("7"), name, workspace_id: workspace, committed_at: "2026-10-12T12:00:00Z" });
async function until(predicate) { for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 1)); } assert.fail("condition did not settle"); }
function fixture(overrides = {}, options = {}) {
  const calls = { create: [], read: [] }; let current = { context, userId: id("8") }; let latest;
  const service = { async prepare() { return id("6"); }, async create(op, name, secret) { calls.create.push({ op, name, secret: secret.withBytes((bytes) => new TextDecoder().decode(bytes)), material: secret }); latest = receipt(op, name); return latest; }, async read(op) { calls.read.push(op); return latest; }, ...overrides };
  const overlay = new NamedSecretOverlay(service, () => current, () => {}, options);
  const gate = new NamedSecretInputGate(); const remote = [];
  const input = (text) => gate.process(typeof text === "string" ? encoder.encode(text) : text, () => overlay.active, () => overlay.open(), (bytes) => overlay.input(bytes), (bytes) => remote.push(...bytes));
  return { overlay, input, calls, remote, authority(next) { current = next; overlay.authorityChanged(); } };
}
test("plaintext lifetime expiry clears edit buffers and still captures late paste without dispatch", async () => {
  const f = fixture({}, { plaintextLifetimeMs: 10 }); f.input("\x11Database\tPRIVATE");
  await until(() => f.overlay.view?.feedback.includes("expired")); assert.equal(f.overlay.view.masked, ""); f.input("\x1b[200~PRIVATE_LATE\x1b[201~\r");
  assert.deepEqual(f.remote, []); assert.equal(f.calls.create.length, 0); f.overlay.dispose();
});
test("an uncooperative dispatched request has a bound, clears mutable material, and retains UNKNOWN recovery identity", async () => {
  let material;
  const f = fixture({ create(op, _name, secret) { f.calls.create.push({ op }); material = secret; return new Promise(() => {}); }, read() { throw new NamedSecretRequestError(404); } }, { requestBudgetMs: 5 });
  f.input("\x11Database\tPRIVATE\r"); await until(() => f.overlay.state === "ERROR"); assert.equal(material.disposed, true); assert.equal(f.overlay.persistence, "UNKNOWN"); assert.match(f.overlay.recoveryNotice, /secrets operation/); f.overlay.dispose();
});
test("one chord quarantines coalesced secret input, repeated Enter dispatches once, only GET confirms success", async () => {
  const f = fixture(); f.input("before\x11Database\tcanary-password\r\r\r");
  await until(() => f.overlay.state === "SUCCESS");
  assert.equal(new TextDecoder().decode(Uint8Array.from(f.remote)), "before"); assert.equal(f.calls.create.length, 1);
  assert.equal(f.calls.read.length, 1); assert.equal(f.calls.read[0], f.calls.create[0].op); assert.equal(f.calls.create[0].material.disposed, true);
  assert.doesNotMatch(JSON.stringify(f.overlay.view), /canary-password/); f.overlay.dispose();
});
test("Escape and all callback tail remain local, including a refused opener", () => {
  const f = fixture(); f.input("\x11Database\tPRIVATE\x1bPRIVATE-tail"); assert.equal(f.overlay.active, false); assert.deepEqual(f.remote, []); assert.equal(f.calls.create.length, 0);
  f.authority(undefined); f.input("\x11PRIVATE-after-refusal"); assert.deepEqual(f.remote, []);
});
test("after a bare Escape closes, a fresh callback which cannot extend paste framing resumes ordinary input", async () => {
  const f = fixture(); f.input("\x11Database\tPRIVATE"); f.input("\x1b"); await until(() => !f.overlay.active);
  f.input("SAFE_AFTER\r"); assert.equal(new TextDecoder().decode(Uint8Array.from(f.remote)), "SAFE_AFTER\r"); assert.equal(f.calls.create.length, 0); f.overlay.dispose();
});
test("a fresh UpArrow after bare Escape is reprocessed as ordinary terminal input", async () => {
  const f = fixture(); f.input("\x11Database\tPRIVATE"); f.input("\x1b"); await until(() => !f.overlay.active);
  f.input("\x1b[A"); assert.equal(new TextDecoder().decode(Uint8Array.from(f.remote)), "\x1b[A"); f.overlay.dispose();
});
test("UTF-8 split and multiline bracketed paste preserve value; pasted Enter never saves", async () => {
  const f = fixture(); f.input("\x11Database\t");
  for (const byte of encoder.encode("\x1b[200~páss🔒\nsecond\tline\x1b[201~")) f.input(Uint8Array.of(byte));
  assert.equal(f.calls.create.length, 0); assert.equal(f.overlay.view.masked, "********"); f.input("\r"); await until(() => f.overlay.state === "SUCCESS");
  assert.equal(f.calls.create[0].secret, "páss🔒\nsecond\tline"); f.overlay.dispose();
});
test("pasted unsupported C0 controls and DEL refuse the complete value without local actions or dispatch", () => {
  for (const byte of [...Array.from({ length: 32 }, (_unused, index) => index), 127].filter((value) => ![9, 10, 13].includes(value))) {
    const f = fixture(); f.input("\x11Database\t");
    f.input("\x1b[200~prefix" + String.fromCharCode(byte) + "suffix\x1b[201~");
    assert.equal(f.overlay.active, true); assert.equal(f.overlay.view.masked, "");
    f.input("\r"); assert.equal(f.calls.create.length, 0); assert.match(f.overlay.view.feedback, /control sequences are unsupported/);
    assert.deepEqual(f.remote, []); f.overlay.dispose();
  }
});
test("trusted paste framing preserves Unicode Tab CR LF bytes exactly", async () => {
  const f = fixture(); const value = "páss🔒\r\nsecond\tline"; f.input("\x11Database\t");
  f.input("\x1b[200~" + value + "\x1b[201~"); assert.equal(f.calls.create.length, 0);
  f.input("\r"); await until(() => f.overlay.state === "SUCCESS"); assert.equal(f.calls.create[0].secret, value); f.overlay.dispose();
});
test("paste END with callback tail and repeated unexpected END refuse truncation without mutation", async () => {
  for (const paste of ["\x1b[200~PRIVATE\x1b[201~\r", "\x1b[200~PRIVATE\x1b[201~TRUNCATED"]) {
    const f = fixture(); f.input("\x11Database\t"); f.input(paste); f.input("\r"); assert.equal(f.calls.create.length, 0); assert.deepEqual(f.remote, []); f.overlay.dispose();
  }
  const f = fixture(); f.input("\x11Database\t\x1b[200~PRIVATE\x1b[201~"); f.input("\x1b[201~"); f.input("\r"); assert.equal(f.calls.create.length, 0); f.overlay.dispose();
});
test("a typed name collision has explicit no-overwrite feedback without server prose", async () => {
  const f = fixture({ async create(op) { return { operation_id: op, state: "rejected", secret_id: null, name: null, workspace_id: null, committed_at: null, reason: "named_secret_name_exists" }; } });
  f.input("\x11Database\tPRIVATE\r"); await until(() => f.overlay.state === "ERROR"); assert.equal(f.overlay.persistence, "REJECTED"); assert.match(f.overlay.view.feedback, /nothing overwritten/); assert.deepEqual(f.remote, []); f.overlay.dispose();
});
test("shortcut inside fragmented remote paste never opens local overlay", () => {
  const f = fixture(); for (const byte of encoder.encode("\x1b[200~a\x11b\x1b[201~")) f.input(Uint8Array.of(byte));
  assert.equal(f.overlay.active, false); assert.equal(new TextDecoder().decode(Uint8Array.from(f.remote)), "\x1b[200~a\x11b\x1b[201~");
});
test("cancel during authority preflight dispatches nothing", async () => {
  let release; const f = fixture({ prepare: () => new Promise((resolve) => { release = resolve; }) });
  f.input("\x11Database\tPRIVATE\r"); assert.equal(f.overlay.state, "VALIDATING"); f.input("\x1b"); await until(() => !f.overlay.active); release(id("6"));
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(f.calls.create.length, 0);
});
test("lost response after commit is UNKNOWN and same operation GET eventually commits, never a second POST", async () => {
  let saved; let reads = 0;
  const f = fixture({ async create(op, name) { f.calls.create.push({ op }); saved = receipt(op, name); throw new Error("PRIVATE server diagnostic"); }, async read(op) { f.calls.read.push(op); if (++reads <= 2) throw new NamedSecretRequestError(404); return saved; } });
  f.input("\x11Database\tPRIVATE\r"); await until(() => f.overlay.persistence === "UNKNOWN" && f.overlay.state === "ERROR");
  assert.doesNotMatch(JSON.stringify(f.overlay.view), /PRIVATE/); await new Promise((resolve) => setImmediate(resolve)); f.input("\r"); await until(() => f.overlay.state === "SUCCESS");
  assert.equal(f.calls.create.length, 1); assert.equal(new Set(f.calls.read).size, 1); f.overlay.dispose();
});
test("cancel after dispatch retains operation without asserting rollback", async () => {
  let release; const f = fixture({ create(op, name) { f.calls.create.push({ op }); return new Promise((resolve) => { release = () => resolve(receipt(op, name)); }); }, async read(op) { f.calls.read.push(op); return receipt(op); } });
  f.input("\x11Database\tPRIVATE\r"); await until(() => f.overlay.state === "SUBMITTING"); f.input("\x1b"); await until(() => !f.overlay.active);
  assert.equal(f.overlay.persistence, "UNKNOWN"); release(); await new Promise((resolve) => setTimeout(resolve, 5)); f.input("\x11\r"); await until(() => f.overlay.state === "SUCCESS"); assert.equal(f.calls.create.length, 1); f.overlay.dispose();
});
test("UNKNOWN recovery retains safe operation notice through disposal and permits observer metadata readback", async () => {
  let saved;
  const f = fixture({ async create(op, name) { f.calls.create.push({ op }); saved = receipt(op, name); throw new NamedSecretRequestError(); }, async read(op) { f.calls.read.push(op); if (f.calls.read.length <= 2) throw new NamedSecretRequestError(404); return saved; } });
  f.input("\x11Database\tPRIVATE\r"); await until(() => f.overlay.state === "ERROR");
  const notice = f.overlay.recoveryNotice; assert.match(notice, /cuna secrets operation [a-f0-9-]+/); assert.doesNotMatch(notice, /PRIVATE|runa_tc/);
  f.overlay.close(); f.authority(undefined); f.input("\x11"); assert.equal(f.overlay.active, true); f.input("\r"); await until(() => f.overlay.state === "SUCCESS"); assert.equal(f.calls.create.length, 1);
  f.overlay.dispose();
});

test("observer or changed connection clears material but remains capturing until explicit close", () => {
  const f = fixture(); f.input("\x11Database\tPRIVATE"); f.authority(undefined); assert.equal(f.overlay.view.masked, ""); f.input("PRIVATE-after-loss"); assert.deepEqual(f.remote, []); assert.equal(f.calls.create.length, 0); f.overlay.dispose();
});
test("size overflow and malformed UTF-8 refuse without dispatch", async () => {
  for (const bytes of [encoder.encode("a".repeat(4097)), Uint8Array.of(0xc3)]) {
    const f = fixture(); f.input("\x11Database\t"); f.input(bytes); f.input("\r"); await new Promise((resolve) => setImmediate(resolve)); assert.equal(f.calls.create.length, 0); assert.equal(f.overlay.state, "ERROR"); f.overlay.dispose();
  }
});
test("mismatched durable workspace or secret identity never confirms success", async () => {
  const f = fixture({ async read(op) { return receipt(op, "Database", id("9")); } }); f.input("\x11Database\tPRIVATE\r"); await until(() => f.overlay.state === "ERROR"); assert.equal(f.overlay.persistence, "UNKNOWN"); f.overlay.dispose();
});
test("sensitive transport discards server prose, JSON causes and network errors and never retries POST", async () => {
  for (const status of [401, 403, 409, 429, 503, 200]) {
    let count = 0; const client = createCunaApiClient(createHttpTransport({ baseUrl: "https://api.getcuna.com", apiKey: `runa_sk_${"A".repeat(43)}`, fetch: async () => { count++; return new Response(status === 200 ? "PRIVATE malformed" : JSON.stringify({ error: "PRIVATE echoed password", password: "PRIVATE" }), { status }); } }));
    await assert.rejects(client.createNamedSecret({ operation_id: id("1"), name: "Database", password: "PRIVATE", context }), (error) => !JSON.stringify(error).includes("PRIVATE") && !String(error).includes("PRIVATE")); assert.equal(count, 1);
  }
});
