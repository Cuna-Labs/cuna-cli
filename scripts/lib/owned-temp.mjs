import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function createOwnedTempDirectory(prefix) {
  if (!/^cuna-[a-z0-9-]+-$/u.test(prefix)) {
    throw new Error("Temporary prefixes must be explicit Cuna-owned identities.");
  }
  const base = path.resolve(tmpdir());
  const root = path.resolve(await mkdtemp(path.join(base, prefix)));
  if (path.dirname(root) !== base) throw new Error("Temporary root escaped the operating-system temp directory.");
  return root;
}

export async function removeOwnedTempDirectory(root) {
  const base = path.resolve(tmpdir());
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== base || !/^cuna-/u.test(path.basename(resolved))) {
    throw new Error("Refusing to remove a directory that is not an exact Cuna-owned temp root.");
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

export async function withOwnedTempDirectory(prefix, action, options = {}) {
  const root = await createOwnedTempDirectory(prefix);
  let result;
  let primaryFailure;
  try {
    result = await action(root);
  } catch (error) {
    primaryFailure = error;
  }
  const cleanupFailures = [];
  if (options.beforeRemove !== undefined) {
    try { await options.beforeRemove(root); } catch (error) { cleanupFailures.push(error); }
  }
  try { await removeOwnedTempDirectory(root); } catch (error) { cleanupFailures.push(error); }
  if (primaryFailure !== undefined && cleanupFailures.length > 0) {
    throw new AggregateError([primaryFailure, ...cleanupFailures], "Operation and temporary-resource cleanup both failed.");
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, "Temporary-resource cleanup failed.");
  return result;
}
