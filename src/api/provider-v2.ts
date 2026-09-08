import { providerV2Schemas } from './provider-v2-schema.js';
import { contractViolation } from '../core/validation.js';
import { decodeAgentSessionWorkspaceEnvelope, type AgentSessionWorkspaceEnvelope } from './remote-workspace.js';
type Schema = { $ref?:string; type?:string; const?:unknown; enum?:readonly unknown[]; minimum?:number; maximum?:number; minLength?:number; maxLength?:number; pattern?:string; minItems?:number; maxItems?:number; items?:Schema; required?:readonly string[]; properties?:Record<string,Schema>; additionalProperties?:boolean; oneOf?:readonly Schema[] };
const schemas=providerV2Schemas as unknown as Record<string,Schema>;
function valid(v:unknown,s:Schema):boolean {
 if(s.$ref) {const ref=schemas[s.$ref.split('/').at(-1)!];return ref!==undefined&&valid(v,ref);}
 if(s.oneOf)return s.oneOf.filter(p=>valid(v,p)).length===1;
 if(s.const!==undefined&&s.const!==v||s.enum&&!s.enum.includes(v))return false;
 if(s.type==='string')return typeof v==='string'&&v.length>=(s.minLength??0)&&v.length<=(s.maxLength??Infinity)&&(!s.pattern||new RegExp(s.pattern).test(v));
 if(s.type==='integer')return typeof v==='number'&&Number.isSafeInteger(v)&&v>=(s.minimum??-Infinity)&&v<=(s.maximum??Infinity);
 if(s.type==='array')return Array.isArray(v)&&v.length>=(s.minItems??0)&&v.length<=(s.maxItems??Infinity)&&v.every(item=>s.items&&valid(item,s.items));
 if(s.type==='object') {if(!v||typeof v!=='object'||Array.isArray(v))return false;const row=v as Record<string,unknown>;return !s.required?.some(k=>!Object.hasOwn(row,k))&&Object.keys(row).every(k=>s.properties?.[k]?valid(row[k],s.properties[k]):s.additionalProperties!==false);}
 return true;
}
function check(v:unknown,name:string){if(!valid(v,schemas[name]!))throw contractViolation('provider_v2_exact_contract');}
export type ProviderPreset={label:string;profile_id:string;profile_revision:number};
export function decodeProviderPresets(v:unknown):readonly ProviderPreset[]{check(v,'ProviderProfileCatalogResponseV2');return (v as {items:ProviderPreset[]}).items;}
export type ProviderFact={version:'2';state:'observed';agent_session_id:string;process_epoch:string;observed_at_ms:number;valid_until_ms:number;provider:{upstream_provider:string;model:string;agent_version:string}};
export type ProviderObservation=ProviderFact|{version:'2';state:'unavailable';reason:string};
export function decodeProviderObservation(v:unknown,sessionId:string,epoch:string):ProviderObservation {check(v,'ProviderObservationResponseV2');const r=v as ProviderObservation;if(r.state==='observed'&&(r.agent_session_id!==sessionId||r.process_epoch!==epoch||r.valid_until_ms<=r.observed_at_ms||r.valid_until_ms-r.observed_at_ms>900000))throw contractViolation('provider_v2_scope');return r;}
export type ProviderSessionInput={operation_id:string;execution_workspace_id:string;workspace_generation:number;cwd:string;profile_id:string;profile_revision:number};
export function decodeProviderSession(v:unknown,machineId:string,input:ProviderSessionInput):AgentSessionWorkspaceEnvelope {
 if(!v||typeof v!=='object'||Array.isArray(v))throw contractViolation('provider_v2_create');
 const r=v as Record<string,unknown>;if(r.version!=='2'||Object.keys(r).sort().join(',')!==['version','agent_session','execution_workspace_id','workspace_generation','remote_root','selection'].sort().join(','))throw contractViolation('provider_v2_create');
 check(r.selection,'ProviderSessionSelectionV2');const s=r.selection as Record<string,unknown>;
 const result=decodeAgentSessionWorkspaceEnvelope({agent_session:r.agent_session,execution_workspace_id:r.execution_workspace_id,workspace_generation:r.workspace_generation,remote_root:r.remote_root});
 if(result.machineId!==machineId||result.executionWorkspaceId!==input.execution_workspace_id||result.workspaceGeneration!==input.workspace_generation||result.agentSession.cwd!==input.cwd||result.agentSession.agent!=='opencode'||result.agentSession.authMode!=='interactive_login'||s.machine_id!==machineId||s.agent_session_id!==result.agentSession.id||s.operation_id!==input.operation_id||s.profile_id!==input.profile_id||s.profile_revision!==input.profile_revision)throw contractViolation('provider_v2_create_scope');return result;
}

export function providerSessionBody(input:ProviderSessionInput){const body={version:"2",...input,agent:"opencode",auth_mode:"interactive_login"};check(body,"ProviderSessionCreateRequestV2");return body;}
