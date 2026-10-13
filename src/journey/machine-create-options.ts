import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Machine, MachineCreateRequest } from "../api/contracts.js";
import type { MachineCreateInput } from "../api/client.js";
import { CunaError, EXIT_CODES } from "../core/errors.js";
import { DurableSyncJournal, inspectSyncJournal, type JournalRecord } from "../sync/journal.js";
import { deriveMachineCreateIdentity, stableUuid, type MachineCreateIdentity, type MachineCreateIdentityInput } from "./derived-identity.js";

export interface MachineCreateChoiceScope extends MachineCreateIdentityInput {
  readonly stateDirectory: string; readonly apiOrigin: string; readonly profileId: string;
  readonly direct?: { readonly key: string; readonly requestId: string; readonly body: MachineCreateInput };
}
export interface PreparedMachineCreate extends MachineCreateIdentity {
  readonly installTetragon?: boolean; readonly createAttempt: number;
}
export type MachineCreateChoiceAnswer = Readonly<{ kind: "choice"; installTetragon?: boolean }> | Readonly<{ kind: "cancel" }>;
export interface MachineCreateChoiceOutcome { readonly operationId: string; readonly state: JournalRecord["state"]; readonly checksum: string; readonly digest: string }
function refusal(reason: string, requestId?: string): CunaError {
  return new CunaError({ code: "cuna.journey.machine_create_choice_unresolved", message: "The original Machine creation choice must be resolved before requesting another.",
    exitCode: EXIT_CODES.conflict, hint: "Run the same command to read its original operation, and inspect `cuna machines list`. An unknown result is never permission to create another.", details: { reason, ...(requestId===undefined?{}:{request_id:requestId}) } });
}
function authority(scope: MachineCreateChoiceScope): { directory: string; bindingId: string } {
  // A local profile alias is not part of the producer's operation identity.
  const serialized = JSON.stringify([scope.direct === undefined ? "machine-create-choice-v1" : "machine-create-direct-choice-v1", 1, "POST /v1/sessions", new URL(scope.apiOrigin).origin, scope.userId, scope.workspaceId,
    ...(scope.direct === undefined ? [scope.canonicalLocalRoot] : [scope.direct.key])]);
  return { directory: join(scope.stateDirectory, "machine-create-choice-v1", createHash("sha256").update(serialized).digest("hex")), bindingId: stableUuid("cuna.machine-create-choice.v1", serialized) };
}
function candidate(scope: MachineCreateChoiceScope, createAttempt: number, installTetragon?: boolean): PreparedMachineCreate {
  if (scope.direct !== undefined) {
    const {body,key,requestId}=scope.direct;
    if (Object.keys(body).some(key => !["name","agent","vcpus","memoryMiB","background","installTetragon"].includes(key))) throw refusal("direct_body_not_control_metadata");
    const digest=createHash("sha256").update(JSON.stringify(["machine-create-direct-v1",1,"POST /v1/sessions",key,requestId,body.name,body.agent??null,body.vcpus??null,body.memoryMiB??null,body.background??null,body.installTetragon??null])).digest("hex");
    return Object.freeze({requestId,idempotencyKey:key,intentDigest:digest,createAttempt:1,...(body.installTetragon===undefined?{}:{installTetragon:body.installTetragon})});
  }
  const { installTetragon: _explicitChoice, ...identity } = scope;
  return Object.freeze({ ...deriveMachineCreateIdentity({ ...identity, createAttempt, ...(installTetragon === undefined ? {} : { installTetragon }) }), createAttempt,
    ...(installTetragon === undefined ? {} : { installTetragon }) });
}
function attemptNumber(records: readonly JournalRecord[], operationId?: string): number {
  const operations = records.filter(record => record.state === "queued").map(record => record.operationId);
  return operationId === undefined ? operations.length + 1 : operations.indexOf(operationId) + 1;
}
function reconstruct(scope: MachineCreateChoiceScope, record: JournalRecord, records: readonly JournalRecord[]): PreparedMachineCreate {
  const matches = (scope.direct === undefined ? [undefined, false, true] : [undefined]).map(choice => candidate(scope, attemptNumber(records, record.operationId), choice))
    .filter(value => value.requestId === record.operationId && value.intentDigest === record.digest);
  if (matches.length !== 1) throw refusal("recorded_scope_or_choice_mismatch");
  return matches[0]!;
}
async function records(scope: MachineCreateChoiceScope): Promise<readonly JournalRecord[]> {
  try {
    const view = await inspectSyncJournal(authority(scope).directory);
    if (view.requiresReconciliation) throw refusal("journal_requires_reconciliation");
    return view.records;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
const fingerprint = (values: readonly JournalRecord[]): string => values.at(-1)?.checksum ?? "empty";
async function writer(scope: MachineCreateChoiceScope): Promise<DurableSyncJournal> {
  const local = authority(scope);
  return await DurableSyncJournal.open({ ...local, bindingGeneration: 1, ownerId: randomUUID(), leaseMs: 120_000 });
}
export async function prepareMachineCreateChoice(scope: MachineCreateChoiceScope,
  select: () => Promise<MachineCreateChoiceAnswer>, options: { readonly releaseCompleted?: boolean } = {}): Promise<PreparedMachineCreate> {
  const observed = await records(scope), last = observed.at(-1);
  if (scope.direct !== undefined && last?.state === "conflicted") throw refusal("direct_terminal_operation_requires_new_key");
  let releaseCompleted = scope.direct === undefined && last?.state === "applied" && options.releaseCompleted === true;
  if (!releaseCompleted && scope.direct === undefined && last?.state === "applied") {
    try { reconstruct(scope,last,observed); } catch { releaseCompleted = true; }
  }
  if (last !== undefined && last.state !== "conflicted" && !releaseCompleted) {
    const prepared = reconstruct(scope, last, observed);
    if (scope.installTetragon !== undefined && scope.installTetragon !== prepared.installTetragon) throw refusal("pending_choice_cannot_change");
    const journal = await writer(scope);
    try { if (fingerprint(journal.records) !== fingerprint(observed)) throw refusal("concurrent_choice_changed"); return prepared; }
    finally { await journal.close(); }
  }
  if (observed.filter(record => record.state === "queued").length >= 1024) throw refusal("choice_history_full");
  // Never hold a short writer lease while a person reads the question.
  const answer = await select();
  if (answer.kind === "cancel") throw new CunaError({ code: "cuna.journey.machine_create_not_authorized", message: "Machine creation was cancelled. Nothing was sent.", exitCode: EXIT_CODES.policy });
  const prepared = candidate(scope, attemptNumber(observed), answer.installTetragon);
  const journal = await writer(scope);
  try {
    if (fingerprint(journal.records) !== fingerprint(observed)) throw refusal("concurrent_choice_changed");
    await journal.append({ operationId: prepared.requestId, baseGeneration: 1, digest: prepared.intentDigest, byteLength: prepared.installTetragon === undefined ? 0 : 1 });
    return prepared;
  } finally { await journal.close(); }
}
export async function hasMachineCreateChoice(scope: MachineCreateChoiceScope): Promise<boolean> { return (await records(scope)).length !== 0; }
export async function machineCreateChoiceOutcome(scope: MachineCreateChoiceScope): Promise<MachineCreateChoiceOutcome | undefined> {
  const last = (await records(scope)).at(-1); return last === undefined ? undefined : Object.freeze({ operationId: last.operationId, state: last.state,checksum:last.checksum,digest:last.digest });
}
/** A read of the original V1 operation can finish its old template; inventory cannot. */
export async function finalizeMachineCreateChoice(scope: MachineCreateChoiceScope, observed: MachineCreateChoiceOutcome, receipt: MachineCreateRequest): Promise<void> {
  checkedReceipt(receipt,{requestId:observed.operationId});
  if ((receipt.state !== "settled" && receipt.state !== "terminal_failed") || receipt.action !== "none" || receipt.retryable !== false) return;
  const journal=await writer(scope);
  try {
    const last=journal.records.at(-1);
    if(last?.operationId!==observed.operationId || last.digest!==observed.digest || last.checksum!==observed.checksum) throw refusal("concurrent_choice_changed",observed.operationId);
    if (!["sending","uncertain","acknowledged"].includes(last.state)) throw refusal("original_operation_not_pending",observed.operationId);
    if(receipt.state === "terminal_failed") await journal.transition(observed.operationId,"conflicted");
    else { if(last.state!=="acknowledged") await journal.transition(observed.operationId,"acknowledged"); await journal.transition(observed.operationId,"applied"); }
  } finally { await journal.close(); }
}
export async function machineCreateChoiceState(scope: MachineCreateChoiceScope, prepared: PreparedMachineCreate): Promise<JournalRecord["state"]> {
  const values = await records(scope), last = values.at(-1);
  if (last === undefined || reconstruct(scope, last, values).requestId !== prepared.requestId) throw refusal("original_operation_missing");
  return last.state;
}
export async function cancelQueuedMachineCreate(scope: MachineCreateChoiceScope, prepared: PreparedMachineCreate): Promise<void> {
  const journal = await writer(scope);
  try {
    const last = journal.records.at(-1);
    if (last?.operationId === prepared.requestId && last.state === "queued") await journal.transition(prepared.requestId, "conflicted");
    // Once sending is durable, cancellation cannot establish a rollback.
  } finally { await journal.close(); }
}
function checkedReceipt(receipt: MachineCreateRequest, prepared: Pick<PreparedMachineCreate,"requestId">): MachineCreateRequest {
  const fields = ["id", "machineId", "state", "retryable", "action", "updatedAt"];
  if (receipt.id !== prepared.requestId || Object.keys(receipt).length!==fields.length || Object.keys(receipt).some(key => !fields.includes(key))) throw refusal("original_v1_receipt_mismatch");
  return receipt;
}
/** V1 only. The scoped V1 endpoint must never project a V2 request or unverified cleanup. */
export async function performMachineCreateChoice(scope: MachineCreateChoiceScope, prepared: PreparedMachineCreate, input: {
  readonly create: (signal: AbortSignal) => Promise<Machine>;
  readonly readReceipt: (signal: AbortSignal) => Promise<MachineCreateRequest>;
  readonly readMachine: (machineId: string, signal: AbortSignal) => Promise<Machine>;
  readonly signal: AbortSignal;
}): Promise<Machine> {
  const journal = await writer(scope), leaseAbort = new AbortController(); let renewal: Promise<void> | undefined; let leaseFailure: unknown;
  const signal = AbortSignal.any([input.signal, leaseAbort.signal]);
  const timer = setInterval(() => { if (renewal !== undefined) return; renewal = journal.renew().catch(error => { leaseFailure = error; leaseAbort.abort(); }).finally(() => { renewal = undefined; }); }, 40_000); timer.unref();
  try {
    const last = journal.records.at(-1);
    if (last === undefined || reconstruct(scope, last, journal.records).requestId !== prepared.requestId || last.state === "conflicted") throw refusal("original_operation_changed");
    signal.throwIfAborted();
    if (last.state === "queued") {
      await journal.transition(prepared.requestId, "sending");
      try {
        const machine = await input.create(signal);
        if (machine.createOperation !== undefined && machine.createOperation.id !== prepared.requestId) throw refusal("original_v1_receipt_mismatch");
        await journal.transition(prepared.requestId, "acknowledged");
        if (leaseFailure !== undefined) throw refusal("writer_lease_lost_original_operation_preserved");
        return machine;
      } catch (error) {
        const current = journal.records.at(-1);
        if (current?.state === "sending") await journal.transition(prepared.requestId, "uncertain");
        throw error;
      }
    }
    const receipt = checkedReceipt(await input.readReceipt(signal), prepared);
    if (receipt.state === "terminal_failed" && receipt.action === "none" && receipt.retryable === false) {
      if (last.state !== "applied") await journal.transition(prepared.requestId, "conflicted");
      throw new CunaError({ code: "cuna.journey.machine_create_failed", message: "The original Machine creation reached an authoritative terminal failure.", exitCode: EXIT_CODES.remote, details: { request_id: prepared.requestId, machine_id: receipt.machineId } });
    }
    if (receipt.state === "terminal_failed") throw refusal("terminal_receipt_not_final",prepared.requestId);
    if ((receipt.state === "settled" || receipt.state === "provider_succeeded") && last.state !== "applied") {
      if (last.state !== "acknowledged") await journal.transition(prepared.requestId, "acknowledged");
      // Provider allocation is not readiness or a terminal create outcome.
      if (receipt.state === "settled" && receipt.action === "none" && receipt.retryable === false) await journal.transition(prepared.requestId, "applied");
    }
    if (receipt.state === "prepared" || receipt.state === "unknown") throw refusal("original_outcome_unknown",prepared.requestId);
    const machine = await input.readMachine(receipt.machineId, signal);
    if (machine.id !== receipt.machineId) throw refusal("original_machine_mismatch");
    if (leaseFailure !== undefined) throw refusal("writer_lease_lost_original_operation_preserved");
    return machine;
  } finally {
    clearInterval(timer); if (renewal !== undefined) await renewal;
    await journal.close();
  }
}
