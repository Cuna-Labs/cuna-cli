import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir,readFile,readdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";

const [moduleRoot,caseRoot,mode]=process.argv.slice(2);
assert.ok(moduleRoot&&caseRoot&&["new","adopt","existing","cancel","back"].includes(mode));
assert.equal(process.stdin.isTTY,true);assert.equal(process.stdout.isTTY,true);
const load=relative=>import(pathToFileURL(path.join(moduleRoot,"dist",relative)).href);
const {runWorkspaceSelectionScreen}=await load("workspace/selection-screen.js");
const {persistWorkspaceBinding,loadWorkspaceBindingIntent}=await load("workspace/binding-store.js");
const {inspectWorkspaceSyncPolicy}=await load("sync/workspace-sync-product-service.js");
const {conservativeFilesystemCapabilities}=await load("journey/workspace-effects.js");
const ids={user:"11111111-1111-4111-8111-111111111111",account:"22222222-2222-4222-8222-222222222222",
  project:"33333333-3333-4333-8333-333333333333",machine:"44444444-4444-4444-8444-444444444444",
  source:"55555555-5555-4555-8555-555555555555",adopt:"66666666-6666-4666-8666-666666666666",
  fresh:"77777777-7777-4777-8777-777777777777",binding:"88888888-8888-4888-8888-888888888888",
  local:"99999999-9999-4999-8999-999999999999",createdBinding:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"};
const source=path.join(caseRoot,"source"),destination=path.join(caseRoot,"destination");
await mkdir(source);await mkdir(destination);
await writeFile(path.join(source,"sentinel.txt"),"public source sentinel\n");
await writeFile(path.join(destination,"sentinel.txt"),"public destination sentinel\n");
const policy=await inspectWorkspaceSyncPolicy({localRoot:source,filesystemCapabilities:conservativeFilesystemCapabilities("windows")});
const now="2026-09-04T00:00:00.000Z",mutations=[];
const draft={profileId:"fixture",userId:ids.user,workspaceId:ids.account,bindingId:ids.binding,
  projectId:ids.project,executionWorkspaceId:ids.source,localInstanceId:ids.local,machineId:ids.machine,
  remoteRoot:`/workspace/workspaces/${ids.source}`,policyDigest:policy.exclusionPolicyDigest,
  generation:0,bindingCreatedAt:now,bindingUpdatedAt:now};
const sourceRecord=await persistWorkspaceBinding({root:source,expected:null,binding:draft});
if(mode==="existing")await persistWorkspaceBinding({root:destination,expected:null,binding:{...draft,
  bindingId:ids.createdBinding,executionWorkspaceId:ids.adopt,remoteRoot:`/workspace/workspaces/${ids.adopt}`}});
const recordPath=root=>path.join(root,".cuna","workspace.json");
const hash=async file=>createHash("sha256").update(await readFile(file)).digest("hex");
const sourceBefore=await hash(recordPath(source));
const destinationBefore=mode==="existing"?await hash(recordPath(destination)):null;
const expectedIdentity={profileId:"fixture",userId:ids.user,workspaceId:ids.account};
const client={
  async getWorkspaceBinding(bindingId,identity,signal){
    signal?.throwIfAborted();assert.equal(bindingId,ids.binding);
    assert.deepEqual(identity,{workspaceId:ids.account,projectId:ids.project,localInstanceId:ids.local,
      machineId:ids.machine,exclusionPolicyDigest:policy.exclusionPolicyDigest,executionWorkspaceId:ids.source});
    return {bindingId,...identity,remoteRoot:sourceRecord.remoteRoot,activeGeneration:0,createdAt:now,updatedAt:now};
  },
  async listExecutionWorkspaces(input,signal){
    signal?.throwIfAborted();assert.deepEqual(input,{workspaceId:ids.account,projectId:ids.project,machineId:ids.machine});
    return {items:[{executionWorkspaceId:ids.adopt,workspaceId:ids.account,projectId:ids.project,machineId:ids.machine,
      remoteRoot:`/workspace/workspaces/${ids.adopt}`,activeGeneration:3,activeManifestRoot:"a".repeat(64),
      exclusionPolicyDigest:policy.exclusionPolicyDigest,createdAt:now}],nextCursor:null};
  },
  async createWorkspaceBinding(input,key,signal){
    signal?.throwIfAborted();assert.ok(mode==="new"||mode==="adopt","unexpected mutation");
    assert.equal(input.workspaceId,ids.account);assert.equal(input.projectId,ids.project);assert.equal(input.machineId,ids.machine);
    assert.equal(input.executionWorkspaceId,mode==="adopt"?ids.adopt:undefined);
    assert.deepEqual(input.excludedPrefixes,[]);assert.match(key,/^cuna-workspace-selection-v1-[a-f0-9]{64}$/u);
    mutations.push({operation:"createWorkspaceBinding",input,key});
    await writeFile(path.join(caseRoot,"mutations.json"),JSON.stringify(mutations));
    const executionWorkspaceId=input.executionWorkspaceId??ids.fresh;
    return {...input,bindingId:ids.createdBinding,executionWorkspaceId,remoteRoot:`/workspace/workspaces/${executionWorkspaceId}`,
      activeGeneration:mode==="adopt"?3:0,createdAt:now,updatedAt:now};
  },
};
await writeFile(path.join(caseRoot,"mutations.json"),"[]");
const context={client,...expectedIdentity,machineId:ids.machine,stateDirectory:caseRoot,platform:"windows"};
const result=await runWorkspaceSelectionScreen(context,source);
assert.equal(result,mode==="cancel"||mode==="existing"?"cancelled":mode==="back"?"back":"saved");
assert.equal(process.stdin.isRaw,false);
assert.equal(await hash(recordPath(source)),sourceBefore);
assert.equal(await readFile(path.join(source,"sentinel.txt"),"utf8"),"public source sentinel\n");
assert.equal(await readFile(path.join(destination,"sentinel.txt"),"utf8"),"public destination sentinel\n");
assert.deepEqual((await readdir(source)).sort(),[".cuna","sentinel.txt"]);
assert.deepEqual(await readdir(path.join(source,".cuna")),["workspace.json"]);
let saved;
if(mode==="new"||mode==="adopt"){
  assert.equal(mutations.length,1);
  saved=(await loadWorkspaceBindingIntent({startPath:destination,boundaryPath:destination,...expectedIdentity})).record;
  assert.equal(saved.executionWorkspaceId,mode==="adopt"?ids.adopt:ids.fresh);
  assert.equal(saved.bindingId,ids.createdBinding);assert.equal(saved.projectId,ids.project);
  assert.equal(saved.machineId,ids.machine);assert.equal(saved.localInstanceId,mutations[0].input.localInstanceId);
  assert.equal(saved.remoteRoot,`/workspace/workspaces/${saved.executionWorkspaceId}`);
  assert.deepEqual((await readdir(destination)).sort(),[".cuna","sentinel.txt"]);
  assert.deepEqual(await readdir(path.join(destination,".cuna")),["workspace.json"]);
}else{
  assert.equal(mutations.length,0);
  if(mode==="existing")assert.equal(await hash(recordPath(destination)),destinationBefore);
  else {
    assert.equal(await loadWorkspaceBindingIntent({startPath:destination,boundaryPath:destination,...expectedIdentity}),undefined);
    assert.deepEqual(await readdir(destination),["sentinel.txt"]);
  }
}
const report={mode,result,rawMode:process.stdin.isRaw,sourceUnchanged:true,existingDestinationPreserved:mode==="existing",
  sentinelsUnchanged:true,mutations,saved:saved??null};
await writeFile(path.join(caseRoot,"result.json"),JSON.stringify(report));
console.log(`WORKSPACE_FIXTURE_RESULT ${JSON.stringify({mode,result,rawMode:process.stdin.isRaw})}`);
