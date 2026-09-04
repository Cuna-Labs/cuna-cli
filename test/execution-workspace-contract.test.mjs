import assert from 'node:assert/strict';
import test from 'node:test';
import {decodeWorkspaceBindingAuthority,decodeAgentSessionItem} from '../dist/api/contracts.js';
import {createApiAgentJourneyEffects} from '../dist/journey/api-effects.js';
import {createWorkspaceJourneyEffects,conservativeFilesystemCapabilities} from '../dist/journey/workspace-effects.js';
import {inspectWorkspaceSyncPolicy,computeWorkspaceManifestRoot} from '../dist/sync/workspace-sync-product-service.js';
import {createCunaApiClient} from '../dist/api/client.js';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {persistWorkspaceBinding,loadWorkspaceBindingIntent,workspaceBindingCompareAndSwap} from '../dist/workspace/binding-store.js';
const id=n=>`${n}0000000-0000-4000-8000-000000000001`;
test('adopting already synchronized content persists the authoritative binding before returning',async t=>{
  const root=await mkdtemp(join(tmpdir(),'cuna-adopted-workspace-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const filesystemCapabilities=conservativeFilesystemCapabilities('windows');
  const policy=await inspectWorkspaceSyncPolicy({localRoot:root,filesystemCapabilities});
  const activeManifestRoot=await computeWorkspaceManifestRoot({localRoot:root,filesystemCapabilities});
  const effects=createWorkspaceJourneyEffects({profileId:'default',userId:id(8),workspaceId:id(2),stateDirectory:root,filesystemCapabilities,transport:{async request(){throw new Error('unchanged content must not upload');}},client:{async createWorkspaceBinding(input){return {bindingId:id(1),executionWorkspaceId:id(6),workspaceId:id(2),projectId:input.projectId,localInstanceId:input.localInstanceId,machineId:id(5),remoteRoot:`/workspace/workspaces/${id(6)}`,exclusionPolicyDigest:policy.exclusionPolicyDigest,activeGeneration:7,activeManifestRoot,createdAt:'2026-09-04T00:00:00Z',updatedAt:'2026-09-04T00:00:00Z'};}}});
  const receipt=await effects.synchronizeWorkspace({machineId:id(5),localPath:root,syncMode:'once',signal:new AbortController().signal});
  assert.equal(receipt.generation,7);
  const local=await loadWorkspaceBindingIntent({startPath:root,profileId:'default',userId:id(8),workspaceId:id(2)});
  assert.equal(local?.record.executionWorkspaceId,id(6));
  assert.equal(local?.record.generation,7);
});
test('failed materialization is a typed terminal outcome before any readiness sleep',async()=>{
  let reads=0;
  const effects=createApiAgentJourneyEffects({client:{async getAgentSession(){reads++;return {requestState:'failed',processState:'starting',workspaceFailureCode:'workspace.remote_edits'};}},requestedAgent:'codex',async sleep(){throw new Error('must not wait after known failure');}});
  await assert.rejects(effects.ensureAgentSessionReady({agentSessionId:id(1),signal:new AbortController().signal}),e=>e.code==='cuna.journey.workspace_materialization_failed'&&e.details.reason==='workspace.remote_edits'&&/remote edits/i.test(e.message));
  assert.equal(reads,1);
});
test('materialization failure code is accepted only on a failed request and without unsafe text',()=>{
  const session={id:id(1),machine_id:id(5),name:'session',agent:'codex',cwd:'/workspace',auth_mode:'interactive_login',desired_state:'running',request_state:'failed',process_state:'starting',row_version:1,created_at:'2026-09-04T00:00:00Z',updated_at:'2026-09-04T00:00:00Z',workspace_failure_code:'workspace.remote_edits'};
  assert.equal(decodeAgentSessionItem(session).workspaceFailureCode,'workspace.remote_edits');
  assert.throws(()=>decodeAgentSessionItem({...session,request_state:'launch_pending'}));
  assert.throws(()=>decodeAgentSessionItem({...session,workspace_failure_code:'bad\x1b[31m'}));
});
const wire=(execution=id(6))=>({binding_id:id(1),workspace_id:id(2),project_id:id(3),local_instance_id:id(4),machine_id:id(5),execution_workspace_id:execution,remote_root:execution===null?`/workspace/projects/${id(3)}`:`/workspace/workspaces/${execution}`,exclusion_policy_digest:'a'.repeat(64),active_generation:0,active_manifest_root:'b'.repeat(64),binding_epoch:1,minimum_reader:1,minimum_writer:1,created_at:'2026-09-04T00:00:00Z',updated_at:'2026-09-04T00:00:00Z'});
test('local record persists an execution Workspace with a versioned identity and rejects sibling rewrite',async t=>{
  const root=await mkdtemp(join(tmpdir(),'cuna-execution-binding-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const binding={profileId:'default',userId:id(8),workspaceId:id(2),bindingId:id(1),projectId:id(3),localInstanceId:id(4),machineId:id(5),executionWorkspaceId:id(6),remoteRoot:`/workspace/workspaces/${id(6)}`,policyDigest:'a'.repeat(64),generation:1,bindingCreatedAt:'2026-09-04T00:00:00Z',bindingUpdatedAt:'2026-09-04T00:00:00Z'};
  const saved=await persistWorkspaceBinding({root,binding,expected:null});
  assert.equal(saved.schemaVersion,3);
  const loaded=await loadWorkspaceBindingIntent({startPath:root,profileId:'default',userId:id(8),workspaceId:id(2)});
  assert.equal(loaded.record.executionWorkspaceId,id(6));
  const before=await readFile(join(root,'.cuna/workspace.json'));
  await assert.rejects(persistWorkspaceBinding({root,binding:{...binding,executionWorkspaceId:id(7),remoteRoot:`/workspace/workspaces/${id(7)}`},expected:workspaceBindingCompareAndSwap(saved)}));
  assert.deepEqual(await readFile(join(root,'.cuna/workspace.json')),before);
});
test('binding distinguishes execution Workspace from account and Project',()=>{
  const a=decodeWorkspaceBindingAuthority(wire());
  assert.equal(a.executionWorkspaceId,id(6));
  assert.equal(a.workspaceId,id(2));
  assert.equal(decodeWorkspaceBindingAuthority(wire(null)).executionWorkspaceId,null);
});
test('missing execution identity and crossed roots fail closed',()=>{
  const missing=wire(null);delete missing.execution_workspace_id;
  for(const value of [missing,{...wire(),remote_root:`/workspace/projects/${id(3)}`},{...wire(null),remote_root:`/workspace/workspaces/${id(6)}`},{...wire(),execution_workspace_id:id(7)}])assert.throws(()=>decodeWorkspaceBindingAuthority(value));
});
test('explicit Workspace adoption is transmitted and response bound to requested identity',async()=>{
  const requests=[];
  const input={workspaceId:id(2),projectId:id(3),localInstanceId:id(4),machineId:id(5),executionWorkspaceId:id(6),exclusionPolicyDigest:'a'.repeat(64),excludedPrefixes:[]};
  let response=wire();
  const client=createCunaApiClient({async request(request){requests.push(request);return response;}});
  await client.createWorkspaceBinding(input,'execution-workspace-adoption-1');
  assert.equal(requests[0].body.execution_workspace_id,id(6));
  response=wire(id(7));
  await assert.rejects(client.createWorkspaceBinding(input,'execution-workspace-adoption-2'));
  await assert.rejects(client.createWorkspaceBinding({...input,executionWorkspaceId:'invalid'},'execution-workspace-adoption-3'));
  assert.equal(requests.length,2);
});
