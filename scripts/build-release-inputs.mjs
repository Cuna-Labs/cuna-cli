import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { invariant, parseArgs } from "./lib/release-evidence.mjs";
import { buildReleaseInputs } from "./lib/release-inputs.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const output = path.resolve(root, args.get("output") ?? "evidence/release-inputs.json");
const sourceCommit = args.get("source-commit");
const npmVersion = args.get("npm-version");
const runner = args.get("runner");
invariant(typeof sourceCommit === "string", "--source-commit is required");
invariant(typeof npmVersion === "string", "--npm-version is required");
invariant(typeof runner === "string", "--runner is required");

const inputs = await buildReleaseInputs({ root, sourceCommit, npmVersion, runner });
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(inputs, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify({ status: "release-inputs-bound", sha256: inputs.payload.sha256 })}\n`);
