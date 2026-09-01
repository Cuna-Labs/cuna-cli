import { createHash } from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";
import { DEPLOYED_WIRE_COMPATIBILITY } from "../core/deployed-wire-compatibility.js";

export const TERMINAL_PROTOCOL = DEPLOYED_WIRE_COMPATIBILITY.terminalProtocol;
export const TERMINAL_PROTOCOL_VERSION = 1 as const;
export const MAX_TERMINAL_FRAME_BYTES = 1024 * 1024;
export const MAX_TERMINAL_BUFFER_BYTES = MAX_TERMINAL_FRAME_BYTES * 2;
export const MAX_TERMINAL_QUEUED_FRAMES = 4096;
export const LOCAL_ACTION_PROTOCOL = "cuna.local-actions.v1" as const;
export const MAX_LOCAL_ACTION_CONTROL_BYTES = 64 * 1024;
export const MAX_LOCAL_STREAM_WINDOW_BYTES = 1024 * 1024;

export const TERMINAL_LOCAL_ACTION_KINDS = Object.freeze([
  "browser.open",
  "auth.device.present",
  "auth.callback.relay",
  "auth.result.observe",
  "clipboard.write",
  "port.forward",
  "file.select",
  "attachment.import",
  "artifact.save",
  "preview.open",
  "diff.open",
  "editor.open",
  "notification.show",
  "git.sign",
  "local_service.request",
  "device.select",
] as const);

export type TerminalLocalActionKind = typeof TERMINAL_LOCAL_ACTION_KINDS[number];

const HEADER_BYTES = 20;
const MAGIC = Uint8Array.of(0x52, 0x54, 0x50, 0x31); // RTP1
const CRITICAL_FLAG = 0x01;

export const TERMINAL_FRAME_TYPES = Object.freeze({
  ready: 1,
  input: 2,
  output: 3,
  resize: 4,
  signal: 5,
  heartbeat: 6,
  exit: 7,
  error: 8,
  acknowledgement: 9,
  resume: 10,
  local_action_request: 11,
  local_action_result: 12,
  local_stream_open: 13,
  local_stream_data: 14,
  local_stream_close: 15,
  local_stream_window_update: 16,
  // Server -> client: the terminal's writer seat moved (a transfer). Carries
  // the new writer epoch, who holds it, and this attachment's own access mode.
  writer_epoch: 17,
} as const);

export type TerminalFrameType = keyof typeof TERMINAL_FRAME_TYPES;
export type TerminalConnectionState = "negotiating" | "ready" | "attached" | "draining" | "interrupted" | "closed";
export type TerminalFrameDirection = "client_to_server" | "server_to_client";

export interface TerminalFrame {
  readonly type: TerminalFrameType;
  readonly critical: boolean;
  readonly sequence: bigint;
  readonly payload: Uint8Array;
}

export interface TerminalReadyPayload {
  readonly protocol: typeof TERMINAL_PROTOCOL;
  readonly machineId?: string;
  readonly machineGeneration?: string;
  readonly workspaceBindingId?: string | null;
  readonly workspaceBindingGeneration?: number | null;
  readonly agentSessionId: string;
  readonly processEpoch: string;
  readonly fencingGeneration: number;
  readonly resizeCapability: "live" | "initial_resize_only";
  // The seat this attachment was bound to, and the terminal's writer epoch at
  // that moment. "observer" reads; only the "writer" may send input.
  readonly accessMode: "writer" | "observer";
  readonly writerEpoch: number;
  readonly localActionProtocol?: TerminalLocalActionProtocolOffer;
}

export interface TerminalWriterEpochPayload {
  readonly writerEpoch: number;
  readonly writerClientInstanceId: string | null;
  readonly accessMode: "writer" | "observer";
}

export interface TerminalLocalActionProtocolOffer {
  readonly name: typeof LOCAL_ACTION_PROTOCOL;
  readonly maxRequestBytes: number;
  readonly maxResultBytes: number;
  readonly streamWindowBytes: number;
  readonly kinds: readonly TerminalLocalActionKind[];
}

export interface TerminalLocalActionProtocolAcceptance {
  readonly name: typeof LOCAL_ACTION_PROTOCOL;
  readonly acceptedKinds: readonly TerminalLocalActionKind[];
}

export interface TerminalResumePayload {
  readonly resumeHandle: string;
  readonly afterOutputSequence: string;
  readonly localActionProtocol?: TerminalLocalActionProtocolAcceptance;
}

export interface TerminalResizePayload {
  readonly columns: number;
  readonly rows: number;
}

export interface TerminalSignalPayload {
  readonly signal: "interrupt" | "suspend" | "terminate";
}

export interface TerminalExitPayload {
  readonly exitCode: number | null;
  readonly reason: "exited" | "signaled" | "terminated" | "failed";
}

export interface TerminalErrorPayload {
  readonly code: string;
  readonly retryable: boolean;
  readonly safeReason: string;
}

export interface TerminalAcknowledgementPayload {
  readonly clientSequence: string;
  readonly meaning: "durably_accepted_not_executed";
}

export type TerminalControlPayload =
  | TerminalReadyPayload
  | TerminalResizePayload
  | TerminalSignalPayload
  | TerminalExitPayload
  | TerminalErrorPayload
  | TerminalAcknowledgementPayload;

const LOCAL_ACTION_FRAME_TYPES: ReadonlySet<TerminalFrameType> = new Set([
  "local_action_request",
  "local_action_result",
  "local_stream_open",
  "local_stream_data",
  "local_stream_close",
  "local_stream_window_update",
]);

export class TerminalProtocolError extends Error {
  readonly code:
    | "invalid_magic"
    | "unsupported_version"
    | "oversize_frame"
    | "buffer_limit"
    | "queue_limit"
    | "unknown_critical_frame"
    | "malformed_frame"
    | "illegal_state"
    | "invalid_payload";

  constructor(code: TerminalProtocolError["code"], message: string) {
    super(message);
    this.name = "TerminalProtocolError";
    this.code = code;
  }
}

const TYPE_NAMES = new Map<number, TerminalFrameType>(
  Object.entries(TERMINAL_FRAME_TYPES).map(([name, code]) => [code, name as TerminalFrameType]),
);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeTerminalFrame(frame: TerminalFrame): Uint8Array {
  if (frame.sequence < 0n || frame.sequence > 0xffff_ffff_ffff_ffffn) {
    throw new TerminalProtocolError("malformed_frame", "The terminal sequence is outside uint64 bounds.");
  }
  if (frame.payload.byteLength > MAX_TERMINAL_FRAME_BYTES) {
    throw new TerminalProtocolError("oversize_frame", "The terminal payload exceeds the protocol limit.");
  }
  const bytes = new Uint8Array(HEADER_BYTES + frame.payload.byteLength);
  bytes.set(MAGIC, 0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint8(4, TERMINAL_PROTOCOL_VERSION);
  view.setUint8(5, frame.critical ? CRITICAL_FLAG : 0);
  view.setUint16(6, TERMINAL_FRAME_TYPES[frame.type], false);
  view.setBigUint64(8, frame.sequence, false);
  view.setUint32(16, frame.payload.byteLength, false);
  bytes.set(frame.payload, HEADER_BYTES);
  return bytes;
}

export function encodeTerminalControl(
  type: Exclude<TerminalFrameType, "input" | "output">,
  sequence: bigint,
  payload: TerminalControlPayload | Readonly<Record<string, unknown>>,
): Uint8Array {
  return encodeTerminalFrame({ type, sequence, critical: true, payload: encoder.encode(JSON.stringify(payload)) });
}

function parseHeader(bytes: Uint8Array): {
  readonly typeCode: number;
  readonly critical: boolean;
  readonly sequence: bigint;
  readonly payloadLength: number;
} {
  if (bytes.byteLength < HEADER_BYTES) {
    throw new TerminalProtocolError("malformed_frame", "The terminal frame header is incomplete.");
  }
  if (!MAGIC.every((value, index) => bytes[index] === value)) {
    throw new TerminalProtocolError("invalid_magic", "The terminal frame magic is invalid.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(4) !== TERMINAL_PROTOCOL_VERSION) {
    throw new TerminalProtocolError("unsupported_version", "The terminal wire version is unsupported.");
  }
  const flags = view.getUint8(5);
  if ((flags & ~CRITICAL_FLAG) !== 0) {
    throw new TerminalProtocolError("malformed_frame", "The terminal frame contains unsupported flags.");
  }
  const payloadLength = view.getUint32(16, false);
  if (payloadLength > MAX_TERMINAL_FRAME_BYTES) {
    throw new TerminalProtocolError("oversize_frame", "The terminal payload exceeds the protocol limit.");
  }
  return {
    typeCode: view.getUint16(6, false),
    critical: (flags & CRITICAL_FLAG) !== 0,
    sequence: view.getBigUint64(8, false),
    payloadLength,
  };
}

export function decodeTerminalFrame(bytes: Uint8Array): TerminalFrame | undefined {
  const header = parseHeader(bytes);
  if (bytes.byteLength !== HEADER_BYTES + header.payloadLength) {
    throw new TerminalProtocolError("malformed_frame", "The terminal frame length does not match its payload.");
  }
  const type = TYPE_NAMES.get(header.typeCode);
  if (type === undefined) {
    if (header.critical) {
      throw new TerminalProtocolError("unknown_critical_frame", "The terminal frame type is unknown and critical.");
    }
    return undefined;
  }
  return Object.freeze({
    type,
    critical: header.critical,
    sequence: header.sequence,
    payload: bytes.slice(HEADER_BYTES),
  });
}

export class TerminalFrameDecoder {
  readonly #chunks: Uint8Array[] = [];
  #headIndex = 0;
  #headOffset = 0;
  #bufferedBytes = 0;

  push(chunk: Uint8Array): readonly TerminalFrame[] {
    if (this.#bufferedBytes + chunk.byteLength > MAX_TERMINAL_BUFFER_BYTES) {
      throw new TerminalProtocolError("buffer_limit", "The terminal receive buffer limit was exceeded.");
    }
    if (chunk.byteLength > 0) {
      this.#chunks.push(chunk.slice());
      this.#bufferedBytes += chunk.byteLength;
    }
    const frames: TerminalFrame[] = [];
    while (this.#bufferedBytes >= HEADER_BYTES) {
      const header = parseHeader(this.#copy(HEADER_BYTES, false));
      const size = HEADER_BYTES + header.payloadLength;
      if (this.#bufferedBytes < size) break;
      const frame = decodeTerminalFrame(this.#copy(size, true));
      if (frame !== undefined) frames.push(frame);
      if (frames.length > MAX_TERMINAL_QUEUED_FRAMES) {
        throw new TerminalProtocolError("queue_limit", "Too many terminal frames were decoded in one batch.");
      }
    }
    return frames;
  }

  #copy(size: number, consume: boolean): Uint8Array {
    const result = new Uint8Array(size);
    let targetOffset = 0;
    let chunkIndex = this.#headIndex;
    let chunkOffset = this.#headOffset;
    while (targetOffset < size) {
      const chunk = this.#chunks[chunkIndex];
      if (chunk === undefined) {
        throw new TerminalProtocolError("malformed_frame", "The terminal receive buffer became inconsistent.");
      }
      const available = chunk.byteLength - chunkOffset;
      const length = Math.min(available, size - targetOffset);
      result.set(chunk.subarray(chunkOffset, chunkOffset + length), targetOffset);
      targetOffset += length;
      chunkOffset += length;
      if (chunkOffset === chunk.byteLength) {
        chunkIndex += 1;
        chunkOffset = 0;
      }
    }
    if (consume) {
      this.#headIndex = chunkIndex;
      this.#headOffset = chunkOffset;
      this.#bufferedBytes -= size;
      if (this.#bufferedBytes === 0) {
        this.#chunks.length = 0;
        this.#headIndex = 0;
        this.#headOffset = 0;
      } else if (this.#headIndex >= 1_024 && this.#headIndex * 2 >= this.#chunks.length) {
        this.#chunks.splice(0, this.#headIndex);
        this.#headIndex = 0;
      }
    }
    return result;
  }
}

const LEGAL_FRAMES: Readonly<
  Record<TerminalConnectionState, Readonly<Record<TerminalFrameDirection, ReadonlySet<TerminalFrameType>>>>
> = Object.freeze({
  negotiating: Object.freeze({ client_to_server: new Set<TerminalFrameType>(["heartbeat"]), server_to_client: new Set<TerminalFrameType>(["ready", "error"])}),
  ready: Object.freeze({ client_to_server: new Set<TerminalFrameType>(["resume", "heartbeat"]), server_to_client: new Set<TerminalFrameType>(["ready", "error", "heartbeat", "writer_epoch"])}),
  attached: Object.freeze({
    client_to_server: new Set<TerminalFrameType>(["input", "resize", "signal", "heartbeat", "resume"]),
    server_to_client: new Set<TerminalFrameType>(["output", "acknowledgement", "heartbeat", "exit", "error", "ready", "writer_epoch"]),
  }),
  draining: Object.freeze({ client_to_server: new Set<TerminalFrameType>(["heartbeat"]), server_to_client: new Set<TerminalFrameType>(["output", "exit", "error", "heartbeat", "writer_epoch"])}),
  interrupted: Object.freeze({ client_to_server: new Set<TerminalFrameType>(["resume"]), server_to_client: new Set<TerminalFrameType>(["ready", "error"])}),
  closed: Object.freeze({ client_to_server: new Set<TerminalFrameType>(), server_to_client: new Set<TerminalFrameType>() }),
});

export function assertTerminalFrameLegal(
  state: TerminalConnectionState,
  direction: TerminalFrameDirection,
  type: TerminalFrameType,
  localActionsNegotiated = false,
): void {
  const localActionLegal = localActionsNegotiated && state === "attached" && (
    type === "local_action_request" ? direction === "server_to_client" :
    type === "local_action_result" ||
    type === "local_stream_open" ||
    type === "local_stream_data" ||
    type === "local_stream_close" ||
    type === "local_stream_window_update"
  );
  if (!LEGAL_FRAMES[state][direction].has(type) && !localActionLegal) {
    throw new TerminalProtocolError("illegal_state", `${type} is illegal while the terminal is ${state}.`);
  }
}

export function decodeTerminalControl(frame: TerminalFrame): Readonly<Record<string, unknown>> {
  if (frame.type === "input" || frame.type === "output") {
    throw new TerminalProtocolError("invalid_payload", "Terminal byte frames are opaque and have no JSON control payload.");
  }
  if (isLocalActionFrameType(frame.type) && !frame.critical) {
    throw new TerminalProtocolError("invalid_payload", "Negotiated local action frames must be critical.");
  }
  if (
    (frame.type === "local_action_request" || frame.type === "local_action_result") &&
    frame.payload.byteLength > MAX_LOCAL_ACTION_CONTROL_BYTES
  ) throw new TerminalProtocolError("invalid_payload", "The local action control payload exceeds its negotiated bound.");
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(frame.payload));
  } catch {
    throw new TerminalProtocolError("invalid_payload", "The terminal control payload is not valid UTF-8 JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TerminalProtocolError("invalid_payload", "The terminal control payload must be an object.");
  }
  validateControlPayload(frame.type, value as Record<string, unknown>);
  return Object.freeze(value as Record<string, unknown>);
}

function validateControlPayload(type: TerminalFrameType, value: Record<string, unknown>): void {
  switch (type) {
    case "ready":
      if (
        value.protocol !== TERMINAL_PROTOCOL ||
        !isIdentifier(value.agentSessionId) ||
        !isIdentifier(value.processEpoch) ||
        !Number.isSafeInteger(value.fencingGeneration) ||
        Number(value.fencingGeneration) < 1 ||
        (value.resizeCapability !== "live" && value.resizeCapability !== "initial_resize_only") ||
        (value.accessMode !== "writer" && value.accessMode !== "observer") ||
        !isBoundedPositiveInteger(value.writerEpoch, Number.MAX_SAFE_INTEGER)
      ) throwInvalidPayload();
      assertKeys(
        value,
        ["protocol", "agentSessionId", "processEpoch", "fencingGeneration", "resizeCapability", "accessMode", "writerEpoch"],
        ["machineId", "machineGeneration", "workspaceBindingId", "workspaceBindingGeneration", "localActionProtocol"],
      );
      validateReadyIdentity(value);
      if (value.localActionProtocol !== undefined) validateLocalActionOffer(value.localActionProtocol);
      return;
    case "writer_epoch":
      if (
        !isBoundedPositiveInteger(value.writerEpoch, Number.MAX_SAFE_INTEGER) ||
        (value.writerClientInstanceId !== null && typeof value.writerClientInstanceId !== "string") ||
        (value.accessMode !== "writer" && value.accessMode !== "observer")
      ) throwInvalidPayload();
      assertKeys(value, ["writerEpoch", "writerClientInstanceId", "accessMode"]);
      return;
    case "resize":
      if (!isDimension(value.columns) || !isDimension(value.rows)) throwInvalidPayload();
      return;
    case "signal":
      if (!SIGNALS.has(String(value.signal))) throwInvalidPayload();
      return;
    case "exit":
      if ((value.exitCode !== null && !Number.isInteger(value.exitCode)) || !EXIT_REASONS.has(String(value.reason))) throwInvalidPayload();
      return;
    case "error":
      if (!isIdentifier(value.code) || typeof value.retryable !== "boolean" || !isIdentifier(value.safeReason)) throwInvalidPayload();
      return;
    case "acknowledgement":
      if (
        !/^[1-9][0-9]*$/u.test(String(value.clientSequence)) ||
        BigInt(String(value.clientSequence)) > 18_446_744_073_709_551_615n ||
        value.meaning !== "durably_accepted_not_executed"
      ) throwInvalidPayload();
      return;
    case "heartbeat":
      assertKeys(value, []);
      return;
    case "resume":
      assertKeys(value, ["resumeHandle", "afterOutputSequence"], ["localActionProtocol"]);
      if (!isIdentifier(value.resumeHandle) || !isUint64String(value.afterOutputSequence)) throwInvalidPayload();
      if (value.localActionProtocol !== undefined) validateLocalActionAcceptance(value.localActionProtocol);
      return;
    case "local_action_request":
      validateLocalActionRequestFrame(value);
      return;
    case "local_action_result":
      validateLocalActionResultFrame(value);
      return;
    case "local_stream_open":
      assertKeys(value, ["streamId", "requestId", "direction", "initialCreditBytes"]);
      if (
        !isIdentifier(value.streamId) || !isIdentifier(value.requestId) ||
        (value.direction !== "local_to_remote" && value.direction !== "remote_to_local") ||
        !isBoundedPositiveInteger(value.initialCreditBytes, MAX_LOCAL_STREAM_WINDOW_BYTES)
      ) throwInvalidPayload();
      return;
    case "local_stream_data":
      assertKeys(value, ["streamId", "offset", "bytesBase64url", "decodedLength", "chunkSha256"]);
      if (
        !isIdentifier(value.streamId) || !isUint64Number(value.offset) ||
        typeof value.bytesBase64url !== "string" || !BASE64URL.test(value.bytesBase64url) ||
        !isBoundedNonnegativeInteger(value.decodedLength, MAX_LOCAL_ACTION_CONTROL_BYTES) ||
        decodedBase64urlLength(value.bytesBase64url) !== value.decodedLength ||
        !SHA256.test(String(value.chunkSha256)) ||
        sha256Base64url(value.bytesBase64url) !== value.chunkSha256
      ) throwInvalidPayload();
      return;
    case "local_stream_close":
      assertKeys(value, ["streamId", "finalOffset", "reason"]);
      if (
        !isIdentifier(value.streamId) || !isUint64Number(value.finalOffset) ||
        !new Set(["completed", "cancelled", "failed", "expired"]).has(String(value.reason))
      ) throwInvalidPayload();
      return;
    case "local_stream_window_update":
      assertKeys(value, ["streamId", "acknowledgedOffset", "creditBytes"]);
      if (
        !isIdentifier(value.streamId) || !isUint64Number(value.acknowledgedOffset) ||
        !isBoundedPositiveInteger(value.creditBytes, MAX_LOCAL_STREAM_WINDOW_BYTES)
      ) throwInvalidPayload();
      return;
    case "input":
    case "output":
      throwInvalidPayload();
  }
}

export function isLocalActionFrameType(type: TerminalFrameType): boolean {
  return LOCAL_ACTION_FRAME_TYPES.has(type);
}

export function negotiateTerminalLocalActions(
  offer: unknown,
  implementedKinds: ReadonlySet<TerminalLocalActionKind>,
): TerminalLocalActionProtocolAcceptance | undefined {
  if (offer === undefined) return undefined;
  validateLocalActionOffer(offer);
  const acceptedKinds = (offer as TerminalLocalActionProtocolOffer).kinds.filter((kind) => implementedKinds.has(kind));
  if (acceptedKinds.length === 0) return undefined;
  return Object.freeze({ name: LOCAL_ACTION_PROTOCOL, acceptedKinds: Object.freeze(acceptedKinds) });
}

function validateLocalActionOffer(value: unknown): asserts value is TerminalLocalActionProtocolOffer {
  const offer = objectValue(value);
  assertKeys(offer, ["name", "maxRequestBytes", "maxResultBytes", "streamWindowBytes", "kinds"]);
  if (
    offer.name !== LOCAL_ACTION_PROTOCOL ||
    !isBoundedPositiveInteger(offer.maxRequestBytes, MAX_LOCAL_ACTION_CONTROL_BYTES) ||
    !isBoundedPositiveInteger(offer.maxResultBytes, MAX_LOCAL_ACTION_CONTROL_BYTES) ||
    !isBoundedPositiveInteger(offer.streamWindowBytes, MAX_LOCAL_STREAM_WINDOW_BYTES)
  ) throwInvalidPayload();
  validateKinds(offer.kinds, true);
}

function validateLocalActionAcceptance(value: unknown): asserts value is TerminalLocalActionProtocolAcceptance {
  const acceptance = objectValue(value);
  assertKeys(acceptance, ["name", "acceptedKinds"]);
  if (acceptance.name !== LOCAL_ACTION_PROTOCOL) throwInvalidPayload();
  validateKinds(acceptance.acceptedKinds, true);
}

function validateKinds(value: unknown, requireNonempty: boolean): asserts value is readonly TerminalLocalActionKind[] {
  if (!Array.isArray(value) || (requireNonempty && value.length === 0) || value.length > TERMINAL_LOCAL_ACTION_KINDS.length) throwInvalidPayload();
  const allowed = new Set<string>(TERMINAL_LOCAL_ACTION_KINDS);
  if (new Set(value).size !== value.length || value.some((kind) => typeof kind !== "string" || !allowed.has(kind))) throwInvalidPayload();
}

function validateLocalActionRequestFrame(value: Record<string, unknown>): void {
  assertKeys(value, ["request"]);
  const request = objectValue(value.request);
  assertKeys(request, ["version", "id", "identity", "provider", "kind", "arguments", "argumentsDigest", "requestedScope", "createdAt", "expiresAt", "nonce"]);
  const identity = objectValue(request.identity);
  validateLocalActionIdentity(identity);
  if (
    request.version !== 1 || !isIdentifier(request.id) ||
    !new Set(["claude-code", "codex", "opencode"]).has(String(request.provider)) ||
    !new Set<string>(TERMINAL_LOCAL_ACTION_KINDS).has(String(request.kind)) ||
    !isJsonObject(request.arguments) || !SHA256_PREFIXED.test(String(request.argumentsDigest)) ||
    !isIdentifier(request.requestedScope) || !isSafeTimestamp(request.createdAt) ||
    !isSafeTimestamp(request.expiresAt) || Number(request.expiresAt) <= Number(request.createdAt) ||
    !isIdentifier(request.nonce)
  ) throwInvalidPayload();
}

function validateLocalActionResultFrame(value: Record<string, unknown>): void {
  if (value.message === "ack") {
    assertKeys(value, ["message", "requestId", "argumentDigest"]);
    if (!isIdentifier(value.requestId) || !SHA256_PREFIXED.test(String(value.argumentDigest))) throwInvalidPayload();
    return;
  }
  assertKeys(value, ["message", "requestId", "argumentDigest", "result"]);
  if (value.message !== "outcome" || !isIdentifier(value.requestId) || !SHA256_PREFIXED.test(String(value.argumentDigest))) throwInvalidPayload();
  const result = objectValue(value.result);
  assertKeys(result, ["version", "requestId", "kind", "identity", "status", "completedAt"], ["safeData", "safeReason"]);
  validateLocalActionIdentity(objectValue(result.identity));
  if (
    result.version !== 1 || result.requestId !== value.requestId ||
    !new Set<string>(TERMINAL_LOCAL_ACTION_KINDS).has(String(result.kind)) ||
    !new Set(["succeeded", "failed", "denied", "expired", "cancelled"]).has(String(result.status)) ||
    !isSafeTimestamp(result.completedAt) ||
    (result.safeData !== undefined && !isJsonObject(result.safeData)) ||
    (result.safeReason !== undefined && !isIdentifier(result.safeReason))
  ) throwInvalidPayload();
}

function validateLocalActionIdentity(identity: Record<string, unknown>): void {
  assertKeys(identity, ["userId", "deviceId", "machineId", "workspaceBindingId", "workspaceBindingGeneration", "agentSessionId", "processEpoch", "fencingGeneration"]);
  if (
    !isIdentifier(identity.userId) || !isIdentifier(identity.deviceId) || !isIdentifier(identity.machineId) ||
    (identity.workspaceBindingId !== null && !isCanonicalUuid(identity.workspaceBindingId)) ||
    (identity.workspaceBindingGeneration !== null && !isPositiveUint64Number(identity.workspaceBindingGeneration)) ||
    (identity.workspaceBindingId === null) !== (identity.workspaceBindingGeneration === null) ||
    !isIdentifier(identity.agentSessionId) || !isIdentifier(identity.processEpoch) ||
    !isBoundedPositiveInteger(identity.fencingGeneration, Number.MAX_SAFE_INTEGER)
  ) throwInvalidPayload();
}

function validateReadyIdentity(value: Record<string, unknown>): void {
  const present = ["machineId", "machineGeneration", "workspaceBindingId", "workspaceBindingGeneration"]
    .filter((key) => key in value).length;
  if (present === 0) {
    if (value.localActionProtocol !== undefined) throwInvalidPayload();
    return;
  }
  if (
    present !== 4 ||
    !isIdentifier(value.machineId) ||
    !isIdentifier(value.machineGeneration) ||
    (value.workspaceBindingId !== null && !isCanonicalUuid(value.workspaceBindingId)) ||
    (value.workspaceBindingGeneration !== null && !isPositiveUint64Number(value.workspaceBindingGeneration)) ||
    (value.workspaceBindingId === null) !== (value.workspaceBindingGeneration === null)
  ) throwInvalidPayload();
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throwInvalidPayload();
  return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || keys.some((key) => !allowed.has(key))) throwInvalidPayload();
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const encoded = JSON.stringify(value);
    return encoded !== undefined && encoder.encode(encoded).byteLength <= MAX_LOCAL_ACTION_CONTROL_BYTES;
  } catch {
    return false;
  }
}

function isSafeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isUint64Number(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveUint64Number(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isUint64String(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+$/u.test(value) && BigInt(value) <= 0xffff_ffff_ffff_ffffn;
}

function isBoundedPositiveInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= maximum;
}

function isBoundedNonnegativeInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function decodedBase64urlLength(value: string): number {
  if (value.length === 0) return 0;
  const remainder = value.length % 4;
  if (remainder === 1) return -1;
  return Math.floor(value.length * 3 / 4);
}

function sha256Base64url(value: string): string {
  try {
    return createHash("sha256").update(Buffer.from(value, "base64url")).digest("hex");
  } catch {
    return "";
  }
}

const SIGNALS: ReadonlySet<string> = new Set(["interrupt", "suspend", "terminate"]);
const EXIT_REASONS: ReadonlySet<string> = new Set(["exited", "signaled", "terminated", "failed"]);
const BASE64URL = /^[A-Za-z0-9_-]*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SHA256_PREFIXED = /^sha256:[0-9a-f]{64}$/u;

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && !value.includes("\0");
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}

function isDimension(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 1000;
}

function throwInvalidPayload(): never {
  throw new TerminalProtocolError("invalid_payload", "The terminal control payload is malformed.");
}
