import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm,writeFile,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareManagedCommand} from '../dist/machines/command-launch.js';
import {saveExecutionReceipt,listExecutionReceipts} from '../dist/machines/execution-receipt.js';
import {createPlatformAdapter} from '../dist/platform/adapter.js';
import {runExecutionsScreen} from '../dist/machines/executions-screen.js';
const id=n=>`${n}0000000-0000-4000-8000-000000000001`;
export function fixture(){
  const calls=[],files=new Map();
  const workspace={machineId:id(1),workspaceId:id(2),executionWorkspaceId:id(3),remoteRoot:`/workspace/workspaces/${id(3)}`,
    workspaceGeneration:1,machineGeneration:'1',publicationStatus:'ready'};
  const identity={id:id(4),workspaceId:id(2)};
  const platform={paths:{stateDirectory:join(tmpdir(),'cuna-command-fixture')},
    async readSafeConfig(path){return files.has(path)?{exists:true,text:files.get(path)}:{exists:false};},
    async writeSafeConfig(path,text){calls.push('save');files.set(path,text);}};
  const environment={platform,baseUrl:'https://example.invalid',profile:'default'};
  const client={
    async discoverCapabilities(scope,subjectId){return {schemaVersion:'1.0',subjectScope:scope,subjectId,
      observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30000).toISOString(),etag:'test',capabilities:
      [['machines.default_workspace.read','read_only'],['machines.exec','native']].map(([id,interaction])=>({id,interaction,
        availability:'supported',mutationClass:'none',surfaces:['cli'],requiredPermissions:[]}))};},
    async getIdentity(){return identity;},async getMachineDefaultWorkspace(){return {...workspace};},
    async executeManagedCommand(machine,operation,input){calls.push(['send',machine,operation,input]);return {exitCode:4,stdout:'out',stderr:'err',durationMs:1,stdoutTruncated:false,stderrTruncated:false};},
  };
  return {calls,files,workspace,identity,environment,client};
}
test('receipt and visible acknowledgment precede one send; no command data is persisted',async()=>{
  const f=fixture(),signal=new AbortController().signal,p=await prepareManagedCommand(f.client,id(1),f.environment,signal);
  assert.equal(f.calls.length,0);
  const result=await p.run('printf secret-input',async()=>{f.calls.push('visible');},signal);
  assert.equal(result.exitCode,4);assert.deepEqual(f.calls.slice(0,2),['save','visible']);
  assert.deepEqual(f.calls[2],['send',id(1),p.operationId,{command:'/bin/sh',args:['-c','printf secret-input'],cwd:f.workspace.remoteRoot}]);
  const record=[...f.files.values()][0];assert.doesNotMatch(record,/secret-input|printf|stderr|stdout|example|default/);
  assert.equal(JSON.parse(record).operationId,p.operationId);
  await assert.rejects(p.run('again',async()=>{},signal),/cannot be repeated/);assert.equal(f.calls.length,3);
});
test('disk failure, unreadable readback, hidden receipt, and abort prevent command dispatch',async()=>{
  for(const mode of ['disk','readback','display','abort']){
    const f=fixture(),abort=new AbortController();
    if(mode==='disk')f.environment.platform.writeSafeConfig=async()=>{throw Error('disk');};
    if(mode==='readback')f.environment.platform.readSafeConfig=async()=>({exists:false});
    const p=await prepareManagedCommand(f.client,id(1),f.environment,abort.signal);
    await assert.rejects(p.run('echo hello',async()=>{if(mode==='display')throw Error('screen');if(mode==='abort')abort.abort();},abort.signal));
    assert.equal(f.calls.filter(Array.isArray).length,0,mode);
  }
});
test('changed authority fails before persistence and dispatch',async()=>{
  for(const field of ['workspaceGeneration','machineGeneration','executionWorkspaceId','remoteRoot','publicationStatus','identity']){
    const f=fixture(),signal=new AbortController().signal,p=await prepareManagedCommand(f.client,id(1),f.environment,signal);
    if(field==='identity')f.identity.id=id(5);else f.workspace[field]=field==='workspaceGeneration'?2:'changed';
    await assert.rejects(p.run('echo hello',async()=>{},signal));assert.equal(f.calls.length,0,field);
  }
});
test('lost response retains the original ID and never replays',async()=>{
  const f=fixture(),signal=new AbortController().signal;
  f.client.executeManagedCommand=async(_machine,op)=>{f.calls.push(['send',op]);throw Error('lost');};
  const p=await prepareManagedCommand(f.client,id(1),f.environment,signal);
  await assert.rejects(p.run('echo hello',async()=>{},signal),/lost/);
  await assert.rejects(p.run('echo hello',async()=>{},signal),/cannot be repeated/);
  assert.equal(f.calls.filter(Array.isArray).length,1);assert.equal(JSON.parse([...f.files.values()][0]).operationId,p.operationId);
});
test('native file survives a new adapter; separate attempts cannot overwrite each other',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cuna-execution-receipt-'));
  try{
    const make=()=>({...createPlatformAdapter(),paths:{stateDirectory:root}});
    const scope={baseUrl:'https://example.invalid',profile:'default',userId:id(4)};
    const [a,b]=await Promise.all([saveExecutionReceipt(make(),scope,id(1),id(3),id(6)),saveExecutionReceipt(make(),scope,id(1),id(3),id(7))]);
    assert.notEqual(a,b);assert.equal(JSON.parse(await readFile(a,'utf8')).operationId,id(6));
    assert.equal((await make().readSafeConfig(b,2048)).exists,true);
    await assert.rejects(saveExecutionReceipt(make(),scope,id(1),id(3),id(6)),/already has/);
    const other=await saveExecutionReceipt(make(),{...scope,userId:id(5)},id(1),id(3),id(6));assert.notEqual(a,other);
  }finally{await rm(root,{recursive:true,maxRetries:3,retryDelay:100});}
});

class Host {
  screen='';restored=0;
  dimensions(){return {columns:110,rows:26};}
  async acquire(){return {restore:async()=>{this.restored++;}};}
  async write(bytes){this.screen=new TextDecoder().decode(bytes);}
  onInput(callback){this.input=callback;return()=>{this.input=undefined;};}
  onResize(){return()=>{};}
  key(text){this.input?.(new TextEncoder().encode(text));}
}
async function see(host,text){for(let i=0;i<600;i++){if(host.screen.includes(text))return;await new Promise(r=>setTimeout(r,5));}assert.fail(`missing ${text}: ${host.screen}`);}
test('interactive CRLF paste needs review and confirmation; disk failure is explicitly not sent',async()=>{
  for(const diskFailure of [false,true]){
    const f=fixture(),host=new Host();
    f.client.listManagedExecutions=async()=>({machineId:id(1),items:[],nextCursor:null});
    if(diskFailure)f.environment.platform.writeSafeConfig=async()=>{throw Error('disk');};
    const run=runExecutionsScreen(f.client,id(1),host,undefined,f.environment);
    try{
      await see(host,'No executions');host.key('x');await see(host,'Command (kept only in memory)');
      host.key('\x1b[200~echo one\r\necho two\x1b[201~');await see(host,'echo two');
      assert.equal(f.calls.length,0);assert.doesNotMatch(host.screen,/Enter sends once/);
      host.key('\r');await see(host,'Enter sends once');assert.equal(f.calls.length,0);
      host.key('\r');await see(host,diskFailure?'Command was not sent':'Exit code: 4');
      const sends=f.calls.filter(Array.isArray);assert.equal(sends.length,diskFailure?0:1);
      if(!diskFailure)assert.deepEqual(sends[0][3].args,['-c','echo one\necho two']);
    }finally{host.key('\x03');await run;assert.equal(host.restored,1);}
  }
});

test('reopened receipt discovery binds profile, endpoint, principal and Machine',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cuna-reopened-executions-'));
  const platform={...createPlatformAdapter(),paths:{stateDirectory:root}};
  const scope={baseUrl:'https://example.invalid',profile:'default',userId:id(4)};
  try{
    assert.deepEqual(await listExecutionReceipts(platform,scope,id(1)),[]);
    await saveExecutionReceipt(platform,scope,id(1),id(3),id(6));
    await saveExecutionReceipt(platform,scope,id(5),id(3),id(7));
    const reopened={...createPlatformAdapter(),paths:{stateDirectory:root}};
    assert.deepEqual((await listExecutionReceipts(reopened,scope,id(1))).map(r=>r.operationId),[id(6)]);
    for(const other of [{...scope,profile:'other'},{...scope,userId:id(8)},{...scope,baseUrl:'https://other.invalid'}]){
      assert.deepEqual(await listExecutionReceipts(reopened,other,id(1)),[]);
    }
    const abort=new AbortController();abort.abort();await assert.rejects(listExecutionReceipts(reopened,scope,id(1),abort.signal));
  }finally{await rm(root,{recursive:true,maxRetries:3,retryDelay:100});}
});

test('corrupt, foreign and linked receipt files never become remote lookup targets',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cuna-receipt-validation-'));
  const platform={...createPlatformAdapter(),paths:{stateDirectory:root}};
  const scope={baseUrl:'https://example.invalid',profile:'default',userId:id(4)};
  try{
    const file=await saveExecutionReceipt(platform,scope,id(1),id(3),id(6));
    const original=JSON.parse(await readFile(file,'utf8'));
    for(const change of [{version:2},{operationId:id(7)},{scope:'wrong'},{command:'DO_NOT_DISCLOSE'},{machineId:'../private'}]){
      await writeFile(file,JSON.stringify({...original,...change}));
      await assert.rejects(listExecutionReceipts(platform,scope,id(1)),error=>!error.message.includes('DO_NOT_DISCLOSE'));
    }
    await rm(file);const linked=join(root,'link-target');await mkdir(linked);
    await symlink(linked,file,process.platform==='win32'?'junction':'dir');
    await assert.rejects(listExecutionReceipts(platform,scope,id(1)),/Unsafe execution recovery record/);
  }finally{await rm(root,{recursive:true,maxRetries:3,retryDelay:100});}
});

test('saved attempts remain inspectable after reopen and absence never resends or selects a remote neighbor',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cuna-receipt-screen-'));
  try{
    const f=fixture(),host=new Host(),gets=[];
    f.environment.platform={...createPlatformAdapter(),paths:{stateDirectory:root}};
    const scope={baseUrl:f.environment.baseUrl,profile:f.environment.profile,userId:f.identity.id};
    await saveExecutionReceipt(f.environment.platform,scope,id(1),id(3),id(6));
    f.client.listManagedExecutions=async()=>({machineId:id(1),items:[{operationId:id(7),leaderState:'exited',ownershipState:'cleared'}],nextCursor:null});
    f.client.getManagedExecution=async(_machine,op)=>{gets.push(op);throw Error('absent');};
    const run=runExecutionsScreen(f.client,id(1),host,undefined,f.environment);
    try{
      await see(host,id(7));host.key('l');await see(host,id(6));assert.doesNotMatch(host.screen,new RegExp(id(7)));
      host.key('\r');await see(host,'No matching authoritative execution');assert.deepEqual(gets,[id(6)]);
      host.key('\r');await see(host,'No matching authoritative execution');assert.deepEqual(gets,[id(6),id(6)]);
      f.identity.id=id(8);host.key('r');await see(host,'No saved attempts');host.key('\r');
      await new Promise(r=>setTimeout(r,20));assert.deepEqual(gets,[id(6),id(6)]);assert.equal(f.calls.length,0);
    }finally{host.key('\x03');await run;}
  }finally{await rm(root,{recursive:true,maxRetries:3,retryDelay:100});}
});
