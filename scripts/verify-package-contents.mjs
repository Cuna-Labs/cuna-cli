import { gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { invariant, parseArgs } from "./lib/release-evidence.mjs";

const args = parseArgs(process.argv.slice(2));
const tarball = path.resolve(args.get("tarball") ?? "");
const archive = gunzipSync(await readFile(tarball));
const entries = [];
const bundledDependencyRoot = "package/node_modules/@xterm/headless/";

function octal(buffer) {
  const text = buffer.toString("ascii").replaceAll("\0", "").trim();
  return text ? Number.parseInt(text, 8) : 0;
}

for (let offset = 0; offset + 512 <= archive.length;) {
  const header = archive.subarray(offset, offset + 512);
  if (header.every((byte) => byte === 0)) break;
  const name = header.subarray(0, 100).toString("utf8").replaceAll("\0", "");
  const prefix = header.subarray(345, 500).toString("utf8").replaceAll("\0", "");
  const fullName = prefix ? `${prefix}/${name}` : name;
  const size = octal(header.subarray(124, 136));
  const type = String.fromCharCode(header[156] || 48);
  const bodyStart = offset + 512;
  entries.push({ name: fullName, size, type, body: archive.subarray(bodyStart, bodyStart + size) });
  offset = bodyStart + Math.ceil(size / 512) * 512;
}

invariant(entries.length > 0, "npm tarball is empty or unreadable");
const normalized = new Set();
for (const entry of entries) {
  invariant(entry.name.startsWith("package/"), `Tar entry escapes package root: ${entry.name}`);
  invariant(!entry.name.includes("\\") && !entry.name.includes("../"), `Unsafe tar entry: ${entry.name}`);
  invariant(entry.type !== "2" && entry.type !== "1", `Links are prohibited in npm tarball: ${entry.name}`);
  const key = entry.name.toLowerCase();
  invariant(!normalized.has(key), `Case-colliding tar entries: ${entry.name}`);
  normalized.add(key);
  invariant(
    entry.name === "package/package.json" ||
      entry.name === "package/LICENSE" ||
      entry.name === "package/NOTICE" ||
      entry.name === "package/THIRD_PARTY_NOTICES.md" ||
      entry.name === "package/README.md" ||
      entry.name.startsWith("package/dist/") ||
      entry.name.startsWith(bundledDependencyRoot),
    `Unexpected npm tarball content: ${entry.name}`,
  );
  if (entry.name.endsWith(".map")) {
    let sourceMap;
    try {
      sourceMap = JSON.parse(entry.body.toString("utf8"));
    } catch {
      throw new Error(`Malformed source map in npm tarball: ${entry.name}`);
    }
    if (!entry.name.startsWith(bundledDependencyRoot)) {
      invariant(
        !Array.isArray(sourceMap.sourcesContent) || sourceMap.sourcesContent.every((value) => value === null || value === ""),
        `Source map embeds source content: ${entry.name}`,
      );
    }
    invariant(
      !Array.isArray(sourceMap.sources) || sourceMap.sources.every((value) => typeof value === "string" && !/^(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/)/.test(value)),
      `Source map exposes an absolute developer path: ${entry.name}`,
    );
  }
}

for (const required of ["package/package.json", "package/LICENSE", "package/NOTICE", "package/THIRD_PARTY_NOTICES.md", "package/README.md"]) {
  invariant(normalized.has(required.toLowerCase()), `Required package file is absent: ${required}`);
}
const packageEntry = entries.find((entry) => entry.name === "package/package.json");
const packageJson = JSON.parse(packageEntry.body.toString("utf8"));
invariant(packageJson.name === "@runa_laboratories/cli", "Packed package identity differs");
invariant(packageJson.license === "Apache-2.0", "Packed package license differs");
invariant(packageJson.engines?.node === "^22.17.1 || ^24.4.1", "Packed package Node support range differs");
invariant(JSON.stringify(packageJson.cpu) === JSON.stringify(["x64"]), "Packed package architecture policy differs");
invariant(
  JSON.stringify(packageJson.os) === JSON.stringify(["win32", "darwin", "linux"]),
  "Packed package operating-system policy differs",
);
for (const script of ["preinstall", "install", "postinstall"]) {
  invariant(packageJson.scripts?.[script] === undefined, `Packed package contains prohibited ${script} lifecycle`);
}
invariant(typeof packageJson.bin?.runa === "string", "Packed package lacks runa bin");
invariant(
  JSON.stringify(packageJson.bundleDependencies) === JSON.stringify(["@xterm/headless"]),
  "Packed package must bundle the exact audited runtime dependency closure",
);
const binPath = `package/${packageJson.bin.runa.replace(/^\.\//, "")}`.toLowerCase();
invariant(normalized.has(binPath), "Packed runa bin target is absent");

const bundledManifest = entries.find((entry) => entry.name === `${bundledDependencyRoot}package.json`);
invariant(bundledManifest !== undefined, "Bundled @xterm/headless manifest is absent");
const bundledPackageJson = JSON.parse(bundledManifest.body.toString("utf8"));
invariant(bundledPackageJson.name === "@xterm/headless", "Bundled dependency identity differs");
invariant(bundledPackageJson.version === "6.0.0", "Bundled dependency version differs");
invariant(bundledPackageJson.license === "MIT", "Bundled dependency license differs");
for (const script of ["preinstall", "install", "postinstall"]) {
  invariant(bundledPackageJson.scripts?.[script] === undefined, `Bundled dependency contains prohibited ${script} lifecycle`);
}

process.stdout.write(`${JSON.stringify({ status: "verified", package: packageJson.name, version: packageJson.version, entries: entries.length })}\n`);
