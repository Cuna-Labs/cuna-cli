import {observerSchemas,observerOperations} from './observer-v2-schema.js';
import type {HttpTransport} from './http.js';
import {assertCanonicalUuid} from '../core/validation.js';
import {CunaError,EXIT_CODES} from '../core/errors.js';
type Schema={$ref?:string;type?:string|string[];const?:unknown;enum?:unknown[];pattern?:string;minimum?:number;maximum?:number;minLength?:number;maxLength?:number;required?:string[];properties?:Record<string,Schema>;additionalProperties?:boolean;items?:Schema;maxItems?:number;anyOf?:Schema[];allOf?:Schema[];if?:Schema;then?:Schema;else?:Schema};
const schemas=observerSchemas as unknown as Record<string,Schema>;
function valid(v:unknown,s:Schema):boolean{
 if(s.$ref)return valid(v,schemas[s.$ref.split('/').at(-1)!]!);
 if(s.allOf&&!s.allOf.every(x=>valid(v,x)))return false;if(s.anyOf&&!s.anyOf.some(x=>valid(v,x)))return false;if(s.if){const branch=valid(v,s.if)?s.then:s.else;if(branch&&!valid(v,branch))return false;}
 if(s.const!==undefined&&v!==s.const||s.enum&&!s.enum.includes(v))return false;
 if(Array.isArray(s.type))return s.type.some(type=>valid(v,{...s,type}));
 if(s.type==='null')return v===null;
 if(s.type==='string')return typeof v==='string'&&v.length>=(s.minLength??0)&&v.length<=(s.maxLength??Infinity)&&(!s.pattern||new RegExp(s.pattern).test(v));
 if(s.type==='integer')return typeof v==='number'&&Number.isSafeInteger(v)&&v>=(s.minimum??-Infinity)&&v<=(s.maximum??Infinity);
 if(s.type==='array')return Array.isArray(v)&&v.length<=(s.maxItems??Infinity)&&v.every(x=>s.items&&valid(x,s.items));
 if(s.type==='object'||s.properties||s.required){if(!v||typeof v!=='object'||Array.isArray(v))return false;const row=v as Record<string,unknown>;const descriptors=Object.getOwnPropertyDescriptors(row);if(Reflect.ownKeys(row).some(k=>typeof k!=='string'||!descriptors[k]?.enumerable||!('value' in descriptors[k]!)))return false;return !(s.required??[]).some(k=>!Object.hasOwn(row,k))&&Object.keys(row).every(k=>s.properties?.[k]?valid(row[k],s.properties[k]!):s.additionalProperties!==false);}
 return true;
}
function fail():never{throw new CunaError({code:'cuna.observer.unavailable',message:'Current observation access could not be verified. Ask the owner to check access, or retry discovery.',exitCode:EXIT_CODES.policy});}
function check(value:unknown,name:string){if(!valid(value,schemas[name]!))fail();}
export type ObserverGrant={version:'2';grant_id:string;agent_session_id:string;session_incarnation:string;subject_principal_id:string;owner_principal_id:string;project_id:string;state:string;revocation_state:string|null;expires_at:number};
export type ObserverPage={items:ObserverGrant[];next_after_grant_id:string|null;project_id:string};
export type ObserverTicket={version:'2';attachment_id:string;expires_at:number;secret:string;stream_path:string};
export function decodeObserverPage(value:unknown,principal:string,project:string,after:string|null,now=Date.now()):ObserverPage{check(value,'ObserverSessionsV2Receipt');const page=value as ObserverPage;if(page.project_id!==project||page.items.some((g,i)=>g.project_id!==project||g.subject_principal_id!==principal||g.owner_principal_id===principal||g.state!=='active'||g.revocation_state!==null||g.expires_at<=now||g.grant_id<=(i?page.items[i-1]!.grant_id:after??''))||page.next_after_grant_id!==null&&(page.next_after_grant_id<=(after??'')||page.items.some(g=>g.grant_id>page.next_after_grant_id!)))fail();return structuredClone(page);}
export function decodeObserverTicket(value:unknown,grant:ObserverGrant,now=Date.now()):ObserverTicket{check(value,'ObserverAttachmentV2Receipt');const t=value as ObserverTicket;if(t.stream_path!==`/v1/collaboration/2/observer-attachments/${t.attachment_id}/stream`||t.expires_at<=now||t.expires_at>grant.expires_at)fail();return structuredClone(t);}
export function observerStreamUrl(ticket:ObserverTicket,origin:string){check(ticket,'ObserverAttachmentV2Receipt');const url=new URL(origin);if(url.origin!=='https://api.getcuna.com'||url.pathname!=='/'||url.search||url.hash||url.username||url.password||ticket.stream_path!==`/v1/collaboration/2/observer-attachments/${ticket.attachment_id}/stream`)fail();return 'wss://api.getcuna.com'+ticket.stream_path;}
export function observerApi(transport:HttpTransport,principal:string,project:string,verifyPrincipal?:()=>Promise<string>){assertCanonicalUuid(project,'Project ID');assertCanonicalUuid(principal,'Principal ID');const current=async()=>{if(verifyPrincipal&&await verifyPrincipal()!==principal)fail();};return{
 async list(after:string|null,signal:AbortSignal){await current();const body={version:'2',after_grant_id:after,limit:50};check(body,'ListObserverSessionsV2Request');const value=await transport.request({method:'POST',path:observerOperations.listObserverSessionsV2.path.replace('{id}',project),body,signal});await current();return decodeObserverPage(value,principal,project,after);},
 async issue(grant:ObserverGrant,operation:string,client:string,signal:AbortSignal){await current();check(grant,'SessionObserveGrantV2Receipt');if(grant.subject_principal_id!==principal||grant.project_id!==project||grant.state!=='active'||grant.revocation_state!==null||grant.expires_at<=Date.now())fail();const body={version:'2',operation_id:operation,client_instance_id:client};check(body,'IssueObserverAttachmentV2Request');const value=await transport.request({method:'POST',path:observerOperations.issueObserverAttachmentV2.path.replace('{id}',grant.grant_id),body,signal});await current();return decodeObserverTicket(value,grant);}
};}
