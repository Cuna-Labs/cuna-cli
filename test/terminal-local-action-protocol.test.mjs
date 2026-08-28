import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  LOCAL_ACTION_PROTOCOL,
  TERMINAL_FRAME_TYPES,
  TerminalProtocolError,
  assertTerminalFrameLegal,
  decodeTerminalControl,
  decodeTerminalFrame,
  encodeTerminalControl,
  encodeTerminalFrame,
  negotiateTerminalLocalActions,
} from "../dist/terminal/codec.js";

const identity = Object.freeze({
  userId: "user-1",
  deviceId: "device-1",
  machineId: "machine-1",
  workspaceBindingId: null,
  workspaceBindingGeneration: null,
  agentSessionId: "session-1",
  processEpoch: "epoch-1",
  fencingGeneration: 7,
});

test("RTP1 reserves 11-16 and negotiates only the implemented intersection", () => {
  assert.deepEqual(Object.values(TERMINAL_FRAME_TYPES).slice(-6), [11, 12, 13, 14, 15, 16]);
  const acceptance = negotiateTerminalLocalActions({
    name: LOCAL_ACTION_PROTOCOL,
    maxRequestBytes: 65_536,
    maxResultBytes: 65_536,
    streamWindowBytes: 1_048_576,
    kinds: ["browser.open", "file.select"],
  }, new Set(["browser.open"]));
  assert.deepEqual(acceptance, { name: LOCAL_ACTION_PROTOCOL, acceptedKinds: ["browser.open"] });
  assert.equal(negotiateTerminalLocalActions(undefined, new Set(["browser.open"])), undefined);
});

test("a local-action READY requires a complete canonical WorkspaceBinding identity", () => {
  const base = {
    protocol: "runa.terminal.v1",
    agentSessionId: "session-1",
    processEpoch: "epoch-1",
    fencingGeneration: 7,
    resizeCapability: "live",
    localActionProtocol: {
      name: LOCAL_ACTION_PROTOCOL,
      maxRequestBytes: 65_536,
      maxResultBytes: 65_536,
      streamWindowBytes: 1_048_576,
      kinds: ["browser.open"],
    },
  };
  const decode = (payload) => decodeTerminalControl(
    decodeTerminalFrame(encodeTerminalControl("ready", 0n, payload)),
  );
  assert.throws(() => decode(base), /malformed/u);
  assert.doesNotThrow(() => decode({
    ...base,
    machineId: "machine-1",
    machineGeneration: "42",
    workspaceBindingId: "00000000-0000-4000-8000-000000000777",
    workspaceBindingGeneration: 3,
  }));
  assert.throws(() => decode({
    ...base,
    machineId: "machine-1",
    machineGeneration: "42",
    workspaceBindingId: "not-a-uuid",
    workspaceBindingGeneration: 0,
  }), /malformed/u);
});

test("local action frames are illegal before bilateral opt-in and request direction is closed", () => {
  assert.throws(
    () => assertTerminalFrameLegal("attached", "server_to_client", "local_action_request"),
    (error) => error instanceof TerminalProtocolError && error.code === "illegal_state",
  );
  assert.doesNotThrow(() =>
    assertTerminalFrameLegal("attached", "server_to_client", "local_action_request", true));
  assert.throws(
    () => assertTerminalFrameLegal("attached", "client_to_server", "local_action_request", true),
    (error) => error instanceof TerminalProtocolError && error.code === "illegal_state",
  );
});

test("local action schemas are closed, critical, strict UTF-8, and chunk hashes bind decoded bytes", () => {
  const request = {
    version: 1,
    id: "request-1",
    identity,
    provider: "claude-code",
    kind: "browser.open",
    arguments: { url: "https://example.test" },
    argumentsDigest: `sha256:${"a".repeat(64)}`,
    requestedScope: "browser.open",
    createdAt: 1,
    expiresAt: 2,
    nonce: "nonce-1",
  };
  const valid = decodeTerminalFrame(encodeTerminalControl("local_action_request", 1n, { request }));
  assert.deepEqual(decodeTerminalControl(valid).request, request);

  const noncritical = decodeTerminalFrame(encodeTerminalFrame({
    type: "local_action_request", sequence: 1n, critical: false,
    payload: new TextEncoder().encode(JSON.stringify({ request })),
  }));
  assert.throws(() => decodeTerminalControl(noncritical), /must be critical/u);

  const unknownField = decodeTerminalFrame(encodeTerminalControl("local_action_request", 2n, {
    request: { ...request, surprise: true },
  }));
  assert.throws(() => decodeTerminalControl(unknownField), /malformed/u);

  const invalidUtf8 = decodeTerminalFrame(encodeTerminalFrame({
    type: "local_action_result", sequence: 3n, critical: true, payload: Uint8Array.of(0x7b, 0xff, 0x7d),
  }));
  assert.throws(() => decodeTerminalControl(invalidUtf8), /not valid UTF-8 JSON/u);

  const bytes = Buffer.from("chunk", "utf8");
  const streamData = {
    streamId: "stream-1",
    offset: 0,
    bytesBase64url: bytes.toString("base64url"),
    decodedLength: bytes.byteLength,
    chunkSha256: createHash("sha256").update(bytes).digest("hex"),
  };
  assert.doesNotThrow(() => decodeTerminalControl(
    decodeTerminalFrame(encodeTerminalControl("local_stream_data", 4n, streamData)),
  ));
  assert.throws(() => decodeTerminalControl(
    decodeTerminalFrame(encodeTerminalControl("local_stream_data", 5n, {
      ...streamData,
      chunkSha256: "0".repeat(64),
    })),
  ), /malformed/u);
});
