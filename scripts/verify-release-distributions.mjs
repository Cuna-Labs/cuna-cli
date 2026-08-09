import { readFile } from "node:fs/promises";
import path from "node:path";

import { invariant, parseArgs, readJson, sha256File } from "./lib/release-evidence.mjs";
import {
  DISTRIBUTION_MANIFEST_FILE,
  candidateInvocations,
  verifyDistributionFiles,
  verifyDistributionInputs,
} from "./release-distribution-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const repositoryRoot = path.resolve(args.get("root") ?? process.cwd());
const evidenceRoot = path.resolve(repositoryRoot, args.get("evidence") ?? "release-artifacts");
const distributionsRoot = path.resolve(repositoryRoot, args.get("distributions") ?? "release-artifacts/distributions");
const envelopeFile = path.join(evidenceRoot, "release-envelope.json");
const envelope = await readJson(envelopeFile);
const { channelDefinitions } = await verifyDistributionInputs(envelope, evidenceRoot);
const manifest = await readJson(path.join(distributionsRoot, DISTRIBUTION_MANIFEST_FILE));
await verifyDistributionFiles(manifest, envelope, distributionsRoot, channelDefinitions);
invariant(manifest.releaseEnvelope.sha256 === await sha256File(envelopeFile), "Distribution release-envelope digest mismatch");

const commands = candidateInvocations(envelope.version, channelDefinitions);
const npm = await readFile(path.join(distributionsRoot, channelDefinitions.npm.projectionFile), "utf8");
const expectedNpm = [
  "# Generated from a candidate-bound Runa CLI release envelope. Do not edit.",
  `public_command=${channelDefinitions.npm.publicCommand}`,
  `candidate_invocation=${commands.npm}`,
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

const bun = await readFile(path.join(distributionsRoot, channelDefinitions.bun.projectionFile), "utf8");
const expectedBun = [
  "# Generated from a candidate-bound Runa CLI release envelope. Do not edit.",
  `public_command=${channelDefinitions.bun.publicCommand}`,
  `candidate_invocation=${commands.bun}`,
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
  const relative = channelDefinitions[id].projectionFile;
  const content = await readFile(path.join(distributionsRoot, relative), "utf8");
  invariant(!content.includes("\r"), `${id} projection is not canonical LF text`);
  invariant(!/@@[A-Z0-9_]+@@/.test(content), `Unresolved template marker in ${id}`);
  invariant(content.includes(envelope.version.replaceAll("-", id === "aur" ? "_" : "-")), `${id} omits the exact version`);
  invariant(content.includes(envelope.tarball.url), `${id} omits the canonical exact-version tarball URL`);
  invariant(content.includes(envelope.tarball.sha256), `${id} omits the candidate tarball digest`);
  invariant(!/archive\/refs\/heads\/|\/main\.(zip|tar\.gz)|git\+|\beval\s|curl[^\n]*\|\s*(?:ba)?sh/.test(content), `${id} contains a mutable or unsafe source path`);
}

const install = await readFile(path.join(distributionsRoot, channelDefinitions.curl.projectionFile), "utf8");
invariant(install.startsWith("#!/bin/sh\nset -eu\n"), "curl bootstrap does not fail closed as POSIX shell");
invariant(install.includes("--proto '=https' --tlsv1.2 --fail --location --show-error"), "curl bootstrap does not constrain transport");
invariant(install.indexOf("sha256sum --check") < install.indexOf("npm install --global"), "curl bootstrap mutates before digest verification");
invariant(install.match(/npm install --global --ignore-scripts/g)?.length === 1, "curl bootstrap must perform one lifecycle-script-free versioned install");
invariant(!/npm install --global[^\n]*"\$tarball"\n(?:runa|\$PATH)/u.test(install), "curl bootstrap contains a non-versioned global activation");
invariant(install.includes('mv "$staging" "$version_dir"'), "curl bootstrap does not publish a verified immutable version directory");
invariant(
  install.match(/mv -f "\$launcher_tmp" "\$launcher"/gu)?.length === 2,
  "curl bootstrap does not atomically activate and restore a Runa-owned launcher",
);
invariant(install.includes("previous launcher was restored") && install.includes("previous_target"), "curl bootstrap does not preserve or restore N-1");
invariant(install.includes("runa-cli-installer-v1") && install.includes("Refusing to replace a non-Runa launcher"), "curl bootstrap does not enforce path ownership");
invariant(install.includes("--uninstall") && install.includes("user configuration was preserved"), "curl bootstrap does not provide bounded uninstall semantics");
invariant(install.includes("EXPECTED_PAYLOAD_SHA256") && install.includes('data.artifactChannel !== "npm"'), "curl bootstrap does not bind runtime payload and artifact-channel identity");

const brew = await readFile(path.join(distributionsRoot, channelDefinitions.homebrew.projectionFile), "utf8");
invariant(brew.includes(`version "${envelope.version}"`), "Homebrew formula version is not exact");
invariant(brew.includes(`sha256 "${envelope.tarball.sha256}"`), "Homebrew formula digest is not exact");
invariant(brew.includes('"--ignore-scripts"'), "Homebrew formula permits npm lifecycle scripts");
invariant(brew.includes('"--offline"') && brew.includes('"--no-audit"') && brew.includes('"--no-fund"'), "Homebrew formula may perform undeclared package-manager network calls");
invariant(brew.includes("depends_on arch: :x86_64"), "Homebrew formula claims an unverified architecture");
invariant(brew.includes(`depends_on "${channelDefinitions.homebrew.runtimeDependency}"`), "Homebrew formula runtime dependency differs from support policy");
invariant(brew.includes(`Formula["${channelDefinitions.homebrew.runtimeDependency}"]`), "Homebrew formula does not resolve the versioned Node provider");
invariant(brew.includes('exec "#{node_formula.opt_bin}/node" "#{cli}" "$@"'), "Homebrew wrapper does not pin Node or preserve arguments");
invariant(!brew.includes("install_symlink"), "Homebrew formula exposes an env-node symlink instead of the admitted wrapper");
invariant(brew.includes('assert_equal "npm", identity.dig("data", "artifactChannel")'), "Homebrew test omits canonical artifact-channel identity");

const aur = await readFile(path.join(distributionsRoot, channelDefinitions.aur.projectionFile), "utf8");
invariant(aur.includes("arch=('x86_64')"), "AUR projection claims an unverified architecture");
invariant(aur.includes(`depends=('${channelDefinitions.aur.runtimeDependency}')`), "AUR runtime dependency differs from support policy");
invariant(!aur.includes("depends=('nodejs>=22')"), "AUR projection accepts unsupported future Node majors");
invariant(aur.includes("--offline --ignore-scripts"), "AUR package phase is not offline and lifecycle-script-free");
invariant(aur.includes("--no-audit --no-fund"), "AUR package phase may perform undeclared package-manager network calls");
invariant(aur.includes("self-test --offline --json"), "AUR package does not run the network-free self-test");
invariant(aur.includes(`"version":"${envelope.version}"`), "AUR package does not verify the exact installed version");

process.stdout.write(`${JSON.stringify({
  status: "DISTRIBUTION_PROJECTIONS_VERIFIED",
  decision: manifest.readiness.decision,
  candidateSha256: envelope.tarball.sha256,
  channels: manifest.channels.map((channel) => ({ id: channel.id, availability: channel.availability })),
  blockers: manifest.readiness.blockers,
})}\n`);
