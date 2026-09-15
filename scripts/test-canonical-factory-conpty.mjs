import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import xterm from '@xterm/headless';
import {acquireExclusiveBuildLock} from './lib/exclusive-build-lock.mjs';
if(process.platform!=='win32'||process.arch!=='x64')throw Error('requires Windows x64 ConPTY');
const root=path.resolve(import.meta.dirname,'..');
const require=createRequire(path.join(root,'test/windows-conpty/package.json'));
const {spawn}=require('node-pty');
const sha=b=>createHash('sha256').update(b).digest('hex');
const lock=await acquireExclusiveBuildLock(root);
let audit,term,child,exited,exit,failure,outputFailure,raw='',rawBytes=0,tail=Promise.resolve();
const actions=[];
const screen=()=>Array.from({length:term.rows},(_,i)=>term.buffer.active.getLine(i)?.translateToString(true,0,term.cols)??'').join('\n');
async function wait(predicate,label){const deadline=Date.now()+6000;while(Date.now()<deadline){await tail;if(outputFailure)throw outputFailure;if(predicate())return;if(exit)throw Error(label+': child exited '+JSON.stringify(exit));await new Promise(r=>setTimeout(r,15));}throw Error(label+': '+screen());}
async function key(bytes,expected){child.write(bytes);await wait(()=>screen().includes(expected),'input '+Buffer.from(bytes).toString('hex'));actions.push({inputHex:Buffer.from(bytes).toString('hex'),screen:screen(),at:new Date().toISOString()});}
try{
 audit=await mkdtemp(path.join(tmpdir(),'cuna-canonical-conpty-owned-'));
 term=new xterm.Terminal({allowProposedApi:true,cols:80,rows:24,scrollback:100});
 child=spawn(process.execPath,[path.join(root,'scripts/harness/canonical-factory-conpty-fixture.mjs')],{cwd:root,cols:80,rows:24,name:'xterm-256color',useConpty:true,useConptyDll:false,env:{...process.env,TERM:'xterm-256color'}});
 child.onData(data=>{if(outputFailure)return;const count=Buffer.byteLength(data);if(rawBytes+count>2000000){outputFailure=Error('output bound');return;}rawBytes+=count;raw+=data;tail=tail.then(()=>new Promise(r=>term.write(data,r))).catch(error=>{outputFailure=error;});});
 exited=new Promise(r=>child.onExit(e=>{exit=e;r(e);}));
 await wait(()=>screen().includes('Restoring terminal'),'initial restoring');
 child.write('Z');actions.push({inputHex:'5a',phase:'beforeReady'});
 await wait(()=>screen().includes('CANONICAL_VIEW_1')&&!screen().includes('Restoring terminal'),'initial current view');
 let expected='';for(const bytes of ['\x1b[A','\t','\x1b','\x7f','hello','\x1b[200~PASTE\x1b[201~']){expected+=Buffer.from(bytes).toString('hex');await key(bytes,'INPUT_HEX '+expected);const observed=screen().match(/INPUT_HEX ([0-9a-f]+)/)?.[1];assert.equal(observed,expected,'observed provider bytes must exclude pre-ready Z and any extra input');}
 child.resize(64,20);term.resize(64,20);await wait(()=>screen().includes('RESIZE 64x18'),'resize');
 actions.push({resize:[64,20],phase:'firstObserved',screen:screen(),bufferLineLengths:[term.buffer.active.getLine(0)?.length,term.buffer.active.getLine(3)?.length]});
 await new Promise(r=>setTimeout(r,150));await tail;
 actions.push({resize:[64,20],phase:'settled',screen:screen(),visibleColumns:term.cols,bufferLineLengths:[term.buffer.active.getLine(0)?.length,term.buffer.active.getLine(3)?.length]});
 child.resize(80,24);term.resize(80,24);await wait(()=>screen().includes('RESIZE 80x22'),'resize restore');
 child.write('~');await wait(()=>screen().includes('Restoring terminal'),'reconnect restoring');await wait(()=>screen().includes('CANONICAL_VIEW_2')&&!screen().includes('Restoring terminal'),'fresh replacement');
 await key('R','INPUT_HEX 52');assert.equal(screen().match(/INPUT_HEX ([0-9a-f]+)/)?.[1],'52');
 child.write('\x03');await wait(()=>exit!==undefined,'detach');assert.equal(exit.exitCode,0);
}catch(error){failure=String(error);}
finally{
 if(child&&!exit){try{child.kill();await Promise.race([exited,new Promise(r=>setTimeout(r,2000))]);if(!exit)failure=(failure??'')+' cleanup_timeout_child_exit_unconfirmed';}catch(error){failure=(failure??'')+' cleanup_failed:'+String(error);}}
 try{
  if(audit){await tail;const identities={};for(const name of ['scripts/test-canonical-factory-conpty.mjs','scripts/harness/canonical-factory-conpty-fixture.mjs','dist/runtime/node-foreground-session.js','dist/runtime/boundary.js','dist/terminal/foreground.js','dist/terminal/xterm-vte.js'])identities[name]=sha(await readFile(path.join(root,name)));
   await writeFile(path.join(audit,'raw.ansi'),raw,{flag:'wx'});await writeFile(path.join(audit,'result.json'),JSON.stringify({result:failure?'FAIL':'PASS',failure,processId:child?.pid,exit,childExitConfirmed:!!exit,dimensions:[80,24],actions,identities,rawSha256:sha(Buffer.from(raw)),rawBytes,limits:'Synthetic provider/transport; actual ConPTY host and factory. No old-edge compatibility or pixel-perfect resize claim.'},null,2),{flag:'wx'});
  }
 }finally{term?.dispose();await lock.release();}
}
console.log(JSON.stringify({result:failure?'FAIL':'PASS',audit,failure,exit,childExitConfirmed:!!exit}));
// node-pty retains handles after onExit; only terminate this driver after cleanup.
process.exit(failure?1:0);
