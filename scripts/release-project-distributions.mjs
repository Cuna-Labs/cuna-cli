import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseArgs, readJson, sha256File } from "./lib/release-evidence.mjs";
import {
  CHANNEL_DEFINITIONS,
  CHANNEL_ORDER,
  DISTRIBUTION_MANIFEST_FILE,
  RELEASE_ENVIRONMENT,
  RELEASE_WORKFLOW,
  immutableCommands,
  validateDistributionManifest,
  verifyDistributionInputs,
} from "./release-distribution-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const repositoryRoot = path.resolve(args.get("root") ?? process.cwd());
const evidenceRoot = path.resolve(repositoryRoot, args.get("evidence") ?? "release-artifacts");
const outputRoot = path.resolve(repositoryRoot, args.get("output") ?? "release-artifacts/distributions");
const envelopeFile = path.join(evidenceRoot, "release-envelope.json");
const envelope = await readJson(envelopeFile);
await verifyDistributionInputs(envelope, evidenceRoot);

const commands = immutableCommands(envelope.version);
const replacements = new Map([
  ["@@VERSION@@", envelope.version],
  ["@@AUR_VERSION@@", envelope.version.replaceAll("-", "_")],
  ["@@TARBALL_URL@@", envelope.tarball.url],
  ["@@TARBALL_SHA256@@", envelope.tarball.sha256],
]);

async function writeExclusive(relative, content, mode = undefined) {
  const output = path.join(outputRoot, relative);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, content, { flag: "wx" });
  if (mode !== undefined) await chmod(output, mode);
  return output;
}

async function render(templateRelative, outputRelative, mode = undefined) {
  let value = await readFile(path.join(repositoryRoot, templateRelative), "utf8");
  value = value.replace(/\r\n?/g, "\n");
  for (const [marker, replacement] of replacements) value = value.replaceAll(marker, replacement);
  if (/@@[A-Z0-9_]+@@/.test(value)) throw new Error(`Unresolved marker in ${templateRelative}`);
  return writeExclusive(outputRelative, value, mode);
}

const outputs = new Map();
outputs.set(
  CHANNEL_DEFINITIONS.npm.projectionFile,
  await writeExclusive(
    CHANNEL_DEFINITIONS.npm.projectionFile,
    [
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
    ].join("\n"),
  ),
);
outputs.set(
  CHANNEL_DEFINITIONS.bun.projectionFile,
  await writeExclusive(
    CHANNEL_DEFINITIONS.bun.projectionFile,
    [
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
    ].join("\n"),
  ),
);
outputs.set(
  CHANNEL_DEFINITIONS.curl.projectionFile,
  await render("packaging/templates/install.sh.template", CHANNEL_DEFINITIONS.curl.projectionFile, 0o555),
);
outputs.set(
  CHANNEL_DEFINITIONS.homebrew.projectionFile,
  await render("packaging/templates/homebrew/runa.rb.template", CHANNEL_DEFINITIONS.homebrew.projectionFile),
);
outputs.set(
  CHANNEL_DEFINITIONS.aur.projectionFile,
  await render("packaging/templates/aur/PKGBUILD.template", CHANNEL_DEFINITIONS.aur.projectionFile),
);

const files = {};
for (const [relative, absolute] of outputs) files[relative] = await sha256File(absolute);

const manifest = {
  schemaVersion: 2,
  releaseEnvelope: {
    file: "release-envelope.json",
    sha256: await sha256File(envelopeFile),
  },
  candidate: {
    packageName: envelope.packageName,
    version: envelope.version,
    sourceCommit: envelope.sourceCommit,
    repository: envelope.repository,
    registry: envelope.registry,
    tarball: envelope.tarball,
    sbom: envelope.sbom,
    supportPolicy: envelope.supportPolicy,
    releaseInputs: envelope.releaseInputs,
    identities: envelope.identities,
  },
  provenance: {
    requiredForPublication: true,
    evidenceStatus: "MISSING_EXTERNAL_EVIDENCE",
    attestationDigest: null,
    publisherReceiptDigest: null,
    expectedRepository: envelope.repository,
    expectedWorkflow: RELEASE_WORKFLOW,
    expectedEnvironment: RELEASE_ENVIRONMENT,
    longLivedTokenAllowed: false,
  },
  channels: CHANNEL_ORDER.map((id) => {
    const definition = CHANNEL_DEFINITIONS[id];
    return {
      id,
      role: definition.role,
      availability: "PROJECTED_NOT_PUBLISHED",
      installerOfRecord: definition.installerOfRecord,
      platforms: [...definition.platforms],
      publicCommand: definition.publicCommand,
      immutableCommand: commands[id],
      artifactSha256: envelope.tarball.sha256,
      projection: { file: definition.projectionFile, sha256: files[definition.projectionFile] },
      liveEvidenceReceipt: null,
    };
  }),
  files,
  recovery: {
    npmArtifactsImmutable: true,
    overwriteForbidden: true,
    strategy: "HALT_CHANNEL_AND_FIXED_FORWARD_OR_VERIFIED_PRIOR_VERSION",
    rehearsalStatus: "MISSING_EXTERNAL_EVIDENCE",
    rollbackBarrier: "UNKNOWN_UNTIL_N_MINUS_1_STATE_COMPATIBILITY_EVIDENCE",
    recoveryReceiptDigest: null,
  },
  readiness: {
    decision: "BLOCKED",
    blockers: [
      "PUBLISHED_NPM_TARBALL_AND_PROVENANCE_NOT_VERIFIED",
      "CHANNEL_INSTALL_RECEIPTS_MISSING",
      "ROLLBACK_OR_FIXED_FORWARD_REHEARSAL_MISSING",
      "OBSERVATION_THRESHOLDS_AND_TELEMETRY_MISSING",
    ],
    claim: "Generated projections are deterministic local evidence only; they do not prove publication, installation, promotion, or rollback.",
  },
};

validateDistributionManifest(manifest, envelope);
await writeFile(path.join(outputRoot, DISTRIBUTION_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
process.stdout.write(
  `${JSON.stringify({
    status: "DISTRIBUTIONS_PROJECTED_NOT_PUBLISHED",
    decision: manifest.readiness.decision,
    version: envelope.version,
    tarballSha256: envelope.tarball.sha256,
    channels: CHANNEL_ORDER,
  })}\n`,
);
