// Synthetic transport only; real factory, runtime, VTE and native terminal host.
import assert from "node:assert/strict";
import {runNodeForegroundSessions} from "../../dist/runtime/node-foreground-session.js";
import {encodeTerminalControl,encodeTerminalFrame,decodeTerminalFrame,decodeTerminalControl,TERMINAL_PROTOCOL} from "../../dist/terminal/codec.js";
const NOW=Date.now();
const SESSION_A="11111111-1111-4111-8111-111111111111",SESSION_B="22222222-2222-4222-8222-222222222222";
function session(id, overrides = {}) {
  return {
    id,
    machineId: "33333333-3333-4333-8333-333333333333",
    name: `session ${id.slice(0, 4)}`,
    agent: id === SESSION_A ? "claude-code" : "codex",
    cwd: "/workspace",
    authMode: "interactive_login",
    desiredState: "running",
    requestState: "launched",
    processState: "running",
    processEpoch: `epoch-${id}`,
    runtimeObservedAt: new Date(NOW - 500).toISOString(),
    rowVersion: 1,
    createdAt: new Date(NOW - 10_000).toISOString(),
    updatedAt: new Date(NOW - 500).toISOString(),
    ...overrides,
  };
}

function capability(id, availability = "supported") {
  return {
    schemaVersion: "1.0",
    subjectScope: "agent_session",
    subjectId: id,
    observedAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 30_000).toISOString(),
    etag: `etag-${id}`,
    capabilities: [{
      id: "terminal_connections.create",
      availability,
      interaction: "native",
      mutationClass: "reversible",
      surfaces: ["cli"],
      requiredPermissions: ["terminal.connect"],
    }],
  };
}

function observation(id, overrides = {}) {
  return {
    authority: "cuna_agent_session_supervisor",
    userId: "user-1",
    machineId: "33333333-3333-4333-8333-333333333333",
    agentSessionId: id,
    processEpoch: `epoch-${id}`,
    state: "running",
    observedAt: new Date(NOW - 500).toISOString(),
    expiresAt: new Date(NOW + 20_000).toISOString(),
    evidenceRevision: `revision-${id}`,
    ...overrides,
  };
}

function fakeClient(events, overrides = {}) {
  return {
    async getAgentSession(id) { events.push(`get:${id}`); return session(id); },
    ...overrides,
  };
}

class AsyncByteQueue {
  values = [];
  waiters = [];
  closed = false;
  push(value) {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(value);
    else waiter({ done: false, value });
  }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }
  [Symbol.asyncIterator]() { return this; }
  next() {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function terminalSystem(events, availability = () => "supported", canonical = false) {
  let generation = 0;
  let connectFailuresRemaining = 0;
  const grants = new Map();
  const activeQueues = new Set();
  const offers = [];
  const sent = [];
  const issuedRequests = new Map();
  const cancelledRequests = [];
  const controlPlane = {
    async cancelTerminalConnection(input) {
      const { signal, ...request } = input;
      assert.ok(issuedRequests.has(input.idempotencyKey), "cleanup names an issued request");
      assert.deepEqual(request, issuedRequests.get(input.idempotencyKey), "cleanup preserves original subject/body/key");
      assert.equal(signal.aborted, false, "cleanup has independent bounded cancellation");
      cancelledRequests.push(request);
      return { cancelled: true };
    },
    async discoverCapabilities(_scope, id) {
      events.push(`capability:${id}`);
      return capability(id, availability(id));
    },
    async observeAgentSession(id) {
      events.push(`observe:${id}`);
      return observation(id);
    },
    async createTerminalConnection(input) {
      const { signal: _signal, ...request } = input;
      issuedRequests.set(input.idempotencyKey, request);
      events.push(`grant:${input.agentSessionId}`);
      generation += 1;
      const terminalSessionId = `00000000-0000-4000-8000-${String(generation).padStart(12, "0")}`;
      const grant = {
        terminalSessionId,
        resumeHandle: "66666666-6666-4666-8666-666666666666",
        connectUrl: `wss://api.getcuna.com/v1/terminal-connections/${terminalSessionId}/stream`,
        connectToken: `runa_tc_${"A".repeat(43)}`,
        protocol: TERMINAL_PROTOCOL,
        capabilities: [
          { name: "acknowledgement", availability: "supported" },
          { name: "heartbeat", availability: "supported" },
          { name: "live_resize", availability: "supported" },
          { name: "resume", availability: "supported" },
          { name: "signals", availability: "supported" },
        ],
        expiresAt: new Date(NOW + 20_000).toISOString(),
        agentSessionId: input.agentSessionId,
        processEpoch: `epoch-${input.agentSessionId}`,
        attachmentGeneration: generation,
      };
      grants.set(terminalSessionId, grant);
      return grant;
    },
  };
  const terminalConnector = {
    async connect(input) {
      events.push("wire:connect");
      offers.push(input.terminalViewProtocol);
      if (connectFailuresRemaining > 0) {
        connectFailuresRemaining -= 1;
        throw new Error("replacement unavailable");
      }
      const terminalSessionId = new URL(input.url).pathname.split("/").at(-2);
      const grant = grants.get(terminalSessionId);
      assert.ok(grant);
      const queue = new AsyncByteQueue();
      activeQueues.add(queue);
      queue.push(encodeTerminalControl("ready", 1n, {
        protocol: TERMINAL_PROTOCOL,
        agentSessionId: grant.agentSessionId,
        processEpoch: grant.processEpoch,
        fencingGeneration: grant.attachmentGeneration,
        resizeCapability: "live",
        accessMode: "writer",
        writerEpoch: 1,
        ...(canonical ? {terminalViewProtocol:{name:"cuna.terminal-view.v1",operation:"new",history:"current_view"}} : {}),
      }));
      assert.equal(input.terminalViewProtocol,"cuna.terminal-view.v1");
      let sequence=0n;let received="";
      const output=(text)=>queue.push(encodeTerminalFrame({type:"output",critical:false,sequence:++sequence,payload:new TextEncoder().encode("\x1b[2J\x1b[H"+text)}));
      const viewId=`aaaaaaaa-aaaa-4aaa-8aaa-${String(generation).padStart(12,"0")}`;
      setTimeout(()=>{
        queue.push(encodeTerminalControl("view_started",0n,{protocol:"cuna.terminal-view.v1",operation:"new",viewId,columns:80,rows:22}));
        output(`CANONICAL_VIEW_${generation} 界`);
        setTimeout(()=>queue.push(encodeTerminalControl("view_ready",0n,{viewId,afterOutputSequence:sequence.toString()})),300);
      },1200);
      events.push("wire:connected");
      return {
        connectionId: terminalSessionId,
        receive: () => queue,
        async send(bytes) {
          const frame=decodeTerminalFrame(bytes);sent.push(frame);
          if(frame.type==="input") {
            const hex=Buffer.from(frame.payload).toString("hex");
            if(hex==="7e") {activeQueues.delete(queue);queue.close();return;}
            received+=hex;output(`CANONICAL_VIEW_${generation} 界\r\nINPUT_HEX ${received}`);
          }
          if(frame.type==="resize") {const p=decodeTerminalControl(frame);if(sequence>0n)output(`CANONICAL_VIEW_${generation} 界\r\nRESIZE ${p.columns}x${p.rows}`);}
        },
        async close() { events.push(`wire:close:${terminalSessionId}`); activeQueues.delete(queue); queue.close(); },
      };
    },
  };
  return {
    controlPlane,
    offers, sent,
    push(bytes) { for (const queue of activeQueues) queue.push(bytes); },
    cancelledRequests,
    terminalConnector,
    failNextConnections(count) { connectFailuresRemaining = count; },
    interruptActiveConnections() {
      for (const queue of activeQueues) {
        activeQueues.delete(queue);
        queue.close();
      }
    },
  };
}


const events=[];const system=terminalSystem(events,()=>"supported",true);
await runNodeForegroundSessions({client:fakeClient(events),baseUrl:"https://api.getcuna.com",agentSessionIds:[SESSION_A]}, {environment:{},controlPlane:system.controlPlane,terminalConnector:system.terminalConnector,clock:()=>Date.now(),coordinatorOptions:{reconnectBaseDelayMs:10}});
