import assert from 'node:assert/strict';
import test from 'node:test';
import {runProviderScreen} from '../dist/machines/provider-screen.js';
import {decodeProviderObservation,decodeProviderPresets} from '../dist/api/provider-v2.js';
class Host{screen='';restored=0;dimensions(){return {columns:120,rows:20};}async acquire(){return {restore:async()=>{this.restored++;}};}async write(b){this.screen=new TextDecoder().decode(b);}onInput(f){this.input=f;return()=>{this.input=undefined;};}onResize(){return()=>{};}key(s){this.input?.(new TextEncoder().encode(s));}}
function stripAnsi(v){let out='';for(let i=0;i<v.length;i++){if(v.charCodeAt(i)===27&&v[i+1]==='['){i+=2;while(i<v.length&&!(v.charCodeAt(i)>=0x40&&v.charCodeAt(i)<=0x7e))i++;continue;}out+=v[i];}return out;}
async function see(h,s){for(let i=0;i<200;i++){if(h.screen.includes(s))return;await new Promise(r=>setTimeout(r,5));}assert.fail(h.screen);}
const id='10000000-0000-4000-8000-000000000001';const preset={kind:'provider_preset',agent:'opencode',label:'OpenCode Zen / Big Pickle',profile_id:id,profile_revision:1};
test('actual preset screen requires explicit selection and ignores pasted Enter',async()=>{const host=new Host();const second={...preset,label:'OpenCode Zen / Other',profile_id:'10000000-0000-4000-8000-000000000002'};const run=runProviderScreen({getProviderPresetsV2:async()=>[preset,second]},{kind:'preset',agent:'opencode'},host);await see(host,second.label);host.key('\x1b[200~\r\x1b[201~');await new Promise(r=>setTimeout(r,20));assert.equal(host.restored,0);host.key('\x1b[B');await see(host,'❯ '+second.label);host.key('\r');assert.deepEqual(await run,second);assert.equal(host.restored,1);});
test('check screen clears identity after expiry and failed explicit refresh; no polling',async()=>{const host=new Host();let pulls=0;const client={getAgentSession:async()=>({id,processEpoch:id,desiredState:'running',processState:'running'}),checkProviderV2:async()=>{pulls++;if(pulls>1)throw Error('unavailable');return {state:'observed',observed_at_ms:Date.now()-1,valid_until_ms:Date.now()+70,provider:{upstream_provider:'opencode',model:'big-pickle',agent_version:'1.2.3'}};}};const run=runProviderScreen(client,{kind:'check',sessionId:id},host);await see(host,'big-pickle');await see(host,'expired');assert.doesNotMatch(host.screen,/big-pickle/);assert.equal(pulls,1);host.key('r');await see(host,'unavailable');assert.equal(pulls,2);host.key('q');await run;});
test('strict V2 decoder refuses cross scope, unknown catalog and numeric version',()=>{assert.throws(()=>decodeProviderPresets({version:'2',items:[]}));assert.deepEqual(decodeProviderPresets({version:'2',items:[preset]}),[preset]);assert.throws(()=>decodeProviderObservation({version:2,state:'unavailable',reason:'runtime_unavailable'},id,id));});

test('actual V2 client posts exact selected operation and rejects changed receipt',async()=>{
 const {createCunaApiClient}=await import('../dist/api/client.js');const uuid=n=>`${n}0000000-0000-4000-8000-000000000001`;
 const input={agent:'opencode',operation_id:uuid(6),profile_id:uuid(7),profile_revision:1,execution_workspace_id:uuid(3),workspace_generation:1,cwd:`/workspace/workspaces/${uuid(3)}`};
 const receipt={version:'2',agent_session:{id:uuid(2),machine_id:uuid(1),name:'OpenCode',agent:'opencode',cwd:input.cwd,auth_mode:'interactive_login',desired_state:'running',request_state:'launch_pending',process_state:'unknown',row_version:1,created_at:'2026-09-05T00:00:00Z',updated_at:'2026-09-05T00:00:00Z'},execution_workspace_id:uuid(3),workspace_generation:1,remote_root:input.cwd,selection:{version:'2',kind:'provider_profile_selection',profile_selection_id:uuid(4),operation_id:uuid(6),agent_session_id:uuid(2),session_incarnation:uuid(5),machine_id:uuid(1),profile_id:uuid(7),profile_revision:1,profile_revision_sha256:'a'.repeat(64),configuration_state:'unobserved'}};
 let response=receipt;const calls=[];const client=createCunaApiClient({request:async r=>{calls.push(r);return response;}});
 assert.equal((await client.createProviderSessionV2(uuid(1),input)).agentSession.id,uuid(2));assert.equal(calls[0].path,`/v1/collaboration/2/sessions/${uuid(1)}/workspace-agent-sessions`);assert.equal(calls[0].body.operation_id,input.operation_id);assert.equal(calls[0].idempotencyKey,undefined);
 for(const agent of ['codex','claude-code']){response={...receipt,agent_session:{...receipt.agent_session,agent}};assert.equal((await client.createProviderSessionV2(uuid(1),{...input,agent})).agentSession.agent,agent);assert.equal(calls.at(-1).body.agent,agent);await assert.rejects(client.createProviderSessionV2(uuid(1),input));}
 response={...receipt,selection:{...receipt.selection,profile_revision:2}};await assert.rejects(client.createProviderSessionV2(uuid(1),input));
 await assert.rejects(client.createProviderSessionV2(uuid(1),{...input,extra:'spoof'}));assert.equal(calls.length,6);
});

test('one profile is used without asking: one line says what happens, the terminal is never taken',async()=>{
 for(const [agent,signIn] of [['claude-code','Claude'],['codex','Codex']]){
  const host=new Host();let acquired=0;host.acquire=async()=>{acquired++;return {restore:async()=>{host.restored++;}};};
  const native={...preset,kind:'native_interactive',agent,label:agent+' native'};const lines=[];
  // The other agent's preset is filtered out first: one of this agent's is one.
  const chosen=await runProviderScreen({getProviderPresetsV2:async()=>[preset,native]},{kind:'preset',agent},host,undefined,{machineName:'rexbit-claude-qa6',announce:l=>lines.push(l),onBeforeTerminalOwnership:()=>assert.fail('no terminal for one profile')});
  assert.deepEqual(chosen,native);assert.equal(acquired,0);assert.equal(host.screen,'');
  assert.deepEqual(lines,[`${agent==='codex'?'Codex':'Claude Code'} will open on rexbit-claude-qa6. Sign in to ${signIn} inside the terminal.`]);
 }
 const lines=[];assert.deepEqual(await runProviderScreen({getProviderPresetsV2:async()=>[preset]},{kind:'preset',agent:'opencode'},new Host(),undefined,{announce:l=>lines.push(l)}),preset);
 assert.deepEqual(lines,['OpenCode will open on your Machine with OpenCode Zen / Big Pickle. Connect your provider inside OpenCode.']);
});

test('several profiles: a Machines-style list in plain words, never "provider observation"',async()=>{
 const host=new Host();const a={...preset,kind:'native_interactive',agent:'claude-code',label:'Claude Code — configure in terminal'};const b={...a,label:'Claude Code — second',profile_id:'10000000-0000-4000-8000-000000000003'};let owned=0;
 const run=runProviderScreen({getProviderPresetsV2:async()=>[a,b]},{kind:'preset',agent:'claude-code'},host,undefined,{machineName:'rexbit-claude-qa6',color:true,onBeforeTerminalOwnership:()=>owned++});
 await see(host,b.label);const plain=stripAnsi(host.screen);
 assert.equal(owned,1);assert.match(plain,/CUNA  ◆── New Claude Code session/);assert.match(plain,/Choose how Claude Code starts on rexbit-claude-qa6\./);
 assert.match(plain,/❯ Claude Code — configure in terminal\s+Sign in to Claude inside the terminal after it opens\./);assert.match(plain,/↑↓ move  ·  Enter choose  ·  r refresh  ·  Esc\/q back/);
 assert.doesNotMatch(plain,/observation/i);assert.ok(host.screen.includes('\x1b[48;5;202m'),'the brand cell is the Machines view header');
 host.key('q');assert.equal(await run,undefined);assert.equal(host.restored,1);
});

test('a failed profile read opens the screen with a retry, and r reads again',async()=>{
 const host=new Host();let reads=0;const two=[preset,{...preset,label:'Second',profile_id:'10000000-0000-4000-8000-000000000004'}];
 const run=runProviderScreen({getProviderPresetsV2:async()=>{if(++reads===1)throw Error('offline');return two;}},{kind:'preset',agent:'opencode'},host);
 await see(host,'could not be read');host.key('r');await see(host,'Second');assert.equal(reads,2);host.key('\r');assert.deepEqual(await run,preset);
});

test('catalog discriminates native and provider profiles without cross-agent alias',()=>{for(const agent of ['codex','claude-code']){const native={...preset,kind:'native_interactive',agent};assert.deepEqual(decodeProviderPresets({version:'2',items:[native]}),[native]);assert.throws(()=>decodeProviderPresets({version:'2',items:[{...native,kind:'provider_preset'}]}));}assert.throws(()=>decodeProviderPresets({version:'2',items:[{...preset,kind:'native_interactive'}]}));});
