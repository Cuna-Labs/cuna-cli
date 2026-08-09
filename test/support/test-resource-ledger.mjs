import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export class TestResourceLedger {
  #ownedRoots = [];

  async createTempDirectory(prefix) {
    if (!/^runa-[a-z0-9-]+-$/u.test(prefix)) {
      throw new Error("Test temp prefixes must be explicit Runa-owned identities.");
    }
    const base = path.resolve(tmpdir());
    const root = path.resolve(await mkdtemp(path.join(base, prefix)));
    if (path.dirname(root) !== base) throw new Error("Test temp root escaped the operating-system temp directory.");
    this.#ownedRoots.push(root);
    return root;
  }

  async cleanup() {
    const failures = [];
    for (const root of this.#ownedRoots.splice(0).reverse()) {
      try {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (error) {
        failures.push(new Error(`Could not remove test-owned root ${root}.`, { cause: error }));
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Test resource reconciliation failed.");
  }
}
