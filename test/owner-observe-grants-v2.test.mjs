import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {ownerObserveGrantsApi,decodeOwnerGrant,decodeProjectObserverPage,describeGrantState,classifyTransportFailure,audienceRefusalCanResend,OwnerGrantError} from '../dist/api/owner-observe-grants-v2.js';
import {ownerObserveGrantSchemas,ownerObserveGrantOperations} from '../dist/api/owner-observe-grants-v2-schema.js';
import {runOwnerGrantsScreen} from '../dist/runtime/owner-grants-screen.js';
import {ownerGrantOperationStore,audienceFactRank,audienceFactIsOlder,audienceFactSameRun} from '../dist/runtime/owner-grant-operations.js';
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
 assert.deepEqual(Object.keys(ownerObserveGrantOperations).sort(),['createSessionObserveGrantV2','inspectSessionObserveGrantV2','listProjectObserversV2','prepareSessionAudienceV2','readSessionAudienceStateV2','revokeSessionObserveGrantV2']);
 // The reading is projected beside the transition: an owner who can change the
 // audience and cannot read it has no way out of a lost acknowledgement.
 assert.equal(ownerObserveGrantOperations.readSessionAudienceStateV2.path,'/v1/collaboration/2/agent-sessions/{id}/audience-state');
 assert.equal(ownerObserveGrantSchemas.ObservedSessionAudienceStateV2.properties.action.const,'observe');
 // Both actions of the canonical enum are projected. Shipping only `publish`
 // would give an owner a way to start disclosing a terminal and no way to stop.
 assert.deepEqual(ownerObserveGrantSchemas.PrepareSessionAudienceV2Request.properties.action.enum,['publish','private']);
 assert.equal(ownerObserveGrantOperations.prepareSessionAudienceV2.path,'/v1/collaboration/2/agent-sessions/{id}/audience');
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
 // Sharing is a separate decision from granting, and the disclosure points at
 // the key that makes it rather than at another product.
 assert.match(screen,/That is a separate decision: press s on the session list/u);
 assert.doesNotMatch(screen,/web app/u);
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

/**
 * Publication, the other half of the same decision.
 *
 * `resolve_collab_v2_observer_admission` (0183) admits nobody unless the
 * session's latest audience result is `public`, so these tests are about the
 * authority that makes a grant mean anything -- and about the fact that it is a
 * SEPARATE authority, never a side effect of granting one.
 */
// One request_id per operation, as `issue_collab_v2_session_audience_request`
// mints it. Reusing one across distinct operations -- as this helper did until
// the acceptance review -- is not something the producer can do, and it hid the
// only identity the client can order its own answers by.
const audienceReceipt=(action,generation,patch={})=>{
 const response={type:'session_audience_response_v2',version:'2',request_id:randomUUID(),action,agent_session_id:session,session_incarnation:id(6),process_epoch:id(71),runtime_lease_id:id(72),logical_terminal_id:id(13),process_start_identity:'4242',expected_generation:String(generation),
  result:action==='publish'
   ? {status:'observed',state:'public',stream_id:id(73),generation:String(generation+1),first_sequence:'1'}
   : {status:'observed',state:'private',generation:String(generation)}};
 return{state:'observed',response:{...response,...patch,...(patch.result?{result:{...response.result,...patch.result}}:{})}};
};
const audienceProblem=(code,status=503)=>new CunaError({code:status>=500?'cuna.network.service_unavailable':'cuna.remote.rejected',message:'x',exitCode:status>=500?EXIT_CODES.network:EXIT_CODES.remote,details:{http_status:status,reason:code}});

test('publication sends the canonical body for both actions and binds the receipt to this session, this run and the transition asked for',async()=>{
 const requests=[];const api=ownerObserveGrantsApi({request:async r=>{requests.push(r);return audienceReceipt(r.body.action,r.body.action==='publish'?4:5);}},owner,project);
 const started=await api.setAudience({agentSessionId:session,action:'publish',sessionIncarnation:id(6)},id(7),signal);
 assert.equal(requests[0].path,`/v1/collaboration/2/agent-sessions/${session}/audience`);
 assert.deepEqual(requests[0].body,{version:'2',operation_id:id(7),action:'publish'});
 assert.equal(started.state,'public');assert.equal(started.generation,'5');assert.equal(started.firstSequence,'1');assert.equal(started.streamId,id(73));
 const stopped=await api.setAudience({agentSessionId:session,action:'private'},id(8),signal);
 assert.equal(stopped.state,'private');assert.equal(stopped.generation,'5');assert.equal(stopped.streamId,undefined);
 assert.deepEqual(requests[1].body,{version:'2',operation_id:id(8),action:'private'});
 // Every way the answer can be about something other than what was asked.
 const cases=[
  [audienceReceipt('publish',4,{agent_session_id:other}),'identity_mismatch','another session'],
  [audienceReceipt('publish',4,{session_incarnation:id(14)}),'identity_mismatch','another run of this session'],
  [audienceReceipt('private',4),'identity_mismatch','the other action'],
  [audienceReceipt('publish',4,{result:{generation:'4'}}),'identity_mismatch','a generation that did not move'],
  [audienceReceipt('publish',4,{result:{generation:'6'}}),'identity_mismatch','a generation that moved twice'],
  [audienceReceipt('publish',4,{result:{first_sequence:'0'}}),'malformed_receipt','a stream that does not start at one'],
  [audienceReceipt('publish',4,{result:{stream_id:'not-a-uuid'}}),'malformed_receipt','an unusable stream identity'],
  [{state:'observed',response:{...audienceReceipt('publish',4).response,extra:1}},'malformed_receipt','a field the contract does not have'],
  [{state:'prepared',response:audienceReceipt('publish',4).response},'malformed_receipt','a state the contract does not have'],
 ];
 for(const [answer,kind,what] of cases){
  const bad=ownerObserveGrantsApi({request:async()=>answer},owner,project);
  await assert.rejects(bad.setAudience({agentSessionId:session,action:'publish',sessionIncarnation:id(6)},id(7),signal),error=>error instanceof OwnerGrantError&&error.kind===kind,what);
 }
 // A publish answered with `private` is a contradiction, not a mismatch.
 const contradiction=ownerObserveGrantsApi({request:async()=>({state:'observed',response:{...audienceReceipt('private',4).response,action:'publish'}})},owner,project);
 await assert.rejects(contradiction.setAudience({agentSessionId:session,action:'publish'},id(7),signal),e=>e.kind==='malformed_receipt'&&/opposite state/u.test(e.message));
});

test('a sharing receipt older than one already confirmed is refused, per run of the session',async()=>{
 let answer=audienceReceipt('publish',4);
 const api=ownerObserveGrantsApi({request:async()=>answer},owner,project);
 assert.equal((await api.setAudience({agentSessionId:session,action:'publish'},id(7),signal)).generation,'5');
 answer=audienceReceipt('private',2);
 await assert.rejects(api.setAudience({agentSessionId:session,action:'private'},id(8),signal),e=>e.kind==='stale_revision'&&/older sharing state than one already confirmed/u.test(e.message));
 // Same generation is not stale: a return to private stays on the one it was issued against.
 answer=audienceReceipt('private',5);
 assert.equal((await api.setAudience({agentSessionId:session,action:'private'},id(9),signal)).state,'private');
 // A different run of the same session counts separately; a restart resets the producer's counter.
 answer=audienceReceipt('publish',0,{session_incarnation:id(15)});
 assert.equal((await api.setAudience({agentSessionId:session,action:'publish'},id(10),signal)).generation,'1');
});

/**
 * Where `coordinateSessionAudienceV2` gives up decides whether anything could
 * have changed. `invalid_scope`, `request_unavailable` and `request_expired`
 * return before `registry.controlSessionAudienceV2` is called; the other three
 * are raised at or after the moment the session was asked.
 */
test('every publication refusal is mapped to whether the session was asked, with a distinguishable reason',async()=>{
 // The five that are settled because the session was asked NOTHING may say so.
 const askedNothing=['audience_request_invalid','audience_runtime_unavailable','audience_invalid_scope','audience_request_unavailable','audience_request_expired'];
 const settled=[...askedNothing,'audience_producer_unavailable'];
 const uncertain=['audience_transport_unavailable','audience_response_unavailable','audience_receipt_unavailable'];
 const rendered=new Set();
 for(const code of settled){
  const error=classifyTransportFailure(audienceProblem(code,code==='audience_request_invalid'?422:503),true,'audience');
  assert.equal(error.effectUnknown,false,code);assert.equal(error.kind,'unavailable',code);
  if(askedNothing.includes(code))assert.match(error.message,/nothing about sharing changed/u,code);
  rendered.add(error.message);
 }
 // `producer_unavailable` is the one settled refusal where the session WAS asked
 // and Cuna recorded an answer. `consume_collab_v2_session_audience_response`
 // retires pending observer attachments and closes active observer endpoints for
 // any recorded result, and the Edge collapses the session's own reason, so
 // claiming nothing changed is a claim the CLI cannot support.
 const refused=classifyTransportFailure(audienceProblem('audience_producer_unavailable'),true,'audience');
 assert.doesNotMatch(refused.message,/nothing about sharing changed/u,'a recorded refusal is not proof that nothing changed');
 assert.match(refused.message,/the change you asked for was not applied/u);
 assert.match(refused.message,/disconnects anyone currently watching/u);
 for(const code of uncertain){
  const error=classifyTransportFailure(audienceProblem(code),true,'audience');
  assert.equal(error.effectUnknown,true,code);assert.equal(error.kind,'uncertain',code);
  assert.doesNotMatch(error.message,/nothing about sharing changed/u,code);
  rendered.add(error.message);
 }
 assert.equal(rendered.size,settled.length+uncertain.length,'different causes must not render identically');
 // A session this account does not own is a 404 from `get_agent_session`, and it
 // is not one of the grant route's collaboration codes.
 const missing=classifyTransportFailure(http(404,'resource_not_found'),true,'audience');
 assert.equal(missing.kind,'not_found');assert.equal(missing.effectUnknown,false);
 assert.match(missing.message,/does not know this session/u);
 assert.doesNotMatch(missing.message,/observer at the membership revision/u,'the grant route\'s meanings may not leak onto this one');
 // A lost answer is uncertain here exactly as it is for a grant.
 assert.equal(classifyTransportFailure(new TypeError('fetch failed'),true,'audience').kind,'uncertain');
});

/**
 * A refusal of a re-raise describes the re-raise. Every refusal that is settled
 * on a first dispatch only because the session was asked nothing therefore says
 * nothing about the attempt being replayed, and settling it would destroy the
 * only identity that could ever finish that attempt.
 */
test('no refusal settles a replay unless it proves the replayed attempt did nothing',async()=>{
 const codes=['audience_invalid_scope','audience_request_unavailable','audience_producer_unavailable','audience_request_expired'];
 for(const code of codes){
  const api=ownerObserveGrantsApi({request:async()=>{throw audienceProblem(code);}},owner,project);
  const first=await api.setAudience({agentSessionId:session,action:'publish'},id(7),signal).catch(e=>e);
  assert.equal(first.effectUnknown,false,`${code} must settle a first dispatch`);
  const replay=await api.setAudience({agentSessionId:session,action:'publish',replay:true},id(7),signal).catch(e=>e);
  assert.equal(replay.effectUnknown,true,`${code} must NOT settle a replay`);
  assert.notEqual(replay.message,first.message,`${code} must not read identically on a replay`);
  assert.match(replay.message,/still unknown|earlier attempt/u,code);
 }
 // The two the producer has closed the door on cannot be resent; the other two can.
 assert.equal(audienceRefusalCanResend('audience_request_expired'),false);
 assert.equal(audienceRefusalCanResend('audience_producer_unavailable'),false);
 assert.equal(audienceRefusalCanResend('audience_request_unavailable'),true);
 assert.equal(audienceRefusalCanResend('audience_invalid_scope'),true);
 assert.equal(audienceRefusalCanResend(undefined),true,'an unnamed reason closes no door');
 const expired=await ownerObserveGrantsApi({request:async()=>{throw audienceProblem('audience_request_expired');}},owner,project)
  .setAudience({agentSessionId:session,action:'publish',replay:true},id(7),signal).catch(e=>e);
 assert.match(expired.message,/can no longer be sent/u);
 const recorded=await ownerObserveGrantsApi({request:async()=>{throw audienceProblem('audience_producer_unavailable');}},owner,project)
  .setAudience({agentSessionId:session,action:'publish',replay:true},id(7),signal).catch(e=>e);
 assert.match(recorded.message,/cannot settle it, because Cuna has now recorded an answer for it/u);
});

/**
 * The case the original delivery had no witness for, and the one the PRD called
 * decisive: an answer to a request that a later confirmed decision has already
 * replaced must never read as the session's current state. The generation cannot
 * order these -- a publish TO G and a private AT G carry the same number -- so
 * the ordering is this client's own record of which requests it has had answered.
 */
test('a stored publish answered again after a confirmed private is labelled history, never current state',async()=>{
 const published=audienceReceipt('publish',0),madePrivate=audienceReceipt('private',1);
 let answer=published;
 const api=ownerObserveGrantsApi({request:async()=>answer},owner,project);
 const p=await api.setAudience({agentSessionId:session,action:'publish'},id(7),signal);
 assert.equal(p.state,'public');assert.equal(p.supersededBy,undefined);
 answer=madePrivate;
 const q=await api.setAudience({agentSessionId:session,action:'private'},id(8),signal);
 assert.equal(q.state,'private');assert.equal(q.generation,p.generation,'the two carry the SAME generation: it cannot order them');
 assert.equal(q.supersededBy,undefined);
 // The producer replays the stored answer to the publish, unchanged. It is
 // refused, not returned: an answer that cannot describe the session now must
 // never reach a screen, and the refusal names what replaced it.
 answer=published;
 const replayed=await api.setAudience({agentSessionId:session,action:'publish',replay:true},id(7),signal).catch(e=>e);
 assert.ok(replayed instanceof OwnerGrantError,'a superseded answer is refused, not returned');
 assert.equal(replayed.kind,'stale_revision');
 assert.equal(replayed.state,undefined,'nothing state-bearing comes back');
 assert.match(replayed.message,/the answer it already gave to an earlier request, which started live sharing/u);
 assert.match(replayed.message,/you asked Cuna to stop live sharing, and Cuna confirmed it/u);
 assert.match(replayed.message,/it cannot say how the session is shared now/u);
 assert.equal(published.response.request_id,p.requestId,'the request identity is what makes this knowable');
 // The same request answered two different ways is a contradiction, not a decision.
 answer={state:'observed',response:{...published.response,result:{...published.response.result,stream_id:id(74)}}};
 await assert.rejects(api.setAudience({agentSessionId:session,action:'publish',replay:true},id(7),signal),
  e=>e.kind==='malformed_receipt'&&/two different ways/u.test(e.message));
 // A request never seen before is a new decision, superseded by nothing.
 answer=audienceReceipt('publish',1);
 const fresh=await api.setAudience({agentSessionId:session,action:'publish'},id(9),signal);
 assert.equal(fresh.supersededBy,undefined);assert.equal(fresh.state,'public');
});

test('sharing is started and stopped explicitly, and granting never starts it',async()=>{
 const answers={publish:audienceReceipt('publish',0),private:audienceReceipt('private',1)};
 const h=await harness(r=>{if(route(r)==='observers')return memberPage;if(route(r)==='observe-grants')return active;if(route(r)==='audience')return answers[r.body.action];throw Error(r.path);});
 await h.wait(/Share a session - read-only observation/u);
 assert.match(h.last(),/s starts sharing this session live; e stops it/u,'the actions are discoverable where a session is selected');
 assert.match(h.last(),/two separate decisions/u);
 // Creating a grant sends nothing to the publication route.
 await h.press('\r',/Choose the member/u);await h.press('\r',/Press 1, 2 or 3/u);await h.press('1',/Observation grant ba600000 - Active/u);
 assert.equal(h.requests.filter(r=>route(r)==='audience').length,0,'a grant never publishes');
 assert.match(h.last(),/Watching also needs this session to be shared live/u);
 // The confirmation states what publishing discloses, and sends nothing.
 await h.press('s',/Share this session's screen live\?/u);
 const confirm=h.last();
 assert.match(confirm,/box \/ claude-live/u,'the confirmation names the session it will share');
 assert.match(confirm,/whatever is on the screen now, and everything printed from now on/u);
 assert.match(confirm,/Nothing from before is replayed to them: no scrollback, no earlier output/u);
 assert.match(confirm,/a token, a login code, a file it opens/u);
 assert.match(confirm,/cannot recall what was already sent/u);
 assert.match(confirm,/never type, resize or send a signal/u);
 assert.match(confirm,/creates no grant/u);
 assert.equal(h.requests.filter(r=>route(r)==='audience').length,0,'the disclosure precedes the request');
 await h.press('n',/Observation grant ba600000 - Active/u);
 assert.equal(h.requests.filter(r=>route(r)==='audience').length,0,'any key but y cancels and sends nothing');
 await h.press('s',/Share this session's screen live\?/u);
 await h.press('y',/Live sharing started - Cuna confirmed it/u);
 const receipt=h.requests.filter(r=>route(r)==='audience');
 assert.equal(receipt.length,1);assert.equal(receipt[0].body.action,'publish');
 // CUNA-COL-016-R4's starting point, named from the receipt rather than promised.
 assert.match(h.last(),/Share {5}#1 of this run of the session/u);
 assert.match(h.last(),/the first thing anyone sees is the screen as it is now/u);
 assert.match(h.last(),/Nothing printed before this moment is sent to them/u);
 assert.match(h.last(),/grants no keyboard, resize or signal/u);
 assert.match(h.last(),/if Cuna's own checks also allow it/u,'publication does not override the provider or grant checks');
 // Stopping is a separate confirmed decision, and its confirmation is bound to
 // the fencing receipt rather than to the keypress.
 await h.press('e',/Stop sharing this session live\?/u);
 assert.match(h.last(),/revokes nothing and expires nothing/u);
 // Declining returns to the receipt that was being read, not to the list.
 await h.press('n',/Live sharing started - Cuna confirmed it/u);
 assert.equal(h.requests.filter(r=>route(r)==='audience').length,1,'declining sends nothing');
 await h.press('e',/Stop sharing this session live\?/u);
 await h.press('y',/Live sharing stopped - Cuna confirmed it/u);
 assert.match(h.last(),/Cuna confirmed with the session itself that its output is fenced/u);
 assert.match(h.last(),/What was already sent cannot be recalled/u);
 assert.equal(h.requests.filter(r=>route(r)==='audience').length,2);
 assert.equal(h.requests.filter(r=>route(r)==='audience').at(-1).body.action,'private');
 assert.notEqual(h.requests.filter(r=>route(r)==='audience')[0].body.operation_id,h.requests.filter(r=>route(r)==='audience')[1].body.operation_id,'each decision has its own identity');
 assert.deepEqual(await h.records(),[],'both answers settled their records');
 h.key('\x03');await h.done;assert.equal(h.restored,1);
});

/**
 * The rendering half of the supersession backstop.
 *
 * Through the shipped producer this branch is unreachable: a replay only exists
 * for an UNSETTLED operation, whose first answer was never seen, and the
 * supervisor re-validates live state before serving its journal. So the fixture
 * here models a producer ANOMALY -- Cuna answering a new sharing request with an
 * answer it already gave -- which is exactly what a backstop is for. What the
 * screen must never do is render it as the session's current state.
 */
test('an answer Cuna has already given never reaches the screen as the session being shared now',async()=>{
 const published=audienceReceipt('publish',0);
 const answers={publish:published,private:audienceReceipt('private',1)};
 let repeat=false;
 const h=await harness(r=>{if(route(r)==='observers')return memberPage;
  if(route(r)==='audience'){if(r.body.action==='publish'&&repeat)return published;if(r.body.action==='publish')repeat=true;return answers[r.body.action];}
  throw Error(r.path);});
 await h.wait(/Share a session/u);
 await h.press('s',/Share this session's screen live\?/u);
 await h.press('y',/Live sharing started - Cuna confirmed it/u);
 await h.press('e',/Stop sharing this session live\?/u);
 await h.press('y',/Live sharing stopped - Cuna confirmed it/u);
 // A second, genuinely new publish request, which Cuna answers with the answer
 // it already gave to the first one.
 await h.press('s',/Share this session's screen live\?/u);
 await h.press('y',/Not done - stale revision/u);
 assert.match(h.last(),/the answer it already gave to an earlier request, which started live sharing/u);
 assert.match(h.last(),/you asked Cuna to stop live sharing, and Cuna confirmed it/u);
 assert.match(h.last(),/it cannot say how the session is shared now/u);
 assert.doesNotMatch(h.last(),/Live sharing started - Cuna confirmed it/u,'a superseded answer must never read as a confirmed publication');
 assert.doesNotMatch(h.last(),/Watching starts here/u);
 assert.match(h.last(),/This attempt applied nothing/u,'the re-raise applied nothing, which is what it settles');
 assert.deepEqual(await h.records(),[],'and the operation it belongs to is settled');
 h.key('\x03');await h.done;
});

test('an unconfirmed publication keeps its identity, resends only that identity, and never blocks stopping',async()=>{
 let lost=true;const bodies=[];
 const h=await harness(r=>{if(route(r)==='observers')return memberPage;
  if(route(r)==='audience'){bodies.push(r.body);if(r.body.action==='publish'&&lost){lost=false;throw new TypeError('fetch failed');}return audienceReceipt(r.body.action,r.body.action==='publish'?0:1);}
  throw Error(r.path);});
 await h.wait(/Share a session/u);
 await h.press('s',/Share this session's screen live\?/u);
 await h.press('y',/Unresolved change - outcome unknown/u);
 assert.match(h.last(),/> share +operation/u);
 assert.match(h.last(),/Cuna never confirmed this\. Press c to ask the session what it is sharing now/u);
 assert.match(h.last(),/asks the session about the same request rather than starting a second one/u);
 assert.match(h.last(),/Press c to ask the session what it is sharing now and what this exact request is recorded to have done/u);
 assert.match(h.last(),/press e: stopping never depends on this answer/u);
 assert.match(h.last(),/c asks what the session is sharing now; e stops live sharing now/u);
 const kept=await h.records();
 assert.equal(kept.length,1);assert.equal(kept[0].kind,'audience');assert.equal(kept[0].action,'publish');
 assert.equal(kept[0].operationId,bodies[0].operation_id);
 assert.deepEqual(Object.keys(kept[0]).sort(),['action','agentSessionId','kind','operationId','scope','version'],'no member, no stream, no secret is persisted');
 // Stopping is allowed while that stays unresolved: it only removes access.
 await h.press('e',/Stop sharing this session live\?/u);
 await h.press('y',/Live sharing stopped - Cuna confirmed it/u);
 assert.equal(bodies.length,2);assert.equal(bodies[1].action,'private');
 assert.notEqual(bodies[1].operation_id,bodies[0].operation_id,'stopping is its own operation, not a replay of the other one');
 const still=await h.records();
 assert.equal(still.length,1,'the unconfirmed publication is still unresolved');
 assert.equal(still[0].operationId,bodies[0].operation_id);
 assert.match(h.last(),/1 earlier change has an unknown outcome/u);
 // Starting a NEW publication is still refused while it is unresolved.
 await h.press('p',/Unresolved change - outcome unknown/u);
 await h.press('b',/Share a session/u);
 await h.press('s',/Cannot start live sharing while an earlier change has an unknown outcome/u);
 assert.equal(bodies.length,2,'nothing left the client');
 // Replaying settles it, under the same identity and the same action.
 await h.press('r',/Live sharing started - Cuna confirmed it/u);
 assert.equal(bodies.length,3);
 assert.equal(bodies[2].operation_id,bodies[0].operation_id,'the replay reuses the exact identity');
 assert.equal(bodies[2].action,'publish','and the exact action: the producer refuses one identity used for two actions');
 assert.deepEqual(await h.records(),[]);
 h.key('\x03');await h.done;
});

test('an unconfirmed publication survives an exit, and forgetting it names what it cannot undo',async()=>{
 const first=await harness(r=>{if(route(r)==='audience')throw new TypeError('fetch failed');throw Error(r.path);});
 await first.wait(/Share a session/u);
 await first.press('s',/Share this session's screen live\?/u);
 await first.press('y',/Unresolved change - outcome unknown/u);
 const stuck=(await first.records())[0].operationId;
 first.key('\x03');await first.done;
 // A new process on the same state directory opens on that exact operation.
 const second=await harness(r=>{if(route(r)==='observers')return memberPage;if(route(r)==='audience')return audienceReceipt(r.body.action,0);throw Error(r.path);},{},first.context);
 await second.wait(/Unresolved change - outcome unknown/u);
 assert.match(second.last(),new RegExp(`operation ${stuck}`,'u'));
 assert.doesNotMatch(second.last(),/Share a session - read-only/u,'recovery precedes the normal entry screen');
 await second.press('d',/Forget this local record\?/u);
 assert.match(second.last(),/Start of live sharing operation/u);
 assert.match(second.last(),/Cuna is not contacted and nothing is revoked/u);
 assert.match(second.last(),/The outcome of that request stays unknown/u);
 assert.match(second.last(),/Asking what the session is sharing now does not need it and answers what the session is doing/u);
 assert.match(second.last(),/stopping the sharing does not need it either and is the only way to be sure/u);
 await second.press('y',/Local record forgotten - nothing was revoked/u);
 assert.match(second.last(),/Asking what the session is sharing now, and stopping live sharing, are both still available/u);
 assert.deepEqual(await second.records(),[]);
 second.key('\x03');await second.done;
});

test('a settled publication refusal renders its reason and its operation identity',async()=>{
 const h=await harness(r=>{if(route(r)==='observers')return memberPage;if(route(r)==='audience')throw audienceProblem('audience_runtime_unavailable');throw Error(r.path);});
 await h.wait(/Share a session/u);
 await h.press('s',/Share this session's screen live\?/u);
 await h.press('y',/Not done - unavailable/u);
 assert.match(h.last(),/not connected to Cuna right now/u);
 assert.match(h.last(),/This attempt applied nothing/u);
 assert.match(h.last(),/\(start of live sharing\) is settled/u);
 assert.doesNotMatch(h.last(),/r rereads the members/u,'a sharing refusal is not a membership problem');
 assert.deepEqual(await h.records(),[],'a refusal the server issued without asking the session drops the record');
 h.key('\x03');await h.done;
});

test('share preflight rejects non-TTY, JSON, invalid Project and invalid grant before credentials; help is discoverable',async()=>{
 let reads=0;const platform={kind:'linux',paths:{configDirectory:'/cfg',stateDirectory:'/state',runtimeDirectory:'/run'},async readSafeConfig(){reads++;throw Error('must not read configuration');}};
 for(const argv of [['share','--project',project],['share','--project',project,'--json'],['share','--project','invalid'],['share','--project',project,'--grant','nope'],['share','extra','--project',project]]){const s=memoryStreams();assert.notEqual(await runCli(argv,{streams:s.streams,platform}),0,argv.join(' '));}
 assert.equal(reads,0);const s=memoryStreams();assert.equal(await runCli(['share','--help'],{streams:s.streams,platform}),0);assert.match(s.stdout(),/share --project PROJECT_ID \[--grant GRANT_ID\]/u);assert.match(s.stdout(),/read-only/u);assert.match(s.stdout(),/keyboard control/u);
 const all=memoryStreams();assert.equal(await runCli(['help','--all'],{streams:all.streams,platform}),0);assert.match(all.stdout(),/\[routed\] share :: cuna share --project PROJECT_ID/u);
});

/* ---- Asking what the session is sharing now: CUNA-COL-024-R3 recovery ---- */
const reading=(result={status:'observed',state:'private',generation:'4'},patch={})=>({state:'reconciled',
 current:{type:'session_audience_response_v2',version:'2',request_id:id(21),action:'observe',agent_session_id:session,session_incarnation:id(6),process_epoch:id(71),runtime_lease_id:id(72),logical_terminal_id:id(13),process_start_identity:'123',expected_generation:'4',result,...patch}});
const recordedPublish={type:'session_audience_response_v2',version:'2',request_id:id(22),action:'publish',agent_session_id:session,session_incarnation:id(6),process_epoch:id(71),runtime_lease_id:id(72),logical_terminal_id:id(13),process_start_identity:'123',expected_generation:'4',result:{status:'observed',state:'public',stream_id:id(23),generation:'5',first_sequence:'1'}};
const recordedRefusal={...recordedPublish,result:{status:'unavailable',reason:'audience_stale'}};
const historyRow=(status,patch={})=>({version:'2',kind:'session_audience_operation',operation_id:id(30),status,
 ...(status==='unknown'?{}:{agent_session_id:session,action:'publish',request_revision:'7',issued_at_ms:1757700000000,deadline_ms:1757700020000,response:null}),...patch});
const withHistory=(row,result)=>({...reading(result),operation:row});

test('a reading is a query: its own fresh identity, no stream, and a generation Cuna never recorded',async()=>{
 const requests=[];const api=ownerObserveGrantsApi({request:async r=>{requests.push(r);return reading();}},owner,project);
 const answer=await api.readAudience({agentSessionId:session,sessionIncarnation:id(6)},id(20),signal);
 assert.equal(requests[0].path,`/v1/collaboration/2/agent-sessions/${session}/audience-state`);
 assert.deepEqual(requests[0].body,{version:'2',operation_id:id(20)});
 assert.deepEqual(answer,{current:{agentSessionId:session,sessionIncarnation:id(6),processEpoch:id(71),logicalTerminalId:id(13),requestId:id(21),state:'private',generation:'4'}});
 assert.equal(answer.operation,undefined,'no earlier change was named, so no history comes back');
 assert.equal(Object.hasOwn(answer.current,'firstSequence'),false,'a reading opens no stream');
 // The repaired case: the runtime is ahead of every generation Cuna recorded.
 const ahead=ownerObserveGrantsApi({request:async()=>reading({status:'observed',state:'public',stream_id:id(23),generation:'9'})},owner,project);
 const shared=await ahead.readAudience({agentSessionId:session},id(20),signal);
 assert.equal(shared.current.state,'public');assert.equal(shared.current.generation,'9');assert.equal(shared.current.streamId,id(23));
 await assert.rejects(api.readAudience({agentSessionId:session,reconcile:{operationId:id(20),action:'publish'}},id(20),signal),e=>e.kind==='identity_mismatch','a reading cannot name itself as the earlier change');
 assert.equal(requests.length,1,'a refused local precondition sends nothing');
});

test('a reading receipt must be about this session, this run and this question',async()=>{
 const cases=[
  [reading({status:'observed',state:'public',stream_id:id(23),generation:'9',first_sequence:'1'}),'malformed_receipt'],
  [reading({status:'observed',state:'public',stream_id:id(23),generation:'0'}),'malformed_receipt'],
  [reading(undefined,{action:'publish'}),'malformed_receipt'],
  [reading(undefined,{agent_session_id:other}),'identity_mismatch'],
  [{state:'observed',current:reading().current},'malformed_receipt'],
 ];
 for(const [answer,kind] of cases){
  const api=ownerObserveGrantsApi({request:async()=>answer},owner,project);
  await assert.rejects(api.readAudience({agentSessionId:session},id(20),signal),e=>e instanceof OwnerGrantError&&e.kind===kind,JSON.stringify(answer).slice(0,120));
 }
 const run=ownerObserveGrantsApi({request:async()=>reading(undefined,{session_incarnation:id(96)})},owner,project);
 await assert.rejects(run.readAudience({agentSessionId:session,sessionIncarnation:id(6)},id(20),signal),e=>e.kind==='identity_mismatch');
 // With no run known, whatever the server names is the run.
 assert.equal((await run.readAudience({agentSessionId:session},id(20),signal)).current.sessionIncarnation,id(96));
});

test('history is decoded as itself and never merged with the reading beside it',async()=>{
 const ask=answer=>ownerObserveGrantsApi({request:async()=>answer},owner,project)
  .readAudience({agentSessionId:session,reconcile:{operationId:id(30),action:'publish'}},id(20),signal);
 assert.deepEqual((await ask(withHistory(historyRow('unknown')))).operation,{status:'unknown',operationId:id(30)});
 assert.deepEqual((await ask(withHistory(historyRow('pending')))).operation,{status:'pending',operationId:id(30),action:'publish',requestRevision:'7'});
 assert.deepEqual((await ask(withHistory(historyRow('expired_unrecorded')))).operation,{status:'expired_unrecorded',operationId:id(30),action:'publish',requestRevision:'7'});
 // A recorded publish beside a private reading is the case this route exists
 // for. Neither answer is adjusted to agree with the other.
 const recorded=await ask(withHistory(historyRow('recorded',{response:recordedPublish})));
 assert.deepEqual(recorded.operation.outcome,{kind:'observed',state:'public',generation:'5',streamId:id(23)});
 assert.equal(recorded.current.state,'private');assert.equal(recorded.current.generation,'4');
 // A recorded REFUSAL is a durable answer that names no audience state at all.
 const refused=await ask(withHistory(historyRow('recorded',{response:recordedRefusal})));
 assert.deepEqual(refused.operation.outcome,{kind:'refused'});
 assert.equal(refused.current.state,'private');
});

test('a history half that answers a different question is refused',async()=>{
 const ask=(answer,reconcile={operationId:id(30),action:'publish'})=>ownerObserveGrantsApi({request:async()=>answer},owner,project)
  .readAudience({agentSessionId:session,...(reconcile===null?{}:{reconcile})},id(20),signal);
 for(const [answer,kind] of [
  [withHistory(historyRow('recorded')),'malformed_receipt'],
  [withHistory(historyRow('pending',{response:recordedPublish})),'malformed_receipt'],
  [withHistory(historyRow('unknown',{agent_session_id:session,action:'publish',request_revision:'7',issued_at_ms:1,deadline_ms:2,response:null})),'malformed_receipt'],
  [withHistory(historyRow('recorded',{response:recordedPublish,operation_id:id(31)})),'identity_mismatch'],
  [withHistory(historyRow('recorded',{response:recordedPublish,agent_session_id:other})),'identity_mismatch'],
  [withHistory(historyRow('recorded',{response:recordedPublish,action:'private'})),'identity_mismatch'],
  [reading(),'malformed_receipt'],
 ])await assert.rejects(ask(answer),e=>e instanceof OwnerGrantError&&e.kind===kind,JSON.stringify(answer).slice(0,140));
 await assert.rejects(ask(withHistory(historyRow('unknown')),null),e=>e.kind==='malformed_receipt','history nobody asked for is refused too');
});

test('a reading older than what this client already confirmed is refused, and it supersedes a journaled replay',async()=>{
 // One stored receipt, returned unchanged on the replay: that is what the
 // producer does, and a fresh request_id would hide the repeat this asserts.
 const journaled=audienceReceipt('publish',4);let answer=journaled;
 const api=ownerObserveGrantsApi({request:async r=>r.path.endsWith('audience-state')?answer:journaled},owner,project);
 const confirmed=await api.setAudience({agentSessionId:session,action:'publish'},id(7),signal);
 assert.equal(confirmed.generation,'5');
 answer=reading({status:'observed',state:'private',generation:'4'});
 await assert.rejects(api.readAudience({agentSessionId:session},id(20),signal),e=>e.kind==='stale_revision');
 answer=reading({status:'observed',state:'private',generation:'5'});
 assert.equal((await api.readAudience({agentSessionId:session},id(21),signal)).current.generation,'5');
 // The reading is now the newest thing this client knows, so Cuna answering the
 // publish request again from its journal cannot describe the session now.
 await assert.rejects(api.setAudience({agentSessionId:session,action:'publish',replay:true},id(7),signal),
  e=>e.kind==='stale_revision'&&/Cuna has since read this session's current sharing state directly/u.test(e.message)&&/it says the session is not sharing live/u.test(e.message));
});

test('every refusal of a reading is settled for the reading and silent about every earlier change',async()=>{
 for(const reason of ['audience_request_invalid','audience_runtime_unavailable','audience_invalid_scope','audience_request_unavailable','audience_request_expired','audience_producer_unavailable','audience_transport_unavailable','audience_response_unavailable','audience_receipt_unavailable','audience_history_unavailable']){
  const error=classifyTransportFailure(http(503,reason),false,'audience-state');
  assert.equal(error.kind,'unavailable',reason);
  assert.equal(error.effectUnknown,false,reason);
  assert.doesNotMatch(error.message,/audience_/u,reason);
 }
 assert.match(classifyTransportFailure(http(503,'audience_transport_unavailable'),false,'audience-state').message,/Machine created before this question existed/u);
 // A lost answer to a query leaves nothing uncertain, unlike a lost mutation.
 const lost=classifyTransportFailure(new TypeError('fetch failed'),false,'audience-state');
 assert.equal(lost.kind,'unavailable');assert.equal(lost.effectUnknown,false);
 assert.equal(classifyTransportFailure(http(404,'resource_not_found'),false,'audience-state').kind,'not_found');
 const missing=new CunaError({code:'cuna.remote.operation_not_served',message:'x',exitCode:EXIT_CODES.remote,details:{http_status:404}});
 assert.match(classifyTransportFailure(missing,false,'audience-state').message,/does not serve the sharing-state question this build asks/u);
 // The publication route's own table is untouched by the reading's.
 assert.equal(classifyTransportFailure(http(503,'audience_transport_unavailable'),true,'audience').effectUnknown,true);
});

const readRoute=r=>r.path.endsWith('/audience-state');
test('the owner asks what a session is sharing, and the answer changes nothing',async()=>{
 const h=await harness(r=>{if(route(r)==='observers')return memberPage;if(readRoute(r))return reading({status:'observed',state:'public',stream_id:id(23),generation:'9'});throw Error(r.path);});
 await h.wait(/Share a session/u);
 await h.press('c',/When Cuna asked, this session was sharing live/u);
 assert.match(h.last(),/Share     #9 of this run of the session/u);
 assert.match(h.last(),/Cuna put the question to the session itself/u);
 assert.match(h.last(),/Asking changed nothing: it started no share, stopped none, created no grant and disconnected nobody/u);
 assert.equal(h.requests.length,1);
 assert.deepEqual(Object.keys(h.requests[0].body).sort(),['operation_id','version'],'nothing was named to reconcile');
 assert.deepEqual(await h.records(),[],'a query has no effect to recover, so it reserves nothing');
 h.key('\x03');await h.done;
});

test('a recorded answer settles the unconfirmed publication and a fresh decision is offered again',async()=>{
 const bodies=[];let lost=true;
 const h=await harness(r=>{
  if(route(r)==='observers')return memberPage;
  if(readRoute(r))return withHistory(historyRow('recorded',{operation_id:bodies[0].operation_id,response:recordedPublish}),{status:'observed',state:'private',generation:'5'});
  if(route(r)==='audience'){bodies.push(r.body);if(lost){lost=false;throw new TypeError('fetch failed');}return audienceReceipt(r.body.action,5);}
  throw Error(r.path);});
 await h.wait(/Share a session/u);
 await h.press('s',/Share this session's screen live\?/u);
 await h.press('y',/Unresolved change - outcome unknown/u);
 assert.equal((await h.records()).length,1);
 await h.press('c',/When Cuna asked, this session was not sharing live/u);
 const ask=h.requests.at(-1);
 assert.equal(ask.body.reconcile_operation_id,bodies[0].operation_id,'the question names the change that was left open');
 assert.notEqual(ask.body.operation_id,bodies[0].operation_id,'and never reuses that identity for itself');
 assert.match(h.last(),/the session started sharing at share #5/u);
 assert.match(h.last(),/That is what that one request did\. It is not what the session is doing now\./u);
 assert.match(h.last(),/Last share #5 of this run of the session/u);
 assert.match(h.last(),/Its local record was dropped/u);
 assert.deepEqual(await h.records(),[],'an answered request has nothing left to finish');
 assert.doesNotMatch(h.last(),/earlier change has an unknown outcome/u);
 // And a fresh decision is issued normally, with no restart and no block.
 await h.press('s',/Share this session's screen live\?/u);
 await h.press('y',/Live sharing started - Cuna confirmed it/u);
 assert.equal(bodies.length,2);
 assert.notEqual(bodies[1].operation_id,bodies[0].operation_id,'a fresh decision is a fresh identity');
 h.key('\x03');await h.done;
});

test('an expired unrecorded change stays unknown, stops being resendable and survives an exit',async()=>{
 const first=await harness(r=>{if(route(r)==='audience')throw new TypeError('fetch failed');throw Error(r.path);});
 await first.wait(/Share a session/u);
 await first.press('s',/Share this session's screen live\?/u);
 await first.press('y',/Unresolved change - outcome unknown/u);
 const stuck=(await first.records())[0].operationId;
 first.key('\x03');await first.done;
 // A new process on the same state directory recovers that exact operation and
 // can ask about it by name.
 const second=await harness(r=>{if(route(r)==='observers')return memberPage;
  if(readRoute(r))return withHistory(historyRow('expired_unrecorded',{operation_id:r.body.reconcile_operation_id}),{status:'observed',state:'public',stream_id:id(23),generation:'7'});
  throw Error(r.path);},{},first.context);
 await second.wait(/Unresolved change - outcome unknown/u);
 assert.match(second.last(),/Press c to ask the session what it is sharing now/u);
 await second.press('c',/When Cuna asked, this session was sharing live/u);
 assert.equal(second.requests.at(-1).body.reconcile_operation_id,stuck);
 assert.match(second.last(),/ran out of time with no answer recorded/u);
 assert.match(second.last(),/Whether it took effect is unknown, and it will stay unknown/u);
 assert.match(second.last(),/Share     #7 of this run of the session/u);
 assert.doesNotMatch(second.last(),/Its local record was dropped/u);
 const kept=await second.records();
 assert.equal(kept.length,1);assert.equal(kept[0].operationId,stuck,'only the owner removes a record no answer settled');
 // Resending it can no longer settle anything, and is no longer offered.
 await second.press('p',/Unresolved change - outcome unknown/u);
 assert.doesNotMatch(second.last(),/r resends this exact operation/u);
 assert.match(second.last(),/Cuna will not raise this request with the session again/u);
 assert.match(second.last(),/Asking what the session is sharing now still answers what the session is doing/u);
 second.key('\x03');await second.done;
});

test('a reading that does not answer leaves the unfinished change exactly as it was',async()=>{
 const h=await harness(r=>{if(route(r)==='observers')return memberPage;
  if(readRoute(r))throw audienceProblem('audience_transport_unavailable');
  if(route(r)==='audience')throw new TypeError('fetch failed');throw Error(r.path);});
 await h.wait(/Share a session/u);
 await h.press('s',/Share this session's screen live\?/u);
 await h.press('y',/Unresolved change - outcome unknown/u);
 const stuck=(await h.records())[0].operationId;
 await h.press('c',/Last reason/u);
 assert.match(h.last(),/Machine created before this question existed/u);
 assert.doesNotMatch(h.last(),/audience_transport_unavailable/u);
 assert.doesNotMatch(h.last(),/When Cuna asked, this session was (not )?sharing live/u,'a question that failed states no current state');
 assert.match(h.last(),/r resends this exact operation/u,'the only identity that can finish it is still offered');
 const kept=await h.records();
 assert.equal(kept.length,1);assert.equal(kept[0].operationId,stuck);
 h.key('\x03');await h.done;
});

test('an unknown operation is an answer: Cuna never issued it, so it changed nothing',async()=>{
 const h=await harness(r=>{if(route(r)==='observers')return memberPage;
  if(readRoute(r))return withHistory(historyRow('unknown',{operation_id:r.body.reconcile_operation_id}));
  if(route(r)==='audience')throw new TypeError('fetch failed');throw Error(r.path);});
 await h.wait(/Share a session/u);
 await h.press('s',/Share this session's screen live\?/u);
 await h.press('y',/Unresolved change - outcome unknown/u);
 await h.press('c',/When Cuna asked, this session was not sharing live/u);
 assert.match(h.last(),/Cuna has no record of the earlier start of live sharing/u);
 assert.match(h.last(),/It never reached the session, so it changed nothing/u);
 assert.deepEqual(await h.records(),[]);
 h.key('\x03');await h.done;
});

/* ---- F1: two processes on one state directory, from the acceptance review ---- */
/* A second `cuna share` on the same state directory is a genuinely separate
   store object over the same files, which is what two processes are. The
   reviewer's counterexamples are reproduced through the real screen, the real
   store and the real decoder; only the transport and the host are local. */
const siblingStore=context=>ownerGrantOperationStore(context.platform,{baseUrl:'https://api.getcuna.com',profile:'default',ownerPrincipalId:owner,projectId:project});
async function twoProcesses({answer,confirm}){
 let release;const held=new Promise(resolve=>{release=resolve;});
 const asker=await harness(async r=>{
  if(route(r)==='observers')return memberPage;
  if(readRoute(r)){await held;return answer;}
  throw Error(r.path);});
 await asker.wait(/Share a session/u);
 // The question leaves, and its answer is still in flight.
 asker.key('c');await tick();
 const other=confirm===null?null:await harness(r=>{
  if(route(r)==='observers')return memberPage;
  if(route(r)==='audience')return confirm;
  throw Error(r.path);},{},{...asker.context,store:siblingStore(asker.context)});
 if(other!==null){
  await other.wait(/Share a session/u);
  await other.press(confirm.response.action==='publish'?'s':'e',/Share this session's screen live\?|Stop sharing this session live\?/u);
  await other.press('y',/Live sharing (started|stopped) - Cuna confirmed it/u);
 }
 release();
 return {asker,other};
}

test('F1 counterexample 1: a held answer of public@1 is not painted after another process confirmed private@1',async()=>{
 const {asker,other}=await twoProcesses({answer:reading({status:'observed',state:'public',stream_id:id(23),generation:'1'}),confirm:audienceReceipt('private',1)});
 await asker.wait(/Cuna answered about an earlier moment than this computer already knows about/u);
 // The exact sentence the review saw is gone, in the direction that matters.
 assert.doesNotMatch(asker.last(),/When Cuna asked, this session was sharing live/u,'a shared terminal must never be reported as this session\'s state from a stale answer');
 assert.doesNotMatch(asker.last(),/Share     #1 of this run/u);
 assert.match(asker.last(),/A sharing change confirmed on this computer: not sharing live, last share #1\./u);
 assert.match(asker.last(),/is not shown as this session's state/u);
 assert.match(asker.last(),/Press c to ask again|c asks again/u);
 asker.key('\x03');await asker.done;other.key('\x03');await other.done;
});

test('F1 counterexample 2: a held answer of private@1 is not painted after another process confirmed public@2',async()=>{
 const {asker,other}=await twoProcesses({answer:reading({status:'observed',state:'private',generation:'1'}),confirm:audienceReceipt('publish',1)});
 await asker.wait(/Cuna answered about an earlier moment than this computer already knows about/u);
 // This is the direction that tells an owner a shared terminal is private.
 assert.doesNotMatch(asker.last(),/When Cuna asked, this session was not sharing live/u);
 assert.match(asker.last(),/A sharing change confirmed on this computer: sharing live at share #2\./u);
 asker.key('\x03');await asker.done;other.key('\x03');await other.done;
});

test('F1 control: the same answer, with no other process, IS painted',async()=>{
 // Same instrument, same held answer, one variable flipped: nothing else
 // confirmed anything. If this did not paint, the two tests above would prove
 // nothing about ordering.
 const first=await twoProcesses({answer:reading({status:'observed',state:'public',stream_id:id(23),generation:'1'}),confirm:null});
 await first.asker.wait(/When Cuna asked, this session was sharing live/u);
 assert.match(first.asker.last(),/Share     #1 of this run of the session/u);
 assert.doesNotMatch(first.asker.last(),/earlier moment than this computer already knows/u);
 first.asker.key('\x03');await first.asker.done;
 const second=await twoProcesses({answer:reading({status:'observed',state:'private',generation:'1'}),confirm:null});
 await second.asker.wait(/When Cuna asked, this session was not sharing live/u);
 second.asker.key('\x03');await second.asker.done;
});

test('F1: a reading says what was true when it was answered, never what is true now',async()=>{
 const h=await harness(r=>{if(route(r)==='observers')return memberPage;if(readRoute(r))return reading();throw Error(r.path);});
 await h.wait(/Share a session/u);
 await h.press('c',/When Cuna asked, this session was not sharing live/u);
 assert.match(h.last(),/not a promise about now: any window signed in to this account can change it at any moment/u);
 assert.match(h.last(),/This computer can only compare an answer against sharing changes made on this computer/u);
 assert.doesNotMatch(h.last(),/right now/u,'no screen may promise the present tense for an observation');
 h.key('\x03');await h.done;
});

test('F1: an answer this computer already knows is out of date never becomes the newest thing it knows',async()=>{
 const store=(await newStore());
 const fact={kind:'transition',agentSessionId:session,sessionIncarnation:id(6),processEpoch:id(71),state:'private',generation:'4'};
 const recorded=await store.store.recordAudienceFact(fact);
 assert.equal(recorded.generation,'4');assert.equal(recorded.state,'private');
 // An older moment of the same run is not written over the newer one.
 const older=await store.store.recordAudienceFact({...fact,kind:'reading',state:'public',generation:'4'});
 assert.equal(older.state,'private','public@4 came before private@4, so it cannot replace it');
 assert.equal((await store.store.readAudienceFact(session)).state,'private');
 // A later moment is.
 const newer=await store.store.recordAudienceFact({...fact,kind:'reading',state:'public',generation:'5'});
 assert.equal(newer.generation,'5');assert.equal(newer.state,'public');
 // A different run cannot be ordered against this one, so it replaces outright.
 const nextRun=await store.store.recordAudienceFact({...fact,sessionIncarnation:id(77),state:'private',generation:'0'});
 assert.equal(nextRun.sessionIncarnation,id(77));assert.equal(nextRun.generation,'0');
 // Nothing but identifiers, a state word and a counter is persisted.
 assert.deepEqual(Object.keys(nextRun).sort(),['agentSessionId','generation','kind','processEpoch','scope','sessionIncarnation','state','version']);
 assert.equal(await store.store.readAudienceFact(id(88)),null,'a session with no record reads as absent, not as private');
});

test('F1: the order is the producer arithmetic, not a clock and not a counter',()=>{
 // `public@G` is created by the publish that answers G; every `private@G` is
 // issued once G exists. So at one generation private is never older.
 assert.equal(audienceFactRank({state:'private',generation:'5'})-audienceFactRank({state:'public',generation:'5'}),1n);
 assert.ok(audienceFactIsOlder({state:'public',generation:'5'},{state:'private',generation:'5'}));
 assert.ok(!audienceFactIsOlder({state:'private',generation:'5'},{state:'public',generation:'5'}));
 assert.ok(audienceFactIsOlder({state:'private',generation:'5'},{state:'public',generation:'6'}));
 assert.ok(!audienceFactIsOlder({state:'private',generation:'5'},{state:'private',generation:'5'}),'an equal answer agrees, it is not stale');
 assert.ok(audienceFactSameRun({sessionIncarnation:id(6),processEpoch:id(71)},{sessionIncarnation:id(6),processEpoch:id(71)}));
 assert.ok(!audienceFactSameRun({sessionIncarnation:id(6),processEpoch:id(71)},{sessionIncarnation:id(6),processEpoch:id(72)}));
});

/* ---- F3: an uncertain publication never hides an explicit grant revocation ---- */
test('F3: --grant reaches the grant and revokes it while an expired publication stands',async()=>{
 const first=await harness(r=>{if(route(r)==='audience')throw new TypeError('fetch failed');throw Error(r.path);});
 await first.wait(/Share a session/u);
 await first.press('s',/Share this session's screen live\?/u);
 await first.press('y',/Unresolved change - outcome unknown/u);
 const stuck=(await first.records())[0].operationId;
 first.key('\x03');await first.done;
 // A new process opened on that grant: the sharing record must not hide it.
 let state=active;const revokes=[];
 const second=await harness(r=>{
  if(route(r)==='observers')return memberPage;
  if(route(r)==='inspect')return state;
  if(route(r)==='revoke'){revokes.push(r.body);state=revoking;return revoking;}
  throw Error(r.path);},{initialGrantId:active.grant_id},first.context);
 await second.wait(/Observation grant ba600000 - Active/u);
 assert.match(second.last(),/1 earlier change has an unknown outcome\. Press p/u,'recovery is named, not lost');
 assert.match(second.last(),/No new start of live sharing can begin/u);
 assert.match(second.last(),/granting or revoking observation are all still available/u);
 assert.doesNotMatch(second.last(),/No new grant or revocation can start/u,'a sharing record is not a grant record');
 // And the revocation actually goes through.
 await second.press('x',/Revocation requested, not yet effective/u);
 assert.equal(revokes.length,1);assert.deepEqual(revokes[0],{version:'2',operation_id:revokes[0].operation_id,expected_revision:1});
 // The uncertain publication is preserved untouched, and never resent.
 const kept=await second.records();
 assert.equal(kept.filter(op=>op.kind==='audience').length,1);
 assert.equal(kept.find(op=>op.kind==='audience').operationId,stuck);
 assert.equal(second.requests.filter(r=>route(r)==='audience').length,0,'nothing about sharing left the client');
 // Recovery is still one keypress away from here.
 await second.press('p',/Unresolved change - outcome unknown/u);
 assert.match(second.last(),new RegExp(`operation ${stuck}`,'u'));
 second.key('\x03');await second.done;
});

test('F3: an uncertain grant change still blocks a grant change, and an uncertain publication still blocks a publication',async()=>{
 // The separation is per authority, not a removal of the guard.
 const h=await harness(r=>{if(route(r)==='observers')return memberPage;if(route(r)==='observe-grants')return active;if(route(r)==='audience')throw new TypeError('fetch failed');throw Error(r.path);});
 await h.wait(/Share a session/u);
 await h.press('s',/Share this session's screen live\?/u);
 await h.press('y',/Unresolved change - outcome unknown/u);
 await h.press('b',/Share a session/u);
 // Same authority: still refused.
 await h.press('s',/Cannot start live sharing while an earlier change has an unknown outcome/u);
 // Different authority: the grant path is reachable and sends its own request.
 await h.press('b',/Share a session/u);
 await h.press('\r',/Choose the member/u);
 await h.press('\r',/Press 1, 2 or 3/u);
 await h.press('1',/Observation grant ba600000 - Active/u);
 assert.equal(h.requests.filter(r=>route(r)==='observe-grants').length,1,'the grant was created despite the uncertain publication');
 assert.equal(h.requests.filter(r=>route(r)==='audience').length,1,'and nothing about sharing was re-sent');
 const records=await h.records();
 assert.equal(records.length,1);assert.equal(records[0].kind,'audience','the uncertain publication is preserved exactly');
 h.key('\x03');await h.done;
});
