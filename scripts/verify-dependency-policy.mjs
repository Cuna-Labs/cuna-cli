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
  if (typeof entry.resolved !== "string" || entry.resolved.length === 0) {
    findings.push(`${location}: missing canonical resolved source`);
  } else {
    try {
      const resolved = new URL(entry.resolved);
      if (
        resolved.protocol !== "https:" ||
        resolved.hostname !== "registry.npmjs.org" ||
        resolved.port !== "" ||
        resolved.username !== "" ||
        resolved.password !== "" ||
        resolved.search !== "" ||
        resolved.hash !== "" ||
        !resolved.pathname.startsWith("/")
      ) {
        findings.push(`${location}: non-canonical source ${entry.resolved}`);
      }
    } catch {
      findings.push(`${location}: invalid resolved source ${entry.resolved}`);
    }
  }
  if (typeof entry.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.integrity)) {
    findings.push(`${location}: missing or non-SHA-512 integrity`);
  }
}

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
for (const section of ["dependencies", "optionalDependencies", "devDependencies"]) {
  for (const [name, version] of Object.entries(packageJson[section] ?? {})) {
    if (/^(git\+|git:|https?:|file:|github:|workspace:)/.test(version)) findings.push(`${section}.${name}: prohibited source ${version}`);
    if ((section === "dependencies" || section === "optionalDependencies") && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
      findings.push(`${section}.${name}: runtime dependencies must use an exact version, received ${version}`);
    }
    if (section === "dependencies" || section === "optionalDependencies") {
      const locked = lock.packages[`node_modules/${name}`];
      if (locked === undefined || locked.version !== version) {
        findings.push(`${section}.${name}: lock entry does not match exact runtime version ${version}`);
      }
    }
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
