import process from "node:process";

import { runCli } from "../../dist/index.js";
import { runLocalRichForeground } from "./local-rich-foreground.mjs";

const configFile = process.argv[2];
if (configFile === undefined) throw new Error("machines-to-foreground fixture requires a config path");
const options = new Set(process.argv.slice(3));
const bareRoot = options.has("--bare");
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
      interactiveMenu: openCode,
      color: input.color,
    });
  },
});
process.exitCode = exitCode;
