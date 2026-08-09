import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  PACKAGE_NAME,
  REGISTRY,
  REPOSITORY,
  invariant,
  sha256File,
  verifyEnvelopeFiles,
} from "./lib/release-evidence.mjs";

export const DISTRIBUTION_SCHEMA_VERSION = 2;
export const DISTRIBUTION_MANIFEST_FILE = "distribution-manifest.json";
export const RELEASE_WORKFLOW = ".github/workflows/release.yml";
export const RELEASE_ENVIRONMENT = "npm";

export const CHANNEL_ORDER = Object.freeze(["npm", "bun", "curl", "homebrew", "aur"]);

export const CHANNEL_DEFINITIONS = Object.freeze({
  npm: Object.freeze({
    role: "canonical",
    installerOfRecord: "npm",
    platforms: Object.freeze(["linux-x64", "darwin-x64", "win32-x64"]),
    projectionFile: "npm/install-command.txt",
    publicCommand: `npm install -g ${PACKAGE_NAME}`,
  }),
  bun: Object.freeze({
    role: "registry-projection",
    installerOfRecord: "bun",
    platforms: Object.freeze(["linux-x64", "darwin-x64", "win32-x64"]),
    projectionFile: "bun/install-command.txt",
    publicCommand: `bun add --global ${PACKAGE_NAME}`,
  }),
  curl: Object.freeze({
    role: "bootstrap-projection",
    installerOfRecord: "npm",
    platforms: Object.freeze(["linux-x64", "darwin-x64"]),
    projectionFile: "curl/install.sh",
    publicCommand: "curl -fsSL https://runacode.io/install | sh",
  }),
  homebrew: Object.freeze({
    role: "formula-projection",
    installerOfRecord: "homebrew",
    platforms: Object.freeze(["linux-x64", "darwin-x64"]),
    projectionFile: "homebrew/runa.rb",
    publicCommand: "brew install Runa-Laboratories/tap/runa",
  }),
  aur: Object.freeze({
    role: "package-projection",
    installerOfRecord: "pacman",
    platforms: Object.freeze(["linux-x64"]),
    projectionFile: "aur/PKGBUILD",
    publicCommand: "paru -S runa-cli-bin",
  }),
});

const SHA256 = /^[0-9a-f]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SUPPORTED_PLATFORM_KEYS = new Set(["linux-x64", "darwin-x64", "win32-x64"]);

export function exactKeys(value, expected, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(JSON.stringify(actual) === JSON.stringify(wanted), `${label} keys differ: ${actual.join(", ")}`);
}

export function normalizeRelativeFile(value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} must be a non-empty string`);
  invariant(!path.isAbsolute(value), `${label} must be relative`);
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  invariant(normalized !== "." && normalized !== ".." && !normalized.startsWith("../"), `${label} escapes its root`);
  invariant(!normalized.includes("\0"), `${label} contains a NUL byte`);
  return normalized;
}

export function immutableCommands(version) {
  return Object.freeze({
    npm: `npm install -g --ignore-scripts --no-audit --no-fund --registry=${REGISTRY} ${PACKAGE_NAME}@${version}`,
    bun: `bun add --global --ignore-scripts --registry=${REGISTRY} ${PACKAGE_NAME}@${version}`,
    curl: CHANNEL_DEFINITIONS.curl.publicCommand,
    homebrew: CHANNEL_DEFINITIONS.homebrew.publicCommand,
    aur: CHANNEL_DEFINITIONS.aur.publicCommand,
  });
}

export function validateSupportPolicy(policy) {
  invariant(policy?.schemaVersion === 1, "Unsupported support-policy schema");
  invariant(policy.packageName === PACKAGE_NAME, "Support policy package mismatch");
  invariant(policy.canonicalRegistry === REGISTRY, "Support policy registry mismatch");
  invariant(Array.isArray(policy.architectures) && policy.architectures.includes("x64"), "x64 support is not declared");
  invariant(policy.node && typeof policy.node.minimum === "string", "Support policy Node minimum is missing");
  invariant(Array.isArray(policy.node.tested) && policy.node.tested.length >= 2, "Two tested Node lines are required");
  invariant(Array.isArray(policy.ciMatrix), "Support policy CI matrix is missing");

  const supported = new Set(
    policy.ciMatrix
      .filter((entry) => entry?.claim !== "observation-only" && entry?.architecture === "x64")
      .map((entry) => `${entry.platform}-x64`),
  );
  for (const platform of SUPPORTED_PLATFORM_KEYS) {
    invariant(supported.has(platform), `Support policy lacks a mandatory ${platform} receipt definition`);
  }
  return Object.freeze([...supported].sort());
}

export async function validateCycloneDxSbom(file, envelope) {
  const sbom = JSON.parse(await readFile(file, "utf8"));
  invariant(sbom?.bomFormat === "CycloneDX", "SBOM is not CycloneDX");
  invariant(typeof sbom.specVersion === "string" && sbom.specVersion.length > 0, "SBOM specVersion is missing");
  invariant(Number.isSafeInteger(sbom.version) && sbom.version >= 1, "SBOM document version is invalid");
  const component = sbom.metadata?.component;
  invariant(component && typeof component === "object", "SBOM metadata.component is missing");
  invariant(component.version === envelope.version, "SBOM component version differs from the release candidate");
  const scopedPurl = `pkg:npm/%40runa_laboratories/cli@${envelope.version}`;
  invariant(
    component.purl === scopedPurl,
    "SBOM component identity differs from the release package",
  );
  return sbom;
}

export async function verifyDistributionInputs(envelope, evidenceRoot) {
  await verifyEnvelopeFiles(envelope, evidenceRoot);
  const supportPolicy = JSON.parse(
    await readFile(path.resolve(evidenceRoot, normalizeRelativeFile(envelope.supportPolicy.file, "supportPolicy.file")), "utf8"),
  );
  const supportedPlatforms = validateSupportPolicy(supportPolicy);
  await validateCycloneDxSbom(
    path.resolve(evidenceRoot, normalizeRelativeFile(envelope.sbom.file, "sbom.file")),
    envelope,
  );
  return { supportPolicy, supportedPlatforms };
}

export function validateDistributionManifest(manifest, envelope) {
  exactKeys(
    manifest,
    ["schemaVersion", "releaseEnvelope", "candidate", "provenance", "channels", "files", "recovery", "readiness"],
    "distribution manifest",
  );
  invariant(manifest.schemaVersion === DISTRIBUTION_SCHEMA_VERSION, "Unsupported distribution-manifest schema");

  exactKeys(manifest.releaseEnvelope, ["file", "sha256"], "releaseEnvelope");
  invariant(manifest.releaseEnvelope.file === "release-envelope.json", "Unexpected release-envelope filename");
  invariant(SHA256.test(manifest.releaseEnvelope.sha256), "Release-envelope digest is invalid");

  exactKeys(
    manifest.candidate,
    ["packageName", "version", "sourceCommit", "repository", "registry", "tarball", "sbom", "supportPolicy", "releaseInputs", "identities"],
    "candidate",
  );
  invariant(manifest.candidate.packageName === envelope.packageName, "Distribution package mismatch");
  invariant(manifest.candidate.version === envelope.version, "Distribution version mismatch");
  invariant(manifest.candidate.sourceCommit === envelope.sourceCommit, "Distribution source commit mismatch");
  invariant(manifest.candidate.repository === REPOSITORY, "Distribution repository mismatch");
  invariant(manifest.candidate.registry === REGISTRY, "Distribution registry mismatch");
  for (const [name, observed, expected] of [
    ["tarball", manifest.candidate.tarball, envelope.tarball],
    ["sbom", manifest.candidate.sbom, envelope.sbom],
    ["supportPolicy", manifest.candidate.supportPolicy, envelope.supportPolicy],
    ["releaseInputs", manifest.candidate.releaseInputs, envelope.releaseInputs],
    ["identities", manifest.candidate.identities, envelope.identities],
  ]) {
    invariant(JSON.stringify(observed) === JSON.stringify(expected), `${name} identity differs from the release envelope`);
  }

  exactKeys(
    manifest.provenance,
    ["requiredForPublication", "evidenceStatus", "attestationDigest", "publisherReceiptDigest", "expectedRepository", "expectedWorkflow", "expectedEnvironment", "longLivedTokenAllowed"],
    "provenance",
  );
  invariant(manifest.provenance.requiredForPublication === true, "Publication provenance must be mandatory");
  invariant(manifest.provenance.evidenceStatus === "MISSING_EXTERNAL_EVIDENCE", "Local projection cannot claim external provenance");
  invariant(manifest.provenance.attestationDigest === null && manifest.provenance.publisherReceiptDigest === null, "Local projection contains fabricated provenance evidence");
  invariant(manifest.provenance.expectedRepository === REPOSITORY, "Provenance repository binding mismatch");
  invariant(manifest.provenance.expectedWorkflow === RELEASE_WORKFLOW, "Provenance workflow binding mismatch");
  invariant(manifest.provenance.expectedEnvironment === RELEASE_ENVIRONMENT, "Provenance environment binding mismatch");
  invariant(manifest.provenance.longLivedTokenAllowed === false, "Long-lived publisher tokens must be forbidden");

  invariant(Array.isArray(manifest.channels), "channels must be an array");
  invariant(manifest.channels.length === CHANNEL_ORDER.length, "Every approved channel must be represented exactly once");
  const commands = immutableCommands(envelope.version);
  for (const [index, id] of CHANNEL_ORDER.entries()) {
    const channel = manifest.channels[index];
    const definition = CHANNEL_DEFINITIONS[id];
    exactKeys(
      channel,
      ["id", "role", "availability", "installerOfRecord", "platforms", "publicCommand", "immutableCommand", "artifactSha256", "projection", "liveEvidenceReceipt"],
      `channel ${id}`,
    );
    invariant(channel.id === id, `Channel order or identity mismatch at ${id}`);
    invariant(channel.role === definition.role, `${id} role mismatch`);
    invariant(channel.availability === "PROJECTED_NOT_PUBLISHED", `${id} may not claim live availability from local projection evidence`);
    invariant(channel.installerOfRecord === definition.installerOfRecord, `${id} installer-of-record mismatch`);
    invariant(JSON.stringify(channel.platforms) === JSON.stringify(definition.platforms), `${id} platform claim mismatch`);
    invariant(channel.publicCommand === definition.publicCommand, `${id} public command mismatch`);
    invariant(channel.immutableCommand === commands[id], `${id} immutable command mismatch`);
    invariant(channel.artifactSha256 === envelope.tarball.sha256, `${id} does not bind the candidate tarball`);
    exactKeys(channel.projection, ["file", "sha256"], `${id}.projection`);
    invariant(channel.projection.file === definition.projectionFile, `${id} projection file mismatch`);
    invariant(SHA256.test(channel.projection.sha256), `${id} projection digest is invalid`);
    invariant(channel.liveEvidenceReceipt === null, `${id} contains an unverified live-evidence claim`);
  }

  invariant(manifest.files && typeof manifest.files === "object" && !Array.isArray(manifest.files), "files must be an object");
  const expectedFiles = CHANNEL_ORDER.map((id) => CHANNEL_DEFINITIONS[id].projectionFile).sort();
  invariant(JSON.stringify(Object.keys(manifest.files).sort()) === JSON.stringify(expectedFiles), "Distribution projection file set mismatch");
  for (const [relative, digest] of Object.entries(manifest.files)) {
    normalizeRelativeFile(relative, "projection path");
    invariant(SHA256.test(digest), `Projection digest is invalid: ${relative}`);
  }

  exactKeys(
    manifest.recovery,
    ["npmArtifactsImmutable", "overwriteForbidden", "strategy", "rehearsalStatus", "rollbackBarrier", "recoveryReceiptDigest"],
    "recovery",
  );
  invariant(manifest.recovery.npmArtifactsImmutable === true, "npm artifacts must remain immutable");
  invariant(manifest.recovery.overwriteForbidden === true, "Release overwrite must be forbidden");
  invariant(manifest.recovery.strategy === "HALT_CHANNEL_AND_FIXED_FORWARD_OR_VERIFIED_PRIOR_VERSION", "Unexpected recovery strategy");
  invariant(manifest.recovery.rehearsalStatus === "MISSING_EXTERNAL_EVIDENCE", "Local projection cannot claim recovery rehearsal");
  invariant(manifest.recovery.rollbackBarrier === "UNKNOWN_UNTIL_N_MINUS_1_STATE_COMPATIBILITY_EVIDENCE", "Rollback barrier truth was weakened");
  invariant(manifest.recovery.recoveryReceiptDigest === null, "Local projection contains a fabricated recovery receipt");

  exactKeys(manifest.readiness, ["decision", "blockers", "claim"], "readiness");
  invariant(manifest.readiness.decision === "BLOCKED", "Projection-only evidence must remain BLOCKED");
  invariant(Array.isArray(manifest.readiness.blockers), "Readiness blockers must be an array");
  const blockers = new Set(manifest.readiness.blockers);
  for (const blocker of [
    "PUBLISHED_NPM_TARBALL_AND_PROVENANCE_NOT_VERIFIED",
    "CHANNEL_INSTALL_RECEIPTS_MISSING",
    "ROLLBACK_OR_FIXED_FORWARD_REHEARSAL_MISSING",
    "OBSERVATION_THRESHOLDS_AND_TELEMETRY_MISSING",
  ]) {
    invariant(blockers.has(blocker), `Mandatory readiness blocker missing: ${blocker}`);
  }
  invariant(
    manifest.readiness.claim === "Generated projections are deterministic local evidence only; they do not prove publication, installation, promotion, or rollback.",
    "Readiness claim differs from the fail-closed policy",
  );
}

export async function verifyDistributionFiles(manifest, envelope, projectionsRoot) {
  validateDistributionManifest(manifest, envelope);
  for (const [relative, expectedDigest] of Object.entries(manifest.files)) {
    const normalized = normalizeRelativeFile(relative, "projection path");
    const absolute = path.resolve(projectionsRoot, normalized);
    invariant(absolute.startsWith(`${path.resolve(projectionsRoot)}${path.sep}`), `Projection path escapes root: ${relative}`);
    invariant((await sha256File(absolute)) === expectedDigest, `Projection digest mismatch: ${relative}`);
  }
  for (const channel of manifest.channels) {
    invariant(manifest.files[channel.projection.file] === channel.projection.sha256, `${channel.id} projection digest is not manifest-bound`);
  }
}

export function validateDistributionReceipt(receipt, { manifest, manifestSha256 }) {
  exactKeys(
    receipt,
    ["schemaVersion", "channel", "distributionManifestSha256", "candidate", "projectionSha256", "runtimeIdentity", "checks", "evidence", "observer", "observedAt"],
    "distribution receipt",
  );
  invariant(receipt.schemaVersion === 2, "Unsupported distribution-receipt schema");
  invariant(CHANNEL_ORDER.includes(receipt.channel), `Unknown distribution channel: ${receipt.channel}`);
  invariant(receipt.distributionManifestSha256 === manifestSha256, "Receipt distribution-manifest digest mismatch");
  const channel = manifest.channels.find((entry) => entry.id === receipt.channel);
  invariant(receipt.projectionSha256 === channel.projection.sha256, "Receipt projection digest mismatch");

  exactKeys(receipt.candidate, ["packageName", "version", "sourceCommit", "tarballSha256", "sbomSha256", "releaseInputsSha256", "payloadSha256"], "receipt candidate");
  invariant(receipt.candidate.packageName === manifest.candidate.packageName, "Receipt package mismatch");
  invariant(receipt.candidate.version === manifest.candidate.version, "Receipt version mismatch");
  invariant(receipt.candidate.sourceCommit === manifest.candidate.sourceCommit, "Receipt source mismatch");
  invariant(receipt.candidate.tarballSha256 === manifest.candidate.tarball.sha256, "Receipt tarball mismatch");
  invariant(receipt.candidate.sbomSha256 === manifest.candidate.sbom.sha256, "Receipt SBOM mismatch");
  invariant(receipt.candidate.releaseInputsSha256 === manifest.candidate.releaseInputs.sha256, "Receipt release-input mismatch");
  invariant(receipt.candidate.payloadSha256 === manifest.candidate.identities.payloadSha256, "Receipt payload identity mismatch");

  exactKeys(receipt.runtimeIdentity, ["version", "buildDigest", "platform", "architecture", "artifactChannel", "installerOfRecord", "protocolRange"], "runtime identity");
  invariant(receipt.runtimeIdentity.version === manifest.candidate.version, "Installed runtime version mismatch");
  invariant(SHA256.test(receipt.runtimeIdentity.buildDigest), "Installed build digest is invalid");
  invariant(receipt.runtimeIdentity.buildDigest === manifest.candidate.identities.payloadSha256, "Installed build digest differs from the candidate payload identity");
  invariant(channel.platforms.includes(`${receipt.runtimeIdentity.platform}-${receipt.runtimeIdentity.architecture}`), "Receipt platform is outside channel support");
  invariant(receipt.runtimeIdentity.artifactChannel === "npm", "All first-GA projections must resolve the canonical npm artifact channel");
  invariant(receipt.runtimeIdentity.installerOfRecord === channel.installerOfRecord, "Installed installer-of-record mismatch");
  exactKeys(receipt.runtimeIdentity.protocolRange, ["minimum", "maximum"], "runtime protocol range");
  invariant(typeof receipt.runtimeIdentity.protocolRange.minimum === "string", "Protocol minimum is missing");
  invariant(typeof receipt.runtimeIdentity.protocolRange.maximum === "string", "Protocol maximum is missing");

  exactKeys(receipt.checks, ["selfTest", "provenance", "supportPolicy", "uninstallCleanup", "rollbackOrFixedForward"], "receipt checks");
  for (const [check, result] of Object.entries(receipt.checks)) invariant(result === "PASS", `${check} did not pass`);
  exactKeys(receipt.evidence, ["install", "selfTest", "version", "provenance", "uninstall", "recovery"], "receipt evidence");
  for (const [name, evidence] of Object.entries(receipt.evidence)) {
    exactKeys(evidence, ["file", "sha256"], `receipt evidence ${name}`);
    normalizeRelativeFile(evidence.file, `receipt evidence ${name}.file`);
    invariant(SHA256.test(evidence.sha256), `receipt evidence ${name}.sha256 is invalid`);
  }
  exactKeys(receipt.observer, ["kind", "identity"], "receipt observer");
  invariant(["github-hosted-runner", "policy-approved-real-host"].includes(receipt.observer.kind), "Receipt observer kind is not admissible");
  invariant(typeof receipt.observer.identity === "string" && receipt.observer.identity.length > 0, "Receipt observer identity is missing");
  invariant(ISO_INSTANT.test(receipt.observedAt) && !Number.isNaN(Date.parse(receipt.observedAt)), "Receipt observedAt is invalid");
}
