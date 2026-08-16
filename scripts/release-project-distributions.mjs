import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseArgs, readJson, sha256File } from "./lib/release-evidence.mjs";
import {
  DISTRIBUTION_SCHEMA_VERSION,
  DISTRIBUTION_MANIFEST_FILE,
  RELEASE_ENVIRONMENT,
  RELEASE_WORKFLOW,
  candidateInvocations,
  validateDistributionManifest,
  verifyDistributionInputs,
} from "./release-distribution-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const repositoryRoot = path.resolve(args.get("root") ?? process.cwd());
const evidenceRoot = path.resolve(repositoryRoot, args.get("evidence") ?? "release-artifacts");
const outputRoot = path.resolve(repositoryRoot, args.get("output") ?? "release-artifacts/distributions");
const envelopeFile = path.join(evidenceRoot, "release-envelope.json");
const envelope = await readJson(envelopeFile);
const { channelDefinitions, channelOrder } = await verifyDistributionInputs(envelope, evidenceRoot);

const commands = candidateInvocations(envelope.version, channelDefinitions);
const replacements = new Map([
  ["@@VERSION@@", envelope.version],
  ["@@AUR_VERSION@@", envelope.version.replaceAll("-", "_")],
  ["@@TARBALL_URL@@", envelope.tarball.url],
  ["@@TARBALL_SHA256@@", envelope.tarball.sha256],
  ["@@PAYLOAD_SHA256@@", envelope.identities.payloadSha256],
  ["@@HOMEBREW_NODE_FORMULA@@", channelDefinitions.homebrew.runtimeDependency],
  ["@@AUR_NODE_DEPENDENCY@@", channelDefinitions.aur.runtimeDependency],
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
  channelDefinitions.npm.projectionFile,
  await writeExclusive(
    channelDefinitions.npm.projectionFile,
    [
      "# Generated from a candidate-bound Cuna CLI release envelope. Do not edit.",
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
    ].join("\n"),
  ),
);
outputs.set(
  channelDefinitions.bun.projectionFile,
  await writeExclusive(
    channelDefinitions.bun.projectionFile,
    [
      "# Generated from a candidate-bound Cuna CLI release envelope. Do not edit.",
      `public_command=${channelDefinitions.bun.publicCommand}`,
      `candidate_invocation=${commands.bun}`,
      `package=${envelope.packageName}`,
      `version=${envelope.version}`,
      `registry=${envelope.registry}`,
      `tarball_sha256=${envelope.tarball.sha256}`,
      "installer_of_record=bun",
      "artifact_channel=npm",
      "availability=PROJECTED_NOT_PUBLISHED",
      `supported_platforms=${channelDefinitions.bun.platforms.join(",")}`,
      `blocked_platforms=${channelDefinitions.bun.blockedPlatforms.map(({ platform }) => platform).join(",")}`,
      `windows_availability=${channelDefinitions.bun.blockedPlatforms[0].availability}`,
      `windows_block_reason=${channelDefinitions.bun.blockedPlatforms[0].reasonCode}`,
      `verified_affected_bun_versions=${channelDefinitions.bun.blockedPlatforms[0].verifiedAffectedVersions.join(",")}`,
      `upstream_source=${channelDefinitions.bun.blockedPlatforms[0].upstreamRepository}@${channelDefinitions.bun.blockedPlatforms[0].upstreamCommit}`,
      `windows_fallback_command=${channelDefinitions.npm.publicCommand}`,
      `windows_readmission_gate=${channelDefinitions.bun.blockedPlatforms[0].readmissionGate}`,
      "",
    ].join("\n"),
  ),
);
outputs.set(
  channelDefinitions.curl.projectionFile,
  await render("packaging/templates/install.sh.template", channelDefinitions.curl.projectionFile, 0o555),
);
outputs.set(
  channelDefinitions.homebrew.projectionFile,
  await render("packaging/templates/homebrew/cuna.rb.template", channelDefinitions.homebrew.projectionFile),
);
outputs.set(
  channelDefinitions.aur.projectionFile,
  await render("packaging/templates/aur/PKGBUILD.template", channelDefinitions.aur.projectionFile),
);

const files = {};
for (const [relative, absolute] of outputs) files[relative] = await sha256File(absolute);

const manifest = {
  schemaVersion: DISTRIBUTION_SCHEMA_VERSION,
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
  channels: channelOrder.map((id) => {
    const definition = channelDefinitions[id];
    return {
      id,
      role: definition.role,
      availability: definition.availability,
      artifactChannel: definition.artifactChannel,
      installerOfRecord: definition.installerOfRecord,
      runtimeDependency: definition.runtimeDependency,
      platforms: [...definition.platforms],
      blockedPlatforms: definition.blockedPlatforms.map((blocked) => ({
        ...blocked,
        verifiedAffectedVersions: [...blocked.verifiedAffectedVersions],
      })),
      publicCommand: definition.publicCommand,
      candidateInvocation: commands[id],
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
      "SIGNED_PLATFORM_CREDENTIAL_BROWSER_BRIDGES_MISSING",
      "WINDOWS_OWNED_PROCESS_HANDLE_IDENTITY_AUTHORITY_MISSING",
      "BUN_WINDOWS_GLOBAL_UNINSTALL_LEAVES_SHIMS",
      "CHANNEL_INSTALL_RECEIPTS_MISSING",
      "ROLLBACK_OR_FIXED_FORWARD_REHEARSAL_MISSING",
      "OBSERVATION_THRESHOLDS_AND_TELEMETRY_MISSING",
    ],
    claim: "Generated projections are deterministic local evidence only; they do not prove publication, installation, promotion, or rollback.",
  },
};

validateDistributionManifest(manifest, envelope, channelDefinitions);
await writeFile(path.join(outputRoot, DISTRIBUTION_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
process.stdout.write(
  `${JSON.stringify({
    status: "DISTRIBUTIONS_PROJECTED_NOT_PUBLISHED",
    decision: manifest.readiness.decision,
    version: envelope.version,
    tarballSha256: envelope.tarball.sha256,
      channels: channelOrder,
  })}\n`,
);
