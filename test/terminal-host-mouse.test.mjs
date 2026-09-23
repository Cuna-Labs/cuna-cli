import assert from "node:assert/strict";
import test from "node:test";

import { encodeRemoteMouse, HostMouseDecoder, wheelDirection } from "../dist/terminal/host-mouse.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const decode = (segments) => segments.map((segment) => segment.kind === "bytes"
  ? { bytes: decoder.decode(segment.bytes) } : { mouse: segment.event });

test("SGR wheel reports become mouse events and never bytes", () => {
  const segments = new HostMouseDecoder().push(encoder.encode("\u001b[<64;10;5M\u001b[<65;10;5M"));
  assert.deepEqual(decode(segments), [
    { mouse: { button: 64, column: 10, row: 5, release: false } },
    { mouse: { button: 65, column: 10, row: 5, release: false } },
  ]);
  assert.equal(wheelDirection(segments[0].event), -1);
  assert.equal(wheelDirection(segments[1].event), 1);
});

test("keys around a report keep their order and bytes", () => {
  const segments = new HostMouseDecoder().push(encoder.encode("a\u001b[<0;3;4Mb\u001b[<0;3;4m\u001b[A"));
  assert.deepEqual(decode(segments), [
    { bytes: "a" },
    { mouse: { button: 0, column: 3, row: 4, release: false } },
    { bytes: "b" },
    { mouse: { button: 0, column: 3, row: 4, release: true } },
    { bytes: "\u001b[A" },
  ]);
});

test("a lone Escape and cursor keys are never held back", () => {
  const mouse = new HostMouseDecoder();
  assert.deepEqual(decode(mouse.push(Uint8Array.of(0x1b))), [{ bytes: "\u001b" }]);
  assert.deepEqual(decode(mouse.push(encoder.encode("\u001b["))), [{ bytes: "\u001b[" }]);
  assert.deepEqual(decode(mouse.push(encoder.encode("\u001b[B"))), [{ bytes: "\u001b[B" }]);
});

test("a report split across chunks is joined; a malformed one is passed through as bytes", () => {
  const mouse = new HostMouseDecoder();
  assert.deepEqual(decode(mouse.push(encoder.encode("x\u001b[<64;1"))), [{ bytes: "x" }]);
  assert.deepEqual(decode(mouse.push(encoder.encode("2;7M"))), [{ mouse: { button: 64, column: 12, row: 7, release: false } }]);
  assert.deepEqual(decode(mouse.push(encoder.encode("\u001b[<64;;7M"))), [{ bytes: "\u001b[<64;;7M" }]);
  assert.deepEqual(decode(mouse.push(encoder.encode("\u001b[<1234567;1;1M"))), [{ bytes: "\u001b[<1234567;1;1M" }]);
});

test("a report inside bracketed paste is pasted text", () => {
  const mouse = new HostMouseDecoder();
  const pasted = "\u001b[200~see \u001b[<64;1;1M here\u001b[201~";
  assert.deepEqual(decode(mouse.push(encoder.encode(pasted))), [{ bytes: pasted }]);
  assert.deepEqual(decode(mouse.push(encoder.encode("\u001b[<64;1;1M"))), [{ mouse: { button: 64, column: 1, row: 1, release: false } }]);
});

test("forwarded reports use the remote program's encoding and coordinates", () => {
  const wheelUp = { button: 64, column: 10, row: 7, release: false };
  const at = { column: 10, row: 5 };
  assert.equal(encodeRemoteMouse(wheelUp, { tracking: "none", sgr: true }, at), undefined);
  assert.equal(decoder.decode(encodeRemoteMouse(wheelUp, { tracking: "vt200", sgr: true }, at)), "\u001b[<64;10;5M");
  assert.deepEqual([...encodeRemoteMouse(wheelUp, { tracking: "vt200", sgr: false }, at)], [0x1b, 0x5b, 0x4d, 32 + 64, 32 + 10, 32 + 5]);
  const release = { button: 0, column: 10, row: 7, release: true };
  assert.equal(decoder.decode(encodeRemoteMouse(release, { tracking: "vt200", sgr: true }, at)), "\u001b[<0;10;5m");
  assert.deepEqual([...encodeRemoteMouse(release, { tracking: "vt200", sgr: false }, at)], [0x1b, 0x5b, 0x4d, 32 + 3, 32 + 10, 32 + 5]);
  assert.equal(encodeRemoteMouse(wheelUp, { tracking: "x10", sgr: false }, at), undefined, "X10 reports presses of buttons only");
  assert.equal(encodeRemoteMouse(wheelUp, { tracking: "vt200", sgr: false }, { column: 300, row: 5 }), undefined);
});
