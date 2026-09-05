import process from "node:process";

import { ForegroundTerminalCoordinator, runCli } from "../../dist/index.js";
import { runLocalRichForeground } from "./local-rich-foreground.mjs";

const configFile = process.argv[2];
if (configFile === undefined) throw new Error("machines-to-foreground fixture requires a config path");
const options = new Set(process.argv.slice(3));
const bareRoot = options.has("--bare");
const executionsReturn = options.has("--executions-return");
// Observe the real native boundary without consuming or changing input. Node
// schedules stdin's native readStop on nextTick after pause(); readableFlowing
// alone therefore cannot establish that it is safe to leave raw mode.
const nativeRestoreObservations = [];
const originalSetRawMode = process.stdin.setRawMode;
let redrawRequests = 0;
if (executionsReturn) {
  const originalBindRuntime = ForegroundTerminalCoordinator.prototype.bindRuntime;
  ForegroundTerminalCoordinator.prototype.bindRuntime = function (runtime) {
    const sendInput = runtime.sendInput.bind(runtime);
    runtime.sendInput = async (bytes) => {
      // Claude receives an explicit Ctrl+L repaint request after replay. Model
      // that control separately from the local fixture's text submission parser.
      if (bytes.length === 1 && bytes[0] === 12) { redrawRequests += 1; return; }
      return await sendInput(bytes);
    };
    return originalBindRuntime.call(this, runtime);
  };
  process.stdin.setRawMode = function (enabled) {
    if (!enabled) nativeRestoreObservations.push({
      paused: this.isPaused(),
      nativeReading: this._handle?.reading,
    });
    return originalSetRawMode.call(this, enabled);
  };
}
const openCode = options.has("--opencode");
const openCodeSessionId = "77777777-7777-4777-8777-777777777777";
const expectedAgent = openCode ? "opencode" : "claude-code";
const argv = openCode
  ? ["opencode", "--agent-session", openCodeSessionId, "--config-file", configFile]
  : bareRoot ? [] : ["machines", "--config-file", configFile];

const exitCode = await runCli(argv, {
  env: { ...process.env, CUNA_CONFIG_FILE: configFile, CUNA_TERMINAL_MODE: "rich" },
  foregroundTerminalRunner: async (input) => {
    const expectedSessionId = openCode ? openCodeSessionId : input.agentSessionIds[0];
    if (input.agentSessionIds.length !== 1 || input.agentSessionIds[0] !== expectedSessionId || input.expectedAgentKinds?.[0] !== expectedAgent) {
      throw new Error(`foreground fixture did not preserve the selected ${expectedAgent} AgentSession authority`);
    }
    // Keep the preflight seam open long enough for ConPTY to observe more than
    // the first frame, matching the real control-plane reads before ownership.
    await new Promise((resolve) => setTimeout(resolve, 180));
    input.onBeforeTerminalOwnership?.();
    await runLocalRichForeground({
      agentSessionId: input.agentSessionIds[0],
      marker: openCode ? "OPENCODE_TUI_ANSI256" : "FLOW_PROVIDER_ANSI256",
      agent: expectedAgent,
      providerLabel: expectedAgent,
      interactiveMenu: openCode || executionsReturn,
      color: input.color,
    });
  },
});
process.exitCode = exitCode;
if (executionsReturn) {
  process.stdin.setRawMode = originalSetRawMode;
  if (redrawRequests !== 1) throw new Error(`Expected one Claude replay redraw, received ${redrawRequests}`);
  if (nativeRestoreObservations.length < 4 || nativeRestoreObservations.some(
    (observation) => observation.paused !== true || observation.nativeReading !== false,
  )) throw new Error(`Unsafe native terminal restoration: ${JSON.stringify(nativeRestoreObservations)}`);
  console.log(`NATIVE_RESTORE_QUIESCENT ${nativeRestoreObservations.length}`);
}
