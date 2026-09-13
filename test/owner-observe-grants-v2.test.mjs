import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {ownerObserveGrantsApi,decodeOwnerGrant,decodeProjectObserverPage,describeGrantState,classifyTransportFailure,OwnerGrantError} from '../dist/api/owner-observe-grants-v2.js';
import {ownerObserveGrantSchemas,ownerObserveGrantOperations} from '../dist/api/owner-observe-grants-v2-schema.js';
import {runOwnerGrantsScreen} from '../dist/runtime/owner-grants-screen.js';
import {ownerGrantOperationStore} from '../dist/runtime/owner-grant-operations.js';
import {createPlatformAdapter} from '../dist/platform/adapter.js';
import {CunaError,EXIT_CODES} from '../dist/core/errors.js';
import {memoryStreams,runCli} from '../dist/index.js';
import {mkdtemp,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const id=n=>`ba600000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const project='20178adc-8ae4-515a-bb38-bd25042707db',owner=id(1),member=id(2),session=id(5),other=id(9);
const now=Date.now();
const active={version:'2',kind:'session_observe_grant',grant_id:id(3),revision:1,owner_principal_id:owner,subject_principal_id:member,agent_session_id:session,session_incarnation:id(6),project_id:project,authority_epoch:1,membership_revision:4,state:'active',expires_at:now+3600000,revocation_state:null};
const revoking={...active,revision:2,state:'revoking',revocation_state:'effective_pending'};
const revoked={...active,revision:3,state:'revoked',revocation_state:'effective'};
const memberPage={version:'2',kind:'project_observers',project_id:project,authority_epoch:1,items:[{principal_id:owner,membership_revision:1,recipient_email:'owner@example.test'},{principal_id:member,membership_revision:4,recipient_email:'member-b@example.test'}],next_after_principal_id:null};
const signal=new AbortController().signal;
const tick=()=>new Promise(resolve=>setTimeout(resolve,25));
const http=(status,reason)=>new CunaError({code:status===403?'cuna.policy.denied':'cuna.remote.rejected',message:'x',exitCode:EXIT_CODES.remote,details:{http_status:status,...(reason?{reason}:{})}});

test('owner projection is generated from the vendored contract and its check passes',()=>{
 const bytes=readFileSync(new URL('../contracts/infra/cuna-api.openapi.json',import.meta.url));
 const header=readFileSync(new URL('../src/api/owner-observe-grants-v2-schema.ts',import.meta.url),'utf8').split('\n')[1];
 assert.ok(header.includes(`contracts/infra/cuna-api.openapi.json; SHA256 ${createHash('sha256').update(bytes).digest('hex')}`));
 const spec=JSON.parse(bytes);for(const [name,schema] of Object.entries(ownerObserveGrantSchemas))assert.deepEqual(schema,spec.components.schemas[name],name);
 assert.deepEqual(Object.keys(ownerObserveGrantOperations).sort(),['createSessionObserveGrantV2','inspectSessionObserveGrantV2','listProjectObserversV2','revokeSessionObserveGrantV2']);
 execFileSync(process.execPath,['scripts/project-owner-observe-grants-v2.mjs','--check'],{cwd:new URL('..',import.meta.url),stdio:'pipe'});
 // The recipient projection and decoder are untouched by this surface.
 assert.doesNotMatch(readFileSync(new URL('../src/api/observer-v2.ts',import.meta.url),'utf8'),/owner-observe/u);
});

test('create sends the canonical body and refuses receipts about another owner, Project, session, member, revision or expiry',async()=>{
 const requests=[];const api=ownerObserveGrantsApi({request:async r=>{requests.push(r);return active;}},owner,project);
 const input={agentSessionId:session,subjectPrincipalId:member,expectedMembershipRevision:4,expiresAtMs:active.expires_at};
 const g=await api.create(input,id(7),signal);assert.equal(g.grant_id,active.grant_id);
 assert.equal(requests[0].path,`/v1/collaboration/2/agent-sessions/${session}/observe-grants`);
 assert.deepEqual(requests[0].body,{version:'2',operation_id:id(7),subject_principal_id:member,expected_membership_revision:4,expires_at_ms:active.expires_at});
 const cases=[[{...active,owner_principal_id:other},'identity_mismatch'],[{...active,project_id:id(8)},'identity_mismatch'],[{...active,agent_session_id:other},'identity_mismatch'],[{...active,subject_principal_id:other},'identity_mismatch'],[{...active,subject_principal_id:owner},'identity_mismatch'],[{...active,membership_revision:5},'stale_revision'],[{...active,expires_at:active.expires_at+1},'identity_mismatch'],[{...active,state:'active',revocation_state:'effective'},'malformed_receipt'],[{...active,extra:1},'malformed_receipt'],[{...active,secret:'x'},'malformed_receipt']];
 for(const [receipt,kind] of cases){const bad=ownerObserveGrantsApi({request:async()=>receipt},owner,project);await assert.rejects(bad.create(input,id(7),signal),error=>error instanceof OwnerGrantError&&error.kind===kind&&error.code===`cuna.share.${kind}`,JSON.stringify(receipt));}
 await assert.rejects(api.create({...input,subjectPrincipalId:owner},id(7),signal),error=>error.kind==='identity_mismatch');
 assert.equal(requests.length,1,'a refused local precondition sends nothing');
});

test('revoke binds the exact read revision and refuses a receipt that still says active; inspect refuses regression',async()=>{
 const requests=[];let answer=revoking;const api=ownerObserveGrantsApi({request:async r=>{requests.push(r);return answer;}},owner,project);
 const g=await api.revoke(active,id(7),signal);assert.equal(g.state,'revoking');
 assert.equal(requests[0].path,`/v1/collaboration/2/observe-grants/${active.grant_id}/revoke`);assert.deepEqual(requests[0].body,{version:'2',operation_id:id(7),expected_revision:1});
 answer=active;await assert.rejects(api.revoke(active,id(7),signal),error=>error.kind==='malformed_receipt');
 answer={...revoking,grant_id:id(4)};await assert.rejects(api.revoke(active,id(7),signal),error=>error.kind==='identity_mismatch');
 answer={...active,revision:0.5};await assert.rejects(api.inspect(active,signal),error=>error.kind==='malformed_receipt');
 answer=active;await assert.rejects(api.inspect(revoking,signal),error=>error.kind==='stale_revision');
 answer=revoked;assert.equal((await api.inspect(revoking,signal)).state,'revoked');assert.deepEqual(requests.at(-1).body,{version:'2'});
});

test('grant states are described distinctly and a pending revocation never reads as revoked',()=>{
 assert.equal(describeGrantState(active,now).label,'Active');
 const pending=describeGrantState(revoking,now);assert.match(pending.label,/not yet effective/u);assert.equal(pending.final,false);assert.doesNotMatch(pending.label,/^Revoked/u);
 const done=describeGrantState(revoked,now);assert.equal(done.label,'Revoked, effective');assert.equal(done.final,true);
 assert.equal(describeGrantState({...active,expires_at:now-1},now).label,'Expired');
 assert.equal(describeGrantState({...revoked,revocation_state:'effective_pending'},now).final,false);
});

/**
 * The producer's own refusal codes, read at infra 2d61dd1 and asserted here
 * against what the screen will say. The check that used to live on this line
 * asserted a 409 for a stale membership revision, which no producer path emits:
 * `create_collab_v2_session_observe_grant` raises `collab_v2_observe_unavailable`,
 * the Edge maps it to `grant_unavailable` and renders 404. 409 is
 * `operation_conflict` only.
 */
test('the producer 404 and 409 are mapped to their real causes, per operation',()=>{
 const created=classifyTransportFailure(http(404,'grant_unavailable'),true,'create');
 assert.equal(created.kind,'grant_unavailable');assert.equal(created.effectUnknown,false);
 assert.match(created.message,/no longer an active observer at the membership revision that was read/u);
 assert.match(created.message,/created nothing/u);
 assert.doesNotMatch(created.message,/stale expected revision/u);
 const revoked404=classifyTransportFailure(http(404,'grant_unavailable'),true,'revoke');
 assert.match(revoked404.message,/no longer active at the revision that was read/u);
 assert.notEqual(revoked404.message,created.message,'different operations must not read identically');
 assert.match(classifyTransportFailure(http(404,'grant_unavailable'),false,'inspect').message,/neither its owner nor its subject/u);
 assert.match(classifyTransportFailure(http(404,'grant_unavailable'),false,'members').message,/not the Project's present active owner/u);
 const conflict=classifyTransportFailure(http(409,'operation_conflict'),true,'create');
 assert.equal(conflict.kind,'operation_conflict');assert.equal(conflict.exitCode,EXIT_CODES.conflict);assert.equal(conflict.effectUnknown,false);
 assert.match(conflict.message,/an active grant for this member on this session already exists/u);
 assert.match(classifyTransportFailure(http(409,'operation_conflict'),true,'revoke').message,/already used for a different revocation request/u);
 // An answer that names no collaboration reason may not be given one.
 assert.equal(classifyTransportFailure(http(404),false,'inspect').kind,'not_found');
 assert.match(classifyTransportFailure(http(404),false,'inspect').message,/named no collaboration reason/u);
 assert.match(classifyTransportFailure(http(409),true,'create').message,/named no collaboration reason/u);
 // Losing Project ownership arrives as 404, so 403 must not claim to report it.
 assert.doesNotMatch(classifyTransportFailure(http(403),true,'create').message,/Project owner with/u);
 assert.match(classifyTransportFailure(http(403),true,'create').message,/collaboration:manage/u);
 // A deployment that does not serve the route is not a missing grant.
 const unserved=classifyTransportFailure(new CunaError({code:'cuna.remote.operation_not_served',message:'The Cuna API at https://x.test does not serve POST /p.',exitCode:EXIT_CODES.unsupported,details:{http_status:404}}),true,'create');
 assert.equal(unserved.kind,'unavailable');assert.match(unserved.message,/does not serve the collaboration grant operations/u);
 assert.match(classifyTransportFailure(http(422,'request_invalid'),true,'create').message,/never reached the grant store/u);
});

test('transport failures become typed owner failures; an unanswered mutation is uncertain, an unanswered read is unavailable',()=>{
 assert.equal(classifyTransportFailure(http(403),true).kind,'denied');
 assert.equal(classifyTransportFailure(http(409,'operation_conflict'),true).kind,'operation_conflict');
 assert.equal(classifyTransportFailure(http(404),false).kind,'not_found');
 assert.equal(classifyTransportFailure(new CunaError({code:'cuna.network.timeout',message:'x',exitCode:EXIT_CODES.network}),true).kind,'uncertain');
 assert.equal(classifyTransportFailure(new CunaError({code:'cuna.network.timeout',message:'x',exitCode:EXIT_CODES.network}),false).kind,'unavailable');
 assert.equal(classifyTransportFailure(new TypeError('fetch failed'),true).kind,'uncertain');
 const e=classifyTransportFailure(new CunaError({code:'cuna.auth.rejected',message:'x',exitCode:EXIT_CODES.auth}),false);assert.equal(e.kind,'auth');assert.equal(e.code,'cuna.share.auth');
});

test('member page must name the Project and be ordered',()=>{
 assert.equal(decodeProjectObserverPage(memberPage,project,null).items.length,2);
 assert.throws(()=>decodeProjectObserverPage({...memberPage,project_id:id(8)},project,null),e=>e.kind==='identity_mismatch');
 assert.throws(()=>decodeProjectObserverPage({...memberPage,items:[...memberPage.items].reverse()},project,null),e=>e.kind==='malformed_receipt');
 assert.throws(()=>decodeOwnerGrant({...active,subject_principal_id:owner},owner,project),e=>e.kind==='identity_mismatch');
});

test('identity change while a mutation is in flight refuses the answer',async()=>{
 let who=owner;const api=ownerObserveGrantsApi({request:async()=>{who=other;return active;}},owner,project,async()=>who);
 await assert.rejects(api.create({agentSessionId:session,subjectPrincipalId:member,expectedMembershipRevision:4,expiresAtMs:active.expires_at},id(7),signal),e=>e.kind==='identity_mismatch');
});

/**
 * Real adapter, real screen and the REAL durable operation store on a real
 * temporary state directory. Only the transport and the host terminal are
 * fakes, so persistence, recovery and the overwrite prohibition are exercised
 * as shipped rather than against a parallel model.
 */
const sandboxes=[];
async function newStore(){
 const directory=await mkdtemp(path.join(tmpdir(),'cuna-share-store-'));sandboxes.push(directory);
 const base=createPlatformAdapter();
 const platform={...base,paths:{...base.paths,stateDirectory:path.join(directory,'state')}};
 return{platform,directory,store:ownerGrantOperationStore(platform,{baseUrl:'https://api.getcuna.com',profile:'default',ownerPrincipalId:owner,projectId:project})};
}
test.after(async()=>{for(const directory of sandboxes)await rm(directory,{recursive:true,force:true});});
async function harness(handler,options={},reuse){
 let input,restored=0;const frames=[],requests=[];
 const context=reuse??await newStore();
 const host={dimensions:()=>({columns:100,rows:30}),acquire:async()=>({restore:async()=>{restored++;}}),write:async bytes=>{frames.push(new TextDecoder().decode(bytes));},onInput(fn){input=fn;return()=>{input=undefined;};},onResize(){throw Error('resize listener forbidden');}};
 const api=ownerObserveGrantsApi({request:async r=>{requests.push(r);return handler(r,requests.length);}},owner,project);
 const sessions={list:async()=>({items:[{id:session,name:'claude-live',agent:'claude-code',machineName:'box',state:'running',projectId:project},{id:id(11),name:'elsewhere',agent:'codex',machineName:'box',state:'running',projectId:id(12)}],omittedMachines:options.omittedMachines??0,machinesWithMoreSessions:options.machinesWithMoreSessions??0})};
 const done=runOwnerGrantsScreen(api,sessions,context.store,{project,owner},{host,now:()=>now,...options});
 const h={done,frames,requests,context,last:()=>frames.at(-1)??'',key(v){input?.(new TextEncoder().encode(v));},get restored(){return restored;},
  records:()=>context.store.list(),
  /**
   * Wait for the screen the step is supposed to reach.
   *
   * A fixed sleep was wrong: this screen now does real filesystem work on the
   * startup and mutation paths, so under load the assertion could run before
   * the paint. Waiting on the rendered condition is what the ConPTY driver
   * does, and it fails with the screen it actually saw.
   */
  async wait(pattern,timeoutMs=15000){const deadline=Date.now()+timeoutMs;
   while(Date.now()<deadline){if(pattern.test(h.last()))return h.last();await new Promise(r=>setTimeout(r,10));}
   throw new Error(`screen never matched ${pattern}. Last screen:\n${h.last()}`);},
  /**
   * Press a key and wait for the screen that press must produce.
   *
   * Requiring a NEW frame matters: an inspect that reports the same state
   * repaints text identical to what was already there, so waiting on the
   * pattern alone would match the previous screen and race ahead of the
   * request. The transient "Waiting for Cuna..." frame is never the answer.
   */
  async press(key,pattern,timeoutMs=15000){const mark=frames.length;h.key(key);const deadline=Date.now()+timeoutMs;
   while(Date.now()<deadline){if(frames.length>mark&&!/Waiting for Cuna/u.test(h.last())&&pattern.test(h.last()))return h.last();await new Promise(r=>setTimeout(r,10));}
   throw new Error(`pressing ${JSON.stringify(key)} never produced ${pattern}. Last screen:\n${h.last()}`);}};
 return h;
}
const route=r=>r.path.split('/').at(-1);

test('owner flow: session -> distinct member -> duration -> active grant -> revoke pending -> inspect effective; keys never reach the wire',async()=>{
 let state=active;const h=await harness(r=>{if(route(r)==='observers')return memberPage;if(route(r)==='observe-grants')return active;if(route(r)==='revoke'){state=revoking;return revoking;}if(route(r)==='inspect'){const out=state;if(state===revoking)state=revoked;return out;}throw Error(r.path);});
 await h.wait(/Share a session - read-only observation/u);assert.match(h.last(),/> box \/ claude-live/u);assert.doesNotMatch(h.last(),/elsewhere/u,'sessions of another Project are not offered');
 await h.press('\r',/Choose the member who may observe claude-live/u);assert.match(h.last(),/member-b@example\.test/u);assert.doesNotMatch(h.last(),/owner@example\.test/u,'the owner is not offered as a recipient');assert.match(h.last(),/grants nothing by itself/u);
 await h.press('\r',/Press 1, 2 or 3/u);
 await h.press('2',/Observation grant ba600000 - Active/u);assert.match(h.last(),/No keyboard, resize or signal is granted/u);
 const create=h.requests.find(r=>route(r)==='observe-grants');assert.equal(create.body.expires_at_ms,now+28800000);assert.equal(create.body.expected_membership_revision,4);assert.equal(create.body.subject_principal_id,member);
 h.key('typed-text');await tick();assert.equal(h.requests.length,2,'stray typing sends nothing');
 await h.press('x',/Revocation requested, not yet effective/u);assert.match(h.last(),/may still see output/u);assert.doesNotMatch(h.last(),/Revoked, effective/u);
 assert.deepEqual(h.requests.at(-1).body,{version:'2',operation_id:h.requests.at(-1).body.operation_id,expected_revision:1});
 h.key('x');await tick();assert.equal(h.requests.length,3,'x on a non-active grant sends nothing');
 await h.press('i',/revision 2/u);assert.match(h.last(),/Revocation requested, not yet effective/u,'a first inspect that still reports pending stays pending');assert.equal(h.requests.length,4);
 await h.press('i',/Revoked, effective/u);assert.match(h.last(),/stream endpoint is retired/u);assert.equal(h.requests.length,5,'each inspect is one explicit keypress, no polling');
 h.key('\x03');await h.done;assert.equal(h.restored,1);
 assert.ok(h.frames.every(f=>f.startsWith('[H[2J')),'every paint is a full repaint');
});

test('uncertain revocation: outcome shown as unknown, r resends the SAME operation and expected revision, i inspects instead',async()=>{
 let lost=true;const bodies=[];const h=await harness(r=>{if(route(r)==='observers')return memberPage;if(route(r)==='observe-grants')return active;if(route(r)==='revoke'){bodies.push(r.body);if(lost){lost=false;throw new TypeError('fetch failed');}return revoked;}throw Error(r.path);});
 await h.wait(/Share a session/u);await h.press('\r',/Choose the member/u);await h.press('\r',/Press 1, 2 or 3/u);await h.press('1',/Observation grant ba600000 - Active/u);
 await h.press('x',/Unresolved change - outcome unknown/u);assert.match(h.last(),/Cuna never confirmed this/u);assert.doesNotMatch(h.last(),/Revoked/u);assert.match(h.last(),/r resends this exact operation/u);
 const kept=await h.records();assert.equal(kept.length,1);assert.equal(kept[0].kind,'revoke');assert.equal(kept[0].operationId,bodies[0].operation_id);assert.equal(kept[0].expectedRevision,1);
 await h.press('r',/Revoked, effective/u);assert.equal(bodies.length,2);assert.deepEqual(bodies[0],bodies[1]);
 assert.deepEqual(await h.records(),[],'a confirmed outcome drops the durable record');
 h.key('\x1b');await h.done;assert.equal(h.restored,1);
});

test('an uncertain revocation is answered by inspecting the grant, which settles the record either way',async()=>{
 const h=await harness(r=>{if(route(r)==='observers')return memberPage;if(route(r)==='observe-grants')return active;if(route(r)==='revoke')throw new TypeError('fetch failed');if(route(r)==='inspect')return revoking;throw Error(r.path);});
 await h.wait(/Share a session/u);await h.press('\r',/Choose the member/u);await h.press('\r',/Press 1, 2 or 3/u);await h.press('1',/Observation grant ba600000 - Active/u);
 await h.press('x',/Unresolved change - outcome unknown/u);assert.match(h.last(),/Inspecting the grant answers it directly/u);
 await h.press('i',/Revocation requested, not yet effective/u);
 assert.deepEqual(await h.records(),[]);assert.doesNotMatch(h.last(),/unknown outcome\. Press p/u);
 h.key('\x03');await h.done;
});

test('uncertain creation replays one operation identity and never mints a second grant; a stale membership renders as the producer\'s 404',async()=>{
 // The replay is followed by a read of current state (M5), so the fixture must
 // answer `inspect`: the frozen create receipt is never the final screen.
 let lost=true;const creates=[];const h=await harness(r=>{if(route(r)==='observers')return memberPage;if(route(r)==='inspect')return active;if(route(r)==='observe-grants'){creates.push(r.body);if(lost){lost=false;throw new CunaError({code:'cuna.network.timeout',message:'x',exitCode:EXIT_CODES.network});}if(creates.length===3)throw http(404,'grant_unavailable');return active;}throw Error(r.path);});
 await h.wait(/Share a session/u);await h.press('\r',/Choose the member/u);await h.press('\r',/Press 1, 2 or 3/u);await h.press('1',/Unresolved change - outcome unknown/u);
 assert.match(h.last(),/cannot create a second grant/u);assert.match(h.last(),/no owner-side listing/u);
 await h.press('b',/Share a session/u);assert.match(h.last(),/unknown outcome\. Press p/u);assert.match(h.last(),/No new grant or revocation can start/u);
 await h.press('p',/Unresolved change - outcome unknown/u);
 await h.press('r',/Observation grant ba600000 - Active/u);assert.equal(creates.length,2);assert.equal(creates[0].operation_id,creates[1].operation_id);assert.deepEqual(await h.records(),[]);
 assert.doesNotMatch(h.last(),/stored answer/u,'a current reading replaces the replayed snapshot');
 await h.press('b',/Share a session/u);await h.press('\r',/Choose the member/u);await h.press('\r',/Press 1, 2 or 3/u);await h.press('1',/Not done - grant unavailable/u);
 assert.equal(creates.length,3);assert.notEqual(creates[2].operation_id,creates[0].operation_id,'a fresh intent gets a fresh identity');
 assert.match(h.last(),/no longer an active observer at the membership revision that was read/u);
 assert.doesNotMatch(h.last(),/stale expected revision/u,'the producer has no 409 for this cause');
 assert.match(h.last(),/r rereads the members/u,'rereading the members is the real recovery for this refusal');
 assert.deepEqual(await h.records(),[],'a refusal the server issued without acting drops the record');
 h.key('\x03');await h.done;
});

/**
 * B1, reproduced as a unit of the shipped screen.
 *
 * A resend the server SETTLES destroys the durable record on purpose -- the
 * outcome is known, so there is nothing left to replay. The rendered reason is
 * then the only explanation that exists anywhere, and it used to be discarded:
 * the empty list fell through to the session list and said nothing.
 */
test('a settled resend renders its reason and keeps the operation identity visible',async()=>{
 for(const [status,reason,expected] of [[404,'grant_unavailable',/Not done - grant unavailable/u],[409,'operation_conflict',/Not done - operation conflict/u]]){
  let lost=true;const h=await harness(r=>{if(route(r)==='observers')return memberPage;if(route(r)==='observe-grants'){if(lost){lost=false;throw new TypeError('fetch failed');}throw http(status,reason);}throw Error(r.path);});
  await h.wait(/Share a session/u);await h.press('\r',/Choose the member/u);await h.press('\r',/Press 1, 2 or 3/u);await h.press('1',/Unresolved change - outcome unknown/u);
  const operationId=(await h.records())[0].operationId;
  await h.press('r',expected);
  assert.doesNotMatch(h.last(),/Share a session - read-only observation/u,'a settled failure must not vanish into the session list');
  assert.match(h.last(),new RegExp(`Operation ${operationId} \\(grant\\) is settled`,'u'),'the settled operation identity survives in the displayed outcome');
  assert.deepEqual(await h.records(),[],'the record is gone, which is why the screen had to say this');
  h.key('\x03');await h.done;
 }
});

/**
 * M5. `create_collab_v2_session_observe_grant` answers a replayed operation ID
 * with `return old.result`, the receipt as it stood at creation. It always says
 * `active`, so it may not be shown as current authority.
 */
test('a create replay is reconciled against current state, and an unreadable current state is labelled, never presented as authority',async()=>{
 let lost=true;const h=await harness(r=>{if(route(r)==='observers')return memberPage;if(route(r)==='observe-grants'){if(lost){lost=false;throw new TypeError('fetch failed');}return active;}if(route(r)==='inspect')return revoked;throw Error(r.path);});
 await h.wait(/Share a session/u);await h.press('\r',/Choose the member/u);await h.press('\r',/Press 1, 2 or 3/u);await h.press('1',/Unresolved change - outcome unknown/u);
 await h.press('r',/Revoked, effective/u);
 assert.equal(h.requests.filter(r=>route(r)==='inspect').length,1,'the replay is followed by exactly one read of current state');
 assert.doesNotMatch(h.last(),/- Active/u,'the frozen active snapshot is never what the owner is shown');
 assert.deepEqual(await h.records(),[]);
 h.key('\x03');await h.done;
 // Same replay, but the current state cannot be read: keep the receipt, say what it is.
 let lostAgain=true;const blind=await harness(r=>{if(route(r)==='observers')return memberPage;if(route(r)==='observe-grants'){if(lostAgain){lostAgain=false;throw new TypeError('fetch failed');}return active;}if(route(r)==='inspect')throw http(503);throw Error(r.path);});
 await blind.wait(/Share a session/u);await blind.press('\r',/Choose the member/u);await blind.press('\r',/Press 1, 2 or 3/u);await blind.press('1',/Unresolved change - outcome unknown/u);
 const replayedOperation=(await blind.records())[0].operationId;
 await blind.press('r',/stored answer, not current authority/u);
 assert.match(blind.last(),new RegExp(`receipt Cuna stored when operation ${replayedOperation} was first answered`,'u'));
 assert.match(blind.last(),/not evidence that this grant is still active/u);
 assert.match(blind.last(),/Reading the current state did not answer/u);
 assert.doesNotMatch(blind.last(),/x revokes/u,'a stored replay is not a revision a revocation may be aimed at');
 blind.key('x');await tick();
 assert.equal(blind.requests.filter(r=>route(r)==='revoke').length,0,'x on a stored replay sends nothing');
 blind.key('\x03');await blind.done;
});

/** CUNA-COL-016-R4: the history scope is stated before the key that grants. */
test('the screen before the grant discloses the real observation and replay history scope',async()=>{
 const h=await harness(r=>{if(route(r)==='observers')return memberPage;throw Error(r.path);});
 await h.wait(/Share a session/u);await h.press('\r',/Choose the member/u);await h.press('\r',/Press 1, 2 or 3/u);
 const screen=h.last();
 assert.match(screen,/Only what happens from the moment they start watching/u);
 assert.match(screen,/Nothing from before that: earlier output and scrollback are never sent/u);
 assert.match(screen,/still on the screen when they start watching is visible to them/u);
 assert.match(screen,/requires this session to be shared live/u);
 // Publication exists; it lives in the console. Saying the CLI cannot do it
 // must not imply nobody can.
 assert.match(screen,/That step is in the Cuna web app; this CLI does not do it/u);
 assert.match(screen,/never type, resize or send a signal/u);
 // Plain language: no contract or transport internals reach the terminal.
 for(const leak of [/sequence/iu,/generation/iu,/stream/iu,/audience/iu,/redraw/iu,/frame/iu])assert.doesNotMatch(screen,leak,String(leak));
 assert.equal(h.requests.filter(r=>route(r)==='observe-grants').length,0,'the disclosure precedes the grant');
 h.key('\x03');await h.done;
});

/** M3: a bounded listing may not imply completeness. */
test('a truncated session listing says so',async()=>{
 const h=await harness(r=>{throw Error(r.path);},{omittedMachines:3,machinesWithMoreSessions:2});
 await h.wait(/Share a session/u);
 assert.match(h.last(),/This list is incomplete: 3 further Machines were not read, and 2 Machines have more AgentSessions than one page/u);
 h.key('\x03');await h.done;
 const whole=await harness(r=>{throw Error(r.path);});
 await whole.wait(/Share a session/u);
 assert.doesNotMatch(whole.last(),/This list is incomplete/u,'a complete listing claims nothing');
 whole.key('\x03');await whole.done;
});

test('the durable record is written BEFORE the request leaves and survives exit; a relaunch opens on it with the same operation ID',async()=>{
 let seen;const first=await harness(async(r)=>{if(route(r)==='observers')return memberPage;if(route(r)==='observe-grants'){seen=[r.body.operation_id,(await first.records()).map(o=>o.operationId)];throw new TypeError('fetch failed');}throw Error(r.path);});
 await first.wait(/Share a session/u);await first.press('\r',/Choose the member/u);await first.press('\r',/Press 1, 2 or 3/u);await first.press('1',/Unresolved change - outcome unknown/u);
 assert.deepEqual(seen[1],[seen[0]],'the operation was on disk before its request was answered');
 // Ordinary exit. Nothing is cleaned up: the outcome is still unknown.
 first.key('\x03');await first.done;
 const kept=await first.context.store.list();assert.equal(kept.length,1);assert.equal(kept[0].operationId,seen[0]);
 assert.deepEqual(Object.keys(kept[0]).sort(),['agentSessionId','expectedMembershipRevision','expiresAtMs','kind','operationId','scope','subjectPrincipalId','version']);
 // A new process, same state directory: recovery comes first, before any session list.
 const replays=[];const second=await harness(r=>{if(route(r)==='observers')return memberPage;if(route(r)==='inspect')return active;if(route(r)==='observe-grants'){replays.push(r.body);return active;}throw Error(r.path);},{},first.context);
 await second.wait(/Unresolved change - outcome unknown/u);assert.match(second.last(),new RegExp(`operation ${seen[0]}`,'u'));
 assert.doesNotMatch(second.last(),/Share a session - read-only/u,'recovery precedes the normal entry screen');
 await second.press('r',/Observation grant ba600000 - Active/u);
 assert.equal(replays.length,1);assert.equal(replays[0].operation_id,seen[0],'the relaunched process replays the exact recovered identity');
 assert.equal(replays[0].expected_membership_revision,4);assert.equal(replays[0].expires_at_ms,now+3600000,'the recovered request is byte-identical in intent, not re-derived from a new clock');
 assert.deepEqual(await second.records(),[]);
 second.key('\x03');await second.done;
});

test('an unresolved operation cannot be overwritten by a new one, and d forgets only the local record',async()=>{
 const creates=[];const h=await harness(r=>{if(route(r)==='observers')return memberPage;if(route(r)==='observe-grants'){creates.push(r.body);if(creates.length===1)throw new TypeError('fetch failed');return active;}throw Error(r.path);});
 await h.wait(/Share a session/u);await h.press('\r',/Choose the member/u);await h.press('\r',/Press 1, 2 or 3/u);await h.press('1',/Unresolved change - outcome unknown/u);
 assert.equal(creates.length,1);
 const stuck=(await h.records())[0].operationId;
 // Walk back out and try to start a DIFFERENT grant: it must be refused, and
 // the stored identity must still be the original one.
 await h.press('b',/Share a session/u);await h.press('\r',/Choose the member/u);await h.press('\r',/Press 1, 2 or 3/u);
 await h.press('2',/Cannot create a grant while an earlier change has an unknown outcome/u);
 assert.equal(creates.length,1,'no second create left the client');
 const after=await h.records();assert.equal(after.length,1);assert.equal(after[0].operationId,stuck,'the unresolved identity was not replaced');
 assert.equal(after[0].expiresAtMs,now+3600000,'nor was its intent rewritten by the newer choice');
 // M1. Forgetting is irreversible and revokes nothing, so it is asked before it
 // is done, keeps the record when declined, and names the operation afterwards.
 await h.press('d',/Forget this local record\?/u);
 assert.match(h.last(),new RegExp(`operation ${stuck}`,'u'));
 assert.match(h.last(),/Cuna is not contacted and nothing is revoked/u);
 // The consequence is conditional on the EFFECT, not on delivery: reaching Cuna
 // is not taking effect, and this outcome is unknown by definition.
 assert.match(h.last(),/The outcome stays unknown/u);
 assert.match(h.last(),/If that request did take effect, a grant exists and the member may be able to observe/u);
 assert.doesNotMatch(h.last(),/did reach Cuna/u,'delivery is not effect');
 assert.match(h.last(),/This cannot be undone/u);
 await h.press('n',/Unresolved change - outcome unknown/u);
 assert.equal((await h.records()).length,1,'any key but y keeps the record');
 await h.press('d',/Forget this local record\?/u);
 await h.press('y',/Local record forgotten - nothing was revoked/u);
 assert.deepEqual(await h.records(),[]);
 assert.match(h.last(),new RegExp(`operation ${stuck}`,'u'),'the outcome retains the operation identity');
 assert.match(h.last(),/Whatever that operation did or did not do still stands, unchanged/u);
 assert.doesNotMatch(h.last(),/authority that operation may have created still exists/u,'no existence is asserted');
 assert.doesNotMatch(h.last(),/unknown outcome\. Press p/u);
 await h.press('b',/Share a session/u);
 await h.press('\r',/Choose the member/u);await h.press('\r',/Press 1, 2 or 3/u);await h.press('2',/Observation grant ba600000 - Active/u);
 assert.equal(creates.length,2,'a new grant is allowed once nothing is unresolved');assert.notEqual(creates[1].operation_id,stuck);
 h.key('\x03');await h.done;
});

/**
 * M2. The in-memory guard is this process's view. A second `cuna share` on the
 * same Project writes to the same scope directory, so the durable scope is
 * re-read immediately before reserving. This narrows the window; it does not
 * close it, because there is no cross-process lock.
 */
test('a record written by another process between launch and the keypress blocks the mutation',async()=>{
 const creates=[];const h=await harness(r=>{if(route(r)==='observers')return memberPage;if(route(r)==='observe-grants'){creates.push(r.body);return active;}throw Error(r.path);});
 await h.wait(/Share a session/u);await h.press('\r',/Choose the member/u);await h.press('\r',/Press 1, 2 or 3/u);
 // The other process reserves AFTER this one loaded its list and painted the
 // duration menu, so nothing in memory here knows about it.
 const intruder={kind:'revoke',operationId:id(41),grantId:active.grant_id,agentSessionId:session,subjectPrincipalId:member,expectedRevision:1};
 await h.context.store.reserve(intruder);
 await h.press('1',/Cannot create a grant while an earlier change has an unknown outcome/u);
 assert.equal(creates.length,0,'nothing left the client');
 assert.deepEqual((await h.records()).map(o=>o.operationId),[id(41)],'the other process\'s record is intact and is the one now shown');
 h.key('\x03');await h.done;
});

test('the operation store refuses to overwrite an identity, isolates scopes and rejects a tampered record',async()=>{
 const {store,platform}=await newStore();
 const intent={kind:'create',operationId:id(21),agentSessionId:session,subjectPrincipalId:member,expectedMembershipRevision:4,expiresAtMs:now+3600000};
 await store.reserve(intent);
 await assert.rejects(store.reserve(intent),/already has an unresolved record/u);
 await assert.rejects(store.reserve({...intent,operationId:'not-a-uuid'}),/Invalid Operation ID|Operation ID/u);
 assert.equal((await store.list()).length,1);
 const elsewhere=ownerGrantOperationStore(platform,{baseUrl:'https://api.getcuna.com',profile:'default',ownerPrincipalId:owner,projectId:id(31)});
 assert.deepEqual(await elsewhere.list(),[],'another Project never sees this Project\'s unresolved operations');
 const other=ownerGrantOperationStore(platform,{baseUrl:'https://api.getcuna.com',profile:'second',ownerPrincipalId:owner,projectId:project});
 assert.deepEqual(await other.list(),[],'another profile is a separate scope');
 await store.settle(id(21));assert.deepEqual(await store.list(),[]);
 await store.settle(id(21));// settling twice is not an error
 const revoke={kind:'revoke',operationId:id(22),grantId:active.grant_id,agentSessionId:session,subjectPrincipalId:member,expectedRevision:2};
 await store.reserve(revoke);
 const directory=path.join(platform.paths.stateDirectory,'owner-observe-grants-v2');
 const scope=(await readdir(directory))[0];
 await writeFile(path.join(directory,scope,`${id(23)}.json`),JSON.stringify({version:1,scope:'wrong',operationId:id(23),kind:'revoke'})+'\n');
 await assert.rejects(store.list(),/Invalid local owner grant operation record/u);
});

test('denied member read and --grant direct inspect render their own reasons; no owner session is ended',async()=>{
 const h=await harness(r=>{if(route(r)==='observers')throw http(403);throw Error(r.path);});
 await h.wait(/Share a session/u);await h.press('\r',/Not done - denied/u);assert.match(h.last(),/collaboration:manage/u);
 h.key('\x03');await h.done;
 const direct=await harness(r=>{if(route(r)==='inspect')return revoking;throw Error(r.path);},{initialGrantId:active.grant_id});
 await direct.wait(/Revocation requested, not yet effective/u);assert.equal(direct.requests[0].path,`/v1/collaboration/2/observe-grants/${active.grant_id}/inspect`);
 direct.key('\x03');await direct.done;assert.equal(direct.restored,1);
 const wrong=await harness(r=>{if(route(r)==='inspect')return{...revoking,grant_id:id(4)};throw Error(r.path);},{initialGrantId:active.grant_id});
 await wrong.wait(/Not done - identity mismatch/u);wrong.key('\x03');await wrong.done;
});

test('share preflight rejects non-TTY, JSON, invalid Project and invalid grant before credentials; help is discoverable',async()=>{
 let reads=0;const platform={kind:'linux',paths:{configDirectory:'/cfg',stateDirectory:'/state',runtimeDirectory:'/run'},async readSafeConfig(){reads++;throw Error('must not read configuration');}};
 for(const argv of [['share','--project',project],['share','--project',project,'--json'],['share','--project','invalid'],['share','--project',project,'--grant','nope'],['share','extra','--project',project]]){const s=memoryStreams();assert.notEqual(await runCli(argv,{streams:s.streams,platform}),0,argv.join(' '));}
 assert.equal(reads,0);const s=memoryStreams();assert.equal(await runCli(['share','--help'],{streams:s.streams,platform}),0);assert.match(s.stdout(),/share --project PROJECT_ID \[--grant GRANT_ID\]/u);assert.match(s.stdout(),/read-only/u);assert.match(s.stdout(),/keyboard control/u);
 const all=memoryStreams();assert.equal(await runCli(['help','--all'],{streams:all.streams,platform}),0);assert.match(all.stdout(),/\[routed\] share :: cuna share --project PROJECT_ID/u);
});
