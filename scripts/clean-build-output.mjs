import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function cleanBuildOutput(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const target = resolve(root, "dist");
  if (dirname(target) !== root || target !== join(root, "dist")) {
    throw new Error("Refusing to clean an output path outside the repository root.");
  }
  await rm(target, { recursive: true, force: true });
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(scriptPath)) {
  const repositoryRoot = resolve(dirname(scriptPath), "..");
  await cleanBuildOutput(repositoryRoot);
}
