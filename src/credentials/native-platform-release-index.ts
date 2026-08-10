/**
 * Generated only from admitted, signed native release artifacts.
 *
 * An empty index is intentional during source development: Windows and macOS
 * interactive authentication then fail closed instead of trusting a locally
 * built or self-described native package. Release automation replaces this
 * module with candidate-bound entries after signing, notarization, SBOM and
 * provenance verification.
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
