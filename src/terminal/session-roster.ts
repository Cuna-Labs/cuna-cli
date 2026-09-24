import type { AgentSession } from "../api/contracts.js";
import { isAgentSessionGone } from "../runtime/terminal-client-identity.js";

/**
 * THE SESSIONS OF ONE MACHINE, AS THE TOP BAR NUMBERS THEM.
 *
 * A number is a promise: `Ctrl+] 2` and the tab labelled `2:` must name the
 * same AgentSession for as long as the run lasts. So an entry never moves and
 * is never removed; new sessions are appended, and a session that ends stays
 * where it was, marked ended. A session that was already gone when first seen
 * is not listed at all: a Machine can carry many finished sessions, and none of
 * them is somewhere the person can go.
 */

export type SessionRosterAgent = "claude-code" | "codex" | "opencode";

export interface SessionRosterEntry {
  /** 1-based and stable for the run. */
  readonly number: number;
  readonly agentSessionId: string;
  readonly agent: SessionRosterAgent;
  readonly label: string;
  readonly ended: boolean;
}

export interface SessionRoster {
  entries(): readonly SessionRosterEntry[];
  /** Called after every accepted change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

interface RosterRecord {
  readonly agentSessionId: string;
  readonly agent: SessionRosterAgent;
  readonly name: string;
  readonly folder: string;
  readonly createdAt: string;
  readonly ended: boolean;
  readonly rowVersion: number;
}

const LABEL_MAXIMUM = 40;

/**
 * Merge one successful listing into the previous roster. `sessions` is the
 * whole Machine listing; an entry missing from it is treated as ended (the
 * listing is authoritative about membership, and a missing session is not one
 * the person can attach to), but keeps its number.
 */
export function mergeSessionRoster(
  previous: readonly RosterRecord[],
  sessions: readonly AgentSession[],
): readonly RosterRecord[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const merged: RosterRecord[] = previous.map((record) => {
    const session = byId.get(record.agentSessionId);
    if (session === undefined) return record.ended ? record : Object.freeze({ ...record, ended: true });
    // Only a strictly newer row may change what is shown; an ended entry
    // stays ended, since a gone session cannot come back.
    if (session.rowVersion <= record.rowVersion || record.ended) return record;
    return recordFor(session, isAgentSessionGone(session));
  });
  const known = new Set(previous.map((record) => record.agentSessionId));
  const fresh = sessions
    .filter((session) => !known.has(session.id) && attachableAgent(session.agent) && !isAgentSessionGone(session))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  for (const session of fresh) merged.push(recordFor(session, false));
  return Object.freeze(merged);
}

/**
 * Numbers and labels for rendering. A name equal to the agent kind (the
 * journey names every session `claude-code`) says nothing next to the agent's
 * own label, so it is dropped. Equal displayed labels use the working folder's
 * last segment; when that also agrees, they use the id's first four characters.
 * The suffix survives the 40-character display limit.
 */
export function sessionRosterEntries(records: readonly RosterRecord[]): readonly SessionRosterEntry[] {
  const bases = records.map((record) => truncateLabel(record.name === record.agent ? "" : record.name));
  const baseCounts = countLabels(bases);
  const folderCounts = countLabels(records.map((record, index) => `${bases[index]}\u0000${record.folder}`));
  const labels = records.map((record, index) => {
    const base = bases[index] ?? "";
    if ((baseCounts.get(base) ?? 0) < 2) return base;
    const folderKey = `${base}\u0000${record.folder}`;
    const suffix = (folderCounts.get(folderKey) ?? 0) > 1 ? record.agentSessionId.slice(0, 4) : record.folder;
    return appendLabelSuffix(base, suffix);
  });
  const displayedCounts = countLabels(labels);
  return Object.freeze(records.map((record, index) => {
    const label = labels[index] ?? "";
    return Object.freeze({
      number: index + 1,
      agentSessionId: record.agentSessionId,
      agent: record.agent,
      label: (displayedCounts.get(label) ?? 0) > 1
        ? appendLabelSuffix(bases[index] ?? "", record.agentSessionId.slice(0, 4)) : label,
      ended: record.ended,
    });
  }));
}

export interface PollingSessionRosterOptions {
  /** Lists every AgentSession of the Machine (all pages). */
  readonly list: (signal: AbortSignal) => Promise<readonly AgentSession[]>;
  readonly intervalMs?: number;
}

/**
 * Polls the Machine's sessions while a terminal is attached. A failed listing
 * keeps the last confirmed roster: the bar never loses the session on screen
 * because one request failed.
 */
export class PollingSessionRoster implements SessionRoster {
  readonly #options: PollingSessionRosterOptions;
  readonly #listeners = new Set<() => void>();
  readonly #abort = new AbortController();
  #records: readonly RosterRecord[] = Object.freeze([]);
  #entries: readonly SessionRosterEntry[] = Object.freeze([]);
  #timer: NodeJS.Timeout | undefined;
  #refreshing: Promise<void> | undefined;

  constructor(options: PollingSessionRosterOptions) {
    const intervalMs = options.intervalMs ?? 10_000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 300_000) {
      throw new RangeError("Session roster refresh must be between 1 and 300 seconds.");
    }
    this.#options = Object.freeze({ ...options, intervalMs });
  }

  entries(): readonly SessionRosterEntry[] {
    return this.#entries;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** Refresh now and then on the interval. Idempotent. */
  start(): void {
    if (this.#timer !== undefined || this.#abort.signal.aborted) return;
    void this.refresh();
    this.#timer = setInterval(() => { void this.refresh(); }, this.#options.intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#abort.abort();
    this.#listeners.clear();
  }

  async refresh(): Promise<void> {
    if (this.#refreshing !== undefined) return await this.#refreshing;
    this.#refreshing = (async () => {
      let sessions: readonly AgentSession[];
      try {
        sessions = await this.#options.list(this.#abort.signal);
      } catch {
        return;
      }
      if (this.#abort.signal.aborted) return;
      const records = mergeSessionRoster(this.#records, sessions);
      const entries = sessionRosterEntries(records);
      this.#records = records;
      if (sameEntries(this.#entries, entries)) return;
      this.#entries = entries;
      for (const listener of this.#listeners) {
        try { listener(); } catch { /* a listener's failure is its own */ }
      }
    })();
    try {
      await this.#refreshing;
    } finally {
      this.#refreshing = undefined;
    }
  }
}

function recordFor(session: AgentSession, ended: boolean): RosterRecord {
  return Object.freeze({
    agentSessionId: session.id,
    agent: session.agent as SessionRosterAgent,
    name: cleanText(session.name),
    folder: cleanText(session.cwd.split(/[\\/]+/u).filter((part) => part.length > 0).at(-1) ?? ""),
    createdAt: session.createdAt,
    ended,
    rowVersion: session.rowVersion,
  });
}

function countLabels(labels: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return counts;
}

function appendLabelSuffix(base: string, suffix: string): string {
  if (suffix === "") return base;
  const shownSuffix = truncateLabel(suffix, LABEL_MAXIMUM - (base === "" ? 0 : 2));
  if (base === "") return shownSuffix;
  return `${truncateLabel(base, LABEL_MAXIMUM - [...shownSuffix].length - 1)} ${shownSuffix}`;
}

function attachableAgent(agent: AgentSession["agent"]): agent is SessionRosterAgent {
  return agent === "claude-code" || agent === "codex" || agent === "opencode";
}

function cleanText(value: string): string {
  return value.normalize("NFC").replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, " ").replace(/\s+/gu, " ").trim();
}

function truncateLabel(value: string, maximum = LABEL_MAXIMUM): string {
  const characters = [...value];
  return characters.length <= maximum ? value : `${characters.slice(0, maximum - 1).join("")}…`;
}

function sameEntries(left: readonly SessionRosterEntry[], right: readonly SessionRosterEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return other !== undefined && entry.agentSessionId === other.agentSessionId && entry.label === other.label &&
      entry.ended === other.ended && entry.agent === other.agent;
  });
}
