import { TextDecoder, TextEncoder } from "node:util";

export const DAEMON_PROTOCOL = "runa.daemon.v1" as const;
export const DAEMON_PROTOCOL_VERSION = 1 as const;
export const MAX_IPC_FRAME_BYTES = 1024 * 1024;
export const MAX_IPC_BUFFER_BYTES = MAX_IPC_FRAME_BYTES * 2;
export const MAX_IPC_QUEUED_FRAMES = 64;

const HEADER_BYTES = 12;
const MAGIC = Uint8Array.of(0x52, 0x49, 0x50, 0x43); // RIPC
const CRITICAL_FLAG = 0x01;

export const IPC_FRAME_TYPES = Object.freeze({
  hello: 1,
  welcome: 2,
  request: 3,
  response: 4,
  event: 5,
  cancel: 6,
  heartbeat: 7,
  error: 8,
} as const);

export type IpcFrameType = keyof typeof IPC_FRAME_TYPES;

const TYPE_NAMES = new Map<number, IpcFrameType>(
  Object.entries(IPC_FRAME_TYPES).map(([name, code]) => [code, name as IpcFrameType]),
);

export type IpcProtocolErrorCode =
  | "invalid_magic"
  | "unsupported_version"
  | "oversize_frame"
  | "buffer_limit"
  | "queue_limit"
  | "unknown_critical_frame"
  | "malformed_frame"
  | "invalid_message";

export class IpcProtocolError extends Error {
  readonly code: IpcProtocolErrorCode;

  constructor(code: IpcProtocolErrorCode, message: string) {
    super(message);
    this.name = "IpcProtocolError";
    this.code = code;
  }
}

export interface IpcFrame {
  readonly type: IpcFrameType;
  readonly critical: boolean;
  readonly payload: Uint8Array;
}

export interface DecodedIpcFrame extends IpcFrame {
  readonly wireVersion: typeof DAEMON_PROTOCOL_VERSION;
}

export interface IpcHello {
  readonly kind: "hello";
  readonly minimumVersion: number;
  readonly maximumVersion: number;
  readonly clientInstanceId: string;
}

export interface IpcWelcome {
  readonly kind: "welcome";
  readonly selectedVersion: typeof DAEMON_PROTOCOL_VERSION;
  readonly daemonInstanceId: string;
}

export interface IpcRequest {
  readonly kind: "request";
  readonly requestId: string;
  readonly operation:
    | "lease.acquire"
    | "lease.renew"
    | "lease.release"
    | "intent.record"
    | "intent.reconcile"
    | "view.open"
    | "view.select"
    | "view.close"
    | "supervisor.inspect";
  readonly body: Readonly<Record<string, unknown>>;
}

export interface IpcResponse {
  readonly kind: "response";
  readonly requestId: string;
  readonly outcome: "accepted" | "rejected" | "unknown" | "reconciling";
  readonly body?: Readonly<Record<string, unknown>>;
  readonly reason?: string;
}

export type IpcMessage = IpcHello | IpcWelcome | IpcRequest | IpcResponse;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function frameTypeCode(type: IpcFrameType): number {
  return IPC_FRAME_TYPES[type];
}

export function encodeIpcFrame(frame: IpcFrame): Uint8Array {
  if (frame.payload.byteLength > MAX_IPC_FRAME_BYTES) {
    throw new IpcProtocolError("oversize_frame", "The IPC payload exceeds the protocol limit.");
  }
  const bytes = new Uint8Array(HEADER_BYTES + frame.payload.byteLength);
  bytes.set(MAGIC, 0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint8(4, DAEMON_PROTOCOL_VERSION);
  view.setUint8(5, frame.critical ? CRITICAL_FLAG : 0);
  view.setUint16(6, frameTypeCode(frame.type), false);
  view.setUint32(8, frame.payload.byteLength, false);
  bytes.set(frame.payload, HEADER_BYTES);
  return bytes;
}

export function encodeIpcMessage(message: IpcMessage): Uint8Array {
  const type = message.kind;
  return encodeIpcFrame({ type, critical: true, payload: encoder.encode(JSON.stringify(message)) });
}

function hasMagic(bytes: Uint8Array): boolean {
  return MAGIC.every((value, index) => bytes[index] === value);
}

function parseHeader(bytes: Uint8Array): { readonly typeCode: number; readonly critical: boolean; readonly length: number } {
  if (bytes.byteLength < HEADER_BYTES) {
    throw new IpcProtocolError("malformed_frame", "The IPC frame header is incomplete.");
  }
  if (!hasMagic(bytes)) {
    throw new IpcProtocolError("invalid_magic", "The IPC frame magic is invalid.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(4) !== DAEMON_PROTOCOL_VERSION) {
    throw new IpcProtocolError("unsupported_version", "The IPC wire version is unsupported.");
  }
  const flags = view.getUint8(5);
  if ((flags & ~CRITICAL_FLAG) !== 0) {
    throw new IpcProtocolError("malformed_frame", "The IPC frame contains unsupported flags.");
  }
  const length = view.getUint32(8, false);
  if (length > MAX_IPC_FRAME_BYTES) {
    throw new IpcProtocolError("oversize_frame", "The IPC payload exceeds the protocol limit.");
  }
  return { typeCode: view.getUint16(6, false), critical: (flags & CRITICAL_FLAG) !== 0, length };
}

export function decodeIpcFrame(bytes: Uint8Array): DecodedIpcFrame | undefined {
  const header = parseHeader(bytes);
  if (bytes.byteLength !== HEADER_BYTES + header.length) {
    throw new IpcProtocolError("malformed_frame", "The IPC frame length does not match its payload.");
  }
  const type = TYPE_NAMES.get(header.typeCode);
  if (type === undefined) {
    if (header.critical) {
      throw new IpcProtocolError("unknown_critical_frame", "The IPC frame type is unknown and critical.");
    }
    return undefined;
  }
  return {
    type,
    critical: header.critical,
    payload: bytes.slice(HEADER_BYTES),
    wireVersion: DAEMON_PROTOCOL_VERSION,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/u.test(value);
}

export function decodeIpcMessage(frame: DecodedIpcFrame): IpcMessage {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(frame.payload));
  } catch {
    throw new IpcProtocolError("invalid_message", "The IPC message is not valid UTF-8 JSON.");
  }
  if (!isRecord(value) || value.kind !== frame.type) {
    throw new IpcProtocolError("invalid_message", "The IPC message kind does not match its frame type.");
  }
  switch (value.kind) {
    case "hello":
      if (
        !Number.isSafeInteger(value.minimumVersion) ||
        !Number.isSafeInteger(value.maximumVersion) ||
        !isSafeIdentifier(value.clientInstanceId)
      ) {
        throw new IpcProtocolError("invalid_message", "The IPC hello message is malformed.");
      }
      return value as unknown as IpcHello;
    case "welcome":
      if (value.selectedVersion !== DAEMON_PROTOCOL_VERSION || !isSafeIdentifier(value.daemonInstanceId)) {
        throw new IpcProtocolError("invalid_message", "The IPC welcome message is malformed.");
      }
      return value as unknown as IpcWelcome;
    case "request":
      if (!isSafeIdentifier(value.requestId) || typeof value.operation !== "string" || !isRecord(value.body)) {
        throw new IpcProtocolError("invalid_message", "The IPC request is malformed.");
      }
      if (!REQUEST_OPERATIONS.has(value.operation)) {
        throw new IpcProtocolError("invalid_message", "The IPC request operation is not allowlisted.");
      }
      return value as unknown as IpcRequest;
    case "response":
      if (!isSafeIdentifier(value.requestId) || !RESPONSE_OUTCOMES.has(String(value.outcome))) {
        throw new IpcProtocolError("invalid_message", "The IPC response is malformed.");
      }
      return value as unknown as IpcResponse;
    default:
      throw new IpcProtocolError("invalid_message", "This IPC message has no structured decoder.");
  }
}

const REQUEST_OPERATIONS: ReadonlySet<string> = new Set([
  "lease.acquire",
  "lease.renew",
  "lease.release",
  "intent.record",
  "intent.reconcile",
  "view.open",
  "view.select",
  "view.close",
  "supervisor.inspect",
]);
const RESPONSE_OUTCOMES: ReadonlySet<string> = new Set(["accepted", "rejected", "unknown", "reconciling"]);

export function negotiateDaemonProtocol(minimumVersion: number, maximumVersion: number): typeof DAEMON_PROTOCOL_VERSION {
  if (
    !Number.isSafeInteger(minimumVersion) ||
    !Number.isSafeInteger(maximumVersion) ||
    minimumVersion > maximumVersion ||
    minimumVersion > DAEMON_PROTOCOL_VERSION ||
    maximumVersion < DAEMON_PROTOCOL_VERSION
  ) {
    throw new IpcProtocolError("unsupported_version", "No compatible daemon IPC protocol version exists.");
  }
  return DAEMON_PROTOCOL_VERSION;
}

export class IpcFrameDecoder {
  #buffer = new Uint8Array(0);

  push(chunk: Uint8Array): readonly DecodedIpcFrame[] {
    if (chunk.byteLength + this.#buffer.byteLength > MAX_IPC_BUFFER_BYTES) {
      throw new IpcProtocolError("buffer_limit", "The IPC receive buffer limit was exceeded.");
    }
    const joined = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    joined.set(this.#buffer, 0);
    joined.set(chunk, this.#buffer.byteLength);
    this.#buffer = joined;

    const frames: DecodedIpcFrame[] = [];
    while (this.#buffer.byteLength >= HEADER_BYTES) {
      const header = parseHeader(this.#buffer);
      const frameLength = HEADER_BYTES + header.length;
      if (this.#buffer.byteLength < frameLength) break;
      const decoded = decodeIpcFrame(this.#buffer.slice(0, frameLength));
      this.#buffer = this.#buffer.slice(frameLength);
      if (decoded !== undefined) frames.push(decoded);
      if (frames.length > MAX_IPC_QUEUED_FRAMES) {
        throw new IpcProtocolError("queue_limit", "Too many IPC frames were decoded in one batch.");
      }
    }
    return frames;
  }

  get bufferedBytes(): number {
    return this.#buffer.byteLength;
  }
}
