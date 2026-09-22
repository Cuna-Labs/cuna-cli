import type { Writable } from "node:stream";
import { assertRegisteredCliRoute, booleanOption, parseArgv } from "./parser.js";
import { preflightAgentJourneyInvocation } from "../journey/intent.js";
import {
  composeInlineProgressLine,
  inlineProgressColumns,
  renderInlineProgressFrame,
} from "./progress-line.js";
import { terminalCellWidth } from "../terminal/cell-width.js";

/**
 * THE FIRST TRUTHFUL LINE, PAINTED BEFORE THE CLI'S CODE HAS LOADED.
 *
 * WHY THIS FILE EXISTS. Measured 2026-09-22: from `runCli` to the first paint
 * takes about 11 ms; everything before it is Node loading the static import
 * graph behind `cli/run.ts`, about 2.2 MB in 138 files, ~98% of the time to the
 * first line. The same unchanged build painted at 499 ms on a quiet host and at
 * 1 391 ms on a loaded one, so no change inside that graph can hold the line
 * down. `bin/cuna.ts` therefore imports only this module (and the small ones it
 * needs), paints here, and only then loads the rest.
 *
 * WHAT IT MAY PAINT, EXACTLY. Only the row `runCli` would itself paint first,
 * decided by the same calls in the same order: the `Starting Cuna` row for an
 * interactive bare `cuna`, and the `Preparing …` row for `cuna claude`, `codex`
 * or `opencode` once `assertRegisteredCliRoute` and
 * `preflightAgentJourneyInvocation` accept the arguments. Nothing is painted
 * unless stdin, stdout and stderr are all terminals and `--json` is absent, so a
 * redirected or structured invocation writes exactly what it wrote before.
 *
 * HOW IT IS HANDED OVER. The paint site in `cli/run.ts` that would have drawn
 * this row `claim`s it and continues from frame 1 without drawing frame 0
 * again. If `runCli` fails before that site, its error path `release`s the row
 * first, so the error is not written onto the end of it.
 */

export const ROOT_FIRST_LINE_LABEL = "Starting Cuna";

export function agentDisplayName(agent: string): string {
  return agent === "claude-code" ? "Claude Code"
    : agent === "codex" ? "Codex"
    : agent === "opencode" ? "OpenCode"
    : "OpenClaw";
}

export function journeyPreparationLabel(agent: string): string {
  return agent === "opencode"
    ? "Preparing OpenCode — use /connect in its terminal"
    : `Preparing ${agentDisplayName(agent)}`;
}

export interface FirstLineDecision {
  readonly kind: "root" | "journey";
  readonly label: string;
  readonly color: boolean;
}

/** What a paint site needs to continue a row it did not draw. */
export interface PaintedFirstLine {
  readonly paintedAt: number;
  readonly columns: number;
  readonly cells: number;
}

export interface FirstLine {
  /**
   * Hand the painted row to the paint site that would have drawn `expected`.
   * Answers once: a different row, colour or stream releases it instead, and so
   * does every later call, so a nested `runCli` can never take it a second time.
   */
  claim(expected: FirstLineDecision & { readonly stream: Writable }): PaintedFirstLine | undefined;
  /** Clear the row unless a paint site already took it. Safe to call again. */
  release(): void;
}

/**
 * The row `runCli` will paint first for this invocation, or `undefined` when it
 * would paint nothing first or something this module cannot prove.
 */
export function firstLineFor(
  argv: readonly string[],
  context: {
    readonly env: NodeJS.ProcessEnv;
    readonly stdinIsTTY: boolean;
    readonly stdoutIsTTY: boolean;
    readonly stderrIsTTY: boolean;
  },
): FirstLineDecision | undefined {
  if (!context.stdinIsTTY || !context.stdoutIsTTY || !context.stderrIsTTY) return undefined;
  if (argv.includes("--json")) return undefined;
  try {
    const parsed = parseArgv(argv);
    if (parsed.command === "help" || parsed.command === "version" ||
      booleanOption(parsed, "help") || booleanOption(parsed, "version")) return undefined;
    const color = !booleanOption(parsed, "no-color") && !Object.hasOwn(context.env, "NO_COLOR");
    if (parsed.command === undefined) {
      // `runCli` refuses any other option on a bare invocation before it paints.
      const allowed = new Set(["help", "version", "json", "no-color"]);
      if (Object.keys(parsed.options).some((name) => !allowed.has(name))) return undefined;
      return Object.freeze({ kind: "root", label: ROOT_FIRST_LINE_LABEL, color });
    }
    if (parsed.command !== "claude" && parsed.command !== "codex" && parsed.command !== "opencode") return undefined;
    assertRegisteredCliRoute(parsed);
    const intent = preflightAgentJourneyInvocation(parsed);
    return Object.freeze({ kind: "journey", label: journeyPreparationLabel(intent.agent), color });
  } catch {
    // Every refusal here is `runCli`'s to render, in its own words.
    return undefined;
  }
}

/** Frame 0 of the row, exactly as `startInlineProgress` would paint it. */
export function firstLineFrame(label: string, color: boolean, columns: number): { readonly bytes: string; readonly cells: number } {
  const { headline, trailer } = composeInlineProgressLine({ label, labelElapsedMs: 0, totalElapsedMs: 0 });
  const { styled, fitted } = renderInlineProgressFrame({ headline, trailer, frame: 0, columns, color });
  return Object.freeze({ bytes: `\r\u001b[2K${styled}`, cells: terminalCellWidth(fitted) });
}

/**
 * Paint the first line if this invocation has one, and return the handle that
 * gives it to `runCli`.
 */
export function paintFirstLine(
  argv: readonly string[],
  host: {
    readonly env: NodeJS.ProcessEnv;
    readonly stdinIsTTY: boolean;
    readonly stdoutIsTTY: boolean;
    readonly stderr: Writable & { readonly isTTY?: boolean };
    readonly now?: () => number;
  },
): FirstLine | undefined {
  const decision = firstLineFor(argv, {
    env: host.env,
    stdinIsTTY: host.stdinIsTTY,
    stdoutIsTTY: host.stdoutIsTTY,
    stderrIsTTY: host.stderr.isTTY === true,
  });
  if (decision === undefined) return undefined;
  const columns = inlineProgressColumns(host.stderr);
  const frame = firstLineFrame(decision.label, decision.color, columns);
  const paintedAt = (host.now ?? Date.now)();
  host.stderr.write(frame.bytes);
  let open = true;
  const release = (): void => {
    if (!open) return;
    open = false;
    host.stderr.write("\r\u001b[2K");
  };
  return Object.freeze({
    claim(expected: FirstLineDecision & { readonly stream: Writable }): PaintedFirstLine | undefined {
      if (!open) return undefined;
      if (expected.stream !== host.stderr || expected.kind !== decision.kind ||
        expected.label !== decision.label || expected.color !== decision.color) {
        release();
        return undefined;
      }
      open = false;
      return Object.freeze({ paintedAt, columns, cells: frame.cells });
    },
    release,
  });
}
