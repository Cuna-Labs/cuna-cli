import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { invariant, parseArgs, readJson, sha256File } from "./lib/release-evidence.mjs";
import { withOwnedTempDirectory } from "./lib/owned-temp.mjs";

const execute = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const envelope = await readJson(args.get("envelope") ?? "release-artifacts/release-envelope.json");
const expectedVersion = args.get("version");
invariant(envelope.version === expectedVersion, "Post-publication version mismatch");
const receipt = await withOwnedTempDirectory("cuna-registry-verify-", async (destination) => {
  await execute("npm", [
    "pack",
    `${envelope.packageName}@${envelope.version}`,
    "--ignore-scripts",
    "--pack-destination",
    destination,
    "--registry",
    envelope.registry,
  ], { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });

  const tarballs = (await readdir(destination)).filter((file) => file.endsWith(".tgz"));
  invariant(tarballs.length === 1, "Registry verification did not recover exactly one tarball");
  const actual = await sha256File(path.join(destination, tarballs[0]));
  invariant(actual === envelope.tarball.sha256, "Registry tarball differs from admitted candidate bytes");

  const tag = args.get("tag");
  const tagResult = await execute("npm", ["view", `${envelope.packageName}@${tag}`, "version", "--json", "--registry", envelope.registry], {
    windowsHide: true,
    timeout: 30_000,
  });
  invariant(JSON.parse(tagResult.stdout) === envelope.version, `Registry tag ${tag} does not identify the published version`);
  return {
    schemaVersion: 1,
    status: "REGISTRY_BYTES_VERIFIED",
    packageName: envelope.packageName,
    version: envelope.version,
    sourceCommit: envelope.sourceCommit,
    sha256: actual,
    tag,
    registry: envelope.registry,
    observedAt: new Date().toISOString(),
  };
});
if (args.get("receipt")) {
  const receiptFile = path.resolve(args.get("receipt"));
  await mkdir(path.dirname(receiptFile), { recursive: true });
  await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
}
process.stdout.write(`${JSON.stringify(receipt)}\n`);
