import { TextDecoder, TextEncoder } from "node:util";

export const TERMINAL_PROTOCOL = "runa.terminal.v1" as const;
export const TERMINAL_PROTOCOL_VERSION = 1 as const;
export const MAX_TERMINAL_FRAME_BYTES = 1024 * 1024;
export const MAX_TERMINAL_BUFFER_BYTES = MAX_TERMINAL_FRAME_BYTES * 2;
export const MAX_TERMINAL_QUEUED_FRAMES = 4096;

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
  readonly agentSessionId: string;
  readonly processEpoch: string;
  readonly fencingGeneration: number;
  readonly resizeCapability: "live" | "initial_resize_only";
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
  #buffer = new Uint8Array(0);

  push(chunk: Uint8Array): readonly TerminalFrame[] {
    if (this.#buffer.byteLength + chunk.byteLength > MAX_TERMINAL_BUFFER_BYTES) {
      throw new TerminalProtocolError("buffer_limit", "The terminal receive buffer limit was exceeded.");
    }
    const joined = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    joined.set(this.#buffer);
    joined.set(chunk, this.#buffer.byteLength);
    this.#buffer = joined;
    const frames: TerminalFrame[] = [];
    while (this.#buffer.byteLength >= HEADER_BYTES) {
      const header = parseHeader(this.#buffer);
      const size = HEADER_BYTES + header.payloadLength;
      if (this.#buffer.byteLength < size) break;
      const frame = decodeTerminalFrame(this.#buffer.slice(0, size));
      this.#buffer = this.#buffer.slice(size);
      if (frame !== undefined) frames.push(frame);
      if (frames.length > MAX_TERMINAL_QUEUED_FRAMES) {
        throw new TerminalProtocolError("queue_limit", "Too many terminal frames were decoded in one batch.");
      }
    }
    return frames;
  }
}

const LEGAL_FRAMES: Readonly<
  Record<TerminalConnectionState, Readonly<Record<TerminalFrameDirection, ReadonlySet<TerminalFrameType>>>>
> = Object.freeze({
  negotiating: Object.freeze({ client_to_server: new Set<TerminalFrameType>(["heartbeat"]), server_to_client: new Set<TerminalFrameType>(["ready", "error"])}),
  ready: Object.freeze({ client_to_server: new Set<TerminalFrameType>(["resume", "heartbeat"]), server_to_client: new Set<TerminalFrameType>(["ready", "error", "heartbeat"])}),
  attached: Object.freeze({
    client_to_server: new Set<TerminalFrameType>(["input", "resize", "signal", "heartbeat", "resume"]),
    server_to_client: new Set<TerminalFrameType>(["output", "acknowledgement", "heartbeat", "exit", "error", "ready"]),
  }),
  draining: Object.freeze({ client_to_server: new Set<TerminalFrameType>(["heartbeat"]), server_to_client: new Set<TerminalFrameType>(["output", "exit", "error", "heartbeat"])}),
  interrupted: Object.freeze({ client_to_server: new Set<TerminalFrameType>(["resume"]), server_to_client: new Set<TerminalFrameType>(["ready", "error"])}),
  closed: Object.freeze({ client_to_server: new Set<TerminalFrameType>(), server_to_client: new Set<TerminalFrameType>() }),
});

export function assertTerminalFrameLegal(
  state: TerminalConnectionState,
  direction: TerminalFrameDirection,
  type: TerminalFrameType,
): void {
  if (!LEGAL_FRAMES[state][direction].has(type)) {
    throw new TerminalProtocolError("illegal_state", `${type} is illegal while the terminal is ${state}.`);
  }
}

export function decodeTerminalControl(frame: TerminalFrame): Readonly<Record<string, unknown>> {
  if (frame.type === "input" || frame.type === "output") {
    throw new TerminalProtocolError("invalid_payload", "Terminal byte frames are opaque and have no JSON control payload.");
  }
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
        (value.resizeCapability !== "live" && value.resizeCapability !== "initial_resize_only")
      ) throwInvalidPayload();
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
      if (!/^\d+$/u.test(String(value.clientSequence)) || value.meaning !== "durably_accepted_not_executed") throwInvalidPayload();
      return;
    case "heartbeat":
    case "resume":
      return;
    case "input":
    case "output":
      throwInvalidPayload();
  }
}

const SIGNALS: ReadonlySet<string> = new Set(["interrupt", "suspend", "terminate"]);
const EXIT_REASONS: ReadonlySet<string> = new Set(["exited", "signaled", "terminated", "failed"]);

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && !value.includes("\0");
}

function isDimension(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 1000;
}

function throwInvalidPayload(): never {
  throw new TerminalProtocolError("invalid_payload", "The terminal control payload is malformed.");
}
