import {ownerObserveGrantSchemas,ownerObserveGrantOperations} from './owner-observe-grants-v2-schema.js';
import type {HttpTransport} from './http.js';
import {assertCanonicalUuid} from '../core/validation.js';
import {CunaError,EXIT_CODES} from '../core/errors.js';

// Owner side of one session observation grant: create for a distinct Project
// member, inspect its current authority, revoke it. The recipient decoder in
// observer-v2.ts is deliberately not shared or modified; this module binds the
// owner schemas projected by scripts/project-owner-observe-grants-v2.mjs.
type Schema={$ref?:string;type?:string|string[];const?:unknown;enum?:unknown[];pattern?:string;format?:string;default?:unknown;minimum?:number;maximum?:number;minLength?:number;maxLength?:number;required?:string[];properties?:Record<string,Schema>;additionalProperties?:boolean;items?:Schema;maxItems?:number;anyOf?:Schema[];allOf?:Schema[];if?:Schema;then?:Schema;else?:Schema};
const schemas=ownerObserveGrantSchemas as unknown as Record<string,Schema>;
function valid(v:unknown,s:Schema):boolean{
 if(s.$ref)return valid(v,schemas[s.$ref.split('/').at(-1)!]!);
 if(s.allOf&&!s.allOf.every(x=>valid(v,x)))return false;if(s.anyOf&&!s.anyOf.some(x=>valid(v,x)))return false;if(s.if){const branch=valid(v,s.if)?s.then:s.else;if(branch&&!valid(v,branch))return false;}
 if(s.const!==undefined&&v!==s.const||s.enum&&!s.enum.includes(v))return false;
 if(Array.isArray(s.type))return s.type.some(type=>valid(v,{...s,type}));
 if(s.type==='null')return v===null;
 if(s.type==='string')return typeof v==='string'&&v.length>=(s.minLength??0)&&v.length<=(s.maxLength??Infinity)&&(!s.pattern||new RegExp(s.pattern).test(v));
 if(s.type==='integer')return typeof v==='number'&&Number.isSafeInteger(v)&&v>=(s.minimum??-Infinity)&&v<=(s.maximum??Infinity);
 if(s.type==='array')return Array.isArray(v)&&v.length<=(s.maxItems??Infinity)&&v.every(x=>s.items&&valid(x,s.items));
 if(s.type==='object'||s.properties||s.required){if(!v||typeof v!=='object'||Array.isArray(v))return false;const row=v as Record<string,unknown>;const descriptors=Object.getOwnPropertyDescriptors(row);if(Reflect.ownKeys(row).some(k=>typeof k!=='string'||!descriptors[k]?.enumerable||!('value' in descriptors[k]!)))return false;return !(s.required??[]).some(k=>!Object.hasOwn(row,k))&&Object.keys(row).every(k=>s.properties?.[k]?valid(row[k],s.properties[k]!):s.additionalProperties!==false);}
 return true;
}

/** Every way an owner grant operation can fail, each rendered differently. */
export type OwnerGrantFailureKind='malformed_receipt'|'identity_mismatch'|'stale_revision'|'operation_conflict'|'grant_unavailable'|'denied'|'not_found'|'auth'|'uncertain'|'unavailable'|'aborted';
/**
 * Which owner operation a transport failure belongs to.
 *
 * The producer collapses several distinct causes into one code -- a stale
 * membership revision, a lost Project ownership and an unknown grant all leave
 * `create_collab_v2_session_observe_grant` as `collab_v2_observe_unavailable`,
 * which the Edge renders as one 404 `grant_unavailable`. The status alone
 * therefore cannot say what happened; the operation the CLI issued is what
 * makes the rendered sentence true instead of merely typed.
 */
export type OwnerGrantOperation='create'|'revoke'|'inspect'|'members';
export class OwnerGrantError extends CunaError{
 readonly kind:OwnerGrantFailureKind;
 /**
  * True when the server-side effect of this attempt is UNDETERMINED.
  *
  * A refusal the server issued before acting (denied, stale revision, unknown
  * grant, rejected credential) settles the outcome: nothing changed. A lost
  * answer, a local cancellation after dispatch, or a receipt this CLI refused
  * to trust does NOT: the authority may exist. Only the first kind may drop a
  * durable operation record.
  */
 readonly effectUnknown:boolean;
 constructor(kind:OwnerGrantFailureKind,message:string,cause?:unknown,reason?:string,effectUnknown=false){
  super({code:`cuna.share.${kind}`,message,exitCode:kind==='denied'||kind==='identity_mismatch'||kind==='malformed_receipt'?EXIT_CODES.policy:kind==='stale_revision'||kind==='operation_conflict'?EXIT_CODES.conflict:kind==='auth'?EXIT_CODES.auth:kind==='not_found'||kind==='grant_unavailable'?EXIT_CODES.remote:EXIT_CODES.network,retryable:kind==='unavailable',...(reason===undefined?{}:{details:{reason}}),...(cause===undefined?{}:{cause})});
  this.kind=kind;this.effectUnknown=effectUnknown;
 }
}
/** Re-mint a failure raised after a mutation left this process: its effect is not settled, whatever the reason reads like. */
export function withUnknownEffect(error:OwnerGrantError):OwnerGrantError{
 return error.effectUnknown?error:new OwnerGrantError(error.kind,error.message,error.cause,typeof error.details?.reason==='string'?error.details.reason:undefined,true);
}
const malformed=(what:string)=>new OwnerGrantError('malformed_receipt',`Cuna answered with a ${what} that does not match the collaboration contract. Nothing was trusted from it.`);
const mismatch=(what:string)=>new OwnerGrantError('identity_mismatch',`Cuna answered about a different ${what}. The receipt was refused.`);
function check(value:unknown,name:string,what:string){if(!valid(value,schemas[name]!))throw malformed(what);}

/**
 * What a 404 `grant_unavailable` actually means, per operation.
 *
 * Read at infra `2d61dd11494e76e5b48623b57aa99d3649dee2ff`.
 * `edge/src/session-observe-grant-v2.ts` maps `collab_v2_observe_unavailable`,
 * `collab_v2_membership_unavailable` and `collab_v2_invitation_unavailable` to
 * `grant_unavailable`, and `edge/src/api.ts:2247` renders that as 404. In
 * migration 0183 the create raises `collab_v2_observe_unavailable` when the
 * subject is not an active observer AT the expected membership revision, when
 * the caller does not own the session's authority, or when the expiry is not
 * inside `(now, now+7 days]`; `require_collab_v2_project_owner` (0175) raises
 * `collab_v2_membership_unavailable` when the caller is not the Project's
 * present active owner -- so losing ownership arrives here as a 404, NOT as the
 * 403. Revoke raises it when the grant is missing, not owned, not active, or
 * not at the expected revision. Inspect returns null, which the Edge turns into
 * the same 404, when the actor is neither owner nor subject.
 */
const GRANT_UNAVAILABLE:Readonly<Record<OwnerGrantOperation,string>>=Object.freeze({
 create:"Cuna refused this grant and created nothing. The member is no longer an active observer at the membership revision that was read, this account is no longer the Project's active owner, the session is not one it owns, or the requested expiry is outside the window Cuna accepts. Reread the members and decide again.",
 revoke:"Cuna refused this revocation and changed nothing. The grant is no longer active at the revision that was read - it may already be revoked or expired - or this account is no longer the Project's active owner. Inspect the grant to read its current state.",
 inspect:'Cuna does not know this grant for this account. It may never have existed, or this account is neither its owner nor its subject.',
 members:"Cuna would not list this Project's members. This account is not the Project's present active owner, or the Project's authority is not in a state Cuna can read members from.",
});
/**
 * What a 409 `operation_conflict` actually means, per operation.
 *
 * The Edge maps two producer facts onto this one code: the explicit
 * `collab_v2_observe_operation_conflict` raised when an operation ID is
 * replayed with a different actor, action or request tuple, and PostgreSQL
 * `23505`, which on create is the partial unique index
 * `collab_v2_one_active_observe_grant(agent_session_id, session_incarnation,
 * subject_id) where state='active'`. Both abort the transaction, so this
 * attempt applied nothing -- but the second says an equivalent authority
 * already exists, which the owner must be told.
 */
const OPERATION_CONFLICT:Readonly<Record<OwnerGrantOperation,string>>=Object.freeze({
 create:'Cuna refused this as a conflict and this attempt created nothing. Either this exact operation ID was already used for a different request, or an active grant for this member on this session already exists.',
 revoke:'Cuna refused this as a conflict and this attempt changed nothing. This exact operation ID was already used for a different revocation request. Inspect the grant to read its current state.',
 inspect:'Cuna answered this read with a conflict. A read carries no operation identity and applies nothing, so read again.',
 members:'Cuna answered this read with a conflict. A read carries no operation identity and applies nothing, so read again.',
});
const pick=(table:Readonly<Record<OwnerGrantOperation,string>>,operation:OwnerGrantOperation|undefined,fallback:string)=>operation===undefined?fallback:table[operation];
/**
 * Map a transport failure to one typed owner failure.
 *
 * A mutation whose answer never arrived is uncertain, never assumed failed or
 * applied. Beyond that, the status is only believed as a collaboration answer
 * when the Problem document names the collaboration code that produces it: a
 * 404 that names no reason is a different event from `grant_unavailable`, and
 * saying "Cuna does not know this grant" about it would invent a cause.
 */
export function classifyTransportFailure(error:unknown,mutation:boolean,operation?:OwnerGrantOperation):OwnerGrantError{
 if(error instanceof OwnerGrantError)return error;
 if(error instanceof CunaError){
  const status=typeof error.details?.http_status==='number'?error.details.http_status:undefined;
  const reason=typeof error.details?.reason==='string'?error.details.reason:error.code;
  if(error.code==='cuna.auth.rejected')return new OwnerGrantError('auth','Cuna rejected the current sign-in. Run `cuna login` and retry.',error,reason);
  // 403 is the Edge's own principal check -- auth class plus `collaboration:manage`.
  // Project ownership is proved later, inside the transaction, and its failure
  // is a 404. Naming ownership here would send the owner after the wrong thing.
  if(status===403||error.code==='cuna.policy.denied')return new OwnerGrantError('denied','Cuna denied this action for this sign-in: it does not carry collaboration:manage. Project ownership is checked separately and is not what this answer reports.',error,reason);
  if(status===409)return new OwnerGrantError('operation_conflict',reason==='operation_conflict'?pick(OPERATION_CONFLICT,operation,'Cuna refused this as a conflict. This attempt applied nothing.'):'Cuna answered with a conflict but named no collaboration reason. This attempt applied nothing; nothing further can be concluded from it.',error,reason);
  // A deployment that does not implement the route is not a missing grant.
  if(status===404&&error.code==='cuna.remote.operation_not_served')return new OwnerGrantError('unavailable',`This Cuna deployment does not serve the collaboration grant operations this build uses. ${error.message}`,error,reason);
  if(status===404)return new OwnerGrantError(reason==='grant_unavailable'?'grant_unavailable':'not_found',reason==='grant_unavailable'?pick(GRANT_UNAVAILABLE,operation,'Cuna refused this: the grant, session, membership or Project authority it needs is not available to this account.'):'Cuna answered 404 and named no collaboration reason, so which grant, session, membership or Project it means is unknown.',error,reason);
  if(status===422)return new OwnerGrantError('unavailable','Cuna rejected the request as invalid for the collaboration contract and never reached the grant store, so nothing changed.',error,reason);
  if(status!==undefined&&status>=400&&status<500)return new OwnerGrantError('unavailable','Cuna rejected the request without a collaboration answer.',error,reason);
  if(mutation)return new OwnerGrantError('uncertain','The answer to this change never arrived. Its outcome is unknown until reconciled.',error,reason,true);
  return new OwnerGrantError('unavailable','Cuna could not be reached for this read.',error,reason);
 }
 if(error instanceof Error&&error.name==='AbortError')return new OwnerGrantError('aborted','The action was cancelled locally.',error,undefined,mutation);
 return mutation?new OwnerGrantError('uncertain','The answer to this change never arrived. Its outcome is unknown until reconciled.',error,undefined,true):new OwnerGrantError('unavailable','Cuna could not be reached for this read.',error);
}

export type OwnerGrantState='active'|'revoking'|'revoked'|'expired';
export type OwnerGrant={version:'2';kind:'session_observe_grant';grant_id:string;revision:number;owner_principal_id:string;subject_principal_id:string;agent_session_id:string;session_incarnation:string;project_id:string;authority_epoch:number;membership_revision:number;state:OwnerGrantState;expires_at:number;revocation_state:'effective_pending'|'effective'|null};
export type ProjectObserver={principal_id:string;membership_revision:number;recipient_email:string|null};
export type ProjectObserverPage={version:'2';kind:'project_observers';project_id:string;authority_epoch:number;items:ProjectObserver[];next_after_principal_id:string|null};
export type CreateGrantInput={agentSessionId:string;subjectPrincipalId:string;expectedMembershipRevision:number;expiresAtMs:number};
/** What the owner already knows about a grant; a receipt must agree with every field present. */
export type GrantReference={grant_id:string;agent_session_id?:string;subject_principal_id?:string;revision?:number};
/** The identity a revocation is aimed at. Every `OwnerGrant` is one; a recovered operation record can build one. */
export type RevocationTarget={grant_id:string;agent_session_id:string;subject_principal_id:string;revision:number};

/**
 * The plain-language meaning of one receipt. `revoking`/`effective_pending`
 * MUST NOT read as "revoked": the endpoint may still be serving frames.
 */
export function describeGrantState(g:OwnerGrant,now=Date.now()):{label:string;detail:string;final:boolean}{
 if(g.state==='active'&&g.expires_at<=now)return{label:'Expired',detail:'The grant reached its expiry. No new observation admission is possible.',final:true};
 if(g.state==='active')return{label:'Active',detail:`Read-only observation may be admitted until ${new Date(g.expires_at).toISOString()}. No keyboard, resize or signal is granted.`,final:false};
 if(g.state==='revoking')return{label:'Revocation requested, not yet effective',detail:'Cuna accepted the revocation but has not confirmed the stream endpoint is retired. The observer may still see output. Inspect again to learn when it is effective.',final:false};
 if(g.state==='revoked')return{label:g.revocation_state==='effective'?'Revoked, effective':'Revoked, endpoint retirement pending',detail:g.revocation_state==='effective'?'Observation access ended and the stream endpoint is retired.':'The grant is revoked but endpoint retirement is not yet confirmed. Inspect again.',final:g.revocation_state==='effective'};
 return{label:'Expired',detail:'The grant reached its expiry. No new observation admission is possible.',final:true};
}

export function decodeOwnerGrant(value:unknown,owner:string,project:string,reference?:GrantReference):OwnerGrant{
 check(value,'SessionObserveGrantV2Receipt','grant receipt');const g=value as OwnerGrant;
 if(g.owner_principal_id!==owner)throw mismatch('owner');
 if(g.project_id!==project)throw mismatch('Project');
 if(g.subject_principal_id===owner)throw new OwnerGrantError('identity_mismatch','Cuna answered with a grant to your own account. Observation grants are for a distinct member.');
 if(reference){if(g.grant_id!==reference.grant_id)throw mismatch('grant');if(reference.agent_session_id!==undefined&&g.agent_session_id!==reference.agent_session_id)throw mismatch('session');if(reference.subject_principal_id!==undefined&&g.subject_principal_id!==reference.subject_principal_id)throw mismatch('member');if(reference.revision!==undefined&&g.revision<reference.revision)throw new OwnerGrantError('stale_revision','Cuna answered with an older revision than the one already read. The receipt was refused.');}
 return structuredClone(g);
}
export function decodeProjectObserverPage(value:unknown,project:string,after:string|null):ProjectObserverPage{
 check(value,'ProjectObserversV2Receipt','member page');const page=value as ProjectObserverPage;
 if(page.project_id!==project)throw mismatch('Project');
 if(page.items.some((m,i)=>m.principal_id<=(i?page.items[i-1]!.principal_id:after??''))||page.next_after_principal_id!==null&&(page.next_after_principal_id<=(after??'')||page.items.some(m=>m.principal_id>page.next_after_principal_id!)))throw malformed('member page order');
 return structuredClone(page);
}

/** Run a receipt check that happens after a mutation was sent, so any refusal reports an undetermined effect. */
function afterDispatch<T>(decode:()=>T):T{
 try{return decode();}catch(error){throw error instanceof OwnerGrantError?withUnknownEffect(error):error;}
}

export function ownerObserveGrantsApi(transport:HttpTransport,owner:string,project:string,verifyPrincipal?:()=>Promise<string>){
 assertCanonicalUuid(project,'Project ID');assertCanonicalUuid(owner,'Principal ID');
 const current=async()=>{if(verifyPrincipal&&await verifyPrincipal()!==owner)throw new OwnerGrantError('identity_mismatch','The signed-in account changed while this action was in flight. Nothing from the answer was trusted.');};
 const send=async(path:string,body:unknown,mutation:boolean,signal:AbortSignal,operation:OwnerGrantOperation)=>{
  await current();let value:unknown;
  try{value=await transport.request({method:'POST',path,body,signal});}catch(error){throw classifyTransportFailure(error,mutation,operation);}
  // The principal re-check below runs after the request was answered, so a
  // mutation that fails it has already reached the server.
  try{await current();}catch(error){throw mutation&&error instanceof OwnerGrantError?withUnknownEffect(error):error;}
  return value;
 };
 return{
  /** Members who currently hold observer membership; membership alone grants nothing. */
  async listMembers(after:string|null,signal:AbortSignal):Promise<ProjectObserverPage>{const body={version:'2',after_principal_id:after,limit:50};check(body,'ListProjectObserversV2Request','member request');return decodeProjectObserverPage(await send(ownerObserveGrantOperations.listProjectObserversV2.path.replace('{id}',project),body,false,signal,'members'),project,after);},
  /** Create with a caller-owned operation ID so an uncertain outcome can be reconciled by replaying the SAME identity, never by minting a second grant. */
  async create(input:CreateGrantInput,operationId:string,signal:AbortSignal):Promise<OwnerGrant>{
   assertCanonicalUuid(input.agentSessionId,'AgentSession ID');assertCanonicalUuid(input.subjectPrincipalId,'Principal ID');
   if(input.subjectPrincipalId===owner)throw new OwnerGrantError('identity_mismatch','You cannot grant observation to your own account. Select a distinct member.');
   const body={version:'2',operation_id:operationId,subject_principal_id:input.subjectPrincipalId,expected_membership_revision:input.expectedMembershipRevision,expires_at_ms:input.expiresAtMs};check(body,'CreateSessionObserveGrantV2Request','grant request');
   // Past this line the request has left. Every refusal below is about an answer
   // we would not trust, which says nothing about whether the grant now exists.
   const answer=await send(ownerObserveGrantOperations.createSessionObserveGrantV2.path.replace('{id}',input.agentSessionId),body,true,signal,'create');
   return afterDispatch(()=>{
    const g=decodeOwnerGrant(answer,owner,project);
    if(g.agent_session_id!==input.agentSessionId)throw mismatch('session');if(g.subject_principal_id!==input.subjectPrincipalId)throw mismatch('member');if(g.membership_revision!==input.expectedMembershipRevision)throw new OwnerGrantError('stale_revision','Cuna created the grant under a different membership revision than the one read. Inspect the grant before relying on it.');if(g.expires_at>input.expiresAtMs)throw mismatch('expiry');
    return g;
   });
  },
  /** A read. Safe to repeat; the only way to learn whether a pending revocation became effective. */
  async inspect(reference:GrantReference,signal:AbortSignal):Promise<OwnerGrant>{assertCanonicalUuid(reference.grant_id,'Grant ID');const body={version:'2'};check(body,'InspectSessionObserveGrantV2Request','inspect request');return decodeOwnerGrant(await send(ownerObserveGrantOperations.inspectSessionObserveGrantV2.path.replace('{id}',reference.grant_id),body,false,signal,'inspect'),owner,project,reference);},
  /**
   * Revoke against the exact revision read. A receipt that still says active
   * contradicts the write and is refused.
   *
   * The target is an identity, not a receipt: grant, session, member and the
   * revision this decision was made against. A full `OwnerGrant` satisfies it,
   * and so does a durable operation record recovered from an earlier process,
   * which is the whole point -- replaying a lost revocation must not require
   * fabricating a server receipt nobody ever sent.
   */
  async revoke(grant:RevocationTarget,operationId:string,signal:AbortSignal):Promise<OwnerGrant>{
   for(const [label,value] of [['Grant ID',grant.grant_id],['AgentSession ID',grant.agent_session_id],['Principal ID',grant.subject_principal_id]] as const)assertCanonicalUuid(value,label);
   if(!Number.isSafeInteger(grant.revision)||grant.revision<1)throw new OwnerGrantError('stale_revision','The grant revision to revoke against is not a revision Cuna could have issued.');
   const body={version:'2',operation_id:operationId,expected_revision:grant.revision};check(body,'RevokeSessionObserveGrantV2Request','revoke request');
   const answer=await send(ownerObserveGrantOperations.revokeSessionObserveGrantV2.path.replace('{id}',grant.grant_id),body,true,signal,'revoke');
   return afterDispatch(()=>{
    const g=decodeOwnerGrant(answer,owner,project,{grant_id:grant.grant_id,agent_session_id:grant.agent_session_id,subject_principal_id:grant.subject_principal_id,revision:grant.revision});
    if(g.state==='active')throw new OwnerGrantError('malformed_receipt','Cuna acknowledged the revocation with a receipt that still says active. The contradiction was refused; inspect the grant.');
    return g;
   });
  }
 };
}
