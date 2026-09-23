import type { AppbarModel, TruthProjection } from "./appbar.js";
import type { ViewportCellColor, ViewportCellStyle, ViewportRenderRun, ViewportSnapshot } from "./viewport.js";

const ESC = "\u001b[";
const CUNA_ORANGE = "48;2;235;86;37";
const CUNA_ORANGE_DARK = "48;2;121;48;25";
const WHITE = "38;2;255;255;255";
const MUTED = "38;2;224;210;203";
const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

export interface WorkbenchTab {
  readonly id: string;
  readonly label: string;
  readonly agent: "claude-code" | "codex" | "openclaw" | "opencode" | "shell";
  readonly viewport: ViewportSnapshot;
}

/** One AgentSession of the Machine, as a clickable tab on the first bar row. */
export interface WorkbenchSessionTab {
  readonly agentSessionId: string;
  readonly number: number;
  readonly agent: WorkbenchTab["agent"];
  readonly label: string;
  readonly ended: boolean;
}

export interface WorkbenchFrameInput {
  readonly columns: number;
  readonly rows: number;
  readonly activeTabId: string;
  readonly tabs: readonly WorkbenchTab[];
  readonly appbar: AppbarModel;
  readonly notice?: string;
  readonly action?: string;
  readonly color?: boolean;
  /**
   * The Machine's sessions. When present and it names `activeSessionId`, the
   * first row lists these instead of the attached tabs, numbered as given.
   */
  readonly sessions?: readonly WorkbenchSessionTab[];
  readonly activeSessionId?: string;
  /** Mouse reporting is on, so plain drag no longer selects: say Shift+drag. */
  readonly mouseReporting?: boolean;
}

/** Where a tab was drawn on the bar, in 1-based host cells, for a click to find. */
export interface WorkbenchAppbarTarget {
  readonly row: number;
  readonly firstColumn: number;
  readonly lastColumn: number;
  /** `session:<id>` for a Machine session, `tab:<id>` for an attached tab. */
  readonly target: string;
}

export interface WorkbenchFrame {
  readonly columns: number;
  readonly rows: number;
  readonly activeTabId: string;
  readonly rowCommands: readonly string[];
  readonly cursorCommand: string;
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly appbarRows: number;
  readonly viewportRows: number;
  readonly appbarTargets: readonly WorkbenchAppbarTarget[];
}

/** The tab under a host cell, if the frame drew one there. */
export function workbenchAppbarTargetAt(frame: WorkbenchFrame, column: number, row: number): string | undefined {
  return frame.appbarTargets.find((target) =>
    target.row === row && column >= target.firstColumn && column <= target.lastColumn)?.target;
}

export class WorkbenchRenderError extends Error {
  readonly code: "invalid_dimensions" | "active_tab_missing" | "binding_mismatch" | "duplicate_tab";

  constructor(code: WorkbenchRenderError["code"], message: string) {
    super(message);
    this.name = "WorkbenchRenderError";
    this.code = code;
  }
}

/** A cell-only projection for the plain observer; it contains no appbar. */
export function renderBareViewport(viewport: ViewportSnapshot, notice?: string): Uint8Array {
  if (!Number.isSafeInteger(viewport.columns) || !Number.isSafeInteger(viewport.rows) ||
    viewport.columns < 1 || viewport.rows < 1 || viewport.columns > 4096 || viewport.rows > 4096) {
    throw new WorkbenchRenderError("invalid_dimensions", "Observer dimensions are outside the admitted range.");
  }
  // A previous raw writer may have changed origin, margins or auto-wrap. The
  // projected cells own these modes locally and must not inherit those modes.
  const notices: string[] = [];
  let remaining = notice === undefined ? "" : safeText(notice);
  while (remaining.length > 0 && notices.length < Math.max(1, viewport.rows - 1)) {
    const line = truncate(remaining, viewport.columns);
    notices.push(line);
    remaining = remaining.slice(line.length).trimStart();
  }
  const contentRows = viewport.rows - notices.length;
  let text = `${ESC}?25l${ESC}?6l${ESC}r${ESC}?7l`;
  for (let row = 0; row < contentRows; row += 1) {
    const cell = viewport.cells[row] ?? "";
    const width = viewport.displayWidths[row] ?? 0;
    const runs = viewport.renderRows?.[row];
    assertViewportCell(cell, width, viewport.columns);
    if (runs !== undefined) assertViewportRenderRuns(runs, cell, width, viewport.columns);
    text += `${ESC}${row + 1};1H${ESC}0m${ESC}2K${runs === undefined ? cell : renderStyledRuns(runs)}`;
  }
  for (let index = 0; index < notices.length; index += 1) {
    text += `${ESC}${contentRows + index + 1};1H${ESC}0m${ESC}2K${notices[index]}`;
  }
  text += `${ESC}0m${ESC}?7h${ESC}${Math.min(Math.max(0, contentRows - 1), Math.max(0, viewport.cursorY)) + 1};${Math.min(viewport.columns - 1, Math.max(0, viewport.cursorX)) + 1}H`;
  text += viewport.modes.cursorVisible && viewport.cursorY < contentRows ? `${ESC}?25h` : `${ESC}?25l`;
  return new TextEncoder().encode(text);
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
  let appbarTargets: readonly WorkbenchAppbarTarget[] = Object.freeze([]);
  let lines: string[];
  if (appbarRows === 2) {
    const tabRow = renderTabRow(tabRowEntries(input), input.action, input.columns);
    appbarTargets = tabRow.targets;
    lines = [
      tabRow.line,
      withClipboardHint(
        input.notice === undefined ? renderTruth(input.appbar, active.agent, input.columns) : truncate(` ${safeText(input.notice)}`, input.columns),
        input.columns,
        input.mouseReporting === true,
      ),
    ];
  } else {
    lines = [input.notice === undefined
      ? renderCompact(input.tabs, input.activeTabId, input.appbar, input.columns)
      : truncate(` CUNA  ${safeText(input.notice)}`, input.columns)];
  }
  const color = input.color !== false;
  let text = `${ESC}?25l${ESC}H`;
  const rowCommands: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const background = index === 0 ? CUNA_ORANGE : CUNA_ORANGE_DARK;
    let command = `${ESC}${index + 1};1H${ESC}0m${ESC}2K${color ? `${ESC}${background}m${ESC}${index === 0 ? WHITE : MUTED}m` : ""}`;
    command += padLine(lines[index] ?? "", input.columns);
    if (color) command += `${ESC}0m`;
    rowCommands.push(command);
  }

  const cells = active.viewport.cells.slice(0, viewportRows);
  for (let row = 0; row < viewportRows; row += 1) {
    const cell = cells[row] ?? "";
    const displayWidth = active.viewport.displayWidths[row] ?? 0;
    assertViewportCell(cell, displayWidth, input.columns);
    const renderRuns = active.viewport.renderRows?.[row];
    if (renderRuns !== undefined) assertViewportRenderRuns(renderRuns, cell, displayWidth, input.columns);
    const rendered = renderRuns === undefined || !color ? cell : renderStyledRuns(renderRuns);
    rowCommands.push(`${ESC}${appbarRows + row + 1};1H${ESC}0m${ESC}2K${rendered}`);
  }
  const cursorRow = Math.min(viewportRows - 1, Math.max(0, active.viewport.cursorY));
  const cursorColumn = Math.min(input.columns - 1, Math.max(0, active.viewport.cursorX));
  const cursorCommand = `${ESC}0m${ESC}${appbarRows + cursorRow + 1};${cursorColumn + 1}H` +
    (active.viewport.modes.cursorVisible ? `${ESC}?25h` : `${ESC}?25l`);
  text += rowCommands.join("") + cursorCommand;
  return Object.freeze({
    columns: input.columns,
    rows: input.rows,
    activeTabId: input.activeTabId,
    rowCommands: Object.freeze(rowCommands),
    cursorCommand,
    bytes: new TextEncoder().encode(text),
    text,
    appbarRows,
    viewportRows,
    appbarTargets,
  });
}

/** Only use a baseline whose host write completed and no other writer invalidated. */
export function workbenchUpdate(previous: WorkbenchFrame | undefined, next: WorkbenchFrame): Uint8Array {
  if (previous === undefined || previous.columns !== next.columns || previous.rows !== next.rows ||
      previous.activeTabId !== next.activeTabId) return next.bytes;
  const changed = next.rowCommands.filter((row, index) => row !== previous.rowCommands[index]);
  if (changed.length === 0 && previous.cursorCommand === next.cursorCommand) return new Uint8Array();
  return new TextEncoder().encode(`${ESC}?25l${changed.join("")}${next.cursorCommand}`);
}

interface TabRowEntry {
  readonly text: string;
  readonly active: boolean;
  readonly target: string;
}

function tabRowEntries(input: WorkbenchFrameInput): readonly TabRowEntry[] {
  const sessions = input.sessions;
  if (sessions !== undefined && input.activeSessionId !== undefined &&
      sessions.some((session) => session.agentSessionId === input.activeSessionId)) {
    return sessions.map((session) => {
      const active = session.agentSessionId === input.activeSessionId;
      const label = [`${session.number}:${agentLabel(session.agent)}`, safeText(session.label), session.ended ? "ended" : ""]
        .filter((part) => part.length > 0).join(" ");
      return { text: active ? `[${label}]` : ` ${label} `, active, target: `session:${session.agentSessionId}` };
    });
  }
  return input.tabs.map((tab, index) => {
    const active = tab.id === input.activeTabId;
    const label = `${index + 1}:${agentLabel(tab.agent)} ${safeText(tab.label)}`;
    return { text: active ? `[${label}]` : ` ${label} `, active, target: `tab:${tab.id}` };
  });
}

/**
 * ` CUNA` on the left, the tabs on the right. Tabs that do not fit give way to
 * a `+k` count, but the active tab is always drawn: it is the one thing on the
 * row the person must never lose.
 */
function renderTabRow(
  entries: readonly TabRowEntry[],
  action: string | undefined,
  columns: number,
): { readonly line: string; readonly targets: readonly WorkbenchAppbarTarget[] } {
  const left = action === undefined ? " CUNA" : ` CUNA  [ ${safeText(action)} ]`;
  const gap = 2;
  const room = columns - displayCellWidth(left) - gap - 1;
  const widths = entries.map((entry) => displayCellWidth(entry.text));
  const total = (chosen: readonly number[], hidden: number): number =>
    chosen.reduce((sum, index) => sum + (widths[index] ?? 0), 0) + Math.max(0, chosen.length - 1) * gap +
    (hidden > 0 ? gap + `+${hidden}`.length : 0);
  let chosen = entries.map((_, index) => index);
  if (total(chosen, 0) > room) {
    const activeIndex = entries.findIndex((entry) => entry.active);
    chosen = activeIndex < 0 ? [] : [activeIndex];
    for (let index = 0; index < entries.length; index += 1) {
      if (index === activeIndex) continue;
      const candidate = [...chosen, index].sort((a, b) => a - b);
      if (total(candidate, entries.length - candidate.length) <= room) chosen = candidate;
    }
  }
  const hidden = entries.length - chosen.length;
  const parts = chosen.map((index) => entries[index]?.text ?? "");
  if (hidden > 0) parts.push(`+${hidden}`);
  const right = parts.join(" ".repeat(gap));
  const start = Math.max(displayCellWidth(left) + gap, columns - 1 - displayCellWidth(right));
  const line = truncate(`${left}${" ".repeat(Math.max(0, start - displayCellWidth(left)))}${right}`, columns);
  const targets: WorkbenchAppbarTarget[] = [];
  let column = start + 1;
  for (const index of chosen) {
    const width = widths[index] ?? 0;
    const entry = entries[index];
    if (entry !== undefined && column + width - 1 <= columns) {
      targets.push(Object.freeze({ row: 1, firstColumn: column, lastColumn: column + width - 1, target: entry.target }));
    }
    column += width + gap;
  }
  return { line, targets: Object.freeze(targets) };
}

/** Windows hosts get the copy/paste keys on the right of the second row when they fit. */
function withClipboardHint(line: string, columns: number, mouseReporting: boolean): string {
  if (process.platform !== "win32") return line;
  const hint = mouseReporting
    ? "Shift+drag select | Ctrl+Shift+C copy | Ctrl+Shift+V paste"
    : "Select text: Ctrl+Shift+C copy | Ctrl+Shift+V paste";
  const used = displayCellWidth(line.trimEnd());
  const start = columns - 1 - hint.length;
  if (start < used + 3) return line;
  return `${line.trimEnd()}${" ".repeat(start - used)}${hint}`;
}

function renderTruth(model: AppbarModel, agent: WorkbenchTab["agent"], columns: number): string {
  const values = [
    projection("terminal", model.attachment),
    providerAuthProjection(providerAuthLabel(agent), model.providerAuthentication),
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
  const provider = active === undefined ? "provider auth" : providerAuthLabel(active.agent);
  return truncate(` CUNA  ${identity}  \u00b7  ${projection("terminal", model.attachment)}  \u00b7  ${providerAuthProjection(provider, model.providerAuthentication)}`, columns);
}

function providerAuthProjection(label: string, value: TruthProjection<string>): string {
  return value.status === "stale"
    ? `${label} status not refreshed`
    : projection(label, value);
}

function projection(label: string, value: TruthProjection<string>): string {
  return value.status === "verified"
    ? `${label} ${humanStatus(value.value)}`
    : `${label} ${value.status}`;
}

function humanStatus(value: string): string {
  return safeText(value).replace(/[_-]+/gu, " ");
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
    case "opencode": return "OpenCode";
    case "shell": return "Shell";
  }
}

function providerAuthLabel(agent: WorkbenchTab["agent"]): string {
  return `${agentLabel(agent)} auth`;
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

function assertViewportRenderRuns(
  runs: readonly ViewportRenderRun[],
  cell: string,
  displayWidth: number,
  columns: number,
): void {
  let width = 0;
  for (const run of runs) {
    assertViewportCell(run.text, run.width, columns);
    assertViewportStyle(run.style);
    width += run.width;
  }
  if (width !== displayWidth || width > columns) {
    throw new WorkbenchRenderError("invalid_dimensions", "Styled viewport width does not match the selected terminal row.");
  }
  if (runs.map((run) => run.text).join("") !== cell) {
    throw new WorkbenchRenderError("binding_mismatch", "Styled viewport text does not match the selected terminal row.");
  }
}

function assertViewportStyle(style: ViewportCellStyle): void {
  for (const flag of [
    style.bold, style.dim, style.italic, style.underline, style.blink,
    style.inverse, style.invisible, style.strikethrough, style.overline,
  ]) {
    if (typeof flag !== "boolean") throw new WorkbenchRenderError("binding_mismatch", "A viewport style flag is invalid.");
  }
  for (const color of [style.foreground, style.background]) {
    if (color === null) continue;
    const maximum = color.mode === "palette" ? 0xff : color.mode === "rgb" ? 0xff_ffff : -1;
    if (!Number.isSafeInteger(color.value) || color.value < 0 || color.value > maximum) {
      throw new WorkbenchRenderError("binding_mismatch", "A viewport color is outside its admitted range.");
    }
  }
}

function renderStyledRuns(runs: readonly ViewportRenderRun[]): string {
  let result = "";
  let previous: ViewportCellStyle | undefined;
  for (const run of runs) {
    if (previous === undefined || !sameViewportStyle(previous, run.style)) {
      const parameters = styleParameters(run.style);
      result += `${ESC}0${parameters.length === 0 ? "" : `;${parameters.join(";")}`}m`;
      previous = run.style;
    }
    result += run.text;
  }
  return result;
}

function styleParameters(style: ViewportCellStyle): readonly string[] {
  const parameters: string[] = [];
  if (style.bold) parameters.push("1");
  if (style.dim) parameters.push("2");
  if (style.italic) parameters.push("3");
  if (style.underline) parameters.push("4");
  if (style.blink) parameters.push("5");
  if (style.inverse) parameters.push("7");
  if (style.invisible) parameters.push("8");
  if (style.strikethrough) parameters.push("9");
  if (style.overline) parameters.push("53");
  appendColor(parameters, "38", style.foreground);
  appendColor(parameters, "48", style.background);
  return parameters;
}

function appendColor(parameters: string[], prefix: "38" | "48", color: ViewportCellColor | null): void {
  if (color === null) return;
  if (color.mode === "palette") {
    parameters.push(prefix, "5", String(color.value));
    return;
  }
  parameters.push(
    prefix,
    "2",
    String((color.value >>> 16) & 0xff),
    String((color.value >>> 8) & 0xff),
    String(color.value & 0xff),
  );
}

function sameViewportStyle(left: ViewportCellStyle, right: ViewportCellStyle): boolean {
  return left.bold === right.bold && left.dim === right.dim && left.italic === right.italic &&
    left.underline === right.underline && left.blink === right.blink && left.inverse === right.inverse &&
    left.invisible === right.invisible && left.strikethrough === right.strikethrough && left.overline === right.overline &&
    sameViewportColor(left.foreground, right.foreground) && sameViewportColor(left.background, right.background);
}

function sameViewportColor(left: ViewportCellColor | null, right: ViewportCellColor | null): boolean {
  return left === right || (left !== null && right !== null && left.mode === right.mode && left.value === right.value);
}

function validateDimensions(columns: number, rows: number): void {
  if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) || columns < 20 || rows < 2) {
    throw new WorkbenchRenderError("invalid_dimensions", "Workbench dimensions are outside the admitted range.");
  }
}
