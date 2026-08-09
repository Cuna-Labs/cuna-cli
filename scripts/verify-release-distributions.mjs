import { readFile } from "node:fs/promises";
import path from "node:path";

import { invariant, parseArgs, readJson, sha256File } from "./lib/release-evidence.mjs";
import {
  CHANNEL_DEFINITIONS,
  DISTRIBUTION_MANIFEST_FILE,
  immutableCommands,
  verifyDistributionFiles,
  verifyDistributionInputs,
} from "./release-distribution-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const repositoryRoot = path.resolve(args.get("root") ?? process.cwd());
const evidenceRoot = path.resolve(repositoryRoot, args.get("evidence") ?? "release-artifacts");
const distributionsRoot = path.resolve(repositoryRoot, args.get("distributions") ?? "release-artifacts/distributions");
const envelopeFile = path.join(evidenceRoot, "release-envelope.json");
const envelope = await readJson(envelopeFile);
await verifyDistributionInputs(envelope, evidenceRoot);
const manifest = await readJson(path.join(distributionsRoot, DISTRIBUTION_MANIFEST_FILE));
await verifyDistributionFiles(manifest, envelope, distributionsRoot);
invariant(manifest.releaseEnvelope.sha256 === await sha256File(envelopeFile), "Distribution release-envelope digest mismatch");

const commands = immutableCommands(envelope.version);
const npm = await readFile(path.join(distributionsRoot, CHANNEL_DEFINITIONS.npm.projectionFile), "utf8");
const expectedNpm = [
  "# Generated from an admitted Runa CLI release envelope. Do not edit.",
  `public_command=${CHANNEL_DEFINITIONS.npm.publicCommand}`,
  `immutable_command=${commands.npm}`,
  `package=${envelope.packageName}`,
  `version=${envelope.version}`,
  `registry=${envelope.registry}`,
  `tarball_sha256=${envelope.tarball.sha256}`,
  "installer_of_record=npm",
  "artifact_channel=npm",
  "availability=PROJECTED_NOT_PUBLISHED",
  "",
].join("\n");
invariant(npm === expectedNpm, "npm projection content differs from the deterministic policy projection");

const bun = await readFile(path.join(distributionsRoot, CHANNEL_DEFINITIONS.bun.projectionFile), "utf8");
const expectedBun = [
  "# Generated from an admitted Runa CLI release envelope. Do not edit.",
  `public_command=${CHANNEL_DEFINITIONS.bun.publicCommand}`,
  `immutable_command=${commands.bun}`,
  `package=${envelope.packageName}`,
  `version=${envelope.version}`,
  `registry=${envelope.registry}`,
  `tarball_sha256=${envelope.tarball.sha256}`,
  "installer_of_record=bun",
  "artifact_channel=npm",
  "availability=PROJECTED_NOT_PUBLISHED",
  "",
].join("\n");
invariant(bun === expectedBun, "Bun projection content differs from the deterministic policy projection");

for (const id of ["curl", "homebrew", "aur"]) {
  const relative = CHANNEL_DEFINITIONS[id].projectionFile;
  const content = await readFile(path.join(distributionsRoot, relative), "utf8");
  invariant(!content.includes("\r"), `${id} projection is not canonical LF text`);
  invariant(!/@@[A-Z0-9_]+@@/.test(content), `Unresolved template marker in ${id}`);
  invariant(content.includes(envelope.version.replaceAll("-", id === "aur" ? "_" : "-")), `${id} omits the exact version`);
  invariant(content.includes(envelope.tarball.url), `${id} omits the canonical exact-version tarball URL`);
  invariant(content.includes(envelope.tarball.sha256), `${id} omits the candidate tarball digest`);
  invariant(!/archive\/refs\/heads\/|\/main\.(zip|tar\.gz)|git\+|\beval\s|curl[^\n]*\|\s*(?:ba)?sh/.test(content), `${id} contains a mutable or unsafe source path`);
}

const install = await readFile(path.join(distributionsRoot, CHANNEL_DEFINITIONS.curl.projectionFile), "utf8");
invariant(install.startsWith("#!/bin/sh\nset -eu\n"), "curl bootstrap does not fail closed as POSIX shell");
invariant(install.includes("--proto '=https' --tlsv1.2 --fail --location --show-error"), "curl bootstrap does not constrain transport");
invariant(install.indexOf("sha256sum --check") < install.indexOf("npm install --global"), "curl bootstrap mutates before digest verification");
invariant(install.match(/npm install --global --ignore-scripts/g)?.length === 2, "curl bootstrap must stage and activate with lifecycle scripts disabled");
invariant(install.indexOf("Staged installed-artifact self-test") < install.lastIndexOf("npm install --global"), "curl bootstrap does not self-test before global activation");
invariant(install.includes("active_identity") && install.includes("staged_identity"), "curl bootstrap does not compare staged and active runtime identity");

const brew = await readFile(path.join(distributionsRoot, CHANNEL_DEFINITIONS.homebrew.projectionFile), "utf8");
invariant(brew.includes(`version "${envelope.version}"`), "Homebrew formula version is not exact");
invariant(brew.includes(`sha256 "${envelope.tarball.sha256}"`), "Homebrew formula digest is not exact");
invariant(brew.includes('"--ignore-scripts"'), "Homebrew formula permits npm lifecycle scripts");
invariant(brew.includes('"--offline"') && brew.includes('"--no-audit"') && brew.includes('"--no-fund"'), "Homebrew formula may perform undeclared package-manager network calls");
invariant(brew.includes('assert_equal "npm", identity.dig("data", "updateChannel")'), "Homebrew test omits canonical artifact-channel identity");

const aur = await readFile(path.join(distributionsRoot, CHANNEL_DEFINITIONS.aur.projectionFile), "utf8");
invariant(aur.includes("arch=('x86_64')"), "AUR projection claims an unverified architecture");
invariant(aur.includes("--offline --ignore-scripts"), "AUR package phase is not offline and lifecycle-script-free");
invariant(aur.includes("--no-audit --no-fund"), "AUR package phase may perform undeclared package-manager network calls");
invariant(aur.includes("self-test --offline --json"), "AUR package does not run the network-free self-test");
invariant(aur.includes(`\"version\":\"${envelope.version}\"`), "AUR package does not verify the exact installed version");

process.stdout.write(`${JSON.stringify({
  status: "DISTRIBUTION_PROJECTIONS_VERIFIED",
  decision: manifest.readiness.decision,
  candidateSha256: envelope.tarball.sha256,
  channels: manifest.channels.map((channel) => ({ id: channel.id, availability: channel.availability })),
  blockers: manifest.readiness.blockers,
})}\n`);
