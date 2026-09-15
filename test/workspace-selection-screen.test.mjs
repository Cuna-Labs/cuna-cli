import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {persistWorkspaceBinding,loadWorkspaceBindingIntent} from '../dist/workspace/binding-store.js';
import {inspectWorkspaceSyncPolicy} from '../dist/sync/workspace-sync-product-service.js';
import {conservativeFilesystemCapabilities} from '../dist/journey/workspace-effects.js';
import {runWorkspaceSelectionScreen} from '../dist/workspace/selection-screen.js';
import {saveWorkspaceSelection} from '../dist/workspace/selection-service.js';
const id=n=>`${n}0000000-0000-4000-8000-000000000001`;
class Host {
  screen='';restored=0;
  dimensions(){return {columns:100,rows:30};}
  async acquire(){return {restore:async()=>{this.restored++;}};}
  async write(b){this.screen=new TextDecoder().decode(b);}
  onInput(f){this.input=f;return()=>{this.input=undefined;};}
  onResize(){return()=>{};}
  key(text){this.input?.(new TextEncoder().encode(text));}
}
async function see(host,text){for(let i=0;i<500;i++){if(host.screen.includes(text))return;await new Promise(r=>setTimeout(r,10));}assert.fail(`Missing screen ${text}: ${host.screen}`);}
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'cuna-workspace-screen-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'source'),destination=join(root,'destination');
  await mkdir(source);await mkdir(destination);
  const policy=await inspectWorkspaceSyncPolicy({localRoot:source,filesystemCapabilities:conservativeFilesystemCapabilities('windows')});
  const record=await persistWorkspaceBinding({root:source,expected:null,binding:{profileId:'default',userId:id(1),workspaceId:id(2),bindingId:id(3),projectId:id(4),localInstanceId:id(5),machineId:id(6),remoteRoot:`/workspace/projects/${id(4)}`,policyDigest:policy.exclusionPolicyDigest,generation:1,bindingCreatedAt:'2026-09-04T00:00:00Z',bindingUpdatedAt:'2026-09-04T00:00:00Z'}});
  const calls=[];
  const context={profileId:'default',userId:id(1),workspaceId:id(2),machineId:id(6),stateDirectory:root,platform:'windows',client:{
    async getWorkspaceBinding(){return {...record,executionWorkspaceId:null};},
    async listExecutionWorkspaces(){return {items:[{executionWorkspaceId:id(7),activeGeneration:7}],nextCursor:null};},
    async createWorkspaceBinding(input,key){calls.push({input,key});return {...input,bindingId:id(8),executionWorkspaceId:input.executionWorkspaceId??id(9),remoteRoot:`/workspace/workspaces/${input.executionWorkspaceId??id(9)}`,activeGeneration:input.executionWorkspaceId?7:0,createdAt:'2026-09-04T00:00:00Z',updatedAt:'2026-09-04T00:00:00Z'};}
  }};
  return {source,destination,context,calls,record};
}
for(const adopt of [false,true])test(`interactive ${adopt?'adoption':'new Workspace'} preserves source and binds only after confirmation`,async t=>{
  const f=await fixture(t),host=new Host();
  const original=await readFile(join(f.source,'.cuna/workspace.json'));
  const run=runWorkspaceSelectionScreen(f.context,f.source,host);
  await see(host,'Project context');host.key('\r');
  await see(host,'Create an independent');
  if(adopt){host.key('\x1b[B');await see(host,`> ${id(7)}`);}
  host.key('\r');await see(host,'existing local folder');
  host.key(f.destination);await see(host,f.destination);
  host.key('\r');await see(host,'Enter confirms');host.key('\n');
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.calls.length,0);
  host.key('\r');await see(host,'binding saved');
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].input.executionWorkspaceId,adopt?id(7):undefined);
  const local=await loadWorkspaceBindingIntent({startPath:f.destination,profileId:'default',userId:id(1),workspaceId:id(2)});
  assert.equal(local.record.executionWorkspaceId,adopt?id(7):id(9));
  assert.deepEqual(await readFile(join(f.source,'.cuna/workspace.json')),original);
  host.key('\r');await run;assert.equal(host.restored,1);
});
test('existing binding refuses before any create request',async t=>{
  const f=await fixture(t);
  await assert.rejects(saveWorkspaceSelection(f.context,f.source,f.source,id(7),f.record),/already has a Workspace/);
  assert.equal(f.calls.length,0);
});
test('a changed displayed Project is refused before creating a binding',async t=>{
  const f=await fixture(t);
  await assert.rejects(saveWorkspaceSelection(f.context,f.source,f.destination,undefined,{...f.record,projectId:id(9)}),/context changed/);
  assert.equal(f.calls.length,0);
});
test('Ctrl+C and bracketed multiline paste never confirm a selection',async t=>{
  const f=await fixture(t),host=new Host();
  const run=runWorkspaceSelectionScreen(f.context,f.source,host);
  await see(host,'Project context');host.key('\x1b[200~\n\x1b[201~');
  await see(host,'Paste one folder');assert.equal(f.calls.length,0);
  host.key('\x03');assert.equal(await run,'cancelled');assert.equal(host.restored,1);
});
test('a hung output write cannot prevent terminal restoration after cancellation',async t=>{
  const f=await fixture(t),host=new Host();
  host.write=()=>new Promise(()=>{});
  const run=runWorkspaceSelectionScreen(f.context,f.source,host);
  while(!host.input)await new Promise(resolve=>setTimeout(resolve,5));
  host.key('\x03');assert.equal(await run,'cancelled');assert.equal(host.restored,1);
});
