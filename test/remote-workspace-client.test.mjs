import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createCunaApiClient} from '../dist/api/client.js';
import {decodeAgentSessionWorkspaceContext} from '../dist/api/remote-workspace.js';
const id=n=>`${n}0000000-0000-4000-8000-000000000001`;
const root=`/workspace/workspaces/${id(4)}`;
const workspace={machine_id:id(1),workspace_id:id(2),project_id:id(3),execution_workspace_id:id(4),remote_root:root,
  origin:'machine_create',initialization:'empty',machine_generation:'2',workspace_generation:1,manifest_root:'a'.repeat(64),policy_digest:'b'.repeat(64),publication_status:'pending',publication_epoch:null,reason:null};
const session={id:id(5),machine_id:id(1),name:'Remote Codex',agent:'codex',cwd:root,auth_mode:'interactive_login',desired_state:'running',request_state:'launch_pending',process_state:'unknown',row_version:1,created_at:'2026-09-05T00:00:00Z',updated_at:'2026-09-05T00:00:00Z'};
const envelope={agent_session:session,execution_workspace_id:id(4),workspace_generation:1,remote_root:root};
const input={agent:'codex',cwd:root,authMode:'interactive_login',executionWorkspaceId:id(4),workspaceGeneration:1};

test('session context consumes the producer schema including Machine authority',async()=>{
  const contract=JSON.parse(await readFile(new URL('../contracts/infra/cuna-api.openapi.json',import.meta.url),'utf8'));
  const schema=contract.components.schemas.AgentSessionWorkspaceContext;
  const wire={agent_session_id:id(5),machine_id:id(1),execution_workspace_id:id(4),workspace_generation:2,remote_root:root};
  assert.deepEqual(Object.keys(wire).sort(),[...schema.required].sort());
  assert.deepEqual(Object.keys(wire).sort(),Object.keys(schema.properties).sort());
  assert.equal(decodeAgentSessionWorkspaceContext(wire).machineId,id(1));
  const {machine_id,...withoutMachine}=wire;
  assert.equal(machine_id,id(1));assert.throws(()=>decodeAgentSessionWorkspaceContext(withoutMachine));
  assert.throws(()=>decodeAgentSessionWorkspaceContext({...wire,machine_id:id(5)}));
  assert.throws(()=>decodeAgentSessionWorkspaceContext({...wire,extra:'unowned'}));
});

test('default discovery preserves pending and requires exact readiness evidence',async()=>{
  let response=workspace;const requests=[];
  const client=createCunaApiClient({async request(r){requests.push(r);return response;}});
  const signal=new AbortController().signal;
  assert.equal((await client.getMachineDefaultWorkspace(id(1),signal)).publicationStatus,'pending');
  assert.equal(requests[0].path,`/v1/sessions/${id(1)}/default-workspace`);assert.equal(requests[0].signal,signal);
  response={...workspace,publication_status:'ready',publication_epoch:3};assert.equal((await client.getMachineDefaultWorkspace(id(1))).publicationEpoch,3);
  for(const change of [{machine_id:id(6)},{remote_root:'/workspace'},{publication_status:'ready'},{publication_epoch:1},{reason:'workspace.failed'},{project_id:id(2)},{local_path:'C:/project'},{machine_generation:'2.1'}]){
    response={...workspace,...change};await assert.rejects(client.getMachineDefaultWorkspace(id(1)));
  }
});
test('direct create sends no local binding and rejects substituted authority',async()=>{
  let response=envelope;const requests=[];const client=createCunaApiClient({async request(r){requests.push(r);return response;}});
  const created=await client.createAgentSessionInWorkspace(id(1),input,id(7));
  assert.equal(created.agentSessionId,id(5));assert.equal(created.agentSession.workspaceBindingId,undefined);
  assert.equal(requests[0].path,`/v1/sessions/${id(1)}/workspace-agent-sessions`);assert.equal(requests[0].idempotencyKey,id(7));
  assert.deepEqual(requests[0].body,{agent:'codex',cwd:root,execution_workspace_id:id(4),workspace_generation:1,auth_mode:'interactive_login'});
  for(const change of [{execution_workspace_id:id(6)},{workspace_generation:2},{agent_session:{...session,machine_id:id(6)}},{agent_session:{...session,cwd:root+'/other'}},{agent_session:{...session,workspace_binding_id:id(8),workspace_generation:1}}]){
    response={...envelope,...change};await assert.rejects(client.createAgentSessionInWorkspace(id(1),input,id(7)));
  }
  const before=requests.length;
  for(const change of [{cwd:'/workspace'},{cwd:root+'/../other'},{cwd:root+'/.'},{authMode:'credential_binding'},{agent:'openclaw'},{workspaceGeneration:0}])await assert.rejects(client.createAgentSessionInWorkspace(id(1),{...input,...change},id(7)));
  assert.equal(requests.length,before);
});
test('context read binds the exact session and preserves its admitted generation',async()=>{
  let response={agent_session_id:id(5),machine_id:id(1),execution_workspace_id:id(4),workspace_generation:2,remote_root:root};
  const client=createCunaApiClient({async request(r){assert.equal(r.path,`/v1/agent-sessions/${id(5)}/workspace-context`);return response;}});
  assert.equal((await client.getAgentSessionWorkspaceContext(id(5))).workspaceGeneration,2);
  response={...response,agent_session_id:id(6)};await assert.rejects(client.getAgentSessionWorkspaceContext(id(5)));
});
