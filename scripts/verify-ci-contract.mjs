import { access, readFile } from "node:fs/promises";
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

const ci = await readFile(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
const generator = "node scripts/release-project-distributions.mjs";
const verifier = "node scripts/verify-release-distributions.mjs";
invariant(!/(?:^|\s)node scripts\/project-distributions\.mjs(?:\s|$)/m.test(ci), "Authoritative CI still invokes the legacy distribution generator");
invariant(!/(?:^|\s)node scripts\/verify-distribution-projections\.mjs(?:\s|$)/m.test(ci), "Authoritative CI still invokes the legacy distribution verifier");
invariant(ci.split(generator).length - 1 === 1, "Authoritative CI must generate distributions exactly once");
invariant(ci.split(verifier).length - 1 === 3, "Candidate, admission, and handoff must each verify the distribution bundle");
const generatedAt = ci.indexOf(generator);
const firstVerifiedAt = ci.indexOf(verifier);
const candidateUploadAt = ci.indexOf("name: release-candidate");
invariant(generatedAt >= 0 && firstVerifiedAt > generatedAt, "Distribution verification must follow generation");
invariant(candidateUploadAt > firstVerifiedAt, "Candidate upload must follow distribution verification");
for (const command of [
  "sh -n release-artifacts/distributions/curl/install.sh",
  "ruby -c release-artifacts/distributions/homebrew/runa.rb",
  "bash -n release-artifacts/distributions/aur/PKGBUILD",
]) invariant(ci.includes(command), `Generated packaging syntax gate is missing: ${command}`);
invariant(!/npm\s+publish/.test(ci), "Candidate CI may not publish npm packages");
invariant(ci.includes("--output release-artifacts/distributions"), "Distribution output is not inside the immutable candidate artifact");
invariant(ci.includes("--distributions release-artifacts/distributions"), "Distribution verification does not bind the immutable candidate artifact");

process.stdout.write(`${JSON.stringify({ status: "verified", package: packageJson.name, version: packageJson.version })}\n`);
