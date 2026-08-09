import { createHash } from "node:crypto";
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

export const DISTRIBUTION_SCHEMA_VERSION = 3;
export const DISTRIBUTION_MANIFEST_FILE = "distribution-manifest.json";
export const RELEASE_WORKFLOW = ".github/workflows/release.yml";
export const RELEASE_ENVIRONMENT = "npm";

const SHA256 = /^[0-9a-f]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SUPPORTED_PLATFORM_KEYS = new Set(["linux-x64", "darwin-x64", "win32-x64"]);
const SUPPORTED_PLATFORMS = new Set(["linux", "darwin", "win32"]);
const APPROVED_CHANNEL_IDS = new Set(["npm", "bun", "curl", "homebrew", "aur"]);
const INSTALLERS = new Set(["npm", "bun", "homebrew", "pacman"]);
const CANDIDATE_INVOCATION_POLICIES = new Set(["npm-exact-version", "bun-exact-version", "verified-projection"]);
const CHANNEL_ROLES = new Set(["canonical-artifact", "registry-projection", "bootstrap-projection", "formula-projection", "package-projection"]);
const RECEIPT_EVIDENCE_FILE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.json$/u;
const PACKAGE_MANAGER_VERSION = /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/u;
const STABLE_DISTRIBUTION_TEST_ID = "TC-053-DISTRIBUTION-CHANNEL-TRANSACTION-V1";
const CHANNEL_CONSTRAINTS = Object.freeze({
  npm: Object.freeze({ role: "canonical-artifact", installerOfRecord: "npm", candidateInvocationPolicy: "npm-exact-version" }),
  bun: Object.freeze({ role: "registry-projection", installerOfRecord: "bun", candidateInvocationPolicy: "bun-exact-version" }),
  curl: Object.freeze({ role: "bootstrap-projection", installerOfRecord: "npm", candidateInvocationPolicy: "verified-projection" }),
  homebrew: Object.freeze({ role: "formula-projection", installerOfRecord: "homebrew", candidateInvocationPolicy: "verified-projection" }),
  aur: Object.freeze({ role: "package-projection", installerOfRecord: "pacman", candidateInvocationPolicy: "verified-projection" }),
});

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

export function normalizeReceiptEvidenceFile(value, label) {
  const normalized = normalizeRelativeFile(value, label);
  invariant(value === normalized, `${label} must use canonical forward-slash syntax`);
  invariant(RECEIPT_EVIDENCE_FILE.test(value), `${label} violates the distribution-receipt path schema`);
  return normalized;
}

export function distributionReceiptId(channel, platformKey, nodeVersion) {
  invariant(APPROVED_CHANNEL_IDS.has(channel), `Unknown distribution channel: ${channel}`);
  invariant(SUPPORTED_PLATFORM_KEYS.has(platformKey), `Unsupported receipt platform: ${platformKey}`);
  invariant(typeof nodeVersion === "string" && /^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(nodeVersion), "Receipt Node version is invalid");
  return `${channel}-${platformKey}-node${nodeVersion.slice(1)}`;
}

export function validateSupportPolicy(policy) {
  exactKeys(
    policy,
    ["schemaVersion", "packageName", "canonicalRegistry", "architectures", "node", "protocolRange", "approvedRealHosts", "ciMatrix", "preGaExternalEvidence", "channelOrder", "channels"],
    "support policy",
  );
  invariant(policy.schemaVersion === 2, "Unsupported support-policy schema");
  invariant(policy.packageName === PACKAGE_NAME, "Support policy package mismatch");
  invariant(policy.canonicalRegistry === REGISTRY, "Support policy registry mismatch");
  invariant(JSON.stringify(policy.architectures) === JSON.stringify(["x64"]), "Support policy architecture claim differs from the admitted x64 set");
  exactKeys(policy.node, ["minimum", "supportedLines", "tested"], "support policy Node range");
  invariant(policy.node.minimum === "22.17.1", "Support policy Node minimum differs from the admitted runtime floor");
  invariant(
    JSON.stringify(policy.node.supportedLines) === JSON.stringify(["22.17.1", "24.4.1"]),
    "Support policy Node lines differ from the admitted runtime lines",
  );
  invariant(
    JSON.stringify(policy.node.tested) === JSON.stringify(policy.node.supportedLines),
    "Every supported Node line must be represented exactly once in the tested set",
  );
  exactKeys(policy.protocolRange, ["minimum", "maximum"], "support policy protocol range");
  invariant(policy.protocolRange.minimum === "1" && policy.protocolRange.maximum === "1", "Support policy protocol range differs from the admitted 1..1 contract");
  invariant(Array.isArray(policy.approvedRealHosts), "Support policy approved-real-host set is missing");
  const approvedRealHostIdentities = new Set();
  for (const host of policy.approvedRealHosts) {
    exactKeys(host, ["runnerImage", "platform", "architecture", "node"], "support policy approved real host");
    invariant(typeof host.runnerImage === "string" && /^policy-approved:[A-Za-z0-9][A-Za-z0-9._:-]{2,111}$/u.test(host.runnerImage), "Approved real-host identity is invalid");
    invariant(SUPPORTED_PLATFORMS.has(host.platform), "Approved real host uses an unknown platform");
    invariant(policy.architectures.includes(host.architecture), "Approved real host uses an unsupported architecture");
    invariant(policy.node.tested.includes(host.node), "Approved real host uses an unsupported Node runtime");
    const identity = canonicalSha256(host);
    invariant(!approvedRealHostIdentities.has(identity), "Support policy contains a duplicate approved real host");
    approvedRealHostIdentities.add(identity);
  }
  invariant(Array.isArray(policy.ciMatrix) && policy.ciMatrix.length >= 3, "Support policy CI matrix is incomplete");
  invariant(Array.isArray(policy.preGaExternalEvidence) && policy.preGaExternalEvidence.length >= 5, "Pre-GA external evidence obligations are incomplete");

  const matrixIds = new Set();
  const supported = new Set();
  for (const entry of policy.ciMatrix) {
    invariant(entry && typeof entry === "object" && !Array.isArray(entry), "Support-policy CI entry must be an object");
    const observationOnly = entry.claim === "observation-only";
    exactKeys(
      entry,
      observationOnly
        ? ["id", "runner", "platform", "architecture", "node", "claim"]
        : ["id", "runner", "platform", "architecture", "node"],
      `support policy CI entry ${entry.id ?? "<unknown>"}`,
    );
    invariant(typeof entry.id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.id), "Support-policy CI entry id is invalid");
    invariant(!matrixIds.has(entry.id), `Support-policy CI entry id is duplicated: ${entry.id}`);
    matrixIds.add(entry.id);
    invariant(typeof entry.runner === "string" && entry.runner.length > 0, `${entry.id} runner is missing`);
    invariant(SUPPORTED_PLATFORMS.has(entry.platform), `${entry.id} platform is unknown`);
    invariant(typeof entry.architecture === "string" && entry.architecture.length > 0, `${entry.id} architecture is missing`);
    invariant(policy.node.tested.includes(entry.node), `${entry.id} uses an untested Node line`);
    if (observationOnly) continue;
    invariant(policy.architectures.includes(entry.architecture), `${entry.id} claims an unadmitted architecture`);
    supported.add(`${entry.platform}-${entry.architecture}`);
  }
  for (const platform of SUPPORTED_PLATFORM_KEYS) {
    invariant(supported.has(platform), `Support policy lacks a mandatory ${platform} receipt definition`);
    const [platformName, architecture] = platform.split("-");
    for (const node of policy.node.tested) {
      invariant(
        policy.ciMatrix.some((entry) => entry.claim !== "observation-only" && entry.platform === platformName && entry.architecture === architecture && entry.node === node),
        `Support policy lacks mandatory ${platform} coverage for Node ${node}`,
      );
    }
  }
  invariant(
    Array.isArray(policy.channelOrder) && policy.channelOrder.length === APPROVED_CHANNEL_IDS.size &&
      new Set(policy.channelOrder).size === policy.channelOrder.length &&
      policy.channelOrder.every((id) => APPROVED_CHANNEL_IDS.has(id)),
    "Support policy channel order must contain every approved channel exactly once",
  );
  exactKeys(policy.channels, policy.channelOrder, "support policy channels");
  for (const id of policy.channelOrder) {
    const channel = policy.channels[id];
    const constraints = CHANNEL_CONSTRAINTS[id];
    exactKeys(
      channel,
      ["role", "availability", "artifactChannel", "installerOfRecord", "platforms", "projectionFile", "publicCommand", "candidateInvocationPolicy", "runtimeDependency"],
      `support policy channel ${id}`,
    );
    invariant(CHANNEL_ROLES.has(channel.role), `${id} role is unknown`);
    invariant(channel.role === constraints.role, `${id} role violates its channel contract`);
    invariant(channel.availability === "PROJECTED_NOT_PUBLISHED", `${id} may not claim live availability in the pre-publication policy`);
    invariant(channel.artifactChannel === "npm", `${id} must resolve the canonical npm artifact`);
    invariant(INSTALLERS.has(channel.installerOfRecord), `${id} installer-of-record is unknown`);
    invariant(channel.installerOfRecord === constraints.installerOfRecord, `${id} installer-of-record violates its channel contract`);
    invariant(Array.isArray(channel.platforms) && channel.platforms.length > 0, `${id} platform set is missing`);
    invariant(new Set(channel.platforms).size === channel.platforms.length, `${id} platform set contains duplicates`);
    for (const platform of channel.platforms) {
      invariant(SUPPORTED_PLATFORM_KEYS.has(platform), `${id} claims unsupported platform ${platform}`);
      invariant(supported.has(platform), `${id} claims platform ${platform} without a support-matrix lane`);
    }
    normalizeRelativeFile(channel.projectionFile, `${id}.projectionFile`);
    invariant(typeof channel.publicCommand === "string" && channel.publicCommand.length > 0, `${id} public command is missing`);
    invariant(!/[\r\n\0]/u.test(channel.publicCommand), `${id} public command is not a single safe line`);
    invariant(CANDIDATE_INVOCATION_POLICIES.has(channel.candidateInvocationPolicy), `${id} candidate-invocation policy is unknown`);
    invariant(channel.candidateInvocationPolicy === constraints.candidateInvocationPolicy, `${id} candidate-invocation policy violates its channel contract`);
    invariant(typeof channel.runtimeDependency === "string" && /^[A-Za-z0-9@^.+:/|><= _-]+$/u.test(channel.runtimeDependency), `${id} runtime dependency is unsafe`);
    if (id === "homebrew") {
      invariant(/^[a-z0-9@+_.-]+$/u.test(channel.runtimeDependency), "Homebrew runtime dependency is not a safe formula identity");
    }
    if (id === "aur") {
      invariant(/^[a-z0-9@+_.-]+(?:[<>=]+[0-9][0-9A-Za-z.+_-]*)?$/u.test(channel.runtimeDependency), "AUR runtime dependency is not a safe package constraint");
    }
  }
  return Object.freeze([...supported].sort());
}

export function channelDefinitionsFromSupportPolicy(policy) {
  validateSupportPolicy(policy);
  return Object.freeze(Object.fromEntries(policy.channelOrder.map((id) => {
    const channel = policy.channels[id];
    return [id, Object.freeze({ ...channel, platforms: Object.freeze([...channel.platforms]) })];
  })));
}

const sourceSupportPolicy = JSON.parse(
  await readFile(new URL("../packaging/support-policy.json", import.meta.url), "utf8"),
);

export const CHANNEL_ORDER = Object.freeze([...sourceSupportPolicy.channelOrder]);
export const CHANNEL_DEFINITIONS = channelDefinitionsFromSupportPolicy(sourceSupportPolicy);

export function candidateInvocations(version, channelDefinitions = CHANNEL_DEFINITIONS) {
  const commands = {};
  for (const id of Object.keys(channelDefinitions)) {
    const definition = channelDefinitions[id];
    if (definition.candidateInvocationPolicy === "npm-exact-version") {
      commands[id] = `npm install -g --ignore-scripts --no-audit --no-fund --registry=${REGISTRY} ${PACKAGE_NAME}@${version}`;
    } else if (definition.candidateInvocationPolicy === "bun-exact-version") {
      commands[id] = `bun add --global --ignore-scripts --registry=${REGISTRY} ${PACKAGE_NAME}@${version}`;
    } else if (id === "curl") {
      commands[id] = `sh ${definition.projectionFile}`;
    } else if (id === "homebrew") {
      commands[id] = `brew install --formula ${definition.projectionFile}`;
    } else {
      commands[id] = `cd ${path.posix.dirname(definition.projectionFile)} && makepkg --syncdeps --install`;
    }
  }
  return Object.freeze(commands);
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
  const channelDefinitions = channelDefinitionsFromSupportPolicy(supportPolicy);
  await validateCycloneDxSbom(
    path.resolve(evidenceRoot, normalizeRelativeFile(envelope.sbom.file, "sbom.file")),
    envelope,
  );
  return { supportPolicy, supportedPlatforms, channelDefinitions, channelOrder: Object.freeze([...supportPolicy.channelOrder]) };
}

export function validateDistributionManifest(manifest, envelope, channelDefinitions = CHANNEL_DEFINITIONS) {
  const channelOrder = Object.keys(channelDefinitions);
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
  invariant(manifest.channels.length === channelOrder.length, "Every approved channel must be represented exactly once");
  const commands = candidateInvocations(envelope.version, channelDefinitions);
  for (const [index, id] of channelOrder.entries()) {
    const channel = manifest.channels[index];
    const definition = channelDefinitions[id];
    exactKeys(
      channel,
      ["id", "role", "availability", "artifactChannel", "installerOfRecord", "runtimeDependency", "platforms", "publicCommand", "candidateInvocation", "artifactSha256", "projection", "liveEvidenceReceipt"],
      `channel ${id}`,
    );
    invariant(channel.id === id, `Channel order or identity mismatch at ${id}`);
    invariant(channel.role === definition.role, `${id} role mismatch`);
    invariant(channel.availability === definition.availability, `${id} may not claim live availability outside the bound support policy`);
    invariant(channel.artifactChannel === definition.artifactChannel, `${id} artifact-channel mismatch`);
    invariant(channel.installerOfRecord === definition.installerOfRecord, `${id} installer-of-record mismatch`);
    invariant(channel.runtimeDependency === definition.runtimeDependency, `${id} runtime-dependency mismatch`);
    invariant(JSON.stringify(channel.platforms) === JSON.stringify(definition.platforms), `${id} platform claim mismatch`);
    invariant(channel.publicCommand === definition.publicCommand, `${id} public command mismatch`);
    invariant(channel.candidateInvocation === commands[id], `${id} candidate invocation mismatch`);
    invariant(channel.artifactSha256 === envelope.tarball.sha256, `${id} does not bind the candidate tarball`);
    exactKeys(channel.projection, ["file", "sha256"], `${id}.projection`);
    invariant(channel.projection.file === definition.projectionFile, `${id} projection file mismatch`);
    invariant(SHA256.test(channel.projection.sha256), `${id} projection digest is invalid`);
    invariant(channel.liveEvidenceReceipt === null, `${id} contains an unverified live-evidence claim`);
  }

  invariant(manifest.files && typeof manifest.files === "object" && !Array.isArray(manifest.files), "files must be an object");
  const expectedFiles = channelOrder.map((id) => channelDefinitions[id].projectionFile).sort();
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

export async function verifyDistributionFiles(manifest, envelope, projectionsRoot, channelDefinitions = CHANNEL_DEFINITIONS) {
  validateDistributionManifest(manifest, envelope, channelDefinitions);
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

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    invariant(Number.isSafeInteger(value), "Content-addressed JSON contains a non-safe integer");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  invariant(value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype, "Content-addressed value must be plain JSON");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function canonicalSha256(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

const OBSERVATION_TYPES = Object.freeze({
  install: "INSTALL",
  selfTest: "SELF_TEST",
  version: "VERSION",
  provenance: "PROVENANCE",
  uninstall: "UNINSTALL",
  recovery: "RECOVERY",
});

function validateRuntimeIdentity(runtimeIdentity, { manifest, channel, supportedNodeVersions, protocolRange }, label = "runtime identity") {
  exactKeys(runtimeIdentity, ["version", "buildDigest", "platform", "architecture", "node", "artifactChannel", "installerOfRecord", "protocolRange"], label);
  invariant(runtimeIdentity.version === manifest.candidate.version, "Installed runtime version mismatch");
  invariant(SHA256.test(runtimeIdentity.buildDigest), "Installed build digest is invalid");
  invariant(runtimeIdentity.buildDigest === manifest.candidate.identities.payloadSha256, "Installed build digest differs from the candidate payload identity");
  invariant(channel.platforms.includes(`${runtimeIdentity.platform}-${runtimeIdentity.architecture}`), "Receipt platform is outside channel support");
  invariant(Array.isArray(supportedNodeVersions) && supportedNodeVersions.includes(runtimeIdentity.node), "Receipt Node version is outside the bound support policy");
  invariant(runtimeIdentity.artifactChannel === "npm", "All first-GA projections must resolve the canonical npm artifact channel");
  invariant(runtimeIdentity.installerOfRecord === channel.installerOfRecord, "Installed installer-of-record mismatch");
  exactKeys(runtimeIdentity.protocolRange, ["minimum", "maximum"], `${label} protocol range`);
  invariant(
    canonicalSha256(runtimeIdentity.protocolRange) === canonicalSha256(protocolRange),
    "Installed protocol range differs from the bound support policy",
  );
}

export function validateDistributionReceipt(receipt, {
  manifest,
  manifestSha256,
  supportedNodeVersions,
  supportPolicy,
  supportPolicySha256,
}) {
  exactKeys(receipt, ["schemaVersion", "attestation", "attestationSha256", "releaseEligible"], "distribution receipt");
  invariant(receipt.schemaVersion === 3, "Unsupported distribution-receipt schema");
  invariant(receipt.releaseEligible === false, "An unauthenticated distribution receipt may not claim release eligibility");
  exactKeys(receipt.attestation, ["statement", "statementSha256", "signingEvidence"], "distribution attestation");
  invariant(receipt.attestation.statementSha256 === canonicalSha256(receipt.attestation.statement), "Attestation statement digest mismatch");
  invariant(receipt.attestationSha256 === canonicalSha256(receipt.attestation), "Attestation envelope digest mismatch");
  exactKeys(receipt.attestation.signingEvidence, ["type", "file", "sha256"], "attestation signing evidence");
  invariant(receipt.attestation.signingEvidence.type === "GITHUB_OIDC_SIGNATURE_VERIFICATION", "Signing-evidence type is invalid");
  normalizeReceiptEvidenceFile(receipt.attestation.signingEvidence.file, "attestation signing-evidence file");
  invariant(SHA256.test(receipt.attestation.signingEvidence.sha256), "Signing-evidence digest is invalid");

  const statement = receipt.attestation.statement;
  exactKeys(
    statement,
    ["schemaVersion", "predicateType", "issuer", "subject", "hostPolicy", "candidate", "runtimeIdentity", "execution", "observations", "observationsSha256", "observedAt"],
    "attestation statement",
  );
  invariant(statement.schemaVersion === 1, "Unsupported distribution-attestation statement schema");
  invariant(statement.predicateType === "https://runacode.io/attestations/runa-cli-distribution-observation/v1", "Distribution-attestation predicate type is invalid");

  exactKeys(statement.issuer, ["provider", "repository", "workflow", "workflowRef", "sourceRef", "sourceCommit", "runId", "runAttempt"], "attestation issuer");
  invariant(statement.issuer.provider === "github-actions", "Attestation issuer provider is not admissible");
  invariant(statement.issuer.repository === manifest.candidate.repository && statement.issuer.repository === REPOSITORY, "Attestation issuer repository substitution detected");
  invariant(statement.issuer.workflow === RELEASE_WORKFLOW, "Attestation issuer workflow substitution detected");
  invariant(statement.issuer.workflowRef === `${REPOSITORY}/${RELEASE_WORKFLOW}@refs/heads/main`, "Attestation workflow-ref substitution detected");
  invariant(statement.issuer.sourceRef === `refs/tags/v${manifest.candidate.version}`, "Attestation source ref does not bind the candidate version");
  invariant(statement.issuer.sourceCommit === manifest.candidate.sourceCommit, "Attestation issuer source commit differs from the candidate");
  invariant(/^[1-9][0-9]*$/u.test(statement.issuer.runId), "Attestation issuer run id is invalid");
  invariant(Number.isSafeInteger(statement.issuer.runAttempt) && statement.issuer.runAttempt >= 1, "Attestation issuer run attempt is invalid");

  exactKeys(statement.subject, ["receiptId", "channel", "platform", "architecture", "node", "distributionManifestSha256", "candidatePayloadSha256", "projectionSha256"], "attestation subject");
  invariant(CHANNEL_ORDER.includes(statement.subject.channel), `Unknown distribution channel: ${statement.subject.channel}`);
  const channel = manifest.channels.find((entry) => entry.id === statement.subject.channel);
  invariant(channel, "Attestation channel is absent from the distribution manifest");
  invariant(
    statement.subject.receiptId === distributionReceiptId(
      statement.subject.channel,
      `${statement.subject.platform}-${statement.subject.architecture}`,
      statement.subject.node,
    ),
    "Attestation receipt identity is not canonical",
  );
  invariant(statement.subject.distributionManifestSha256 === manifestSha256, "Receipt distribution-manifest digest mismatch");
  invariant(statement.subject.candidatePayloadSha256 === manifest.candidate.identities.payloadSha256, "Receipt subject payload identity mismatch");
  invariant(statement.subject.projectionSha256 === channel.projection.sha256, "Receipt projection digest mismatch");

  exactKeys(statement.candidate, ["packageName", "version", "sourceCommit", "tarballSha256", "sbomSha256", "releaseInputsSha256", "payloadSha256"], "receipt candidate");
  invariant(statement.candidate.packageName === manifest.candidate.packageName, "Receipt package mismatch");
  invariant(statement.candidate.version === manifest.candidate.version, "Receipt version mismatch");
  invariant(statement.candidate.sourceCommit === manifest.candidate.sourceCommit, "Receipt source mismatch");
  invariant(statement.candidate.tarballSha256 === manifest.candidate.tarball.sha256, "Receipt tarball mismatch");
  invariant(statement.candidate.sbomSha256 === manifest.candidate.sbom.sha256, "Receipt SBOM mismatch");
  invariant(statement.candidate.releaseInputsSha256 === manifest.candidate.releaseInputs.sha256, "Receipt release-input mismatch");
  invariant(statement.candidate.payloadSha256 === manifest.candidate.identities.payloadSha256, "Receipt payload identity mismatch");

  validateRuntimeIdentity(statement.runtimeIdentity, {
    manifest,
    channel,
    supportedNodeVersions,
    protocolRange: supportPolicy.protocolRange,
  });
  invariant(
    statement.subject.platform === statement.runtimeIdentity.platform &&
      statement.subject.architecture === statement.runtimeIdentity.architecture &&
      statement.subject.node === statement.runtimeIdentity.node,
    "Attestation subject and runtime host differ",
  );

  exactKeys(statement.hostPolicy, ["kind", "runnerImage", "platform", "architecture", "node", "supportPolicySha256"], "attestation host policy");
  invariant(["github-hosted-runner", "policy-approved-real-host"].includes(statement.hostPolicy.kind), "Receipt host kind is not admissible");
  invariant(typeof statement.hostPolicy.runnerImage === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(statement.hostPolicy.runnerImage), "Receipt runner image is invalid");
  invariant(statement.hostPolicy.platform === statement.runtimeIdentity.platform && statement.hostPolicy.architecture === statement.runtimeIdentity.architecture, "Receipt host policy and runtime host differ");
  invariant(statement.hostPolicy.node === statement.runtimeIdentity.node, "Receipt host policy and runtime Node differ");
  invariant(SHA256.test(supportPolicySha256) && statement.hostPolicy.supportPolicySha256 === supportPolicySha256, "Receipt host policy digest differs from the candidate support policy");
  if (statement.hostPolicy.kind === "github-hosted-runner") {
    invariant(
      supportPolicy?.ciMatrix?.some((entry) => entry.claim !== "observation-only" &&
        entry.runner === statement.hostPolicy.runnerImage &&
        entry.platform === statement.hostPolicy.platform &&
        entry.architecture === statement.hostPolicy.architecture &&
        `v${entry.node}` === statement.hostPolicy.node),
      "Receipt host is not an admitted support-policy runner",
    );
  } else {
    invariant(
      supportPolicy.approvedRealHosts.some((host) =>
        host.runnerImage === statement.hostPolicy.runnerImage &&
        host.platform === statement.hostPolicy.platform &&
        host.architecture === statement.hostPolicy.architecture &&
        `v${host.node}` === statement.hostPolicy.node),
      "Real-host receipt is not an exact member of the approved support-policy host set",
    );
  }

  exactKeys(statement.execution, ["stableTestId", "packageManager", "candidateInvocation", "environmentPolicy", "publicShimResolution"], "receipt execution context");
  invariant(statement.execution.stableTestId === STABLE_DISTRIBUTION_TEST_ID, "Receipt stable test identity is invalid");
  exactKeys(statement.execution.packageManager, ["name", "version"], "receipt package manager");
  invariant(statement.execution.packageManager.name === channel.installerOfRecord, "Receipt package-manager identity differs from the installer of record");
  invariant(typeof statement.execution.packageManager.version === "string" && PACKAGE_MANAGER_VERSION.test(statement.execution.packageManager.version), "Receipt package-manager version is invalid");
  invariant(statement.execution.candidateInvocation === channel.candidateInvocation, "Receipt candidate invocation differs from the bound distribution manifest");
  exactKeys(statement.execution.environmentPolicy, ["kind", "networkPolicy", "userStateSentinels", "environmentId"], "receipt environment isolation policy");
  invariant(statement.execution.environmentPolicy.kind === "ephemeral-dedicated-prefix", "Receipt environment is not an isolated ephemeral prefix");
  invariant(statement.execution.environmentPolicy.networkPolicy === "INSTALL_ONLY_THEN_OFFLINE", "Receipt environment network policy is invalid");
  invariant(statement.execution.environmentPolicy.userStateSentinels === true, "Receipt environment omits user-state sentinels");
  invariant(statement.execution.environmentPolicy.environmentId === statement.subject.receiptId, "Receipt environment identity differs from its matrix cell");
  exactKeys(statement.execution.publicShimResolution, ["command", "resolutionMethod", "resolvedPath", "internalModuleBypass"], "receipt public shim resolution");
  invariant(statement.execution.publicShimResolution.command === "runa" && statement.execution.publicShimResolution.resolutionMethod === "shell-path", "Receipt did not resolve the public runa command through the shell");
  invariant(statement.execution.publicShimResolution.internalModuleBypass === false, "Receipt used an internal-module bypass instead of the public runa shim");
  const resolvedShim = statement.execution.publicShimResolution.resolvedPath;
  invariant(typeof resolvedShim === "string" && resolvedShim.length > 0 && resolvedShim.length <= 1024 && !/[\r\n\0]/u.test(resolvedShim), "Receipt public shim path is invalid");
  if (statement.subject.platform === "win32") {
    invariant(path.win32.isAbsolute(resolvedShim) && path.win32.basename(resolvedShim).toLowerCase() === "runa.cmd", "Windows receipt did not resolve the public runa.cmd shim");
  } else {
    invariant(path.posix.isAbsolute(resolvedShim) && path.posix.basename(resolvedShim) === "runa", "POSIX receipt did not resolve the public runa shim");
  }

  exactKeys(statement.observations, Object.keys(OBSERVATION_TYPES), "receipt observations");
  for (const [name, expectedType] of Object.entries(OBSERVATION_TYPES)) {
    const observation = statement.observations[name];
    exactKeys(observation, ["type", "file", "sha256"], `receipt observation ${name}`);
    invariant(observation.type === expectedType, `${name} observation type is invalid`);
    normalizeReceiptEvidenceFile(observation.file, `receipt observation ${name}.file`);
    invariant(SHA256.test(observation.sha256), `receipt observation ${name}.sha256 is invalid`);
  }
  invariant(statement.observationsSha256 === canonicalSha256(statement.observations), "Observation-set digest mismatch");
  invariant(ISO_INSTANT.test(statement.observedAt) && !Number.isNaN(Date.parse(statement.observedAt)), "Receipt observedAt is invalid");
  return { statement, channel, executionContextSha256: canonicalSha256(statement.execution) };
}

export function validateDistributionObservations(receipt, raw, { manifest }) {
  const { statement } = receipt.attestation;
  const channel = manifest.channels.find((entry) => entry.id === statement.subject.channel);
  const executionContextSha256 = canonicalSha256(statement.execution);
  exactKeys(raw, Object.keys(OBSERVATION_TYPES), "raw distribution observations");

  const validateExecutionContext = (observation, label) => {
    invariant(observation.executionContextSha256 === executionContextSha256, `${label} does not bind the attested execution context`);
  };

  exactKeys(raw.install, ["schemaVersion", "type", "executionContextSha256", "commandExitCode", "packageName", "version", "tarballSha256", "payloadSha256", "artifactChannel", "installerOfRecord", "projectionSha256"], "install observation");
  invariant(raw.install.schemaVersion === 1 && raw.install.type === "INSTALL", "Install observation schema is invalid");
  validateExecutionContext(raw.install, "Install observation");
  invariant(raw.install.commandExitCode === 0, "Install command did not succeed");
  invariant(raw.install.packageName === statement.candidate.packageName && raw.install.version === statement.candidate.version, "Install observation reports a different package candidate");
  invariant(raw.install.tarballSha256 === statement.candidate.tarballSha256 && raw.install.payloadSha256 === statement.candidate.payloadSha256, "Install observation reports a different artifact identity");
  invariant(raw.install.artifactChannel === statement.runtimeIdentity.artifactChannel && raw.install.installerOfRecord === channel.installerOfRecord, "Install observation reports a different channel authority");
  invariant(raw.install.projectionSha256 === statement.subject.projectionSha256, "Install observation reports a different projection");

  exactKeys(raw.selfTest, ["schemaVersion", "type", "executionContextSha256", "commandExitCode", "offline", "networkRequests", "runtimeIdentity"], "self-test observation");
  invariant(raw.selfTest.schemaVersion === 1 && raw.selfTest.type === "SELF_TEST", "Self-test observation schema is invalid");
  validateExecutionContext(raw.selfTest, "Self-test observation");
  invariant(raw.selfTest.commandExitCode === 0 && raw.selfTest.offline === true && raw.selfTest.networkRequests === 0, "Self-test observation does not prove an offline successful probe");
  invariant(canonicalSha256(raw.selfTest.runtimeIdentity) === canonicalSha256(statement.runtimeIdentity), "Self-test runtime identity differs from the attested runtime");

  exactKeys(raw.version, ["schemaVersion", "type", "executionContextSha256", "commandExitCode", "reportedVersion"], "version observation");
  invariant(raw.version.schemaVersion === 1 && raw.version.type === "VERSION", "Version observation schema is invalid");
  validateExecutionContext(raw.version, "Version observation");
  invariant(raw.version.commandExitCode === 0 && raw.version.reportedVersion === statement.candidate.version, "Version observation differs from the candidate");

  exactKeys(raw.provenance, ["schemaVersion", "type", "executionContextSha256", "packageName", "version", "sourceCommit", "tarballSha256", "sbomSha256", "releaseInputsSha256", "payloadSha256", "projectionSha256"], "provenance observation");
  invariant(raw.provenance.schemaVersion === 1 && raw.provenance.type === "PROVENANCE", "Provenance observation schema is invalid");
  validateExecutionContext(raw.provenance, "Provenance observation");
  for (const key of ["packageName", "version", "sourceCommit", "tarballSha256", "sbomSha256", "releaseInputsSha256", "payloadSha256"]) {
    invariant(raw.provenance[key] === statement.candidate[key], `Provenance observation ${key} differs from the candidate`);
  }
  invariant(raw.provenance.projectionSha256 === statement.subject.projectionSha256, "Provenance observation projection differs from the candidate");

  exactKeys(raw.uninstall, ["schemaVersion", "type", "executionContextSha256", "commandExitCode", "managedPathsBefore", "managedPathsAfter", "foreignPathsBefore", "foreignPathsAfter", "commandAvailableAfter"], "uninstall observation");
  invariant(raw.uninstall.schemaVersion === 1 && raw.uninstall.type === "UNINSTALL", "Uninstall observation schema is invalid");
  validateExecutionContext(raw.uninstall, "Uninstall observation");
  invariant(raw.uninstall.commandExitCode === 0, "Uninstall command did not succeed");
  invariant(Number.isSafeInteger(raw.uninstall.managedPathsBefore) && raw.uninstall.managedPathsBefore > 0, "Uninstall observation lacks a pre-existing managed installation");
  invariant(raw.uninstall.managedPathsAfter === 0 && raw.uninstall.commandAvailableAfter === false, "Uninstall cleanup left managed product paths");
  invariant(Number.isSafeInteger(raw.uninstall.foreignPathsBefore) && raw.uninstall.foreignPathsBefore >= 0 && raw.uninstall.foreignPathsAfter === raw.uninstall.foreignPathsBefore, "Uninstall cleanup changed foreign paths");

  exactKeys(raw.recovery, ["schemaVersion", "type", "executionContextSha256", "strategy", "commandExitCode", "sourceVersion", "sourceBuildDigest", "recoveredVersion", "recoveredBuildDigest", "healthCheckExitCode"], "recovery observation");
  invariant(raw.recovery.schemaVersion === 1 && raw.recovery.type === "RECOVERY", "Recovery observation schema is invalid");
  validateExecutionContext(raw.recovery, "Recovery observation");
  invariant(["ROLLBACK", "FIXED_FORWARD"].includes(raw.recovery.strategy), "Recovery strategy is invalid");
  invariant(raw.recovery.commandExitCode === 0 && raw.recovery.healthCheckExitCode === 0, "Recovery observation did not reach a healthy terminal state");
  invariant(raw.recovery.sourceVersion === statement.candidate.version && raw.recovery.sourceBuildDigest === statement.candidate.payloadSha256, "Recovery observation source differs from the candidate");
  invariant(typeof raw.recovery.recoveredVersion === "string" && raw.recovery.recoveredVersion.length > 0 && raw.recovery.recoveredVersion !== raw.recovery.sourceVersion, "Recovery observation did not change the failed version");
  invariant(SHA256.test(raw.recovery.recoveredBuildDigest) && raw.recovery.recoveredBuildDigest !== raw.recovery.sourceBuildDigest, "Recovery observation did not change the failed build identity");

  return Object.freeze({
    evidenceClass: "SELF_AUTHORED_TYPED_CLAIM",
    installIdentity: "CONSISTENT_TYPED_CLAIM",
    selfTest: "CONSISTENT_TYPED_CLAIM",
    version: "CONSISTENT_TYPED_CLAIM",
    provenance: "CONSISTENT_TYPED_CLAIM",
    uninstallCleanup: "CONSISTENT_TYPED_CLAIM",
    rollbackOrFixedForward: "CONSISTENT_TYPED_CLAIM",
  });
}

export function validateSigningVerificationEvidence(receipt, evidence) {
  exactKeys(evidence, ["schemaVersion", "type", "verificationState", "statementSha256", "bundleSha256", "certificateIssuer", "certificateIdentity", "verifiedAt"], "signing verification evidence");
  invariant(evidence.schemaVersion === 1 && evidence.type === "GITHUB_OIDC_SIGNATURE_VERIFICATION", "Signing verification evidence schema is invalid");
  invariant(evidence.statementSha256 === receipt.attestation.statementSha256, "Signing verification evidence does not bind the attestation statement");
  invariant(evidence.verificationState === "NOT_VERIFIED_PREPUBLICATION", "Cryptographic/OIDC claims are not accepted without an independent offline verifier");
  invariant(evidence.bundleSha256 === null && evidence.certificateIssuer === null && evidence.certificateIdentity === null && evidence.verifiedAt === null, "Unverified signing evidence may not contain fabricated verification claims");
  return Object.freeze({ authentication: "UNVERIFIED", releaseEligible: false });
}
