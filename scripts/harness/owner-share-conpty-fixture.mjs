import {appendFile,mkdir} from 'node:fs/promises';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import {createPlatformAdapter} from '../../dist/platform/adapter.js';
import {runCli} from '../../dist/index.js';
import {runProcessCli} from '../../dist/cli/process-entrypoint.js';

// LOCAL FIXTURE BACKEND. This process runs the real installed-candidate `cuna
// share` code path (parser, preflight, human-login transport, owner adapter,
// screen) against an in-process fake of the collaboration API. It proves the
// CLI's behaviour against the vendored contract; it proves NOTHING about the
// deployed Edge. No network socket is opened: `fetch` is replaced.
const [ledger,configFile,mode='happy']=process.argv.slice(2);
if(!ledger||!configFile)throw new Error('fixture requires an owned ledger path and a config file');
const id=n=>`ba600000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const PROJECT='20178adc-8ae4-515a-bb38-bd25042707db',OWNER=id(1),MEMBER=id(2),MACHINE=id(3),SESSION=id(5),GRANT=id(3);
const record=(event,details={})=>appendFile(ledger,JSON.stringify({timestamp:new Date().toISOString(),pid:process.pid,event,...details})+'\n');
let grant,revokeAttempts=0,inspects=0;
const receipt=()=>({version:'2',kind:'session_observe_grant',grant_id:GRANT,revision:grant.revision,owner_principal_id:OWNER,subject_principal_id:MEMBER,agent_session_id:SESSION,session_incarnation:id(6),project_id:PROJECT,authority_epoch:1,membership_revision:4,state:grant.state,expires_at:grant.expires_at,revocation_state:grant.revocation_state});
const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const problem=(status,code,title,retryable=false)=>json(status,{type:'about:blank',title,status,code,request_id:id(99),retryable,detail:title});
// Publication state, modelled on what the producer actually does at infra
// 2d61dd1. `issue_collab_v2_session_audience_request` is keyed on operation_id
// and returns the SAME stored request -- INCLUDING its original deadline -- for a
// replay, and the supervisor's `_run_audience_v2` journals its answer per
// request_id. A publish moves the generation forward by exactly one and mints a
// fresh stream; a return to private stays on it.
//
// Two fidelity repairs after the acceptance review, both of which had made the
// CLI look better than the producer allows:
//  - the stored DEADLINE is modelled. `coordinateSessionAudienceV2` returns
//    `uncertain/request_expired` when `deadline_ms<=now()` BEFORE calling the
//    registry, so a replay outside the window never reaches the journal at all.
//    Re-serving a stored receipt regardless of elapsed time advertised a
//    recovery the producer does not offer.
//  - the journal hit RE-VALIDATES live state, as `_run_audience_v2` does
//    (`str(audience.generation) != value["generation"]`, and for a public result
//    `not audience.active or audience.stream_id != value["stream_id"]`). Without
//    it a retired public receipt could be served, which is the one thing this
//    harness most needs to be able to catch.
// The journal is a FILE, not process memory, because the recovery case is a
// second CLI process talking to a producer that has not forgotten anything.
const AUDIENCE_WINDOW_MS=20000;
const journalPath=path.join(path.dirname(ledger),'audience-journal.json');
const readJournal=()=>{try{return JSON.parse(readFileSync(journalPath,'utf8'));}catch{return{generation:0,active:false,streamId:null,operations:{}};}};
let audienceLost=false;
const audienceBody=(action,generation,patch={})=>({state:'observed',response:{type:'session_audience_response_v2',version:'2',request_id:randomUUID(),action,
 agent_session_id:SESSION,session_incarnation:id(6),process_epoch:id(7),runtime_lease_id:id(72),logical_terminal_id:id(13),process_start_identity:'4242',expected_generation:String(generation),
 result:action==='publish'
  ? {status:'observed',state:'public',stream_id:id(80+generation),generation:String(generation+1),first_sequence:'1'}
  : {status:'observed',state:'private',generation:String(generation)},
 ...patch}});
async function fakeFetch(url,init){
 const u=new URL(url),method=init?.method??'GET',body=init?.body?JSON.parse(typeof init.body==='string'?init.body:new TextDecoder().decode(init.body)):undefined;
 await record('request',{method,path:u.pathname,...(body?{body:{...body}}:{})});
 if(!(init?.headers?.Authorization??'').startsWith('Bearer cuna_at_'))return json(401,{error:'unauthenticated'});
 if(method==='GET'&&u.pathname==='/v1/me')return json(200,{id:OWNER,email:'owner@example.test',workspace:{assigned:false,waitlist_position:1}});
 if(method==='GET'&&u.pathname==='/v1/sessions')return json(200,[{id:MACHINE,name:'conpty-owner-box',agent:'claude-code',status:'running',memory_mib:2048,vcpus:1,url:'https://machine.invalid'}]);
 if(method==='GET'&&u.pathname===`/v1/sessions/${MACHINE}/agent-sessions`){const now=Date.now();return json(200,{items:[{id:SESSION,machine_id:MACHINE,project_id:PROJECT,name:'claude-live',agent:'claude-code',cwd:'/workspace/conpty',auth_mode:'interactive_login',desired_state:'running',request_state:'launched',process_state:'running',process_epoch:id(7),runtime_observed_at:new Date(now-100).toISOString(),runtime_expires_at:new Date(now+60000).toISOString(),row_version:1,created_at:new Date(now-1000).toISOString(),updated_at:new Date(now-100).toISOString()},{id:id(11),machine_id:MACHINE,project_id:id(12),name:'other-project-session',agent:'codex',cwd:'/workspace/other',auth_mode:'interactive_login',desired_state:'running',request_state:'launched',process_state:'running',row_version:1,created_at:new Date(now-1000).toISOString(),updated_at:new Date(now-100).toISOString()}]});}
 if(method==='POST'&&u.pathname===`/v1/collaboration/2/projects/${PROJECT}/observers`)return json(200,{version:'2',kind:'project_observers',project_id:PROJECT,authority_epoch:1,items:[{principal_id:OWNER,membership_revision:1,recipient_email:'owner@example.test'},{principal_id:MEMBER,membership_revision:4,recipient_email:'member-b@example.test'}],next_after_principal_id:null});
 if(method==='POST'&&u.pathname===`/v1/collaboration/2/agent-sessions/${SESSION}/observe-grants`){
  // The producer at infra 2d61dd1 answers a stale membership revision from
  // `create_collab_v2_session_observe_grant` with `collab_v2_observe_unavailable`,
  // which edge/src/session-observe-grant-v2.ts maps to `grant_unavailable` and
  // edge/src/api.ts:2247 renders as 404. It has no path that emits 409 for that
  // cause: 409 is `operation_conflict` only. Modelling this as 409 -- which this
  // fixture did until 2026-09-13 -- made a passing check out of a fiction.
  if(mode==='stale')return problem(404,'grant_unavailable','No such grant, session, membership or authority');
  // A replay the server SETTLES. The first attempt never committed, the
  // membership revision moved, and the replay is refused outright. The durable
  // record is correctly destroyed here, so the rendered reason is the only
  // remaining explanation the owner can ever get.
  if(mode==='replay-settled')return problem(404,'grant_unavailable','No such grant, session, membership or authority');
  if(mode==='replay-conflict')return problem(409,'operation_conflict','Operation identity conflict');
  // The answer is lost after the service acted. This process never tells the
  // CLI what happened; only the durable record carries the identity forward.
  if(mode==='lost-create'||mode==='lost-create-settled'){await record('create-answer-lost',{operation_id:body.operation_id});throw new TypeError('fetch failed');}
  if(body.subject_principal_id!==MEMBER||body.expected_membership_revision!==4)return problem(409,'membership_revision_stale','Membership revision changed');
  grant={revision:1,state:'active',revocation_state:null,expires_at:body.expires_at_ms,operation_id:body.operation_id};return json(200,receipt());
 }
 if(method==='POST'&&u.pathname===`/v1/collaboration/2/observe-grants/${GRANT}/inspect`){if(!grant)return problem(404,'grant_not_found','Unknown grant');inspects++;if(grant.state==='revoking'&&inspects>=2){grant={...grant,revision:grant.revision+1,state:'revoked',revocation_state:'effective'};}return json(200,receipt());}
 if(method==='POST'&&u.pathname===`/v1/collaboration/2/observe-grants/${GRANT}/revoke`){
  if(!grant)return problem(404,'grant_not_found','Unknown grant');
  revokeAttempts++;
  // FIXTURE ASSUMPTION, not a deployed witness: a replay carrying the SAME
  // operation_id answers with the committed receipt (operation identity is
  // durable), while a different operation_id against a moved revision is stale.
  if(grant.revoke_operation_id===body.operation_id)return json(200,receipt());
  if(body.expected_revision!==grant.revision)return problem(409,'grant_revision_stale','Grant revision changed');
  grant={...grant,revision:2,state:'revoking',revocation_state:'effective_pending',revoke_operation_id:body.operation_id};
  if(mode==='lost-revoke'&&revokeAttempts===1){await record('revoke-applied-but-response-lost',{operation_id:body.operation_id});throw new TypeError('fetch failed');}
  return json(200,receipt());
 }
 if(method==='POST'&&u.pathname===`/v1/collaboration/2/agent-sessions/${SESSION}/audience`){
  // A receipt about a DIFFERENT session. The CLI must refuse it rather than
  // report that this session is now shared.
  const journal=readJournal();
  if(mode==='share-wrong-session')return json(200,audienceBody(body.action,journal.generation,{agent_session_id:id(11)}));
  if(mode==='share-refused')return problem(503,'audience_runtime_unavailable','Session audience unavailable',true);
  const prior=journal.operations[body.operation_id];
  if(prior){
   // `issue_…` returns the stored request with its ORIGINAL deadline, and the
   // coordinator gives up before the session is reached once it has passed.
   if(Date.now()>=prior.deadlineMs){
    await record('audience-replay-outside-window',{operation_id:body.operation_id,deadline_ms:prior.deadlineMs});
    return problem(503,'audience_request_expired','Session audience unconfirmed',true);
   }
   // The same operation identity used for a different action is a SQL exception
   // in `issue_…`, and the coordinator maps every rpc error to
   // `request_unavailable`. This route cannot answer 409; modelling it as one
   // invented a producer behaviour, which the acceptance review caught.
   if(prior.action!==body.action)return problem(503,'audience_request_unavailable','Session audience unconfirmed',true);
   // `_run_audience_v2` re-validates live state before serving a journaled
   // answer: a retired public receipt is never re-served.
   const stale=String(journal.generation)!==prior.receipt.response.result.generation||
    (prior.receipt.response.result.state==='public'&&(!journal.active||journal.streamId!==prior.receipt.response.result.stream_id));
   if(stale){
    await record('audience-replay-refused-stale',{operation_id:body.operation_id,journal_generation:journal.generation,active:journal.active});
    return problem(503,'audience_producer_unavailable','Session audience unconfirmed',true);
   }
   await record('audience-replay-answered-from-journal',{operation_id:body.operation_id,action:prior.action});
   return json(200,prior.receipt);
  }
  const answer=audienceBody(body.action,journal.generation);
  journal.operations[body.operation_id]={action:body.action,receipt:answer,
   deadlineMs:Date.now()+(mode==='lost-share-expired'?-1:AUDIENCE_WINDOW_MS)};
  if(body.action==='publish'){journal.generation+=1;journal.active=true;journal.streamId=answer.response.result.stream_id;}
  else journal.active=false;
  writeFileSync(journalPath,JSON.stringify(journal));
  // The session transitioned and the journal holds the answer; only the HTTP
  // response is lost. The durable operation record is the only thing that can
  // still reach it.
  if((mode==='lost-share'||mode==='lost-share-expired')&&body.action==='publish'&&!audienceLost){audienceLost=true;await record('audience-applied-but-response-lost',{operation_id:body.operation_id});throw new TypeError('fetch failed');}
  return json(200,answer);
 }
 return json(404,{error:'unexpected_route',path:u.pathname});
}
const base=path.dirname(ledger);await mkdir(path.join(base,'config'),{recursive:true});
process.exitCode=await runProcessCli(['share','--project',PROJECT,'--config-file',configFile],{stdin:process.stdin,run:async(argv,deps)=>runCli(argv,{
 ...deps,env:{CUNA_TERMINAL_MODE:'rich'},fetch:fakeFetch,
 humanAuth:{async acquireAccessToken(){return `cuna_at_${'a'.repeat(43)}`;},async refreshRejectedAccessToken(){return `cuna_at_${'a'.repeat(43)}`;}},
 platform:{...createPlatformAdapter(),paths:{configDirectory:path.join(base,'config'),stateDirectory:path.join(base,'state'),runtimeDirectory:path.join(base,'runtime')}},
})});
await record('exit',{code:process.exitCode,revokeAttempts,inspects,audience:readJournal().generation,final:grant?{state:grant.state,revocation_state:grant.revocation_state,revision:grant.revision}:null});
