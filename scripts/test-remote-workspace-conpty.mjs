import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import xterm from '@xterm/headless';

if(process.platform!=='win32')throw new Error('Requires real Windows ConPTY');
const root=path.resolve(import.meta.dirname,'..');
const {spawn}=createRequire(path.join(root,'test/windows-conpty/package.json'))('node-pty');
const directory=await mkdtemp(path.join(tmpdir(),'cuna-remote-menu-'));
const results=[];
try {
  for(const mode of ['ready','foreign','cancel']){
    const ledger=path.join(directory,mode+'.jsonl'),gate=path.join(directory,mode+'.gate');
    const terminal=new xterm.Terminal({allowProposedApi:true,cols:110,rows:26,scrollback:1000});
    let raw='',tail=Promise.resolve(),exit;const inputs=[],screens=[];
    const child=spawn(process.execPath,[path.join(root,'scripts/harness/remote-workspace-menu-fixture.mjs'),ledger,gate,mode],{
      cwd:root,cols:110,rows:26,useConpty:true,useConptyDll:false,env:{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'}});
    child.onData(data=>{raw+=data;tail=tail.then(()=>new Promise(resolve=>terminal.write(data,resolve)));});
    const exited=new Promise(resolve=>child.onExit(value=>{exit=value;resolve(value);}));
    const screen=()=>Array.from({length:terminal.rows},(_,row)=>terminal.buffer.active.getLine(row)?.translateToString(true)??'').join('\n');
    const wait=async(predicate,label)=>{const deadline=Date.now()+10000;while(Date.now()<deadline){await tail;if(predicate()){screens.push({label,screen:screen(),timestamp:new Date().toISOString()});return;}await new Promise(r=>setTimeout(r,20));}throw new Error(`FIRST_BAD ${label}\n${screen()}`);};
    const send=key=>{inputs.push({key,timestamp:new Date().toISOString()});child.write(key);};
    try {
      await wait(()=>screen().includes('remote-menu-fixture'),'Machine menu rendered');
      send('\r');await wait(()=>screen().includes('New Claude session'),'New session selected');
      send('\r');await wait(()=>screen().includes('Waiting for remote Workspace publication'),'Publication pending visible');
      if(mode==='cancel'){send('\x03');}
      else {
        await writeFile(gate,'ready');
        if(mode==='ready'){
          await wait(()=>screen().includes('REMOTE_MENU_ATTACHED'),'Exact session entered foreground');
          send('\x03');
        }
      }
      await Promise.race([exited,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('process did not exit')),10000);t.unref();})]);
      await tail;
      const events=(await readFile(ledger,'utf8')).trim().split('\n').map(JSON.parse);
      results.push({mode,pid:child.pid,inputs,screens,events,exit,raw,rawSha256:createHash('sha256').update(raw).digest('hex')});
      assert.equal(events.filter(e=>e.event==='create').length,mode==='cancel'?0:1);
      assert.equal(events.filter(e=>e.event==='attach').length,mode==='ready'?1:0);
      assert.equal(exit.exitCode,mode==='foreign'?6:0);
      assert.equal(terminal.buffer.active.type,'normal');
    } catch(error) {
      if(process.argv[2])await writeFile(path.resolve(process.argv[2])+'.failed.json',JSON.stringify({status:'FAIL',mode,error:String(error),results,current:{inputs,screens,raw,exit}},null,2));
      throw error;
    } finally {if(!exit){child.kill();await exited;}terminal.dispose();}
  }
  const result={status:'PASS',scope:'Real ConPTY and CLI menus; API and provider fixture, not installed or production acceptance',dimensions:{columns:110,rows:26},results};
  if(process.argv[2])await writeFile(path.resolve(process.argv[2]),JSON.stringify(result,null,2));
  console.log(JSON.stringify({status:result.status,scope:result.scope,cases:results.map(({mode,exit})=>({mode,exit}))}));
} finally {
  // mkdtemp returned this exact owned directory; no computed parent is removed.
  assert.equal(path.dirname(directory),tmpdir());assert.ok(path.basename(directory).startsWith('cuna-remote-menu-'));
  await rm(directory,{recursive:true,force:true});
}
// node-pty retains its Windows helper handles after each child exit. All child
// exits, terminal disposal, evidence writes and owned-directory cleanup above
// have completed before ending this standalone harness process.
process.exit(0);
