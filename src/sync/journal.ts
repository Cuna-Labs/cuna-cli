import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { isAbsolute, join, parse, resolve } from "node:path";

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

interface WriterAuthority {
  readonly server: Server;
  close(): Promise<void>;
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
  readonly #authority: WriterAuthority;
  #metadata: JournalMetadata;
  #records: JournalRecord[];
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #lastObservedNow: number;

  private constructor(input: {
    readonly directory: string;
    readonly ownerId: string;
    readonly fence: number;
    readonly leaseMs: number;
    readonly metadata: JournalMetadata;
    readonly records: JournalRecord[];
    readonly clock: () => number;
    readonly authority: WriterAuthority;
    readonly observedAt: number;
  }) {
    this.#directory = input.directory;
    this.#ownerId = input.ownerId;
    this.#fence = input.fence;
    this.#leaseMs = input.leaseMs;
    this.#metadata = input.metadata;
    this.#records = input.records;
    this.#clock = input.clock;
    this.#authority = input.authority;
    this.#lastObservedNow = input.observedAt;
  }

  static async open(input: {
    readonly directory: string;
    readonly bindingId: string;
    readonly bindingGeneration: number;
    readonly ownerId: string;
    readonly leaseMs?: number;
    readonly clock?: () => number;
  }): Promise<DurableSyncJournal> {
    const leaseMs = input.leaseMs ?? 30_000;
    const clock = input.clock ?? Date.now;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw journalFailure("invalid_lease");
    const directory = await prepareJournalDirectory(input.directory);
    const authority = await acquireWriterAuthority(directory);
    let leaseOwned = false;
    let ownerFence = 0;
    try {
      await assertDirectoryAuthority(directory);
      const metadataPath = join(directory, META_FILE);
      let metadata = await readMetadata(metadataPath, input.bindingId, input.bindingGeneration);
      assertWritableSchema(metadata);
      const leasePath = join(directory, LEASE_FILE);
      const previousLease = await readOptionalJson<LeaseRecord>(leasePath, validLeaseRecord);
      const previousFence = Math.max(metadata.lastFence, previousLease?.fence ?? 0);
      const fence = safeIncrement(previousFence, "fence_overflow");
      const observedAt = trustedNow(clock);
      const expiresAt = safeAdd(observedAt, leaseMs, "lease_overflow");
      await atomicWriteJson(leasePath, {
        ownerId: input.ownerId,
        fence,
        expiresAt,
      });
      leaseOwned = true;
      ownerFence = fence;
      metadata = Object.freeze({ ...metadata, lastFence: fence });
      await atomicWriteJson(metadataPath, metadata);
      const inspection = await inspectSyncJournal(directory);
      if (inspection.requiresReconciliation) {
        throw journalFailure(inspection.reason ?? "journal_untrusted");
      }
      const readyAt = trustedNow(clock);
      if (readyAt < observedAt) throw journalFailure("clock_rollback");
      if (readyAt >= expiresAt) throw journalFailure("lease_expired_during_open");
      return new DurableSyncJournal({
        directory,
        ownerId: input.ownerId,
        fence,
        leaseMs,
        metadata,
        records: [...inspection.records],
        clock,
        authority,
        observedAt: readyAt,
      });
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      if (leaseOwned) {
        try { await releaseLeaseFile(join(directory, LEASE_FILE), input.ownerId, ownerFence); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
      }
      try { await authority.close(); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], "The journal failed to release writer authority after open failed.");
      }
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

  async renew(): Promise<void> {
    await this.#serialized(async () => {
      await this.#assertLease();
      const now = this.#trustedNow();
      await atomicWriteJson(join(this.#directory, LEASE_FILE), {
        ownerId: this.#ownerId,
        fence: this.#fence,
        expiresAt: safeAdd(now, this.#leaseMs, "lease_overflow"),
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
      const failures: unknown[] = [];
      try { await releaseLeaseFile(join(this.#directory, LEASE_FILE), this.#ownerId, this.#fence); } catch (error) { failures.push(error); }
      try { await this.#authority.close(); } catch (error) { failures.push(error); }
      this.#closed = true;
      if (failures.length > 0) throw new AggregateError(failures, "The journal failed to release writer authority.");
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
    await assertDirectoryAuthority(this.#directory);
    const handle = await openSecureAppendFile(join(this.#directory, RECORD_FILE));
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
    await assertDirectoryAuthority(this.#directory);
    const lease = await readJson<LeaseRecord>(join(this.#directory, LEASE_FILE), validLeaseRecord);
    if (
      lease.ownerId !== this.#ownerId ||
      lease.fence !== this.#fence ||
      !Number.isSafeInteger(lease.expiresAt) ||
      lease.expiresAt <= this.#trustedNow()
    ) {
      throw workspaceError("writer_fenced", "The journal writer lease has been fenced.", "conflict", "stale_fence");
    }
  }

  #trustedNow(): number {
    const now = trustedNow(this.#clock);
    if (now < this.#lastObservedNow) throw journalFailure("clock_rollback");
    this.#lastObservedNow = now;
    return now;
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

async function prepareJournalDirectory(directory: string): Promise<string> {
  if (!isAbsolute(directory) || directory.includes("\0")) throw journalFailure("directory_untrusted");
  const requested = resolve(directory);
  const parsed = parse(requested);
  let current = parsed.root;
  for (const component of requested.slice(parsed.root.length).split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, component);
    try {
      await assertPlainDirectory(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { await mkdir(current, { mode: 0o700 }); } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      await assertPlainDirectory(current);
    }
  }
  const canonical = await realpath(requested);
  if (!samePath(canonical, requested)) throw journalFailure("directory_untrusted");
  await chmod(canonical, 0o700);
  return canonical;
}

async function assertPlainDirectory(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw journalFailure("directory_untrusted");
  const canonical = await realpath(path);
  if (!samePath(canonical, resolve(path))) throw journalFailure("directory_untrusted");
}

async function assertDirectoryAuthority(directory: string): Promise<void> {
  await assertPlainDirectory(directory);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function trustedNow(clock: () => number): number {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) throw journalFailure("clock_untrusted");
  return now;
}

export async function inspectSyncJournal(directory: string): Promise<JournalInspection> {
  const canonical = resolve(directory);
  await assertDirectoryAuthority(canonical);
  const metadata = await readJson<JournalMetadata>(join(canonical, META_FILE));
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
    text = await readSecureTextFile(join(canonical, RECORD_FILE));
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

async function releaseLeaseFile(path: string, ownerId: string, fence: number): Promise<void> {
  try {
    const current = await readJson<LeaseRecord>(path, validLeaseRecord);
    if (current.ownerId !== ownerId || current.fence !== fence) return;
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await assertSafeExistingFile(path, true);
  try {
    await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await assertSafeExistingFile(temporary, false);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readJson<T>(path: string, validate?: (value: unknown) => value is T): Promise<T> {
  const value = JSON.parse(await readSecureTextFile(path)) as unknown;
  if (validate !== undefined && !validate(value)) throw journalFailure("file_shape_untrusted");
  return value as T;
}

async function readOptionalJson<T>(path: string, validate: (value: unknown) => value is T): Promise<T | undefined> {
  try { return await readJson(path, validate); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readSecureTextFile(path: string): Promise<string> {
  await assertSafeExistingFile(path, false);
  const handle = await open(path, fileConstants.O_RDONLY | noFollowFlag());
  try {
    await assertSecureHandle(handle, path);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function openSecureAppendFile(path: string) {
  let handle;
  try {
    handle = await open(path, fileConstants.O_APPEND | fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_WRONLY | noFollowFlag(), 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await assertSafeExistingFile(path, false);
    handle = await open(path, fileConstants.O_APPEND | fileConstants.O_WRONLY | noFollowFlag(), 0o600);
  }
  try {
    await assertSecureHandle(handle, path);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertSafeExistingFile(path: string, allowMissing: boolean): Promise<void> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw journalFailure("file_untrusted");
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function assertSecureHandle(handle: Awaited<ReturnType<typeof open>>, path: string): Promise<void> {
  const entry = await handle.stat();
  if (!entry.isFile() || entry.nlink !== 1) throw journalFailure("file_untrusted");
  const linked = await lstat(path);
  if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 1) throw journalFailure("file_untrusted");
  if (typeof entry.dev === "number" && typeof linked.dev === "number" && (entry.dev !== linked.dev || entry.ino !== linked.ino)) {
    throw journalFailure("file_identity_changed");
  }
}

function noFollowFlag(): number {
  return typeof fileConstants.O_NOFOLLOW === "number" ? fileConstants.O_NOFOLLOW : 0;
}

async function acquireWriterAuthority(directory: string): Promise<WriterAuthority> {
  const canonicalIdentity = process.platform === "win32" ? directory.toLowerCase() : directory;
  const digest = createHash("sha256")
    .update("cuna-journal-authority-v2\0")
    .update(canonicalIdentity)
    .digest("hex");
  // Windows reserves dynamic TCP port ranges for system services. Deriving a
  // lock port from a directory hash can therefore fail with EACCES even when
  // no peer owns the journal. A named pipe is kernel-owned, directory-scoped,
  // and released automatically when the process exits.
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\cuna-workspace-journal-${digest}`
    : Object.freeze({
      host: "127.0.0.1" as const,
      port: 20_000 + Number.parseInt(digest.slice(0, 4), 16) % 40_000,
      exclusive: true,
    });
  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener("listening", onListening);
        rejectListen(error);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolveListen();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(endpoint);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw workspaceError("workspace_busy", "Another process owns the workspace journal.", "conflict", "active_writer");
    }
    throw error;
  }
  let closed = false;
  return Object.freeze({
    server,
    close: async (): Promise<void> => {
      if (closed) return;
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
      });
      closed = true;
    },
  });
}

function validLeaseRecord(value: unknown): value is LeaseRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.length === 3 && keys[0] === "expiresAt" && keys[1] === "fence" && keys[2] === "ownerId" &&
    typeof record.ownerId === "string" && record.ownerId.length > 0 && record.ownerId.length <= 256 &&
    Number.isSafeInteger(record.fence) && (record.fence as number) >= 1 &&
    Number.isSafeInteger(record.expiresAt) && (record.expiresAt as number) >= 0;
}

function safeIncrement(value: number, reason: string): number {
  return safeAdd(value, 1, reason);
}

function safeAdd(left: number, right: number, reason: string): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0 || left > Number.MAX_SAFE_INTEGER - right) {
    throw journalFailure(reason);
  }
  return left + right;
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
    .update("cuna-journal-intent-v2\0")
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
    .update("cuna-journal-record-v2\0")
    .update(JSON.stringify(body))
    .digest("hex");
}

function journalFailure(reason: string) {
  return workspaceError("journal_invalid", "The durable sync journal cannot be safely used.", "integrity", reason);
}
