import { appendFile, access } from 'node:fs/promises';
import { runCli } from '../../dist/index.js';
import { runProcessCli } from '../../dist/cli/process-entrypoint.js';
import { runLocalRichForeground } from './local-rich-foreground.mjs';

const [ledger, gate, mode = 'ready'] = process.argv.slice(2);
if (!ledger || !gate) throw new Error('fixture requires owned ledger and publication gate paths');
const machineId='33333333-3333-4333-8333-333333333333';
const sessionId='11111111-1111-4111-8111-111111111111';
const workspaceId='22222222-2222-4222-8222-222222222222';
const executionWorkspaceId='44444444-4444-4444-8444-444444444444';
const remoteRoot=`/workspace/workspaces/${executionWorkspaceId}`;
const record=async(event,details={})=>appendFile(ledger,JSON.stringify({timestamp:new Date().toISOString(),pid:process.pid,event,...details})+'\n');
const session={id:sessionId,machineId,agent:'claude-code',cwd:remoteRoot,authMode:'interactive_login',requestState:'launched',processState:'running'};
const client={
  async getIdentity(){return {id:'55555555-5555-4555-8555-555555555555',workspaceId};},
  async listMachines(){return {items:[{id:machineId,name:'remote-menu-fixture',state:'running',agent:'claude-code'}]};},
  async listAgentSessions(){return {items:[]};},
  async discoverCapabilities(subjectScope,subjectId){const now=Date.now();return {schemaVersion:'1.0',subjectScope,subjectId,
    observedAt:new Date(now-100).toISOString(),expiresAt:new Date(now+30000).toISOString(),etag:'fixture',capabilities:
    [['machines.default_workspace.read','read_only'],['agent_sessions.workspace.create','native'],['agent_sessions.workspace.read','read_only']]
      .map(([id,interaction])=>({id,interaction,availability:'supported',mutationClass:'none',surfaces:['cli'],requiredPermissions:[]}))};},
  async getMachineDefaultWorkspace(){const ready=await access(gate).then(()=>true,()=>false);await record('publication',{ready});
    return {machineId,workspaceId,executionWorkspaceId,remoteRoot,workspaceGeneration:1,publicationStatus:ready?'ready':'pending'};},
  async createAgentSessionInWorkspace(id,input,key){await record('create',{machineId:id,input,key});return {agentSession:session};},
  async getAgentSessionWorkspaceContext(id){await record('context',{id});return {agentSessionId:id,machineId,
    executionWorkspaceId:mode==='foreign'?'66666666-6666-4666-8666-666666666666':executionWorkspaceId,remoteRoot,workspaceGeneration:1};},
  async getAgentSession(id){await record('ready',{id});return session;},
};
process.exitCode=await runProcessCli([], { stdin:process.stdin, run:async(argv,dependencies)=>runCli(argv,{
  ...dependencies,
  env:{CUNA_API_KEY:'cuna_sk_abcdefghijklmnop',CUNA_TERMINAL_MODE:'rich'},
  platform:{kind:'windows',paths:{configDirectory:'unused',stateDirectory:'unused',runtimeDirectory:'unused'},async readSafeConfig(){return {exists:false};}},
  clientFactory:()=>client,
  automaticJourneyEffectsFactory:()=>{throw new Error('FIRST_BAD: remote menu invoked local synchronization');},
  foregroundTerminalRunner:async input=>{
    if(input.agentSessionIds.length!==1||input.agentSessionIds[0]!==sessionId)throw new Error('wrong attachment');
    await record('attach',{id:sessionId});input.onBeforeTerminalOwnership?.();
    await runLocalRichForeground({agentSessionId:sessionId,marker:'REMOTE_MENU_ATTACHED',agent:'claude-code',providerLabel:'fixture',color:input.color});
  },
}) });
await record('exit',{code:process.exitCode});
