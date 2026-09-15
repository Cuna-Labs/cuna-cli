import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiTerminalControlPlane } from '../dist/runtime/api-terminal-control-plane.js';

function fixture() {
  const now=Date.parse('2026-09-05T00:00:00Z');
  const root='/workspace/workspaces/33333333-3333-4333-8333-333333333333';
  const session={id:'session',machineId:'machine',cwd:root,processEpoch:'process',processState:'running',
    runtimeObservedAt:new Date(now-100).toISOString(),runtimeExpiresAt:new Date(now+30000).toISOString(),rowVersion:1};
  let context={agentSessionId:'session',machineId:'machine',executionWorkspaceId:root.split('/').at(-1),workspaceGeneration:3,remoteRoot:root};
  let reads=0,capability=true;
  const client={
    async getIdentity(){return {id:'user',workspaceAssigned:true};},
    async getAgentSession(){return {...session};},
    async discoverCapabilities(){return {schemaVersion:'1.0',subjectScope:'agent_session',subjectId:'session',
      observedAt:new Date(now-100).toISOString(),expiresAt:new Date(now+30000).toISOString(),etag:'fixture',capabilities:capability?[{
        id:'agent_sessions.workspace.read',availability:'supported',interaction:'read_only',mutationClass:'none',surfaces:['cli'],requiredPermissions:[],
      }]:[]};},
    async getAgentSessionWorkspaceContext(){reads++;return {...context};},
  };
  return {plane:createApiTerminalControlPlane({client,clock:()=>now}),session,
    change:value=>{context={...context,...value};},deny:()=>{capability=false;},reads:()=>reads};
}
test('terminal rereads admitted Workspace and rejects changed revision on reconnect',async()=>{
  const f=fixture();await f.plane.observeAgentSession('session');
  f.change({workspaceGeneration:4});
  await assert.rejects(f.plane.observeAgentSession('session'),{code:'session_discontinuous'});
});
test('unchanged remote context remains observable without fabricating a local binding',async()=>{
  const f=fixture();await f.plane.observeAgentSession('session');
  const observation=await f.plane.observeAgentSession('session');
  assert.equal(f.reads(),2);assert.equal(observation.workspaceBindingId,null);assert.equal(observation.workspaceBindingGeneration,null);
});
test('foreign context or missing capability cannot admit remote terminal authority',async()=>{
  for(const value of [{machineId:'other'},{agentSessionId:'other'},{remoteRoot:'/root'},{executionWorkspaceId:'other'}]){
    const f=fixture();f.change(value);await assert.rejects(f.plane.observeAgentSession('session'));
  }
  const f=fixture();f.deny();await assert.rejects(f.plane.observeAgentSession('session'));assert.equal(f.reads(),0);
});
test('legacy root avoids remote lookup but cannot replace an already admitted remote root',async()=>{
  const f=fixture();f.session.cwd='/workspace';await f.plane.observeAgentSession('session');assert.equal(f.reads(),0);
  const remote=fixture();await remote.plane.observeAgentSession('session');remote.session.cwd='/workspace';
  await assert.rejects(remote.plane.observeAgentSession('session'));
});
