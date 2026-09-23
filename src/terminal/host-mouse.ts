/**
 * Mouse input from the host terminal, in SGR form (DECSET 1006).
 *
 * Rich mode asks the host for press/release reports only (1000), never drag
 * (1002) or motion (1003): the host keeps Shift+drag selection and copy, and
 * the only mouse bytes that arrive are presses, releases and wheel steps.
 * Every report is taken out of the input here, before any byte can reach a
 * remote program: a click on Cuna's own bar is Cuna's, not the agent's.
 */

export const ENABLE_HOST_MOUSE_REPORTING = "\u001b[?1000h\u001b[?1006h";
export const DISABLE_HOST_MOUSE_REPORTING = "\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l";

export interface HostMouseEvent {
  readonly kind: "press" | "release" | "wheel_up" | "wheel_down" | "wheel_left" | "wheel_right" | "motion";
  /** 0 primary, 1 middle, 2 secondary; wheel and motion events keep the raw low bits. */
  readonly button: number;
  /** 1-based host cell column and row, as the host reports them. */
  readonly column: number;
  readonly row: number;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
}

export type HostInputSegment =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "mouse"; readonly event: HostMouseEvent };

const ESC = 0x1b;
const LEFT_BRACKET = 0x5b;
const LESS_THAN = 0x3c;
const PRESS = 0x4d; // M
const RELEASE = 0x6d; // m
const SEMICOLON = 0x3b;
// ESC [ < 3 digits ; 5 digits ; 5 digits M is 20 bytes; anything longer is not a report.
const MAXIMUM_REPORT_BYTES = 24;
const BRACKETED_PASTE_START = Uint8Array.of(0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e);
const BRACKETED_PASTE_END = Uint8Array.of(0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e);

/**
 * Splits host input into ordered key bytes and mouse events.
 *
 * Stateful across chunks in two ways. A report cut after its unambiguous
 * `ESC [ <` prefix is held until the rest arrives (no key sends that prefix).
 * A bracketed paste is passed through untouched, so pasted text that happens to
 * contain `ESC [ <` is never read as a click. A lone `ESC` or `ESC [` at the end
 * of a chunk is NOT held: that is how the Escape key and arrow keys arrive, and
 * holding them would delay the key the agent uses to interrupt.
 */
export class HostMouseParser {
  #pending: number[] = [];
  #pasteActive = false;
  #pasteStartMatch = 0;
  #pasteEndMatch = 0;

  push(chunk: Uint8Array): readonly HostInputSegment[] {
    const segments: HostInputSegment[] = [];
    let bytes: number[] = [];
    const flushBytes = (): void => {
      if (bytes.length === 0) return;
      segments.push(Object.freeze({ kind: "bytes", bytes: Uint8Array.from(bytes) }));
      bytes = [];
    };
    const input = this.#pending.length === 0 ? chunk : Uint8Array.from([...this.#pending, ...chunk]);
    this.#pending = [];
    let index = 0;
    while (index < input.length) {
      const byte = input[index] as number;
      if (this.#pasteActive) {
        bytes.push(byte);
        this.#pasteEndMatch = advance(BRACKETED_PASTE_END, byte, this.#pasteEndMatch);
        if (this.#pasteEndMatch === BRACKETED_PASTE_END.length) {
          this.#pasteActive = false;
          this.#pasteEndMatch = 0;
        }
        index += 1;
        continue;
      }
      if (byte === ESC && input[index + 1] === LEFT_BRACKET && input[index + 2] === LESS_THAN) {
        const report = readReport(input, index);
        if (report.kind === "incomplete") {
          this.#pending = [...input.subarray(index)];
          break;
        }
        if (report.kind === "event") {
          flushBytes();
          segments.push(Object.freeze({ kind: "mouse", event: report.event }));
          this.#pasteStartMatch = 0;
          index = report.end;
          continue;
        }
      }
      bytes.push(byte);
      this.#pasteStartMatch = advance(BRACKETED_PASTE_START, byte, this.#pasteStartMatch);
      if (this.#pasteStartMatch === BRACKETED_PASTE_START.length) {
        this.#pasteActive = true;
        this.#pasteStartMatch = 0;
      }
      index += 1;
    }
    flushBytes();
    return Object.freeze(segments);
  }
}

type ReportRead =
  | { readonly kind: "event"; readonly event: HostMouseEvent; readonly end: number }
  | { readonly kind: "incomplete" }
  | { readonly kind: "invalid" };

function readReport(input: Uint8Array, start: number): ReportRead {
  const fields: number[] = [];
  let value = 0;
  let digits = 0;
  for (let index = start + 3; index < input.length; index += 1) {
    if (index - start >= MAXIMUM_REPORT_BYTES) return { kind: "invalid" };
    const byte = input[index] as number;
    if (byte >= 0x30 && byte <= 0x39) {
      value = value * 10 + (byte - 0x30);
      digits += 1;
      if (digits > 5) return { kind: "invalid" };
      continue;
    }
    if (digits === 0) return { kind: "invalid" };
    fields.push(value);
    value = 0;
    digits = 0;
    if (byte === SEMICOLON) {
      if (fields.length >= 3) return { kind: "invalid" };
      continue;
    }
    if ((byte !== PRESS && byte !== RELEASE) || fields.length !== 3) return { kind: "invalid" };
    const [code, column, row] = fields as [number, number, number];
    if (column < 1 || row < 1) return { kind: "invalid" };
    return { kind: "event", event: decode(code, column, row, byte === PRESS), end: index + 1 };
  }
  return input.length - start >= MAXIMUM_REPORT_BYTES ? { kind: "invalid" } : { kind: "incomplete" };
}

function decode(code: number, column: number, row: number, press: boolean): HostMouseEvent {
  const low = code & 0b11;
  const modifiers = { shift: (code & 4) !== 0, alt: (code & 8) !== 0, ctrl: (code & 16) !== 0 };
  let kind: HostMouseEvent["kind"];
  if ((code & 64) !== 0) {
    kind = low === 0 ? "wheel_up" : low === 1 ? "wheel_down" : low === 2 ? "wheel_left" : "wheel_right";
  } else if ((code & 32) !== 0) {
    kind = "motion";
  } else {
    kind = press ? "press" : "release";
  }
  return Object.freeze({ kind, button: low, column, row, ...modifiers });
}

function advance(sequence: Uint8Array, byte: number, matched: number): number {
  if (sequence[matched] === byte) return matched + 1;
  return sequence[0] === byte ? 1 : 0;
}
