import { createOwnedTempDirectory, removeOwnedTempDirectory } from "../../scripts/lib/owned-temp.mjs";

export class TestResourceLedger {
  #ownedRoots = [];

  async createTempDirectory(prefix) {
    const root = await createOwnedTempDirectory(prefix);
    this.#ownedRoots.push(root);
    return root;
  }

  async cleanup() {
    const failures = [];
    for (const root of this.#ownedRoots.splice(0).reverse()) {
      try {
        await removeOwnedTempDirectory(root);
      } catch (error) {
        failures.push(new Error(`Could not remove test-owned root ${root}.`, { cause: error }));
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Test resource reconciliation failed.");
  }
}
