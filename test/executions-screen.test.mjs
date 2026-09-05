import assert from 'node:assert/strict';
import test from 'node:test';
import {runExecutionsScreen} from '../dist/machines/executions-screen.js';
const id=n=>`${n}0000000-0000-4000-8000-000000000001`;
const row={operationId:id(2),machineId:id(1),executionWorkspaceId:id(3),leaderState:'exited',ownershipState:'descendants_live',cancelRequested:false,exitCode:0,durationMs:3,reason:null};
class Host {
  screen='';restored=0;size={columns:100,rows:30};
  dimensions(){return this.size;}
  async acquire(){return {restore:async()=>{this.restored++;}};}
  async write(b){this.screen=new TextDecoder().decode(b);}
  onInput(f){this.input=f;return()=>{this.input=undefined;};}
  onResize(f){this.resize=f;return()=>{this.resize=undefined;};}
  key(value){this.input?.(new TextEncoder().encode(value));}
}
async function see(h,text){const deadline=Date.now()+3000;while(Date.now()<deadline){if(h.screen.includes(text))return;await new Promise(r=>setTimeout(r,5));}assert.fail(`missing ${text}: ${h.screen}`);}
function fixture(){const host=new Host(),calls=[];let current={...row};const client={
  async listManagedExecutions(machine,input,signal){calls.push({kind:'list',machine,input,signal});return {machineId:machine,items:[current,{...current,operationId:id(4)}],nextCursor:null};},
  async getManagedExecution(machine,operation,signal){calls.push({kind:'get',machine,operation,signal});return {...current,operationId:operation};},
  async cancelManagedExecution(machine,operation,signal){calls.push({kind:'cancel',machine,operation,signal});current={...current,cancelRequested:true};return {...current,operationId:operation};},
};return {host,calls,client,set(value){current={...current,...value};}};}

test('arrows select exact execution; cancellation needs confirmation and exit never implies cleanup',async()=>{
  const f=fixture(),run=runExecutionsScreen(f.client,id(1),f.host);
  try{
    await see(f.host,`> ${id(2)}`);f.host.key('\x1b[B');await see(f.host,`> ${id(4)}`);
    f.host.key('\r');await see(f.host,`Execution: ${id(4)}`);assert.match(f.host.screen,/cleanup is not confirmed/);
    f.host.key('c');await see(f.host,'Enter confirms');assert.equal(f.calls.filter(c=>c.kind==='cancel').length,0);
    f.host.key('\x1b');await new Promise(r=>setTimeout(r,170));assert.doesNotMatch(f.host.screen,/Enter confirms/);
    f.host.key('c');await see(f.host,'Enter confirms');f.host.key('\r');await see(f.host,'Cancellation accepted');
    assert.match(f.host.screen,/Process ownership: descendants_live/);
    assert.deepEqual(f.calls.filter(c=>c.kind==='cancel').map(c=>[c.machine,c.operation]),[[id(1),id(4)]]);
    f.set({ownershipState:'cleared'});f.host.key('r');await see(f.host,'ownership is cleared');
    f.host.key('\x1b');await see(f.host,`> ${id(4)}`);f.host.key('\x1b');assert.equal(await run,'back');
    assert.equal(f.host.restored,1);
  }finally{f.host.key('\x03');await run;}
});

test('bracketed pasted commands cannot confirm cancellation; resize retains readable ownership',async()=>{
  const f=fixture(),run=runExecutionsScreen(f.client,id(1),f.host);
  try{
    await see(f.host,`> ${id(2)}`);f.host.key('\r');await see(f.host,'Execution:');
    f.host.key('\x1b[200~c\r\x1b[201~');await new Promise(r=>setTimeout(r,20));
    assert.doesNotMatch(f.host.screen,/Enter confirms/);assert.equal(f.calls.filter(c=>c.kind==='cancel').length,0);
    f.host.size={columns:60,rows:20};f.host.resize();await see(f.host,'Process ownership: descendants_live');
    f.host.key('\x03');assert.equal(await run,'cancelled');assert.equal(f.host.restored,1);
  }finally{f.host.key('\x03');await run;}
});

test('lost cancel response refreshes same execution without mutation replay',async()=>{
  const f=fixture();f.client.cancelManagedExecution=async(machine,operation)=>{f.calls.push({kind:'cancel',machine,operation});throw new Error('lost');};
  const run=runExecutionsScreen(f.client,id(1),f.host);
  try{
    await see(f.host,`> ${id(2)}`);f.host.key('\r');await see(f.host,'Execution:');f.host.key('c');await see(f.host,'Enter confirms');
    f.host.key('\r');await see(f.host,'Cancellation not confirmed');f.host.key('r');await see(f.host,'Process ownership: descendants_live');
    assert.equal(f.calls.filter(c=>c.kind==='cancel').length,1);
    assert.ok(f.calls.filter(c=>c.kind==='get').every(c=>c.operation===id(2)));
  }finally{f.host.key('\x03');await run;}
});

test('Ctrl+C restores terminal and aborts a pending read without claiming remote cancellation',async()=>{
  const f=fixture();let observedSignal;
  f.client.listManagedExecutions=async(_machine,_input,signal)=>{observedSignal=signal;return new Promise(()=>{});};
  const run=runExecutionsScreen(f.client,id(1),f.host);
  await see(f.host,'Reading remote state');f.host.key('\x03');assert.equal(await run,'cancelled');
  assert.equal(observedSignal.aborted,true);assert.equal(f.host.restored,1);assert.equal(f.calls.length,0);
});
