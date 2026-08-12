import path from "node:path";

import { invariant, parseArgs, readJson, sha256File } from "./lib/release-evidence.mjs";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const evidence = path.resolve(root, args.get("evidence") ?? "evidence/native-local");
const requireProduction = args.get("require-production") === "true";
const manifest = await readJson(path.join(evidence, "cuna-native-bridge.manifest.json"));
const provenance = await readJson(path.join(evidence, "cuna-native-bridge.provenance.json"));
const sbom = await readJson(path.join(evidence, "cuna-native-bridge.spdx.json"));
const identity = await readJson(path.join(evidence, "cuna-native-bridge.identity.json"));
const binary = path.join(evidence, "cuna-native-bridge.exe");
const binarySha256 = await sha256File(binary);
const sbomSha256 = await sha256File(path.join(evidence, "cuna-native-bridge.spdx.json"));
const provenanceSha256 = await sha256File(path.join(evidence, "cuna-native-bridge.provenance.json"));
const identitySha256 = await sha256File(path.join(evidence, "cuna-native-bridge.identity.json"));

invariant(manifest.schema === "cuna.native-bridge-manifest.v1", "Native manifest schema is invalid");
invariant(manifest.protocol === "cuna.native-bridge.v1", "Native protocol identity is invalid");
invariant(manifest.platform === "win32", "Native evidence platform is invalid");
invariant(manifest.architecture === "x64" || manifest.architecture === "arm64", "Native evidence architecture is invalid");
invariant(manifest.executableFile === "cuna-native-bridge.exe", "Native executable name is invalid");
invariant(manifest.maximumCredentialBytes === 2_560, "Native capacity contract is invalid");
invariant(manifest.binarySha256 === binarySha256, "Native binary digest is not manifest-bound");
invariant(manifest.sbom?.file === "cuna-native-bridge.spdx.json" && manifest.sbom.sha256 === sbomSha256, "Native SBOM is not manifest-bound");
invariant(manifest.provenance?.file === "cuna-native-bridge.provenance.json" && manifest.provenance.sha256 === provenanceSha256, "Native provenance is not manifest-bound");
invariant(identity.schema === "cuna.native-windows-identity.v1", "Native identity receipt schema is invalid");
invariant(identity.binarySha256 === binarySha256, "Native identity receipt is not binary-bound");
invariant(identity.version?.fileVersion === manifest.fileVersion, "Native FileVersion is not manifest-bound");
invariant(identity.version?.productVersion === manifest.fileVersion, "Native ProductVersion is not manifest-bound");
invariant(identity.version?.companyName === "Cuna Labs", "Native CompanyName is invalid");
invariant(identity.version?.fileDescription === "Cuna Native Credential and Browser Bridge", "Native FileDescription is invalid");
invariant(identity.version?.originalFilename === manifest.executableFile, "Native OriginalFilename is invalid");
invariant(sbom.spdxVersion === "SPDX-2.3" && sbom.dataLicense === "CC0-1.0", "Native SPDX document identity is invalid");
invariant(Array.isArray(sbom.packages) && sbom.packages.some((entry) =>
  entry?.name === "cuna-native-bridge" && entry?.versionInfo === manifest.nativeVersion
), "Native SPDX document omits the native package");
invariant(provenance.schema === "cuna.native-bridge-provenance.v1", "Native provenance schema is invalid");
invariant(provenance.subject?.file === manifest.executableFile && provenance.subject.sha256 === binarySha256, "Native provenance subject is invalid");
invariant(provenance.build?.packageVersion === manifest.packageVersion, "Native provenance package version is invalid");
invariant(provenance.build?.nativeVersion === manifest.nativeVersion, "Native provenance crate version is invalid");
invariant(provenance.build?.platform === manifest.platform && provenance.build?.architecture === manifest.architecture, "Native provenance target is invalid");
invariant(provenance.sbom?.file === manifest.sbom.file && provenance.sbom.sha256 === sbomSha256, "Native provenance SBOM edge is invalid");
invariant(provenance.signature?.identityReceipt?.file === "cuna-native-bridge.identity.json", "Native provenance identity receipt path is invalid");
invariant(provenance.signature?.identityReceipt?.sha256 === identitySha256, "Native provenance identity receipt digest is invalid");

if (requireProduction) {
  const expectedFingerprint = args.get("publisher-fingerprint");
  invariant(typeof expectedFingerprint === "string" && /^[0-9A-F]{40,128}$/u.test(expectedFingerprint), "Production verification requires a pinned publisher fingerprint");
  invariant(manifest.releaseStatus === "production-signed", "Unsigned/local manifest is not production-admissible");
  invariant(provenance.releaseEligible === true && provenance.admission === "signed-release-candidate", "Native provenance is not release-admissible");
  invariant(identity.signature?.valid === true && identity.signature?.status === "Valid", "Authenticode verification did not pass");
  invariant(identity.locationProtected === true, "Native artifact location is user-writable");
  invariant(identity.signature?.publisherCertificateFingerprint === expectedFingerprint, "Authenticode publisher fingerprint differs");
  invariant(manifest.signature?.kind === "authenticode" && manifest.signature?.publisherCertificateFingerprint === expectedFingerprint, "Manifest publisher binding differs");
  invariant(provenance.signature?.status === "verified" && provenance.signature?.publisherCertificateFingerprint === expectedFingerprint, "Provenance publisher binding differs");
  process.stdout.write(`${JSON.stringify({ status: "NATIVE_PRODUCTION_EVIDENCE_VERIFIED", releaseEligible: true, binarySha256 })}\n`);
} else {
  invariant(manifest.releaseStatus === "local-unsigned", "Local evidence must never impersonate a signed production manifest");
  invariant(provenance.releaseEligible === false, "Local native evidence must remain non-release evidence");
  invariant(provenance.admission === "blocked-unsigned-or-local" || provenance.admission === "blocked-no-independent-release-attestation", "Local native evidence is not explicitly blocked");
  invariant(
    Array.isArray(provenance.limitations) &&
      provenance.limitations.includes("NO_WINDOWS_OWNED_PROCESS_HANDLE_CHILD_IDENTITY_AUTHORITY"),
    "Local native evidence omitted the Windows process-instance authority blocker",
  );
  process.stdout.write(`${JSON.stringify({
    status: "LOCAL_NATIVE_EVIDENCE_VERIFIED_NOT_ADMISSIBLE",
    releaseEligible: false,
    binarySha256,
    limitations: provenance.limitations,
  })}\n`);
}
