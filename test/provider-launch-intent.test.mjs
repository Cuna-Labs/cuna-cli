import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {withProviderLaunchIntent} from '../dist/journey/provider-launch-intent.js';
import {DurableSyncJournal} from '../dist/sync/journal.js';
import {stableUuid} from '../dist/journey/derived-identity.js';

test('restart after uncertain admission reuses operation; resolved next launch gets a new operation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'cuna-provider-intent-'));try{
 const scope={stateDirectory:directory,ownerId:'A',workspaceId:'account',machineId:'machine',executionWorkspaceId:'execution',intent:{generation:7,profile:'profile',revision:2}};let first;
 await assert.rejects(withProviderLaunchIntent({...scope,create:async id=>{first=id;throw Error('reply lost after remote admission');}}));
 let conflictingCalls=0;await assert.rejects(withProviderLaunchIntent({...scope,intent:{...scope.intent,generation:8},create:async()=>{conflictingCalls++;}}),e=>e.code==='cuna.provider.pending_intent_conflict');assert.equal(conflictingCalls,0);
 const replay=await withProviderLaunchIntent({...scope,create:async id=>id});assert.equal(replay,first);
 const crashAfterApplied=await withProviderLaunchIntent({...scope,create:async id=>id});assert.equal(crashAfterApplied,first);
 const deliberate=await withProviderLaunchIntent({...scope,confirmNew:async()=>true,create:async id=>id});assert.notEqual(deliberate,first);
 const foreign=await withProviderLaunchIntent({...scope,ownerId:'B',create:async id=>id});assert.notEqual(foreign,first);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('exclusive journal rejects concurrent admission before a second network mutation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'cuna-provider-intent-'));let release;try{
 const scope={stateDirectory:directory,ownerId:'A',workspaceId:'account',machineId:'machine',executionWorkspaceId:'execution',intent:{profile:'p'}};let entered;const started=new Promise(resolve=>{entered=resolve;});const held=new Promise(resolve=>{release=resolve;});let calls=0;
 const first=withProviderLaunchIntent({...scope,create:async id=>{calls++;entered();await held;return id;}});await started;
 await assert.rejects(withProviderLaunchIntent({...scope,create:async()=>{calls++;}}));assert.equal(calls,1);release();await first;
 }finally{release?.();await rm(directory,{recursive:true,force:true});}
});

// qa6 witness 2026-09-22: the question was answered y four minutes after it
// was asked, and the create failed as unprovable although nothing was sent,
// because the journal's two-minute writer lease was held across the prompt.
// While the question is open, no writer lease may be held: here a second
// writer opens the same journal from inside the question.
test('the recorded-launch question is asked without holding the journal writer lease',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'cuna-provider-intent-'));try{
 const scope={stateDirectory:directory,ownerId:'A',workspaceId:'account',machineId:'machine',executionWorkspaceId:'execution',intent:{generation:1,profile:'profile',revision:2}};
 const first=await withProviderLaunchIntent({...scope,create:async id=>id});
 const key=JSON.stringify(['provider-launch-v2','A','account','machine','execution']);
 const journalDirectory=join(directory,'provider-launch-v2',createHash('sha256').update(key).digest('hex'));
 let asked=false;
 const second=await withProviderLaunchIntent({...scope,intent:{...scope.intent,generation:8},confirmNew:async()=>{
  asked=true;
  const other=await DurableSyncJournal.open({directory:journalDirectory,bindingId:stableUuid('provider-launch-v2',key),bindingGeneration:1,ownerId:'someone-else',leaseMs:1000});
  await other.close();
  return true;
 },create:async id=>id});
 assert.equal(asked,true);assert.notEqual(second,first);
 }finally{await rm(directory,{recursive:true,force:true});}
});

// qa6 witness 2026-09-22: No to the question, after the recorded launch's
// Workspace generation moved on (1 -> 8), is refused locally with nothing
// sent. The refusal names the way forward instead of an unresolved launch.
test('No for a launch recorded under another Workspace version is a typed local refusal that names the way forward',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'cuna-provider-intent-'));try{
 const scope={stateDirectory:directory,ownerId:'A',workspaceId:'account',machineId:'machine',executionWorkspaceId:'execution',intent:{generation:1,profile:'profile',revision:2}};
 await withProviderLaunchIntent({...scope,create:async id=>id});
 let calls=0;
 await assert.rejects(withProviderLaunchIntent({...scope,intent:{...scope.intent,generation:8},confirmNew:async()=>false,create:async()=>{calls++;}}),error=>{
  assert.equal(error.code,'cuna.provider.pending_intent_conflict');
  assert.equal(error.details?.reason,'recorded_launch_mismatch');
  assert.match(error.hint,/--new-session/);
  return true;
 });
 assert.equal(calls,0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

// qa6 re-witness 2026-09-23, run j6: the recorded launch's session had been
// terminated, No was offered as "resumes the recorded launch", the replay
// returned the dead session and the screen said "reused" before failing
// with exit 7. A launch whose session ended is never offered for resume.
function endedScope(directory) {
 return {stateDirectory:directory,ownerId:'A',workspaceId:'account',machineId:'machine',executionWorkspaceId:'execution',intent:{generation:5,profile:'profile',revision:2}};
}
test('a recorded launch whose session ended is not offered for resume, and No starts nothing',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'cuna-provider-intent-'));try{
 const scope=endedScope(directory);
 await withProviderLaunchIntent({...scope,create:async()=>({id:'session-1'})});
 const asked=[];let creates=0;
 await assert.rejects(withProviderLaunchIntent({...scope,
  confirmNew:async(context)=>{asked.push(context?.state);return false;},
  isSessionEnded:async(id)=>id==='session-1',
  create:async()=>{creates++;return {id:'session-1'};}}),
  error=>error.code==='cuna.provider.recorded_launch_ended'&&error.details?.reason==='recorded_launch_ended'&&/--new-session/.test(error.hint));
 assert.deepEqual(asked,['ended'],'the question says the session ended');
 assert.equal(creates,0,'nothing is re-sent for a session known to have ended');
 const fresh=await withProviderLaunchIntent({...scope,confirmNew:async()=>true,isSessionEnded:async(id)=>id==='session-1',create:async id=>({id:'session-2',operation:id})});
 assert.equal(fresh.id,'session-2','yes starts a new session');
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('a resumed launch that turns out to have ended is refused before anyone calls it reused',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'cuna-provider-intent-'));try{
 const scope=endedScope(directory);
 await withProviderLaunchIntent({...scope,create:async()=>({id:'session-1'})});
 // A record written before session ids were kept: nothing is known until the replay.
 const {readdir,unlink}=await import('node:fs/promises');
 const root=join(directory,'provider-launch-v2');
 for(const name of await readdir(root))for(const file of await readdir(join(root,name)))if(file.startsWith('sessions'))await unlink(join(root,name,file));
 let resumed=0;
 await assert.rejects(withProviderLaunchIntent({...scope,confirmNew:async()=>false,onResume:()=>{resumed++;},
  isSessionEnded:async(id)=>id==='session-1',create:async()=>({id:'session-1'})}),
  error=>error.code==='cuna.provider.recorded_launch_ended');
 assert.equal(resumed,0,'a dead session is never announced as resumed');
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('control: a recorded launch whose session is live still resumes',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'cuna-provider-intent-'));try{
 const scope=endedScope(directory);
 const first=await withProviderLaunchIntent({...scope,create:async id=>({id:'session-1',operation:id})});
 const asked=[];
 const again=await withProviderLaunchIntent({...scope,confirmNew:async(context)=>{asked.push(context?.state);return false;},isSessionEnded:async()=>false,create:async id=>({id:'session-1',operation:id})});
 assert.equal(again.operation,first.operation);assert.deepEqual(asked,['resumable']);
 }finally{await rm(directory,{recursive:true,force:true});}
});
