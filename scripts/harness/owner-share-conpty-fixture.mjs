import {appendFile,mkdir} from 'node:fs/promises';
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
const problem=(status,code,title)=>json(status,{type:'about:blank',title,status,code,request_id:id(99),retryable:false,detail:title});
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
 return json(404,{error:'unexpected_route',path:u.pathname});
}
const base=path.dirname(ledger);await mkdir(path.join(base,'config'),{recursive:true});
process.exitCode=await runProcessCli(['share','--project',PROJECT,'--config-file',configFile],{stdin:process.stdin,run:async(argv,deps)=>runCli(argv,{
 ...deps,env:{CUNA_TERMINAL_MODE:'rich'},fetch:fakeFetch,
 humanAuth:{async acquireAccessToken(){return `cuna_at_${'a'.repeat(43)}`;},async refreshRejectedAccessToken(){return `cuna_at_${'a'.repeat(43)}`;}},
 platform:{...createPlatformAdapter(),paths:{configDirectory:path.join(base,'config'),stateDirectory:path.join(base,'state'),runtimeDirectory:path.join(base,'runtime')}},
})});
await record('exit',{code:process.exitCode,revokeAttempts,inspects,final:grant?{state:grant.state,revocation_state:grant.revocation_state,revision:grant.revision}:null});
