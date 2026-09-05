import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {createCunaApiClient} from '../dist/api/client.js';
import {createHttpTransport} from '../dist/api/http.js';
const machine='10000000-0000-4000-8000-000000000001';
const operation='20000000-0000-4000-8000-000000000001';
const cwd='/workspace/workspaces/30000000-0000-4000-8000-000000000001';

for(const mode of ['result','lost','budget'])test(`real HTTP launch ${mode} retains one caller operation without replay`,async()=>{
  const requests=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part.toString();
    requests.push({method:req.method,path:req.url,body:JSON.parse(raw)});
    if(mode==='lost'){req.socket.destroy();return;}
    if(mode==='budget')return;
    res.writeHead(200,{'content-type':'application/json','X-Cuna-Execution-Id':operation});
    res.end(JSON.stringify({exit_code:4,stdout:'literal output\n',stderr:'',duration_ms:5,stdout_truncated:false,stderr_truncated:false}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const client=createCunaApiClient(createHttpTransport({baseUrl:`http://127.0.0.1:${server.address().port}`,timeoutMs:mode==='budget'?150:3000}));
    const result=client.executeManagedCommand(machine,operation,{command:'printf',args:['%s','a; b'],cwd,timeoutSecs:1});
    if(mode==='result')assert.equal((await result).exitCode,4);
    else await assert.rejects(result,error=>{
      assert.ok(error.code.startsWith('cuna.'),error.code);
      assert.ok((error.hint??'').includes(operation),`missing exact recovery identity: ${error.hint}`);
      assert.doesNotMatch(error.message,/a; b/);
      return true;
    });
    assert.deepEqual(requests,[{method:'POST',path:`/v1/sessions/${machine}/exec`,body:{operation_id:operation,command:'printf',args:['%s','a; b'],cwd,timeout_secs:1}}]);
  }finally{
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});
