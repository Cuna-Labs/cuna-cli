import type {ForegroundTerminalHost} from "../terminal/foreground.js";
import {createNodeForegroundTerminalHost} from "../pty/node-host-terminal.js";
import {sanitizeHumanTerminalOutput} from "../cli/output.js";
import {truncateTerminalLine} from "../terminal/cell-width.js";
import {readWorkspaceSelectionSource,listWorkspaceSelections,saveWorkspaceSelection,type WorkspaceSelectionContext} from "./selection-service.js";
import type {ExecutionWorkspace} from "../api/execution-workspaces.js";
import type {WorkspaceBindingRecord} from "./binding-store.js";

export async function runWorkspaceSelectionScreen(context:WorkspaceSelectionContext,sourcePath:string,host:ForegroundTerminalHost=createNodeForegroundTerminalHost(),signal?:AbortSignal):Promise<"saved"|"back"|"cancelled">{
  const lease=await host.acquire("rich");
  const abort=new AbortController();
  const encoder=new TextEncoder(),decoder=new TextDecoder();
  let phase:"source"|"choose"|"destination"|"confirm"|"done"="source";
  let text=sourcePath,destination="",index=0,busy=false,closed=false,cancelled=false,notice="";
  let choices:readonly ExecutionWorkspace[]=[];
  let displayedSource:WorkspaceBindingRecord|undefined;
  let sequence="",paste=false,previousCR=false,escapeTimer:ReturnType<typeof setTimeout>|undefined;
  let writes=Promise.resolve();
  let outcome:"saved"|"back"|"cancelled"="cancelled",revision=0;
  let finish!:()=>void;
  const done=new Promise<void>(resolve=>{finish=resolve;});
  const close=(reason:"saved"|"back"|"cancelled"="cancelled")=>{outcome=reason;cancelled=true;abort.abort();if(!busy){closed=true;finish();}};
  const render=()=>{
    if(closed)return;
    const lines=[" CUNA  /  Workspaces",""];
    if(phase==="source")lines.push(" Project context: choose an already linked local folder.",` > ${text}`);
    if(phase==="choose"){
      lines.push(" Same Project and Machine. Choose a remote Workspace:");
      const labels=["Create an independent Workspace",...choices.map(w=>`${w.executionWorkspaceId}  generation ${w.activeGeneration}`)];
      const start=Math.max(0,index-Math.max(1,host.dimensions().rows-10));
      labels.slice(start,start+Math.max(1,host.dimensions().rows-8)).forEach((label,i)=>lines.push(`${start+i===index?" >":"  "} ${label}`));
    }
    if(phase==="destination")lines.push(" Choose an existing local folder without a Workspace binding."," Its files will not be uploaded by this selection.",` > ${text}`);
    if(phase==="confirm")lines.push(index===0?" Create a separate remote Workspace.":` Adopt remote Workspace ${choices[index-1]!.executionWorkspaceId}.`,` Local folder: ${destination}`," The selected folder keeps its own files; this does not download remote files."," Enter confirms the binding. Esc returns.");
    if(phase==="done")lines.push(" Workspace binding saved.",` Local folder: ${destination}`," Open an agent in this folder to use it."," Existing remote files are preserved; synchronization may require reconciliation.");
    lines.push("",busy?" Working… Ctrl+C requests cancellation.":phase==="done"?" Enter or Esc closes.":" ↑↓ select  ·  Enter continue  ·  Esc back  ·  Ctrl+C cancel");
    if(notice)lines.push("",notice);
    const frame=lines.map(line=>truncateTerminalLine(sanitizeHumanTerminalOutput(line),host.dimensions().columns)).join("\r\n");
    const frameRevision=++revision;
    writes=writes.then(()=>frameRevision===revision&&!closed?host.write(encoder.encode("\x1b[H\x1b[2J"+frame)):undefined).catch(()=>close());
  };
  const act=async()=>{
    if(busy)return;
    if(phase==="done"){close("saved");return;}
    if(phase==="choose"){phase="destination";text="";notice="";render();return;}
    if(phase==="destination"){if(!text.trim()){notice="Enter a local folder path.";render();return;}destination=text;phase="confirm";render();return;}
    busy=true;notice="";render();
    try{
      if(phase==="source"){
        sourcePath=text;
        const source=await readWorkspaceSelectionSource(context,sourcePath,abort.signal);
        displayedSource=source;
        choices=await listWorkspaceSelections(context,source,abort.signal);phase="choose";index=0;
      }else{
        if(displayedSource===undefined)throw new Error("Reload the Project context before confirming.");
        await saveWorkspaceSelection(context,sourcePath,destination,index===0?undefined:choices[index-1]!.executionWorkspaceId,displayedSource,abort.signal);
        phase="done";
      }
    }catch(error){notice=error instanceof Error?error.message:"Workspace selection could not be confirmed.";}
    finally{busy=false;if(cancelled){closed=true;finish();}else render();}
  };
  const back=()=>{
    if(busy)return;
    if(phase==="source"||phase==="done"){close(phase==="done"?"saved":"back");return;}
    if(phase==="confirm"){phase="destination";text=destination;}
    else if(phase==="destination")phase="choose";
    else{phase="source";text=sourcePath;}
    notice="";render();
  };
  const input=host.onInput(bytes=>{
    for(const char of decoder.decode(bytes,{stream:true})){
      if(char==="\n"&&previousCR){previousCR=false;continue;}
      previousCR=char==="\r";
      if(char==="\x03"){close();break;}
      if(busy||closed)continue;
      if(sequence==="escape"){
        if(escapeTimer!==undefined)clearTimeout(escapeTimer);
        sequence=char==="["||char==="O"?"cursor":"";continue;
      }
      if(sequence.startsWith("cursor")){
        if(!/[A-Za-z~]/u.test(char)){sequence+=char;continue;}
        if(sequence==="cursor200"&&char==="~"){paste=true;sequence="";continue;}
        if(sequence==="cursor201"&&char==="~"){paste=false;sequence="";continue;}
        sequence="";
        if(phase==="choose"&&(char==="A"||char==="B")){index=Math.max(0,Math.min(choices.length,index+(char==="A"?-1:1)));render();}
        continue;
      }
      if(char==="\x1b"){sequence="escape";escapeTimer=setTimeout(()=>{sequence="";back();},150);continue;}
      if(char==="\r"||char==="\n"){if(paste){notice="Paste one folder path on a single line.";render();continue;}void act();break;}
      if(phase==="source"||phase==="destination"){
        if(char==="\x7f"||char==="\b")text=Array.from(text).slice(0,-1).join("");
        else if(!/[\p{Cc}\p{Cf}]/u.test(char)&&text.length<4096)text+=char;
        render();
      }
    }
  });
  const resize=host.onResize(render);
  const onAbort=()=>close();
  signal?.addEventListener("abort",onAbort,{once:true});
  if(signal?.aborted)close();else render();
  try{await done;}finally{
    input();resize();signal?.removeEventListener("abort",onAbort);if(escapeTimer!==undefined)clearTimeout(escapeTimer);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([writes,new Promise<void>(resolve=>{timer=setTimeout(resolve,2000);})]);}
    finally{if(timer!==undefined)clearTimeout(timer);await lease.restore();}
  }
  return outcome;
}
