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

test("abort during the open event cannot escape the handshake cancellation fence", async () => {
  const controller = new AbortController();
  class AbortAfterOpenWebSocket extends FakeWebSocket {
    dispatchEvent(event) {
      const result = super.dispatchEvent(event);
      if (event.type === "open") controller.abort();
      return result;
    }
  }
  AbortAfterOpenWebSocket.instances.length = 0;
  const connector = createNodeWebSocketConnector({ WebSocket: AbortAfterOpenWebSocket });
  await assert.rejects(
    connector.connect({ url: URL, token: TOKEN, protocol: "runa.terminal.v1", signal: controller.signal }),
    (error) => error instanceof RuntimeBoundaryError && error.code === "terminal_disconnected",
  );
  assert.equal(AbortAfterOpenWebSocket.instances[0].closeCalls.at(-1).reason, "runa_cancelled");
});

test("asynchronous Blob conversion preserves WebSocket arrival order", async () => {
  FakeWebSocket.instances.length = 0;
  const connector = createNodeWebSocketConnector({ WebSocket: FakeWebSocket });
  const connection = await connector.connect({ url: URL, token: TOKEN, protocol: "runa.terminal.v1" });
  const socket = FakeWebSocket.instances[0];
  let resolveFirst;
  let resolveSecond;
  const first = new Blob([Uint8Array.of(1)]);
  const second = new Blob([Uint8Array.of(2)]);
  Object.defineProperty(first, "arrayBuffer", { value: () => new Promise((resolve) => { resolveFirst = resolve; }) });
  Object.defineProperty(second, "arrayBuffer", { value: () => new Promise((resolve) => { resolveSecond = resolve; }) });

  socket.dispatchEvent(new MessageEvent("message", { data: first }));
  socket.dispatchEvent(new MessageEvent("message", { data: second }));
  const iterator = connection.receive()[Symbol.asyncIterator]();
  let firstSettled = false;
  const firstResult = iterator.next().then((value) => { firstSettled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolveSecond, undefined, "the second conversion cannot start before the first completes");
  assert.equal(firstSettled, false);
  resolveFirst(Uint8Array.of(1).buffer);
  const receivedFirst = await firstResult;
  await new Promise((resolve) => setImmediate(resolve));
  resolveSecond(Uint8Array.of(2).buffer);
  const receivedSecond = await iterator.next();
  assert.deepEqual([...receivedFirst.value], [1]);
  assert.deepEqual([...receivedSecond.value], [2]);
  await connection.close();
});

test("remote close drains an already-delivered asynchronous Blob before ending the receive stream", async () => {
  FakeWebSocket.instances.length = 0;
  const connector = createNodeWebSocketConnector({ WebSocket: FakeWebSocket });
  const connection = await connector.connect({ url: URL, token: TOKEN, protocol: "runa.terminal.v1" });
  const socket = FakeWebSocket.instances[0];
  let resolveBlob;
  const finalBlob = new Blob([Uint8Array.of(9)]);
  Object.defineProperty(finalBlob, "arrayBuffer", { value: () => new Promise((resolve) => { resolveBlob = resolve; }) });
  const iterator = connection.receive()[Symbol.asyncIterator]();
  socket.dispatchEvent(new MessageEvent("message", { data: finalBlob }));
  socket.dispatchEvent(new CloseEvent("close", { code: 1000, reason: "remote_complete" }));
  let settled = false;
  const finalFrame = iterator.next().then((value) => { settled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "receive remains open until the delivered Blob conversion settles");
  resolveBlob(Uint8Array.of(9).buffer);
  assert.deepEqual([...(await finalFrame).value], [9]);
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("Blob size and pending conversion count are bounded before asynchronous allocation", async () => {
  FakeWebSocket.instances.length = 0;
  const connector = createNodeWebSocketConnector({ WebSocket: FakeWebSocket });
  const oversizedConnection = await connector.connect({ url: URL, token: TOKEN, protocol: "runa.terminal.v1" });
  const oversizedSocket = FakeWebSocket.instances[0];
  let converted = false;
  const oversized = new Blob([new Uint8Array(1_048_597)]);
  Object.defineProperty(oversized, "arrayBuffer", { value: async () => { converted = true; return new ArrayBuffer(0); } });
  oversizedSocket.dispatchEvent(new MessageEvent("message", { data: oversized }));
  await assert.rejects(oversizedConnection.receive()[Symbol.asyncIterator]().next(), RuntimeBoundaryError);
  assert.equal(converted, false, "oversized Blob must be rejected before conversion allocates bytes");
  assert.equal(oversizedSocket.closeCalls.at(-1).code, 1009);

  FakeWebSocket.instances.length = 0;
  const boundedConnection = await connector.connect({ url: URL, token: TOKEN, protocol: "runa.terminal.v1" });
  const boundedSocket = FakeWebSocket.instances[0];
  for (let index = 0; index < 65; index += 1) {
    const pending = new Blob([Uint8Array.of(index)]);
    Object.defineProperty(pending, "arrayBuffer", { value: () => new Promise(() => undefined) });
    boundedSocket.dispatchEvent(new MessageEvent("message", { data: pending }));
  }
  await assert.rejects(boundedConnection.receive()[Symbol.asyncIterator]().next(), /conversion queue exceeded/u);
  assert.equal(boundedSocket.closeCalls.at(-1).code, 1009);
});

test("TC-055-16 receive overflow and stalled Blob conversion fail immediately and close the transport", async () => {
  FakeWebSocket.instances.length = 0;
  const connector = createNodeWebSocketConnector({ WebSocket: FakeWebSocket });
  const overflowed = await connector.connect({ url: URL, token: TOKEN, protocol: "runa.terminal.v1" });
  const overflowSocket = FakeWebSocket.instances[0];
  const frame = new Uint8Array(1_048_000).buffer;
  for (let index = 0; index < 17; index += 1) {
    overflowSocket.dispatchEvent(new MessageEvent("message", { data: frame }));
    await new Promise((resolve) => setImmediate(resolve));
  }
  await assert.rejects(overflowed.receive()[Symbol.asyncIterator]().next(), /receive queue exceeded/u);
  assert.equal(overflowSocket.closeCalls.at(-1).reason, "runa_binary_required");
  await assert.rejects(overflowed.send(Uint8Array.of(1)), /not open/u);

  FakeWebSocket.instances.length = 0;
  const bounded = createNodeWebSocketConnector({ WebSocket: FakeWebSocket, conversionTimeoutMs: 5 });
  const stalled = await bounded.connect({ url: URL, token: TOKEN, protocol: "runa.terminal.v1" });
  const stalledSocket = FakeWebSocket.instances[0];
  const blob = new Blob([Uint8Array.of(1)]);
  Object.defineProperty(blob, "arrayBuffer", { value: () => new Promise(() => undefined) });
  stalledSocket.dispatchEvent(new MessageEvent("message", { data: blob }));
  stalledSocket.dispatchEvent(new CloseEvent("close", { code: 1000, reason: "remote_complete" }));
  await assert.rejects(stalled.receive()[Symbol.asyncIterator]().next(), /conversion exceeded/u);
});
