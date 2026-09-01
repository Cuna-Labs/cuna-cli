import path from "node:path";
import { pathToFileURL } from "node:url";

const [installedRoot, agentSessionId, processEpoch, scenario = "clean"] = process.argv.slice(2);
if (!installedRoot || !agentSessionId || !processEpoch) throw new Error("installed terminal child arguments are required");
const { encodeTerminalControl, TERMINAL_PROTOCOL } = await import(pathToFileURL(path.join(installedRoot, "dist/terminal/codec.js")).href);
if (scenario === "exit-23") process.exit(23);
const frame = encodeTerminalControl("ready", 1n, { protocol: TERMINAL_PROTOCOL, agentSessionId, processEpoch, fencingGeneration: 1, accessMode: "writer", writerEpoch: 1, resizeCapability: "live" });
process.stdout.write(`${JSON.stringify({ event: "ready", frame: Buffer.from(frame).toString("base64") })}\n`);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (chunk.includes("close")) process.exit(0);
});
process.stdin.resume();
