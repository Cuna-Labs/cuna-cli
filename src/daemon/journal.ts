import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

import type { FenceToken } from "./lease.js";

export const JOURNAL_SCHEMA_VERSION = 1 as const;
export const MAX_JOURNAL_ENTRIES = 4096;
export const MAX_JOURNAL_FILE_BYTES = 8 * 1024 * 1024;

export type IntentState = "recorded" | "dispatched" | "uncertain" | "committed" | "rejected";

export interface IntentRecord {
  readonly intentId: string;
  readonly operation: string;
  readonly payloadDigest: string;
  readonly resourceId: string;
  readonly fenceGeneration: number;
  readonly state: IntentState;
  readonly recordedAt: number;
  readonly updatedAt: number;
  readonly dispositionReference?: string;
}

export interface JournalDocument {
  readonly schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  readonly minimumReaderVersion: typeof JOURNAL_SCHEMA_VERSION;
  readonly journalId: string;
  readonly revision: number;
  readonly entries: readonly IntentRecord[];
  readonly checksum: string;
}

interface JournalContent {
  readonly schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  readonly minimumReaderVersion: typeof JOURNAL_SCHEMA_VERSION;
  readonly journalId: string;
  readonly revision: number;
  readonly entries: readonly IntentRecord[];
}

export interface JournalStorage {
  load(): Promise<JournalDocument | undefined>;
  save(document: JournalDocument): Promise<void>;
}

export class JournalError extends Error {
  readonly code:
    | "journal_corrupt"
    | "journal_incompatible"
    | "journal_full"
    | "intent_conflict"
    | "invalid_transition"
    | "unsafe_path";

  constructor(code: JournalError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JournalError";
    this.code = code;
  }
}

export class DurableIntentJournal {
  readonly #storage: JournalStorage;
  #document: JournalDocument;

  private constructor(storage: JournalStorage, document: JournalDocument) {
    this.#storage = storage;
    this.#document = document;
  }

  static async open(storage: JournalStorage, journalId: string = randomUUID()): Promise<DurableIntentJournal> {
    const loaded = await storage.load();
    if (loaded !== undefined) {
      validateDocument(loaded);
      return new DurableIntentJournal(storage, freezeDocument(loaded));
    }
    assertIdentifier(journalId, "journalId");
    const content: JournalContent = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      minimumReaderVersion: JOURNAL_SCHEMA_VERSION,
      journalId,
      revision: 0,
      entries: [],
    };
    return new DurableIntentJournal(storage, freezeDocument(withChecksum(content)));
  }

  snapshot(): JournalDocument {
    return this.#document;
  }

  recoveryQueue(): readonly IntentRecord[] {
    return this.#document.entries.filter(
      (entry) => entry.state === "recorded" || entry.state === "dispatched" || entry.state === "uncertain",
    );
  }

  async recordIntent(input: {
    readonly intentId: string;
    readonly operation: string;
    readonly payloadDigest: string;
    readonly fence: FenceToken;
    readonly now: number;
  }): Promise<IntentRecord> {
    assertIdentifier(input.intentId, "intentId");
    assertIdentifier(input.operation, "operation");
    assertDigest(input.payloadDigest);
    const existing = this.#document.entries.find((entry) => entry.intentId === input.intentId);
    if (existing !== undefined) {
      if (
        existing.operation !== input.operation ||
        existing.payloadDigest !== input.payloadDigest ||
        existing.resourceId !== input.fence.resourceId ||
        existing.fenceGeneration !== input.fence.generation
      ) {
        throw new JournalError("intent_conflict", "The idempotency identity is already bound to different intent.");
      }
      return existing;
    }
    if (this.#document.entries.length >= MAX_JOURNAL_ENTRIES) {
      throw new JournalError("journal_full", "The durable-intent journal has reached its entry limit.");
    }
    const entry: IntentRecord = Object.freeze({
      intentId: input.intentId,
      operation: input.operation,
      payloadDigest: input.payloadDigest,
      resourceId: input.fence.resourceId,
      fenceGeneration: input.fence.generation,
      state: "recorded",
      recordedAt: input.now,
      updatedAt: input.now,
    });
    await this.#persist([...this.#document.entries, entry]);
    return this.require(input.intentId);
  }

  async markDispatched(intentId: string, now: number): Promise<IntentRecord> {
    return this.#transition(intentId, ["recorded"], "dispatched", now);
  }

  async markUncertain(intentId: string, now: number): Promise<IntentRecord> {
    return this.#transition(intentId, ["recorded", "dispatched"], "uncertain", now);
  }

  async recordDisposition(
    intentId: string,
    state: "committed" | "rejected",
    dispositionReference: string,
    now: number,
  ): Promise<IntentRecord> {
    assertIdentifier(dispositionReference, "dispositionReference");
    return this.#transition(
      intentId,
      ["recorded", "dispatched", "uncertain"],
      state,
      now,
      dispositionReference,
    );
  }

  require(intentId: string): IntentRecord {
    const record = this.#document.entries.find((entry) => entry.intentId === intentId);
    if (record === undefined) throw new JournalError("invalid_transition", "The intent does not exist.");
    return record;
  }

  async #transition(
    intentId: string,
    allowed: readonly IntentState[],
    state: IntentState,
    now: number,
    dispositionReference?: string,
  ): Promise<IntentRecord> {
    const current = this.require(intentId);
    if (!allowed.includes(current.state)) {
      if (current.state === state && current.dispositionReference === dispositionReference) return current;
      throw new JournalError("invalid_transition", `Intent cannot transition from ${current.state} to ${state}.`);
    }
    const next: IntentRecord = Object.freeze({
      ...current,
      state,
      updatedAt: now,
      ...(dispositionReference === undefined ? {} : { dispositionReference }),
    });
    await this.#persist(this.#document.entries.map((entry) => (entry.intentId === intentId ? next : entry)));
    return this.require(intentId);
  }

  async #persist(entries: readonly IntentRecord[]): Promise<void> {
    const content: JournalContent = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      minimumReaderVersion: JOURNAL_SCHEMA_VERSION,
      journalId: this.#document.journalId,
      revision: this.#document.revision + 1,
      entries,
    };
    const next = freezeDocument(withChecksum(content));
    await this.#storage.save(next);
    // Admission occurs only after the storage boundary confirms durability.
    this.#document = next;
  }
}

export class MemoryJournalStorage implements JournalStorage {
  document: JournalDocument | undefined;

  async load(): Promise<JournalDocument | undefined> {
    return this.document;
  }

  async save(document: JournalDocument): Promise<void> {
    this.document = document;
  }
}

export class AtomicFileJournalStorage implements JournalStorage {
  readonly #filePath: string;

  constructor(filePath: string) {
    if (!path.isAbsolute(filePath) || filePath.includes("\0")) {
      throw new JournalError("unsafe_path", "The journal path must be absolute.");
    }
    this.#filePath = filePath;
  }

  async load(): Promise<JournalDocument | undefined> {
    try {
      const stat = await lstat(this.#filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new JournalError("unsafe_path", "The journal path is not a regular file.");
      }
      if (stat.size > MAX_JOURNAL_FILE_BYTES) {
        throw new JournalError("journal_corrupt", "The journal file exceeds the recovery limit.");
      }
      const bytes = await readFile(this.#filePath);
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      validateDocument(parsed);
      return freezeDocument(parsed);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      if (error instanceof JournalError) throw error;
      throw new JournalError("journal_corrupt", "The journal cannot be recovered safely.", { cause: error });
    }
  }

  async save(document: JournalDocument): Promise<void> {
    validateDocument(document);
    const directory = path.dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(directory, `.${path.basename(this.#filePath)}.${process.pid}.${randomUUID()}.tmp`);
    const payload = Buffer.from(JSON.stringify(document), "utf8");
    if (payload.byteLength > MAX_JOURNAL_FILE_BYTES) {
      throw new JournalError("journal_full", "The serialized journal exceeds the durable file limit.");
    }
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.#filePath);
    try {
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      // Windows does not expose directory fsync through Node. File fsync plus
      // atomic rename remains the strongest portable primitive available here.
      if (process.platform !== "win32") throw error;
    }
  }
}

function withChecksum(content: JournalContent): JournalDocument {
  return { ...content, checksum: checksum(content) };
}

function checksum(content: JournalContent): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(content)).digest("hex")}`;
}

function freezeDocument(document: JournalDocument): JournalDocument {
  const entries = document.entries.map((entry) => Object.freeze({ ...entry }));
  return Object.freeze({ ...document, entries: Object.freeze(entries) });
}

function validateDocument(value: unknown): asserts value is JournalDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JournalError("journal_corrupt", "The journal root is invalid.");
  }
  const document = value as Partial<JournalDocument>;
  if (document.schemaVersion !== JOURNAL_SCHEMA_VERSION || document.minimumReaderVersion !== JOURNAL_SCHEMA_VERSION) {
    throw new JournalError("journal_incompatible", "The durable journal version is incompatible.");
  }
  if (
    typeof document.journalId !== "string" ||
    !Number.isSafeInteger(document.revision) ||
    document.revision! < 0 ||
    !Array.isArray(document.entries) ||
    document.entries.length > MAX_JOURNAL_ENTRIES ||
    typeof document.checksum !== "string"
  ) {
    throw new JournalError("journal_corrupt", "The journal envelope is malformed.");
  }
  const identifiers = new Set<string>();
  for (const entry of document.entries) {
    validateEntry(entry);
    if (identifiers.has(entry.intentId)) throw new JournalError("journal_corrupt", "The journal repeats an intent ID.");
    identifiers.add(entry.intentId);
  }
  const content: JournalContent = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    minimumReaderVersion: JOURNAL_SCHEMA_VERSION,
    journalId: document.journalId,
    revision: document.revision!,
    entries: document.entries,
  };
  if (document.checksum !== checksum(content)) {
    throw new JournalError("journal_corrupt", "The journal checksum is invalid.");
  }
}

function validateEntry(value: unknown): asserts value is IntentRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JournalError("journal_corrupt", "A journal entry is malformed.");
  }
  const entry = value as Partial<IntentRecord>;
  if (
    typeof entry.intentId !== "string" ||
    typeof entry.operation !== "string" ||
    typeof entry.payloadDigest !== "string" ||
    typeof entry.resourceId !== "string" ||
    !Number.isSafeInteger(entry.fenceGeneration) ||
    !INTENT_STATES.has(String(entry.state)) ||
    !Number.isFinite(entry.recordedAt) ||
    !Number.isFinite(entry.updatedAt) ||
    (entry.dispositionReference !== undefined && typeof entry.dispositionReference !== "string")
  ) {
    throw new JournalError("journal_corrupt", "A journal entry has invalid fields.");
  }
}

const INTENT_STATES: ReadonlySet<string> = new Set(["recorded", "dispatched", "uncertain", "committed", "rejected"]);

function assertIdentifier(value: string, name: string): void {
  if (value.length === 0 || value.length > 256 || value.includes("\0")) {
    throw new JournalError("intent_conflict", `${name} is invalid.`);
  }
}

function assertDigest(value: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new JournalError("intent_conflict", "payloadDigest must be a SHA-256 digest.");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
