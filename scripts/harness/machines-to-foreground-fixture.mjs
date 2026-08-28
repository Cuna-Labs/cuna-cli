import process from "node:process";

import { runCli } from "../../dist/index.js";
import { runLocalRichForeground } from "./local-rich-foreground.mjs";

const configFile = process.argv[2];
if (configFile === undefined) throw new Error("machines-to-foreground fixture requires a config path");
const bareRoot = process.argv[3] === "--bare";

const exitCode = await runCli(bareRoot ? [] : ["machines", "--config-file", configFile], {
  env: { ...process.env, CUNA_CONFIG_FILE: configFile, CUNA_TERMINAL_MODE: "rich" },
  foregroundTerminalRunner: async (input) => {
    if (input.agentSessionIds.length !== 1 || input.expectedAgentKinds?.[0] !== "claude-code") {
      throw new Error("machines explorer did not preserve the selected Claude AgentSession authority");
    }
    // Keep the preflight seam open long enough for ConPTY to observe more than
    // the first frame, matching the real control-plane reads before ownership.
    await new Promise((resolve) => setTimeout(resolve, 180));
    input.onBeforeTerminalOwnership?.();
    await runLocalRichForeground({
      agentSessionId: input.agentSessionIds[0],
      marker: "FLOW_PROVIDER_ANSI256",
    });
  },
});
process.exitCode = exitCode;
