/**
 * Mouse reports from the host terminal, and the reports forwarded to a remote
 * program that asked for them.
 *
 * WHY THE HOST REPORTS THE MOUSE AT ALL. Rich mode draws the remote screen in
 * the host's alternate screen. There, a host with no mouse reporting turns
 * the wheel into cursor keys: Windows Terminal starts with alternate-scroll
 * mode set (`_inputMode{ Ansi, AutoRepeat, AlternateScroll }`,
 * microsoft/terminal src/terminal/input/terminalInput.hpp @ fbda436d) and
 * `_makeAlternateScrollOutput` sends VK_UP/VK_DOWN for every wheel notch. Those
 * were indistinguishable from real arrow keys and reached the agent as prompt
 * history (owner report, 2026-09-23). With button reporting (1000) in SGR form
 * (1006) the wheel arrives as `ESC [ < 64/65 ; x ; y M` instead, and Cuna
 * decides what it means. Text selection moves to Shift+drag, which Windows
 * Terminal, xterm and VTE all reserve for the local selection while an
 * application reports the mouse.
 */

export interface HostMouseEvent {
  /** The SGR button code, modifiers included (shift 4, meta 8, control 16, motion 32). */
  readonly button: number;
  /** 1-based host column and row. */
  readonly column: number;
  readonly row: number;
  readonly release: boolean;
}

export type HostInputSegment =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "mouse"; readonly event: HostMouseEvent };

const ESC = 0x1b;
const PASTE_START = [ESC, 0x5b, 0x32, 0x30, 0x30, 0x7e]; // ESC [ 2 0 0 ~
const PASTE_END = [ESC, 0x5b, 0x32, 0x30, 0x31, 0x7e]; // ESC [ 2 0 1 ~
/** `ESC [ < 65535 ; 65535 ; 65535 M` is 21 bytes; anything longer is not a report. */
const MAX_REPORT_BYTES = 24;
const MODIFIER_BITS = 4 | 8 | 16;
const MOTION_BIT = 32;

/** Enable button reporting in SGR encoding on the host; the inverse is in the reset sequence. */
export const HOST_MOUSE_REPORTING_ON = "\u001b[?1000h\u001b[?1006h";
export const HOST_MOUSE_REPORTING_OFF = "\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l";

/**
 * Splits host input into ordinary bytes and SGR mouse reports.
 *
 * Potential mouse and bracketed-paste prefixes are held across chunks until
 * complete or until the owner releases them after a short idle window. Raw
 * terminal bytes cannot distinguish a lone Escape key from the first chunk
 * of a report delayed beyond that window. Bracketed paste content is never
 * parsed: a pasted report is text.
 */
export class HostMouseDecoder {
  #carry: number[] = [];
  #pasting = false;
  #pasteMatch = 0;

  get hasPending(): boolean { return this.#carry.length > 0; }
  get needsIdleRelease(): boolean {
    return this.#carry.length === 1 && this.#carry[0] === ESC ||
      this.#carry.length === 2 && this.#carry[0] === ESC && this.#carry[1] === 0x5b;
  }

  /** Release an ambiguous prefix after the host input has gone idle. */
  flushPending(): Uint8Array {
    const pending = Uint8Array.from(this.#carry);
    this.#carry = [];
    return pending;
  }

  push(chunk: Uint8Array): HostInputSegment[] {
    const hadCarry = this.#carry.length > 0;
    const input = this.#carry.length === 0 ? chunk : Uint8Array.from([...this.#carry, ...chunk]);
    this.#carry = [];
    const segments: HostInputSegment[] = [];
    let plain: number[] = [];
    const flushPlain = (): void => {
      if (plain.length === 0) return;
      segments.push(Object.freeze({ kind: "bytes" as const, bytes: Uint8Array.from(plain) }));
      plain = [];
    };
    let index = 0;
    while (index < input.length) {
      const byte = input[index] as number;
      if (this.#pasting) {
        plain.push(byte);
        this.#pasteMatch = byte === PASTE_END[this.#pasteMatch] ? this.#pasteMatch + 1 : byte === PASTE_END[0] ? 1 : 0;
        if (this.#pasteMatch === PASTE_END.length) { this.#pasting = false; this.#pasteMatch = 0; }
        index += 1;
        continue;
      }
      if (hadCarry && index === 0 && byte === ESC && input.length > 1 && input[1] !== 0x5b) {
        // An isolated Escape followed by an unrelated key is two input acts.
        // Keep their receipt boundaries so local decisions (for example a
        // browser request's "d" response) still see the key alone.
        plain.push(ESC);
        flushPlain();
        index += 1;
        continue;
      }
      if (byte === ESC && (incompletePrefix(input, index, PASTE_START) ||
        incompletePrefix(input, index, [ESC, 0x5b, 0x3c]))) {
        flushPlain();
        this.#carry = [...input.subarray(index)];
        return segments;
      }
      if (byte === ESC && startsWith(input, index, PASTE_START)) {
        plain.push(...PASTE_START);
        this.#pasting = true;
        this.#pasteMatch = 0;
        index += PASTE_START.length;
        continue;
      }
      if (byte === ESC && input[index + 1] === 0x5b && input[index + 2] === 0x3c) {
        const parsed = parseSgrReport(input, index);
        if (parsed === "incomplete") {
          flushPlain();
          this.#carry = [...input.subarray(index)];
          return segments;
        }
        if (parsed !== undefined) {
          flushPlain();
          segments.push(Object.freeze({ kind: "mouse" as const, event: parsed.event }));
          index = parsed.next;
          continue;
        }
      }
      plain.push(byte);
      index += 1;
    }
    flushPlain();
    return segments;
  }
}

function startsWith(input: Uint8Array, index: number, prefix: readonly number[]): boolean {
  if (index + prefix.length > input.length) return false;
  return prefix.every((value, offset) => input[index + offset] === value);
}

function incompletePrefix(input: Uint8Array, index: number, prefix: readonly number[]): boolean {
  const available = input.length - index;
  return available < prefix.length && prefix.slice(0, available).every((value, offset) => input[index + offset] === value);
}

function parseSgrReport(input: Uint8Array, start: number):
  { readonly event: HostMouseEvent; readonly next: number } | "incomplete" | undefined {
  const fields: number[] = [0];
  let digits = 0;
  for (let index = start + 3; index < input.length; index += 1) {
    if (index - start >= MAX_REPORT_BYTES) return undefined;
    const byte = input[index] as number;
    if (byte >= 0x30 && byte <= 0x39) {
      if (digits >= 5) return undefined;
      fields[fields.length - 1] = (fields.at(-1) as number) * 10 + (byte - 0x30);
      digits += 1;
    } else if (byte === 0x3b) {
      if (digits === 0 || fields.length === 3) return undefined;
      fields.push(0);
      digits = 0;
    } else if (byte === 0x4d || byte === 0x6d) {
      if (digits === 0 || fields.length !== 3) return undefined;
      const [button, column, row] = fields as [number, number, number];
      if (column < 1 || row < 1) return undefined;
      return {
        event: Object.freeze({ button, column, row, release: byte === 0x6d }),
        next: index + 1,
      };
    } else {
      return undefined;
    }
  }
  return input.length - start >= MAX_REPORT_BYTES ? undefined : "incomplete";
}

/** -1 for a wheel notch up, +1 down, 0 for anything that is not a vertical wheel press. */
export function wheelDirection(event: HostMouseEvent): -1 | 0 | 1 {
  if (event.release) return 0;
  const base = event.button & ~(MODIFIER_BITS | MOTION_BIT);
  return base === 64 ? -1 : base === 65 ? 1 : 0;
}

export type RemoteMouseTracking = "none" | "x10" | "vt200" | "drag" | "any";

export interface RemoteMouseReporting {
  readonly tracking: RemoteMouseTracking;
  /** The remote program enabled SGR encoding (1006). */
  readonly sgr: boolean;
}

/**
 * The report the remote program asked for, in its coordinates and encoding,
 * or undefined when it asked for nothing this event can say.
 */
export function encodeRemoteMouse(
  event: HostMouseEvent,
  reporting: RemoteMouseReporting,
  position: { readonly column: number; readonly row: number },
): Uint8Array | undefined {
  if (reporting.tracking === "none") return undefined;
  const wheel = wheelDirection(event) !== 0 || ((event.button & ~(MODIFIER_BITS | MOTION_BIT)) >= 64);
  // X10 compatibility reports presses only, without modifiers.
  if (reporting.tracking === "x10" && (event.release || wheel)) return undefined;
  const button = reporting.tracking === "x10" ? event.button & ~(MODIFIER_BITS | MOTION_BIT) : event.button;
  if (reporting.sgr) {
    return new TextEncoder().encode(`\u001b[<${button};${position.column};${position.row}${event.release ? "m" : "M"}`);
  }
  // The legacy encoding cannot name a coordinate past 223 or which button was released.
  if (position.column > 223 || position.row > 223) return undefined;
  const legacyButton = event.release && !wheel ? 3 | (button & MODIFIER_BITS) : button;
  return Uint8Array.of(ESC, 0x5b, 0x4d, 32 + legacyButton, 32 + position.column, 32 + position.row);
}
