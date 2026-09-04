import {createHash} from "node:crypto";
import type {CunaApiClient} from "../api/client.js";
import type {ExecutionWorkspace} from "../api/execution-workspaces.js";
import {CunaError,EXIT_CODES} from "../core/errors.js";
import {conservativeFilesystemCapabilities} from "../journey/workspace-effects.js";
import {inspectWorkspaceSyncPolicy} from "../sync/workspace-sync-product-service.js";
import {loadWorkspaceBindingIntent,persistWorkspaceBinding,type WorkspaceBindingRecord} from "./binding-store.js";

export interface WorkspaceSelectionContext {
  readonly client:CunaApiClient;
  readonly profileId:string;
  readonly userId:string;
  readonly workspaceId:string;
  readonly machineId:string;
  readonly stateDirectory:string;
  readonly platform:"windows"|"macos"|"linux";
}
function refusal(message:string):never {
  throw new CunaError({code:"cuna.workspace.selection_conflict",message,exitCode:EXIT_CODES.conflict});
}
function stableId(text:string):string {
  const bytes=createHash("sha256").update(text).digest().subarray(0,16);
  bytes[6]=(bytes[6]!&15)|80;bytes[8]=(bytes[8]!&63)|128;
  const hex=bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export async function readWorkspaceSelectionSource(context:WorkspaceSelectionContext,path:string,signal?:AbortSignal):Promise<WorkspaceBindingRecord> {
  const loaded=await loadWorkspaceBindingIntent({startPath:path,profileId:context.profileId,userId:context.userId,workspaceId:context.workspaceId});
  if(loaded===undefined)refusal("Choose a folder already linked to this Project. Open an agent in that folder first if the Project has no binding.");
  const record=loaded.record;
  if(record.machineId!==context.machineId)refusal("This folder belongs to another Machine. Select its Machine before managing Workspaces.");
  const authority=await context.client.getWorkspaceBinding(record.bindingId,{workspaceId:record.workspaceId,projectId:record.projectId,localInstanceId:record.localInstanceId,machineId:record.machineId,exclusionPolicyDigest:record.policyDigest,...(record.executionWorkspaceId===undefined?{}:{executionWorkspaceId:record.executionWorkspaceId})},signal);
  if(authority.remoteRoot!==record.remoteRoot||(authority.executionWorkspaceId??null)!==(record.executionWorkspaceId??null))refusal("The Project folder's remote identity changed. Refresh its binding before continuing.");
  return record;
}
export async function listWorkspaceSelections(context:WorkspaceSelectionContext,source:WorkspaceBindingRecord,signal?:AbortSignal):Promise<readonly ExecutionWorkspace[]> {
  const bounded=signal===undefined?AbortSignal.timeout(30_000):AbortSignal.any([signal,AbortSignal.timeout(30_000)]);
  const items:ExecutionWorkspace[]=[];
  let after:string|undefined;
  for(let pageNumber=0;pageNumber<100;pageNumber++){
    const page=await context.client.listExecutionWorkspaces({workspaceId:context.workspaceId,projectId:source.projectId,machineId:context.machineId,...(after===undefined?{}:{after})},bounded);
    items.push(...page.items);
    if(page.nextCursor===null)return Object.freeze(items);
    if(page.nextCursor===after)refusal("Workspace discovery did not advance. Retry the observation.");
    after=page.nextCursor;
  }
  refusal("Workspace discovery exceeded its complete-list limit. No partial selection was accepted.");
}
export async function saveWorkspaceSelection(context:WorkspaceSelectionContext,sourcePath:string,destinationPath:string,executionWorkspaceId:string|undefined,displayedSource:WorkspaceBindingRecord,signal?:AbortSignal):Promise<WorkspaceBindingRecord> {
  // Re-read source authority at confirmation; a displayed menu is not a lease.
  const source=await readWorkspaceSelectionSource(context,sourcePath,signal);
  for(const key of ["bindingId","projectId","localInstanceId","machineId","workspaceId","userId","profileId","canonicalLocalRoot","remoteRoot","executionWorkspaceId"] as const){
    if(source[key]!==displayedSource[key])refusal("The displayed Project context changed. Go back and reload it before confirming a Workspace.");
  }
  if(JSON.stringify(source.rootIdentity)!==JSON.stringify(displayedSource.rootIdentity))refusal("The Project folder identity changed. Reload it before confirming a Workspace.");
  const policy=await inspectWorkspaceSyncPolicy({localRoot:destinationPath,filesystemCapabilities:conservativeFilesystemCapabilities(context.platform)});
  const existing=await loadWorkspaceBindingIntent({startPath:policy.canonicalRoot,boundaryPath:policy.canonicalRoot,profileId:context.profileId,userId:context.userId,workspaceId:context.workspaceId});
  if(existing!==undefined)refusal("The selected folder already has a Workspace binding. Choose a different folder; its existing binding was preserved.");
  const localInstanceId=stableId(JSON.stringify(["cuna.workspace.selection.v1",context.workspaceId,context.userId,source.projectId,policy.canonicalRoot,context.stateDirectory]));
  const request={workspaceId:context.workspaceId,projectId:source.projectId,localInstanceId,machineId:context.machineId,exclusionPolicyDigest:policy.exclusionPolicyDigest,excludedPrefixes:Object.freeze([] as string[]),...(executionWorkspaceId===undefined?{}:{executionWorkspaceId})};
  const key="cuna-workspace-selection-v1-"+createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const authority=await context.client.createWorkspaceBinding(request,key,signal);
  if(authority.executionWorkspaceId===null)refusal("The server did not create or adopt an isolated Workspace. This folder was not relabeled as isolated.");
  return persistWorkspaceBinding({root:policy.canonicalRoot,expected:null,binding:{profileId:context.profileId,userId:context.userId,workspaceId:context.workspaceId,bindingId:authority.bindingId,projectId:authority.projectId,executionWorkspaceId:authority.executionWorkspaceId,localInstanceId:authority.localInstanceId,machineId:authority.machineId,remoteRoot:authority.remoteRoot,policyDigest:authority.exclusionPolicyDigest,generation:authority.activeGeneration,bindingCreatedAt:authority.createdAt,bindingUpdatedAt:authority.updatedAt}});
}
