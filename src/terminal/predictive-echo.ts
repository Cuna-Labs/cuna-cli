import { runtimeFailure } from "../runtime/errors.js";
import { terminalCellWidth } from "./cell-width.js";
import type { ViewportRenderRun, ViewportSnapshot } from "./viewport.js";

/**
 * Predictive local echo for the rich workbench (mosh-style).
 *
 * Every keystroke of an attached writer travels CLI -> Edge -> Machine -> agent
 * and back before its glyph appears; measured 2026-09-15 that round trip is
 * never below ~210 ms from this PC. A printable character typed at the input
 * point is therefore drawn at once, dim and underlined, as a guess about what
 * the remote will echo. The guess lives only in the painted host frame: the
 * local VTE that mirrors the remote screen is never written, so the remote's
 * truth is always what `ViewportSnapshot` says.
 *
 * A guess is settled by the remote screen, never by time alone:
 * - confirmed when the predicted cell shows exactly that glyph (the painted
 *   frame then shows the real cell in its real style);
 * - rolled back when that cell shows anything else, when a non-printable key
 *   (Enter, Backspace, arrows, a chord) makes the next screen unpredictable,
 *   or when it is still unconfirmed `PREDICTION_CONFIRM_TIMEOUT_MS` after it
 *   was typed. Rolling back is just painting the true row again.
 *
 * Guesses are always tracked, but only shown while the remote has earned it:
 * its last `PREDICTION_TRUST_CONFIRMATIONS` settled guesses were all echoed
 * exactly (an echo-off password prompt fails this at once), the measured echo
 * time is above `PREDICTIVE_ECHO_ENABLE_RTT_MS` (mode `auto`), and the input
 * line does not ask for a secret. `CUNA_PREDICTIVE_ECHO=off|on|auto` selects
 * the mode; `on` drops only the round-trip threshold, never a safety rule.
 */

export type PredictiveEchoMode = "off" | "on" | "auto";

export const PREDICTIVE_ECHO_ENABLE_RTT_MS = 60;
/** Hysteresis: once shown, predictions stay on until echo is clearly fast. */
export const PREDICTIVE_ECHO_DISABLE_RTT_MS = 50;
export const PREDICTION_CONFIRM_TIMEOUT_MS = 1_000;
export const PREDICTION_TRUST_CONFIRMATIONS = 3;
/** After a key that makes the screen unpredictable, wait at least this long for its echo. */
const DEFAULT_BARRIER_MS = 250;
const MAX_PENDING_PREDICTIONS = 64;
const RTT_GAIN = 0.125;
const SECRET_PROMPT = /pass(?:word|phrase|code)|\bpin\b|secret|token|api[ _-]?key|one[- ]time|\botp\b|verification code/iu;
const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

export function predictiveEchoModeFromEnvironment(environment: NodeJS.ProcessEnv): PredictiveEchoMode {
  const requested = environment.CUNA_PREDICTIVE_ECHO?.trim().toLowerCase();
  if (requested === undefined || requested === "" || requested === "auto") return "auto";
  if (requested === "on" || requested === "off") return requested;
  throw runtimeFailure("pty_unavailable", "CUNA_PREDICTIVE_ECHO must be auto, on, or off.");
}

/** Where the remote application will put the next typed character. */
export interface InsertionPoint {
  readonly row: number;
  readonly column: number;
  /**
   * `cursor`: the terminal cursor is visible there. `inverse`: the cursor is
   * hidden and the application paints its own one-cell inverse block, as
   * Ink-based agent TUIs do.
   */
  readonly kind: "cursor" | "inverse";
}

export interface PredictionOverlay {
  /** Viewport row and first column of the unconfirmed guesses. */
  readonly row: number;
  readonly column: number;
  /** Printable ASCII only. */
  readonly text: string;
  /** Where the insertion point is after the guesses. */
  readonly cursorColumn: number;
  readonly cursor: InsertionPoint["kind"];
}

export interface PredictiveEchoStatistics {
  readonly predicted: number;
  readonly confirmed: number;
  readonly mispredicted: number;
  readonly expired: number;
  readonly srttMs: number | undefined;
}

interface Prediction {
  readonly row: number;
  readonly column: number;
  readonly glyph: string;
  readonly kind: InsertionPoint["kind"];
  readonly sentAt: number;
}

interface Cell {
  readonly text: string;
  readonly inverse: boolean;
}

export class PredictiveEcho {
  readonly #mode: PredictiveEchoMode;
  readonly #clock: () => number;
  readonly #onExpire: () => void;
  #key: string | undefined;
  #pending: Prediction[] = [];
  #srtt: number | undefined;
  /** Echo is slow enough that guesses help (hysteresis between the two thresholds). */
  #slowEcho = false;
  /** Outcomes of the most recent settled guesses, newest last. */
  #recent: boolean[] = [];
  #barrierUntil: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #predicted = 0;
  #confirmed = 0;
  #mispredicted = 0;
  #expired = 0;

  constructor(options: {
    readonly mode: PredictiveEchoMode;
    readonly clock?: () => number;
    /** Called after timed-out guesses were dropped, so the host repaints the true row. */
    readonly onExpire?: () => void;
  }) {
    this.#mode = options.mode;
    this.#clock = options.clock ?? Date.now;
    this.#onExpire = options.onExpire ?? (() => undefined);
  }

  get mode(): PredictiveEchoMode {
    return this.#mode;
  }

  get statistics(): PredictiveEchoStatistics {
    return Object.freeze({
      predicted: this.#predicted,
      confirmed: this.#confirmed,
      mispredicted: this.#mispredicted,
      expired: this.#expired,
      srttMs: this.#srtt,
    });
  }

  /** True when guesses would be painted right now. */
  get showing(): boolean {
    return this.#pending.length > 0 && this.#displayAllowed();
  }

  /**
   * Record the guesses for one received input chunk. `key` names the exact
   * writer attachment and geometry; any change discards older guesses.
   * Returns whether the painted overlay may have changed.
   */
  predict(bytes: Uint8Array, view: ViewportSnapshot, key: string): boolean {
    if (this.#mode === "off") return false;
    const changed = this.#adopt(key);
    const now = this.#clock();
    if (!bytes.every(isPrintableAscii)) return this.barrier() || changed;
    if (this.#barrierUntil !== undefined) return changed;
    let anchor: InsertionPoint | undefined;
    const last = this.#pending.at(-1);
    if (last === undefined) {
      anchor = insertionPoint(view);
      if (anchor === undefined || asksForSecret(view, anchor)) return changed;
    } else {
      anchor = { row: last.row, column: last.column + 1, kind: last.kind };
    }
    let added = 0;
    for (const byte of bytes) {
      const column = anchor.column + added;
      if (this.#pending.length >= MAX_PENDING_PREDICTIONS) break;
      // Inverse-cursor applications need one more cell for the moved block.
      if (column >= view.columns - (anchor.kind === "inverse" ? 1 : 0)) break;
      const cell = cellAt(view, anchor.row, column);
      if (cell === undefined || !isBlank(cell.text)) break;
      if (cell.inverse && !(anchor.kind === "inverse" && this.#pending.length === 0 && added === 0)) break;
      if (anchor.kind === "inverse") {
        const block = cellAt(view, anchor.row, column + 1);
        if (block === undefined || !isBlank(block.text) || block.inverse) break;
      }
      this.#pending.push({ row: anchor.row, column, glyph: String.fromCharCode(byte), kind: anchor.kind, sentAt: now });
      this.#predicted += 1;
      added += 1;
    }
    if (added < bytes.length) {
      // The rest of this chunk cannot be placed; the remote screen decides.
      this.#barrierUntil = now;
    }
    this.#armTimer();
    return (added > 0 && this.#displayAllowed()) || changed;
  }

  /**
   * A key whose echo cannot be predicted (Enter, Backspace, an escape
   * sequence, a paste, a local chord). Pending guesses are withdrawn without
   * counting against the remote, and none are made until the remote screen
   * has had time to show that key's effect.
   */
  barrier(): boolean {
    if (this.#mode === "off") return false;
    const shown = this.showing;
    this.#pending = [];
    this.#clearTimer();
    this.#barrierUntil = this.#clock() + Math.max(DEFAULT_BARRIER_MS, Math.round(this.#srtt ?? 0));
    return shown;
  }

  /** Settle guesses against the remote screen after each parsed output frame. */
  reconcile(view: ViewportSnapshot, key: string): boolean {
    if (this.#mode === "off") return false;
    const changed = this.#adopt(key);
    const now = this.#clock();
    if (this.#barrierUntil !== undefined && now >= this.#barrierUntil) this.#barrierUntil = undefined;
    if (this.#pending.length === 0) return changed;
    const shownBefore = this.showing;
    const point = insertionPoint(view);
    // The newest guess the screen proves was echoed; every earlier guess on
    // the same row must then show its own glyph too.
    let evidenced = -1;
    for (let index = 0; index < this.#pending.length; index += 1) {
      const prediction = this.#pending[index]!;
      const cell = cellAt(view, prediction.row, prediction.column);
      if (cell === undefined) break;
      const passed = point !== undefined && point.row === prediction.row && point.column > prediction.column;
      if (!isBlank(cell.text) && cell.text !== prediction.glyph) {
        this.#rollBack("mispredicted");
        return true;
      }
      if (cell.text === prediction.glyph && (prediction.glyph !== " " || passed)) evidenced = index;
      else if (passed && isBlank(cell.text) && prediction.glyph === " ") evidenced = index;
    }
    if (evidenced < 0) return changed;
    for (const prediction of this.#pending.slice(0, evidenced + 1)) {
      const cell = cellAt(view, prediction.row, prediction.column);
      const matches = cell !== undefined && (cell.text === prediction.glyph || (prediction.glyph === " " && isBlank(cell.text)));
      if (!matches) {
        this.#rollBack("mispredicted");
        return true;
      }
    }
    for (const prediction of this.#pending.splice(0, evidenced + 1)) {
      this.#sample(now - prediction.sentAt);
      this.#settle(true);
      this.#confirmed += 1;
    }
    if (this.#pending.length === 0) this.#clearTimer();
    else this.#armTimer();
    return changed || shownBefore || this.showing;
  }

  /**
   * The guesses to paint over the true frame, or undefined. They are shown
   * only while the true screen agrees on where they start: its insertion
   * point sits exactly on the first unconfirmed guess.
   */
  overlay(view: ViewportSnapshot, key: string): PredictionOverlay | undefined {
    if (this.#mode === "off" || key !== this.#key || !this.#displayAllowed()) return undefined;
    const first = this.#pending[0];
    const last = this.#pending.at(-1);
    if (first === undefined || last === undefined) return undefined;
    if (this.#clock() - first.sentAt >= PREDICTION_CONFIRM_TIMEOUT_MS) return undefined;
    const point = insertionPoint(view);
    if (point === undefined || point.row !== first.row || point.column !== first.column || point.kind !== first.kind) return undefined;
    if (asksForSecret(view, point)) return undefined;
    for (const prediction of this.#pending) {
      const cell = cellAt(view, prediction.row, prediction.column);
      if (cell === undefined || !isBlank(cell.text)) return undefined;
    }
    return Object.freeze({
      row: first.row,
      column: first.column,
      text: this.#pending.map((prediction) => prediction.glyph).join(""),
      cursorColumn: last.column + 1,
      cursor: first.kind,
    });
  }

  /** Forget every guess, e.g. on seat change or detach. Never counts against the remote. */
  clear(): boolean {
    const shown = this.showing;
    this.#pending = [];
    this.#clearTimer();
    return shown;
  }

  dispose(): void {
    this.clear();
  }

  #adopt(key: string): boolean {
    if (this.#key === key) return false;
    this.#key = key;
    this.#barrierUntil = undefined;
    return this.clear();
  }

  #displayAllowed(): boolean {
    if (this.#mode === "off") return false;
    const trusted = this.#recent.length >= PREDICTION_TRUST_CONFIRMATIONS &&
      this.#recent.slice(-PREDICTION_TRUST_CONFIRMATIONS).every(Boolean);
    return trusted && (this.#mode === "on" || this.#slowEcho);
  }

  #sample(elapsedMs: number): void {
    const sample = Math.max(0, elapsedMs);
    this.#srtt = this.#srtt === undefined ? sample : this.#srtt + RTT_GAIN * (sample - this.#srtt);
    if (this.#srtt > PREDICTIVE_ECHO_ENABLE_RTT_MS) this.#slowEcho = true;
    else if (this.#srtt < PREDICTIVE_ECHO_DISABLE_RTT_MS) this.#slowEcho = false;
  }

  #settle(confirmed: boolean): void {
    this.#recent.push(confirmed);
    if (this.#recent.length > 8) this.#recent.splice(0, this.#recent.length - 8);
  }

  #rollBack(reason: "mispredicted" | "expired"): void {
    this.#pending = [];
    this.#clearTimer();
    this.#settle(false);
    if (reason === "expired") this.#expired += 1;
    else this.#mispredicted += 1;
  }

  #armTimer(): void {
    this.#clearTimer();
    const first = this.#pending[0];
    if (first === undefined) return;
    const delay = Math.max(0, first.sentAt + PREDICTION_CONFIRM_TIMEOUT_MS - this.#clock());
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#pending[0] !== first) return;
      const shown = this.showing;
      this.#rollBack("expired");
      if (shown) this.#onExpire();
    }, delay);
    this.#timer.unref?.();
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

/**
 * The visible terminal cursor when the application shows it; otherwise the
 * single one-cell inverse block an application paints as its own cursor.
 * Anything else (no cursor, several inverse cells) is not a place to guess.
 */
export function insertionPoint(view: ViewportSnapshot): InsertionPoint | undefined {
  if (view.modes.cursorVisible) {
    if (view.cursorY < 0 || view.cursorY >= view.rows || view.cursorX < 0 || view.cursorX >= view.columns) return undefined;
    return { row: view.cursorY, column: view.cursorX, kind: "cursor" };
  }
  const rows = view.renderRows;
  if (rows === undefined) return undefined;
  let found: InsertionPoint | undefined;
  for (let row = 0; row < rows.length && row < view.rows; row += 1) {
    let column = 0;
    for (const run of rows[row] ?? []) {
      if (run.style.inverse) {
        if (run.width !== 1 || found !== undefined) return undefined;
        found = { row, column, kind: "inverse" };
      }
      column += run.width;
    }
  }
  return found;
}

function asksForSecret(view: ViewportSnapshot, point: InsertionPoint): boolean {
  const line = view.cells[point.row] ?? "";
  return SECRET_PROMPT.test(line);
}

/** The cell at one viewport position, or undefined when the row cannot be mapped to columns. */
function cellAt(view: ViewportSnapshot, row: number, column: number): Cell | undefined {
  if (row < 0 || row >= view.rows || column < 0 || column >= view.columns) return undefined;
  const runs: readonly ViewportRenderRun[] | undefined = view.renderRows?.[row];
  const source: readonly { readonly text: string; readonly width: number; readonly style: { readonly inverse: boolean } }[] =
    runs ?? [{ text: view.cells[row] ?? "", width: view.displayWidths[row] ?? 0, style: { inverse: false } }];
  let at = 0;
  for (const run of source) {
    // A run whose graphemes do not add up to its measured width cannot be
    // mapped to columns; refuse rather than guess over a cell that is not blank.
    const graphemes = [...GRAPHEMES.segment(run.text)].map(({ segment }) => ({ segment, width: terminalCellWidth(segment) }));
    if (graphemes.reduce((total, item) => total + item.width, 0) !== run.width) return undefined;
    if (column >= at + run.width) {
      at += run.width;
      continue;
    }
    let offset = at;
    for (const { segment, width } of graphemes) {
      if (column < offset + width) {
        return width === 1 && offset === column ? { text: segment, inverse: run.style.inverse } : undefined;
      }
      offset += width;
    }
    return undefined;
  }
  return { text: "", inverse: false };
}

function isBlank(text: string): boolean {
  return text === "" || text === " ";
}

function isPrintableAscii(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x7e;
}
