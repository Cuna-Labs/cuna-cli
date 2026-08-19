import type { Writable } from "node:stream";

import type { AgentJourneyPhase, AgentJourneyPhaseEvent } from "../journey/orchestrator.js";
import type { WorkspaceSyncProgress } from "../sync/workspace-sync-coordinator.js";

const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const CLEAR_LINE = "\u001b[2K";
const FRAMES = Object.freeze(["|", "/", "-", "\\"]);

export interface JourneyPresentation {
  onPhase(event: AgentJourneyPhaseEvent): void;
  close(outcome?: "failed" | "cancelled"): void;
}

export interface JourneyPresentationInput {
  readonly stderr: Writable;
  readonly stderrIsTTY: boolean;
  readonly json: boolean;
  readonly color: boolean;
  readonly signal?: AbortSignal;
  /** Test seams; production uses the host clock and timer functions. */
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, milliseconds: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
}

interface ActivePhase {
  readonly phase: AgentJourneyPhase;
  readonly startedAt: number;
  progress?: WorkspaceSyncProgress;
}

function noPresentation(): JourneyPresentation {
  return Object.freeze({ onPhase() {}, close() {} });
}

function phaseName(phase: AgentJourneyPhase): string {
  return phase.replaceAll("-", " ");
}

function elapsed(milliseconds: number): string {
  return `${(Math.max(0, milliseconds) / 1_000).toFixed(1)}s`;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1_024 && unit < units.length - 1) {
    value /= 1_024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function progressText(progress: WorkspaceSyncProgress | undefined): string {
  if (progress === undefined || progress.totalBytes === 0) return "";
  const ratio = Math.min(1, progress.completedBytes / progress.totalBytes);
  const percentage = Math.floor(ratio * 100);
  const width = 16;
  const complete = Math.round(ratio * width);
  const bar = `${"\u2588".repeat(complete)}${"\u2591".repeat(width - complete)}`;
  return `  [${bar}] ${percentage}% ${formatBytes(progress.completedBytes)}/${formatBytes(progress.totalBytes)} ${progress.completedFiles}/${progress.totalFiles} files`;
}

/**
 * A deliberately small terminal renderer. It becomes a no-op outside an
 * interactive, non-JSON stderr, so no timer, cursor sequence, or colour byte
 * can leak into a pipeline or structured result.
 */
export function createJourneyPresentation(input: JourneyPresentationInput): JourneyPresentation {
  if (input.json || !input.stderrIsTTY) return noPresentation();

  const now = input.now ?? Date.now;
  const schedule = input.schedule ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
  const cancel = input.cancel ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let active: ActivePhase | undefined;
  let timer: unknown;
  let frame = 0;
  let cursorHidden = false;
  let closed = false;

  const write = (value: string): void => {
    try {
      input.stderr.write(value);
    } catch {
      // A closed terminal must not turn an already-running journey into an error.
      closed = true;
    }
  };
  const color = (code: "36" | "32" | "31" | "33", value: string): string =>
    input.color ? `\u001b[${code}m${value}\u001b[0m` : value;
  const stopTimer = (): void => {
    if (timer !== undefined) {
      cancel(timer);
      timer = undefined;
    }
  };
  const showCursor = (): void => {
    if (cursorHidden) {
      write(SHOW_CURSOR);
      cursorHidden = false;
    }
  };
  const paint = (): void => {
    if (active === undefined || closed) return;
    const marker = color("36", FRAMES[frame % FRAMES.length] ?? "|");
    const line = `${marker} ${phaseName(active.phase)} - ${elapsed(now() - active.startedAt)}${progressText(active.progress)}`;
    write(`\r${CLEAR_LINE}${line}`);
    frame += 1;
  };
  const finishActive = (outcome: "completed" | "failed" | "cancelled"): void => {
    if (active === undefined) return;
    stopTimer();
    const current = active;
    active = undefined;
    const code = outcome === "completed" ? "32" : outcome === "failed" ? "31" : "33";
    const line = `${color(code, `[${outcome}]`)} ${phaseName(current.phase)} - ${outcome} in ${elapsed(now() - current.startedAt)}${progressText(current.progress)}`;
    write(`\r${CLEAR_LINE}${line}\n`);
  };
  const abort = (): void => close("cancelled");
  const close = (outcome: "failed" | "cancelled" = "failed"): void => {
    if (closed) return;
    finishActive(outcome);
    showCursor();
    input.signal?.removeEventListener("abort", abort);
    closed = true;
  };

  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) {
    close("cancelled");
    return noPresentation();
  }

  return Object.freeze({
    onPhase(event: AgentJourneyPhaseEvent) {
      if (closed) return;
      if (event.type === "progress") {
        const current = active;
        if (current?.phase === event.phase) {
          current.progress = event.progress;
          paint();
        }
        return;
      }
      if (event.type === "started") {
        finishActive("completed");
        active = { phase: event.phase, startedAt: now() };
        if (!cursorHidden) {
          write(HIDE_CURSOR);
          cursorHidden = true;
        }
        paint();
        timer = schedule(paint, 125);
        return;
      }
      if (active?.phase !== event.phase) return;
      finishActive(event.type);
    },
    close,
  });
}

export const TERMINAL_CURSOR_SEQUENCES = Object.freeze({ hide: HIDE_CURSOR, show: SHOW_CURSOR });
