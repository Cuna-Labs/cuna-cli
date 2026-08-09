import { readFile } from "node:fs/promises";
import path from "node:path";
import { invariant, parseArgs, readJson, sha256File, verifyEnvelopeFiles } from "./lib/release-evidence.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const evidenceRoot = path.resolve(root, args.get("evidence") ?? "release-artifacts");
const projectionsRoot = path.resolve(root, args.get("projections") ?? "release-artifacts/projections");
const envelope = await readJson(path.join(evidenceRoot, "release-envelope.json"));
await verifyEnvelopeFiles(envelope, evidenceRoot);
const manifest = await readJson(path.join(projectionsRoot, "projection-manifest.json"));

invariant(manifest.schemaVersion === 1, "Unsupported projection manifest");
invariant(manifest.version === envelope.version, "Projection version mismatch");
invariant(manifest.tarballSha256 === envelope.tarball.sha256, "Projection tarball mismatch");
invariant(Object.keys(manifest.projections).sort().join(",") === "aur/PKGBUILD,homebrew/runa.rb,install.sh", "Projection set mismatch");

for (const [relative, digest] of Object.entries(manifest.projections)) {
  const file = path.resolve(projectionsRoot, relative);
  invariant(file.startsWith(`${projectionsRoot}${path.sep}`), `Projection path escapes root: ${relative}`);
  invariant((await sha256File(file)) === digest, `Projection digest mismatch: ${relative}`);
  const content = await readFile(file, "utf8");
  invariant(!/@@[A-Z0-9_]+@@/.test(content), `Unresolved marker: ${relative}`);
  invariant(content.includes(envelope.version.replaceAll("-", relative === "aur/PKGBUILD" ? "_" : "-")), `Version missing: ${relative}`);
  invariant(content.includes(envelope.tarball.sha256), `Tarball digest missing: ${relative}`);
  invariant(content.includes(envelope.tarball.url), `Canonical tarball URL missing: ${relative}`);
  invariant(!/archive\/refs\/heads\/|\/main\.(zip|tar\.gz)|git\+|eval\s/.test(content), `Mutable or unsafe source in ${relative}`);
}

const install = await readFile(path.join(projectionsRoot, "install.sh"), "utf8");
invariant(install.indexOf("sha256sum") < install.indexOf("npm install"), "curl installer installs before digest verification");
invariant(install.includes("--ignore-scripts"), "curl installer must suppress lifecycle scripts");
const brew = await readFile(path.join(projectionsRoot, "homebrew/runa.rb"), "utf8");
invariant(brew.includes('sha256 "'), "Homebrew formula lacks digest pin");
const aur = await readFile(path.join(projectionsRoot, "aur/PKGBUILD"), "utf8");
invariant(aur.includes("--offline") && aur.includes("sha256sums=('"), "AUR projection is not offline and digest-bound");

process.stdout.write(`${JSON.stringify({ status: "verified", projections: Object.keys(manifest.projections) })}\n`);
