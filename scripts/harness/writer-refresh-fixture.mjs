import assert from "node:assert/strict";
import { ForegroundTerminalCoordinator } from "../../dist/index.js";
import { createNodeForegroundTerminalHost } from "../../dist/pty/node-host-terminal.js";
import { runtimeFailure } from "../../dist/runtime/errors.js";

// Native foreground/input integration only. Runtime discovery, writer authority
// and provider output below are local fixtures, not server enforcement evidence.
const mode = process.argv[2];
assert.ok(mode === "supported" || mode === "unsupported");
const intent = { tabId: "fixture", agentSessionId: "77777777-7777-4777-8777-777777777777", agent: "opencode", label: "OpenCode" };
const coordinator = new ForegroundTerminalCoordinator({ host: createNodeForegroundTerminalHost(), color: true });
const callbacks = coordinator.runtimeCallbacks();
let accessMode = "observer", epoch = 1, outputSequence = 0n;
let capability = { supported: true, reasonCode: null, expiresAt: Date.now() - 1 };
let discoveries = 0, transfers = 0, accepted = "";
let observerInputDispatches = 0;
const snapshot = () => ({
  tabId: intent.tabId, viewId: "fixture:1", userId: "fixture-user", machineId: "fixture-machine",
  agentSessionId: intent.agentSessionId, processEpoch: "44444444-4444-4444-8444-444444444444",
  state: "active", fencingGeneration: 1, inputSequence: 0n, outputSequence,
  outputContinuity: "complete", resizeCapability: "live", accessMode, writerEpoch: epoch,
  writerTransferCapability: capability, heartbeatObservedAt: Date.now(), heartbeatExpiresAt: Date.now() + 60_000,
});
const output = async text => {
  const state = snapshot();
  await callbacks.onTerminalOutput({ tabId: intent.tabId, agentSessionId: intent.agentSessionId,
    binding: { userId: state.userId, machineId: state.machineId, agentSessionId: state.agentSessionId,
      processEpoch: state.processEpoch, fencingGeneration: state.fencingGeneration },
    sequence: ++outputSequence, bytes: new TextEncoder().encode(`\u001b[2J\u001b[HWRITER_REFRESH_FIXTURE\r\n${text}`),
    signal: new AbortController().signal });
};
const runtime = {
  activeTabId: intent.tabId,
  async attach() { const state = snapshot(); await callbacks.onTerminalReady(state); await output("EXPIRED_OBSERVER_READY"); return state; },
  async takeWriter({ tabId }) {
    assert.equal(tabId, intent.tabId);
    discoveries++;
    capability = mode === "supported"
      ? { supported: true, reasonCode: null, expiresAt: Date.now() + 59_000 }
      : { supported: false, reasonCode: "supervisor_writer_operation_unavailable", expiresAt: Date.now() + 59_000 };
    await callbacks.onTerminalState(snapshot());
    if (mode === "unsupported") throw runtimeFailure("capability_unsupported", "Fixture discovery refused transfer.", { safeDetails: { reason_code: capability.reasonCode } });
    transfers++;
    // Only this explicit simulated server notice changes the local seat.
    accessMode = "writer"; epoch = 2;
    await callbacks.onTerminalState(snapshot());
    await output("WRITER_READY");
    return snapshot();
  },
  async sendInput(bytes) {
    if (accessMode !== "writer") {
      observerInputDispatches++;
      throw runtimeFailure("terminal_observer", "Fixture observer input is disabled.");
    }
    accepted += new TextDecoder().decode(bytes);
    await output(`ACCEPTED ${JSON.stringify(accepted)}`);
  },
  async detach() {}, async resize() {}, async sendTerminalResponse() {},
  async reconnect() { return snapshot(); }, switchActive() { return snapshot(); },
};
coordinator.bindRuntime(runtime);
await coordinator.start([intent]);
await coordinator.waitForStop();
if (coordinator.failure !== undefined) throw coordinator.failure;
assert.equal(discoveries, 1);
assert.equal(transfers, mode === "supported" ? 1 : 0);
assert.equal(accepted, mode === "supported" ? "safe-input" : "");
assert.equal(observerInputDispatches, mode === "unsupported" ? 1 : 0, "unsupported input must exercise the runtime refusal exactly once");
console.log(`WRITER_REFRESH_RESULT ${JSON.stringify({ mode, discoveries, transfers, acceptedBytes: accepted.length, accessMode, observerInputDispatches })}`);
