import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assertReadableSchema, assertWritableSchema, type DurableSchemaEnvelope } from "../workspace/schema.js";
import { workspaceError } from "../workspace/errors.js";

export type JournalOperationState =
  | "queued"
  | "sending"
  | "uncertain"
  | "acknowledged"
  | "applied"
  | "conflicted";

export interface JournalIntent {
  readonly operationId: string;
  readonly baseGeneration: number;
  readonly digest: string;
  readonly byteLength: number;
}

export interface JournalRecord extends JournalIntent {
  readonly recordSequence: number;
  readonly fence: number;
  readonly state: JournalOperationState;
  readonly intentHash: string;
  readonly previousChecksum: string;
  readonly checksum: string;
}

interface JournalMetadata extends DurableSchemaEnvelope {
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly lastFence: number;
}

interface LeaseRecord {
  readonly ownerId: string;
  readonly fence: number;
  readonly expiresAt: number;
}

export interface JournalInspection {
  readonly metadata: JournalMetadata;
  readonly records: readonly JournalRecord[];
  readonly requiresReconciliation: boolean;
  readonly reason?: string;
  readonly recoveryActions: readonly {
    readonly operationId: string;
    readonly action: "send" | "query_outcome" | "apply_receipt" | "none";
  }[];
}

const META_FILE = "journal.meta.json";
const RECORD_FILE = "journal.ndjson";
const LEASE_FILE = "writer.lease";

export class DurableSyncJournal {
  readonly #directory: string;
  readonly #ownerId: string;
  readonly #fence: number;
  readonly #leaseMs: number;
  readonly #clock: () => number;
  #metadata: JournalMetadata;
  #records: JournalRecord[];
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(input: {
    readonly directory: string;
    readonly ownerId: string;
    readonly fence: number;
    readonly leaseMs: number;
    readonly metadata: JournalMetadata;
    readonly records: JournalRecord[];
    readonly clock: () => number;
  }) {
    this.#directory = input.directory;
    this.#ownerId = input.ownerId;
    this.#fence = input.fence;
    this.#leaseMs = input.leaseMs;
    this.#metadata = input.metadata;
    this.#records = input.records;
    this.#clock = input.clock;
  }

  static async open(input: {
    readonly directory: string;
    readonly bindingId: string;
    readonly bindingGeneration: number;
    readonly ownerId: string;
    readonly leaseMs?: number;
    readonly now?: number;
    readonly clock?: () => number;
  }): Promise<DurableSyncJournal> {
    const leaseMs = input.leaseMs ?? 30_000;
    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw journalFailure("invalid_lease");
    await mkdir(input.directory, { recursive: true, mode: 0o700 });
    await chmod(input.directory, 0o700);
    const metadataPath = join(input.directory, META_FILE);
    let metadata = await readMetadata(metadataPath, input.bindingId, input.bindingGeneration);
    assertWritableSchema(metadata);
    const leasePath = join(input.directory, LEASE_FILE);
    await acquireLeaseFile(leasePath, input.ownerId, metadata.lastFence + 1, now, leaseMs);
    const fence = metadata.lastFence + 1;
    metadata = Object.freeze({ ...metadata, lastFence: fence });
    try {
      await atomicWriteJson(metadataPath, metadata);
      const inspection = await inspectSyncJournal(input.directory);
      if (inspection.requiresReconciliation) {
        throw journalFailure(inspection.reason ?? "journal_untrusted");
      }
      return new DurableSyncJournal({
        directory: input.directory,
        ownerId: input.ownerId,
        fence,
        leaseMs,
        metadata,
        records: [...inspection.records],
        clock: input.clock ?? Date.now,
      });
    } catch (error) {
      await releaseLeaseFile(leasePath, input.ownerId, fence);
      throw error;
    }
  }

  get fence(): number {
    return this.#fence;
  }

  get metadata(): DurableSchemaEnvelope & {
    readonly bindingId: string;
    readonly bindingGeneration: number;
  } {
    return Object.freeze({
      schemaVersion: this.#metadata.schemaVersion,
      minimumReaderVersion: this.#metadata.minimumReaderVersion,
      minimumWriterVersion: this.#metadata.minimumWriterVersion,
      bindingId: this.#metadata.bindingId,
      bindingGeneration: this.#metadata.bindingGeneration,
    });
  }

  get records(): readonly JournalRecord[] {
    return Object.freeze([...this.#records]);
  }

  async renew(now = Date.now()): Promise<void> {
    await this.#serialized(async () => {
      await this.#assertLease();
      await atomicWriteJson(join(this.#directory, LEASE_FILE), {
        ownerId: this.#ownerId,
        fence: this.#fence,
        expiresAt: now + this.#leaseMs,
      });
    });
  }

  async append(intent: JournalIntent): Promise<JournalRecord> {
    let result: JournalRecord | undefined;
    await this.#serialized(async () => {
      validateIntent(intent);
      const sameOperation = this.#records.filter((record) => record.operationId === intent.operationId);
      const intentHash = hashIntent(intent);
      if (sameOperation.some((record) => record.intentHash !== intentHash)) {
        throw workspaceError(
          "idempotency_conflict",
          "The operation identifier was reused for a different intent.",
          "conflict",
          "operation_id_reuse",
        );
      }
      const existing = sameOperation.at(-1);
      if (existing !== undefined) {
        result = existing;
        return;
      }
      result = await this.#appendRecord(intent, "queued", intentHash);
    });
    if (result === undefined) throw journalFailure("append_incomplete");
    return result;
  }

  async transition(operationId: string, state: JournalOperationState): Promise<JournalRecord> {
    let result: JournalRecord | undefined;
    await this.#serialized(async () => {
      const latest = [...this.#records].reverse().find((record) => record.operationId === operationId);
      if (latest === undefined) throw journalFailure("operation_unknown");
      if (latest.state === state) {
        result = latest;
        return;
      }
      if (!allowedTransition(latest.state, state)) throw journalFailure("invalid_transition");
      result = await this.#appendRecord(latest, state, latest.intentHash);
    });
    if (result === undefined) throw journalFailure("transition_incomplete");
    return result;
  }

  async close(): Promise<void> {
    await this.#serialized(async () => {
      await releaseLeaseFile(join(this.#directory, LEASE_FILE), this.#ownerId, this.#fence);
      this.#closed = true;
    }, true);
  }

  async #appendRecord(
    intent: JournalIntent,
    state: JournalOperationState,
    intentHash: string,
  ): Promise<JournalRecord> {
    await this.#assertLease();
    const previousChecksum = this.#records.at(-1)?.checksum ?? "0".repeat(64);
    const body = {
      operationId: intent.operationId,
      baseGeneration: intent.baseGeneration,
      digest: intent.digest,
      byteLength: intent.byteLength,
      recordSequence: this.#records.length + 1,
      fence: this.#fence,
      state,
      intentHash,
      previousChecksum,
    };
    const record = Object.freeze({ ...body, checksum: hashRecord(body) });
    const handle = await open(join(this.#directory, RECORD_FILE), fileConstants.O_APPEND | fileConstants.O_CREAT | fileConstants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.#records.push(record);
    return record;
  }

  async #assertLease(): Promise<void> {
    if (this.#closed) throw journalFailure("writer_closed");
    const lease = await readJson<LeaseRecord>(join(this.#directory, LEASE_FILE));
    if (
      lease.ownerId !== this.#ownerId ||
      lease.fence !== this.#fence ||
      !Number.isSafeInteger(lease.expiresAt) ||
      lease.expiresAt <= this.#clock()
    ) {
      throw workspaceError("writer_fenced", "The journal writer lease has been fenced.", "conflict", "stale_fence");
    }
  }

  async #serialized(action: () => Promise<void>, allowClosed = false): Promise<void> {
    const run = this.#tail.then(async () => {
      if (this.#closed && !allowClosed) throw journalFailure("writer_closed");
      await action();
    });
    this.#tail = run.catch(() => undefined);
    await run;
  }
}

export async function inspectSyncJournal(directory: string): Promise<JournalInspection> {
  const metadata = await readJson<JournalMetadata>(join(directory, META_FILE));
  try {
    assertReadableSchema(metadata);
  } catch {
    return Object.freeze({
      metadata,
      records: Object.freeze([]),
      requiresReconciliation: true,
      reason: "schema_incompatible",
      recoveryActions: Object.freeze([]),
    });
  }
  let text = "";
  try {
    text = await readFile(join(directory, RECORD_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const records: JournalRecord[] = [];
  const latestByOperation = new Map<string, JournalRecord>();
  let previousChecksum = "0".repeat(64);
  let previousFence = 0;
  for (const [index, line] of text.split("\n").filter(Boolean).entries()) {
    try {
      const record = JSON.parse(line) as JournalRecord;
      const { checksum, ...body } = record;
      const previousOperation = latestByOperation.get(record.operationId);
      if (
        !validRecordShape(record) ||
        record.recordSequence !== index + 1 ||
        record.previousChecksum !== previousChecksum ||
        hashRecord(body) !== checksum ||
        record.intentHash !== hashIntent(record) ||
        record.fence < previousFence ||
        record.fence > metadata.lastFence ||
        (previousOperation === undefined
          ? record.state !== "queued"
          : previousOperation.intentHash !== record.intentHash || !allowedTransition(previousOperation.state, record.state))
      ) {
        throw new Error("invalid chain");
      }
      validateIntent(record);
      records.push(Object.freeze(record));
      latestByOperation.set(record.operationId, record);
      previousChecksum = checksum;
      previousFence = record.fence;
    } catch {
      return Object.freeze({
        metadata,
        records: Object.freeze(records),
        requiresReconciliation: true,
        reason: "checksum_or_sequence_gap",
        recoveryActions: Object.freeze([]),
      });
    }
  }
  const latest = new Map<string, JournalRecord>();
  for (const record of records) latest.set(record.operationId, record);
  const recoveryActions = [...latest.values()]
    .sort((left, right) => left.recordSequence - right.recordSequence)
    .map((record) => Object.freeze({
      operationId: record.operationId,
      action: recoveryAction(record.state),
    }));
  return Object.freeze({
    metadata,
    records: Object.freeze(records),
    requiresReconciliation: false,
    recoveryActions: Object.freeze(recoveryActions),
  });
}

export function exportJournalRecoveryMetadata(inspection: JournalInspection): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: inspection.metadata.schemaVersion,
    bindingId: inspection.metadata.bindingId,
    bindingGeneration: inspection.metadata.bindingGeneration,
    requiresReconciliation: inspection.requiresReconciliation,
    reason: inspection.reason ?? null,
    operations: inspection.recoveryActions,
  });
}

async function readMetadata(
  path: string,
  bindingId: string,
  bindingGeneration: number,
): Promise<JournalMetadata> {
  try {
    const metadata = await readJson<JournalMetadata>(path);
    if (metadata.bindingId !== bindingId || metadata.bindingGeneration !== bindingGeneration) {
      throw workspaceError("journal_identity", "The journal belongs to another binding generation.", "policy", "identity_mismatch");
    }
    return metadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const metadata = Object.freeze({
      schemaVersion: 2,
      minimumReaderVersion: 1,
      minimumWriterVersion: 2,
      bindingId,
      bindingGeneration,
      lastFence: 0,
    });
    await atomicWriteJson(path, metadata);
    return metadata;
  }
}

async function acquireLeaseFile(
  path: string,
  ownerId: string,
  fence: number,
  now: number,
  leaseMs: number,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_WRONLY, 0o600);
      try {
        await handle.writeFile(JSON.stringify({ ownerId, fence, expiresAt: now + leaseMs }), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = await readJson<LeaseRecord>(path);
      if (current.expiresAt > now || attempt > 0) {
        throw workspaceError("workspace_busy", "Another process owns the workspace journal.", "conflict", "active_writer");
      }
      await unlink(path).catch((unlinkError: unknown) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      });
    }
  }
}

async function releaseLeaseFile(path: string, ownerId: string, fence: number): Promise<void> {
  try {
    const current = await readJson<LeaseRecord>(path);
    if (current.ownerId !== ownerId || current.fence !== fence) return;
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function validateIntent(intent: JournalIntent): void {
  if (
    intent.operationId.length === 0 ||
    !Number.isSafeInteger(intent.baseGeneration) ||
    intent.baseGeneration < 0 ||
    !Number.isSafeInteger(intent.byteLength) ||
    intent.byteLength < 0 ||
    !/^[a-f0-9]{64}$/u.test(intent.digest)
  ) throw journalFailure("invalid_intent");
}

function allowedTransition(from: JournalOperationState, to: JournalOperationState): boolean {
  const allowed: Readonly<Record<JournalOperationState, readonly JournalOperationState[]>> = {
    queued: ["sending", "conflicted"],
    sending: ["uncertain", "acknowledged", "conflicted"],
    uncertain: ["acknowledged", "conflicted"],
    acknowledged: ["applied", "conflicted"],
    applied: [],
    conflicted: [],
  };
  return allowed[from].includes(to);
}

function recoveryAction(state: JournalOperationState): "send" | "query_outcome" | "apply_receipt" | "none" {
  if (state === "queued") return "send";
  if (state === "sending" || state === "uncertain") return "query_outcome";
  if (state === "acknowledged") return "apply_receipt";
  return "none";
}

function hashIntent(intent: JournalIntent): string {
  return createHash("sha256")
    .update("runa-journal-intent-v2\0")
    .update(JSON.stringify({
      baseGeneration: intent.baseGeneration,
      byteLength: intent.byteLength,
      digest: intent.digest,
      operationId: intent.operationId,
    }))
    .digest("hex");
}

function validRecordShape(record: JournalRecord): boolean {
  if (record === null || typeof record !== "object") return false;
  const keys = Object.keys(record).sort();
  const expected = [
    "baseGeneration", "byteLength", "checksum", "digest", "fence", "intentHash",
    "operationId", "previousChecksum", "recordSequence", "state",
  ];
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    Number.isSafeInteger(record.recordSequence) && record.recordSequence >= 1 &&
    Number.isSafeInteger(record.fence) && record.fence >= 1 &&
    /^[a-f0-9]{64}$/u.test(record.intentHash) &&
    /^[a-f0-9]{64}$/u.test(record.previousChecksum) &&
    /^[a-f0-9]{64}$/u.test(record.checksum) &&
    (["queued", "sending", "uncertain", "acknowledged", "applied", "conflicted"] as const).includes(record.state)
  );
}

function hashRecord(body: Omit<JournalRecord, "checksum">): string {
  return createHash("sha256")
    .update("runa-journal-record-v2\0")
    .update(JSON.stringify(body))
    .digest("hex");
}

function journalFailure(reason: string) {
  return workspaceError("journal_invalid", "The durable sync journal cannot be safely used.", "integrity", reason);
}
