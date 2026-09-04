import assert from 'node:assert/strict';
import test from 'node:test';
import {createCunaApiClient} from '../dist/api/client.js';
const id=n=>`${n}0000000-0000-4000-8000-000000000001`;
const item={execution_workspace_id:id(6),workspace_id:id(2),project_id:id(3),machine_id:id(5),remote_root:`/workspace/workspaces/${id(6)}`,active_generation:1,active_manifest_root:'a'.repeat(64),exclusion_policy_digest:'b'.repeat(64),created_at:'2026-09-04T00:00:00Z'};
const scope={workspaceId:id(2),projectId:id(3),machineId:id(5)};
test('discovery sends exact account/Project/Machine scope and returns authoritative execution identity',async()=>{
  const requests=[];
  const client=createCunaApiClient({async request(r){requests.push(r);return {items:[item],next_cursor:null};}});
  const page=await client.listExecutionWorkspaces(scope);
  assert.equal(page.items[0].executionWorkspaceId,id(6));
  assert.equal(page.nextCursor,null);
  assert.equal(requests[0].method,'GET');
  const url=new URL(requests[0].path,'https://api.getcuna.com');
  assert.equal(url.pathname,'/v1/execution-workspaces');
  assert.deepEqual(Object.fromEntries(url.searchParams),{workspace_id:id(2),project_id:id(3),machine_id:id(5)});
});
test('discovery rejects wrong scope, root, duplicate entries, missing cursor and backward continuation',async()=>{
  let response;
  const client=createCunaApiClient({async request(){return response;}});
  for(const bad of [{items:[{...item,project_id:id(7)}],next_cursor:null},{items:[{...item,remote_root:'/workspace'}],next_cursor:null},{items:[item,item],next_cursor:null},{items:[item]},{items:[item],next_cursor:id(7)}]){
    response=bad;await assert.rejects(client.listExecutionWorkspaces(scope));
  }
  response={items:[item],next_cursor:null};
  await assert.rejects(client.listExecutionWorkspaces({...scope,after:id(6)}));
});
