import assert from "node:assert/strict";
import test from "node:test";

import { createNodeWebSocketConnector } from "../dist/runtime/node-websocket-connector.js";
import { RuntimeBoundaryError } from "../dist/runtime/errors.js";
import { TerminalFrameDecoder, encodeTerminalFrame } from "../dist/terminal/codec.js";

const TERMINAL_ID = "55555555-5555-4555-8555-555555555555";
const URL = `wss://api.getcuna.com/v1/terminal-connections/${TERMINAL_ID}/stream`;
const TOKEN = `runa_tc_${"A".repeat(43)}`;

test("canonical view is an explicit offer while selected WebSocket protocol remains RTP1", async () => {
  const connector=createNodeWebSocketConnector({WebSocket:FakeWebSocket});
  const connection=await connector.connect({url:URL,token:TOKEN,protocol:"runa.terminal.v1",terminalViewProtocol:"cuna.terminal-view.v1"});
  try { assert.deepEqual(FakeWebSocket.instances.at(-1).protocols,["runa.terminal.v1",`runa.auth.${TOKEN}`,"cuna.terminal-view.v1"]); }
  finally {await connection.close();}
});

function closeEvent(code, reason) {
  const event = new Event("close");
  Object.defineProperties(event, {
    code: { value: code, enumerable: true },
    reason: { value: reason, enumerable: true },
  });
  return event;
}

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
    this.dispatchEvent(closeEvent(code, reason));
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
  assert.equal(AbortAfterOpenWebSocket.instances[0].closeCalls.at(-1).reason, "cuna_cancelled");
});

for (const count of [65, 4097]) for (const waiting of [false, true]) for (const coalesced of [false, true]) {
  test(`${count} synchronous binary frames preserve every byte; waiting=${waiting}; coalesced=${coalesced}`, async () => {
    const connector = createNodeWebSocketConnector({ WebSocket: FakeWebSocket });
    const connection = await connector.connect({ url: URL, token: TOKEN, protocol: "runa.terminal.v1" });
    const socket = FakeWebSocket.instances.at(-1);
    const frames = Array.from({ length: count }, (_, i) => encodeTerminalFrame({ type: "output", sequence: BigInt(i + 1), payload: Uint8Array.of(i) }));
    const bytes = Buffer.concat(frames);
    try {
      const iterator = connection.receive()[Symbol.asyncIterator]();
      const first = waiting ? iterator.next() : undefined;
      for (const frame of coalesced ? [bytes] : frames) {
        const owned = Uint8Array.from(frame);
        socket.dispatchEvent(new MessageEvent("message", { data: owned.buffer }));
      }
      const decoder = new TerminalFrameDecoder();
      const received = [];
      if (first) { const chunk = (await first).value; assert.ok(chunk.byteLength <= 16 * 1024); received.push(...decoder.push(chunk)); }
      while (received.length < frames.length) received.push(...decoder.push((await iterator.next()).value));
      assert.deepEqual(received.map(f => f.sequence), frames.map((_, i) => BigInt(i + 1)));
      assert.deepEqual(received.map(f => f.payload[0]), frames.map((_, i) => i % 256));
      assert.equal(socket.closeCalls.length, 0);
    } finally { await connection.close({ code: 1000, reason: "test_complete" }); }
  });
}

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

test("synchronous views are copied and cannot overtake an earlier Blob", async () => {
  const connection = await createNodeWebSocketConnector({ WebSocket: FakeWebSocket }).connect({ url: URL, token: TOKEN, protocol: "runa.terminal.v1" });
  const socket = FakeWebSocket.instances.at(-1);
  try {
    const iterator = connection.receive()[Symbol.asyncIterator]();
    const pending = iterator.next();
    const original = Uint8Array.of(99, 7, 98);
    socket.dispatchEvent(new MessageEvent("message", { data: original.subarray(1, 2) }));
    original.fill(0);
    assert.deepEqual([...(await pending).value], [7], "direct waiter owns a copy of the selected view bytes");
    let release;
    const blob = new Blob([Uint8Array.of(8)]);
    blob.arrayBuffer = () => new Promise(resolve => { release = resolve; });
    socket.dispatchEvent(new MessageEvent("message", { data: blob }));
    socket.dispatchEvent(new MessageEvent("message", { data: Uint8Array.of(9).buffer }));
    await new Promise(resolve => setImmediate(resolve));
    release(Uint8Array.of(8).buffer);
    const first = (await iterator.next()).value;
    const values = [...first];
    while (values.length < 2) values.push(...(await iterator.next()).value);
    assert.deepEqual(values, [8, 9]);
  } finally { await connection.close({ code: 1000, reason: "test_complete" }); }
});

test("waiting readers, queued remainder and later messages preserve byte order", async () => {
  const connection = await createNodeWebSocketConnector({ WebSocket: FakeWebSocket }).connect({ url: URL, token: TOKEN, protocol: "runa.terminal.v1" });
  const socket = FakeWebSocket.instances.at(-1);
  try {
    const iterator = connection.receive()[Symbol.asyncIterator]();
    const waiters = [iterator.next(), iterator.next()];
    const input = Uint8Array.from({ length: 40_000 }, (_, i) => i % 251);
    socket.dispatchEvent(new MessageEvent("message", { data: input.buffer }));
    socket.dispatchEvent(new MessageEvent("message", { data: Uint8Array.of(255).buffer }));
    const chunks = (await Promise.all(waiters)).map(item => item.value);
    let size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    while (size < input.byteLength + 1) { const chunk = (await iterator.next()).value; chunks.push(chunk); size += chunk.byteLength; }
    assert.ok(chunks.every(chunk => chunk.byteLength <= 16 * 1024));
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat([input, Uint8Array.of(255)]));
  } finally { await connection.close({ code: 1000, reason: "test_complete" }); }
});

for (const overflow of [false, true]) {
  test(`near-capacity queue admits whole messages or fails without partial success; overflow=${overflow}`, async () => {
    const connection = await createNodeWebSocketConnector({ WebSocket: FakeWebSocket }).connect({ url: URL, token: TOKEN, protocol: "runa.terminal.v1" });
    const socket = FakeWebSocket.instances.at(-1);
    try {
      const mib = 1024 * 1024;
      for (let i = 0; i < 15; i++) socket.dispatchEvent(new MessageEvent("message", { data: new Uint8Array(mib).buffer }));
      socket.dispatchEvent(new MessageEvent("message", { data: new Uint8Array(mib - 10).buffer }));
      socket.dispatchEvent(new MessageEvent("message", { data: new Uint8Array(overflow ? 11 : 10).fill(1).buffer }));
      const iterator = connection.receive()[Symbol.asyncIterator]();
      if (overflow) {
        await assert.rejects(iterator.next(), /receive queue exceeded/u);
        await assert.rejects(iterator.next(), /receive queue exceeded/u);
      } else {
        let total = 0; let ones = 0;
        while (total < 16 * mib) { const bytes = (await iterator.next()).value; total += bytes.length; ones += bytes.reduce((sum, b) => sum + b, 0); }
        assert.equal(total, 16 * mib); assert.equal(ones, 10); assert.equal(socket.closeCalls.length, 0);
      }
    } finally { await connection.close({ code: 1000, reason: "test_complete" }); }
  });
}

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
  socket.dispatchEvent(closeEvent(1000, "remote_complete"));
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

test("paced small replay stays lossless under a stalled consumer within the byte budget", async () => {
  // Model the boundary awaiting an output sink: transport delivery continues
  // while that consumer is blocked. Pace conversion to exclude its 64-item cap.
  const replayMessages = 1_025;
  const bytesPerMessage = 32;
  const connect = async () => {
    const connection = await createNodeWebSocketConnector({ WebSocket: FakeWebSocket })
      .connect({ url: URL, token: TOKEN, protocol: "runa.terminal.v1" });
    return { connection, socket: FakeWebSocket.instances.at(-1), iterator: connection.receive()[Symbol.asyncIterator]() };
  };
  const deliver = async (socket, bytes) => {
    socket.dispatchEvent(new MessageEvent("message", { data: bytes.buffer }));
    await new Promise((resolve) => setImmediate(resolve));
  };
  const stalled = await connect();
  for (let index = 0; index < replayMessages; index += 1) {
    await deliver(stalled.socket, new Uint8Array(bytesPerMessage));
  }
  assert.equal(replayMessages * bytesPerMessage, 32_800);
  await stalled.connection.close();
  let replayed = 0;
  for await (const bytes of stalled.iterator) {
    assert.ok(bytes.byteLength <= 16 * 1024);
    assert.ok(bytes.every((byte) => byte === 0));
    replayed += bytes.byteLength;
  }
  assert.equal(replayed, 32_800);
  assert.equal(stalled.socket.closeCalls.length, 1);

  // Negative control: the exact same message schedule is accepted when the
  // sink drains each chunk instead of waiting on a paint before consuming it.
  const draining = await connect();
  let applied = 0;
  for (let index = 0; index < replayMessages; index += 1) {
    await deliver(draining.socket, new Uint8Array(bytesPerMessage).fill(index % 256));
    const item = await draining.iterator.next();
    assert.equal(item.value[0], index % 256);
    applied += item.value.byteLength;
  }
  assert.equal(applied, 32_800);
  assert.equal(draining.socket.closeCalls.length, 0);
  await draining.connection.close();

  // Discriminating control: unchanged total bytes, one transport message.
  const combined = await connect();
  await deliver(combined.socket, new Uint8Array(applied));
  await combined.connection.close();
  let combinedBytes = 0;
  for await (const bytes of combined.iterator) combinedBytes += bytes.byteLength;
  assert.equal(combinedBytes, applied);
  assert.equal(combined.socket.closeCalls.length, 1);
});

test("receive slabs preserve split headers, large payloads and interleaved control frame order", async () => {
  const connection = await createNodeWebSocketConnector({ WebSocket: FakeWebSocket })
    .connect({ url: URL, token: TOKEN, protocol: "runa.terminal.v1" });
  const socket = FakeWebSocket.instances.at(-1);
  const expected = Array.from({ length: 1_100 }, (_, index) => ({
    type: index % 11 === 0 ? "heartbeat" : "output",
    critical: true,
    sequence: BigInt(index),
    payload: index === 550 ? new Uint8Array(80_000).fill(0xff) : Uint8Array.of(index % 256),
  }));
  for (const frame of expected) {
    const wire = encodeTerminalFrame(frame);
    for (const bytes of [wire.slice(0, 7), wire.slice(7)]) {
      socket.dispatchEvent(new MessageEvent("message", { data: bytes.buffer }));
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  assert.equal(socket.closeCalls.length, 0);
  await connection.close();
  const decoder = new TerminalFrameDecoder();
  const actual = [];
  for await (const bytes of connection.receive()) actual.push(...decoder.push(bytes));
  assert.equal(actual.length, expected.length);
  actual.forEach((frame, index) => {
    assert.equal(frame.type, expected[index].type);
    assert.equal(frame.sequence, expected[index].sequence);
    assert.deepEqual(frame.payload, expected[index].payload);
  });
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
  assert.equal(overflowSocket.closeCalls.at(-1).reason, "cuna_binary_required");
  await assert.rejects(overflowed.send(Uint8Array.of(1)), /not open/u);

  FakeWebSocket.instances.length = 0;
  const bounded = createNodeWebSocketConnector({ WebSocket: FakeWebSocket, conversionTimeoutMs: 5 });
  const stalled = await bounded.connect({ url: URL, token: TOKEN, protocol: "runa.terminal.v1" });
  const stalledSocket = FakeWebSocket.instances[0];
  const blob = new Blob([Uint8Array.of(1)]);
  Object.defineProperty(blob, "arrayBuffer", { value: () => new Promise(() => undefined) });
  stalledSocket.dispatchEvent(new MessageEvent("message", { data: blob }));
  stalledSocket.dispatchEvent(closeEvent(1000, "remote_complete"));
  await assert.rejects(stalled.receive()[Symbol.asyncIterator]().next(), /conversion exceeded/u);
});
