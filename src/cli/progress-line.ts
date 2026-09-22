import type { Writable } from "node:stream";
import { journeyWaitLine, type JourneyWait } from "../journey/wait-policy.js";
import type { JourneyAgentSessionDisposition } from "../journey/orchestrator.js";
import { truncateTerminalLine } from "../terminal/cell-width.js";

/**
 * What the one inline progress row SAYS, separated from how it is painted.
 *
 * WHY IT IS ITS OWN FILE. The paint loop owns cursor control, terminal width,
 * colour and a 90 ms timer; none of that can be asserted without a real clock
 * and a real TTY, and the defect being repaired here is entirely about words.
 * Measured 2026-09-22 (`prds/cuna-cli-latency-before-20260922.md` § 3): the row
 * repainted every 90 ms for 61 259 ms while saying the same eleven words, so
 * every byte-level liveness check passed and the screen was still frozen to a
 * reader. Keeping the sentence testable is the only way that stays fixed.
 */

/**
 * When the elapsed counter joins the label.
 *
 * DERIVATION. The goal's own silence threshold is 2 000 ms, and the measured
 * dwell floor worth reporting was `Preparing Claude Code` at 2.0–3.7 s in
 * all five runs (§ 3, finding 4). Below this a step is finishing normally and
 * a counter is noise; above it, the number is the only evidence a person has.
 */
export const INLINE_DWELL_HINT_MS = 2_000;

/**
 * When the Ctrl-C affordance joins the line. Unchanged from the behaviour this
 * replaces, and deliberately measured against the WHOLE command rather than
 * the current step: the affordance is about this process, and resetting it on
 * every phase change would hide it from exactly the long journeys that need it.
 */
export const INLINE_CANCEL_HINT_MS = 12_000;

export interface InlineProgressLineInput {
  readonly label: string;
  /** Present while a declared wait owns the row; it supplies its own sentence. */
  readonly waiting?: JourneyWait | undefined;
  /** How long the CURRENT label has been on screen, not the whole command. */
  readonly labelElapsedMs: number;
  readonly totalElapsedMs: number;
}

export interface InlineProgressLine {
  /** The bright half: the step, or the wait that replaced it. */
  readonly headline: string;
  /** The dim half: elapsed seconds and the cancel affordance. */
  readonly trailer: string;
}

export function composeInlineProgressLine(input: InlineProgressLineInput): InlineProgressLine {
  const headline = input.waiting === undefined ? input.label : journeyWaitLine(input.waiting);
  // A wait headline already carries its own seconds AND its deadline, which is
  // strictly more than the counter would add. Two elapsed figures on one row
  // is the kind of thing a reader has to stop and reconcile.
  const dwellHint = input.waiting === undefined && input.labelElapsedMs >= INLINE_DWELL_HINT_MS
    ? ` · ${Math.floor(input.labelElapsedMs / 1_000)}s`
    : "";
  const cancelHint = input.totalElapsedMs >= INLINE_CANCEL_HINT_MS ? " — Ctrl-C cancels" : "";
  return Object.freeze({ headline, trailer: `${dwellHint}${cancelHint}` });
}

const INLINE_PROGRESS_SPINNER = Object.freeze(["◐", "◓", "◑", "◒"]);
const INLINE_PROGRESS_BARS = Object.freeze(["━╺━━━━", "━━╺━━━", "━━━╺━━", "━━━━╺━", "━━━━━╺", "━━━━╸━", "━━━╸━━", "━━╸━━━"]);

/**
 * One painted frame of the row, as the bytes after `\r\x1b[2K`.
 *
 * Here rather than inside the paint loop because two writers must produce the
 * same frame: `cli/first-line.ts` paints frame 0 before the CLI's modules have
 * loaded, and the loop in `cli/run.ts` takes the row over from frame 1. Two
 * spellings of one frame would show as a flicker at the handover.
 */
export function renderInlineProgressFrame(input: {
  readonly headline: string;
  readonly trailer: string;
  readonly frame: number;
  readonly columns: number;
  readonly color: boolean;
}): { readonly styled: string; readonly fitted: string } {
  const spinner = INLINE_PROGRESS_SPINNER[input.frame % INLINE_PROGRESS_SPINNER.length];
  const bar = INLINE_PROGRESS_BARS[input.frame % INLINE_PROGRESS_BARS.length];
  const text = `◆ CUNA  ${spinner} ${input.headline}${input.trailer}  ${bar}`;
  const fitted = truncateTerminalLine(text, input.columns - 1);
  const styled = input.color && fitted === text
    ? `\u001b[38;5;202m\u001b[1m◆ CUNA\u001b[0m  \u001b[38;5;202m${spinner}\u001b[0m \u001b[38;5;255m\u001b[1m${input.headline}\u001b[0m\u001b[38;5;245m${input.trailer}\u001b[0m  \u001b[38;5;208m${bar}\u001b[0m`
    : input.color ? `\u001b[38;5;255m${fitted}\u001b[0m` : fitted;
  return Object.freeze({ styled, fitted });
}

export function inlineProgressColumns(stream: Writable): number {
  const tty = stream as Writable & {
    columns?: number;
    _handle?: { getWindowSize?: (size: number[]) => number };
  };
  // Node 24 on Windows can retain stale public columns after ConPTY resize.
  // Read this stream's native TTY observation without changing its prototype
  // or cached fields. This guarded private API depends on the supported Node
  // engine; absent/failed/malformed observations retain the ordinary fallback.
  if (process.platform === "win32" && typeof tty._handle?.getWindowSize === "function") {
    try {
      const size: number[] = [];
      if (tty._handle.getWindowSize(size) === 0 && size.length === 2 &&
        Number.isSafeInteger(size[0]) && size[0]! >= 2 && size[0]! <= 4096 &&
        Number.isSafeInteger(size[1]) && size[1]! >= 1 && size[1]! <= 4096) return size[0]!;
    } catch { /* An unavailable native observation does not break progress. */ }
  }
  return Number.isSafeInteger(tty.columns) && tty.columns! >= 2 && tty.columns! <= 4096 ? tty.columns! : 80;
}

/**
 * The one durable line that says which AgentSession this journey settled on.
 *
 * Measured 2026-09-22 (§ 2, finding (ii)): no such line existed. The CLI
 * printed the intent `Creating Claude Code session` and never a completion, so
 * the row `00b6d65a` was created at t+11 446 ms while the screen still read
 * `Starting Claude Code`, and nothing named it for the rest of the run; the
 * only thing resembling a reuse statement was a QUESTION. The id is shown as
 * an 8-character prefix, the truncation `runtime/owner-grants-screen.ts`
 * already uses when it puts a resource id on screen, so it can never read as a
 * whole identifier.
 */
export function agentSessionDispositionLine(event: JourneyAgentSessionDisposition): string {
  return `AgentSession ${event.agentSessionId.slice(0, 8)} · ${event.disposition}`;
}
