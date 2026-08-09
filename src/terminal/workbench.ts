import type { AppbarModel, TruthProjection } from "./appbar.js";
import type { ViewportSnapshot } from "./viewport.js";

const ESC = "\u001b[";
const RUNA_ORANGE = "48;2;235;86;37";
const RUNA_ORANGE_DARK = "48;2;121;48;25";
const WHITE = "38;2;255;255;255";
const MUTED = "38;2;224;210;203";
const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

export interface WorkbenchTab {
  readonly id: string;
  readonly label: string;
  readonly agent: "claude-code" | "codex" | "openclaw" | "shell";
  readonly viewport: ViewportSnapshot;
}

export interface WorkbenchFrameInput {
  readonly columns: number;
  readonly rows: number;
  readonly activeTabId: string;
  readonly tabs: readonly WorkbenchTab[];
  readonly appbar: AppbarModel;
  readonly notice?: string;
  readonly color?: boolean;
}

export interface WorkbenchFrame {
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly appbarRows: number;
  readonly viewportRows: number;
}

export class WorkbenchRenderError extends Error {
  readonly code: "invalid_dimensions" | "active_tab_missing" | "binding_mismatch" | "duplicate_tab";

  constructor(code: WorkbenchRenderError["code"], message: string) {
    super(message);
    this.name = "WorkbenchRenderError";
    this.code = code;
  }
}

export function renderWorkbenchFrame(input: WorkbenchFrameInput): WorkbenchFrame {
  validateDimensions(input.columns, input.rows);
  if (new Set(input.tabs.map((tab) => tab.id)).size !== input.tabs.length) {
    throw new WorkbenchRenderError("duplicate_tab", "Workbench tab identities must be unique.");
  }
  const active = input.tabs.find((tab) => tab.id === input.activeTabId);
  if (active === undefined) {
    throw new WorkbenchRenderError("active_tab_missing", "The active workbench tab does not exist.");
  }
  if (active.viewport.tabId !== active.id) {
    throw new WorkbenchRenderError("binding_mismatch", "The selected viewport belongs to another workbench tab.");
  }

  const appbarRows = input.rows >= 5 ? 2 : 1;
  const viewportRows = input.rows - appbarRows;
  const lines = appbarRows === 2
    ? [
        renderTabs(input.tabs, input.activeTabId, input.columns),
        input.notice === undefined ? renderTruth(input.appbar, input.columns) : truncate(` ${safeText(input.notice)}`, input.columns),
      ]
    : [input.notice === undefined
        ? renderCompact(input.tabs, input.activeTabId, input.appbar, input.columns)
        : truncate(` RUNA  ${safeText(input.notice)}`, input.columns)];
  const color = input.color !== false;
  let text = `${ESC}?25l${ESC}H`;
  for (let index = 0; index < lines.length; index += 1) {
    const background = index === 0 ? RUNA_ORANGE : RUNA_ORANGE_DARK;
    text += `${ESC}${index + 1};1H${color ? `${ESC}${background}m${ESC}${index === 0 ? WHITE : MUTED}m` : ""}`;
    text += padLine(lines[index] ?? "", input.columns);
    if (color) text += `${ESC}0m`;
  }

  const cells = active.viewport.cells.slice(0, viewportRows);
  for (let row = 0; row < viewportRows; row += 1) {
    const cell = cells[row] ?? "";
    const displayWidth = active.viewport.displayWidths[row] ?? 0;
    assertViewportCell(cell, displayWidth, input.columns);
    text += `${ESC}${appbarRows + row + 1};1H${ESC}0m${ESC}2K${cell}`;
  }
  const cursorRow = Math.min(viewportRows - 1, Math.max(0, active.viewport.cursorY));
  const cursorColumn = Math.min(input.columns - 1, Math.max(0, active.viewport.cursorX));
  text += `${ESC}0m${ESC}${appbarRows + cursorRow + 1};${cursorColumn + 1}H`;
  text += active.viewport.modes.cursorVisible ? `${ESC}?25h` : `${ESC}?25l`;
  return Object.freeze({
    bytes: new TextEncoder().encode(text),
    text,
    appbarRows,
    viewportRows,
  });
}

function renderTabs(tabs: readonly WorkbenchTab[], activeTabId: string, columns: number): string {
  const parts = [" RUNA"];
  for (let index = 0; index < tabs.length; index += 1) {
    const tab = tabs[index];
    if (tab === undefined) continue;
    const active = tab.id === activeTabId;
    const label = `${index + 1}:${agentLabel(tab.agent)} ${safeText(tab.label)}`;
    parts.push(active ? `[${label}]` : ` ${label} `);
  }
  return truncate(parts.join("  "), columns);
}

function renderTruth(model: AppbarModel, columns: number): string {
  const values = [
    projection("machine", model.machineLifecycle),
    projection("session", model.agentSessionLifecycle),
    projection("terminal", model.attachment),
    projection("auth", model.providerAuthentication),
    projection("sync", model.workspaceSync),
  ];
  if (model.cost !== undefined) values.push(metric("cost", model.cost, (value) => `$${value.toFixed(2)}`));
  if (model.tokensSaved !== undefined) values.push(metric("tokens saved", model.tokensSaved, String));
  return truncate(` ${values.join("  \u00b7  ")}`, columns);
}

function renderCompact(
  tabs: readonly WorkbenchTab[],
  activeTabId: string,
  model: AppbarModel,
  columns: number,
): string {
  const active = tabs.find((tab) => tab.id === activeTabId);
  const identity = active === undefined ? "session" : `${agentLabel(active.agent)} ${safeText(active.label)}`;
  return truncate(` RUNA  ${identity}  \u00b7  ${projection("terminal", model.attachment)}  \u00b7  ${projection("auth", model.providerAuthentication)}`, columns);
}

function projection(label: string, value: TruthProjection<string>): string {
  return value.status === "verified"
    ? `${label} ${safeText(value.value)}`
    : `${label} ${value.status}`;
}

function metric(label: string, value: TruthProjection<number>, format: (value: number) => string): string {
  return value.status === "verified"
    ? `${label} ${format(value.value)}`
    : `${label} ${value.status}`;
}

function agentLabel(agent: WorkbenchTab["agent"]): string {
  switch (agent) {
    case "claude-code": return "Claude";
    case "codex": return "Codex";
    case "openclaw": return "OpenClaw";
    case "shell": return "Shell";
  }
}

function safeText(value: string): string {
  const safe = value.normalize("NFC").replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "");
  return safe.replace(/\s+/gu, " ").trim();
}

function truncate(value: string, columns: number): string {
  let result = "";
  let width = 0;
  for (const item of GRAPHEME_SEGMENTER.segment(value)) {
    const nextWidth = graphemeCellWidth(item.segment);
    if (width + nextWidth > columns) break;
    result += item.segment;
    width += nextWidth;
  }
  return result;
}

function padLine(value: string, columns: number): string {
  const truncated = truncate(value, columns);
  return truncated + " ".repeat(Math.max(0, columns - displayCellWidth(truncated)));
}

function displayCellWidth(value: string): number {
  let width = 0;
  for (const item of GRAPHEME_SEGMENTER.segment(value)) width += graphemeCellWidth(item.segment);
  return width;
}

function graphemeCellWidth(value: string): number {
  if (/^[\p{M}\p{Cf}]*$/u.test(value)) return 0;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value)) return 2;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && isWideCodePoint(point)) return 2;
  }
  return 1;
}

function isWideCodePoint(point: number): boolean {
  return (
    point >= 0x1100 && (
      point <= 0x115f ||
      point === 0x2329 || point === 0x232a ||
      (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f) ||
      (point >= 0xac00 && point <= 0xd7a3) ||
      (point >= 0xf900 && point <= 0xfaff) ||
      (point >= 0xfe10 && point <= 0xfe19) ||
      (point >= 0xfe30 && point <= 0xfe6f) ||
      (point >= 0xff00 && point <= 0xff60) ||
      (point >= 0xffe0 && point <= 0xffe6) ||
      (point >= 0x20000 && point <= 0x3fffd)
    )
  );
}

function assertViewportCell(value: string, displayWidth: number, columns: number): void {
  if (!Number.isSafeInteger(displayWidth) || displayWidth < 0 || displayWidth > columns) {
    throw new WorkbenchRenderError("invalid_dimensions", "A viewport cell exceeds the host frame width.");
  }
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point <= 0x1f || (point >= 0x7f && point <= 0x9f))) {
      throw new WorkbenchRenderError("binding_mismatch", "Remote control bytes cannot enter the host compositor.");
    }
  }
}

function validateDimensions(columns: number, rows: number): void {
  if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) || columns < 20 || rows < 2) {
    throw new WorkbenchRenderError("invalid_dimensions", "Workbench dimensions are outside the admitted range.");
  }
}
