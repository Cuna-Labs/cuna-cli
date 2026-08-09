import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { invariant, parseArgs, readJson } from "./lib/release-evidence.mjs";

const execute = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const envelope = await readJson(args.get("envelope") ?? "release-artifacts/release-envelope.json");
const requestedVersion = args.get("version");
invariant(envelope.version === requestedVersion, "Requested version differs from admitted candidate");

try {
  const result = await execute("npm", ["view", `${envelope.packageName}@${envelope.version}`, "version", "--json", "--registry", envelope.registry], {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.stdout.trim()) throw new Error(`Version already exists and immutable packages cannot be overwritten: ${result.stdout.trim()}`);
  throw new Error("Registry returned an ambiguous empty success response");
} catch (error) {
  if (error.message.startsWith("Version already exists") || error.message.startsWith("Registry returned")) throw error;
  const diagnostic = `${error.stderr ?? ""}\n${error.stdout ?? ""}`;
  if (!/E404|404 Not Found/.test(diagnostic)) throw new Error(`Registry absence could not be proven: ${diagnostic.trim()}`);
}

process.stdout.write(`${JSON.stringify({ status: "registry-version-absent", version: envelope.version })}\n`);
