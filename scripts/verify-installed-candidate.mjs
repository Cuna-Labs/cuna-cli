import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { invariant, parseArgs, readJson, sha256File, verifyEnvelopeFiles } from "./lib/release-evidence.mjs";
import { withOwnedTempDirectory } from "./lib/owned-temp.mjs";

const execute = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? "release-artifacts");
const receiptFile = path.resolve(args.get("receipt") ?? "evidence/platform-receipt.json");
const envelope = await readJson(path.join(root, "release-envelope.json"));
await verifyEnvelopeFiles(envelope, root);

let installed = false;
const verification = await withOwnedTempDirectory("runa-cli-install-", async (prefix) => {
  const emptyCache = path.join(prefix, "npm-cache");
  await mkdir(emptyCache, { recursive: false });
  await runNpm(["install", "--global", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--cache", emptyCache, "--prefix", prefix, path.join(root, envelope.tarball.file)], {
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  installed = true;
  const executable = process.platform === "win32"
    ? path.join(prefix, "node_modules", "@runa_laboratories", "cli", "dist", "bin", "runa.js")
    : path.join(prefix, "bin", "runa");
  if (process.platform === "win32") await stat(path.join(prefix, "runa.cmd"));
  const runExecutable = process.platform === "win32" ? process.execPath : executable;
  const executablePrefix = process.platform === "win32" ? [executable] : [];
  const selfTest = await execute(runExecutable, [...executablePrefix, "self-test", "--offline", "--json"], { windowsHide: true, timeout: 30_000 });
  const version = await execute(runExecutable, [...executablePrefix, "version", "--json"], { windowsHide: true, timeout: 30_000 });
  const selfTestJson = JSON.parse(selfTest.stdout);
  const versionJson = JSON.parse(version.stdout);
  invariant(selfTestJson.schema_version === "1" && selfTestJson.type === "result" && selfTestJson.command === "self-test", "Self-test envelope is invalid");
  invariant(versionJson.schema_version === "1" && versionJson.type === "result" && versionJson.command === "version", "Version envelope is invalid");
  invariant(selfTestJson.data?.ok === true, "Installed-artifact self-test did not report data.ok=true");
  invariant(versionJson.data?.version === envelope.version, "Installed version differs from candidate");
  invariant(/^[0-9a-f]{64}$/.test(versionJson.data?.buildDigest), "Installed build digest is missing or malformed");
  invariant(versionJson.data.buildDigest === envelope.identities.payloadSha256, "Installed payload identity differs from the release envelope");
  invariant(versionJson.data?.platform === process.platform, "Installed platform identity differs from runtime");
  invariant(versionJson.data?.architecture === process.arch, "Installed architecture identity differs from runtime");
  invariant(versionJson.data?.updateChannel === "npm", "Installed candidate does not identify npm as installer channel");
  invariant(
    versionJson.data?.protocolRange && typeof versionJson.data.protocolRange.minimum === "string" && typeof versionJson.data.protocolRange.maximum === "string",
    "Installed protocol range is missing",
  );
  return {
    schemaVersion: 2,
    releaseEnvelopeSha256: await sha256File(path.join(root, "release-envelope.json")),
    candidateSha256: envelope.tarball.sha256,
    releaseInputsSha256: envelope.releaseInputs.sha256,
    identities: envelope.identities,
    sourceCommit: envelope.sourceCommit,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    selfTest: "PASS",
    versionIdentity: "PASS",
    uninstallCleanup: "PASS",
    observedAt: new Date().toISOString(),
  };
}, {
  beforeRemove: async (prefix) => {
    if (!installed) return;
    const cleanupCache = path.join(prefix, "npm-cleanup-cache");
    await mkdir(cleanupCache, { recursive: true });
    await runNpm(["uninstall", "--global", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--cache", cleanupCache, "--prefix", prefix, envelope.packageName], {
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    for (const candidate of installedPaths(prefix)) await assertAbsent(candidate);
  },
});

await mkdir(path.dirname(receiptFile), { recursive: true });
await writeFile(
  receiptFile,
  `${JSON.stringify(verification, null, 2)}\n`,
  { flag: "wx" },
);
process.stdout.write(`${JSON.stringify({ status: "installed-artifact-verified", platform: process.platform, architecture: process.arch })}\n`);

async function runNpm(npmArgs, options) {
  if (process.platform !== "win32") return execute("npm", npmArgs, options);
  const where = await execute("where.exe", ["npm.cmd"], { windowsHide: true, timeout: 10_000 });
  const npmCommand = where.stdout.split(/\r?\n/u).map((value) => value.trim()).find(Boolean);
  invariant(npmCommand, "npm.cmd could not be resolved from PATH");
  const npmCli = path.join(path.dirname(npmCommand), "node_modules", "npm", "bin", "npm-cli.js");
  await stat(npmCli);
  return execute(process.execPath, [npmCli, ...npmArgs], options);
}

function installedPaths(prefix) {
  if (process.platform === "win32") {
    return [
      path.join(prefix, "runa"),
      path.join(prefix, "runa.cmd"),
      path.join(prefix, "runa.ps1"),
      path.join(prefix, "node_modules", "@runa_laboratories", "cli"),
    ];
  }
  return [
    path.join(prefix, "bin", "runa"),
    path.join(prefix, "lib", "node_modules", "@runa_laboratories", "cli"),
  ];
}

async function assertAbsent(candidate) {
  try {
    await stat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Installed candidate artifact remains after uninstall: ${candidate}`);
}
