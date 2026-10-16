import assert from 'node:assert/strict';
import test from 'node:test';
import {createCunaApiClient} from '../dist/api/client.js';
import {createHttpTransport} from '../dist/api/http.js';
import {decodeExecutionWorkspacePage} from '../dist/api/execution-workspaces.js';
import {listWorkspaceSelections} from '../dist/workspace/selection-service.js';
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
  assert.equal(requests[0].path,'/v1/execution-workspaces');
  assert.deepEqual(requests[0].query,{workspace_id:id(2),project_id:id(3),machine_id:id(5)});
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

function composed(response=()=>({items:[item],next_cursor:null})){
  const requests=[];
  const transport=createHttpTransport({baseUrl:'http://127.0.0.1:9',fetch:async(input,init)=>{
    const url=new URL(String(input));
    assert.equal(url.origin,'http://127.0.0.1:9');
    assert.equal(init.method,'GET');
    assert.equal(new Headers(init.headers).has('authorization'),false);
    requests.push({path:url.pathname,query:Object.fromEntries(url.searchParams)});
    return new Response(JSON.stringify(response(url)),{status:200,headers:{'content-type':'application/json'}});
  }});
  return {client:createCunaApiClient(transport),transport,requests};
}
test('unqueried SDK read reaches the actual transport fake fetch',async()=>{
  const {client,requests}=composed(()=>({id:id(1),email:'fixture@example.test',workspace:{assigned:true,id:id(2),usage:{}}}));
  const identity=await client.getIdentity();
  assert.equal(identity.id,id(1));
  assert.deepEqual(requests,[{path:'/v1/me',query:{}}]);
});
for(const after of [undefined,id(4)])test(`discovery composes with the real transport ${after===undefined?'on the first page':'with a continuation'}`,async()=>{
  const {client,requests}=composed();
  const page=await client.listExecutionWorkspaces({...scope,...(after===undefined?{}:{after})});
  assert.equal(page.items[0].executionWorkspaceId,id(6));
  assert.equal(page.nextCursor,null);
  assert.deepEqual(requests,[{path:'/v1/execution-workspaces',query:{workspace_id:id(2),project_id:id(3),machine_id:id(5),...(after===undefined?{}:{after})}}]);
});
test('transport rejects search text in the path before fetch',async()=>{
  const {transport,requests}=composed();
  await assert.rejects(transport.request({method:'GET',path:`/v1/execution-workspaces?workspace_id=${id(2)}`}),error=>error?.code==='cuna.internal.invalid_api_path');
  assert.equal(requests.length,0);
});
test('the declared transport query slot preserves exact scope for the real decoder',async()=>{
  const {transport,requests}=composed();
  const query={workspace_id:id(2),project_id:id(3),machine_id:id(5),after:id(4)};
  const page=decodeExecutionWorkspacePage(await transport.request({method:'GET',path:'/v1/execution-workspaces',query}));
  assert.equal(page.items[0].executionWorkspaceId,id(6));
  assert.deepEqual(requests,[{path:'/v1/execution-workspaces',query}]);
});
test('workspace selection uses the actual client and transport across complete discovery pages',async()=>{
  const second={...item,execution_workspace_id:id(7),remote_root:`/workspace/workspaces/${id(7)}`};
  const {client,requests}=composed(url=>url.searchParams.has('after')?{items:[second],next_cursor:null}:{items:[item],next_cursor:id(6)});
  const controller=new AbortController();
  const page=await listWorkspaceSelections({client,workspaceId:id(2),machineId:id(5)},{projectId:id(3)},controller.signal);
  assert.deepEqual(page.map(row=>row.executionWorkspaceId),[id(6),id(7)]);
  assert.deepEqual(requests,[
    {path:'/v1/execution-workspaces',query:{workspace_id:id(2),project_id:id(3),machine_id:id(5)}},
    {path:'/v1/execution-workspaces',query:{workspace_id:id(2),project_id:id(3),machine_id:id(5),after:id(6)}},
  ]);
});
