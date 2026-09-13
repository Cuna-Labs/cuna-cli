import {randomUUID} from 'node:crypto';
import {createNodeForegroundTerminalHost} from '../pty/node-host-terminal.js';
import type {ForegroundTerminalHost} from '../terminal/foreground.js';
import {sanitizeHumanTerminalOutput} from '../cli/output.js';
import {describeGrantState,OwnerGrantError,classifyTransportFailure,audienceRefusalCanResend,type ownerObserveGrantsApi,type OwnerGrant,type ProjectObserver,type SessionAudience,type SessionAudienceAction} from '../api/owner-observe-grants-v2.js';
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
type Phase='sessions'|'members'|'duration'|'working'|'grant'|'failure'|'unresolved'|'confirm-forget'|'forgotten'|'confirm-share'|'confirm-stop'|'shared';
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
 * latest audience result is `public`, so a grant and a live publication are
 * separate facts and stay separate keypresses here. Which stream and generation
 * a member joins is decided at attach time, which is why the lines below promise
 * a boundary rather than a moment; the moment is named on the receipt the
 * publication itself returns.
 */
const DISCLOSURE=[
 'What the member will see:',
 "  Only what happens from the moment they start watching - a live view of this session's screen.",
 '  Nothing from before that: earlier output and scrollback are never sent to them.',
 '  Whatever is still on the screen when they start watching is visible to them, even if it is from earlier.',
 '  Watching also requires this session to be shared live. That is a separate decision: press s on the session list.',
 '  They can never type, resize or send a signal.',
];
/**
 * What starting a live share actually exposes, stated before the key that does it.
 *
 * Every line is a property of the shipped producer.
 * `terminal-public-audience.py`'s `PublicAudience.publish` resets to a blank
 * public view and answers `starting_sequence: 0`, after which each poll encodes
 * `snapshot()` -- a full redraw of the CURRENTLY VISIBLE screen -- so no
 * scrollback and no earlier output is replayed, while whatever is still on the
 * screen is transmitted whole. CUNA-COL-016 is explicit that screen inspection
 * cannot detect an authentication prompt and that bytes already delivered cannot
 * be recalled; both are said here rather than implied.
 */
const SHARE_DISCLOSURE=[
 '  Everyone you have granted observation of this session can watch it from the moment this starts.',
 '  They see whatever is on the screen now, and everything printed from now on.',
 '  Nothing from before is replayed to them: no scrollback, no earlier output.',
 '  Anything a program prints while this is on is part of that - a token, a login code, a file it opens.',
 '  Cuna cannot detect that and will not hide it. Stopping later ends what comes next; it cannot recall what was already sent.',
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
 // Operations whose exact request Cuna has already answered, so resending it
 // again cannot settle anything. In memory only: a new process has not seen that
 // refusal and must not pretend it has.
 const unresendable=new Set<string>();
 // The operation a settled answer just closed. It is kept for the OUTCOME
 // screen only: once the record is gone this string is the last thing that can
 // tie what the owner is reading to what they asked Cuna to do.
 let settled:{operationId:string;kind:PendingOwnerGrantOperation['kind'];action?:SessionAudienceAction}|undefined;
 // The last sharing decision Cuna confirmed IN THIS PROCESS, and the session a
 // pending sharing decision is about. Neither is a reading of how the session is
 // shared now: the canonical contract has no way to ask that question, only to
 // change the answer. Nothing here is ever rendered as current state.
 let audience:SessionAudience|undefined,audienceTarget:{id:string;label:string;incarnation?:string}|undefined,audienceFrom:'sessions'|'grant'|'shared'='sessions';
 // Which surface the failure on screen came from, so a recovery offered for a
 // grant refusal is not offered for a sharing refusal that reads alike.
 let failureSubject:'grant'|'audience'='grant';
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
 /** What one operation was, in the words the owner chose it with. */
 const noun=(op:{kind:PendingOwnerGrantOperation['kind'];action?:SessionAudienceAction})=>op.kind==='create'?'grant':op.kind==='revoke'?'revocation':op.action==='publish'?'start of live sharing':'stop of live sharing';
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
 const paintSessions=()=>{phase='sessions';return screen('Share a session - read-only observation',[...(items.length?items.map(sessionLine):['No AgentSessions in this Project were found on your Machines.']),...limits(),
  ...(items.length?['','Granting a member access and sharing the session live are two separate decisions. Cuna needs both before anyone can watch.']:[]),...banner()],
  items.length?'Enter grants a member access; s starts sharing this session live; e stops it; Up/Down selects; r refreshes.':'r refreshes.');};
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
    // A grant on its own shows nobody anything, and this is the screen where
    // that is asked. Neither key claims to know how the session is shared now.
    '','Watching also needs this session to be shared live, which is a separate decision from this grant.',
    ...banner()],
   `${stored?'i reads the current state':d.final?'i inspects again':g.state==='active'?'x revokes; i inspects the current state':'i inspects again (no scheduled polling)'}; s starts sharing this session live; e stops it; b back to sessions.`);};
 /**
  * The two sharing decisions, each asked before it is made.
  *
  * Publication is the authority that lets a granted member see anything, so it
  * is never a side effect of granting: the owner reaches these screens by
  * pressing s or e and confirms with y.
  */
 const paintConfirmShare=()=>{phase='confirm-share';const target=audienceTarget!;
  return screen("Share this session's screen live?",[`Session   ${target.label}`,'',...SHARE_DISCLOSURE,'',
   'It gives nobody keyboard control, and it creates no grant: a member still needs one, and Cuna still applies its own checks before letting anyone watch.'],
   'Press y to start sharing; any other key cancels and sends nothing.');};
 const paintConfirmStop=()=>{phase='confirm-stop';const target=audienceTarget!;
  return screen('Stop sharing this session live?',[`Session   ${target.label}`,'',
   '  Anyone watching stops receiving this session the moment Cuna confirms it.',
   '  What they have already seen cannot be recalled.',
   '  Observation grants are left exactly as they are: this revokes nothing and expires nothing.',
   '  If the session is already private, this changes nothing.'],
   'Press y to stop sharing; any other key cancels and sends nothing.');};
 /**
  * The receipt screen for a confirmed sharing decision.
  *
  * CUNA-COL-016-R4 asks for the starting point of what a watcher receives. The
  * publication receipt is the only place it exists: the producer answers with a
  * generation exactly one past the one it was issued against and
  * `first_sequence: '1'`, meaning a new public stream whose first frame is a
  * redraw of the screen as it is now. It is rendered as a plain share number and
  * a plain sentence; the stream and request identifiers stay off the terminal
  * because no decision here depends on them.
  */
 const paintAudience=()=>{phase='shared';const a=audience!,target=audienceTarget;
  // An answer that a later confirmed decision has already replaced never reaches
  // this screen: `setAudience` refuses it at the adapter, so there is no path by
  // which a superseded receipt can be painted as the session's state.
  return screen(a.state==='public'?'Live sharing started - Cuna confirmed it':'Live sharing stopped - Cuna confirmed it',
   [`Session   ${target?.label??a.agentSessionId}`,
    ...(a.state==='public'
     ? [`Share     #${a.generation} of this run of the session`,'',
        'Watching starts here: the first thing anyone sees is the screen as it is now. Nothing printed before this moment is sent to them.',
        'Everyone who holds an active observation grant on this session can watch it, if Cuna\'s own checks also allow it. Sharing grants no keyboard, resize or signal.']
     : ['',
        'Cuna confirmed with the session itself that its output is fenced: nothing more is sent to anyone who was watching.',
        'What was already sent cannot be recalled. Observation grants are untouched - stopping the live share revokes nothing.']),
    ...banner()],
   a.state==='public'?'e stops sharing; b back to sessions.':'s starts sharing again; b back to sessions.');};
 /** True when rereading the Project members is the actual recovery for this refusal. */
 const rereadsMembers=(f:OwnerGrantError)=>failureSubject==='grant'&&!grant&&session!==undefined&&(f.kind==='stale_revision'||f.kind==='grant_unavailable');
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
     `Operation ${settled.operationId} (${noun(settled)}) is settled: Cuna answered it, so its local record was dropped.`]),
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
  const lines=unresolved.map((op,i)=>`${cursor===i?'>':' '} ${op.kind==='create'?'grant  ':op.kind==='revoke'?'revoke ':op.action==='publish'?'share  ':'unshare'}  operation ${op.operationId}`);
  lines.push('',row.kind==='create'
   ? `Grant for member ${row.subjectPrincipalId} on session ${row.agentSessionId}, membership revision ${row.expectedMembershipRevision}, expiring ${new Date(row.expiresAtMs).toISOString()}.`
   : row.kind==='revoke'
    ? `Revocation of grant ${row.grantId} (member ${row.subjectPrincipalId}, session ${row.agentSessionId}) against revision ${row.expectedRevision}.`
    : `${row.action==='publish'?'Start':'Stop'} of live sharing on session ${row.agentSessionId}.`);
  // Cuna has closed the door on resending this exact request: the stored request
  // has expired, or Cuna has already recorded an answer for it. Offering `r`
  // would be offering an action that cannot settle anything -- and the standing
  // description must stop promising it, or the screen contradicts itself one
  // line later.
  const resendable=!unresendable.has(row.operationId);
  lines.push('',row.kind==='create'
   ? "Cuna never confirmed this. The grant may or may not exist, and this CLI cannot tell: the collaboration contract has no owner-side listing of a session's grants. Resending reuses this exact operation ID, so it cannot create a second grant. The web app is the other way to find out."
   : row.kind==='revoke'
    ? 'Cuna never confirmed this. Inspecting the grant answers it directly, because the grant ID is known. Resending reuses this exact operation ID and the same expected revision.'
    // Resending is not one option among several here: the session refuses a
    // fresh request issued against a sharing state it has already moved past,
    // so this exact identity is the only thing that can ever settle this -- for
    // as long as Cuna will still raise it.
    : `Cuna never confirmed this. The session may or may not be ${row.action==='publish'?'shared live':'private'} now, and Cuna offers no way to ask - it can only be changed.${resendable?' Resending reuses this exact operation ID, which asks the session about the same request instead of starting a second one, and it is the only thing that can settle this.':' Cuna will not raise this request with the session again, so nothing here can settle it now.'}${row.action==='publish'?' If what you need is for nobody to be watching, press e: stopping never depends on this answer.':''}`);
  if(!resendable)lines.push('','What that operation did stays unknown, and it will stay unknown. Forgetting the record is the only thing left that changes anything here, and it changes nothing at Cuna.');
  if(failure)lines.push('',`Last reason: ${failure.message}`);
  if(refusal)lines.push('',refusal);
  return screen(`Unresolved change${unresolved.length===1?'':'s'} - outcome unknown`,lines,`Up/Down selects; ${resendable?'r resends this exact operation; ':''}${row.kind==='revoke'?'i inspects the grant; ':row.kind==='audience'&&row.action==='publish'?'e stops live sharing now; ':''}d forgets the local record only; b back to sessions.`);
 };
 /**
  * Deleting the record is irreversible and revokes nothing, so it is asked
  * before it is done and named after it is done.
  */
 const paintConfirmForget=()=>{phase='confirm-forget';const op=forgetTarget!;
  return screen('Forget this local record?',
   [`${op.kind==='create'?'Grant':op.kind==='revoke'?'Revocation':op.action==='publish'?'Start of live sharing':'Stop of live sharing'} operation ${op.operationId}`,'',
    'This deletes the local record only. Cuna is not contacted and nothing is revoked.',
    // Reaching Cuna is not the same as taking effect, and the outcome here is
    // unknown by definition. Every branch stays conditional on the effect, not
    // on delivery, and none states that an authority exists.
    op.kind==='create'
     ? "The outcome stays unknown. If that request did take effect, a grant exists and the member may be able to observe this session - and after this, no screen in this CLI can name or replay that operation, because the collaboration contract has no owner-side listing of a session's grants. The web app becomes the only way to find out."
     : op.kind==='revoke'
      ? `The outcome stays unknown. If that request did take effect, the revocation applied. Grant ${op.grantId} stays readable by ID either way, so its state is still reachable; the operation identity is not.`
      : op.action==='publish'
       ? 'The outcome stays unknown. If that request did take effect, this session is shared live and anyone holding a grant on it may be watching - and after this, nothing in this CLI can replay that operation. Stopping the sharing does not need it and is the only way to be sure nobody is watching.'
       : 'The outcome stays unknown. If that request did take effect, the session is private. Asking Cuna to stop sharing again is a separate decision that does not need this record.',
    '','This cannot be undone.'],
   'Press y to forget it; any other key keeps it.');};
 const paintForgotten=()=>{phase='forgotten';const op=forgotten!;
  return screen('Local record forgotten - nothing was revoked',
   [`${op.kind==='create'?'Grant':op.kind==='revoke'?'Revocation':op.action==='publish'?'Start of live sharing':'Stop of live sharing'} operation ${op.operationId}`,'',
    'Cuna was not contacted, so its side is exactly as it was. Whatever that operation did or did not do still stands, unchanged.',
    op.kind==='create'
     ? 'This CLI can no longer name or replay it. Check the web app if you need to know whether a grant exists.'
     : op.kind==='revoke'
      ? `Grant ${op.grantId} can still be read: cuna share --project ${identity.project} --grant ${op.grantId}`
      : 'This CLI can no longer replay it. Stopping live sharing is still available and does not depend on it.',
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
 const settleWith=async<T>(op:{operationId:string;kind:PendingOwnerGrantOperation['kind'];action?:SessionAudienceAction},call:()=>Promise<T>,accept:(value:T)=>Promise<void>)=>{
  const identity={operationId:op.operationId,kind:op.kind,...(op.action===undefined?{}:{action:op.action})};
  let value:T;
  try{value=await call();}
  catch(error){if(!(error instanceof OwnerGrantError)||!error.effectUnknown){settled=identity;await forget(op.operationId);}throw error;}
  await forget(op.operationId);failure=undefined;settled=identity;
  await accept(value);
 };
 const acceptGrant=async(value:OwnerGrant)=>{grant=value;replayed=undefined;refusal=undefined;await paintGrant();};
 const acceptAudience=async(value:SessionAudience)=>{audience=value;refusal=undefined;await paintAudience();};
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
 const loadSessions=()=>run('Finding your AgentSessions',async()=>{failureSubject='grant';await readSessions();index=0;failure=undefined;refusal=undefined;await paintSessions();});
 const loadMembers=(after:string|null)=>run('Reading Project members',async()=>{failureSubject='grant';const page=await api.listMembers(after,abort.signal);members=page.items.filter(m=>m.principal_id!==identity.owner);membersAfter=after;membersNext=page.next_after_principal_id;index=0;await paintMembers();});
 const create=(input:CreateInput)=>run('Creating the observation grant',async()=>{failureSubject='grant';if(!await cleared('create a grant'))return;const op=await reserve({kind:'create',operationId:randomUUID(),...input});await settleWith(op,()=>api.create(input,op.operationId,abort.signal),acceptGrant);});
 const revoke=(g:OwnerGrant)=>run('Requesting revocation',async()=>{failureSubject='grant';if(!await cleared('revoke'))return;const op=await reserve({kind:'revoke',operationId:randomUUID(),grantId:g.grant_id,agentSessionId:g.agent_session_id,subjectPrincipalId:g.subject_principal_id,expectedRevision:g.revision});await settleWith(op,()=>api.revoke(g,op.operationId,abort.signal),acceptGrant);});
 /** The session one sharing decision is about, named the way the owner saw it if this process has seen it listed. */
 const audienceTargetFor=(agentSessionId:string,incarnation?:string):{id:string;label:string;incarnation?:string}=>{
  const known=items.find(s=>s.id===agentSessionId);
  return{id:agentSessionId,label:known?`${known.machineName} / ${known.name}`:agentSessionId,...(incarnation===undefined?{}:{incarnation})};
 };
 /**
  * Start or stop live sharing of one session.
  *
  * Stopping is deliberately NOT gated on an unresolved change. Every other
  * mutation here is blocked while one exists, because starting a second could
  * create a second authority. This one only ever removes access, and an owner
  * who cannot tell whether a session is live is exactly the owner who most needs
  * to be able to make it private. It still takes its own operation identity and
  * never touches, replaces or replays the unresolved record.
  */
 const changeAudience=(action:SessionAudienceAction,target:{id:string;label:string;incarnation?:string})=>run(action==='publish'?'Starting live sharing':'Stopping live sharing',async()=>{
  failureSubject='audience';audienceTarget=target;
  if(action==='publish'){if(!await cleared('start live sharing'))return;}
  else unresolved=[...await localState('read its record of unresolved changes',()=>store.list(abort.signal))];
  const op=await reserve({kind:'audience',operationId:randomUUID(),action,agentSessionId:target.id});
  await settleWith(op,()=>api.setAudience({agentSessionId:target.id,action,...(target.incarnation===undefined?{}:{sessionIncarnation:target.incarnation})},op.operationId,abort.signal),acceptAudience);
 });
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
 const resend=(op:PendingOwnerGrantOperation)=>run(op.kind==='create'?'Resending the same grant request':op.kind==='revoke'?'Resending the same revocation':op.action==='publish'?'Resending the same request to share':'Resending the same request to stop sharing',async()=>{
  failureSubject=op.kind==='audience'?'audience':'grant';
  if(op.kind==='audience'){
   audienceTarget=audienceTargetFor(op.agentSessionId);
   try{await settleWith(op,()=>api.setAudience({agentSessionId:op.agentSessionId,action:op.action,replay:true},op.operationId,abort.signal),acceptAudience);}
   catch(error){
    // Record the one thing this refusal does establish: whether this request can
    // still be sent at all. The outcome of the operation stays unknown.
    if(error instanceof OwnerGrantError&&!audienceRefusalCanResend(error.details?.reason))unresendable.add(op.operationId);
    throw error;
   }
   return;
  }
  if(op.kind==='create'){
   await settleWith(op,()=>api.create({agentSessionId:op.agentSessionId,subjectPrincipalId:op.subjectPrincipalId,expectedMembershipRevision:op.expectedMembershipRevision,expiresAtMs:op.expiresAtMs},op.operationId,abort.signal),async value=>{grant=value;await reconcileReplay(op.operationId);});
   return;
  }
  await settleWith(op,()=>api.revoke({grant_id:op.grantId,agent_session_id:op.agentSessionId,subject_principal_id:op.subjectPrincipalId,revision:op.expectedRevision},op.operationId,abort.signal),acceptGrant);
 });
 const inspect=(reference:{grant_id:string},settling?:string)=>run('Inspecting the grant',async()=>{
  failureSubject='grant';
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
  if(phase==='sessions'){if(key==='\x1b[A'){up();void paintSessions();}else if(key==='\x1b[B'){down(items.length);void paintSessions();}else if(key==='\r'&&items[index]){session=items[index];void loadMembers(null);}
   // Publication is asked for on the session the cursor names, and confirmed
   // before anything is sent.
   else if(key==='s'&&items[index]){if(blocked('start live sharing'))return;audienceFrom='sessions';audienceTarget=audienceTargetFor(items[index]!.id);void paintConfirmShare();}
   else if(key==='e'&&items[index]){audienceFrom='sessions';audienceTarget=audienceTargetFor(items[index]!.id);void paintConfirmStop();}
   else if(key==='r')void loadSessions();else toUnresolved(key);}
  else if(phase==='members'){if(key==='\x1b[A'){up();void paintMembers();}else if(key==='\x1b[B'){down(members.length);void paintMembers();}else if(key==='\r'&&members[index]){member=members[index];void paintDuration();}else if(key==='n'&&membersNext)void loadMembers(membersNext);else if(key==='r')void loadMembers(membersAfter);else if(key==='b')void paintSessions();else toUnresolved(key);}
  else if(phase==='duration'){const choice=DURATIONS.find(([k])=>k===key);
   if(choice){if(blocked('create a grant'))return;void create({agentSessionId:session!.id,subjectPrincipalId:member!.principal_id,expectedMembershipRevision:member!.membership_revision,expiresAtMs:now()+choice[2]});}
   else if(key==='b')void paintMembers();else toUnresolved(key);}
  else if(phase==='grant'){if(key==='i'&&grant)void inspect(grant);
   // A stored replay is not a reading of current authority, so it may not be
   // the revision a revocation is aimed at. `i` first.
   else if(key==='x'&&grant&&!replayed&&grant.state==='active'&&!describeGrantState(grant,now()).final){if(blocked('revoke'))return;void revoke(grant);}
   // The grant names its session and the exact run of it, so a sharing receipt
   // about a different run can be refused rather than believed.
   else if(key==='s'&&grant){if(blocked('start live sharing'))return;audienceFrom='grant';audienceTarget=audienceTargetFor(grant.agent_session_id,grant.session_incarnation);void paintConfirmShare();}
   else if(key==='e'&&grant){audienceFrom='grant';audienceTarget=audienceTargetFor(grant.agent_session_id,grant.session_incarnation);void paintConfirmStop();}
   else if(key==='b'){grant=undefined;failure=undefined;replayed=undefined;void loadSessions();}
   else toUnresolved(key);}
  else if(phase==='confirm-share'||phase==='confirm-stop'){const action:SessionAudienceAction=phase==='confirm-share'?'publish':'private',target=audienceTarget!;
   if(key==='y')void changeAudience(action,target);
   // Cancelling returns to the screen the decision was reached from, so the
   // receipt a person was reading is not lost by declining the next step.
   else if(audienceFrom==='shared'&&audience)void paintAudience();
   else{audienceTarget=undefined;void (audienceFrom==='grant'&&grant?paintGrant():items.length?paintSessions():loadSessions());}}
  else if(phase==='shared'){
   if(key==='s'&&audienceTarget){if(blocked('start live sharing'))return;audienceFrom='shared';void paintConfirmShare();}
   else if(key==='e'&&audienceTarget){audienceFrom='shared';void paintConfirmStop();}
   else if(key==='b'){audience=undefined;audienceTarget=undefined;void (items.length?paintSessions():loadSessions());}
   else toUnresolved(key);}
  else if(phase==='failure'){
   if(key==='r'&&failure&&rereadsMembers(failure))void loadMembers(null);
   else if(key==='i'&&grant)void inspect(grant);
   else if(key==='b'){failure=undefined;grant=undefined;replayed=undefined;void loadSessions();}
   else toUnresolved(key);}
  else if(phase==='unresolved'){const row=unresolved[cursor];
   if(key==='\x1b[A'){cursor=Math.max(0,cursor-1);void paintUnresolved();}
   else if(key==='\x1b[B'){cursor=Math.min(Math.max(0,unresolved.length-1),cursor+1);void paintUnresolved();}
   else if(key==='r'&&row&&!unresendable.has(row.operationId)){refusal=undefined;void resend(row);}
   else if(key==='i'&&row?.kind==='revoke'){refusal=undefined;void inspect({grant_id:row.grantId},row.operationId);}
   // The safe direction out of an unconfirmed publication, reachable without
   // first settling it: it removes access and starts its own operation.
   else if(key==='e'&&row?.kind==='audience'&&row.action==='publish'){refusal=undefined;audienceFrom='sessions';audienceTarget=audienceTargetFor(row.agentSessionId);void paintConfirmStop();}
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
