import type { AttachmentIdentity } from "./resume.js";

export const MAX_VIEWPORT_CELLS = 250_000;
export const MAX_VIEWPORT_TABS = 32;

export interface ViewportBinding extends AttachmentIdentity {
  readonly fencingGeneration: number;
}

export interface ViewportModes {
  readonly bracketedPaste: boolean;
  readonly mouse: boolean;
  readonly alternateScreen: boolean;
  readonly cursorVisible: boolean;
}

export interface ViewportCellColor {
  readonly mode: "palette" | "rgb";
  readonly value: number;
}

export interface ViewportCellStyle {
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly blink: boolean;
  readonly inverse: boolean;
  readonly invisible: boolean;
  readonly strikethrough: boolean;
  readonly overline: boolean;
  readonly foreground: ViewportCellColor | null;
  readonly background: ViewportCellColor | null;
}

/** A locally parsed run of terminal cells. Remote escape bytes never enter it. */
export interface ViewportRenderRun {
  readonly text: string;
  readonly width: number;
  readonly style: ViewportCellStyle;
}

export interface ViewportSnapshot {
  readonly tabId: string;
  readonly binding: ViewportBinding;
  readonly columns: number;
  readonly rows: number;
  readonly outputSequence: bigint;
  readonly replayCursor: bigint;
  readonly cells: readonly string[];
  /** Safe, structured SGR state recovered by the local VTE for each visible row. */
  readonly renderRows?: readonly (readonly ViewportRenderRun[])[];
  /** Display columns occupied by each rendered row, as measured by the VTE. */
  readonly displayWidths: readonly number[];
  readonly cursorX: number;
  readonly cursorY: number;
  readonly modes: ViewportModes;
}

export class ViewportIsolationError extends Error {
  readonly code: "tab_limit" | "duplicate_tab" | "unknown_tab" | "binding_mismatch" | "frame_regression" | "viewport_limit";

  constructor(code: ViewportIsolationError["code"], message: string) {
    super(message);
    this.name = "ViewportIsolationError";
    this.code = code;
  }
}

export class ViewportRegistry {
  readonly #tabs = new Map<string, ViewportSnapshot>();
  #activeTabId: string | undefined;

  open(tabId: string, binding: ViewportBinding, columns: number, rows: number): ViewportSnapshot {
    if (this.#tabs.size >= MAX_VIEWPORT_TABS) throw new ViewportIsolationError("tab_limit", "The viewport tab limit was reached.");
    if (this.#tabs.has(tabId)) throw new ViewportIsolationError("duplicate_tab", "The viewport tab already exists.");
    validateDimensions(columns, rows);
    validateBinding(binding);
    const snapshot = freezeSnapshot({
      tabId,
      binding,
      columns,
      rows,
      outputSequence: 0n,
      replayCursor: 0n,
      cells: Object.freeze(Array.from({ length: rows }, () => "")),
      displayWidths: Object.freeze(Array.from({ length: rows }, () => 0)),
      cursorX: 0,
      cursorY: 0,
      modes: Object.freeze({ bracketedPaste: false, mouse: false, alternateScreen: false, cursorVisible: true }),
    });
    this.#tabs.set(tabId, snapshot);
    this.#activeTabId ??= tabId;
    return snapshot;
  }

  select(tabId: string): ViewportSnapshot {
    const tab = this.require(tabId);
    this.#activeTabId = tabId;
    return tab;
  }

  close(tabId: string): void {
    this.require(tabId);
    this.#tabs.delete(tabId);
    if (this.#activeTabId === tabId) this.#activeTabId = this.#tabs.keys().next().value as string | undefined;
  }

  applyRenderedFrame(input: {
    readonly tabId: string;
    readonly binding: ViewportBinding;
    readonly outputSequence: bigint;
    readonly replayCursor: bigint;
    readonly cells: readonly string[];
    readonly renderRows?: readonly (readonly ViewportRenderRun[])[];
    readonly displayWidths?: readonly number[];
    readonly cursorX?: number;
    readonly cursorY?: number;
    readonly modes: ViewportModes;
  }): ViewportSnapshot {
    const current = this.require(input.tabId);
    if (!sameBinding(current.binding, input.binding)) {
      throw new ViewportIsolationError("binding_mismatch", "Rendered cells target another AgentSession or PTY generation.");
    }
    if (input.outputSequence <= current.outputSequence || input.replayCursor < current.replayCursor) {
      throw new ViewportIsolationError("frame_regression", "Viewport sequence state cannot move backward.");
    }
    const displayWidths = input.displayWidths ?? input.cells.map((row) => [...row].length);
    const cursorX = input.cursorX ?? current.cursorX;
    const cursorY = input.cursorY ?? current.cursorY;
    if (
      input.cells.length > current.rows ||
      displayWidths.length !== input.cells.length ||
      input.cells.some((row) => containsHostControl(row)) ||
      displayWidths.some((width) => !Number.isSafeInteger(width) || width < 0 || width > current.columns) ||
      !Number.isSafeInteger(cursorX) || cursorX < 0 || cursorX > current.columns ||
      !Number.isSafeInteger(cursorY) || cursorY < 0 || cursorY >= current.rows
    ) {
      throw new ViewportIsolationError("viewport_limit", "Rendered cells exceed their isolated viewport bounds.");
    }
    if (input.renderRows !== undefined) validateRenderRows(input.renderRows, input.cells, displayWidths, current.columns);
    const next = freezeSnapshot({
      ...current,
      outputSequence: input.outputSequence,
      replayCursor: input.replayCursor,
      cells: Object.freeze([...input.cells]),
      ...(input.renderRows === undefined ? {} : { renderRows: freezeRenderRows(input.renderRows) }),
      displayWidths: Object.freeze([...displayWidths]),
      cursorX,
      cursorY,
      modes: Object.freeze({ ...input.modes }),
    });
    this.#tabs.set(input.tabId, next);
    return next;
  }

  resize(tabId: string, columns: number, rows: number): ViewportSnapshot {
    validateDimensions(columns, rows);
    const current = this.require(tabId);
    const cells = current.cells.slice(0, rows).map((row) => [...row].slice(0, columns).join(""));
    const displayWidths = current.displayWidths.slice(0, rows).map((width) => Math.min(width, columns));
    // Styled runs are terminal-column based. Drop them until the owning VTE
    // supplies its authoritative local reflow for the new dimensions.
    const { renderRows: _renderRows, ...withoutRenderRows } = current;
    const next = freezeSnapshot({
      ...withoutRenderRows,
      columns,
      rows,
      cells: Object.freeze(cells),
      displayWidths: Object.freeze(displayWidths),
      cursorX: Math.min(current.cursorX, columns),
      cursorY: Math.min(current.cursorY, rows - 1),
    });
    this.#tabs.set(tabId, next);
    return next;
  }

  applyLocalReflow(input: {
    readonly tabId: string;
    readonly binding: ViewportBinding;
    readonly outputSequence: bigint;
    readonly replayCursor: bigint;
    readonly cells: readonly string[];
    readonly renderRows?: readonly (readonly ViewportRenderRun[])[];
    readonly displayWidths: readonly number[];
    readonly cursorX: number;
    readonly cursorY: number;
    readonly modes: ViewportModes;
  }): ViewportSnapshot {
    const current = this.require(input.tabId);
    if (!sameBinding(current.binding, input.binding)) {
      throw new ViewportIsolationError("binding_mismatch", "Local reflow targets another terminal generation.");
    }
    if (input.outputSequence !== current.outputSequence || input.replayCursor !== current.replayCursor) {
      throw new ViewportIsolationError("frame_regression", "Local reflow cannot invent or change remote sequence truth.");
    }
    return this.#replaceCells(current, input);
  }

  active(): ViewportSnapshot | undefined {
    return this.#activeTabId === undefined ? undefined : this.require(this.#activeTabId);
  }

  require(tabId: string): ViewportSnapshot {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) throw new ViewportIsolationError("unknown_tab", "The viewport tab does not exist.");
    return tab;
  }

  list(): readonly ViewportSnapshot[] {
    return Object.freeze([...this.#tabs.values()]);
  }

  #replaceCells(
    current: ViewportSnapshot,
    input: {
      readonly cells: readonly string[];
      readonly renderRows?: readonly (readonly ViewportRenderRun[])[];
      readonly displayWidths: readonly number[];
      readonly cursorX: number;
      readonly cursorY: number;
      readonly modes: ViewportModes;
    },
  ): ViewportSnapshot {
    if (
      input.cells.length > current.rows ||
      input.displayWidths.length !== input.cells.length ||
      input.cells.some((row) => containsHostControl(row)) ||
      input.displayWidths.some((width) => !Number.isSafeInteger(width) || width < 0 || width > current.columns) ||
      !Number.isSafeInteger(input.cursorX) || input.cursorX < 0 || input.cursorX > current.columns ||
      !Number.isSafeInteger(input.cursorY) || input.cursorY < 0 || input.cursorY >= current.rows
    ) {
      throw new ViewportIsolationError("viewport_limit", "Rendered cells exceed their isolated viewport bounds.");
    }
    if (input.renderRows !== undefined) validateRenderRows(input.renderRows, input.cells, input.displayWidths, current.columns);
    const next = freezeSnapshot({
      ...current,
      cells: Object.freeze([...input.cells]),
      ...(input.renderRows === undefined ? {} : { renderRows: freezeRenderRows(input.renderRows) }),
      displayWidths: Object.freeze([...input.displayWidths]),
      cursorX: input.cursorX,
      cursorY: input.cursorY,
      modes: Object.freeze({ ...input.modes }),
    });
    this.#tabs.set(current.tabId, next);
    return next;
  }
}

function containsHostControl(value: string): boolean {
  // A VTE adapter must resolve control sequences to cells. Passing ESC, C1, or
  // host control characters here would reintroduce the appbar escape path.
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))) return true;
  }
  return false;
}

function validateDimensions(columns: number, rows: number): void {
  if (
    !Number.isSafeInteger(columns) ||
    !Number.isSafeInteger(rows) ||
    columns < 1 ||
    rows < 1 ||
    columns * rows > MAX_VIEWPORT_CELLS
  ) {
    throw new ViewportIsolationError("viewport_limit", "The viewport dimensions exceed the cell budget.");
  }
}

function validateBinding(binding: ViewportBinding): void {
  for (const value of [binding.userId, binding.machineId, binding.agentSessionId, binding.processEpoch]) {
    if (value.length === 0 || value.length > 256) throw new ViewportIsolationError("binding_mismatch", "The viewport binding is invalid.");
  }
  if (!Number.isSafeInteger(binding.fencingGeneration) || binding.fencingGeneration < 1) {
    throw new ViewportIsolationError("binding_mismatch", "The viewport fence is invalid.");
  }
}

function sameBinding(left: ViewportBinding, right: ViewportBinding): boolean {
  return (
    left.userId === right.userId &&
    left.machineId === right.machineId &&
    left.agentSessionId === right.agentSessionId &&
    left.processEpoch === right.processEpoch &&
    left.fencingGeneration === right.fencingGeneration
  );
}

function freezeSnapshot(snapshot: ViewportSnapshot): ViewportSnapshot {
  return Object.freeze({
    ...snapshot,
    binding: Object.freeze({ ...snapshot.binding }),
    cells: Object.freeze([...snapshot.cells]),
    ...(snapshot.renderRows === undefined ? {} : { renderRows: freezeRenderRows(snapshot.renderRows) }),
    displayWidths: Object.freeze([...snapshot.displayWidths]),
    modes: Object.freeze({ ...snapshot.modes }),
  });
}

function validateRenderRows(
  rows: readonly (readonly ViewportRenderRun[])[],
  cells: readonly string[],
  displayWidths: readonly number[],
  columns: number,
): void {
  if (rows.length !== cells.length) {
    throw new ViewportIsolationError("viewport_limit", "Styled viewport rows do not match the rendered cells.");
  }
  for (const [rowIndex, row] of rows.entries()) {
    let width = 0;
    for (const run of row) {
      if (!Number.isSafeInteger(run.width) || run.width < 1 || containsHostControl(run.text)) {
        throw new ViewportIsolationError("viewport_limit", "A styled viewport run is invalid.");
      }
      validateStyle(run.style);
      width += run.width;
    }
    const renderedText = row.map((run) => run.text).join("");
    if (renderedText !== cells[rowIndex]) {
      throw new ViewportIsolationError("viewport_limit", "Styled viewport text does not match the VTE cells.");
    }
    if (width !== (displayWidths[rowIndex] ?? -1) || width > columns) {
      throw new ViewportIsolationError("viewport_limit", "Styled viewport width does not match the VTE observation.");
    }
  }
}

function validateStyle(style: ViewportCellStyle): void {
  for (const color of [style.foreground, style.background]) {
    if (color === null) continue;
    const maximum = color.mode === "palette" ? 0xff : color.mode === "rgb" ? 0xff_ffff : -1;
    if (!Number.isSafeInteger(color.value) || color.value < 0 || color.value > maximum) {
      throw new ViewportIsolationError("viewport_limit", "A viewport color is outside its admitted range.");
    }
  }
}

function freezeRenderRows(rows: readonly (readonly ViewportRenderRun[])[]): readonly (readonly ViewportRenderRun[])[] {
  return Object.freeze(rows.map((row) => Object.freeze(row.map((run) => Object.freeze({
    text: run.text,
    width: run.width,
    style: Object.freeze({
      ...run.style,
      ...(run.style.foreground === null ? {} : { foreground: Object.freeze({ ...run.style.foreground }) }),
      ...(run.style.background === null ? {} : { background: Object.freeze({ ...run.style.background }) }),
    }),
  })))));
}
