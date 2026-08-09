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

export interface ViewportSnapshot {
  readonly tabId: string;
  readonly binding: ViewportBinding;
  readonly columns: number;
  readonly rows: number;
  readonly outputSequence: bigint;
  readonly replayCursor: bigint;
  readonly cells: readonly string[];
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
    const next = freezeSnapshot({
      ...current,
      outputSequence: input.outputSequence,
      replayCursor: input.replayCursor,
      cells: Object.freeze([...input.cells]),
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
    const next = freezeSnapshot({
      ...current,
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
    displayWidths: Object.freeze([...snapshot.displayWidths]),
    modes: Object.freeze({ ...snapshot.modes }),
  });
}
