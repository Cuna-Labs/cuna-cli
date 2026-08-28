import { ForegroundTerminalCoordinator } from "../../dist/index.js";
import { createNodeForegroundTerminalHost } from "../../dist/pty/node-host-terminal.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEFAULT_SESSION_ID = "11111111-1111-4111-8111-111111111111";

export async function runLocalRichForeground(input = {}) {
  const sessionId = input.agentSessionId ?? DEFAULT_SESSION_ID;
  const marker = input.marker ?? "REMOTE_ANSI256";
  const agent = input.agent ?? "claude-code";
  const providerLabel = input.providerLabel ?? agent;
  const tabId = input.tabId ?? (agent === "claude-code" ? "claude" : agent);
  const intent = Object.freeze({
    tabId,
    agentSessionId: sessionId,
    label: providerLabel,
    agent,
  });
  let selectedMenuIndex = 0;
  let inputBuffer = "";
  const providerFrame = (suffix = "provider viewport ready") => input.interactiveMenu === true
    ? `\u001b[2J\u001b[H\u001b[38;5;208m${marker}\u001b[0m  OpenCode cloud session 界 🦊\r\n\r\n${selectedMenuIndex === 0 ? "\u001b[38;5;45m❯ Continue\u001b[0m" : "  Continue"}\r\n${selectedMenuIndex === 1 ? "\u001b[38;5;45m❯ Connect provider\u001b[0m" : "  Connect provider"}\r\n\r\n${suffix}`
    : `\u001b[2J\u001b[H\u001b[38;5;208m${marker}\u001b[0m\r\n${suffix}`;
  const snapshot = () => {
    const now = Date.now();
    return Object.freeze({
      tabId: intent.tabId,
      viewId: `${intent.tabId}:attachment:1`,
      userId: "user-1",
      machineId: "machine-1",
      agentSessionId: sessionId,
      processEpoch: "44444444-4444-4444-8444-444444444444",
      state: "active",
      fencingGeneration: 1,
      inputSequence: 0n,
      outputSequence: 0n,
      outputContinuity: "complete",
      resizeCapability: "live",
      heartbeatObservedAt: now - 100,
      heartbeatExpiresAt: now + 30_000,
    });
  };
  const outputEvent = (sequence, text) => {
    const state = snapshot();
    return Object.freeze({
      tabId: intent.tabId,
      agentSessionId: sessionId,
      binding: Object.freeze({
        userId: state.userId,
        machineId: state.machineId,
        agentSessionId: state.agentSessionId,
        processEpoch: state.processEpoch,
        fencingGeneration: state.fencingGeneration,
      }),
      sequence,
      bytes: encoder.encode(text),
      signal: new AbortController().signal,
    });
  };

  const coordinator = new ForegroundTerminalCoordinator({
    host: createNodeForegroundTerminalHost(),
    resizeCoalesceMs: 10,
    color: input.color ?? true,
  });
  const callbacks = coordinator.runtimeCallbacks();
  let outputSequence = 0n;
  const runtime = {
    activeTabId: intent.tabId,
    async attach() {
      const ready = snapshot();
      await callbacks.onTerminalReady(ready);
      outputSequence += 1n;
      await callbacks.onTerminalOutput(outputEvent(
        outputSequence,
        providerFrame(),
      ));
      return ready;
    },
    async detach() {
      if (input.detachDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, input.detachDelayMs));
      }
      if (input.detachFailure === true) throw new Error("LOCAL_DETACH_FAILURE");
    },
    async reconnect() { return snapshot(); },
    async sendInput(bytes) {
      if (input.interactiveMenu !== true) return;
      inputBuffer += decoder.decode(bytes, { stream: true });
      let changed = false;
      while (inputBuffer.includes("\u001b[B") || inputBuffer.includes("\u001b[A")) {
        const down = inputBuffer.indexOf("\u001b[B");
        const up = inputBuffer.indexOf("\u001b[A");
        const next = down >= 0 && (up < 0 || down < up) ? down : up;
        selectedMenuIndex = next === down ? 1 : 0;
        inputBuffer = inputBuffer.slice(next + 3);
        changed = true;
      }
      if (!changed) return;
      outputSequence += 1n;
      await callbacks.onTerminalOutput(outputEvent(outputSequence, providerFrame("↑↓ provider navigation ready")));
    },
    async resize(columns, rows) {
      if (columns !== 64 || rows !== 14) return;
      outputSequence += 1n;
      await callbacks.onTerminalOutput(outputEvent(
        outputSequence,
        providerFrame("RESIZED_64x14"),
      ));
    },
    switchActive() { return snapshot(); },
    async sendTerminalResponse() {},
  };

  coordinator.bindRuntime(runtime);
  await coordinator.start([intent]);
  await coordinator.waitForStop();
  if (coordinator.failure !== undefined) throw coordinator.failure;
}
