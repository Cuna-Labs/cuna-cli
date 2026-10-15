import test from "node:test";
import assert from "node:assert/strict";
import {createCunaApiClient} from "../dist/api/client.js";
import {createNamedSecretService} from "../dist/named-secrets/service.js";
import {NamedSecretOverlay,NamedSecretInputGate} from "../dist/named-secrets/overlay.js";
import {assertRemoteAgentSessionEvidence} from "../dist/runtime/terminal-transport.js";
const id=d=>`${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`;
const user=id("8"),execution=id("3"),workspace=id("6");
const common={agent_session_id:id("1"),machine_id:id("2"),process_epoch:id("4"),terminal_connection_id:id("5"),connect_token:`runa_tc_${"A".repeat(43)}`,writer_epoch:2};
const modern={...common,execution_workspace_id:execution,execution_workspace_generation:4};
const legacy={...common,workspace_binding_id:id("9")};
const receipt=operation=>({operation_id:operation,state:"committed",secret_id:id("7"),name:"Database",workspace_id:workspace,committed_at:"2026-10-13T12:00:00Z"});
test("legacy bytes remain exact; V2 serialized body carries only the frozen execution proof",async()=>{
 for(const context of [legacy,modern]){const requests=[];const client=createCunaApiClient({request:async request=>{requests.push(request);return receipt(id("1"));}});
 await client.createNamedSecret({operation_id:id("1"),name:"Database",password:"Disposable",context});assert.equal(requests.length,1);assert.deepEqual(requests[0].body.context,context);assert.equal(requests[0].sensitive,"named-secret");assert.equal(requests[0].automaticRedispatch,false);}
});
test("mixed, absent, malformed or unsafe scope proofs never send secret material",async()=>{
 for(const context of [{...modern,workspace_binding_id:id("9")},{...modern,workspace_binding_id:undefined},common,{...modern,execution_workspace_generation:0},{...modern,execution_workspace_generation:Number.MAX_SAFE_INTEGER+1},{...modern,execution_workspace_id:"wrong"},{...legacy,execution_workspace_generation:4}]){
 let requests=0;const client=createCunaApiClient({request:async()=>{requests++;assert.fail("invalid scope must not dispatch");}});
 await assert.rejects(client.createNamedSecret({operation_id:id("1"),name:"Database",password:"Disposable",context}));assert.equal(requests,0);}
});
function prepareClient(change={}){let reads=0;const now=Date.now();return {getIdentity:async()=>({id:user,workspaceId:workspace}),getMachine:async()=>({state:"running"}),getAgentSession:async()=>({machineId:common.machine_id,processState:"running",processEpoch:common.process_epoch,cwd:`/workspace/workspaces/${execution}`}),
 discoverCapabilities:async()=>({schemaVersion:"1.0",subjectScope:"agent_session",subjectId:common.agent_session_id,observedAt:new Date(now).toISOString(),expiresAt:new Date(now+30000).toISOString(),etag:"fixture",capabilities:[{id:"agent_sessions.workspace.read",availability:"supported",interaction:"read_only",mutationClass:"none",surfaces:["cli"],requiredPermissions:[]}]}),
 getAgentSessionWorkspaceContext:async()=>{reads++;return {agentSessionId:common.agent_session_id,machineId:common.machine_id,executionWorkspaceId:execution,workspaceGeneration:4,remoteRoot:`/workspace/workspaces/${execution}`,...change};},reads:()=>reads};}
test("V2 preflight freshly verifies exact authenticated context and returns public account Workspace",async()=>{
 const client=prepareClient();assert.equal(await createNamedSecretService(client).prepare(modern,user,new AbortController().signal),workspace);assert.equal(client.reads(),1);
 for(const change of [{agentSessionId:id("9")},{machineId:id("9")},{executionWorkspaceId:id("9")},{workspaceGeneration:5},{remoteRoot:"/root"}])await assert.rejects(createNamedSecretService(prepareClient(change)).prepare(modern,user,new AbortController().signal));
 const denied=prepareClient();denied.discoverCapabilities=async()=>({schemaVersion:"1.0",subjectScope:"agent_session",subjectId:common.agent_session_id,observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30000).toISOString(),etag:"denied",capabilities:[]});await assert.rejects(createNamedSecretService(denied).prepare(modern,user,new AbortController().signal));assert.equal(denied.reads(),0);
});
test("modern generation change while validating clears password and cannot dispatch",async()=>{
 let current={context:modern,userId:user},release,writes=0;const remote=[];
 const overlay=new NamedSecretOverlay({prepare:()=>new Promise(resolve=>{release=resolve;}),create:async()=>{writes++;assert.fail("changed authority");},read:async()=>assert.fail("unused")},()=>current,()=>{});
 const gate=new NamedSecretInputGate(),encode=new TextEncoder(),input=text=>gate.process(encode.encode(text),()=>overlay.active,()=>overlay.open(),bytes=>overlay.input(bytes),bytes=>remote.push(...bytes));
 try{input("\x11Database\tDisposable\r");assert.equal(overlay.state,"VALIDATING");current={context:{...modern,execution_workspace_generation:5},userId:user};overlay.authorityChanged();release(workspace);await new Promise(resolve=>setImmediate(resolve));assert.equal(writes,0);assert.equal(overlay.view.masked,"");assert.deepEqual(remote,[]);assert.equal(overlay.persistence,"NOT_SENT");}finally{overlay.dispose();}
});
test("terminal execution pair remains distinct from legacy binding and rejects malformed evidence",()=>{
 const now=Date.now(),base={authority:"cuna_agent_session_supervisor",userId:user,machineId:common.machine_id,agentSessionId:common.agent_session_id,processEpoch:common.process_epoch,workspaceBindingId:null,workspaceBindingGeneration:null,state:"running",observedAt:new Date(now).toISOString(),expiresAt:new Date(now+30000).toISOString(),evidenceRevision:"fixture"};
 assert.equal(assertRemoteAgentSessionEvidence({evidence:{...base,executionWorkspaceId:execution,executionWorkspaceGeneration:4},expectedAgentSessionId:common.agent_session_id,now}).workspaceBindingId,null);
 for(const change of [{executionWorkspaceId:execution},{executionWorkspaceGeneration:4},{executionWorkspaceId:execution,executionWorkspaceGeneration:0},{executionWorkspaceId:execution,executionWorkspaceGeneration:4,workspaceBindingId:id("9"),workspaceBindingGeneration:1}])assert.throws(()=>assertRemoteAgentSessionEvidence({evidence:{...base,...change},expectedAgentSessionId:common.agent_session_id,now}));
});
