import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageEntries = [
  "LICENSE",
  "NOTICE",
  "README.md",
  "package.json",
  "dist",
  "node_modules/@xterm/headless",
] as const;

async function collectFiles(relativePath: string): Promise<string[]> {
  const absolutePath = path.join(packageRoot, relativePath);
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Package identity refuses symbolic link ${relativePath}.`);
  }
  if (metadata.isFile()) return [relativePath.replaceAll(path.sep, "/")];
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

export function packageBuildDigest(): Promise<string> {
  cachedDigest ??= (async () => {
    const files = (await Promise.all(packageEntries.map(collectFiles))).flat().sort();
    const hash = createHash("sha256");
    for (const relativePath of files) {
      const content = await readFile(path.join(packageRoot, relativePath));
      hash.update(relativePath, "utf8");
      hash.update("\0");
      hash.update(String(content.byteLength), "utf8");
      hash.update("\0");
      hash.update(content);
      hash.update("\0");
    }
    return hash.digest("hex");
  })();
  return cachedDigest;
}

export const UPDATE_CHANNEL = "npm" as const;
export const PROTOCOL_RANGE = Object.freeze({ minimum: "1", maximum: "1" });
