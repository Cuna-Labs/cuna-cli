import { access } from "node:fs/promises";
import path from "node:path";
import { invariant, parseArgs, readJson } from "./lib/release-evidence.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const packageJson = await readJson(path.join(root, "package.json"));

invariant(packageJson.name === "@runa_laboratories/cli", "Unexpected package name");
invariant(packageJson.license === "Apache-2.0", "package.json license must be Apache-2.0");
invariant(packageJson.private !== true, "Release package is marked private");
invariant(packageJson.publishConfig?.registry === "https://registry.npmjs.org", "Registry is not canonical npm");
invariant(packageJson.publishConfig?.access === "public", "npm access must be public");
invariant(packageJson.bin?.runa && typeof packageJson.bin.runa === "string", "package.json must expose exactly the runa binary");
invariant(Object.keys(packageJson.bin).length === 1, "package.json exposes unexpected binaries");
for (const requiredFile of ["dist", "README.md", "LICENSE", "NOTICE"]) {
  invariant(packageJson.files?.includes(requiredFile), `package.json files must include ${requiredFile}`);
}
invariant(packageJson.scripts && typeof packageJson.scripts === "object", "package.json scripts are missing");
for (const command of ["build", "lint", "typecheck", "test"]) {
  invariant(typeof packageJson.scripts[command] === "string" && packageJson.scripts[command].length > 0, `Required npm script is missing: ${command}`);
}
for (const [name, script] of Object.entries(packageJson.scripts)) {
  invariant(!/npm\s+publish/.test(script), `Local npm script may publish: ${name}`);
}
invariant(packageJson.scripts.preinstall === undefined && packageJson.scripts.install === undefined && packageJson.scripts.postinstall === undefined, "Install lifecycle scripts are prohibited");
invariant(packageJson.engines?.node, "Explicit Node engine range is required");
await access(path.join(root, "package-lock.json"));

process.stdout.write(`${JSON.stringify({ status: "verified", package: packageJson.name, version: packageJson.version })}\n`);
