import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import xterm from '@xterm/headless';
if(process.platform!=='win32')throw new Error('Requires real Windows ConPTY');
const root=path.resolve(import.meta.dirname,'..');
const {spawn}=createRequire(path.join(root,'test/windows-conpty/package.json'))('node-pty');
const directory=await mkdtemp(path.join(tmpdir(),'cuna-executions-menu-'));
const results=[];
try{
  for(const mode of ['root','machines','lost','launch','launch-lost']){
    const ledger=path.join(directory,mode+'.jsonl');
    const terminal=new xterm.Terminal({allowProposedApi:true,cols:110,rows:26,scrollback:1000});
    let raw='',tail=Promise.resolve(),exit;const inputs=[],screens=[];
    const child=spawn(process.execPath,[path.join(root,'scripts/harness/executions-menu-fixture.mjs'),ledger,mode],{
      cwd:root,cols:110,rows:26,useConpty:true,useConptyDll:false,env:{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'}});
    child.onData(data=>{raw+=data;tail=tail.then(()=>new Promise(resolve=>terminal.write(data,resolve)));});
    const exited=new Promise(resolve=>child.onExit(value=>{exit=value;resolve(value);}));
    const screen=()=>Array.from({length:terminal.rows},(_,row)=>terminal.buffer.active.getLine(row)?.translateToString(true)??'').join('\n');
    const wait=async(predicate,label)=>{const deadline=Date.now()+10000;while(Date.now()<deadline){await tail;if(predicate()){screens.push({label,screen:screen(),timestamp:new Date().toISOString()});return;}await new Promise(r=>setTimeout(r,20));}throw new Error(`FIRST_BAD ${label}\n${screen()}`);};
    const send=key=>{inputs.push({key,timestamp:new Date().toISOString()});child.write(key);};
    try{
      await wait(()=>screen().includes('execution-menu-fixture'),'Machine listed');
      send('\r');await wait(()=>screen().includes('e Executions'),'Machine actions expose recovery');
      send('e');await wait(()=>screen().includes('exited / descendants_live'),'Inventory preserves descendant ownership');
      if(mode.startsWith('launch')){
        send('x');await wait(()=>screen().includes('Command (kept only in memory)'),'Remote command editor');
        child.resize(60,20);terminal.resize(60,20);inputs.push({resize:{columns:60,rows:20},timestamp:new Date().toISOString()});
        await wait(()=>screen().includes('Local files are not synchronized'),'Narrow launch shows remote context');
        send('\x1b[200~printf "hello"\nprintf "world"\x1b[201~');
        await wait(()=>screen().includes('printf "world"'),'Multiline paste remains editable');
        assert.ok(!screen().includes('Enter sends once'));
        send('\r');await wait(()=>screen().includes('Enter sends once'),'Separate command review');
        send('\x1b');await wait(()=>screen().includes('Enter reviews'),'Escape returns to editing');
        send('\x7f');await wait(()=>screen().includes('printf "world')&&!screen().includes('printf "world"'),'Backspace edits command');
        send('"');await wait(()=>screen().includes('printf "world"'),'Literal text restores command');
        send('\r');await wait(()=>screen().includes('Enter sends once'),'Review restored command');
        send('\r');await wait(()=>screen().includes(mode==='launch-lost'?'Command outcome is unconfirmed':'Exit code: 4'),'Single dispatch outcome');
        assert.ok(screen().includes('Recovery ID saved'));
        send('r');await wait(()=>screen().includes('Process ownership: descendants_live'),'Inspect same launched execution');
      }else{
      send('\x1b[B');await wait(()=>screen().includes('> 20000000'),'Arrow stays within one item');
      send('\r');await wait(()=>screen().includes('Process ownership: descendants_live'),'Exact operation inspected');
      send('\x1b[200~c\r\x1b[201~');await new Promise(r=>setTimeout(r,100));await tail;
      assert.ok(!screen().includes('Enter confirms'));
      screens.push({label:'Pasted confirmation ignored',screen:screen(),timestamp:new Date().toISOString()});
      send('c');await wait(()=>screen().includes('Enter confirms'),'Explicit cancellation confirmation');
      send('\x1b');await wait(()=>!screen().includes('Enter confirms'),'Escape cancels confirmation');
      send('c');await wait(()=>screen().includes('Enter confirms'),'Confirmation reopened');
      send('\r');await wait(()=>screen().includes(mode==='lost'?'Cancellation not confirmed':'Cancellation accepted'),'Cancellation result retains ownership');
      assert.ok(screen().includes('descendants_live'));
      child.resize(60,20);terminal.resize(60,20);inputs.push({resize:{columns:60,rows:20},timestamp:new Date().toISOString()});
      await wait(()=>screen().includes('Process ownership: descendants_live'),'Narrow terminal shows ownership');
      send('r');await wait(()=>screen().includes('ownership is cleared'),'Readback confirms cleanup without replay');
      }
      send('\x1b');await wait(()=>screen().includes(mode.startsWith('launch')?'exited / descendants_live':'exited / cleared'),'Back returns to inventory');
      send('\x1b');await wait(()=>screen().includes('execution-menu-fixture'),'Back returns to Machines');
      send('\x03');await Promise.race([exited,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('process did not exit')),10000);t.unref();})]);
      await tail;
      const events=(await readFile(ledger,'utf8')).trim().split('\n').map(JSON.parse);
      results.push({mode,pid:child.pid,inputs,screens,events,exit,raw,rawSha256:createHash('sha256').update(raw).digest('hex')});
      assert.equal(events.filter(e=>e.method==='POST').length,1);assert.equal(exit.exitCode,0);
      assert.equal(terminal.buffer.active.type,'normal');
    }catch(error){
      if(process.argv[2])await writeFile(path.resolve(process.argv[2])+'.failed.json',JSON.stringify({status:'FAIL',mode,error:String(error),results,current:{inputs,screens,raw,exit}},null,2));
      throw error;
    }finally{if(!exit){child.kill();await exited;}terminal.dispose();}
  }
  const result={status:'PASS',scope:'Real ConPTY, source CLI, strict API decoder and synthetic backend; not installed or production acceptance',dimensions:{columns:110,rows:26},results};
  if(process.argv[2])await writeFile(path.resolve(process.argv[2]),JSON.stringify(result,null,2));
  console.log(JSON.stringify({status:result.status,scope:result.scope,cases:results.map(({mode,exit})=>({mode,exit}))}));
}finally{
  assert.equal(path.dirname(directory),tmpdir());assert.ok(path.basename(directory).startsWith('cuna-executions-menu-'));
  await rm(directory,{recursive:true,force:true});
}
// All recorded child exits, terminal restorations and owned cleanup precede
// terminating the standalone node-pty helper handles on Windows.
process.exit(0);
