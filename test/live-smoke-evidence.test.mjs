import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const xtermStub = `export default { Terminal: class {
  constructor(o) { Object.assign(this,o); this.buffer={active:{type:'normal',getLine(){return {translateToString(){return 'CUNA Claude';}}}}}; }
  write(data,done){done();} resize(){} dispose(){}
}};`;
const ptyStub = `export function spawn() {
  let data, exit;
  return {
    pid: 12345,
    onData(fn){data=fn;setImmediate(()=>data('\\u001b[48;2;235;86;37m\\u001b[38;5;2mCUNA Claude'));},
    onExit(fn){exit=fn;},
    resize(){data('CUNA Claude resized');},
    write(){exit({exitCode:0});},
    _agent:{inSocket:{destroy(){}},_ptyNative:{kill(){}},_conoutSocketWorker:{_worker:{threadId:-1},dispose(){}}}
  };
}`;

for (const mode of ["plain", "rich"]) {
  test(`${mode} live smoke rejects a presentation-only success at the real reporting call site`, () => {
    const preload = `
      import Module, { registerHooks, syncBuiltinESMExports } from 'node:module';
      import cp from 'node:child_process';
      const timer=globalThis.setTimeout;
      globalThis.setTimeout=(fn,ms,...args)=>timer(fn,Math.min(ms,10),...args);
      cp.spawn=cp.spawnSync=cp.execFileSync=()=>{throw new Error('UNEXPECTED_EXTERNAL_PROCESS');};
      syncBuiltinESMExports();
      const stubs=${JSON.stringify({ "@xterm/headless": xtermStub, "node-pty": ptyStub })};
      const pty=await import('data:text/javascript,'+encodeURIComponent(stubs['node-pty']));
      const load=Module._load;
      Module._load=function(specifier,...args){if(specifier==='node-pty')return pty;return load.call(this,specifier,...args);};
      registerHooks({resolve(specifier,context,next){
        if(specifier==='@xterm/headless') return {url:'data:text/javascript,'+encodeURIComponent(stubs[specifier]),shortCircuit:true};
        return next(specifier,context);
      }});
    `;
    const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`,
      path.join(root, "scripts/harness/live-foreground-smoke.mjs"), "11111111-1111-4111-8111-111111111111", mode], {
      cwd: root, encoding: "utf8", timeout: 20_000, windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.result, "UNVERIFIED");
    assert.equal(report.observations.hostResizeRequested, true);
    assert.equal(report.observations.remotePtyResize, "UNVERIFIED");
    assert.equal(report.observations.resize, undefined);
  });
}

test("OpenCode keeps grant redemption distinct from the mandatory unresolved PTY witness (source guard)", async () => {
  const source = await readFile(path.join(root, "scripts/harness/live-opencode-journey.mjs"), "utf8");
  assert.match(source, /"terminal_grant_redeemed —/u);
  assert.match(source, /name: "attach_pty — remote PTY attachment and execution",\s*observed: false,\s*unwitnessable: true/u);
  assert.doesNotMatch(source, /A row with redeemed_at set is an attach/u);
  assert.match(source, /else if \(unwitnessed.length > 0\)[\s\S]*process.exitCode = 2/u);
});
