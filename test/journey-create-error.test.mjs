import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {ContractViolation} from '../dist/core/validation.js';
import {providerSessionBody} from '../dist/api/provider-v2.js';
import {CunaError,EXIT_CODES} from '../dist/core/errors.js';
const source=readFileSync(new URL('../src/journey/orchestrator.ts',import.meta.url),'utf8');
const start=source.indexOf('function unreconcilableAgentSessionCreate('),end=source.indexOf('\n/**',start);
const context={CunaError,EXIT_CODES,ContractViolation};vm.runInNewContext(ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2023}}).outputText,context);
const wrap=context.unreconcilableAgentSessionCreate;
test('safe diagnostic preserves known server reason without claiming status proves no commit',()=>{const error=wrap(new CunaError({code:'cuna.remote.rejected',message:'SECRET',hint:'SECRET',exitCode:7,details:{http_status:409,reason:'provider_session_v2_operation_conflict',request_id:'11111111-1111-4111-8111-111111111111',operation_id:'22222222-2222-4222-8222-222222222222',body:'SECRET'}}));assert.equal(error.details.http_status,409);assert.equal(error.details.cause_reason,'provider_session_v2_operation_conflict');assert.equal(error.details.failure_stage,undefined);assert.match(error.message,/cannot prove/);assert.doesNotMatch(JSON.stringify({message:error.message,hint:error.hint,details:error.details}),/SECRET/);assert.equal(error.retryable,false);});
test('unknown strings and accessors cannot escape diagnostic allowlist',()=>{const raw={http_status:503,predicate:'SECRET',operation_id:'SECRET'};let reads=0;Object.defineProperty(raw,'reason',{get(){reads++;return 'SECRET';}});const error=wrap(new CunaError({code:'SECRET',message:'SECRET',exitCode:7,details:raw}));assert.equal(reads,0);assert.equal(error.details.cause_code,undefined);assert.equal(error.details.predicate,undefined);assert.equal(error.details.operation_id,undefined);assert.doesNotMatch(error.message,/SECRET/);});
test('local preparation refusal identifies only this attempt as pre-admission',()=>{const error=wrap(new CunaError({code:'cuna.provider.pending_intent_conflict',message:'SECRET',exitCode:6}));assert.equal(error.details.failure_stage,'local_pre_admission');assert.match(error.message,/earlier launch remains unresolved/);assert.equal(error.details.recovery,'exhausted');});

test('real invalid provider request body exposes plain ContractViolation before dispatch',()=>{let violation;try{providerSessionBody({operation_id:'invalid',execution_workspace_id:'invalid',workspace_generation:0,cwd:'invalid',profile_id:'invalid',profile_revision:0});}catch(error){violation=error;}assert.ok(violation instanceof ContractViolation);const result=wrap(violation);assert.equal(result.details.predicate,'provider_v2_exact_contract');assert.equal(result.details.failure_stage,'local_pre_admission');});
test('wrapped response violation and actual conflict transport code remain outcome-uncertain',()=>{const result=wrap(new CunaError({code:'cuna.remote.conflict',message:'SECRET',exitCode:7,details:{http_status:409,predicate:'provider_v2_exact_contract'}}));assert.equal(result.details.cause_code,'cuna.remote.conflict');assert.equal(result.details.predicate,'provider_v2_exact_contract');assert.equal(result.details.failure_stage,undefined);});
test('plain contract predicate accessor is never evaluated',()=>{const violation=new ContractViolation('unknown');let reads=0;Object.defineProperty(violation,'predicate',{get(){reads++;return 'provider_v2_exact_contract';}});const result=wrap(violation);assert.equal(reads,0);assert.equal(result.details.predicate,undefined);assert.equal(result.details.failure_stage,undefined);});

test('actual HTTP 409 memory refusal survives the create wrapper without raw server detail',async()=>{
 const {createHttpTransport}=await import('../dist/api/http.js');let calls=0;
 const transport=createHttpTransport({baseUrl:'https://api.getcuna.com',apiKey:'cuna_sk_'+'a'.repeat(43),fetch:async()=>{calls++;return new Response(JSON.stringify({type:'https://api.getcuna.com/problems/agent_session_memory_capacity',title:'Machine memory exhausted',status:409,code:'agent_session_memory_capacity',detail:'SECRET raw capacity detail',retryable:false,action:'none'}),{status:409,headers:{'content-type':'application/problem+json','x-request-id':'7cc9a519-b764-4d23-9584-a8ddee129dd4'}});}});
 let cause;try{await transport.request({method:'POST',path:'/v1/collaboration/2/sessions/22222222-2222-4222-8222-222222222222/workspace-agent-sessions',body:{}});}catch(error){cause=error;}
 const error=wrap(cause);assert.equal(calls,1);assert.equal(error.details.cause_code,'cuna.remote.conflict');assert.equal(error.details.http_status,409);assert.equal(error.details.cause_reason,'agent_session_memory_capacity');assert.match(error.message,/agent_session_memory_capacity/);assert.doesNotMatch(error.message,/SECRET/);assert.equal(error.details.failure_stage,undefined);
});
