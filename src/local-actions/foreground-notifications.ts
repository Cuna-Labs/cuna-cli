const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const DEDUP_WINDOW_MS = 60_000;
const REFILL_INTERVAL_MS = 10_000;
const BURST_CAPACITY = 3;

export type NotificationCategory = "action_required" | "task_complete" | "task_failed";

export interface NotificationShowArgs {
  readonly category: NotificationCategory;
  readonly title: string;
  readonly body: string;
  readonly focusRequestId: string;
}

export interface ForegroundNotificationHandle {
  dismiss(): void | Promise<void>;
}

export interface ForegroundNotificationPresenter {
  show(input: {
    readonly brand: "Cuna";
    readonly category: NotificationCategory;
    readonly title: string;
    readonly body: string;
    readonly actionLabel: "Open in Cuna";
    readonly onFocus: () => void;
    readonly signal: AbortSignal;
  }): Promise<ForegroundNotificationHandle>;
}

export interface ForegroundNotificationActionsOptions {
  readonly agentSessionId: string;
  readonly isForegroundAlive: () => boolean;
  readonly focusRequest: (requestId: string) => void;
  readonly presenter: ForegroundNotificationPresenter;
  readonly now?: () => number;
}

export type NotificationReceipt = Readonly<{ outcome: "shown" | "rate_limited" }>;

export class ForegroundNotificationError extends Error {
  public constructor(public readonly code: string) {
    super(`Cuna foreground notification failed: ${code}.`);
    this.name = "ForegroundNotificationError";
  }
}

export class ForegroundNotificationActions {
  readonly #options: ForegroundNotificationActionsOptions;
  readonly #now: () => number;
  readonly #controller = new AbortController();
  readonly #handles = new Set<ForegroundNotificationHandle>();
  readonly #pendingPresentations = new Set<Promise<ForegroundNotificationHandle>>();
  readonly #pendingDismissals = new Set<Promise<void>>();
  readonly #dedup = new Map<string, number>();
  #closed = false;
  #tokens = BURST_CAPACITY;
  #lastRefill: number;

  public constructor(options: ForegroundNotificationActionsOptions) {
    if (!IDENTIFIER.test(options.agentSessionId)) throw new ForegroundNotificationError("session_invalid");
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#lastRefill = this.#now();
  }

  public async show(args: NotificationShowArgs, agentSessionId: string): Promise<NotificationReceipt> {
    this.#assertAlive(agentSessionId);
    const sanitized = sanitizeNotification(args);
    const now = this.#now();
    this.#discardExpiredDedup(now);
    const key = `${agentSessionId}\0${sanitized.category}\0${sanitized.focusRequestId}`;
    if ((this.#dedup.get(key) ?? Number.NEGATIVE_INFINITY) + DEDUP_WINDOW_MS > now) {
      return Object.freeze({ outcome: "rate_limited" });
    }
    this.#refill(now);
    if (this.#tokens < 1) return Object.freeze({ outcome: "rate_limited" });
    this.#tokens -= 1;
    this.#dedup.set(key, now);
    const presentation = this.#options.presenter.show({
      brand: "Cuna",
      category: sanitized.category,
      title: sanitized.title,
      body: sanitized.body,
      actionLabel: "Open in Cuna",
      onFocus: () => {
        if (!this.#closed && this.#options.isForegroundAlive()) this.#options.focusRequest(sanitized.focusRequestId);
      },
      signal: this.#controller.signal,
    });
    this.#pendingPresentations.add(presentation);
    let handle: ForegroundNotificationHandle;
    try {
      handle = await presentation;
    } finally {
      this.#pendingPresentations.delete(presentation);
    }
    if (this.#closed || !this.#options.isForegroundAlive()) {
      const dismissal = Promise.resolve(handle.dismiss()).then(() => undefined, () => undefined);
      this.#pendingDismissals.add(dismissal);
      try { await dismissal; } finally { this.#pendingDismissals.delete(dismissal); }
      throw new ForegroundNotificationError("foreground_closed");
    }
    this.#handles.add(handle);
    return Object.freeze({ outcome: "shown" });
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller.abort();
    await Promise.allSettled(this.#pendingPresentations);
    await Promise.allSettled(this.#pendingDismissals);
    const handles = [...this.#handles];
    this.#handles.clear();
    this.#dedup.clear();
    await Promise.allSettled(handles.map(async (handle) => handle.dismiss()));
  }

  #assertAlive(agentSessionId: string): void {
    if (agentSessionId !== this.#options.agentSessionId) throw new ForegroundNotificationError("session_mismatch");
    if (this.#closed || !this.#options.isForegroundAlive()) throw new ForegroundNotificationError("foreground_closed");
  }

  #discardExpiredDedup(now: number): void {
    for (const [key, createdAt] of this.#dedup) {
      if (createdAt + DEDUP_WINDOW_MS <= now) this.#dedup.delete(key);
    }
  }

  #refill(now: number): void {
    const elapsed = now - this.#lastRefill;
    if (elapsed < REFILL_INTERVAL_MS) return;
    const recovered = Math.floor(elapsed / REFILL_INTERVAL_MS);
    this.#tokens = Math.min(BURST_CAPACITY, this.#tokens + recovered);
    this.#lastRefill += recovered * REFILL_INTERVAL_MS;
  }
}

function sanitizeNotification(args: NotificationShowArgs): NotificationShowArgs {
  const keys = Object.keys(args);
  if (keys.length !== 4 || keys.some((key) => !["category", "title", "body", "focusRequestId"].includes(key))) invalid();
  if (args.category !== "action_required" && args.category !== "task_complete" && args.category !== "task_failed") invalid();
  if (!IDENTIFIER.test(args.focusRequestId)) invalid();
  const title = sanitizeText(args.title, 80);
  const body = sanitizeText(args.body, 240);
  if (title.length === 0 || body.length === 0) invalid();
  return Object.freeze({ category: args.category, title, body, focusRequestId: args.focusRequestId });
}

function sanitizeText(value: string, maximumBytes: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximumBytes) invalid();
  return [...stripAnsiControlSequences(value)]
    .map((character) => unsafePresentationCodePoint(character.codePointAt(0)!) ? " " : character)
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}

function stripAnsiControlSequences(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.codePointAt(index) !== 0x1b || value[index + 1] !== "[") {
      output += value[index];
      continue;
    }
    let cursor = index + 2;
    while (cursor < value.length) {
      const point = value.codePointAt(cursor)!;
      cursor += 1;
      if (point >= 0x40 && point <= 0x7e) break;
    }
    index = cursor - 1;
  }
  return output;
}

function unsafePresentationCodePoint(point: number): boolean {
  return point <= 0x1f || (point >= 0x7f && point <= 0x9f) ||
    (point >= 0x202a && point <= 0x202e) || (point >= 0x2066 && point <= 0x2069);
}

function invalid(): never {
  throw new ForegroundNotificationError("request_invalid");
}

export const NOTIFICATION_DEDUP_WINDOW_MS = DEDUP_WINDOW_MS;
export const NOTIFICATION_REFILL_INTERVAL_MS = REFILL_INTERVAL_MS;
export const NOTIFICATION_BURST_CAPACITY = BURST_CAPACITY;
