import assert from 'node:assert/strict';
import test from 'node:test';
import { launchRemoteWorkspaceSession } from '../dist/journey/remote-workspace.js';
import { CunaError } from '../dist/core/errors.js';

function fixture() {
  const calls=[]; let clock=Date.parse('2026-09-05T00:00:00Z');
  const workspace={machineId:'machine',workspaceId:'account-workspace',executionWorkspaceId:'execution',
    remoteRoot:'/workspace/workspaces/execution',workspaceGeneration:1,publicationStatus:'ready'};
  const session={id:'session',machineId:'machine',agent:'opencode',cwd:workspace.remoteRoot,
    authMode:'interactive_login',requestState:'launch_pending',processState:'unknown'};
  const client={
    async discoverCapabilities(scope,id) { calls.push(['gate',scope,id]); return {
      schemaVersion:'1.0',subjectScope:scope,subjectId:id,observedAt:new Date(clock).toISOString(),
      expiresAt:new Date(clock+60000).toISOString(),etag:'test',capabilities:[
        ['machines.default_workspace.read','read_only'],['agent_sessions.workspace.create','native'],['agent_sessions.workspace.read','read_only']
      ].map(([id,interaction])=>({id,interaction,availability:'supported',mutationClass:'none',surfaces:['cli'],requiredPermissions:[]}))}; },
    async getMachineDefaultWorkspace(){calls.push(['workspace']);return workspace;},
    async createProviderSessionV2(machine,input,key){calls.push(['create',machine,input,key]);return {agentSession:session};},
    async inspectAgentSessionCreate(key){calls.push(['inspect',key]);return session;},
    async getAgentSessionWorkspaceContext(id){calls.push(['context',id]);return {
      agentSessionId:id,machineId:'machine',executionWorkspaceId:workspace.executionWorkspaceId,remoteRoot:workspace.remoteRoot,workspaceGeneration:1};},
    async getAgentSession(id){calls.push(['session',id]);return {...session,processState:'running'};},
  };
  const input={client,machineId:'machine',workspaceId:'account-workspace',agent:'opencode',idempotencyKey:'one-key',preset:{label:'OpenCode Zen / Big Pickle',profile_id:'profile',profile_revision:1},
    now:()=>clock,sleep:async ms=>{calls.push(['sleep']);clock+=ms;}};
  return {input,client,workspace,session,calls};
}
test('remote launch waits for publication and attaches only the admitted ready identity',async()=>{
  const f=fixture();let reads=0;const progress=[];
  f.input.onProgress=message=>progress.push(message);
  f.client.getMachineDefaultWorkspace=async()=>({...f.workspace,publicationStatus:++reads===1?'pending':'ready'});
  assert.equal(await launchRemoteWorkspaceSession(f.input),'session');
  assert.equal(reads,2);const create=f.calls.find(c=>c[0]==='create');
  assert.equal(create[2].operation_id,'one-key');assert.equal(create[2].execution_workspace_id,'execution');
  assert.equal(create[2].profile_id,'profile');assert.equal(create[2].profile_revision,1);
  assert.deepEqual(f.calls.filter(c=>c[0]==='session'),[['session','session']]);
  assert.ok(progress.some(line=>line.includes('expected provider preset')));

});
test('lost V2 reply replays the exact atomic operation without V1 inspection',async()=>{
  const f=fixture();const posts=[];
  f.client.createProviderSessionV2=async(machine,input,key)=>{posts.push([machine,input,key]);if(posts.length===1)throw new CunaError({code:'cuna.network.failed',message:'lost',exitCode:5});return {agentSession:f.session};};
  f.client.inspectAgentSessionCreate=async()=>{assert.fail('V1 inspection forbidden');};
  assert.equal(await launchRemoteWorkspaceSession(f.input),'session');assert.deepEqual(posts[0],posts[1]);
});
test('foreign authority, failed publication, missing capability and cancellation never dispatch',async()=>{
  for(const mode of ['foreign','failed','missing','cancel']){
    const f=fixture();
    if(mode==='foreign')f.workspace.workspaceId='other';
    if(mode==='failed')f.workspace.publicationStatus='failed';
    if(mode==='missing'){const discover=f.client.discoverCapabilities;f.client.discoverCapabilities=async(...args)=>({...await discover(...args),capabilities:[]});}
    if(mode==='cancel')f.input.signal=AbortSignal.abort(new Error('cancelled'));
    await assert.rejects(launchRemoteWorkspaceSession(f.input));assert.equal(f.calls.filter(c=>c[0]==='create').length,0);
  }
});
test('pending publication stops at observation budget without claiming a runtime failure',async()=>{
  const f=fixture();f.workspace.publicationStatus='pending';
  await assert.rejects(launchRemoteWorkspaceSession(f.input),e=>e.details.remote_outcome==='unobserved'&&e.retryable===true);
  assert.equal(f.calls.filter(c=>c[0]==='create').length,0);
});
test('terminal or substituted session state never becomes an attachment',async()=>{
  for(const change of [{processState:'exited'},{requestState:'failed'},{machineId:'other'},{id:'other'},{workspaceBindingId:'local'}]){
    const f=fixture();f.client.getAgentSession=async()=>({...f.session,processState:'running',...change});
    await assert.rejects(launchRemoteWorkspaceSession(f.input));
  }
});
test('failed real-session observation preserves reason and exact inspection target without another create',async()=>{
  const f=fixture();
  f.client.getAgentSession=async()=>({...f.session,processState:'failed',terminalReason:'canonical_launch_interrupted'});
  await assert.rejects(launchRemoteWorkspaceSession(f.input),e=>{
    assert.equal(e.code,'cuna.journey.agent_session_failed');
    assert.equal(e.details.reason,'canonical_launch_interrupted');
    assert.equal(e.details.agent_session_id,'session');
    assert.match(e.message,/could not complete the agent launch/);
    assert.match(e.hint,/cuna agent-sessions get session/);
    return true;
  });
  assert.equal(f.calls.filter(c=>c[0]==='create').length,1);
});

test('unsupported agent refuses before any server request',async()=>{const f=fixture();f.input.agent='codex';await assert.rejects(launchRemoteWorkspaceSession(f.input),{code:'cuna.provider.v2_unavailable'});assert.equal(f.calls.length,0);});
