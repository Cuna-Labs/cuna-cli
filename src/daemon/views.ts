export interface SessionBinding {
  readonly userId: string;
  readonly machineId: string;
  readonly agentSessionId: string;
  readonly processEpoch: string;
  readonly fencingGeneration: number;
}

export type LocalViewState = "active" | "navigation" | "detached";

export interface LocalClientView {
  readonly viewId: string;
  readonly binding: SessionBinding;
  readonly state: LocalViewState;
  readonly columns: number;
  readonly rows: number;
}

export class ViewIsolationError extends Error {
  readonly code: "duplicate_view" | "unknown_view" | "stale_fence" | "navigation_active" | "invalid_view";

  constructor(code: ViewIsolationError["code"], message: string) {
    super(message);
    this.name = "ViewIsolationError";
    this.code = code;
  }
}

export class LocalClientViewRegistry {
  readonly #views = new Map<string, LocalClientView>();

  open(input: LocalClientView): LocalClientView {
    assertView(input);
    if (this.#views.has(input.viewId)) throw new ViewIsolationError("duplicate_view", "The local client view already exists.");
    const view = freezeView(input);
    this.#views.set(view.viewId, view);
    return view;
  }

  enterNavigation(viewId: string): LocalClientView {
    return this.#update(viewId, { state: "navigation" });
  }

  leaveNavigation(viewId: string): LocalClientView {
    return this.#update(viewId, { state: "active" });
  }

  resize(viewId: string, columns: number, rows: number): LocalClientView {
    assertDimensions(columns, rows);
    return this.#update(viewId, { columns, rows });
  }

  detach(viewId: string): LocalClientView {
    return this.#update(viewId, { state: "detached" });
  }

  routeInput(viewId: string, presentedFence: number): SessionBinding {
    const view = this.require(viewId);
    if (view.state === "navigation") {
      throw new ViewIsolationError("navigation_active", "Remote input is suspended while local navigation is open.");
    }
    if (view.state !== "active" || presentedFence !== view.binding.fencingGeneration) {
      throw new ViewIsolationError("stale_fence", "The local view cannot write with this attachment fence.");
    }
    // Returning the full immutable child binding prevents callers from routing by Machine ID alone.
    return view.binding;
  }

  require(viewId: string): LocalClientView {
    const view = this.#views.get(viewId);
    if (view === undefined) throw new ViewIsolationError("unknown_view", "The local client view does not exist.");
    return view;
  }

  list(): readonly LocalClientView[] {
    return Object.freeze([...this.#views.values()]);
  }

  #update(viewId: string, patch: Partial<Pick<LocalClientView, "state" | "columns" | "rows">>): LocalClientView {
    const current = this.require(viewId);
    if (current.state === "detached") throw new ViewIsolationError("stale_fence", "A detached local view is terminal.");
    const next = freezeView({ ...current, ...patch });
    this.#views.set(viewId, next);
    return next;
  }
}

function assertView(view: LocalClientView): void {
  for (const value of [
    view.viewId,
    view.binding.userId,
    view.binding.machineId,
    view.binding.agentSessionId,
    view.binding.processEpoch,
  ]) {
    if (value.length === 0 || value.length > 256 || value.includes("\0")) {
      throw new ViewIsolationError("invalid_view", "The local view identity is invalid.");
    }
  }
  if (!Number.isSafeInteger(view.binding.fencingGeneration) || view.binding.fencingGeneration < 1) {
    throw new ViewIsolationError("invalid_view", "The local view fence is invalid.");
  }
  assertDimensions(view.columns, view.rows);
}

function assertDimensions(columns: number, rows: number): void {
  if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) || columns < 1 || columns > 1000 || rows < 1 || rows > 1000) {
    throw new ViewIsolationError("invalid_view", "The local view dimensions are outside protocol bounds.");
  }
}

function freezeView(view: LocalClientView): LocalClientView {
  return Object.freeze({ ...view, binding: Object.freeze({ ...view.binding }) });
}
