import {randomUUID} from 'node:crypto';
import {createNodeForegroundTerminalHost} from '../pty/node-host-terminal.js';
import type {ForegroundTerminalHost} from '../terminal/foreground.js';
import {sanitizeHumanTerminalOutput} from '../cli/output.js';
import {describeGrantState,OwnerGrantError,classifyTransportFailure,type ownerObserveGrantsApi,type OwnerGrant,type ProjectObserver} from '../api/owner-observe-grants-v2.js';
import type {OwnerGrantOperationStore,PendingOwnerGrantOperation} from './owner-grant-operations.js';

/** One session the owner may share. `projectId` undefined means the server did not name one. */
export type ShareableSession={id:string;name:string;agent:string;machineName:string;state:string;projectId?:string};
/**
 * What one listing pass actually saw.
 *
 * The reads behind this are bounded -- a fixed number of Machines, one page of
 * AgentSessions each -- so a listing can be a strict subset of what exists. A
 * screen that shows a subset while implying completeness is a false statement
 * about the owner's own account, so the bounds are reported, not hidden.
 */
export type ShareableSessionListing={items:ShareableSession[];omittedMachines:number;machinesWithMoreSessions:number};
export interface ShareableSessionSource{list(signal:AbortSignal):Promise<ShareableSessionListing>}
type Api=ReturnType<typeof ownerObserveGrantsApi>;
type Phase='sessions'|'members'|'duration'|'working'|'grant'|'failure'|'unresolved'|'confirm-forget'|'forgotten';
type CreateInput={agentSessionId:string;subjectPrincipalId:string;expectedMembershipRevision:number;expiresAtMs:number};
const DURATIONS=[['1','1 hour',3600000],['2','8 hours',28800000],['3','24 hours',86400000]] as const;
const CLOSE='Esc / Ctrl+C closes this local view. Observation is read-only: it never grants keyboard control.';
/**
 * CUNA-COL-016-R4: state the real history scope BEFORE the key that grants.
 *
 * Plain language only. Every line is a property of the shipped producer rather
 * than a promise, and the proof stays here instead of on the terminal: the
 * supervisor's `publish_public_audience` documents itself as publishing "future
 * provider output"; `PublicScreenView.reset` starts a blank model and
 * `PublicAudience.publish` returns `starting_sequence: 0`, after which each poll
 * encodes `snapshot()` -- a full redraw of the CURRENTLY VISIBLE screen. So no
 * scrollback and no earlier output is replayed, but the screen still visible on
 * attach is transmitted whole. Migration 0183's
 * `resolve_collab_v2_observer_admission` admits nobody unless the session's
 * latest audience result is `public`, and this CLI issues no audience request at
 * all, so a grant and a live publication are separate facts. Publication does
 * exist as a product capability -- the console's
 * `SessionObserveGrantControlsV2.tsx` calls `observeAccessV2.prepare` ->
 * `prepareSessionAudienceV2` -- so the disclosure names where it is available
 * rather than implying nobody can publish. Which stream and generation a member
 * joins is decided at attach time, which is why the lines below promise a
 * boundary rather than a moment.
 */
const DISCLOSURE=[
 'What the member will see:',
 "  Only what happens from the moment they start watching - a live view of this session's screen.",
 '  Nothing from before that: earlier output and scrollback are never sent to them.',
 '  Whatever is still on the screen when they start watching is visible to them, even if it is from earlier.',
 '  Watching also requires this session to be shared live. That step is in the Cuna web app; this CLI does not do it.',
 '  They can never type, resize or send a signal.',
];

export async function runOwnerGrantsScreen(api:Api,sessions:ShareableSessionSource,store:OwnerGrantOperationStore,identity:{project:string;owner:string},options:{host?:ForegroundTerminalHost;signal?:AbortSignal;initialGrantId?:string;now?:()=>number}={}):Promise<void>{
 const host=options.host??createNodeForegroundTerminalHost(),now=options.now??Date.now,lease=await host.acquire('rich'),abort=new AbortController(),encoder=new TextEncoder();
 let stopped=false,busy=false,phase:Phase='sessions',index=0,items:ShareableSession[]=[],listing:ShareableSessionListing|undefined,members:ProjectObserver[]=[],membersAfter:string|null=null,membersNext:string|null=null,session:ShareableSession|undefined,member:ProjectObserver|undefined,grant:OwnerGrant|undefined,failure:OwnerGrantError|undefined,hostWrites=Promise.resolve();
 // Every operation whose outcome is unknown HERE. The record is on disk before
 // the request leaves, so an exit, a crash or a lost answer cannot lose the
 // operation identity a replay needs. While this list is non-empty, no NEW
 // authority change may start: an unresolved operation is never overwritten.
 let unresolved:PendingOwnerGrantOperation[]=[],cursor=0,refusal:string|undefined;
 // The operation a settled answer just closed. It is kept for the OUTCOME
 // screen only: once the record is gone this string is the last thing that can
 // tie what the owner is reading to what they asked Cuna to do.
 let settled:{operationId:string;kind:'create'|'revoke'}|undefined;
 // Set while `grant` holds a receipt Cuna REPLAYED from storage rather than a
 // reading of current authority. Never presented as the grant's state.
 let replayed:{operationId:string;reason?:string}|undefined;
 let forgetTarget:PendingOwnerGrantOperation|undefined,forgotten:PendingOwnerGrantOperation|undefined;
 let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=resolve;});
 const write=(text:string)=>{hostWrites=hostWrites.then(async()=>{if(!stopped)await host.write(encoder.encode(text));}).catch(()=>{stop();});return hostWrites;};
 const stop=()=>{if(stopped)return;stopped=true;abort.abort();finish();};
 const screen=(title:string,lines:string[],footer:string)=>write('\x1b[H\x1b[2J'+sanitizeHumanTerminalOutput([title,'',...lines,'',footer,CLOSE].join('\n')).replaceAll('\n','\r\n'));
 const mark=(i:number)=>index===i?'>':' ';
 const short=(id:string)=>id.slice(0,8);
 const sessionLine=(s:ShareableSession,i:number)=>`${mark(i)} ${s.machineName} / ${s.name}  ${s.agent}  ${s.state}${s.projectId===undefined?'  (Project not named by server)':''}  ${short(s.id)}`;
 const memberLine=(m:ProjectObserver,i:number)=>`${mark(i)} ${m.recipient_email??'(no email on record)'}  ${short(m.principal_id)}  membership rev ${m.membership_revision}`;
 const banner=()=>unresolved.length?['',`${unresolved.length} earlier change${unresolved.length===1?' has':'s have'} an unknown outcome. Press p to return to ${unresolved.length===1?'it':'them'}.`,'No new grant or revocation can start until it is resolved or its local record is forgotten.']:[];
 /** Say what this listing could not see. Silence here would claim a completeness the reads do not have. */
 const limits=()=>{
  if(!listing)return[];const parts:string[]=[];
  if(listing.omittedMachines>0)parts.push(`${listing.omittedMachines} further Machine${listing.omittedMachines===1?' was':'s were'} not read`);
  if(listing.machinesWithMoreSessions>0)parts.push(`${listing.machinesWithMoreSessions} Machine${listing.machinesWithMoreSessions===1?' has':'s have'} more AgentSessions than one page`);
  return parts.length?['',`This list is incomplete: ${parts.join(', and ')}. Sessions not shown here cannot be shared from this screen.`]:[];
 };
 const paintSessions=()=>{phase='sessions';return screen('Share a session - read-only observation',[...(items.length?items.map(sessionLine):['No AgentSessions in this Project were found on your Machines.']),...limits(),...banner()],'Up/Down selects; Enter chooses the session; r refreshes.');};
 const paintMembers=()=>{phase='members';return screen(`Choose the member who may observe ${session!.name}`,[...(members.length?members.map(memberLine):['No other members hold observer membership in this Project. Invite one in the web app first; an invitation alone grants no observation.']),'','Membership lets a member be granted observation; it grants nothing by itself.',...banner()],'Up/Down selects; Enter chooses; n next page; r refreshes; b back.');};
 const paintDuration=()=>{phase='duration';return screen(`Grant ${member!.recipient_email??short(member!.principal_id)} read-only observation of ${session!.name}`,[...DURATIONS.map(([key,label])=>`  ${key}  ${label}`),'',...DISCLOSURE,...banner()],'Press 1, 2 or 3 to create the grant; b back.');};
 const paintGrant=()=>{phase='grant';const g=grant!,d=describeGrantState(g,now()),stored=replayed;
  return screen(`Observation grant ${short(g.grant_id)} - ${stored?'stored answer, not current authority':d.label}`,
   [`Session   ${g.agent_session_id}`,`Member    ${g.subject_principal_id}`,`State     ${g.state}${g.revocation_state===null?'':` / ${g.revocation_state}`}   revision ${g.revision}`,`Expires   ${new Date(g.expires_at).toISOString()}`,'',
    ...(stored
     ? [`This is the receipt Cuna stored when operation ${stored.operationId} was first answered, replayed unchanged. It cannot show a revocation made since, so it is not evidence that this grant is still ${g.state}.`,
        ...(stored.reason===undefined?[]:[`Reading the current state did not answer: ${stored.reason}`]),
        'Press i to read the grant\'s current state.']
     : [d.detail]),
    ...banner()],
   stored?'i reads the current state; b back to sessions.':d.final?'i inspects again; b back.':g.state==='active'?'x revokes; i inspects the current state; b back to sessions.':'i inspects again (no scheduled polling); b back to sessions.');};
 /** True when rereading the Project members is the actual recovery for this refusal. */
 const rereadsMembers=(f:OwnerGrantError)=>!grant&&session!==undefined&&(f.kind==='stale_revision'||f.kind==='grant_unavailable');
 const paintFailure=()=>{phase='failure';const f=failure!;
  return screen(`Not done - ${f.kind.replaceAll('_',' ')}`,
   [f.message,
    // `settled` is set only when a MUTATION was refused with its effect known,
    // so this is the one place the no-effect claim is proved by the answer. A
    // read reaching this screen changed nothing by construction and needs no
    // such line; asserting one for every failure claimed more than was known.
    ...(settled===undefined?[]:['',
     'This attempt applied nothing.',
     // The record is gone by the time this renders, so this is the last link
     // between the sentence above and the thing the owner asked Cuna to do.
     `Operation ${settled.operationId} (${settled.kind==='create'?'grant':'revocation'}) is settled: Cuna answered it, so its local record was dropped.`]),
    ...banner()],
   rereadsMembers(f)?'r rereads the members; b back.':grant?'i inspects the grant; b back.':'b back to sessions.');};
 /**
  * The recovery screen, reached on relaunch as well as in-session.
  *
  * It states what is known and what is not, and does not claim the CLI can
  * determine a create's outcome: the canonical contract has no owner-side
  * listing of a session's grants, so an unanswered create can only be replayed
  * under its own operation identity or checked in the web app. A revoke is
  * different -- the grant ID is known, so inspecting it answers the question.
  */
 const paintUnresolved=()=>{phase='unresolved';
  // A resend the server SETTLES empties this list, and the reason it settled on
  // is then the only explanation that exists -- the durable record it would
  // otherwise have been read from has just been destroyed. Falling through to
  // the session list here rendered nothing at all, which is what the owner saw
  // on a 404 or a 409 replay.
  if(!unresolved.length)return failure?paintFailure():paintSessions();
  cursor=Math.min(cursor,unresolved.length-1);const row=unresolved[cursor]!;
  const lines=unresolved.map((op,i)=>`${cursor===i?'>':' '} ${op.kind==='create'?'grant ':'revoke'}  operation ${op.operationId}`);
  lines.push('',row.kind==='create'
   ? `Grant for member ${row.subjectPrincipalId} on session ${row.agentSessionId}, membership revision ${row.expectedMembershipRevision}, expiring ${new Date(row.expiresAtMs).toISOString()}.`
   : `Revocation of grant ${row.grantId} (member ${row.subjectPrincipalId}, session ${row.agentSessionId}) against revision ${row.expectedRevision}.`);
  lines.push('',row.kind==='create'
   ? "Cuna never confirmed this. The grant may or may not exist, and this CLI cannot tell: the collaboration contract has no owner-side listing of a session's grants. Resending reuses this exact operation ID, so it cannot create a second grant. The web app is the other way to find out."
   : 'Cuna never confirmed this. Inspecting the grant answers it directly, because the grant ID is known. Resending reuses this exact operation ID and the same expected revision.');
  if(failure)lines.push('',`Last reason: ${failure.message}`);
  if(refusal)lines.push('',refusal);
  return screen(`Unresolved change${unresolved.length===1?'':'s'} - outcome unknown`,lines,`Up/Down selects; r resends this exact operation; ${row.kind==='revoke'?'i inspects the grant; ':''}d forgets the local record only; b back to sessions.`);
 };
 /**
  * Deleting the record is irreversible and revokes nothing, so it is asked
  * before it is done and named after it is done.
  */
 const paintConfirmForget=()=>{phase='confirm-forget';const op=forgetTarget!;
  return screen('Forget this local record?',
   [`${op.kind==='create'?'Grant':'Revocation'} operation ${op.operationId}`,'',
    'This deletes the local record only. Cuna is not contacted and nothing is revoked.',
    // Reaching Cuna is not the same as taking effect, and the outcome here is
    // unknown by definition. Both branches stay conditional on the effect, not
    // on delivery, and neither states that an authority exists.
    op.kind==='create'
     ? "The outcome stays unknown. If that request did take effect, a grant exists and the member may be able to observe this session - and after this, no screen in this CLI can name or replay that operation, because the collaboration contract has no owner-side listing of a session's grants. The web app becomes the only way to find out."
     : `The outcome stays unknown. If that request did take effect, the revocation applied. Grant ${op.grantId} stays readable by ID either way, so its state is still reachable; the operation identity is not.`,
    '','This cannot be undone.'],
   'Press y to forget it; any other key keeps it.');};
 const paintForgotten=()=>{phase='forgotten';const op=forgotten!;
  return screen('Local record forgotten - nothing was revoked',
   [`${op.kind==='create'?'Grant':'Revocation'} operation ${op.operationId}`,'',
    'Cuna was not contacted, so its side is exactly as it was. Whatever that operation did or did not do still stands, unchanged.',
    op.kind==='create'
     ? 'This CLI can no longer name or replay it. Check the web app if you need to know whether a grant exists.'
     : `Grant ${op.grantId} can still be read: cuna share --project ${identity.project} --grant ${op.grantId}`,
    ...banner()],
   unresolved.length?'p returns to the remaining unresolved changes; b back to sessions.':'b back to sessions.');};
 /**
  * Run a local-state operation and keep its failure local.
  *
  * These never touch the network, so classifying them with the transport
  * classifier reported "Cuna could not be reached for this read", which names
  * the wrong boundary and hides the file the person has to fix.
  */
 const localState=async<T>(what:string,work:()=>Promise<T>):Promise<T>=>{
  try{return await work();}
  catch(error){
   if(error instanceof OwnerGrantError||(error instanceof Error&&error.name==='AbortError'))throw error;
   throw new OwnerGrantError('unavailable',`Cuna was not contacted. This CLI could not ${what}: ${error instanceof Error?error.message:String(error)}`,error);
  }};
 const run=async(label:string,work:()=>Promise<void>)=>{if(busy||stopped)return;busy=true;const previous=phase;phase='working';settled=undefined;await screen(label,['Waiting for Cuna...'],'');
  try{await work();}
  catch(error){if(stopped)return;failure=error instanceof OwnerGrantError?error:classifyTransportFailure(error,false);
   if(failure.effectUnknown||previous==='unresolved'){cursor=0;await paintUnresolved();}else await paintFailure();}
  finally{busy=false;}};
 /**
  * Drop a resolved record.
  *
  * Failing to drop it over-reports, which is the safe direction, and it must
  * never replace the answer that made this call: this runs inside the catch
  * that carries a server refusal.
  */
 const forget=async(operationId:string)=>{
  try{await store.settle(operationId);unresolved=unresolved.filter(op=>op.operationId!==operationId);}
  catch(error){refusal=`Cuna answered this operation, but its local record could not be removed: ${error instanceof Error?error.message:String(error)}. It is still listed as unresolved here.`;}
 };
 /**
  * Send one mutation under an already-durable identity.
  *
  * On success, and on any refusal the server issued WITHOUT acting, the record
  * is dropped. When the effect is undetermined the record stays exactly as it
  * was, which is what makes the next process able to finish this operation.
  */
 const settleWith=async(op:{operationId:string;kind:'create'|'revoke'},call:()=>Promise<OwnerGrant>,after?:()=>Promise<void>)=>{
  try{grant=await call();}
  catch(error){if(!(error instanceof OwnerGrantError)||!error.effectUnknown){settled={operationId:op.operationId,kind:op.kind};await forget(op.operationId);}throw error;}
  await forget(op.operationId);failure=undefined;settled={operationId:op.operationId,kind:op.kind};
  if(after)await after();else{replayed=undefined;refusal=undefined;await paintGrant();}
 };
 const reserve=async(intent:Parameters<OwnerGrantOperationStore['reserve']>[0])=>{
  let reserved;
  try{reserved=await store.reserve(intent);}
  catch(error){throw new OwnerGrantError('unavailable','Cuna could not record this change locally, so nothing was sent. Fix the local state directory and try again.',error);}
  unresolved=[reserved,...unresolved];
  return reserved;
 };
 /**
  * Re-read the durable scope immediately before reserving.
  *
  * `unresolved` is this process's view, loaded at start. A second `cuna share`
  * on the same Project writes to the same scope directory, so the in-memory
  * guard alone lets two processes each start a mutation. This closes all but
  * the window between this read and the reserve below; there is no cross-process
  * lock, so it narrows the race rather than removing it.
  */
 const cleared=async(action:string)=>{
  unresolved=[...await localState('read its record of unresolved changes',()=>store.list(abort.signal))];
  if(!unresolved.length)return true;
  refusal=`Cannot ${action} while an earlier change has an unknown outcome. Resend it, inspect it, or forget its local record first.`;cursor=0;await paintUnresolved();return false;
 };
 const readSessions=async()=>{listing=await sessions.list(abort.signal);items=listing.items.filter(s=>s.projectId===undefined||s.projectId===identity.project);};
 const loadSessions=()=>run('Finding your AgentSessions',async()=>{await readSessions();index=0;failure=undefined;refusal=undefined;await paintSessions();});
 const loadMembers=(after:string|null)=>run('Reading Project members',async()=>{const page=await api.listMembers(after,abort.signal);members=page.items.filter(m=>m.principal_id!==identity.owner);membersAfter=after;membersNext=page.next_after_principal_id;index=0;await paintMembers();});
 const create=(input:CreateInput)=>run('Creating the observation grant',async()=>{if(!await cleared('create a grant'))return;const op=await reserve({kind:'create',operationId:randomUUID(),...input});await settleWith(op,()=>api.create(input,op.operationId,abort.signal));});
 const revoke=(g:OwnerGrant)=>run('Requesting revocation',async()=>{if(!await cleared('revoke'))return;const op=await reserve({kind:'revoke',operationId:randomUUID(),grantId:g.grant_id,agentSessionId:g.agent_session_id,subjectPrincipalId:g.subject_principal_id,expectedRevision:g.revision});await settleWith(op,()=>api.revoke(g,op.operationId,abort.signal));});
 /**
  * Reconcile the receipt a CREATE replay returned.
  *
  * `create_collab_v2_session_observe_grant` answers a replayed operation ID with
  * `return old.result` -- the receipt as it stood when the original request was
  * first answered. Migration 0190 gave the revoke replay a freshly built receipt
  * but left this one a stored snapshot, and it always says `active`, so showing
  * it as the grant's state would report authority that may have been revoked
  * since. Read the current state instead; if that read does not answer, keep
  * the replayed receipt and label it for exactly what it is.
  */
 const reconcileReplay=async(operationId:string)=>{
  const stored=grant!;replayed={operationId};
  try{grant=await api.inspect({grant_id:stored.grant_id,agent_session_id:stored.agent_session_id,subject_principal_id:stored.subject_principal_id,revision:stored.revision},abort.signal);replayed=undefined;refusal=undefined;}
  catch(error){grant=stored;replayed={operationId,reason:(error instanceof OwnerGrantError?error:classifyTransportFailure(error,false,'inspect')).message};}
  await paintGrant();
 };
 /** Replay an operation the durable record already owns. It is never re-reserved and never re-identified. */
 const resend=(op:PendingOwnerGrantOperation)=>run(op.kind==='create'?'Resending the same grant request':'Resending the same revocation',()=>settleWith(op,()=>op.kind==='create'
  ? api.create({agentSessionId:op.agentSessionId,subjectPrincipalId:op.subjectPrincipalId,expectedMembershipRevision:op.expectedMembershipRevision,expiresAtMs:op.expiresAtMs},op.operationId,abort.signal)
  : api.revoke({grant_id:op.grantId,agent_session_id:op.agentSessionId,subject_principal_id:op.subjectPrincipalId,revision:op.expectedRevision},op.operationId,abort.signal),
  op.kind==='create'?()=>reconcileReplay(op.operationId):undefined));
 const inspect=(reference:{grant_id:string},settling?:string)=>run('Inspecting the grant',async()=>{
  grant=await api.inspect(grant?.grant_id===reference.grant_id?grant:reference,abort.signal);
  // A trustworthy receipt answers the question the record existed to ask,
  // whichever way it went: the revocation either applied or never did.
  if(settling!==undefined)await forget(settling);
  failure=undefined;refusal=undefined;replayed=undefined;await paintGrant();
 });
 /** One unresolved operation blocks every NEW authority change, so it can never be silently replaced. */
 const blocked=(action:string)=>{if(!unresolved.length)return false;refusal=`Cannot ${action} while an earlier change has an unknown outcome. Resend it, inspect it, or forget its local record first.`;cursor=0;void paintUnresolved();return true;};
 const toUnresolved=(key:string)=>{if(key!=='p'||!unresolved.length)return false;refusal=undefined;cursor=0;void paintUnresolved();return true;};
 const remove=host.onInput(bytes=>{if(stopped)return;const key=new TextDecoder().decode(bytes);if(key==='\x03'||key==='\x1b'){stop();return;}if(busy)return;
  const up=()=>{index=Math.max(0,index-1);},down=(n:number)=>{index=Math.min(Math.max(0,n-1),index+1);};
  if(phase==='sessions'){if(key==='\x1b[A'){up();void paintSessions();}else if(key==='\x1b[B'){down(items.length);void paintSessions();}else if(key==='\r'&&items[index]){session=items[index];void loadMembers(null);}else if(key==='r')void loadSessions();else toUnresolved(key);}
  else if(phase==='members'){if(key==='\x1b[A'){up();void paintMembers();}else if(key==='\x1b[B'){down(members.length);void paintMembers();}else if(key==='\r'&&members[index]){member=members[index];void paintDuration();}else if(key==='n'&&membersNext)void loadMembers(membersNext);else if(key==='r')void loadMembers(membersAfter);else if(key==='b')void paintSessions();else toUnresolved(key);}
  else if(phase==='duration'){const choice=DURATIONS.find(([k])=>k===key);
   if(choice){if(blocked('create a grant'))return;void create({agentSessionId:session!.id,subjectPrincipalId:member!.principal_id,expectedMembershipRevision:member!.membership_revision,expiresAtMs:now()+choice[2]});}
   else if(key==='b')void paintMembers();else toUnresolved(key);}
  else if(phase==='grant'){if(key==='i'&&grant)void inspect(grant);
   // A stored replay is not a reading of current authority, so it may not be
   // the revision a revocation is aimed at. `i` first.
   else if(key==='x'&&grant&&!replayed&&grant.state==='active'&&!describeGrantState(grant,now()).final){if(blocked('revoke'))return;void revoke(grant);}
   else if(key==='b'){grant=undefined;failure=undefined;replayed=undefined;void loadSessions();}
   else toUnresolved(key);}
  else if(phase==='failure'){
   if(key==='r'&&failure&&rereadsMembers(failure))void loadMembers(null);
   else if(key==='i'&&grant)void inspect(grant);
   else if(key==='b'){failure=undefined;grant=undefined;replayed=undefined;void loadSessions();}
   else toUnresolved(key);}
  else if(phase==='unresolved'){const row=unresolved[cursor];
   if(key==='\x1b[A'){cursor=Math.max(0,cursor-1);void paintUnresolved();}
   else if(key==='\x1b[B'){cursor=Math.min(Math.max(0,unresolved.length-1),cursor+1);void paintUnresolved();}
   else if(key==='r'&&row){refusal=undefined;void resend(row);}
   else if(key==='i'&&row?.kind==='revoke'){refusal=undefined;void inspect({grant_id:row.grantId},row.operationId);}
   else if(key==='d'&&row){forgetTarget=row;void paintConfirmForget();}
   else if(key==='b'){refusal=undefined;void (items.length?paintSessions():loadSessions());}}
  else if(phase==='confirm-forget'){const op=forgetTarget!;
   if(key==='y')void run('Forgetting the local record',async()=>{await forget(op.operationId);forgetTarget=undefined;refusal=undefined;failure=undefined;
    if(unresolved.some(o=>o.operationId===op.operationId))await paintUnresolved();else{forgotten=op;await paintForgotten();}});
   else{forgetTarget=undefined;void paintUnresolved();}}
  else if(phase==='forgotten'){if(key==='b'){forgotten=undefined;void (items.length?paintSessions():loadSessions());}else toUnresolved(key);}
 });
 options.signal?.addEventListener('abort',stop,{once:true});
 try{
  if(options.signal?.aborted)stop();
  else await run('Reading local state',async()=>{
   // Recover operation identity from an earlier process before anything else.
   unresolved=[...await localState('read its record of unresolved changes',()=>store.list(abort.signal))];
   await readSessions();
   if(unresolved.length){cursor=0;await paintUnresolved();}
   else if(options.initialGrantId){grant=await api.inspect({grant_id:options.initialGrantId},abort.signal);await paintGrant();}
   else await paintSessions();
  });
  await done;
 }
 finally{stop();remove();options.signal?.removeEventListener('abort',stop);await hostWrites;await lease.restore();}
}
