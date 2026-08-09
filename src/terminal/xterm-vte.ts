import xtermHeadless from "@xterm/headless";

import type { Terminal as XtermTerminal } from "@xterm/headless";

import { MAX_TERMINAL_FRAME_BYTES } from "./codec.js";
import { MAX_VIEWPORT_CELLS, ViewportRegistry, type ViewportBinding, type ViewportSnapshot } from "./viewport.js";

const { Terminal } = xtermHeadless as unknown as { readonly Terminal: typeof XtermTerminal };
export const DEFAULT_XTERM_SCROLLBACK = 1_000;
export const MAX_XTERM_SCROLLBACK = 10_000;
export const MAX_XTERM_BUFFER_CELLS = 1_000_000;
export const MAX_XTERM_PENDING_WRITE_BYTES = MAX_TERMINAL_FRAME_BYTES * 2;
export const MAX_XTERM_RESPONSE_EVENTS_PER_WRITE = 64;
export const MAX_XTERM_RESPONSE_BYTES_PER_WRITE = 4_096;
export const MAX_XTERM_ACTIVE_VIEWPORTS = 4;
export const MAX_XTERM_GLOBAL_BUFFER_CELLS = 2_000_000;
export const MAX_XTERM_GLOBAL_PENDING_WRITE_BYTES = MAX_TERMINAL_FRAME_BYTES * 4;
const MAX_XTERM_RESPONSE_EVENTS_PER_SECOND = 256;
const MAX_XTERM_RESPONSE_BYTES_PER_SECOND = 16_384;
const XTERM_WRITE_TIMEOUT_MS = 5_000;
const DEFAULT_RESPONSE_DELIVERY_TIMEOUT_MS = 2_000;
const CONTAINED_OSC_IDENTIFIERS = Object.freeze([0, 1, 2, 8, 52] as const);

export interface XtermTerminalResponse {
  readonly tabId: string;
  readonly binding: ViewportBinding;
  readonly source: "data" | "binary";
  readonly bytes: Uint8Array;
  readonly signal: AbortSignal;
}

interface XtermResourceReservation {
  cells: number;
  pendingBytes: number;
}

export class XtermResourceBudget {
  readonly #reservations = new Map<string, XtermResourceReservation>();

  reserve(tabId: string, cells: number): void {
    if (this.#reservations.has(tabId)) throw new Error("The rich terminal tab already owns a resource reservation.");
    if (this.#reservations.size >= MAX_XTERM_ACTIVE_VIEWPORTS) {
      throw new RangeError(`At most ${MAX_XTERM_ACTIVE_VIEWPORTS} rich terminal viewports may be active.`);
    }
    if (this.#totalCells() + cells > MAX_XTERM_GLOBAL_BUFFER_CELLS) {
      throw new RangeError(`Rich terminal viewports exceed the ${MAX_XTERM_GLOBAL_BUFFER_CELLS}-cell global budget.`);
    }
    this.#reservations.set(tabId, { cells, pendingBytes: 0 });
  }

  resize(tabId: string, cells: number): void {
    const reservation = this.#require(tabId);
    if (this.#totalCells() - reservation.cells + cells > MAX_XTERM_GLOBAL_BUFFER_CELLS) {
      throw new RangeError(`Rich terminal viewports exceed the ${MAX_XTERM_GLOBAL_BUFFER_CELLS}-cell global budget.`);
    }
    reservation.cells = cells;
  }

  reservePending(tabId: string, bytes: number): () => void {
    const reservation = this.#require(tabId);
    if (this.#totalPendingBytes() + bytes > MAX_XTERM_GLOBAL_PENDING_WRITE_BYTES) {
      throw new RangeError(`Rich terminal output exceeds the ${MAX_XTERM_GLOBAL_PENDING_WRITE_BYTES}-byte global pending budget.`);
    }
    reservation.pendingBytes += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      reservation.pendingBytes -= bytes;
    };
  }

  release(tabId: string): void {
    this.#reservations.delete(tabId);
  }

  #require(tabId: string): XtermResourceReservation {
    const reservation = this.#reservations.get(tabId);
    if (reservation === undefined) throw new Error("The rich terminal tab has no resource reservation.");
    return reservation;
  }

  #totalCells(): number {
    return [...this.#reservations.values()].reduce((total, item) => total + item.cells, 0);
  }

  #totalPendingBytes(): number {
    return [...this.#reservations.values()].reduce((total, item) => total + item.pendingBytes, 0);
  }
}

const REGISTRY_RESOURCE_BUDGETS = new WeakMap<ViewportRegistry, XtermResourceBudget>();

export interface XtermViewportOptions {
  readonly tabId: string;
  readonly binding: ViewportBinding;
  readonly columns: number;
  readonly rows: number;
  readonly registry: ViewportRegistry;
  readonly onTerminalResponse?: (response: XtermTerminalResponse) => void | Promise<void>;
  readonly scrollback?: number;
  readonly clock?: () => number;
  readonly responseDeliveryTimeoutMs?: number;
  readonly resourceBudget?: XtermResourceBudget;
}

export class XtermViewportAdapter {
  readonly #tabId: string;
  readonly #binding: ViewportBinding;
  readonly #registry: ViewportRegistry;
  readonly #terminal: XtermTerminal;
  readonly #encoder = new TextEncoder();
  readonly #scrollback: number;
  readonly #onTerminalResponse: XtermViewportOptions["onTerminalResponse"];
  readonly #clock: () => number;
  readonly #responseDeliveryTimeoutMs: number;
  readonly #resourceBudget: XtermResourceBudget;
  readonly #responseAbort = new AbortController();
  #writeTail: Promise<void> = Promise.resolve();
  #pendingWriteBytes = 0;
  #responseBatch: XtermTerminalResponse[] | undefined;
  #responseBatchBytes = 0;
  #responseOverflow = false;
  #responseWindowStartedAt = 0;
  #responseWindowEvents = 0;
  #responseWindowBytes = 0;
  #cursorVisible = true;
  #disposed = false;

  constructor(options: XtermViewportOptions) {
    const scrollback = options.scrollback ?? DEFAULT_XTERM_SCROLLBACK;
    if (!Number.isSafeInteger(scrollback) || scrollback < 0 || scrollback > MAX_XTERM_SCROLLBACK) {
      throw new RangeError(`Terminal scrollback must be an integer between 0 and ${MAX_XTERM_SCROLLBACK}.`);
    }
    assertBufferBudget(options.columns, options.rows, scrollback);
    const responseDeliveryTimeoutMs = options.responseDeliveryTimeoutMs ?? DEFAULT_RESPONSE_DELIVERY_TIMEOUT_MS;
    if (!Number.isSafeInteger(responseDeliveryTimeoutMs) || responseDeliveryTimeoutMs < 1 || responseDeliveryTimeoutMs > 10_000) {
      throw new RangeError("Terminal response delivery timeout must be between 1 and 10000 milliseconds.");
    }
    this.#tabId = options.tabId;
    this.#binding = Object.freeze({ ...options.binding });
    this.#registry = options.registry;
    this.#scrollback = scrollback;
    this.#onTerminalResponse = options.onTerminalResponse;
    this.#clock = options.clock ?? Date.now;
    this.#responseDeliveryTimeoutMs = responseDeliveryTimeoutMs;
    this.#resourceBudget = options.resourceBudget ?? registryResourceBudget(options.registry);
    this.#responseWindowStartedAt = this.#clock();
    const cells = bufferCells(options.columns, options.rows, scrollback);
    this.#resourceBudget.reserve(options.tabId, cells);
    try {
      this.#registry.open(options.tabId, this.#binding, options.columns, options.rows);
      this.#terminal = new Terminal({
        cols: options.columns,
        rows: options.rows,
        // @xterm/headless gates buffer and parser inspection behind this flag.
        // Keep that unstable surface confined to this adapter and exact package pin.
        allowProposedApi: true,
        scrollback,
        convertEol: false,
      });
    } catch (error) {
      this.#resourceBudget.release(options.tabId);
      try { this.#registry.close(options.tabId); } catch { /* the registry may not have opened */ }
      throw error;
    }
    for (const identifier of CONTAINED_OSC_IDENTIFIERS) {
      // Runa renders cells only. Consuming non-cell metadata prevents remote
      // title, hyperlink, and clipboard state from entering trusted host UI or
      // being retained in the headless VTE link service.
      this.#terminal.parser.registerOscHandler(identifier, () => true);
    }
    this.#terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (params.some((value) => value === 25 || (Array.isArray(value) && value.includes(25)))) this.#cursorVisible = true;
      return false;
    });
    this.#terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (params.some((value) => value === 25 || (Array.isArray(value) && value.includes(25)))) this.#cursorVisible = false;
      return false;
    });
    if (options.onTerminalResponse !== undefined) {
      this.#terminal.onData((value) => this.#queueTerminalResponse("data", this.#encoder.encode(value)));
      this.#terminal.onBinary((value) => this.#queueTerminalResponse(
        "binary",
        Uint8Array.from(value, (character) => character.charCodeAt(0) & 0xff),
      ));
    }
  }

  snapshot(): ViewportSnapshot {
    this.#assertOpen();
    return this.#registry.require(this.#tabId);
  }

  async write(
    bytes: Uint8Array,
    outputSequence: bigint,
    replayCursor: bigint,
  ): Promise<ViewportSnapshot> {
    this.#assertOpen();
    if (bytes.byteLength > MAX_TERMINAL_FRAME_BYTES) {
      throw new RangeError(`Terminal output exceeds the ${MAX_TERMINAL_FRAME_BYTES}-byte frame limit.`);
    }
    if (this.#pendingWriteBytes + bytes.byteLength > MAX_XTERM_PENDING_WRITE_BYTES) {
      throw new RangeError(`Pending terminal output exceeds the ${MAX_XTERM_PENDING_WRITE_BYTES}-byte budget.`);
    }
    const payload = bytes.slice();
    const releaseGlobalPending = this.#resourceBudget.reservePending(this.#tabId, payload.byteLength);
    this.#pendingWriteBytes += payload.byteLength;
    const operation = this.#writeTail.then(() => this.#writeNow(payload, outputSequence, replayCursor));
    this.#writeTail = operation.then(() => undefined, () => undefined);
    try {
      return await operation;
    } finally {
      this.#pendingWriteBytes -= payload.byteLength;
      releaseGlobalPending();
    }
  }

  async resize(columns: number, rows: number): Promise<ViewportSnapshot> {
    this.#assertOpen();
    assertBufferBudget(columns, rows, this.#scrollback);
    const operation = this.#writeTail.then(() => this.#resizeNow(columns, rows));
    this.#writeTail = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  #resizeNow(columns: number, rows: number): ViewportSnapshot {
    this.#assertOpen();
    const previousCells = bufferCells(this.#terminal.cols, this.#terminal.rows, this.#scrollback);
    this.#resourceBudget.resize(this.#tabId, bufferCells(columns, rows, this.#scrollback));
    try {
      this.#terminal.resize(columns, rows);
      this.#registry.resize(this.#tabId, columns, rows);
    } catch (error) {
      this.#resourceBudget.resize(this.#tabId, previousCells);
      throw error;
    }
    const current = this.#registry.require(this.#tabId);
    return this.#capture(current.outputSequence, current.replayCursor, true);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#responseAbort.abort(new Error("The virtual terminal was disposed."));
    this.#terminal.dispose();
    this.#resourceBudget.release(this.#tabId);
    try {
      this.#registry.close(this.#tabId);
    } catch {
      // The owning registry may already have closed the tab during fault cleanup.
    }
  }

  async #writeNow(bytes: Uint8Array, outputSequence: bigint, replayCursor: bigint): Promise<ViewportSnapshot> {
    this.#assertOpen();
    this.#responseBatch = [];
    this.#responseBatchBytes = 0;
    this.#responseOverflow = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => this.#terminal.write(bytes, resolve)),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("The virtual terminal write exceeded its processing deadline.")), XTERM_WRITE_TIMEOUT_MS);
        }),
      ]);
      if (this.#responseOverflow) {
        throw new Error("The remote terminal exceeded its protocol-response budget.");
      }
      const responses = this.#responseBatch;
      this.#responseBatch = undefined;
      if (this.#onTerminalResponse !== undefined) {
        for (const response of responses) {
          await withDeadline(
            Promise.resolve(this.#onTerminalResponse(response)),
            this.#responseDeliveryTimeoutMs,
            this.#responseAbort.signal,
          );
        }
      }
      return this.#capture(outputSequence, replayCursor);
    } catch (error) {
      this.dispose();
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      this.#responseBatch = undefined;
      this.#responseBatchBytes = 0;
    }
  }

  #queueTerminalResponse(source: XtermTerminalResponse["source"], bytes: Uint8Array): void {
    if (this.#responseBatch === undefined || this.#disposed) {
      this.#responseOverflow = true;
      return;
    }
    const now = this.#clock();
    if (now - this.#responseWindowStartedAt >= 1_000) {
      this.#responseWindowStartedAt = now;
      this.#responseWindowEvents = 0;
      this.#responseWindowBytes = 0;
    }
    this.#responseWindowEvents += 1;
    this.#responseWindowBytes += bytes.byteLength;
    this.#responseBatchBytes += bytes.byteLength;
    if (
      this.#responseBatch.length >= MAX_XTERM_RESPONSE_EVENTS_PER_WRITE ||
      this.#responseBatchBytes > MAX_XTERM_RESPONSE_BYTES_PER_WRITE ||
      this.#responseWindowEvents > MAX_XTERM_RESPONSE_EVENTS_PER_SECOND ||
      this.#responseWindowBytes > MAX_XTERM_RESPONSE_BYTES_PER_SECOND
    ) {
      this.#responseOverflow = true;
      return;
    }
    this.#responseBatch.push(Object.freeze({
      tabId: this.#tabId,
      binding: this.#binding,
      source,
      bytes: bytes.slice(),
      signal: this.#responseAbort.signal,
    }));
  }

  #capture(outputSequence: bigint, replayCursor: bigint, localReflow = false): ViewportSnapshot {
    const buffer = this.#terminal.buffer.active;
    const cells: string[] = [];
    const displayWidths: number[] = [];
    for (let row = 0; row < this.#terminal.rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row);
      cells.push(line?.translateToString(true) ?? "");
      let visibleWidth = 0;
      if (line !== undefined) {
        for (let column = 0; column < this.#terminal.cols; column += 1) {
          const cell = line.getCell(column);
          const characters = cell?.getChars() ?? "";
          if (characters !== "" && characters !== " ") {
            visibleWidth = column + Math.max(1, cell?.getWidth() ?? 1);
          }
        }
      }
      displayWidths.push(visibleWidth);
    }
    const frame = {
      tabId: this.#tabId,
      binding: this.#binding,
      outputSequence,
      replayCursor,
      cells,
      displayWidths,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      modes: {
        bracketedPaste: this.#terminal.modes.bracketedPasteMode,
        mouse: this.#terminal.modes.mouseTrackingMode !== "none",
        alternateScreen: buffer.type === "alternate",
        cursorVisible: this.#cursorVisible,
      },
    };
    return localReflow
      ? this.#registry.applyLocalReflow(frame)
      : this.#registry.applyRenderedFrame(frame);
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error("The xterm viewport adapter is disposed.");
  }
}

function assertBufferBudget(columns: number, rows: number, scrollback: number): void {
  if (
    !Number.isSafeInteger(columns) ||
    !Number.isSafeInteger(rows) ||
    columns < 1 ||
    rows < 1 ||
    columns * rows > MAX_VIEWPORT_CELLS ||
    bufferCells(columns, rows, scrollback) > MAX_XTERM_BUFFER_CELLS
  ) {
    throw new RangeError(`Terminal viewport and scrollback exceed the ${MAX_XTERM_BUFFER_CELLS}-cell memory budget.`);
  }
}

function bufferCells(columns: number, rows: number, scrollback: number): number {
  return columns * (rows + scrollback);
}

function registryResourceBudget(registry: ViewportRegistry): XtermResourceBudget {
  const existing = REGISTRY_RESOURCE_BUDGETS.get(registry);
  if (existing !== undefined) return existing;
  const created = new XtermResourceBudget();
  REGISTRY_RESOURCE_BUDGETS.set(registry, created);
  return created;
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Terminal protocol response delivery timed out.")), timeoutMs);
        abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Terminal protocol response delivery was cancelled."));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (abort !== undefined) signal.removeEventListener("abort", abort);
  }
}
