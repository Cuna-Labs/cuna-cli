import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { invariant, parseArgs } from "./lib/release-evidence.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
invariant(lock.lockfileVersion >= 2, "package-lock.json must use lockfileVersion 2 or newer");
invariant(lock.packages && typeof lock.packages === "object", "package-lock package inventory is missing");

const findings = [];
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location) continue;
  if (entry.link) findings.push(`${location}: linked dependency`);
  if (entry.hasInstallScript) findings.push(`${location}: install script`);
  if (entry.resolved) {
    if (!entry.resolved.startsWith("https://registry.npmjs.org/")) findings.push(`${location}: non-canonical source ${entry.resolved}`);
    if (!entry.integrity) findings.push(`${location}: missing integrity`);
  }
}

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
for (const section of ["dependencies", "optionalDependencies", "devDependencies"]) {
  for (const [name, version] of Object.entries(packageJson[section] ?? {})) {
    if (/^(git\+|git:|https?:|file:|github:|workspace:)/.test(version)) findings.push(`${section}.${name}: prohibited source ${version}`);
  }
}

try {
  await access(path.join(root, ".npmrc"));
  const npmrc = await readFile(path.join(root, ".npmrc"), "utf8");
  if (/registry\s*=\s*(?!https:\/\/registry\.npmjs\.org\/?\s*$)/m.test(npmrc)) findings.push(".npmrc: non-canonical registry");
} catch {
  // Absence is acceptable because the workflow passes the canonical registry.
}

invariant(findings.length === 0, `Dependency policy violations:\n${findings.join("\n")}`);
process.stdout.write(`${JSON.stringify({ status: "verified", packages: Object.keys(lock.packages).length - 1 })}\n`);
