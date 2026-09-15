import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {createCunaApiClient} from '../dist/api/client.js';
import {decodeManagedExecution,decodeManagedExecutionPage,decodeManagedCommandResult} from '../dist/api/managed-executions.js';
import {parseArgv} from '../dist/cli/parser.js';
import {preflightInvocation,executeCommand} from '../dist/commands/commands.js';

const id=n=>`${n}0000000-0000-4000-8000-000000000001`;
const row={operation_id:id(2),machine_id:id(1),execution_workspace_id:id(3),leader_state:'exited',
  ownership_state:'descendants_live',cancel_requested:false,exit_code:0,duration_ms:8,reason:null,
  created_at:'2026-09-05T00:00:00.000+00:00',observed_at:'2026-09-05T00:00:01Z'};
const page={machine_id:id(1),items:[row],next_cursor:null};
function setup(response=page){const requests=[];return {requests,client:createCunaApiClient({async request(r){requests.push(r);return typeof response==='function'?response(r):response;}})};}
const context=(argv,client)=>({parsed:parseArgv(argv),client,now:0,credentialMode:'interactive',config:{}});
const command={command:'printf',args:['%s','literal ; argument'],cwd:`/workspace/workspaces/${id(3)}`,timeoutSecs:5};
const commandResult={exit_code:7,stdout:'output\n',stderr:'diagnostic\n',duration_ms:9,stdout_truncated:false,stderr_truncated:true};

test('launch sends the preallocated operation ID with literal arguments and an exact recovery command',async()=>{
  const {client,requests}=setup(commandResult);const signal=new AbortController().signal;
  const result=await client.executeManagedCommand(id(1),id(2),command,signal);
  assert.deepEqual(requests[0],{method:'POST',path:`/v1/sessions/${id(1)}/exec`,body:{
    operation_id:id(2),command:'printf',args:['%s','literal ; argument'],cwd:command.cwd,timeout_secs:5},
    budgetMs:10000,settleWith:`cuna executions get ${id(2)} --machine ${id(1)}`,signal});
  assert.equal(result.exitCode,7);assert.equal(result.stderrTruncated,true);
  assert.equal(Object.hasOwn(result,'ownershipState'),false,'a result cannot invent process cleanup');
  const contract=JSON.parse(await readFile(new URL('../contracts/infra/cuna-api.openapi.json',import.meta.url),'utf8'));
  assert.equal(contract.components.schemas.ExecRequest.properties.operation_id.$ref,'#/components/schemas/Uuid');
  assert.deepEqual(Object.keys(commandResult).sort(),[...contract.components.schemas.ExecResult.required].sort());
});

test('invalid launch rejects before transport without echoing command contents',async()=>{
  const {client,requests}=setup(commandResult);
  for(const change of [{command:''},{command:'private\0value'},{args:['private\0value']},{args:'private'},
    {cwd:'/workspace'},{cwd:command.cwd+'/../sibling'},{cwd:command.cwd+'/.'},{cwd:command.cwd+'\\file'},
    {cwd:command.cwd+'\nforged'},{timeoutSecs:0},{timeoutSecs:601},{timeoutSecs:1.5}]){
    await assert.rejects(client.executeManagedCommand(id(1),id(2),{...command,...change}),error=>{
      assert.equal(error.code,'cuna.usage.invalid');assert.doesNotMatch(error.message,/private|forged/);return true;
    });
  }
  await assert.rejects(client.executeManagedCommand(id(1),'invalid',command));
  await assert.rejects(client.executeManagedCommand('invalid',id(2),command));
  assert.equal(requests.length,0);
});

test('unknown launch outcome is never automatically replayed or replaced by a new ID',async()=>{
  const {client,requests}=setup(()=>{throw new Error('synthetic response loss');});
  await assert.rejects(client.executeManagedCommand(id(1),id(2),command),/synthetic response loss/);
  assert.equal(requests.length,1);assert.equal(requests[0].body.operation_id,id(2));
  assert.equal(requests[0].settleWith,`cuna executions get ${id(2)} --machine ${id(1)}`);
});

test('result decoder retains output as data and refuses malformed completion evidence',()=>{
  const output='\x1b]52;c;ZmFrZQ==\x07';
  assert.equal(decodeManagedCommandResult({...commandResult,stdout:output}).stdout,output);
  for(const change of [{exit_code:0.5},{exit_code:null},{duration_ms:-1},{duration_ms:Number.MAX_SAFE_INTEGER+1},
    {stdout:[]},{stderr:null},{stdout_truncated:0},{stderr_truncated:'false'},{operation_id:id(2)}]){
    assert.throws(()=>decodeManagedCommandResult({...commandResult,...change}));
  }
  for(const key of Object.keys(commandResult)){const value={...commandResult};delete value[key];assert.throws(()=>decodeManagedCommandResult(value));}
});

test('managed execution fixture matches all producer fields; exit retains descendant ownership',async()=>{
  const contract=JSON.parse(await readFile(new URL('../contracts/infra/cuna-api.openapi.json',import.meta.url),'utf8'));
  for(const [name,value] of [['ManagedExecution',row],['ManagedExecutionPage',page]]){
    const schema=contract.components.schemas[name];
    assert.deepEqual(Object.keys(value).sort(),[...schema.required].sort());
    assert.deepEqual(Object.keys(value).sort(),Object.keys(schema.properties).sort());
    assert.equal(schema.additionalProperties,false);
  }
  assert.equal(decodeManagedExecution(row).ownershipState,'descendants_live');
  assert.equal(decodeManagedExecution({...row,execution_workspace_id:null}).executionWorkspaceId,null);
});

test('managed execution rejects invalid state pairs and unsafe or missing metadata',()=>{
  for(const change of [{leader_state:'running',ownership_state:'cleared'},{leader_state:'admitted',ownership_state:'unknown'},
    {leader_state:'toString'},{ownership_state:'destroyed'},{cancel_requested:'true'},{exit_code:0.5},
    {duration_ms:-1},{duration_ms:Number.MAX_SAFE_INTEGER+1},{created_at:'tomorrow'},
    {observed_at:'2026-09-05T00:00:00Z\u001b[2J'},{reason:'managed_exec_failed\nspoof'},
    {reason:'credential contents'},{operation_id:'OTHER'},{command:'must not be exposed'}]){
    assert.throws(()=>decodeManagedExecution({...row,...change}),JSON.stringify(change));
  }
  for(const key of Object.keys(row)){const value={...row};delete value[key];assert.throws(()=>decodeManagedExecution(value),key);}
});

test('inventory refuses duplicate, reversed, foreign and unbounded pages or invented cursors',()=>{
  for(const change of [{items:[row,row]},{items:[{...row,operation_id:id(4)},row]},
    {items:[{...row,machine_id:id(4)}]},{items:Array(51).fill(row)},
    {items:[],next_cursor:id(2)},{next_cursor:id(4)},{next_cursor:'opaque'}, {output:'forbidden'}]){
    assert.throws(()=>decodeManagedExecutionPage({...page,...change}));
  }
  assert.equal(decodeManagedExecutionPage({...page,next_cursor:id(2)}).nextCursor,id(2));
});

test('list binds request Machine, Workspace filter and cursor and forwards cancellation',async()=>{
  const {client,requests}=setup();const signal=new AbortController().signal;
  const result=await client.listManagedExecutions(id(1),{executionWorkspaceId:id(3),after:id(1)},signal);
  assert.equal(result.items[0].ownershipState,'descendants_live');
  assert.equal(requests[0].method,'GET');assert.equal(requests[0].signal,signal);
  const url=new URL(requests[0].path,'https://fixture.invalid');
  assert.equal(url.pathname,`/v1/sessions/${id(1)}/executions`);
  assert.equal(url.searchParams.get('execution_workspace_id'),id(3));assert.equal(url.searchParams.get('after'),id(1));
  for(const input of [{executionWorkspaceId:id(4)},{after:id(2)}])await assert.rejects(client.listManagedExecutions(id(1),input));
  await assert.rejects(client.listManagedExecutions(id(4)));
});

test('get and cancel bind both identities and cancellation acceptance never proves cleanup',async()=>{
  const {client,requests}=setup(r=>({...row,cancel_requested:r.method==='POST'}));
  const signal=new AbortController().signal;
  assert.equal((await client.getManagedExecution(id(1),id(2),signal)).cancelRequested,false);
  const cancelled=await client.cancelManagedExecution(id(1),id(2),signal);
  assert.equal(cancelled.cancelRequested,true);assert.equal(cancelled.ownershipState,'descendants_live');
  assert.equal(requests[0].path,`/v1/sessions/${id(1)}/executions/${id(2)}`);
  assert.equal(requests[1].path,requests[0].path+'/cancel');assert.deepEqual(requests[1].body,{});
  assert.equal(requests[1].signal,signal);assert.equal(requests[1].settleWith,`cuna executions get ${id(2)} --machine ${id(1)}`);
  for(const method of ['getManagedExecution','cancelManagedExecution']){
    await assert.rejects(client[method](id(4),id(2)));
    await assert.rejects(client[method](id(1),id(4)));
  }
  await assert.rejects(setup(row).client.cancelManagedExecution(id(1),id(2)));
});

test('invalid identifiers refuse before any transport and uncertain cancellation is never replayed',async()=>{
  const {client,requests}=setup();
  for(const args of [['bad',{}],[id(1),{after:'bad'}],[id(1),{executionWorkspaceId:'bad'}]])await assert.rejects(client.listManagedExecutions(...args));
  for(const method of ['getManagedExecution','cancelManagedExecution']){
    await assert.rejects(client[method]('bad',id(2)));await assert.rejects(client[method](id(1),'bad'));
  }
  assert.equal(requests.length,0);
  const failed=setup(()=>{throw new Error('connection lost');});
  await assert.rejects(failed.client.cancelManagedExecution(id(1),id(2)),/connection lost/);
  assert.equal(failed.requests.length,1);
});

test('recovery commands preserve leader and ownership, work without new-exec capability and retain filters',async()=>{
  const {client,requests}=setup({...page,next_cursor:id(2)});
  const result=await executeCommand(context(['executions','list','--machine',id(1),'--execution-workspace-id',id(3)],client));
  assert.match(result.human,/leader=exited\townership=descendants_live/);
  assert.match(result.human,new RegExp(`--execution-workspace-id ${id(3)} --after ${id(2)}`));
  assert.equal(result.data.items[0].exit_code,0);assert.equal(result.data.items[0].ownership_state,'descendants_live');
  assert.equal(requests.length,1);assert.match(requests[0].path,/\/executions\?/);
  const cancel=await executeCommand(context(['executions','cancel',id(2),'--machine',id(1),'--yes'],setup({...row,cancel_requested:true}).client));
  assert.match(cancel.human,/Cancellation accepted/);assert.match(cancel.human,/cleanup is not confirmed/);
  assert.doesNotMatch(cancel.human,/ownership is cleared/);
  const cleared=await executeCommand(context(['executions','get',id(2),'--machine',id(1)],setup({...row,ownership_state:'cleared'}).client));
  assert.match(cleared.human,/ownership is cleared/);
});

test('execution command preflight enforces exact target, no stray operands and explicit cancellation confirmation',async()=>{
  for(const argv of [['executions','list'],['executions','list','stray','--machine',id(1)],
    ['executions','list','--machine',id(1),'--after','bad'],['executions','get',id(2),'--machine','bad'],
    ['executions','cancel',id(2),'--machine',id(1)],['executions','cancel',id(2),'--machine',id(1),'--yes','--all'],
    ['executions','get',id(2),'--machine',id(1),'--after',id(4)]]){
    assert.throws(()=>preflightInvocation(parseArgv(argv)),argv.join(' '));
  }
  const {client,requests}=setup(row);
  await assert.rejects(executeCommand({...context(['executions','get',id(2),'--machine',id(1)],client),credentialMode:undefined}));
  assert.equal(requests.length,0);
});
