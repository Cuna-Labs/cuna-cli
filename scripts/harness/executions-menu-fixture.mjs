import {appendFile,readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {createPlatformAdapter} from '../../dist/platform/adapter.js';
import {runCli} from '../../dist/index.js';
import {runProcessCli} from '../../dist/cli/process-entrypoint.js';
import {createCunaApiClient} from '../../dist/api/client.js';
const [ledger,mode='root']=process.argv.slice(2);
if(!ledger)throw new Error('fixture requires an owned ledger path');
const id=n=>`${n}0000000-0000-4000-8000-000000000001`;
const record=(event,details={})=>appendFile(ledger,JSON.stringify({timestamp:new Date().toISOString(),pid:process.pid,event,...details})+'\n');
let cancelled=false,readsAfterCancel=0;
let launched;
const row=()=>({operation_id:id(2),machine_id:id(1),execution_workspace_id:id(3),leader_state:'exited',
  ownership_state:readsAfterCancel?'cleared':'descendants_live',cancel_requested:cancelled,exit_code:0,duration_ms:8,
  reason:null,created_at:'2026-09-05T00:00:00Z',observed_at:'2026-09-05T00:00:01Z'});
const recovery=createCunaApiClient({async request(r){
  await record('request',{method:r.method,path:r.path});
  if(r.path===`/v1/sessions/${id(1)}/exec`&&r.method==='POST'){
    const body=r.body;launched=body.operation_id;
    const files=await readdir(path.join(path.dirname(ledger),'state','executions'),{recursive:true});
    const name=files.find(file=>file.endsWith(`${launched}.json`));
    if(!name)throw Error('No durable receipt before dispatch');
    const receipt=JSON.parse(await readFile(path.join(path.dirname(ledger),'state','executions',name),'utf8'));
    if(receipt.operationId!==launched||receipt.machineId!==id(1))throw Error('Wrong receipt');
    await record('receipt-before-dispatch',{operationId:launched});
    if(mode==='launch-lost')throw Error('synthetic response loss');
    return {exit_code:4,stdout:'remote fixture output\n',stderr:'',duration_ms:1,stdout_truncated:false,stderr_truncated:false};
  }
  if(launched&&r.path===`/v1/sessions/${id(1)}/executions/${launched}`)return {...row(),operation_id:launched};
  if(mode.startsWith('reopen')&&r.method==='GET'&&r.path.startsWith(`/v1/sessions/${id(1)}/executions/`)){
    if(mode==='reopen-absent')throw Error('synthetic absent execution');
    return {...row(),operation_id:r.path.split('/').at(-1)};
  }
  if(r.path===`/v1/sessions/${id(1)}/executions`)return {machine_id:id(1),items:[row()],next_cursor:null};
  if(r.path===`/v1/sessions/${id(1)}/executions/${id(2)}/cancel`&&r.method==='POST'){
    cancelled=true;if(mode==='lost')throw new Error('synthetic response loss');return row();
  }
  if(r.path===`/v1/sessions/${id(1)}/executions/${id(2)}`&&r.method==='GET'){
    if(cancelled)readsAfterCancel++;return row();
  }
  throw new Error('unexpected fixture route');
}});
const client={...recovery,
  async getIdentity(){return {id:id(4),workspaceId:id(5)};},
  async getMachineDefaultWorkspace(){return {machineId:id(1),workspaceId:id(5),executionWorkspaceId:id(3),
    remoteRoot:`/workspace/workspaces/${id(3)}`,workspaceGeneration:1,machineGeneration:'1',publicationStatus:'ready'};},
  async listMachines(){return {items:[{id:id(1),name:'execution-menu-fixture',state:'running',agent:'claude-code'}]};},
  async listAgentSessions(){return {items:[]};},
  async discoverCapabilities(subjectScope,subjectId){const now=Date.now();return {schemaVersion:'1.0',subjectScope,subjectId,
    observedAt:new Date(now-100).toISOString(),expiresAt:new Date(now+30000).toISOString(),etag:'fixture',capabilities:
      [['machines.default_workspace.read','read_only'],['machines.exec','native']].map(([id,interaction])=>({id,interaction,
        availability:'supported',mutationClass:'none',surfaces:['cli'],requiredPermissions:[]}))};},
};
process.exitCode=await runProcessCli(mode==='machines'?['machines']:[],{stdin:process.stdin,run:async(argv,deps)=>runCli(argv,{
  ...deps,env:{CUNA_API_KEY:'cuna_sk_abcdefghijklmnop',CUNA_TERMINAL_MODE:'rich'},
  platform:{...createPlatformAdapter(),paths:{configDirectory:path.join(path.dirname(ledger),'config'),stateDirectory:path.join(path.dirname(ledger),'state'),runtimeDirectory:path.join(path.dirname(ledger),'runtime')}},
  clientFactory:()=>client,
})});
await record('exit',{code:process.exitCode});
