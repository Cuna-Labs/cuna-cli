import assert from "node:assert/strict";
import test from "node:test";

import { createNodeWebSocketConnector } from "../dist/runtime/node-websocket-connector.js";
import { RuntimeBoundaryError } from "../dist/runtime/errors.js";

const TERMINAL_ID = "55555555-5555-4555-8555-555555555555";
const URL = `wss://api.runacode.io/v1/terminal-connections/${TERMINAL_ID}/stream`;
const TOKEN = `runa_tc_${"A".repeat(43)}`;

class FakeWebSocket extends EventTarget {
  static OPEN = 1;
  static instances = [];
  readyState = 0;
  protocol = "";
  bufferedAmount = 0;
  binaryType = "blob";
  sent = [];
  closeCalls = [];

  static negotiatedProtocol(protocols) { return protocols[0]; }

  constructor(url, protocols) {
    super();
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.protocol = this.constructor.negotiatedProtocol(protocols);
      this.dispatchEvent(new Event("open"));
    });
  }

  send(bytes) { this.sent.push(bytes); }
  close(code, reason) {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }
}

test("Node WebSocket connector keeps the one-use token out of the URL and negotiates it only as a subprotocol field", async () => {
  FakeWebSocket.instances.length = 0;
  const connector = createNodeWebSocketConnector({ WebSocket: FakeWebSocket });
  const connection = await connector.connect({
    url: URL,
    token: TOKEN,
    protocol: "runa.terminal.v1",
  });
  const socket = FakeWebSocket.instances[0];
  assert.ok(socket);
  assert.equal(socket.url.includes(TOKEN), false);
  assert.deepEqual(socket.protocols, ["runa.terminal.v1", `runa.auth.${TOKEN}`]);
  assert.equal(connection.connectionId, TERMINAL_ID);

  const incoming = new Uint8Array([1, 2, 3, 4]);
  socket.dispatchEvent(new MessageEvent("message", { data: incoming.buffer }));
  const received = await connection.receive()[Symbol.asyncIterator]().next();
  assert.deepEqual([...received.value], [...incoming]);

  const outgoing = new Uint8Array([5, 6, 7]);
  await connection.send(outgoing);
  outgoing.fill(0);
  assert.deepEqual([...socket.sent[0]], [5, 6, 7]);
  await connection.close({ code: 1000, reason: "test_complete" });
  assert.deepEqual(socket.closeCalls, [{ code: 1000, reason: "test_complete" }]);
});

test("Node WebSocket connector fails closed on protocol mismatch, text frames, and pre-aborted dispatch", async () => {
  class WrongProtocolWebSocket extends FakeWebSocket {
    static negotiatedProtocol() { return "unexpected.protocol"; }
  }
  const mismatched = createNodeWebSocketConnector({ WebSocket: WrongProtocolWebSocket });
  await assert.rejects(
    mismatched.connect({ url: URL, token: TOKEN, protocol: "runa.terminal.v1" }),
    (error) => error instanceof RuntimeBoundaryError && error.code === "terminal_protocol_error",
  );

  FakeWebSocket.instances.length = 0;
  const connector = createNodeWebSocketConnector({ WebSocket: FakeWebSocket });
  const connection = await connector.connect({ url: URL, token: TOKEN, protocol: "runa.terminal.v1" });
  const socket = FakeWebSocket.instances[0];
  socket.dispatchEvent(new MessageEvent("message", { data: "terminal text is forbidden" }));
  await assert.rejects(
    connection.receive()[Symbol.asyncIterator]().next(),
    (error) => error instanceof RuntimeBoundaryError && error.code === "terminal_protocol_error",
  );
  assert.equal(socket.closeCalls[0].code, 1003);

  const controller = new AbortController();
  controller.abort();
  const before = FakeWebSocket.instances.length;
  await assert.rejects(
    connector.connect({
      url: URL,
      token: TOKEN,
      protocol: "runa.terminal.v1",
      signal: controller.signal,
    }),
    (error) => error instanceof RuntimeBoundaryError && error.code === "terminal_disconnected",
  );
  assert.equal(FakeWebSocket.instances.length, before);
});
