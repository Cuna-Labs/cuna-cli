import type { AppbarModel, TruthProjection } from "./appbar.js";
import type { ViewportCellColor, ViewportCellStyle, ViewportRenderRun, ViewportSnapshot } from "./viewport.js";

const ESC = "\u001b[";
const CUNA_ORANGE = "48;2;235;86;37";
const CUNA_ORANGE_DARK = "48;2;121;48;25";
const WHITE = "38;2;255;255;255";
const MUTED = "38;2;224;210;203";
const OSC = "\u001b]";
const ST = "\u001b\\";
const HYPERLINK_CLOSE = `${OSC}8;;${ST}`;
/** Marks a row whose writer content continues past the right edge of this window. */
export const CONTINUED_MARKER = "›";
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
  /**
   * The remote program asked for mouse reports, so Cuna forwards drags to it
   * and only the host's own Shift+drag selects. Otherwise Cuna selects.
   */
  readonly remoteMouse?: boolean;
  /** Cuna's own selection, as cell ranges [start, end) of viewport rows. */
  readonly selection?: readonly WorkbenchSelectionRow[];
  /** Link cells of viewport rows with their exact targets, painted as OSC 8 hyperlinks. */
  readonly links?: readonly WorkbenchLinkSpan[];
}

export interface WorkbenchLinkSpan {
  readonly row: number;
  readonly start: number;
  readonly end: number;
  readonly uri: string;
}

export interface WorkbenchSelectionRow {
  readonly row: number;
  readonly start: number;
  readonly end: number;
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
    const continued = viewport.continuedRows?.[row] === true;
    const cellColumns = continued ? viewport.columns - 1 : viewport.columns;
    assertViewportCell(cell, width, cellColumns);
    if (runs !== undefined) assertViewportRenderRuns(runs, cell, width, cellColumns);
    text += `${ESC}${row + 1};1H${ESC}0m${ESC}2K${runs === undefined ? cell : renderStyledRuns(runs)}` +
      (continued ? continuedMarker(row + 1, viewport.columns, false) : "");
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
        input.notice === undefined ? renderTruth(input.appbar, active.agent, input.columns) : truncateMarked(` ${safeText(input.notice)}`, input.columns),
        input.columns,
        input.mouseReporting === true,
        input.remoteMouse === true,
      ),
    ];
  } else {
    lines = [input.notice === undefined
      ? renderCompact(input.tabs, input.activeTabId, input.appbar, input.columns)
      : truncateMarked(` CUNA  ${safeText(input.notice)}`, input.columns)];
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
    const continued = active.viewport.continuedRows?.[row] === true;
    const cellColumns = continued ? input.columns - 1 : input.columns;
    assertViewportCell(cell, displayWidth, cellColumns);
    const renderRuns = active.viewport.renderRows?.[row];
    if (renderRuns !== undefined) assertViewportRenderRuns(renderRuns, cell, displayWidth, cellColumns);
    const rowLinks = input.links?.filter((span) => span.row === row && linkUriIsSafe(span.uri));
    const rendered = rowLinks !== undefined && rowLinks.length > 0
      ? renderLinkedRow(cell, color ? renderRuns : undefined, rowLinks, input.links as readonly WorkbenchLinkSpan[])
      : renderRuns === undefined || !color ? cell : renderStyledRuns(renderRuns);
    const selected = input.selection?.find((range) => range.row === row);
    rowCommands.push(`${ESC}${appbarRows + row + 1};1H${ESC}0m${ESC}2K${rendered}` +
      (continued ? continuedMarker(appbarRows + row + 1, input.columns, color) : "") +
      (selected === undefined ? "" : selectionHighlight(appbarRows + row + 1, cell, selected, cellColumns)));
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

/** Unconfirmed typed glyphs to paint over one viewport row; see predictive-echo.ts. */
export interface WorkbenchPredictionOverlay {
  readonly row: number;
  readonly column: number;
  readonly text: string;
  readonly cursorColumn: number;
  readonly cursor: "cursor" | "inverse";
}

/**
 * The same frame with predicted glyphs drawn dim and underlined after the
 * true row content. The overlay is appended to that row's own command, so a
 * frame without it differs in exactly that row and `workbenchUpdate` repaints
 * the true row: rollback is an ordinary repaint.
 */
export function withPredictionOverlay(frame: WorkbenchFrame, overlay: WorkbenchPredictionOverlay): WorkbenchFrame {
  const block = overlay.cursor === "inverse" ? 1 : 0;
  if (
    !Number.isSafeInteger(overlay.row) || !Number.isSafeInteger(overlay.column) ||
    overlay.row < 0 || overlay.row >= frame.viewportRows || overlay.column < 0 ||
    !/^[\x20-\x7e]+$/u.test(overlay.text) ||
    overlay.cursorColumn !== overlay.column + overlay.text.length ||
    overlay.cursorColumn + block > frame.columns
  ) {
    throw new WorkbenchRenderError("invalid_dimensions", "A predicted glyph lies outside the terminal viewport.");
  }
  const hostRow = frame.appbarRows + overlay.row + 1;
  const index = frame.appbarRows + overlay.row;
  const rowCommands = [...frame.rowCommands];
  rowCommands[index] = `${rowCommands[index] ?? ""}${ESC}${hostRow};${overlay.column + 1}H${ESC}0;2;4m${overlay.text}${ESC}0m` +
    (block === 1 ? `${ESC}7m ${ESC}0m` : "");
  const cursorCommand = overlay.cursor === "cursor" && overlay.cursorColumn < frame.columns
    ? `${ESC}0m${ESC}${hostRow};${overlay.cursorColumn + 1}H${ESC}?25h`
    : frame.cursorCommand;
  const text = `${ESC}?25l${ESC}H${rowCommands.join("")}${cursorCommand}`;
  return Object.freeze({
    ...frame,
    rowCommands: Object.freeze(rowCommands),
    cursorCommand,
    bytes: new TextEncoder().encode(text),
    text,
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
  const gap = 2;
  let left = action === undefined ? " CUNA" : ` CUNA  [ ${safeText(action)} ]`;
  const active = entries.find((entry) => entry.active);
  const activeIdentityWidth = active === undefined ? 0 : displayCellWidth(active.text.split(" ")[0] ?? "") + 2;
  const overflowWidth = entries.length > 1 ? gap + `+${entries.length - 1}`.length : 0;
  if (action !== undefined && columns - displayCellWidth(left) - gap - 1 < activeIdentityWidth + overflowWidth) {
    left = " CUNA";
  }
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
  const hiddenMarker = hidden > 0 ? `+${hidden}` : "";
  const parts = chosen.map((index) => entries[index]?.text ?? "");
  if (chosen.length === 1 && parts[0] !== undefined) {
    const available = Math.max(0, room - (hidden > 0 ? gap + displayCellWidth(hiddenMarker) : 0));
    if (displayCellWidth(parts[0]) > available) {
      // Keep the active number and agent at narrow admitted widths, with a
      // closing bracket and a hit target matching only the cells actually drawn.
      parts[0] = available >= 3 ? `${truncate(parts[0], available - 2)}…]` : truncate(parts[0], available);
    }
  }
  if (hidden > 0) parts.push(`+${hidden}`);
  const right = parts.join(" ".repeat(gap));
  const start = Math.max(displayCellWidth(left) + gap, columns - 1 - displayCellWidth(right));
  const line = truncate(`${left}${" ".repeat(Math.max(0, start - displayCellWidth(left)))}${right}`, columns);
  const targets: WorkbenchAppbarTarget[] = [];
  let column = start + 1;
  for (let position = 0; position < chosen.length; position += 1) {
    const index = chosen[position] as number;
    const width = displayCellWidth(parts[position] ?? "");
    const entry = entries[index];
    if (entry !== undefined && column + width - 1 <= columns) {
      targets.push(Object.freeze({ row: 1, firstColumn: column, lastColumn: column + width - 1, target: entry.target }));
    }
    column += width + gap;
  }
  return { line, targets: Object.freeze(targets) };
}

/** Windows hosts get the copy/paste keys on the right of the second row when they fit. */
function withClipboardHint(line: string, columns: number, mouseReporting: boolean, remoteMouse: boolean): string {
  if (process.platform !== "win32") return line;
  // Cuna reports the mouse so the bar is clickable; it then selects on a
  // plain drag itself, unless the remote program asked for the mouse. Only
  // then is the host's own Shift+drag the way to select.
  const hint = !mouseReporting
    ? "Select text: Ctrl+Shift+C copy | Ctrl+Shift+V paste"
    : remoteMouse
      ? "Agent uses the mouse: Shift+drag select | Ctrl+Shift+C copy | Ctrl+Shift+V paste"
      : "Drag to select and copy | Ctrl+click opens a link | Ctrl+Shift+V paste";
  const used = displayCellWidth(line.trimEnd());
  const start = columns - 1 - hint.length;
  if (start < used + 3) return line;
  return `${line.trimEnd()}${" ".repeat(start - used)}${hint}`;
}

function renderTruth(model: AppbarModel, agent: WorkbenchTab["agent"], columns: number): string {
  const values = [
    projection("terminal", model.attachment),
    providerAuthProjection(providerAuthLabel(agent), model.providerAuthentication, agent),
  ];
  if (model.cost !== undefined) values.push(metric("cost", model.cost, (value) => `$${value.toFixed(2)}`));
  if (model.tokensSaved !== undefined) values.push(metric("tokens saved", model.tokensSaved, String));
  return truncateMarked(` ${values.join("  \u00b7  ")}`, columns);
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
  return truncateMarked(` CUNA  ${identity}  \u00b7  ${projection("terminal", model.attachment)}  \u00b7  ${providerAuthProjection(provider, model.providerAuthentication, active?.agent)}`, columns);
}

function providerAuthProjection(label: string, value: TruthProjection<string>, agent?: WorkbenchTab["agent"]): string {
  // OpenCode's default model needs no provider credential; "login required"
  // would send its user to a sign-in that is optional.
  if (agent === "opencode" && value.status === "verified" && value.value === "login_required") {
    return "OpenCode default model (no sign-in needed)";
  }
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

/** Like truncate, but a line cut short ends in "…" so the cut is never silent. */
function truncateMarked(value: string, columns: number): string {
  if (displayCellWidth(value) <= columns) return value;
  return `${truncate(value, columns - 1)}…`;
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

/**
 * One viewport row with its link cells wrapped in OSC 8 hyperlinks. Rows of
 * one link share an id so the host treats them as one link. Cell text and
 * styles are the row's own; only the hyperlink attribute is added.
 */
function renderLinkedRow(
  cell: string,
  runs: readonly ViewportRenderRun[] | undefined,
  links: readonly WorkbenchLinkSpan[],
  frameLinks: readonly WorkbenchLinkSpan[],
): string {
  const pieces: { column: number; text: string; style: ViewportCellStyle | undefined }[] = [];
  let column = 0;
  for (const run of runs ?? [{ text: cell, width: displayCellWidth(cell), style: undefined }]) {
    for (const item of GRAPHEME_SEGMENTER.segment(run.text)) {
      const width = graphemeCellWidth(item.segment);
      const previous = pieces.at(-1);
      if (width === 0 && previous !== undefined) {
        previous.text += item.segment;
        continue;
      }
      pieces.push({ column, text: item.segment, style: run.style });
      column += width;
    }
  }
  const uris = [...new Set(frameLinks.map((span) => span.uri))];
  let text = "";
  let style: ViewportCellStyle | undefined;
  let open: WorkbenchLinkSpan | undefined;
  for (const piece of pieces) {
    const span = links.find((candidate) => piece.column >= candidate.start && piece.column < candidate.end);
    if (span?.uri !== open?.uri) {
      if (open !== undefined) text += HYPERLINK_CLOSE;
      if (span !== undefined) text += `${OSC}8;id=cuna-${uris.indexOf(span.uri)};${span.uri}${ST}`;
      open = span;
    }
    if (piece.style !== undefined && (style === undefined || !sameViewportStyle(style, piece.style))) {
      const parameters = styleParameters(piece.style);
      text += `${ESC}0${parameters.length === 0 ? "" : `;${parameters.join(";")}`}m`;
      style = piece.style;
    }
    text += piece.text;
  }
  if (open !== undefined) text += HYPERLINK_CLOSE;
  return text;
}

/** A host hyperlink carries only a bounded http(s) URL of printable characters. */
function linkUriIsSafe(uri: string): boolean {
  return uri.length <= 2_048 && /^https?:\/\/[^\p{Cc}\s]+$/u.test(uri);
}

/**
 * Cuna's selection over one row: the selected cells again, inverse, drawn
 * over the row. Cells past the row's content are blanks; a wide glyph the
 * range only partly covers is drawn whole.
 */
function selectionHighlight(hostRow: number, cell: string, range: WorkbenchSelectionRow, columns: number): string {
  const cells: { readonly column: number; readonly text: string; readonly width: number }[] = [];
  let column = 0;
  for (const item of GRAPHEME_SEGMENTER.segment(cell)) {
    const width = graphemeCellWidth(item.segment);
    if (width === 0) continue;
    cells.push({ column, text: item.segment, width });
    column += width;
  }
  const end = Math.min(columns, Math.max(range.start, range.end));
  let start = Math.max(0, range.start);
  const straddled = cells.find((item) => item.column < start && item.column + item.width > start);
  if (straddled !== undefined) start = straddled.column;
  if (start >= end) return "";
  let text = "";
  let at = start;
  for (const item of cells) {
    if (item.column < start || item.column >= end || item.column + item.width > columns) continue;
    text += " ".repeat(Math.max(0, item.column - at)) + item.text;
    at = item.column + item.width;
  }
  text += " ".repeat(Math.max(0, end - at));
  return `${ESC}${hostRow};${start + 1}H${ESC}0;7m${text}${ESC}0m`;
}

/**
 * Trusted chrome in the last host column of a row the host cannot show whole:
 * the writer's line continues past this window. It is drawn by Cuna, never
 * taken from remote cells, and occupies the cell the projection left free.
 */
function continuedMarker(hostRow: number, columns: number, color: boolean): string {
  return `${ESC}${hostRow};${columns}H${ESC}0m${color ? `${ESC}1;38;2;235;86;37m` : ""}${CONTINUED_MARKER}${ESC}0m`;
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
