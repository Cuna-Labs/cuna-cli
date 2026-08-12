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
const runtimeDependencyNames = Object.keys(packageJson.dependencies ?? {}).sort();
const optionalDependencyNames = Object.keys(packageJson.optionalDependencies ?? {}).sort();
const bundledDependencyNames = Array.isArray(packageJson.bundleDependencies)
  ? [...packageJson.bundleDependencies].sort()
  : [];
if (JSON.stringify(bundledDependencyNames) !== JSON.stringify(runtimeDependencyNames)) {
  findings.push(
    `bundleDependencies must equal the exact runtime dependency closure: expected ${runtimeDependencyNames.join(", ") || "<empty>"}`,
  );
}

// Platform-native authentication packages are deliberately separate optional
// dependencies. Bundling them into the architecture-neutral root tarball would
// either ship foreign binaries or make the root artifact platform-specific.
// The root may name them only as one complete, exact-version cohort after all
// three packages exist in the canonical registry and the immutable release
// index admits their signed contents.
const nativePackageCohort = [
  ["@cuna_labs/cli-native-darwin-arm64", "darwin", "arm64"],
  ["@cuna_labs/cli-native-darwin-x64", "darwin", "x64"],
  ["@cuna_labs/cli-native-win32-x64", "win32", "x64"],
];
const expectedNativeNames = nativePackageCohort.map(([name]) => name).sort();
const selectedNativeNames = optionalDependencyNames
  .filter((name) => name.startsWith("@cuna_labs/cli-native-"))
  .sort();
if (JSON.stringify(optionalDependencyNames) !== JSON.stringify(selectedNativeNames)) {
  findings.push("optionalDependencies may contain only the governed Cuna native package cohort");
}
if (selectedNativeNames.length > 0 &&
    JSON.stringify(selectedNativeNames) !== JSON.stringify(expectedNativeNames)) {
  findings.push("native optional dependencies must be admitted as one complete platform cohort");
}
if (selectedNativeNames.length > 0 &&
    !sameStringMap(
      lock.packages[""]?.optionalDependencies ?? {},
      packageJson.optionalDependencies ?? {},
    )) {
  findings.push("root lock optionalDependencies must exactly match package.json");
}
for (const [name, os, cpu] of nativePackageCohort) {
  const selectedVersion = packageJson.optionalDependencies?.[name];
  if (selectedVersion === undefined) continue;
  if (selectedVersion !== packageJson.version) {
    findings.push(`optionalDependencies.${name}: native package version must equal root version ${packageJson.version}`);
  }
  const locked = lock.packages[`node_modules/${name}`];
  if (locked?.optional !== true || locked?.inBundle === true ||
      JSON.stringify(locked?.os) !== JSON.stringify([os]) ||
      JSON.stringify(locked?.cpu) !== JSON.stringify([cpu])) {
    findings.push(`${name}: lock entry must be optional, unbundled, and bound to ${os}/${cpu}`);
  }
}
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
      } else if (section === "dependencies" && locked.inBundle !== true) {
        findings.push(`${section}.${name}: runtime dependency is not marked as bundled in package-lock.json`);
      } else if (section === "optionalDependencies" && locked.inBundle === true) {
        findings.push(`${section}.${name}: platform optional dependency must not be bundled in the root tarball`);
      }
    }
  }
}

function sameStringMap(left, right) {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
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
