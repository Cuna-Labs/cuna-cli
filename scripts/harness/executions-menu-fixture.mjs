import {appendFile} from 'node:fs/promises';
import {runCli} from '../../dist/index.js';
import {runProcessCli} from '../../dist/cli/process-entrypoint.js';
import {createCunaApiClient} from '../../dist/api/client.js';
const [ledger,mode='root']=process.argv.slice(2);
if(!ledger)throw new Error('fixture requires an owned ledger path');
const id=n=>`${n}0000000-0000-4000-8000-000000000001`;
const record=(event,details={})=>appendFile(ledger,JSON.stringify({timestamp:new Date().toISOString(),pid:process.pid,event,...details})+'\n');
let cancelled=false,readsAfterCancel=0;
const row=()=>({operation_id:id(2),machine_id:id(1),execution_workspace_id:id(3),leader_state:'exited',
  ownership_state:readsAfterCancel?'cleared':'descendants_live',cancel_requested:cancelled,exit_code:0,duration_ms:8,
  reason:null,created_at:'2026-09-05T00:00:00Z',observed_at:'2026-09-05T00:00:01Z'});
const recovery=createCunaApiClient({async request(r){
  await record('request',{method:r.method,path:r.path});
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
  async listMachines(){return {items:[{id:id(1),name:'execution-menu-fixture',state:'running',agent:'claude-code'}]};},
  async listAgentSessions(){return {items:[]};},
  async discoverCapabilities(subjectScope,subjectId){const now=Date.now();return {schemaVersion:'1.0',subjectScope,subjectId,
    observedAt:new Date(now-100).toISOString(),expiresAt:new Date(now+30000).toISOString(),etag:'fixture',capabilities:[]};},
};
process.exitCode=await runProcessCli(mode==='machines'?['machines']:[],{stdin:process.stdin,run:async(argv,deps)=>runCli(argv,{
  ...deps,env:{CUNA_API_KEY:'cuna_sk_abcdefghijklmnop',CUNA_TERMINAL_MODE:'rich'},
  platform:{kind:'windows',paths:{configDirectory:'unused',stateDirectory:'unused',runtimeDirectory:'unused'},async readSafeConfig(){return {exists:false};}},
  clientFactory:()=>client,
})});
await record('exit',{code:process.exitCode});
