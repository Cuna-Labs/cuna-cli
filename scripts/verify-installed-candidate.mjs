import { execFile } from "node:child_process";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { invariant, parseArgs, readJson, verifyEnvelopeFiles } from "./lib/release-evidence.mjs";

const execute = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? "release-artifacts");
const receiptFile = path.resolve(args.get("receipt") ?? "evidence/platform-receipt.json");
const envelope = await readJson(path.join(root, "release-envelope.json"));
await verifyEnvelopeFiles(envelope, root);

const prefix = await mkdtemp(path.join(tmpdir(), "runa-cli-install-"));
const npmArgs = ["install", "--global", "--ignore-scripts", "--prefix", prefix, path.join(root, envelope.tarball.file)];
const npmInvocation = process.platform === "win32"
  ? await resolveWindowsNpm()
  : { command: "npm", args: [] };
await execute(npmInvocation.command, [...npmInvocation.args, ...npmArgs], {
  windowsHide: true,
  timeout: 180_000,
  maxBuffer: 8 * 1024 * 1024,
});
const executable = process.platform === "win32" ? path.join(prefix, "runa.cmd") : path.join(prefix, "bin", "runa");
const selfTest = await execute(executable, ["self-test", "--offline", "--json"], { windowsHide: true, timeout: 30_000 });
const version = await execute(executable, ["version", "--json"], { windowsHide: true, timeout: 30_000 });
const selfTestJson = JSON.parse(selfTest.stdout);
const versionJson = JSON.parse(version.stdout);
invariant(selfTestJson.schema_version === "1" && selfTestJson.type === "result" && selfTestJson.command === "self-test", "Self-test envelope is invalid");
invariant(versionJson.schema_version === "1" && versionJson.type === "result" && versionJson.command === "version", "Version envelope is invalid");
invariant(selfTestJson.data?.ok === true, "Installed-artifact self-test did not report data.ok=true");
invariant(versionJson.data?.version === envelope.version, "Installed version differs from candidate");
invariant(/^[0-9a-f]{64}$/.test(versionJson.data?.buildDigest), "Installed build digest is missing or malformed");
invariant(versionJson.data?.platform === process.platform, "Installed platform identity differs from runtime");
invariant(versionJson.data?.architecture === process.arch, "Installed architecture identity differs from runtime");
invariant(versionJson.data?.updateChannel === "npm", "Installed candidate does not identify npm as installer channel");
invariant(
  versionJson.data?.protocolRange && typeof versionJson.data.protocolRange.minimum === "string" && typeof versionJson.data.protocolRange.maximum === "string",
  "Installed protocol range is missing",
);

await mkdir(path.dirname(receiptFile), { recursive: true });
await writeFile(
  receiptFile,
  `${JSON.stringify({
    schemaVersion: 1,
    candidateSha256: envelope.tarball.sha256,
    sourceCommit: envelope.sourceCommit,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    selfTest: "PASS",
    versionIdentity: "PASS",
    observedAt: new Date().toISOString(),
  }, null, 2)}\n`,
  { flag: "wx" },
);
process.stdout.write(`${JSON.stringify({ status: "installed-artifact-verified", platform: process.platform, architecture: process.arch })}\n`);

async function resolveWindowsNpm() {
  const where = await execute("where.exe", ["npm.cmd"], { windowsHide: true, timeout: 10_000 });
  const npmCommand = where.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
  invariant(npmCommand, "npm.cmd could not be resolved from PATH");
  const npmCli = path.join(path.dirname(npmCommand), "node_modules", "npm", "bin", "npm-cli.js");
  await stat(npmCli);
  return { command: process.execPath, args: [npmCli] };
}
