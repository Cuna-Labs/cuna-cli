import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile, symlink, rename } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { selectManagedWorkspaceRoot } from "../dist/journey/managed-workspace-root.js";
import { persistWorkspaceBinding } from "../dist/workspace/binding-store.js";
import { createOwnedTempDirectory, removeOwnedTempDirectory } from "../scripts/lib/owned-temp.mjs";
import { runCli, memoryStreams, CunaError, EXIT_CODES } from "../dist/index.js";
const intent = (agent="claude-code", machine={kind:"automatic"}) => ({schemaVersion:"1.0",command:agent==="claude-code"?"claude":agent,agent,target:"reconcile",machine,syncMode:"enabled",newSession:false});
const owner={profileId:"default",userId:"user_1",workspaceId:"workspace_1"};
const input = (homeDirectory, overrides={}) => ({homeDirectory,baseUrl:"https://api.getcuna.com",...owner,intent:intent(),...overrides});
async function home(t) {const root=await createOwnedTempDirectory("cuna-managed-root-");t.after(()=>removeOwnedTempDirectory(root));return root;}
async function bind(root, overrides={}) {await mkdir(root,{recursive:true});return persistWorkspaceBinding({root,expected:null,binding:{...owner,bindingId:"binding_1",projectId:"project_1",localInstanceId:"local_1",machineId:"machine_1",remoteRoot:"/workspace/projects/project_1",policyDigest:"a".repeat(64),generation:0,bindingCreatedAt:"2026-08-09T00:00:00.000Z",bindingUpdatedAt:"2026-08-09T00:00:00.000Z",...overrides}});}
test("matching legacy owner reuses exact intact root; every foreign owner dimension leaves bytes untouched",async(t)=>{
 const h=await home(t),legacy=path.join(h,"Cuna Workspaces","claude-code-automatic");await bind(legacy);
 const marker=path.join(legacy,".cuna","workspace.json"), before=await readFile(marker);
 assert.equal(await selectManagedWorkspaceRoot(input(h)),legacy);
 const roots=[];for(const changed of [{userId:"user_2"},{workspaceId:"workspace_2"},{profileId:"other"},{baseUrl:"https://other.example.test",userId:"user_2"}])roots.push(await selectManagedWorkspaceRoot(input(h,changed)));
 assert.equal(new Set(roots).size,4);for(const root of roots)assert.ok(!root.startsWith(legacy+path.sep));
 assert.deepEqual(await readFile(marker),before);
});
test("all agent and Machine scope variants are stable and account separated",async(t)=>{
 const h=await home(t),roots=[];
 for(const agent of ["claude-code","codex","opencode"]){const args=input(h,{intent:intent(agent)});const root=await selectManagedWorkspaceRoot(args);assert.equal(await selectManagedWorkspaceRoot(args),root);roots.push(root);assert.notEqual(await selectManagedWorkspaceRoot({...args,userId:"user_2"}),root);}
 for(const machine of [{kind:"new"},{kind:"exact-name",name:"primary"}])roots.push(await selectManagedWorkspaceRoot(input(h,{intent:intent("claude-code",machine)})));
 const byId=await selectManagedWorkspaceRoot(input(h,{machineId:"machine-public-id"}));assert.match(path.basename(byId),/^machine-[0-9a-f]{16}$/u);roots.push(byId);assert.equal(new Set(roots).size,6);
});
test("explicit path is returned without filesystem probing or redirect",async()=>{assert.equal(await selectManagedWorkspaceRoot(input("does-not-exist",{intent:{...intent(),localPath:"EXPLICIT_PROJECT"}})),"EXPLICIT_PROJECT");});
test("unknown legacy contents are preserved, corrupt legacy and bound ancestors refuse",async(t)=>{
 const h=await home(t),legacy=path.join(h,"Cuna Workspaces","claude-code-automatic");await mkdir(legacy,{recursive:true});await writeFile(path.join(legacy,"keep.txt"),"retained");
 assert.notEqual(await selectManagedWorkspaceRoot(input(h)),legacy);assert.equal(await readFile(path.join(legacy,"keep.txt"),"utf8"),"retained");
 await mkdir(path.join(legacy,".cuna"));await writeFile(path.join(legacy,".cuna","workspace.json"),"bad JSON");await assert.rejects(selectManagedWorkspaceRoot(input(h)),error=>error.code?.startsWith("cuna.workspace."));
 const bound=await home(t);await bind(bound);await assert.rejects(selectManagedWorkspaceRoot(input(bound)),error=>error.details?.reason==="managed_workspace_ancestor_binding");
});
test("linked or bound intermediate account ancestors refuse before creating outside HOME",async(t)=>{
 const h=await home(t),outside=await home(t);await mkdir(path.join(h,"Cuna Workspaces"));await symlink(outside,path.join(h,"Cuna Workspaces","accounts"),process.platform==="win32"?"junction":"dir");
 await assert.rejects(selectManagedWorkspaceRoot(input(h)),error=>error.code?.startsWith("cuna.workspace."));
 assert.deepEqual(await readdir(outside),[],"a linked intermediate path receives no namespace creation");
 const fresh=await home(t);await bind(path.join(fresh,"Cuna Workspaces","accounts"));await assert.rejects(selectManagedWorkspaceRoot(input(fresh)),error=>error.details?.reason==="managed_workspace_ancestor_binding");
});
test("same-owner legacy relocation is preserved for the existing fenced journey",async(t)=>{
 const h=await home(t),original=path.join(h,"original-project"),legacy=path.join(h,"Cuna Workspaces","claude-code-automatic");await bind(original);await mkdir(path.dirname(legacy));await rename(original,legacy);
 assert.equal(await selectManagedWorkspaceRoot(input(h)),legacy);
});
test("actual CLI HOME default resolves after exactly one identity read; explicit path never redirects",async(t)=>{
 const h=await home(t),previous=process.cwd();let identities=0,observed;process.chdir(h);
 const platform={kind:"linux",paths:{configDirectory:h,stateDirectory:h,runtimeDirectory:h},async readSafeConfig(){return {exists:false};}};
 const dependencies={platform,env:{CUNA_API_KEY:"cuna_sk_abcdefghijklmnop",USERPROFILE:h,HOME:h},clientFactory:()=>({async getIdentity(){identities++;assert.deepEqual(await readdir(h),[],"identity must precede managed mkdir");return {id:owner.userId,workspaceId:owner.workspaceId};}}),automaticJourneyEffectsFactory:({intent:received})=>({async inspectWorkspace(){observed=received.localPath;throw new CunaError({code:"cuna.test.fixture_stop",message:"stopped before provisioning",exitCode:EXIT_CODES.policy});},async reconcileCancellation(){}})};
 try{
  const first=memoryStreams({stdinIsTTY:true,stdoutIsTTY:true,stderrIsTTY:true});assert.equal(await runCli(["claude"],{...dependencies,streams:first.streams}),EXIT_CODES.policy);assert.equal(identities,1);assert.ok(observed.includes(path.join("Cuna Workspaces","accounts")));
  const explicit="EXPLICIT_PROJECT";const second=memoryStreams({stdinIsTTY:true,stdoutIsTTY:true,stderrIsTTY:true});
  const clientFactory=()=>({async getIdentity(){identities++;return {id:owner.userId,workspaceId:owner.workspaceId};}});
  assert.equal(await runCli(["claude",explicit],{...dependencies,clientFactory,streams:second.streams}),EXIT_CODES.policy);assert.equal(observed,explicit);assert.equal(identities,2);
 }finally{process.chdir(previous);}
});
