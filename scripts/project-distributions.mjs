import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, readJson, sha256File, verifyEnvelopeFiles } from "./lib/release-evidence.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const evidenceRoot = path.resolve(root, args.get("evidence") ?? "release-artifacts");
const outputRoot = path.resolve(root, args.get("output") ?? "release-artifacts/projections");
const envelope = await readJson(path.join(evidenceRoot, "release-envelope.json"));
await verifyEnvelopeFiles(envelope, evidenceRoot);

const replacements = new Map([
  ["@@VERSION@@", envelope.version],
  ["@@AUR_VERSION@@", envelope.version.replaceAll("-", "_")],
  ["@@TARBALL_URL@@", envelope.tarball.url],
  ["@@TARBALL_SHA256@@", envelope.tarball.sha256],
]);

async function render(templateRelative, outputRelative) {
  let value = await readFile(path.join(root, templateRelative), "utf8");
  for (const [marker, replacement] of replacements) value = value.replaceAll(marker, replacement);
  if (/@@[A-Z0-9_]+@@/.test(value)) throw new Error(`Unresolved marker in ${templateRelative}`);
  const output = path.join(outputRoot, outputRelative);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, value, { flag: "wx" });
  return output;
}

const files = [
  await render("packaging/templates/install.sh.template", "install.sh"),
  await render("packaging/templates/homebrew/runa.rb.template", "homebrew/runa.rb"),
  await render("packaging/templates/aur/PKGBUILD.template", "aur/PKGBUILD"),
];
await chmod(files[0], 0o555);

const projections = {};
for (const file of files) {
  projections[path.relative(outputRoot, file).replaceAll("\\", "/")] = await sha256File(file);
}
await writeFile(
  path.join(outputRoot, "projection-manifest.json"),
  `${JSON.stringify({ schemaVersion: 1, version: envelope.version, tarballSha256: envelope.tarball.sha256, projections }, null, 2)}\n`,
  { flag: "wx" },
);
process.stdout.write(`${JSON.stringify({ status: "projected", files: Object.keys(projections) })}\n`);
