import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import process from 'node:process';
import xtermHeadless from '@xterm/headless';

// Drives `cuna share` through a REAL Windows ConPTY (node-pty), one input at a
// time, observing the decoded screen before the next key. The backend is the
// LOCAL FIXTURE in owner-share-conpty-fixture.mjs, never the deployed API.
// Usage: node scripts/harness/owner-share-conpty.mjs <evidence-dir>
const {Terminal}=xtermHeadless;
if(process.platform!=='win32'){console.log(JSON.stringify({result:'UNVERIFIED',reason:'requires Windows ConPTY'}));process.exit(2);}
const evidenceDir=process.argv[2];if(!evidenceDir)throw new Error('evidence directory required');
const root=path.resolve(import.meta.dirname,'..','..');
const {spawn}=createRequire(path.join(root,'test','windows-conpty','package.json'))('node-pty');
const fixture=path.join(root,'scripts','harness','owner-share-conpty-fixture.mjs');
await mkdir(evidenceDir,{recursive:true});
const sandbox=await mkdtemp(path.join(tmpdir(),'cuna-share-conpty-'));
const configFile=path.join(sandbox,'config.json');
await writeFile(configFile,`${JSON.stringify({schema_version:1,selected_profile:'conpty',profiles:{conpty:{development:true,base_url:'http://127.0.0.1:9/'}}})}\n`);
const source={commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim().split(/\r?\n/u).filter(Boolean)};
const screenOf=terminal=>{const b=terminal.buffer.active;const lines=[];for(let r=0;r<terminal.rows;r++)lines.push(b.getLine(r)?.translateToString(true)??'');return lines.join('\n').replace(/\n+$/u,'');};
/**
 * The screen as logical lines.
 *
 * A 110-column ConPTY wraps a long sentence wherever the column runs out,
 * including mid-word, so a predicate written against the sentence the product
 * emits would fail on the wrap rather than on the behaviour. The terminal
 * itself records which rows are continuations (`isWrapped`), so rejoining them
 * with no separator reconstructs exactly what was written. Screenshots keep the
 * wrapped truth; only predicates read this.
 */
const logicalOf=terminal=>{
 const b=terminal.buffer.active;const lines=[];
 for(let r=0;r<terminal.rows;r++){const line=b.getLine(r);if(!line)continue;const text=line.translateToString(true);
  if(line.isWrapped&&lines.length)lines[lines.length-1]+=text;else lines.push(text);}
 return lines.join('\n').replace(/\n+$/u,'');
};
const folded=screen=>screen.replaceAll(/[ \t]+/gu,' ').replaceAll(/\s+([,.;])/gu,'$1');
async function drive(mode,steps,shared){
 // `shared` names a sandbox directory two runs have in common, so the second
 // spawn is a genuine relaunch against the first one's state directory.
 const ledger=path.join(sandbox,shared??mode,'ledger.jsonl');await mkdir(path.dirname(ledger),{recursive:true});
 const terminal=new Terminal({allowProposedApi:true,cols:110,rows:32,scrollback:200});let transcript='',tail=Promise.resolve(),exit;
 const child=spawn(process.execPath,[fixture,ledger,configFile,mode],{name:'xterm-256color',cols:110,rows:32,cwd:root,useConpty:true,useConptyDll:false,env:{...process.env,TERM:'xterm-256color'}});
 child.onData(d=>{transcript+=d;tail=tail.then(()=>new Promise(r=>terminal.write(d,r)));});
 const exited=new Promise(r=>child.onExit(e=>{exit=e;r(e);}));
 const observations=[];
 const waitFor=async(label,predicate,timeoutMs=8000)=>{const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){await tail;if(predicate(logicalOf(terminal))){const screen=screenOf(terminal);observations.push({step:label,at:new Date().toISOString(),screen});return screen;}await new Promise(r=>setTimeout(r,20));}const screen=screenOf(terminal);observations.push({step:label,at:new Date().toISOString(),screen,TIMEOUT:true});throw new Error(`${mode}: ${label} not observed. Screen:\n${screen}\nTranscript tail:\n${transcript.slice(-1200)}`);};
 try{
  // A key that triggers a request is observed through the fixture's own request
  // ledger BEFORE the screen predicate: a screen identical to the previous one
  // (an inspect that still says pending) would otherwise match instantly and the
  // next key would be sent while the screen is still busy.
  const requestCount=async()=>{try{return (await readFile(ledger,'utf8')).split('\n').filter(l=>l.includes('"event":"request"')).length;}catch{return 0;}};
  for(const step of steps){const before=await requestCount();if(step.key!==undefined){observations.push({step:`input ${JSON.stringify(step.key)}`,at:new Date().toISOString()});child.write(step.key);}
   if(step.requests){const deadline=Date.now()+8000;while(await requestCount()<before+step.requests){if(Date.now()>deadline)throw new Error(`${mode}: ${step.expect}: expected ${step.requests} new request(s) after the key`);await new Promise(r=>setTimeout(r,20));}}
   await waitFor(step.expect,screen=>step.test(folded(screen)),step.timeoutMs);if(step.assert)step.assert(folded(logicalOf(terminal)));}
  child.write('\x03');await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Ctrl+C did not exit within 3s')),3000))]);await tail;
  const finalScreen=screenOf(terminal);const restored=/\[\?1049l/u.test(transcript)&&terminal.buffer.active.type==='normal';
  const ledgerRows=(await readFile(ledger,'utf8')).trim().split('\n').map(l=>JSON.parse(l));
  const stateRoot=path.join(path.dirname(ledger),'state','owner-observe-grants-v2');
  let records=[];
  try{for(const scope of await readdir(stateRoot))for(const name of await readdir(path.join(stateRoot,scope)))records.push(JSON.parse(await readFile(path.join(stateRoot,scope,name),'utf8')));}catch{records=[];}
  return{mode,result:'PASS',exitCode:exit?.exitCode??null,alternateScreenRestored:restored,observations,ledger:ledgerRows,durableRecordsAfterExit:records,transcriptSha256:createHash('sha256').update(transcript).digest('hex'),transcriptBytes:Buffer.byteLength(transcript),finalScreen,transcript};
 }catch(error){if(!exit){try{child.kill();}catch{}}return{mode,result:'FAIL',error:error.message,observations,transcript,exitCode:exit?.exitCode??null};}
 finally{terminal.dispose();}
}
const includes=s=>screen=>screen.includes(s);
const results=[];
results.push(await drive('happy',[
 {expect:'sessions list',test:s=>s.includes('Share a session - read-only observation')&&s.includes('> conpty-owner-box / claude-live'),assert:s=>assert.ok(!s.includes('other-project-session'),'another Project\'s session must not be offered')},
 {key:'\r',expect:'member list',test:s=>s.includes('Choose the member who may observe claude-live')&&s.includes('member-b@example.test'),assert:s=>{assert.ok(!s.includes('owner@example.test'),'owner must not be offered as recipient');assert.ok(s.includes('grants nothing by itself'));}},
 {key:'\r',expect:'duration menu',test:includes('Press 1, 2 or 3 to create the grant')},
 {key:'1',expect:'active grant',test:s=>s.includes('Observation grant ba600000 - Active')&&s.includes('No keyboard, resize or signal is granted')},
 {key:'x',requests:1,expect:'revocation pending',test:s=>s.includes('Revocation requested, not yet effective')&&s.includes('may still see output'),assert:s=>assert.ok(!s.includes('Revoked, effective'),'pending must never read as effective')},
 {key:'i',requests:1,expect:'still pending after first inspect',test:s=>s.includes('Revocation requested, not yet effective')&&s.includes('revision 2')},
 {key:'i',requests:1,expect:'revoked effective',test:s=>s.includes('Revoked, effective')&&s.includes('revision 3')},
]));
results.push(await drive('lost-revoke',[
 {expect:'sessions list',test:includes('> conpty-owner-box / claude-live')},
 {key:'\r',expect:'member list',test:includes('member-b@example.test')},
 {key:'\r',expect:'duration menu',test:includes('Press 1, 2 or 3')},
 {key:'3',expect:'active grant',test:includes('Observation grant ba600000 - Active')},
 {key:'x',requests:1,expect:'uncertain outcome',test:s=>s.includes('Unresolved change - outcome unknown')&&s.includes('Cuna never confirmed this'),assert:s=>assert.ok(!s.includes('Revoked'),'unknown must not read as revoked')},
 {key:'r',requests:1,expect:'same operation replayed and accepted',test:s=>s.includes('Revocation requested, not yet effective')&&s.includes('revision 2')},
]));
// Durability across a real process boundary: the first spawn loses the answer
// to a create and exits; the second spawn is a fresh CLI process on the SAME
// state directory and must open on that exact operation.
results.push(await drive('lost-create',[
 {expect:'sessions list',test:includes('> conpty-owner-box / claude-live')},
 {key:'\r',expect:'member list',test:includes('member-b@example.test')},
 {key:'\r',expect:'duration menu',test:includes('Press 1, 2 or 3')},
 {key:'1',requests:1,expect:'unresolved create',test:s=>s.includes('Unresolved change - outcome unknown')&&s.includes('cannot create a second grant')&&s.includes('no owner-side listing'),assert:s=>assert.ok(!s.includes('Observation grant ba600000 - Active'),'an unconfirmed create must not render as a grant')},
],'recovery'));
results.push(await drive('recover',[
 {expect:'recovery screen before anything else',test:s=>s.includes('Unresolved change - outcome unknown')&&s.includes('operation '),assert:s=>assert.ok(!s.includes('Share a session - read-only observation'),'recovery precedes the normal entry screen')},
 {key:'r',requests:1,expect:'replayed grant accepted',test:includes('Observation grant ba600000 - Active')},
],'recovery'));
results.push(await drive('stale',[
 {expect:'sessions list',test:includes('> conpty-owner-box / claude-live')},
 {key:'\r',expect:'member list',test:includes('member-b@example.test')},
 {key:'\r',expect:'duration menu',test:includes('Press 1, 2 or 3')},
 // 404 grant_unavailable is what the producer actually answers for a stale
 // membership revision. The screen must name that cause, not a stale revision.
 {key:'2',requests:1,expect:'membership refusal named truthfully',test:s=>s.includes('Not done - grant unavailable')&&s.includes('no longer an active observer at the membership revision that was read'),assert:s=>assert.ok(!s.includes('Cuna refused a stale expected revision'),'a 404 must not be rendered as a stale revision')},
]));
// B1, independently reproduced by the reviewer as CSA-3/D1 and reproduced here
// inside this harness rather than a second one: a resend the server SETTLES
// destroys the durable record, so the rendered reason is the ONLY explanation
// left. Before the repair the banner vanished and the owner was dropped on the
// session list with nothing said. One input (`r`), then observe.
results.push(await drive('lost-create-settled',[
 {expect:'sessions list',test:includes('> conpty-owner-box / claude-live')},
 {key:'\r',expect:'member list',test:includes('member-b@example.test')},
 {key:'\r',expect:'duration menu',test:includes('Press 1, 2 or 3')},
 {key:'1',requests:1,expect:'unresolved create',test:includes('Unresolved change - outcome unknown')},
],'settled'));
results.push(await drive('replay-settled',[
 {expect:'recovery screen carrying the operation ID',test:s=>s.includes('Unresolved change - outcome unknown')&&s.includes('operation ')},
 {key:'r',requests:1,expect:'the settled refusal is rendered',test:s=>s.includes('Not done - grant unavailable')&&s.includes('Cuna refused this grant and created nothing'),
  assert:s=>{assert.ok(!s.includes('Share a session - read-only observation'),'a settled failure must not vanish into the session list');assert.ok(/Operation [0-9a-f-]{36}/u.test(s),'the settled operation identity must survive in the displayed outcome');}},
],'settled'));
// Publication: the authority that makes a grant mean anything. It is a separate
// decision here, asked for and confirmed on its own, and its receipt is what
// names the point a watcher starts from.
results.push(await drive('share',[
 {expect:'sessions list offers both decisions',test:s=>s.includes('> conpty-owner-box / claude-live')&&s.includes('s starts sharing this session live; e stops it'),
  assert:s=>assert.ok(s.includes('two separate decisions'),'granting and sharing must be presented as separate')},
 {key:'s',expect:'the disclosure before anything is sent',test:s=>s.includes("Share this session's screen live?")&&s.includes('a token, a login code, a file it opens'),
  assert:s=>{assert.ok(s.includes('Nothing from before is replayed to them'),'history scope must be stated');assert.ok(s.includes('cannot recall what was already sent'),'the irrevocable half must be stated');assert.ok(s.includes('creates no grant'));}},
 {key:'y',requests:1,expect:'publication confirmed with its starting point',test:s=>s.includes('Live sharing started - Cuna confirmed it')&&s.includes('Share #1 of this run of the session'),
  assert:s=>{assert.ok(s.includes('the first thing anyone sees is the screen as it is now'));assert.ok(s.includes('grants no keyboard, resize or signal'));}},
 {key:'e',expect:'stopping is confirmed separately',test:s=>s.includes('Stop sharing this session live?')&&s.includes('revokes nothing and expires nothing')},
 {key:'y',requests:1,expect:'private confirmed by the fencing receipt',test:s=>s.includes('Live sharing stopped - Cuna confirmed it')&&s.includes('its output is fenced'),
  assert:s=>assert.ok(s.includes('What was already sent cannot be recalled'),'stopping must not claim to recall what was sent')},
]));
// A receipt about a different session may not be reported as this session being
// shared. Refusing it happens AFTER the request left, so the honest outcome is
// "unknown", not "nothing happened": the refusal is about an answer that was not
// trusted, which says nothing about what the session did. One input, then observe.
results.push(await drive('share-wrong-session',[
 {expect:'sessions list',test:includes('> conpty-owner-box / claude-live')},
 {key:'s',expect:'the disclosure',test:includes("Share this session's screen live?")},
 {key:'y',requests:1,expect:'the cross-session receipt is refused and its outcome held unknown',
  test:s=>s.includes('Unresolved change - outcome unknown')&&s.includes('Cuna answered about a different session. The receipt was refused'),
  assert:s=>{assert.ok(!s.includes('Live sharing started'),'a receipt about another session must never read as this one being shared');
   assert.ok(!s.includes('nothing about sharing changed'),'a receipt we refused is not evidence that nothing happened');}},
]));
// The answer to a publication is lost AFTER the session transitioned. Only the
// durable operation identity can reach the producer's stored answer, and a
// second CLI process must reach it without publishing a second time.
results.push(await drive('lost-share',[
 {expect:'sessions list',test:includes('> conpty-owner-box / claude-live')},
 {key:'s',expect:'the disclosure',test:includes("Share this session's screen live?")},
 {key:'y',requests:1,expect:'unresolved publication',test:s=>s.includes('Unresolved change - outcome unknown')&&s.includes('may or may not be shared live now'),
  assert:s=>{assert.ok(!s.includes('Live sharing started'),'an unconfirmed publication must not render as confirmed');assert.ok(s.includes('e stops live sharing now'),'the safe direction must be reachable from here');}},
],'audience-recovery'));
results.push(await drive('recover-share',[
 {expect:'recovery screen before anything else',test:s=>s.includes('Unresolved change - outcome unknown')&&s.includes('operation '),
  assert:s=>assert.ok(!s.includes('Share a session - read-only observation'),'recovery precedes the normal entry screen')},
 {key:'r',requests:1,expect:'the producer answers the same identity from its journal',test:includes('Live sharing started - Cuna confirmed it'),
  assert:s=>assert.ok(s.includes('Share #1 of this run of the session'),'the replay must settle on the SAME share, not a second one')},
],'audience-recovery'));
// The ordering root named as decisive, end to end through the screen: an
// unconfirmed publish, then a SEPARATELY confirmed stop, then a replay of the
// publish. The producer re-validates live state before serving its journal, so
// the replay is refused; the screen must hold the original outcome unknown and
// must never render the stored publication as current.
results.push(await drive('lost-share',[
 {expect:'sessions list',test:includes('> conpty-owner-box / claude-live')},
 {key:'s',expect:'the disclosure',test:includes("Share this session's screen live?")},
 {key:'y',requests:1,expect:'unresolved publication',test:includes('Unresolved change - outcome unknown')},
 {key:'e',expect:'stopping is offered from the unresolved screen',test:includes('Stop sharing this session live?')},
 {key:'y',requests:1,expect:'private confirmed while the publish stays unresolved',
  test:s=>s.includes('Live sharing stopped - Cuna confirmed it')&&s.includes('1 earlier change has an unknown outcome')},
 {key:'p',expect:'back to the unresolved publication',test:includes('Unresolved change - outcome unknown')},
 {key:'r',requests:1,expect:'the replay is refused and the outcome stays unknown',
  test:s=>s.includes('The session refused this attempt and Cuna recorded that refusal')&&s.includes('what the earlier one did is still unknown'),
  assert:s=>{assert.ok(!s.includes('Live sharing started'),'a stored publication must never be rendered after a confirmed stop');
   assert.ok(!s.includes('r resends this exact operation'),'a request Cuna has already answered may not be offered for resend');
   assert.ok(!s.includes('it is the only thing that can settle this'),'the screen must stop promising a resend it has just withdrawn');
   assert.ok(s.includes('Cuna will not raise this request with the session again'),'and must say why');}},
],'audience-ordering'));
// The acceptance review's F5: reconciliation by replay is bounded to the stored
// request's ~20 s deadline, and the fixture now models it. Outside the window the
// replay never reaches the producer's journal, so the screen must say the request
// can no longer settle anything, must KEEP the record, and must stop offering a
// resend that cannot work.
results.push(await drive('lost-share-expired',[
 {expect:'sessions list',test:includes('> conpty-owner-box / claude-live')},
 {key:'s',expect:'the disclosure',test:includes("Share this session's screen live?")},
 {key:'y',requests:1,expect:'unresolved publication',test:includes('Unresolved change - outcome unknown')},
],'audience-expired'));
results.push(await drive('lost-share-expired',[
 {expect:'recovery screen',test:s=>s.includes('Unresolved change - outcome unknown')&&s.includes('r resends this exact operation')},
 {key:'r',requests:1,expect:'the expired replay settles nothing and keeps the record',
  test:s=>s.includes('this exact request can no longer be sent')&&s.includes('What the first attempt did is still unknown'),
  assert:s=>{assert.ok(!s.includes('Live sharing started'),'an expired replay must never render as a confirmed publication');
   assert.ok(s.includes('Cuna will not raise this request with the session again'),'the screen must say the door is closed');
   assert.ok(!s.includes('r resends this exact operation'),'and must stop offering the resend');
   assert.ok(s.includes('e stops live sharing now'),'while keeping the safe direction');}},
],'audience-expired'));
// Evidence is written before any cross-case assertion, so a failing assertion
// leaves the screens and transcripts that explain it rather than nothing.
for(const r of results){await writeFile(path.join(evidenceDir,`conpty-${r.mode}.transcript.ansi`),r.transcript??'');await writeFile(path.join(evidenceDir,`conpty-${r.mode}.screens.txt`),r.observations.map(o=>`=== ${o.step} @ ${o.at}${o.TIMEOUT?' (TIMEOUT)':''}\n${o.screen??''}\n`).join('\n'));}
console.log(JSON.stringify({cases:results.map(r=>({mode:r.mode,result:r.result,exitCode:r.exitCode,error:r.error}))},null,2));
const creates=r=>r.ledger.filter(row=>row.event==='request'&&row.path.endsWith('/observe-grants'));
const audience=r=>r.ledger.filter(row=>row.event==='request'&&row.path.endsWith('/audience'));
for(const r of results){
 if(r.result!=='PASS')continue;
 if(r.result!=='PASS')continue;
 const revokes=r.ledger.filter(row=>row.event==='request'&&row.path.endsWith('/revoke'));
 if(r.mode==='lost-revoke'){assert.equal(revokes.length,2,'exactly one replay');assert.equal(revokes[0].body.operation_id,revokes[1].body.operation_id,'replay keeps the operation ID');assert.equal(revokes[0].body.expected_revision,revokes[1].body.expected_revision);}
 if(r.mode==='happy'){assert.equal(revokes.length,1);assert.equal(r.ledger.filter(row=>row.event==='request'&&row.path.endsWith('/inspect')).length,2,'two explicit inspects, no polling');}
 // `recover` and `replay-settled` share a ledger with the run that lost the
 // create, so their rows carry both attempts by construction; the sharing cases
 // never reach the grant route at all, which is asserted below instead.
 if(!['recover','replay-settled','share','share-wrong-session','lost-share','recover-share','lost-share-expired'].includes(r.mode))assert.equal(creates(r).length,1,'exactly one create request per run');
 assert.ok(!r.transcript.includes('cuna_at_'),'the bearer never reaches the screen');
 // No sharing decision is ever a side effect of a grant decision, and no grant
 // is ever a side effect of a sharing decision.
 const sharing=audience(r);
 if(['happy','lost-revoke','stale','lost-create','lost-create-settled'].includes(r.mode))assert.equal(sharing.length,0,`${r.mode} must send no publication request`);
 if(['share','share-wrong-session','lost-share','recover-share','lost-share-expired'].includes(r.mode))assert.equal(creates(r).length,0,`${r.mode} must create no grant`);
 if(r.mode==='share')assert.deepEqual(sharing.map(row=>row.body.action),['publish','private']);
}
// The lost publication and its recovery share a ledger, so its rows carry both
// attempts: the same identity, the same action, one publication.
const shareRecovery=results.find(r=>r.mode==='recover-share');
if(shareRecovery?.result==='PASS'){
 const attempts=audience(shareRecovery);
 assert.equal(attempts.length,2,'one lost publication and exactly one replay');
 assert.equal(attempts[0].body.operation_id,attempts[1].body.operation_id,'the relaunched process replayed the exact recovered operation ID');
 assert.deepEqual(attempts[0].body,attempts[1].body,'the recovered request is identical in every field, including the action');
 assert.equal(shareRecovery.ledger.filter(row=>row.event==='audience-replay-answered-from-journal').length,1,'the producer answered the replay from its journal instead of transitioning again');
 assert.equal(shareRecovery.ledger.filter(row=>row.event==='exit').at(-1).audience,1,'the session was published exactly once across both processes');
 const lost=results.find(r=>r.mode==='lost-share');
 assert.equal(lost.durableRecordsAfterExit.length,1,'the unresolved publication survived an ordinary exit');
 assert.equal(lost.durableRecordsAfterExit[0].kind,'audience');
 assert.equal(lost.durableRecordsAfterExit[0].action,'publish');
 assert.deepEqual(Object.keys(lost.durableRecordsAfterExit[0]).sort(),['action','agentSessionId','kind','operationId','scope','version'],'no member, stream or secret is persisted');
 assert.equal(shareRecovery.durableRecordsAfterExit.length,0,'a settled replay clears the record');
}
// Outside the stored window the same replay reaches nothing and settles nothing,
// so the record must survive rather than be dropped.
const expiredRuns=results.filter(r=>r.mode==='lost-share-expired'&&r.result==='PASS');
if(expiredRuns.length===2){
 const replay=expiredRuns[1];
 assert.equal(replay.ledger.filter(row=>row.event==='audience-replay-outside-window').length,1,'the producer refused the replay before reaching its journal');
 assert.equal(replay.ledger.filter(row=>row.event==='audience-replay-answered-from-journal').length,0,'an expired replay must never be served from the journal');
 assert.equal(replay.durableRecordsAfterExit.length,1,'an unsettled publication keeps its identity across the expired replay');
 assert.equal(replay.durableRecordsAfterExit[0].kind,'audience');
}
// The relaunch shares its ledger with the first run, so its rows include both.
const recovery=results.find(r=>r.mode==='recover');
if(recovery?.result==='PASS'){
 const attempts=creates(recovery);
 assert.equal(attempts.length,2,'one lost create and exactly one replay');
 assert.equal(attempts[0].body.operation_id,attempts[1].body.operation_id,'the relaunched process replayed the exact recovered operation ID');
 assert.deepEqual(attempts[0].body,attempts[1].body,'the recovered request is identical in every field');
 const lost=results.find(r=>r.mode==='lost-create');
 assert.equal(lost.durableRecordsAfterExit.length,1,'the unresolved operation survived an ordinary exit');
 assert.equal(lost.durableRecordsAfterExit[0].operationId,attempts[0].body.operation_id);
 assert.deepEqual(Object.keys(lost.durableRecordsAfterExit[0]).sort(),['agentSessionId','expectedMembershipRevision','expiresAtMs','kind','operationId','scope','subjectPrincipalId','version'],'no secret, email or session name is persisted');
 assert.equal(recovery.durableRecordsAfterExit.length,0,'a confirmed replay clears the record');
}
for(const r of results){await writeFile(path.join(evidenceDir,`conpty-${r.mode}.transcript.ansi`),r.transcript??'');await writeFile(path.join(evidenceDir,`conpty-${r.mode}.screens.txt`),r.observations.map(o=>`=== ${o.step} @ ${o.at}${o.TIMEOUT?' (TIMEOUT)':''}\n${o.screen??''}\n`).join('\n'));}
const summary={testId:'OWNER-R5-CONPTY',backend:'LOCAL_FIXTURE (owner-share-conpty-fixture.mjs); not the deployed API',timestamp:new Date().toISOString(),host:{platform:process.platform,arch:process.arch,node:process.version},conpty:{implementation:'node-pty',useConpty:true},source,cases:results.map(r=>({...r,transcript:undefined}))};
await writeFile(path.join(evidenceDir,'conpty-summary.json'),JSON.stringify(summary,null,2));
await rm(sandbox,{recursive:true,force:true});
console.log(JSON.stringify({result:results.every(r=>r.result==='PASS')?'PASS':'FAIL',cases:results.map(r=>({mode:r.mode,result:r.result,exitCode:r.exitCode,alternateScreenRestored:r.alternateScreenRestored,error:r.error}))},null,2));
process.exit(results.every(r=>r.result==='PASS')?0:1);
