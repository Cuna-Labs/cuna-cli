import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {PassThrough} from "node:stream";
import {join} from "node:path";
import {createCunaApiClient, parseArgv, runCli, memoryStreams, CunaError} from "../dist/index.js";
import {orchestrateAgentJourney} from "../dist/journey/orchestrator.js";
import {parseAgentJourneyIntent} from "../dist/journey/intent.js";
import {deriveMachineCreateIdentity} from "../dist/journey/derived-identity.js";
import {createApiAgentJourneyEffects} from "../dist/journey/api-effects.js";
import {prepareMachineCreateChoice, performMachineCreateChoice, machineCreateChoiceState, machineCreateChoiceOutcome, finalizeMachineCreateChoice, cancelQueuedMachineCreate} from "../dist/journey/machine-create-options.js";
import {preflightInvocation} from "../dist/commands/commands.js";
import {FULL_HELP} from "../dist/cli/help.js";
import {selectInstallTetragon} from "../dist/cli/run.js";

const USER="11111111-1111-4111-8111-111111111111", WORKSPACE="22222222-2222-4222-8222-222222222222", MACHINE="55555555-5555-4555-8555-555555555555";
const NOW=Date.parse("2026-10-13T00:00:00Z"), signal=new AbortController().signal;
const identity={userId:USER,workspaceId:WORKSPACE,canonicalLocalRoot:"C:\\work\\project",agent:"claude-code",machine:{kind:"automatic"}};
const machine={id:MACHINE,name:"choice-test",state:"running"};
function snapshot(supported=true){return {schemaVersion:"1.0",subjectScope:"account",observedAt:new Date(NOW).toISOString(),expiresAt:new Date(NOW+30000).toISOString(),etag:"options",
 capabilities:["machines.create",...(supported?["machines.create.install_tetragon"]:[])].map(id=>({id,availability:"supported",interaction:"native",mutationClass:"financial",surfaces:["cli"],requiredPermissions:["machines:create"]}))};}
async function scratch(t){const stateDirectory=await mkdtemp(join(tmpdir(),"cuna-create-options-"));t.after(()=>rm(stateDirectory,{recursive:true,force:true,maxRetries:8,retryDelay:30}));return {...identity,stateDirectory,apiOrigin:"https://api.getcuna.com",profileId:"default"};}
function receipt(id,overrides={}){return {id,machineId:MACHINE,state:"settled",action:"none",retryable:false,updatedAt:new Date(NOW).toISOString(),...overrides};}
function fx(scope,client,overrides={}){return createApiAgentJourneyEffects({client,requestedAgent:"claude-code",machineCreateState:{stateDirectory:scope.stateDirectory,apiOrigin:scope.apiOrigin,profileId:scope.profileId},
 inspectWorkspace:async()=>({canonicalLocalRoot:identity.canonicalLocalRoot}),synchronizeWorkspace:async()=>assert.fail("unused"),attach:async()=>assert.fail("unused"),authorizeMachineCreate:async()=>true,now:()=>NOW,...overrides});}

test("strict bool flag rejects before config/auth and documents both explicit values",async()=>{
 for(const raw of ["yes","0","FALSE",""]){assert.throws(()=>parseAgentJourneyIntent(["claude","--install-tetragon",raw]),/true or false|requires a value/);
 assert.throws(()=>preflightInvocation(parseArgv(["machines","create","--name","dev","--yes","--install-tetragon",raw])),/true or false|requires a value/);}
 for(const value of [true,false])assert.equal(parseAgentJourneyIntent(["codex","--install-tetragon",String(value)]).installTetragon,value);
 let config=0;const streams=memoryStreams();const exit=await runCli(["machines","create","--name","dev","--yes","--install-tetragon","yes"],{streams:streams.streams,platform:{async readSafeConfig(){config++;assert.fail("preauth");}}});
 assert.equal(exit,2);assert.equal(config,0);assert.match(FULL_HELP,/--install-tetragon true\|false/);
});
test("omitted first epoch keeps legacy bytes, choices and released epochs are distinct",()=>{
 const legacy=deriveMachineCreateIdentity(identity);assert.equal(legacy.requestId,"438d4ad0-8e22-560f-9cc5-e8e3694aa696");
 assert.deepEqual(deriveMachineCreateIdentity({...identity,createAttempt:1}),legacy);
 const ids=[legacy,...[true,false].map(installTetragon=>deriveMachineCreateIdentity({...identity,installTetragon})),deriveMachineCreateIdentity({...identity,createAttempt:2})].map(v=>v.requestId);
 assert.equal(new Set(ids).size,4);
});
test("durable choice precedes first POST; lost reply restarts GET-only without re-prompt",async t=>{
 const scope=await scratch(t);let prompts=0,posts=0,reads=0,original;
 const client={discoverCapabilities:async()=>snapshot(),async createMachine(body,_key,id){posts++;original=id;assert.equal(body.installTetragon,false);throw Error("lost reply");},async getMachineCreateRequest(id){reads++;assert.equal(id,original);return receipt(id);},getMachine:async()=>machine};
 const first=fx(scope,client,{selectInstallTetragon:async()=>{prompts++;return {kind:"choice",installTetragon:false};}});
 const prepared=await first.prepareMachineCreate({identity,signal});assert.equal(await machineCreateChoiceState(scope,prepared),"queued");
 await assert.rejects(first.createMachine({requestedAgent:identity.agent,...prepared,onDispatch(){},signal}),/lost reply/);
 assert.equal(await machineCreateChoiceState(scope,prepared),"uncertain");
 const restarted=fx(scope,client,{selectInstallTetragon:async()=>assert.fail("must not prompt"),authorizeMachineCreate:async()=>assert.fail("read-only recovery")});
 const recovered=await restarted.prepareMachineCreate({identity,signal});assert.equal(recovered.requestId,prepared.requestId);
 await restarted.createMachine({requestedAgent:identity.agent,...recovered,onDispatch:()=>assert.fail("no POST"),signal});
 assert.equal(posts,1);assert.equal(prompts,1);assert.ok(reads>=1);
});
test("queued financial cancel is proven unsent and releases next explicit choice",async t=>{
 const scope=await scratch(t);let posts=0;const effects=fx(scope,{discoverCapabilities:async()=>snapshot(),async createMachine(){posts++;}}, {selectInstallTetragon:async()=>({kind:"choice",installTetragon:true}),authorizeMachineCreate:async()=>false});
 const prepared=await effects.prepareMachineCreate({identity,signal});await assert.rejects(effects.createMachine({requestedAgent:identity.agent,...prepared,onDispatch(){},signal}),/not authorized/);
 assert.equal(posts,0);assert.equal(await machineCreateChoiceState(scope,prepared),"conflicted");
 const next=await prepareMachineCreateChoice(scope,async()=>({kind:"choice",installTetragon:false}));assert.equal(next.createAttempt,2);assert.notEqual(next.requestId,prepared.requestId);
});
test("unsupported server omits wire option and explicit choice refuses with zero POST",async t=>{
 const scope=await scratch(t);let posts=0;const effects=fx(scope,{discoverCapabilities:async()=>snapshot(false),async createMachine(body){posts++;assert.equal(Object.hasOwn(body,"installTetragon"),false);return machine;}},{selectInstallTetragon:async()=>assert.fail("old API must not ask")});
 const prepared=await effects.prepareMachineCreate({identity,signal});assert.equal(prepared.installTetragon,undefined);await effects.createMachine({requestedAgent:identity.agent,...prepared,onDispatch(){},signal});assert.equal(posts,1);
 const explicit=fx({...scope,stateDirectory:join(scope.stateDirectory,"explicit")},{discoverCapabilities:async()=>snapshot(false),createMachine:async()=>assert.fail("unsupported")});
 await assert.rejects(explicit.prepareMachineCreate({identity:{...identity,installTetragon:false},signal}),error=>error.details.capability_id==="machines.create.install_tetragon");
});
test("capability revocation after prompt fences actual dispatch without changing durable choice",async t=>{
 const scope=await scratch(t);let supported=true;const effects=fx(scope,{discoverCapabilities:async()=>snapshot(supported),createMachine:async()=>assert.fail("revoked")},{selectInstallTetragon:async()=>({kind:"choice",installTetragon:false})});
 const prepared=await effects.prepareMachineCreate({identity,signal});supported=false;await assert.rejects(effects.createMachine({requestedAgent:identity.agent,...prepared,onDispatch:()=>assert.fail("no dispatch"),signal}));assert.equal(await machineCreateChoiceState(scope,prepared),"queued");
});
test("unknown and not-readable original receipts cannot release an epoch or resend",async t=>{
 const scope=await scratch(t);const prepared=await prepareMachineCreateChoice(scope,async()=>({kind:"choice",installTetragon:true}));
 const io={signal,create:async()=>{throw Error("lost");},readReceipt:async()=>receipt(prepared.requestId,{state:"unknown",action:"reconcile",retryable:true}),readMachine:async()=>assert.fail("unknown")};
 await assert.rejects(performMachineCreateChoice(scope,prepared,io));await assert.rejects(performMachineCreateChoice(scope,prepared,io),error=>error.details.reason==="original_outcome_unknown");
 const restored=await prepareMachineCreateChoice(scope,async()=>assert.fail("no reprompt"));assert.equal(restored.requestId,prepared.requestId);
 await assert.rejects(prepareMachineCreateChoice({...scope,installTetragon:false},async()=>assert.fail("no prompt")),error=>error.details.reason==="pending_choice_cannot_change");
 await assert.rejects(performMachineCreateChoice(scope,prepared,{...io,readReceipt:async()=>{throw Error("404 not proof of absence");}}));assert.equal(await machineCreateChoiceState(scope,prepared),"uncertain");
});
test("only exact terminal V1 receipt releases new epoch; extra V2 evidence fails closed",async t=>{
 for(const variant of ["wrong-id","retryable","v2","terminal"]){const scope=await scratch(t);const prepared=await prepareMachineCreateChoice(scope,async()=>({kind:"choice",installTetragon:false}));
 const io={signal,create:async()=>{throw Error("lost");},readMachine:async()=>assert.fail("terminal"),readReceipt:async()=>receipt(variant==="wrong-id"?USER:prepared.requestId,{state:"terminal_failed",action:"none",retryable:variant==="retryable",...(variant==="v2"?{version:"2"}:{})})};
 await assert.rejects(performMachineCreateChoice(scope,prepared,io));await assert.rejects(performMachineCreateChoice(scope,prepared,io));
 assert.equal(await machineCreateChoiceState(scope,prepared),variant==="terminal"?"conflicted":"uncertain");
 if(variant==="terminal"){const next=await prepareMachineCreateChoice(scope,async()=>({kind:"choice",installTetragon:true}));assert.equal(next.createAttempt,2);assert.notEqual(next.requestId,prepared.requestId);}
 }
});
test("preflight cancellation persists no operation and dispatched cancellation never resets one",async t=>{
 const scope=await scratch(t);await assert.rejects(prepareMachineCreateChoice(scope,async()=>({kind:"cancel"})),/Nothing was sent/);
 const prepared=await prepareMachineCreateChoice(scope,async()=>({kind:"choice"}));assert.equal(prepared.createAttempt,1);
 await assert.rejects(performMachineCreateChoice(scope,prepared,{signal,create:async()=>{throw Error("cancel after dispatch");},readReceipt:async()=>assert.fail("unused"),readMachine:async()=>assert.fail("unused")}));
 await cancelQueuedMachineCreate(scope,prepared);assert.equal(await machineCreateChoiceState(scope,prepared),"uncertain");
});
test("client encodes false literally and rechecks feature support at real transport boundary",async()=>{
 for(const supported of [false,true]){const requests=[];const client=createCunaApiClient({async request(request){requests.push(request);if(request.path==="/v1/capabilities"){const s=snapshot(supported);return {schema_version:s.schemaVersion,subject_scope:"account",observed_at:new Date().toISOString(),expires_at:new Date(Date.now()+30000).toISOString(),etag:s.etag,capabilities:s.capabilities.map(c=>({id:c.id,availability:c.availability,interaction:c.interaction,mutation_class:c.mutationClass,surfaces:c.surfaces,required_permissions:c.requiredPermissions}))};}return machine;}});
 if(supported){await client.createMachine({name:"dev",installTetragon:false},"test-choice",USER);assert.deepEqual(requests.at(-1).body,{name:"dev",install_tetragon:false});}
 else await assert.rejects(client.createMachine({name:"dev",installTetragon:false},"test-choice",USER));
 assert.equal(requests.filter(r=>r.method==="POST").length,supported?1:0);}
});
test("actual direct CLI journals original full body, lost reply GET-only, changed choice refuses",async t=>{
 const scope=await scratch(t);let posts=0,reconciles=0,settled=false,missingReceipt=false,requestId,clock=0;
 const client={getIdentity:async()=>({id:USER,workspaceId:WORKSPACE}),discoverCapabilities:async()=>snapshot(),async createMachine(body,_key,id){posts++;requestId=id;assert.equal(body.installTetragon,false);throw new CunaError({code:"cuna.client.response_budget_elapsed",message:"lost reply",exitCode:6,retryable:true});},
 async getMachineCreateRequest(id){if(requestId===undefined||missingReceipt)throw new CunaError({code:"cuna.remote.not_found",message:"not readable",exitCode:7,details:{http_status:404}});assert.equal(id,requestId);return receipt(id,settled?{}:{state:"unknown",action:"reconcile",retryable:true});},getMachine:async()=>machine,reconcileMachineCreateRequest:async()=>{reconciles++;assert.fail("UNKNOWN must not POST");}};
 const platform={kind:"linux",paths:{configDirectory:join(scope.stateDirectory,"cfg"),stateDirectory:scope.stateDirectory,runtimeDirectory:join(scope.stateDirectory,"runtime")},readSafeConfig:async()=>({exists:false})};
 const invoke=async(choice=false,extra={},argv=[])=>{const streams=memoryStreams();const exit=await runCli(["machines","create","--name",machine.name,"--background","--yes","--idempotency-key","stable-original-key",...(choice==="omit"?[]:["--install-tetragon",String(choice)]),"--json",...argv],{
 streams:streams.streams,platform,workspaceRoot:scope.stateDirectory,env:{CUNA_API_KEY:"cuna_sk_abcdefghijklmnop"},now:()=>NOW,clientFactory:()=>client,convergencePoller:{now:()=>clock,sleep:async ms=>{clock+=ms;}},...extra});return {exit,out:streams.stdout(),error:streams.stderr()};};
 const lost=await invoke();assert.notEqual(lost.exit,0);assert.equal(posts,1);assert.equal(reconciles,0);
 const omitted=await invoke("omit");assert.notEqual(omitted.exit,0);assert.match(omitted.error,/recorded_scope_or_choice_mismatch/);assert.equal(posts,1);assert.equal(reconciles,0);
 missingReceipt=true;const late404=await invoke("omit");assert.notEqual(late404.exit,0);assert.match(late404.error,/recorded_scope_or_choice_mismatch/);assert.equal(posts,1);assert.equal(reconciles,0);missingReceipt=false;
 const aliasPlatform={...platform,readSafeConfig:async()=>({exists:true,text:JSON.stringify({profiles:{default:{},alias:{}}})})};
 missingReceipt=true;const aliasOmission=await invoke("omit",{platform:aliasPlatform},["--profile","alias"]);assert.notEqual(aliasOmission.exit,0);assert.match(aliasOmission.error,/recorded_scope_or_choice_mismatch/);assert.equal(posts,1);assert.equal(reconciles,0);missingReceipt=false;
 settled=true;const recovered=await invoke();assert.equal(recovered.exit,0,recovered.error);assert.equal(posts,1);assert.equal(reconciles,0);
 const aliasRecovery=await invoke(false,{platform:aliasPlatform},["--profile","alias"]);assert.equal(aliasRecovery.exit,0,aliasRecovery.error);assert.equal(posts,1);assert.equal(reconciles,0);
 const moved=await invoke(false,{workspaceRoot:join(scope.stateDirectory,"different-cwd")});assert.equal(moved.exit,0,moved.error);assert.equal(posts,1);
 const movedOmission=await invoke("omit",{workspaceRoot:join(scope.stateDirectory,"different-cwd")});assert.notEqual(movedOmission.exit,0);assert.match(movedOmission.error,/recorded_scope_or_choice_mismatch/);assert.equal(posts,1);assert.equal(reconciles,0);
 const changed=await invoke(true);assert.notEqual(changed.exit,0);assert.match(changed.error,/recorded_scope_or_choice_mismatch/);assert.equal(posts,1);
 const unrecorded=await invoke(false,{platform:{...platform,paths:{...platform.paths,stateDirectory:join(scope.stateDirectory,"unrecorded")}}});assert.notEqual(unrecorded.exit,0);assert.match(unrecorded.error,/machine_create_policy_unproven/);assert.equal(posts,1);
});
test("real orchestrator prepares choice before deriving/dispatched request and reuses existing Machine without prompting",async t=>{
 const scope=await scratch(t);const events=[];let selected=false;
 const api=fx(scope,{discoverCapabilities:async()=>snapshot(),async createMachine(body,_key,id){events.push("POST");assert.equal(body.installTetragon,false);assert.equal(id,deriveMachineCreateIdentity({...identity,installTetragon:false}).requestId);return machine;}},{selectInstallTetragon:async()=>{events.push("choice");return {kind:"choice",installTetragon:false};}});
 const effects={...api,observeMachines:async()=>selected?[{...machine,agent:"claude-code",requestedAgentSupport:"supported",ownership:"owned",freshness:"fresh",recency:"recent",resources:{vcpus:2,memoryMiB:2048},costStatus:"known"}]:[],ensureMachineReady:async()=>machine,
 synchronizeWorkspace:async()=>({bindingId:WORKSPACE,workspaceIdentity:WORKSPACE,generation:1,remoteCwd:"/workspace/projects/test"}),observeAgentSessions:async()=>[],createAgentSession:async()=>({id:USER,machineId:MACHINE}),ensureAgentSessionReady:async()=>({id:USER,machineId:MACHINE}),attach:async()=>{events.push("attach");}};
 const intent=parseAgentJourneyIntent(["claude",scope.stateDirectory]);await orchestrateAgentJourney({intent,effects,scope:{userId:USER,workspaceId:WORKSPACE},idempotencyKey:"journey-test"});assert.deepEqual(events,["choice","POST","attach"]);
 selected=true;events.length=0;await orchestrateAgentJourney({intent,effects,scope:{userId:USER,workspaceId:WORKSPACE},idempotencyKey:"journey-test"});assert.deepEqual(events,["attach"]);
 await assert.rejects(orchestrateAgentJourney({intent:{...intent,installTetragon:false},effects,scope:{userId:USER,workspaceId:WORKSPACE},idempotencyKey:"journey-test"}),/only to a new Machine/);
});
test("provider allocation can still fail; only cleanup-terminal receipt permits another choice",async t=>{
 const scope=await scratch(t);let allocations=0;
 const prepared=await prepareMachineCreateChoice(scope,async()=>({kind:"choice",installTetragon:false}));
 const io={signal,create:async()=>{allocations++;return {...machine,state:"creating"};},readReceipt:async()=>receipt(prepared.requestId,{state:"provider_succeeded",action:"wait",retryable:true}),readMachine:async()=>({...machine,state:"creating"})};
 await performMachineCreateChoice(scope,prepared,io);await performMachineCreateChoice(scope,prepared,io);assert.equal(await machineCreateChoiceState(scope,prepared),"acknowledged");
 await assert.rejects(performMachineCreateChoice(scope,prepared,{...io,readReceipt:async()=>receipt(prepared.requestId,{state:"terminal_failed",action:"none",retryable:false})}));assert.equal(await machineCreateChoiceState(scope,prepared),"conflicted");
 const next=await prepareMachineCreateChoice(scope,async()=>({kind:"choice",installTetragon:true}));assert.equal(next.createAttempt,2);assert.equal(allocations,1);
});
test("settled completed explicit new or deleted-original releases epoch; unknown template switch stays fenced",async t=>{
 for(const variant of ["explicit-new","deleted","unknown-template"]){const scope=await scratch(t);const selection={...identity,machine:{kind:variant==="explicit-new"?"new":"automatic"}};
 const prepared=await prepareMachineCreateChoice({...scope,...selection},async()=>({kind:"choice",installTetragon:false}));
 const io={signal,create:async()=>{if(variant==="unknown-template")throw Error("lost");return machine;},readReceipt:async()=>receipt(prepared.requestId),readMachine:async()=>machine};
 if(variant==="unknown-template")await assert.rejects(performMachineCreateChoice(scope,prepared,io));else{await performMachineCreateChoice({...scope,...selection},prepared,io);await performMachineCreateChoice({...scope,...selection},prepared,io);}
 let prompts=0;const api=fx(scope,{getMachineCreateRequest:async()=>receipt(prepared.requestId,variant==="unknown-template"?{state:"unknown",action:"reconcile",retryable:true}:{}),getMachine:async()=>({...machine,state:variant==="deleted"?"deleted":"running"}),discoverCapabilities:async()=>snapshot()},{selectInstallTetragon:async()=>{prompts++;return {kind:"choice",installTetragon:true};}});
 if(variant==="unknown-template"){await assert.rejects(api.prepareMachineCreate({identity:{...identity,machine:{kind:"new"}},signal}),error=>error.details.reason==="recorded_scope_or_choice_mismatch");assert.equal(prompts,0);}
 else{const next=await api.prepareMachineCreate({identity:selection,signal});assert.equal(next.createAttempt,2);assert.notEqual(next.requestId,prepared.requestId);assert.equal(prompts,1);}
 }
});
test("normal first create/readiness then first explicit new or changed template reads original settled receipt and creates once",async t=>{
 for(const variant of ["new","changed-template"]){const scope=await scratch(t);let posts=0,prompts=0,originalId;const readIds=[];
 const api=fx(scope,{discoverCapabilities:async()=>snapshot(),async createMachine(body,_key,id){posts++;if(posts===1)originalId=id;else assert.notEqual(id,originalId);return {...machine,id:posts===1?MACHINE:"66666666-6666-4666-8666-666666666666",state:"creating"};},
 async getMachineCreateRequest(id){readIds.push(id);assert.equal(id,originalId);return receipt(id);},getMachine:async id=>({...machine,id})},{selectInstallTetragon:async()=>{prompts++;return {kind:"choice",installTetragon:false};}});
 const prepared=await api.prepareMachineCreate({identity,signal});const first=await api.createMachine({requestedAgent:identity.agent,...prepared,onDispatch(){},signal});await api.ensureMachineReady({machineId:first.id,observedState:first.state,signal});
 assert.equal(await machineCreateChoiceState(scope,prepared),"acknowledged","normal successful first flow has not performed recovery");assert.equal(readIds.length,0);
 const nextIdentity={...identity,...(variant==="new"?{machine:{kind:"new"}}:{agent:"codex"})};
 const restarted=fx(scope,{discoverCapabilities:async()=>snapshot(),getMachineCreateRequest:async id=>{readIds.push(id);assert.equal(id,originalId);return receipt(id);},getMachine:async id=>({...machine,id}),async createMachine(body,_key,id){posts++;assert.notEqual(id,originalId);return {...machine,id:"66666666-6666-4666-8666-666666666666",state:"creating"};}},{selectInstallTetragon:async()=>{prompts++;return {kind:"choice",installTetragon:true};}});
 const next=await restarted.prepareMachineCreate({identity:nextIdentity,signal});assert.equal(next.createAttempt,2);await restarted.createMachine({requestedAgent:nextIdentity.agent,...next,onDispatch(){},signal});assert.equal(posts,2);assert.equal(prompts,2);assert.ok(readIds.length>=1);
 }
});
test("built-in prompt rejects nonTTY before output and cancels EOF without waiting for external abort",async()=>{
 const input=new PassThrough(), output=new PassThrough();let text="";output.on("data",chunk=>{text+=chunk;});
 await assert.rejects(selectInstallTetragon(signal,{input,output}),error=>error.code==="cuna.journey.machine_create_choice_required"&&error.exitCode===2&&error.hint.includes("--install-tetragon true|false"));assert.equal(text,"");
 const tty=new PassThrough();tty.isTTY=true;tty.isRaw=false;tty.setRawMode=raw=>{tty.isRaw=raw;};
 const controller=new AbortController(), timer=setTimeout(()=>controller.abort(Error("EOF did not settle")),500);
 try{const pending=selectInstallTetragon(controller.signal,{input:tty,output});tty.end();assert.deepEqual(await pending,{kind:"cancel"});assert.equal(controller.signal.aborted,false);assert.equal(tty.isRaw,false);assert.equal((text.match(/Install Tetragon\?/gu)??[]).length,1);}finally{clearTimeout(timer);}
});
test("pending finalization requires exact settled coupling and unchanged native journal fingerprint",async t=>{
 for(const variant of ["retryable","wait","extra","missing","concurrent"]){const scope=await scratch(t), prepared=await prepareMachineCreateChoice(scope,async()=>({kind:"choice",installTetragon:false}));
 const io={signal,create:async()=>machine,readReceipt:async()=>receipt(prepared.requestId),readMachine:async()=>machine};await performMachineCreateChoice(scope,prepared,io);const observed=await machineCreateChoiceOutcome(scope);
 const candidateReceipt=receipt(prepared.requestId,variant==="retryable"?{retryable:true}:variant==="wait"?{action:"wait"}:variant==="extra"?{version:"2"}:{});if(variant==="missing")delete candidateReceipt.updatedAt;
 if(variant==="concurrent")await performMachineCreateChoice(scope,prepared,io);
 if(["extra","missing","concurrent"].includes(variant))await assert.rejects(finalizeMachineCreateChoice(scope,observed,candidateReceipt));else await finalizeMachineCreateChoice(scope,observed,candidateReceipt);
 assert.equal(await machineCreateChoiceState(scope,prepared),variant==="concurrent"?"applied":"acknowledged");
 }
});
test("automatic profile alias preserves pending producer identity; other principals and Workspaces remain independent",async t=>{
 const scope=await scratch(t);let posts=0,prompts=0;const first=fx(scope,{discoverCapabilities:async()=>snapshot(),async createMachine(){posts++;throw Error("lost");}},{selectInstallTetragon:async()=>{prompts++;return {kind:"choice",installTetragon:false};}});
 const prepared=await first.prepareMachineCreate({identity,signal});await assert.rejects(first.createMachine({requestedAgent:identity.agent,...prepared,onDispatch(){},signal}),/lost/);
 const alias=fx({...scope,profileId:"alias"},{getMachineCreateRequest:async id=>{assert.equal(id,prepared.requestId);return receipt(id,{state:"unknown",action:"reconcile",retryable:true});},createMachine:async()=>assert.fail("alias cannot POST")},{selectInstallTetragon:async()=>assert.fail("same operation never reprompts")});
 const restored=await alias.prepareMachineCreate({identity,signal});assert.equal(restored.requestId,prepared.requestId);assert.equal(restored.installTetragon,false);
 await assert.rejects(alias.prepareMachineCreate({identity:{...identity,installTetragon:true},signal}),error=>error.details.reason==="pending_choice_cannot_change");assert.equal(posts,1);assert.equal(prompts,1);
 for(const changed of [{userId:"77777777-7777-4777-8777-777777777777"},{workspaceId:"88888888-8888-4888-8888-888888888888"}]){const separate=await prepareMachineCreateChoice({...scope,...changed,profileId:"alias"},async()=>({kind:"choice",installTetragon:true}));assert.equal(separate.createAttempt,1);assert.notEqual(separate.requestId,prepared.requestId);}
});
