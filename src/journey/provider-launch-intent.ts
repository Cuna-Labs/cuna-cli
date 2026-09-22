import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {DurableSyncJournal,inspectSyncJournal} from '../sync/journal.js';
import {CunaError,EXIT_CODES} from '../core/errors.js';
import {stableUuid} from './derived-identity.js';

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
 const journal=await DurableSyncJournal.open({directory,bindingId:stableUuid('provider-launch-v2',scope),bindingGeneration:1,ownerId:randomUUID(),leaseMs:120000});
 try{
  const inspection=await inspectSyncJournal(directory);const latest=new Map(inspection.records.map(record=>[record.operationId,record]));
  const pending=[...latest.values()].filter(record=>record.state!=='applied'&&record.state!=='conflicted');
  const serialized=JSON.stringify(input.intent),digest=createHash('sha256').update(serialized).digest('hex');
  if(pending.length>1||pending.some(record=>record.digest!==digest))throw new CunaError({code:'cuna.provider.pending_intent_conflict',message:'A previous provider launch is unresolved with a different Workspace version or preset. Resolve that launch before requesting another.',exitCode:EXIT_CODES.conflict});
  const resolved=[...latest.values()].filter(record=>record.state==='applied').at(-1);
  if(pending.length===0&&resolved&&!(await input.confirmNew?.())){if(resolved.digest!==digest)throw new CunaError({code:'cuna.provider.pending_intent_conflict',message:'Resume requires the previously selected Workspace version and preset. Explicitly confirm a new session to change them.',exitCode:EXIT_CODES.conflict});input.onResume?.();return await input.create(resolved.operationId);}
  if(pending.length===0&&latest.size>=1024)throw new CunaError({code:'cuna.provider.intent_history_full',message:'The local provider launch history is full. Inspect it before starting another launch.',exitCode:EXIT_CODES.conflict});
  let record=pending[0]??await journal.append({operationId:randomUUID(),baseGeneration:1,digest,byteLength:Buffer.byteLength(serialized)});
  if(record.state==='queued')record=await journal.transition(record.operationId,'sending');
  const result=await input.create(record.operationId);
  await journal.renew();
  if(record.state==='sending'||record.state==='uncertain')await journal.transition(record.operationId,'acknowledged');
  await journal.transition(record.operationId,'applied');
  return result;
 }finally{await journal.close();}
}
