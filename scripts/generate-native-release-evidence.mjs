import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { invariant, parseArgs, readJson, sha256File } from "./lib/release-evidence.mjs";

const execute = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") ?? process.cwd());
const output = path.resolve(root, args.get("output") ?? "evidence/native-local");
const sourceBinary = path.resolve(root, args.get("binary") ?? "native/target/release/cuna-native-bridge.exe");
const identityFile = path.resolve(root, requiredArgument("identity"));
const packageJson = await readJson(path.join(root, "package.json"));
const cargoRoot = path.join(root, "native");
const cargoLock = path.join(cargoRoot, "Cargo.lock");
const metadata = JSON.parse((await execute("cargo", ["metadata", "--format-version", "1", "--locked"], {
  cwd: cargoRoot,
  windowsHide: true,
  timeout: 30_000,
  maxBuffer: 16 * 1024 * 1024,
})).stdout);
const nativePackage = metadata.packages.find((entry) => entry.name === "cuna-native-bridge");
invariant(nativePackage !== undefined, "Native package metadata is missing");
const identity = await readJson(identityFile);
const sourceBinarySha256 = await sha256File(sourceBinary);
invariant(identity.schema === "cuna.native-windows-identity.v1", "Native identity receipt schema is invalid");
invariant(identity.binarySha256 === sourceBinarySha256, "Native identity receipt names a different binary");
invariant(identity.version?.fileVersion === `${nativePackage.version}.0`, "Native FileVersion is not release-bound");
invariant(identity.version?.productVersion === `${nativePackage.version}.0`, "Native ProductVersion is not release-bound");
invariant(identity.version?.companyName === "Cuna Labs", "Native CompanyName is missing");
invariant(identity.version?.fileDescription === "Cuna Native Credential and Browser Bridge", "Native FileDescription is missing");
invariant(identity.version?.originalFilename === "cuna-native-bridge.exe", "Native OriginalFilename is missing");

await mkdir(output, { recursive: true });
const binaryFile = "cuna-native-bridge.exe";
const binary = path.join(output, binaryFile);
await copyFile(sourceBinary, binary);
const identityReceiptFile = "cuna-native-bridge.identity.json";
await copyFile(identityFile, path.join(output, identityReceiptFile));
const cargoLockSha256 = await sha256File(cargoLock);
const sourceCommit = (await execute("git", ["rev-parse", "HEAD"], {
  cwd: root,
  windowsHide: true,
  timeout: 10_000,
})).stdout.trim();
const sourceStatus = (await execute("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
  cwd: root,
  windowsHide: true,
  timeout: 10_000,
  maxBuffer: 4 * 1024 * 1024,
})).stdout;
const rustc = (await execute("rustc", ["--version", "--verbose"], {
  windowsHide: true,
  timeout: 10_000,
})).stdout.trim();
const cargo = (await execute("cargo", ["--version", "--verbose"], {
  windowsHide: true,
  timeout: 10_000,
})).stdout.trim();
const lockChecksums = parseCargoLock(await readFile(cargoLock, "utf8"));
const packages = metadata.packages
  .map((entry, index) => spdxPackage(entry, index, lockChecksums))
  .sort((left, right) => left.name.localeCompare(right.name) || left.versionInfo.localeCompare(right.versionInfo));
const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `cuna-native-bridge-${nativePackage.version}`,
  documentNamespace: `https://getcuna.com/spdx/native/${sourceCommit}/${sourceBinarySha256}`,
  creationInfo: {
    created: new Date().toISOString(),
    creators: ["Organization: Cuna Labs", "Tool: cuna-native-evidence-v1"],
  },
  packages,
  relationships: packages.map((entry) => ({
    spdxElementId: "SPDXRef-DOCUMENT",
    relationshipType: "DESCRIBES",
    relatedSpdxElement: entry.SPDXID,
  })),
};
const sbomFile = "cuna-native-bridge.spdx.json";
await writeExclusiveJson(path.join(output, sbomFile), sbom);
const sbomSha256 = await sha256File(path.join(output, sbomFile));
const signed = identity.signature?.valid === true &&
  typeof identity.signature.publisherCertificateFingerprint === "string" &&
  identity.locationProtected === true && sourceStatus.length === 0;
const provenance = {
  schema: "cuna.native-bridge-provenance.v1",
  authority: "LOCAL_NATIVE_BUILD_EVIDENCE",
  releaseEligible: false,
  admission: signed ? "blocked-no-independent-release-attestation" : "blocked-unsigned-or-local",
  subject: { file: binaryFile, sha256: sourceBinarySha256, size: (await stat(binary)).size },
  build: {
    sourceCommit,
    sourceTreeStatus: sourceStatus.length === 0 ? "clean" : "dirty",
    sourceStatusSha256: sha256Text(sourceStatus),
    cargoLockSha256,
    packageVersion: packageJson.version,
    nativeVersion: nativePackage.version,
    platform: "win32",
    architecture: process.arch,
    rustc,
    cargo,
  },
  sbom: { file: sbomFile, sha256: sbomSha256 },
  signature: {
    status: identity.signature?.valid === true ? "observed-valid-not-admitted" : "unverified",
    kind: "authenticode",
    publisherCertificateFingerprint: identity.signature?.publisherCertificateFingerprint ?? null,
    identityReceipt: {
      file: identityReceiptFile,
      sha256: await sha256File(path.join(output, identityReceiptFile)),
    },
    locationProtected: identity.locationProtected === true,
  },
  limitations: [
    "LOCAL_BUILD_AUTHORITY_IS_NOT_A_RELEASE_BUILDER",
    "NO_INDEPENDENT_PROVENANCE_ATTESTATION",
    "NO_ACTIVE_ENDPOINT_SECURITY_JOURNEY",
    "NO_RUNTIME_SIGNATURE_AUTHORITY",
    "NO_WINDOWS_SIGNED_SYSTEM_COMPONENT_LOADER_AUTHORITY",
  ],
  generatedAt: new Date().toISOString(),
};
const provenanceFile = "cuna-native-bridge.provenance.json";
await writeExclusiveJson(path.join(output, provenanceFile), provenance);
const provenanceSha256 = await sha256File(path.join(output, provenanceFile));
const manifest = {
  schema: "cuna.native-bridge-manifest.v1",
  releaseStatus: "local-unsigned",
  protocol: "cuna.native-bridge.v1",
  platform: "win32",
  architecture: process.arch,
  packageVersion: packageJson.version,
  nativeVersion: nativePackage.version,
  fileVersion: identity.version.fileVersion,
  executableFile: binaryFile,
  maximumCredentialBytes: 2_560,
  binarySha256: sourceBinarySha256,
  sbom: { file: sbomFile, sha256: sbomSha256 },
  provenance: { file: provenanceFile, sha256: provenanceSha256 },
  signature: {
    kind: "authenticode",
    publisherCertificateFingerprint: identity.signature?.publisherCertificateFingerprint ?? null,
  },
};
await writeExclusiveJson(path.join(output, "cuna-native-bridge.manifest.json"), manifest);
process.stdout.write(`${JSON.stringify({
  status: "LOCAL_NATIVE_EVIDENCE_GENERATED_NOT_ADMISSIBLE",
  releaseEligible: false,
  binarySha256: sourceBinarySha256,
  sbomSha256,
  provenanceSha256,
})}\n`);

function requiredArgument(name) {
  const value = args.get(name);
  invariant(typeof value === "string" && value.length > 0, `Missing --${name}`);
  return value;
}

function parseCargoLock(text) {
  const result = new Map();
  for (const section of text.split(/\r?\n\[\[package\]\]\r?\n/u).slice(1)) {
    const name = /^name = "([^"]+)"$/mu.exec(section)?.[1];
    const version = /^version = "([^"]+)"$/mu.exec(section)?.[1];
    const checksum = /^checksum = "([0-9a-f]{64})"$/mu.exec(section)?.[1];
    if (name !== undefined && version !== undefined && checksum !== undefined) {
      result.set(`${name}@${version}`, checksum);
    }
  }
  return result;
}

function spdxPackage(entry, index, lockChecksums) {
  const checksum = lockChecksums.get(`${entry.name}@${entry.version}`);
  return {
    name: entry.name,
    SPDXID: `SPDXRef-Package-${index}-${entry.name.replace(/[^A-Za-z0-9.-]/gu, "-")}`,
    versionInfo: entry.version,
    downloadLocation: entry.source?.replace(/^registry\+/u, "") ?? "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: entry.license ?? "NOASSERTION",
    licenseDeclared: entry.license ?? "NOASSERTION",
    copyrightText: "NOASSERTION",
    ...(checksum === undefined ? {} : { checksums: [{ algorithm: "SHA256", checksumValue: checksum }] }),
    externalRefs: [{
      referenceCategory: "PACKAGE-MANAGER",
      referenceType: "purl",
      referenceLocator: `pkg:cargo/${encodeURIComponent(entry.name)}@${encodeURIComponent(entry.version)}`,
    }],
  };
}

async function writeExclusiveJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}
