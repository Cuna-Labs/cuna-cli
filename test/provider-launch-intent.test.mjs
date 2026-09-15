import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withProviderLaunchIntent} from '../dist/journey/provider-launch-intent.js';

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
