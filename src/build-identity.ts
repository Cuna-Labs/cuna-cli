import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageEntries = [
  "LICENSE",
  "NOTICE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
  "dist",
  "node_modules/@xterm/headless",
] as const;

async function collectFiles(relativePath: string): Promise<string[]> {
  const normalizedPath = relativePath.replaceAll(path.sep, "/");
  // The preview credential implementation is deliberately excluded from the
  // public npm payload.  Its development-tree presence must therefore never
  // influence the identity reported by an installed CLI.
  if (normalizedPath.startsWith("dist/credentials/local-session-preview.")) return [];
  const absolutePath = path.join(packageRoot, relativePath);
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Package identity refuses symbolic link ${relativePath}.`);
  }
  if (metadata.isFile()) return [normalizedPath];
  if (!metadata.isDirectory()) {
    throw new Error(`Package identity refuses non-file entry ${relativePath}.`);
  }

  const children = await readdir(absolutePath);
  const nested = await Promise.all(
    children.sort().map((child) => collectFiles(path.join(relativePath, child))),
  );
  return nested.flat();
}

let cachedDigest: Promise<string> | undefined;
let cachedManifest: Promise<PackageBuildManifest> | undefined;

export interface PackageBuildManifestEntry {
  readonly file: string;
  readonly size: number;
  readonly sha256: string;
}

export interface PackageBuildManifest {
  readonly schemaVersion: 1;
  readonly algorithm: "cuna-package-payload-v1";
  readonly fileCount: number;
  readonly files: readonly PackageBuildManifestEntry[];
  readonly sha256: string;
}

export function packageBuildManifest(): Promise<PackageBuildManifest> {
  cachedManifest ??= (async () => {
    const files = (await Promise.all(packageEntries.map(collectFiles))).flat().sort();
    const hash = createHash("sha256");
    const entries: PackageBuildManifestEntry[] = [];
    for (const relativePath of files) {
      const content = await readFile(path.join(packageRoot, relativePath));
      hash.update(relativePath, "utf8");
      hash.update("\0");
      hash.update(String(content.byteLength), "utf8");
      hash.update("\0");
      hash.update(content);
      hash.update("\0");
      entries.push(Object.freeze({
        file: relativePath,
        size: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
      }));
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      algorithm: "cuna-package-payload-v1" as const,
      fileCount: entries.length,
      files: Object.freeze(entries),
      sha256: hash.digest("hex"),
    });
  })();
  return cachedManifest;
}

export function packageBuildDigest(): Promise<string> {
  cachedDigest ??= packageBuildManifest().then((manifest) => manifest.sha256);
  return cachedDigest;
}

// GOAL_0 is deliberately installed from a tarball built on this machine.  npm
// may be the package *tool* used to unpack that tarball, but it is not the
// artifact source and must never be reported as one to the owner.
export const ARTIFACT_CHANNEL = "local" as const;
export const PROTOCOL_RANGE = Object.freeze({ minimum: "1", maximum: "1" });
