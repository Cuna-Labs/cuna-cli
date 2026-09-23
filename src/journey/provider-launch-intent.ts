import {createHash,randomUUID} from 'node:crypto';
import {readFile,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DurableSyncJournal,inspectSyncJournal,type JournalRecord} from '../sync/journal.js';
import {CunaError,EXIT_CODES} from '../core/errors.js';
import {stableUuid} from './derived-identity.js';

const LEASE_MS=120000;
const SESSIONS_FILE='sessions.json';

/**
 * What the recorded-launch question is about. `ended`: the session the
 * recorded launch produced is known to be gone, so there is nothing to
 * resume and the question may only offer a new session.
 */
export interface RecordedLaunchContext {readonly state:'resumable'|'ended'}

/** Reuses the fsync journal and exclusive local writer; no provider credentials are persisted. */
export async function withProviderLaunchIntent<T extends {readonly id:string}>(input:{stateDirectory:string;ownerId:string;workspaceId:string;machineId:string;executionWorkspaceId:string;intent:Readonly<Record<string,unknown>>;confirmNew?:(context:RecordedLaunchContext)=>Promise<boolean>;
 /**
  * Called when this call re-dispatches a RECORDED launch identity instead of
  * minting one — the branch below that reuses `resolved.operationId` — and
  * only once the session that replay returned is known to be live.
  *
  * It reports the branch rather than the answer because the two are not the
  * same: with no `confirmNew` wired, `await undefined?.()` is `undefined` and
  * the resume branch is taken without anyone being asked. A caller that
  * inferred "resumed" from a No it never received would call that launch new,
  * and say so on screen next to its id.
  */
 onResume?:()=>void;
 /**
  * Whether an AgentSession has ended, read from the server. A replayed create
  * returns the receipt stored at creation, which still says "starting" for a
  * session terminated since (qa6 re-witness 2026-09-23, run j6), so the
  * receipt cannot answer this.
  */
 isSessionEnded?:(agentSessionId:string)=>Promise<boolean>;
 create:(operationId:string)=>Promise<T>}):Promise<T>{
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
 const sessions=await readLaunchSessions(directory);
 const decision=await decide(observed.latest,digest,sessions,input.confirmNew,input.isSessionEnded);
 const journal=await DurableSyncJournal.open({directory,bindingId:stableUuid('provider-launch-v2',scope),bindingGeneration:1,ownerId:randomUUID(),leaseMs:LEASE_MS});
 try{
  const current=await readLaunchRecords(directory);
  if(current.fingerprint!==observed.fingerprint)throw new CunaError({code:'cuna.provider.pending_intent_conflict',message:'Another launch changed the local launch record while this one was deciding. Nothing was sent. Run the command again.',exitCode:EXIT_CODES.conflict});
  if(decision.kind==='resume'){
   const session=await input.create(decision.operationId);
   await rememberLaunchSession(directory,decision.operationId,session.id);
   // A record kept before session ids were stored is only identified by the
   // replay, so the ended check runs again on what it returned.
   if(await input.isSessionEnded?.(session.id))throw recordedLaunchEnded(session.id);
   input.onResume?.();
   return session;
  }
  let record=decision.pending??await journal.append({operationId:randomUUID(),baseGeneration:1,digest,byteLength:Buffer.byteLength(serialized)});
  if(record.state==='queued')record=await journal.transition(record.operationId,'sending');
  const result=await input.create(record.operationId);
  await journal.renew();
  if(record.state==='sending'||record.state==='uncertain')await journal.transition(record.operationId,'acknowledged');
  await journal.transition(record.operationId,'applied');
  await rememberLaunchSession(directory,record.operationId,result.id);
  return result;
 }finally{await journal.close();}
}

async function decide(latest:ReadonlyMap<string,JournalRecord>,digest:string,sessions:ReadonlyMap<string,string>,confirmNew:((context:RecordedLaunchContext)=>Promise<boolean>)|undefined,isSessionEnded:((agentSessionId:string)=>Promise<boolean>)|undefined):Promise<{kind:'resume';operationId:string}|{kind:'dispatch';pending?:JournalRecord}>{
 const pending=[...latest.values()].filter(record=>record.state!=='applied'&&record.state!=='conflicted');
 if(pending.length>1||pending.some(record=>record.digest!==digest))throw new CunaError({code:'cuna.provider.pending_intent_conflict',message:'A previous provider launch is unresolved with a different Workspace version or preset. Resolve that launch before requesting another.',exitCode:EXIT_CODES.conflict});
 const resolved=[...latest.values()].filter(record=>record.state==='applied').at(-1);
 if(pending.length===0&&resolved){
  const recordedSession=sessions.get(resolved.operationId);
  const ended=recordedSession!==undefined&&isSessionEnded!==undefined&&await isSessionEnded(recordedSession);
  if(!(await confirmNew?.({state:ended?'ended':'resumable'}))){
   // A session that ended cannot be resumed: re-sending its launch returns
   // the dead row. Say so, and send nothing.
   if(ended)throw recordedLaunchEnded(recordedSession);
   // Resuming re-sends the recorded launch as it was. A launch recorded for
   // another Workspace version or preset cannot be resumed, and nothing is
   // unresolved about it: the way forward is a new session, and the refusal
   // says so rather than reading as a create of unknown outcome.
   if(resolved.digest!==digest)throw new CunaError({code:'cuna.provider.pending_intent_conflict',message:'The recorded launch used another Workspace version or preset, so it cannot be resumed. Nothing was sent.',exitCode:EXIT_CODES.conflict,hint:'Answer y to the question, or run the same command with --new-session, to start a new session.',details:{reason:'recorded_launch_mismatch'}});
   return {kind:'resume',operationId:resolved.operationId};
  }
 }
 if(pending.length===0&&latest.size>=1024)throw new CunaError({code:'cuna.provider.intent_history_full',message:'The local provider launch history is full. Inspect it before starting another launch.',exitCode:EXIT_CODES.conflict});
 return pending[0]===undefined?{kind:'dispatch'}:{kind:'dispatch',pending:pending[0]};
}

function recordedLaunchEnded(agentSessionId:string):CunaError{
 return new CunaError({code:'cuna.provider.recorded_launch_ended',message:`The session this folder last launched (${agentSessionId.slice(0,8)}) has ended, so there is nothing to resume. Nothing was started.`,exitCode:EXIT_CODES.conflict,hint:'Answer y to the question, or run the same command with --new-session, to start a new session.',details:{reason:'recorded_launch_ended',agent_session_id:agentSessionId}});
}

/** The latest record per operation, read without taking the writer lease. A journal that does not exist yet has none. */
async function readLaunchRecords(directory:string):Promise<{latest:ReadonlyMap<string,JournalRecord>;fingerprint:string}>{
 let records:readonly JournalRecord[];
 try{records=(await inspectSyncJournal(directory)).records;}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')records=[];else throw error;}
 return {latest:new Map(records.map(record=>[record.operationId,record])),fingerprint:`${records.length}:${records.at(-1)?.checksum??''}`};
}

/**
 * Which AgentSession each recorded launch produced. A hint, not authority:
 * it only decides which question to ask, and a missing or unreadable file
 * reads as "unknown", which falls back to checking the replay's result.
 */
async function readLaunchSessions(directory:string):Promise<ReadonlyMap<string,string>>{
 try{
  const value=JSON.parse(await readFile(join(directory,SESSIONS_FILE),'utf8')) as unknown;
  if(value===null||typeof value!=='object'||Array.isArray(value))return new Map();
  return new Map(Object.entries(value as Record<string,unknown>).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));
 }catch{return new Map();}
}

/** Written under the journal's writer lease, by rename, so a reader never sees half a file. */
async function rememberLaunchSession(directory:string,operationId:string,agentSessionId:string):Promise<void>{
 const sessions=new Map(await readLaunchSessions(directory));
 if(typeof agentSessionId!=='string'||sessions.get(operationId)===agentSessionId)return;
 sessions.set(operationId,agentSessionId);
 const temporary=join(directory,`${SESSIONS_FILE}.${randomUUID()}.tmp`);
 // The launch already happened; failing to note its session only costs the
 // better question next time, never this launch.
 try{
  await writeFile(temporary,`${JSON.stringify(Object.fromEntries(sessions))}\n`,{encoding:'utf8',mode:0o600,flag:'wx'});
  await rename(temporary,join(directory,SESSIONS_FILE));
 }catch{/* a hint that could not be written is a hint not kept */}
}
