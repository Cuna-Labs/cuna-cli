import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile,access} from "node:fs/promises";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import path from "node:path";
import xtermHeadless from "@xterm/headless";

if(process.platform!=="win32"||process.arch!=="x64"){
  console.log(JSON.stringify({result:"UNVERIFIED",reason:"Windows x64 ConPTY required"}));process.exit(2);
}
const root=path.resolve(import.meta.dirname,"../..");
const args=process.argv.slice(2);
const argument=(name,fallback)=>{const index=args.indexOf(name);return index<0?fallback:path.resolve(args[index+1]);};
const moduleRoot=argument("--module-root",root),ptyRoot=argument("--pty-root",root),evidence=argument("--evidence",undefined);
const {spawn}=createRequire(path.join(ptyRoot,"test/windows-conpty/package.json"))("node-pty");
const fixture=path.join(root,"test/fixtures/workspace-selection-conpty.mjs");
const sha256=file=>createHash("sha256").update(readFileSync(file)).digest("hex");
const moduleFiles=["workspace/selection-screen.js","workspace/selection-service.js","workspace/binding-store.js","pty/node-host-terminal.js"];
const moduleHashes=Object.fromEntries(moduleFiles.map(file=>[file,sha256(path.join(moduleRoot,"dist",file))]));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const scratch=await mkdtemp(path.join(await realpath(tmpdir()),"cuna-ws-conpty-"));
const cases=[];
let allChildrenExited=true;
async function runCase(mode){
  const caseRoot=path.join(scratch,mode);await mkdir(caseRoot);
  const terminal=new xtermHeadless.Terminal({allowProposedApi:true,cols:100,rows:25,scrollback:100});
  let raw="",writeTail=Promise.resolve(),exitResult,overflow=false;
  const steps=[];let outcome;
  const env={TERM:"xterm-256color"};
  for(const name of ["PATH","Path","SystemRoot","SYSTEMROOT","WINDIR","TEMP","TMP","COMSPEC"]){if(process.env[name]!==undefined)env[name]=process.env[name];}
  const child=spawn(process.execPath,[fixture,moduleRoot,caseRoot,mode],{cwd:caseRoot,env,name:"xterm-256color",cols:100,rows:25,useConpty:true,useConptyDll:false});
  child.onData(data=>{
    if(raw.length+data.length>2_000_000){overflow=true;return;}
    raw+=data;writeTail=writeTail.then(()=>new Promise(resolve=>terminal.write(data,resolve)));
  });
  child.onExit(value=>{exitResult=value;});
  const screen=()=>Array.from({length:terminal.rows},(_,i)=>terminal.buffer.active.getLine(terminal.buffer.active.viewportY+i)?.translateToString(true)??"").join("\n");
  async function until(predicate,label,timeout=8000){
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline){await writeTail;assert.equal(overflow,false,"raw capture limit");if(predicate())return;
      if(exitResult!==undefined)throw new Error(`${label}: child exited ${exitResult.exitCode}`);await pause(15);}
    throw new Error(`Timeout: ${label}`);
  }
  function observe(label){steps.push({label,cols:terminal.cols,rows:terminal.rows,activeScreen:terminal.buffer.active.type,screen:screen()});}
  const ledger=async()=>JSON.parse(await readFile(path.join(caseRoot,"mutations.json"),"utf8"));
  async function key(bytes,predicate,label){child.write(bytes);await until(predicate,label);observe(label);}
  try{
    await until(()=>screen().includes("Project context: choose"),"source");observe("source");assert.equal(terminal.buffer.active.type,"alternate");
    if(mode==="cancel")child.write("\x03");
    else if(mode==="back")child.write("\x1b");
    else{
      await key("\r",()=>screen().includes("Create an independent Workspace"),"choices");
      if(mode==="new"){
        await key("\x1b",()=>screen().includes("Project context: choose"),"Escape choices to source");
        await key("\r",()=>screen().includes("Create an independent Workspace"),"choices reloaded");
      }
      child.resize(60,25);terminal.resize(60,25);await pause(100);await writeTail;observe("resize 60 columns");
      if(mode==="adopt")await key("\x1b[B",()=>screen().includes("> 66666666-6666-4666-8666-666666666666"),"adopt selected");
      await key("\r",()=>screen().includes("Choose an existing local folder"),"destination");
      await key("\x1b[200~destinationx\x1b[201~",()=>screen().includes("> destinationx"),"single-line bracketed paste");
      await key("\x7f",()=>screen().includes("> destination")&&!screen().includes("destinationx"),"Backspace correction");
      await key("\r",()=>screen().includes("Enter confirms the binding"),"confirmation shown");
      child.write("\n");await pause(250);await writeTail;
      assert.match(screen(),/Enter confirms the binding/u);assert.deepEqual(await ledger(),[]);observe("split LF does not confirm");
      await key("\x1b",()=>screen().includes("Choose an existing local folder"),"Escape confirmation to destination");
      await key("\r",()=>screen().includes("Enter confirms the binding"),"confirmation shown again");
      assert.deepEqual(await ledger(),[]);
      if(mode==="existing"){
        await key("\r",()=>screen().includes("already has a Workspace binding"),"existing destination refused");
        assert.deepEqual(await ledger(),[]);child.write("\x03");
      }else{
        await key("\r",()=>screen().includes("Workspace binding saved"),"separate Enter saves");
        assert.equal((await ledger()).length,1);child.write("\r");
      }
    }
    await until(()=>exitResult!==undefined,"child exit",5000);await pause(50);await writeTail;
    assert.equal(exitResult.exitCode,0);assert.equal(terminal.buffer.active.type,"normal");observe("restored");
    const result=JSON.parse(await readFile(path.join(caseRoot,"result.json"),"utf8"));
    assert.equal(result.rawMode,false);assert.equal(result.sourceUnchanged,true);assert.equal(result.sentinelsUnchanged,true);
    outcome={mode,result:"PASS",exitCode:exitResult.exitCode,childPid:child.pid,restored:true,steps,fixture:result,raw};
  }catch(error){outcome={mode,result:"FAIL",error:error.message,steps,screen:screen(),raw,exit:exitResult??null};}
  finally{
    if(exitResult===undefined){try{child.kill();}catch{}
      const deadline=Date.now()+3000;while(exitResult===undefined&&Date.now()<deadline)await pause(20);}
    await writeTail;terminal.dispose();
    if(exitResult===undefined)allChildrenExited=false;
  }
  if(exitResult===undefined)return {...outcome,result:"FAIL",error:`ConPTY child did not exit: ${mode}`};
  return outcome;
}
let cleanup=false;
try{for(const mode of ["new","adopt","existing","cancel","back"])cases.push(await runCase(mode));}
finally{
  if(allChildrenExited){
    const resolved=await realpath(scratch),base=await realpath(tmpdir());
    assert.equal(path.dirname(resolved).toLowerCase(),base.toLowerCase());assert.match(path.basename(resolved),/^cuna-ws-conpty-[A-Za-z0-9]+$/u);
    await rm(resolved,{recursive:true,force:false});
    cleanup=await access(resolved).then(()=>false,error=>{if(error.code!=="ENOENT")throw error;return true;});
  }
}
const unchanged=moduleFiles.every(file=>sha256(path.join(moduleRoot,"dist",file))===moduleHashes[file]);
const report={result:cases.every(item=>item.result==="PASS")&&cleanup&&unchanged?"PASS":"FAIL",
  scope:"LOCAL_WINDOWS_CONPTY_ACTUAL_SCREEN_SERVICE_FILESYSTEM_SYNTHETIC_API",node:process.version,moduleRoot,moduleHashes,
  modulesUnchanged:unchanged,harnessHash:sha256(import.meta.filename),fixtureHash:sha256(fixture),ownedTemporaryCleanup:cleanup,
  ...(cleanup?{}:{retainedScratch:scratch}),cases};
if(evidence!==undefined){await mkdir(evidence,{recursive:true});await writeFile(path.join(evidence,"report.json"),JSON.stringify(report,null,2));}
process.stdout.write(JSON.stringify({...report,evidence,cases:cases.map(item=>({mode:item.mode,result:item.result,error:item.error,
  observedSteps:item.steps.length,exitCode:item.exitCode,restored:item.restored,rawBytes:Buffer.byteLength(item.raw)}))},null,2)+"\n",()=>process.exit(report.result==="PASS"?0:1));
