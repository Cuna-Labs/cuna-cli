/**
 * Generated only from admitted, signed native release artifacts.
 *
 * An empty index is intentional during source development: Windows and macOS
 * interactive authentication then fail closed instead of trusting a locally
 * built or self-described native package. Release automation replaces this
 * module with candidate-bound entries after signing, notarization, SBOM and
 * provenance verification.
 *
 * Capability status: UNAVAILABLE.
 *
 * The platform packages named by `NativePlatformReleaseEntry["packageName"]`
 * have never been published to the registry. Their sources under
 * `native/packages/` carry a manifest only — no signed `cuna-native-bridge`
 * executable, no `cuna-native-authority.node` addon, no manifest/SBOM/
 * provenance evidence — and no workflow publishes them. The root package
 * therefore declares no optional dependency on them: naming an installable
 * package that the registry cannot serve would break `npm ci` for every
 * consumer while still delivering no native authority.
 *
 * Consequently the native credential and browser authority is unreachable on
 * every platform, and `createProductionNativeAuthBridges` fails closed with
 * `credential_backend_unverified` before any package resolution is attempted.
 * Restoring the capability requires, in one admitted release: signed and
 * notarized platform artifacts, a publish job that ships them from the same
 * release as the root package, the matching `optionalDependencies` and
 * `package-lock.json` entries, and candidate-bound entries in this index.
 * Never populate this index from locally built or unsigned artifacts.
 */
export interface NativePlatformReleaseEntry {
  readonly packageName:
    | "@cuna_labs/cli-native-win32-x64"
    | "@cuna_labs/cli-native-darwin-x64"
    | "@cuna_labs/cli-native-darwin-arm64";
  readonly packageVersion: string;
  readonly platform: "win32" | "darwin";
  readonly architecture: "x64" | "arm64";
  readonly packageJsonSha256: string;
  readonly authorityAddonFile: "cuna-native-authority.node";
  readonly authorityAddonSha256: string;
  readonly manifestSha256: string;
  readonly nativeVersion: string;
  readonly fileVersion: string;
  readonly signature:
    | {
        readonly kind: "authenticode";
        readonly publisherCertificateFingerprint: string;
      }
    | {
        readonly kind: "developer_id_notarized";
        readonly publisherCertificateFingerprint: string;
      };
}

export const NATIVE_PLATFORM_RELEASE_INDEX: readonly NativePlatformReleaseEntry[] = Object.freeze([]);
