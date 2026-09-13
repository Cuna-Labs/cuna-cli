import {createHash} from 'node:crypto';
import {lstat,opendir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import type {PlatformAdapter} from '../platform/adapter.js';
import {assertCanonicalUuid} from '../core/validation.js';

/**
 * Durable identity for one in-flight owner grant mutation.
 *
 * Modelled on `machines/execution-receipt.ts`: one immutable file per operation
 * ID, written BEFORE the request is dispatched, so a process that dies between
 * dispatch and answer still knows which authority it may have created or which
 * session it may have started sharing. Nothing secret is persisted -- only
 * UUIDs, integers and the operation kind and action. No bearer, no email, no
 * session name, no grant secret.
 *
 * A record's presence means "the outcome of this exact operation is unknown
 * here". It is never permission to replay: replay is an explicit human action
 * that reuses the SAME operation ID, and only the server can say what exists.
 */
export interface OwnerGrantOperationScope {
  readonly baseUrl:string;
  readonly profile:string;
  readonly ownerPrincipalId:string;
  readonly projectId:string;
}
export interface PendingCreateOperation {
  readonly version:1;readonly scope:string;readonly operationId:string;readonly kind:'create';
  readonly agentSessionId:string;readonly subjectPrincipalId:string;
  readonly expectedMembershipRevision:number;readonly expiresAtMs:number;
}
export interface PendingRevokeOperation {
  readonly version:1;readonly scope:string;readonly operationId:string;readonly kind:'revoke';
  readonly grantId:string;readonly agentSessionId:string;readonly subjectPrincipalId:string;
  readonly expectedRevision:number;
}
/**
 * An unanswered publish or return-to-private.
 *
 * It carries no subject: publication is a property of the session, not of one
 * member. The action is part of the durable identity because
 * `issue_collab_v2_session_audience_request` refuses an operation ID replayed
 * with a different action -- replaying the wrong one would turn a recoverable
 * request into a conflict.
 */
export interface PendingAudienceOperation {
  readonly version:1;readonly scope:string;readonly operationId:string;readonly kind:'audience';
  readonly action:'publish'|'private';readonly agentSessionId:string;
}
export type PendingOwnerGrantOperation=PendingCreateOperation|PendingRevokeOperation|PendingAudienceOperation;
export type OwnerGrantOperationIntent=Omit<PendingCreateOperation,'version'|'scope'>|Omit<PendingRevokeOperation,'version'|'scope'>|Omit<PendingAudienceOperation,'version'|'scope'>;

const MAXIMUM_BYTES=2048;
const RECORD_NAME=/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/u;
const CREATE_KEYS='agentSessionId,expectedMembershipRevision,expiresAtMs,kind,operationId,scope,subjectPrincipalId,version';
const REVOKE_KEYS='agentSessionId,expectedRevision,grantId,kind,operationId,scope,subjectPrincipalId,version';
const AUDIENCE_KEYS='action,agentSessionId,kind,operationId,scope,version';

function scopeDigest(scope:OwnerGrantOperationScope):string{
 const url=new URL(scope.baseUrl);
 if(url.username||url.password||url.search||url.hash||!['https:','http:'].includes(url.protocol)||!scope.profile)throw new Error('Invalid owner grant operation scope.');
 assertCanonicalUuid(scope.ownerPrincipalId,'Principal ID');assertCanonicalUuid(scope.projectId,'Project ID');
 return createHash('sha256').update(JSON.stringify(['owner-observe-grants-v2',url.href,scope.profile,scope.ownerPrincipalId,scope.projectId])).digest('hex');
}
function record(scope:OwnerGrantOperationScope,intent:OwnerGrantOperationIntent):PendingOwnerGrantOperation{
 const digest=scopeDigest(scope);
 assertCanonicalUuid(intent.operationId,'Operation ID');
 assertCanonicalUuid(intent.agentSessionId,'AgentSession ID');
 if(intent.kind==='audience'){
  if(intent.action!=='publish'&&intent.action!=='private')throw new Error('Invalid sharing action.');
  return Object.freeze({version:1,scope:digest,operationId:intent.operationId,kind:'audience',action:intent.action,agentSessionId:intent.agentSessionId});
 }
 assertCanonicalUuid(intent.subjectPrincipalId,'Principal ID');
 if(intent.kind==='create'){
  if(!Number.isSafeInteger(intent.expectedMembershipRevision)||intent.expectedMembershipRevision<1)throw new Error('Invalid membership revision.');
  if(!Number.isSafeInteger(intent.expiresAtMs)||intent.expiresAtMs<0)throw new Error('Invalid expiry.');
  return Object.freeze({version:1,scope:digest,operationId:intent.operationId,kind:'create',agentSessionId:intent.agentSessionId,subjectPrincipalId:intent.subjectPrincipalId,expectedMembershipRevision:intent.expectedMembershipRevision,expiresAtMs:intent.expiresAtMs});
 }
 assertCanonicalUuid(intent.grantId,'Grant ID');
 if(!Number.isSafeInteger(intent.expectedRevision)||intent.expectedRevision<1)throw new Error('Invalid grant revision.');
 return Object.freeze({version:1,scope:digest,operationId:intent.operationId,kind:'revoke',grantId:intent.grantId,agentSessionId:intent.agentSessionId,subjectPrincipalId:intent.subjectPrincipalId,expectedRevision:intent.expectedRevision});
}

/**
 * The newest audience fact this computer holds about one run of one AgentSession.
 *
 * It exists because ordering is otherwise per-process: two `cuna share`
 * processes on one state directory each kept their knowledge in a closure, so a
 * reading answered in one could be painted as the present after the other had
 * already confirmed the opposite. This record is the shared ground both read.
 *
 * It is deliberately NOT a clock and NOT a local counter. The order comes from
 * the producer's own arithmetic: `issue_collab_v2_session_audience_request`
 * answers a publish at `expected_generation + 1` and a return to private at
 * `expected_generation`, and refuses to issue while an answer is outstanding.
 * So generation G can only be created by the publish that answers `public@G`,
 * and any `private@G` must have been issued when G already existed -- meaning
 * `public@G` always precedes `private@G`, and nothing can put a second
 * `public@G` after it. `(generation, state)` is therefore a total order over one
 * run, computed in `audienceFactRank`, and no local tie-break is invented.
 *
 * It is bound to the exact run: a fact about another `sessionIncarnation` or
 * `processEpoch` says nothing about this one and is never compared to it.
 * Nothing secret is persisted -- identifiers, a state word and a counter.
 */
export interface ConfirmedAudienceFact {
  readonly version:1;readonly scope:string;readonly agentSessionId:string;
  readonly sessionIncarnation:string;readonly processEpoch:string;
  /** `transition` is a decision this account had confirmed here; `reading` is an answer the session gave here. */
  readonly kind:'transition'|'reading';
  readonly state:'public'|'private';readonly generation:string;
}
export type ConfirmedAudienceFactInput=Omit<ConfirmedAudienceFact,'version'|'scope'>;
export interface OwnerGrantOperationStore {
  /** Persist one unresolved operation before its request leaves. Refuses to overwrite an existing identity. */
  reserve(intent:OwnerGrantOperationIntent):Promise<PendingOwnerGrantOperation>;
  /** Drop the record once the outcome is known. Failure to drop over-reports, which is the safe direction. */
  settle(operationId:string):Promise<void>;
  /** Every operation in this scope whose outcome is still unknown here. */
  list(signal?:AbortSignal):Promise<readonly PendingOwnerGrantOperation[]>;
  /** The newest audience fact recorded on this computer for this session, or null. Unreadable bytes throw rather than read as absence. */
  readAudienceFact(agentSessionId:string):Promise<ConfirmedAudienceFact|null>;
  /** Record one fact. A fact the stored one already supersedes is not written, and the stored winner is returned either way. */
  recordAudienceFact(input:ConfirmedAudienceFactInput):Promise<ConfirmedAudienceFact>;
}
const AUDIENCE_FACT_KEYS='agentSessionId,generation,kind,processEpoch,scope,sessionIncarnation,state,version';
/**
 * The producer's own order over one run, as one number.
 *
 * `2*generation + (private ? 1 : 0)`: a higher generation always wins, and at an
 * equal generation `private` is never older than `public`, because the publish
 * that created G answers `public@G` and every `private@G` is issued after G
 * exists. Equal ranks agree and need no tie-break.
 */
export function audienceFactRank(fact:{state:'public'|'private';generation:string}):bigint{
 return BigInt(fact.generation)*2n+(fact.state==='private'?1n:0n);
}
/** True when `candidate` describes a strictly earlier moment of the same run than `held`. */
export function audienceFactIsOlder(candidate:{state:'public'|'private';generation:string},held:{state:'public'|'private';generation:string}):boolean{
 return audienceFactRank(candidate)<audienceFactRank(held);
}
/** True when two facts describe the same run and can therefore be ordered against each other. */
export function audienceFactSameRun(a:{sessionIncarnation:string;processEpoch:string},b:{sessionIncarnation:string;processEpoch:string}):boolean{
 return a.sessionIncarnation===b.sessionIncarnation&&a.processEpoch===b.processEpoch;
}

function audienceFact(scope:OwnerGrantOperationScope,input:ConfirmedAudienceFactInput):ConfirmedAudienceFact{
 const digest=scopeDigest(scope);
 assertCanonicalUuid(input.agentSessionId,'AgentSession ID');
 assertCanonicalUuid(input.sessionIncarnation,'Session incarnation');
 assertCanonicalUuid(input.processEpoch,'Process epoch');
 if(input.kind!=='transition'&&input.kind!=='reading')throw new Error('Invalid audience fact kind.');
 if(input.state!=='public'&&input.state!=='private')throw new Error('Invalid audience state.');
 if(!/^(?:0|[1-9][0-9]{0,19})$/u.test(input.generation)||BigInt(input.generation)>18446744073709551615n)throw new Error('Invalid audience generation.');
 return Object.freeze({version:1,scope:digest,agentSessionId:input.agentSessionId,sessionIncarnation:input.sessionIncarnation,processEpoch:input.processEpoch,kind:input.kind,state:input.state,generation:input.generation});
}
export function ownerGrantOperationStore(platform:PlatformAdapter,scope:OwnerGrantOperationScope):OwnerGrantOperationStore{
 const digest=scopeDigest(scope);
 const directory=join(platform.paths.stateDirectory,'owner-observe-grants-v2',digest);
 const file=(operationId:string)=>join(directory,`${operationId}.json`);
 // A separate tree, so an audience fact can never be mistaken for an unresolved
 // operation by `list()` and cannot make that scan fail closed.
 const factFile=(agentSessionId:string)=>{assertCanonicalUuid(agentSessionId,'AgentSession ID');return join(platform.paths.stateDirectory,'owner-audience-facts-v2',digest,`${agentSessionId}.json`);};
 const readFact=async(agentSessionId:string):Promise<ConfirmedAudienceFact|null>=>{
  const path=factFile(agentSessionId);
  const snapshot=await platform.readSafeConfig(path,MAXIMUM_BYTES);
  if(!snapshot.exists)return null;
  let value:unknown;try{value=JSON.parse(snapshot.text??'');}catch{throw new Error(`A local audience state record is unreadable: ${path}`);}
  if(typeof value!=='object'||value===null||Array.isArray(value))throw new Error(`Invalid local audience state record: ${path}`);
  const row=value as Record<string,unknown>;
  if(row.version!==1||row.scope!==digest||row.agentSessionId!==agentSessionId||Object.keys(row).sort().join(',')!==AUDIENCE_FACT_KEYS)throw new Error(`Invalid local audience state record: ${path}`);
  return audienceFact(scope,row as unknown as ConfirmedAudienceFactInput);
 };
 const store:OwnerGrantOperationStore={
  async reserve(intent){
   const value=record(scope,intent);const text=JSON.stringify(value)+'\n';
   const previous=await platform.readSafeConfig(file(value.operationId),MAXIMUM_BYTES);
   if(previous.exists)throw new Error('This operation ID already has an unresolved record. Resolve it before starting another.');
   await platform.writeSafeConfig(file(value.operationId),text,MAXIMUM_BYTES);
   const saved=await platform.readSafeConfig(file(value.operationId),MAXIMUM_BYTES);
   if(!saved.exists||saved.text!==text)throw new Error('The operation record could not be verified. Nothing was sent.');
   return value;
  },
  async settle(operationId){
   assertCanonicalUuid(operationId,'Operation ID');
   const path=file(operationId);
   try{const metadata=await lstat(path);if(metadata.isSymbolicLink()||!metadata.isFile())throw new Error('Unsafe owner grant operation record.');await unlink(path);}
   catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  },
  async list(signal){
   signal?.throwIfAborted();
   const root=join(platform.paths.stateDirectory,'owner-observe-grants-v2');
   try{for(const target of [root,directory]){const metadata=await lstat(target);if(!metadata.isDirectory()||metadata.isSymbolicLink())throw new Error('Unsafe owner grant operation directory.');}}
   catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return Object.freeze([]);throw new Error('Local owner grant operation records cannot be read safely.');}
   const items:PendingOwnerGrantOperation[]=[];let scanned=0;
   for await (const entry of await opendir(directory)){
    signal?.throwIfAborted();
    if(++scanned>4096)throw new Error('Too many local operation records to list safely. No partial result is shown.');
    const match=RECORD_NAME.exec(entry.name);if(match===null)continue;
    const path=join(directory,entry.name);
    if(!entry.isFile()||entry.isSymbolicLink())throw new Error(`Unsafe owner grant operation record: ${path}`);
    const snapshot=await platform.readSafeConfig(path,MAXIMUM_BYTES);
    let value:unknown;try{value=JSON.parse(snapshot.text??'');}catch{throw new Error(`A local owner grant operation record is unreadable: ${path}`);}
    // Failing closed is the safe direction, but a message that named no file
    // left no way back: one unreadable record refuses the whole scope, and the
    // person could not know which file to move aside.
    if(typeof value!=='object'||value===null||Array.isArray(value))throw new Error(`Invalid local owner grant operation record: ${path}`);
    const row=value as Record<string,unknown>;
    const keys=Object.keys(row).sort().join(',');
    if(row.version!==1||row.scope!==digest||row.operationId!==match[1]||(row.kind==='create'?keys!==CREATE_KEYS:row.kind==='revoke'?keys!==REVOKE_KEYS:row.kind==='audience'?keys!==AUDIENCE_KEYS:true))throw new Error(`Invalid local owner grant operation record: ${path}`);
    items.push(record(scope,row as unknown as OwnerGrantOperationIntent));
   }
   signal?.throwIfAborted();
   return Object.freeze(items.sort((a,b)=>a.operationId.localeCompare(b.operationId)));
  },
  readAudienceFact:agentSessionId=>readFact(agentSessionId),
  /**
   * Record one fact, keeping whichever of the two describes the later moment.
   *
   * A fact about a different run replaces the stored one outright: the counter
   * restarts with the run, so the old one cannot be compared and must not be
   * allowed to order anything about the new one.
   *
   * There is no cross-process lock here, and none can be built from the
   * primitives this store has. Two processes writing at once can lose one
   * write, so the read-back below re-merges once against whatever actually
   * landed; a fact that is still missing after that is reported rather than
   * assumed. The residual window is stated in the delivery, not papered over.
   */
  async recordAudienceFact(input){
   const next=audienceFact(scope,input),path=factFile(next.agentSessionId);
   /** True when what is stored already describes this run at or after `next`. */
   const supersedes=(stored:ConfirmedAudienceFact|null):stored is ConfirmedAudienceFact=>
    stored!==null&&audienceFactSameRun(stored,next)&&!audienceFactIsOlder(stored,next);
   const current=await readFact(next.agentSessionId);
   if(supersedes(current))return current;
   const text=JSON.stringify(next)+'\n';
   await platform.writeSafeConfig(path,text,MAXIMUM_BYTES);
   const saved=await readFact(next.agentSessionId);
   if(saved===null)throw new Error('The audience state record could not be verified after writing.');
   if(supersedes(saved))return saved;
   // An older fact landed between the read and the write. Re-merge once against
   // what is actually there; either way the store ends holding a fact some
   // process really observed, never one invented to break a tie.
   await platform.writeSafeConfig(path,text,MAXIMUM_BYTES);
   const settled=await readFact(next.agentSessionId);
   if(settled===null)throw new Error('The audience state record could not be verified after writing.');
   return settled;
  },
 };
 return Object.freeze(store);
}
