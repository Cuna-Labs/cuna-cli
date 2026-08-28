import { randomBytes, randomUUID } from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";

export type BrowserActionProvider = "claude-code" | "codex";
export type BrowserActionState =
  | "detected"
  | "pending_permission"
  | "approved"
  | "opening"
  | "awaiting_callback"
  | "completed"
  | "denied"
  | "expired"
  | "failed";

export interface LocalBrowserActionRequest {
  readonly id: string;
  readonly type: "browser.open";
  readonly provider: BrowserActionProvider;
  readonly agentSessionId: string;
  readonly processEpoch: string;
  readonly fencingGeneration: number;
  readonly url: string;
  readonly origin: string;
  readonly nonce: string;
  readonly detectedAt: number;
  readonly expiresAt: number;
  readonly state: "pending_permission";
}

export interface BrowserActionDetectorOptions {
  readonly provider: BrowserActionProvider;
  readonly agentSessionId: string;
  readonly processEpoch: string;
  readonly fencingGeneration: number;
  readonly clock?: () => number;
  readonly id?: () => string;
  readonly nonce?: () => string;
  readonly ttlMs?: number;
}

const MAX_BUFFER_CHARACTERS = 16_384;
const MAX_URL_CHARACTERS = 8_192;
const MAX_GUARDED_PASTE_BYTES = 1_048_576;
const DEFAULT_TTL_MS = 2 * 60_000;
const URL_CANDIDATE = /https:\/\/[^\s\p{Cc}<>"']{1,8192}(?=[\s\p{Cc}<>"']|$)/gu;
const BRACKETED_PASTE_START = Uint8Array.of(0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e);
const BRACKETED_PASTE_END = Uint8Array.of(0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e);

export interface ProviderOAuthPasteGuardResult {
  /** Bytes which must be forwarded in order. Blocked paste bytes are omitted. */
  readonly forward: readonly Uint8Array[];
  /** True when this push completed and suppressed an admitted provider URL paste. */
  readonly blocked: boolean;
}

/**
 * A byte-preserving guard for the provider's hidden authorization-code prompt.
 *
 * It buffers only a complete bracketed paste, so a URL split across stdin
 * chunks cannot leak partially before it is classified. Opaque input is
 * returned byte-for-byte (including its bracketed-paste markers). The result
 * deliberately carries no rejected value, URL, or diagnostic text.
 */
export class ProviderOAuthPasteGuard {
  readonly #provider: BrowserActionProvider;
  readonly #requestUrl: string;
  readonly #requestUrlBytes: Uint8Array;
  #startPrefix: number[] = [];
  #pasteBytes: number[] | undefined;
  #endMatch = 0;
  #disabled = false;
  #captureCodes = false;

  constructor(request: LocalBrowserActionRequest) {
    const admitted = admitProviderAuthUrl(request.provider, request.url);
    if (
      request.type !== "browser.open" ||
      request.state !== "pending_permission" ||
      !identifier(request.agentSessionId) ||
      !identifier(request.processEpoch) ||
      !Number.isSafeInteger(request.fencingGeneration) ||
      request.fencingGeneration < 1 ||
      admitted?.href !== request.url
    ) {
      throw new TypeError("OAuth paste guard requires an exact admitted browser request binding.");
    }
    this.#provider = request.provider;
    this.#requestUrl = request.url;
    this.#requestUrlBytes = new TextEncoder().encode(request.url);
  }

  push(bytes: Uint8Array): ProviderOAuthPasteGuardResult {
    if (bytes.byteLength === 0) return pasteGuardResult([], false);
    if (this.#disabled) return pasteGuardResult([bytes], false);

    const forward: Uint8Array[] = [];
    let output: number[] = [];
    let blocked = false;
    const flushOutput = (): void => {
      if (output.length === 0) return;
      forward.push(Uint8Array.from(output));
      output = [];
    };

    for (const byte of bytes) {
      if (this.#disabled) {
        output.push(byte);
        continue;
      }
      if (this.#pasteBytes !== undefined) {
        if (this.#pasteBytes.length >= MAX_GUARDED_PASTE_BYTES) {
          flushOutput();
          forward.push(Uint8Array.from(this.#pasteBytes));
          this.#pasteBytes = undefined;
          this.#endMatch = 0;
          this.#disabled = true;
          output.push(byte);
          continue;
        }
        this.#pasteBytes.push(byte);
        this.#endMatch = advanceMarkerMatch(BRACKETED_PASTE_END, this.#endMatch, byte);
        if (this.#endMatch === BRACKETED_PASTE_END.byteLength) {
          const paste = Uint8Array.from(this.#pasteBytes);
          this.#pasteBytes = undefined;
          this.#endMatch = 0;
          if (this.#isProviderUrlPaste(paste)) {
            blocked = true;
          } else if (this.#captureCodes) {
            flushOutput();
            forward.push(capturedCodeBytes(paste));
          } else {
            flushOutput();
            forward.push(paste);
          }
        }
        continue;
      }

      if (this.#startPrefix.length === 0) {
        if (byte === BRACKETED_PASTE_START[0]) this.#startPrefix.push(byte);
        else output.push(byte);
        continue;
      }

      const expected = BRACKETED_PASTE_START[this.#startPrefix.length];
      if (byte === expected) {
        this.#startPrefix.push(byte);
        if (this.#startPrefix.length === BRACKETED_PASTE_START.byteLength) {
          flushOutput();
          this.#pasteBytes = this.#startPrefix;
          this.#startPrefix = [];
          this.#endMatch = 0;
        }
        continue;
      }

      output.push(...this.#startPrefix);
      this.#startPrefix = [];
      if (byte === BRACKETED_PASTE_START[0]) this.#startPrefix.push(byte);
      else output.push(byte);
    }

    flushOutput();
    return pasteGuardResult(forward, blocked);
  }

  /** Drop any partial paste when its exact terminal binding is no longer valid. */
  reset(): void {
    this.#startPrefix = [];
    this.#pasteBytes = undefined;
    this.#endMatch = 0;
    this.#disabled = false;
  }

  /** Commit a complete pasted provider code as opaque bytes plus exactly one CR. */
  beginCodeCapture(): void {
    this.#captureCodes = true;
  }

  #isProviderUrlPaste(paste: Uint8Array): boolean {
    let start = BRACKETED_PASTE_START.byteLength;
    let end = paste.byteLength - BRACKETED_PASTE_END.byteLength;
    while (start < end && (paste[start] === 0x0a || paste[start] === 0x0d)) start += 1;
    while (end > start && (paste[end - 1] === 0x0a || paste[end - 1] === 0x0d)) end -= 1;
    const candidate = paste.subarray(start, end);
    if (bytesEqual(candidate, this.#requestUrlBytes)) return true;
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(candidate); } catch { return false; }
    if (text === this.#requestUrl) return true;
    return admitProviderAuthUrl(this.#provider, text) !== undefined;
  }
}

function capturedCodeBytes(paste: Uint8Array): Uint8Array {
  let start = BRACKETED_PASTE_START.byteLength;
  let end = paste.byteLength - BRACKETED_PASTE_END.byteLength;
  while (start < end && (paste[start] === 0x0a || paste[start] === 0x0d)) start += 1;
  while (end > start && (paste[end - 1] === 0x0a || paste[end - 1] === 0x0d)) end -= 1;
  const result = new Uint8Array(end - start + 1);
  result.set(paste.subarray(start, end));
  result[result.byteLength - 1] = 0x0d;
  return result;
}

function advanceMarkerMatch(marker: Uint8Array, current: number, byte: number): number {
  if (byte === marker[current]) return current + 1;
  return byte === marker[0] ? 1 : 0;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function pasteGuardResult(
  forward: readonly Uint8Array[],
  blocked: boolean,
): ProviderOAuthPasteGuardResult {
  return Object.freeze({ forward: Object.freeze([...forward]), blocked });
}

/**
 * Turns the provider's unavoidable PTY fallback into a typed local request.
 * Detection cannot execute anything and the full URL is never logged.
 */
export class ProviderBrowserActionDetector {
  readonly #options: Required<Pick<BrowserActionDetectorOptions, "provider" | "agentSessionId" | "processEpoch" | "fencingGeneration">> &
    Pick<BrowserActionDetectorOptions, "clock" | "id" | "nonce" | "ttlMs">;
  readonly #decoder = new TextDecoder("utf-8", { fatal: false });
  readonly #seen = new Set<string>();
  #buffer = "";

  constructor(options: BrowserActionDetectorOptions) {
    if (!identifier(options.agentSessionId) || !identifier(options.processEpoch)) {
      throw new TypeError("Browser action detection requires an exact AgentSession process binding.");
    }
    if (!Number.isSafeInteger(options.fencingGeneration) || options.fencingGeneration < 1) {
      throw new TypeError("Browser action detection requires a positive attachment generation.");
    }
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 10 * 60_000) {
      throw new RangeError("Browser action expiry must be between one second and ten minutes.");
    }
    this.#options = Object.freeze({ ...options, ttlMs });
  }

  push(bytes: Uint8Array): readonly LocalBrowserActionRequest[] {
    if (bytes.byteLength === 0) return Object.freeze([]);
    this.#buffer += this.#decoder.decode(bytes, { stream: true });
    if (this.#buffer.length > MAX_BUFFER_CHARACTERS) this.#buffer = this.#buffer.slice(-MAX_BUFFER_CHARACTERS);
    const requests: LocalBrowserActionRequest[] = [];
    for (const match of this.#buffer.matchAll(URL_CANDIDATE)) {
      const raw = match[0];
      if (raw.length > MAX_URL_CHARACTERS || this.#seen.has(raw)) continue;
      const admitted = admitProviderAuthUrl(this.#options.provider, raw);
      if (admitted === undefined) continue;
      this.#seen.add(raw);
      const detectedAt = (this.#options.clock ?? Date.now)();
      requests.push(Object.freeze({
        id: (this.#options.id ?? randomUUID)(),
        type: "browser.open",
        provider: this.#options.provider,
        agentSessionId: this.#options.agentSessionId,
        processEpoch: this.#options.processEpoch,
        fencingGeneration: this.#options.fencingGeneration,
        url: admitted.href,
        origin: admitted.origin,
        nonce: (this.#options.nonce ?? (() => randomBytes(32).toString("base64url")))(),
        detectedAt,
        expiresAt: detectedAt + (this.#options.ttlMs ?? DEFAULT_TTL_MS),
        state: "pending_permission",
      }));
    }
    if (this.#buffer.length > MAX_URL_CHARACTERS) this.#buffer = this.#buffer.slice(-MAX_URL_CHARACTERS);
    return Object.freeze(requests);
  }
}

export function admitProviderAuthUrl(provider: BrowserActionProvider, raw: string): URL | undefined {
  if (raw.length < 1 || raw.length > MAX_URL_CHARACTERS) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return undefined;
  const host = url.hostname.toLowerCase();
  if (provider === "claude-code") {
    if (!new Set(["claude.com", "platform.claude.com", "console.anthropic.com"]).has(host)) return undefined;
    if (!url.pathname.toLowerCase().endsWith("/oauth/authorize")) return undefined;
    return url;
  }
  // Browser PKCE callbacks bind to localhost inside the remote VM. Only Codex's
  // explicit headless device page is safe to open on the user's local machine.
  if (host !== "auth.openai.com" || url.pathname.replace(/\/+$/u, "") !== "/codex/device") return undefined;
  return url;
}

function identifier(value: string): boolean {
  return value.length >= 1 && value.length <= 256 && !/\p{Cc}/u.test(value);
}
