import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, readJson, sha256File, validateEnvelope, verifyEnvelopeFiles } from "./lib/release-evidence.mjs";

const args = parseArgs(process.argv.slice(2));

if (args.get("self-test") === "true") {
  const root = await mkdtemp(path.join(tmpdir(), "runa-envelope-test-"));
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "runa.tgz"), "candidate");
  await writeFile(path.join(root, "sbom.json"), "{}");
  await writeFile(path.join(root, "support.json"), "{}");
  const envelope = {
    schemaVersion: 1,
    packageName: "@runa_laboratories/cli",
    version: "1.2.3-test.1",
    sourceCommit: "a".repeat(40),
    repository: "Runa-Laboratories/runa-cli",
    registry: "https://registry.npmjs.org",
    tarball: {
      file: "runa.tgz",
      url: "https://registry.npmjs.org/@runa_laboratories/cli/-/cli-1.2.3-test.1.tgz",
      sha256: await sha256File(path.join(root, "runa.tgz")),
      size: 9,
    },
    sbom: { file: "sbom.json", sha256: await sha256File(path.join(root, "sbom.json")) },
    supportPolicy: { file: "support.json", sha256: await sha256File(path.join(root, "support.json")) },
    builder: { workflow: ".github/workflows/ci.yml", runId: "1", runAttempt: "1" },
  };
  await verifyEnvelopeFiles(envelope, root);
  await writeFile(path.join(root, "runa.tgz"), "substituted");
  let rejected = false;
  try {
    await verifyEnvelopeFiles(envelope, root);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Negative control failed: substituted tarball was accepted");
  process.stdout.write('{"status":"negative-control-passed"}\n');
  process.exit(0);
}

const root = path.resolve(args.get("root") ?? "release-artifacts");
const envelope = await readJson(path.join(root, args.get("envelope") ?? "release-envelope.json"));
validateEnvelope(envelope);
await verifyEnvelopeFiles(envelope, root);
process.stdout.write(`${JSON.stringify({ status: "verified", version: envelope.version, sha256: envelope.tarball.sha256 })}\n`);
