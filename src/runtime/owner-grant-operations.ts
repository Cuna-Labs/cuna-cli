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

export interface OwnerGrantOperationStore {
  /** Persist one unresolved operation before its request leaves. Refuses to overwrite an existing identity. */
  reserve(intent:OwnerGrantOperationIntent):Promise<PendingOwnerGrantOperation>;
  /** Drop the record once the outcome is known. Failure to drop over-reports, which is the safe direction. */
  settle(operationId:string):Promise<void>;
  /** Every operation in this scope whose outcome is still unknown here. */
  list(signal?:AbortSignal):Promise<readonly PendingOwnerGrantOperation[]>;
}

export function ownerGrantOperationStore(platform:PlatformAdapter,scope:OwnerGrantOperationScope):OwnerGrantOperationStore{
 const digest=scopeDigest(scope);
 const directory=join(platform.paths.stateDirectory,'owner-observe-grants-v2',digest);
 const file=(operationId:string)=>join(directory,`${operationId}.json`);
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
 };
 return Object.freeze(store);
}
