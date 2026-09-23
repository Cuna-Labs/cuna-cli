import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {DurableSyncJournal,inspectSyncJournal,type JournalRecord} from '../sync/journal.js';
import {CunaError,EXIT_CODES} from '../core/errors.js';
import {stableUuid} from './derived-identity.js';

const LEASE_MS=120000;

/** Reuses the fsync journal and exclusive local writer; no provider credentials are persisted. */
export async function withProviderLaunchIntent<T>(input:{stateDirectory:string;ownerId:string;workspaceId:string;machineId:string;executionWorkspaceId:string;intent:Readonly<Record<string,unknown>>;confirmNew?:()=>Promise<boolean>;
 /**
  * Called when this call re-dispatches a RECORDED launch identity instead of
  * minting one — the branch below that reuses `resolved.operationId`.
  *
  * It reports the branch rather than the answer because the two are not the
  * same: with no `confirmNew` wired, `await undefined?.()` is `undefined` and
  * the resume branch is taken without anyone being asked. A caller that
  * inferred "resumed" from a No it never received would call that launch new,
  * and say so on screen next to its id.
  */
 onResume?:()=>void;create:(operationId:string)=>Promise<T>}):Promise<T>{
 const scope=JSON.stringify(['provider-launch-v2',input.ownerId,input.workspaceId,input.machineId,input.executionWorkspaceId]);
 const directory=join(input.stateDirectory,'provider-launch-v2',createHash('sha256').update(scope).digest('hex'));
 const serialized=JSON.stringify(input.intent),digest=createHash('sha256').update(serialized).digest('hex');
 // The question is asked BEFORE the writer lease is taken. The lease lasts
 // two minutes and nothing renews it while a person reads the question, so a
 // slower answer used to find the lease fenced: `y` then failed as an
 // unprovable create although nothing had been sent (qa6 witness 2026-09-22,
 // answered after four minutes). The records the answer was based on are
 // re-read under the lease and must be unchanged.
 const observed=await readLaunchRecords(directory);
 const decision=await decide(observed.latest,digest,input.confirmNew);
 const journal=await DurableSyncJournal.open({directory,bindingId:stableUuid('provider-launch-v2',scope),bindingGeneration:1,ownerId:randomUUID(),leaseMs:LEASE_MS});
 try{
  const current=await readLaunchRecords(directory);
  if(current.fingerprint!==observed.fingerprint)throw new CunaError({code:'cuna.provider.pending_intent_conflict',message:'Another launch changed the local launch record while this one was deciding. Nothing was sent. Run the command again.',exitCode:EXIT_CODES.conflict});
  if(decision.kind==='resume'){input.onResume?.();return await input.create(decision.operationId);}
  let record=decision.pending??await journal.append({operationId:randomUUID(),baseGeneration:1,digest,byteLength:Buffer.byteLength(serialized)});
  if(record.state==='queued')record=await journal.transition(record.operationId,'sending');
  const result=await input.create(record.operationId);
  await journal.renew();
  if(record.state==='sending'||record.state==='uncertain')await journal.transition(record.operationId,'acknowledged');
  await journal.transition(record.operationId,'applied');
  return result;
 }finally{await journal.close();}
}

async function decide(latest:ReadonlyMap<string,JournalRecord>,digest:string,confirmNew:(()=>Promise<boolean>)|undefined):Promise<{kind:'resume';operationId:string}|{kind:'dispatch';pending?:JournalRecord}>{
 const pending=[...latest.values()].filter(record=>record.state!=='applied'&&record.state!=='conflicted');
 if(pending.length>1||pending.some(record=>record.digest!==digest))throw new CunaError({code:'cuna.provider.pending_intent_conflict',message:'A previous provider launch is unresolved with a different Workspace version or preset. Resolve that launch before requesting another.',exitCode:EXIT_CODES.conflict});
 const resolved=[...latest.values()].filter(record=>record.state==='applied').at(-1);
 if(pending.length===0&&resolved&&!(await confirmNew?.())){
  // Resuming re-sends the recorded launch as it was. A launch recorded for
  // another Workspace version or preset cannot be resumed, and nothing is
  // unresolved about it: the way forward is a new session, and the refusal
  // says so rather than reading as a create of unknown outcome.
  if(resolved.digest!==digest)throw new CunaError({code:'cuna.provider.pending_intent_conflict',message:'The recorded launch used another Workspace version or preset, so it cannot be resumed. Nothing was sent.',exitCode:EXIT_CODES.conflict,hint:'Answer y to the question, or run the same command with --new-session, to start a new session.',details:{reason:'recorded_launch_mismatch'}});
  return {kind:'resume',operationId:resolved.operationId};
 }
 if(pending.length===0&&latest.size>=1024)throw new CunaError({code:'cuna.provider.intent_history_full',message:'The local provider launch history is full. Inspect it before starting another launch.',exitCode:EXIT_CODES.conflict});
 return pending[0]===undefined?{kind:'dispatch'}:{kind:'dispatch',pending:pending[0]};
}

/** The latest record per operation, read without taking the writer lease. A journal that does not exist yet has none. */
async function readLaunchRecords(directory:string):Promise<{latest:ReadonlyMap<string,JournalRecord>;fingerprint:string}>{
 let records:readonly JournalRecord[];
 try{records=(await inspectSyncJournal(directory)).records;}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')records=[];else throw error;}
 return {latest:new Map(records.map(record=>[record.operationId,record])),fingerprint:`${records.length}:${records.at(-1)?.checksum??''}`};
}
