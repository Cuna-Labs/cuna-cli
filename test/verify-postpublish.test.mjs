import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { verifyPublishedRegistry } from "../scripts/verify-postpublish.mjs";

const publishedBytes = Buffer.from("exact admitted candidate bytes");
const publishedDigest = createHash("sha256").update(publishedBytes).digest("hex");
const envelope = {
  schemaVersion: 2,
  packageName: "@cuna_labs/cli",
  version: "1.2.3-preview.1",
  sourceCommit: "b".repeat(40),
  repository: "Cuna-Labs/cuna-cli",
  registry: "https://registry.npmjs.org",
  tarball: {
    file: "cuna.tgz",
    url: "https://registry.npmjs.org/@cuna_labs/cli/-/cli-1.2.3-preview.1.tgz",
    sha256: publishedDigest,
    size: publishedBytes.length,
  },
  sbom: { file: "sbom.json", sha256: "b".repeat(64) },
  supportPolicy: { file: "support.json", sha256: "c".repeat(64) },
  releaseInputs: { file: "release-inputs.json", sha256: "d".repeat(64) },
  identities: {
    lockfileSha256: "e".repeat(64),
    dependencyClosureSha256: "f".repeat(64),
    contractSha256: "a".repeat(64),
    buildRecipeSha256: "b".repeat(64),
    toolchainSha256: "c".repeat(64),
    payloadSha256: "d".repeat(64),
    payloadFileCount: 1,
  },
  authority: {
    phase: "CANDIDATE_BUILT",
    releaseEligible: false,
    approval: { state: "REQUIRED_NOT_PRESENT", environment: "npm", receiptSha256: null },
    provenance: { state: "REQUIRED_NOT_PRESENT", workflow: ".github/workflows/ci.yml", receiptSha256: null },
  },
  builder: { workflow: ".github/workflows/ci.yml", runId: "123", runAttempt: "1" },
};

function clock() {
  let elapsed = 0;
  return {
    now: () => elapsed,
    sleep: async (milliseconds) => { elapsed += milliseconds; },
  };
}

test("postpublish verification waits for package visibility and a lagging tag without republishing", async () => {
  const calls = [];
  const destinations = [];
  let packCount = 0;
  let viewCount = 0;
  const receipt = await verifyPublishedRegistry(envelope, "preview", {
    ...clock(),
    propagationDeadlineMs: 10_000,
    execute: async (command, args) => {
      assert.equal(command, "npm");
      calls.push(args[0]);
      if (args[0] === "pack") {
        packCount += 1;
        const destination = args[args.indexOf("--pack-destination") + 1];
        destinations.push(destination);
        if (packCount === 1) throw Object.assign(new Error("not yet visible"), { stderr: "npm error code E404" });
        await writeFile(path.join(destination, "cli-1.2.3-preview.1.tgz"), publishedBytes);
        return { stdout: "" };
      }
      assert.equal(args[0], "view");
      viewCount += 1;
      return { stdout: JSON.stringify(viewCount === 1 ? "1.2.2" : envelope.version) };
    },
  });
  assert.deepEqual(calls, ["pack", "pack", "view", "view"]);
  assert.equal(receipt.status, "REGISTRY_BYTES_VERIFIED");
  assert.equal(receipt.sha256, publishedDigest);
  for (const destination of destinations) await assert.rejects(access(destination), { code: "ENOENT" });
});

test("postpublish verification retries npm ETARGET for the exact version until its bytes appear", async () => {
  let packCount = 0;
  let viewCount = 0;
  const receipt = await verifyPublishedRegistry(envelope, "preview", {
    ...clock(),
    propagationDeadlineMs: 10_000,
    execute: async (_command, args) => {
      if (args[0] === "pack") {
        packCount += 1;
        if (packCount === 1) {
          throw Object.assign(new Error("npm pack failed"), {
            stderr: `npm error code ETARGET\nnpm error notarget No matching version found for ${envelope.packageName}@${envelope.version}.`,
          });
        }
        const destination = args[args.indexOf("--pack-destination") + 1];
        await writeFile(path.join(destination, "cli-1.2.3-preview.1.tgz"), publishedBytes);
        return { stdout: "" };
      }
      assert.equal(args[0], "view");
      viewCount += 1;
      return { stdout: JSON.stringify(envelope.version) };
    },
  });
  assert.equal(packCount, 2);
  assert.equal(viewCount, 1);
  assert.equal(receipt.sha256, publishedDigest);
});

test("postpublish verification does not retry ETARGET for a different version", async () => {
  let attempts = 0;
  await assert.rejects(verifyPublishedRegistry(envelope, "preview", {
    ...clock(),
    propagationDeadlineMs: 10_000,
    execute: async () => {
      attempts += 1;
      throw Object.assign(new Error("npm pack failed"), {
        stderr: "npm error code ETARGET\nnpm error notarget No matching version found for @cuna_labs/cli@9.9.9.",
      });
    },
  }), /npm pack failed/u);
  assert.equal(attempts, 1);
});

test("postpublish verification does not retry a prefix-colliding ETARGET version", async () => {
  let attempts = 0;
  await assert.rejects(verifyPublishedRegistry(envelope, "preview", {
    ...clock(),
    propagationDeadlineMs: 2_500,
    execute: async () => {
      attempts += 1;
      throw Object.assign(new Error("npm pack failed"), {
        stderr: "npm error code ETARGET\nnpm error notarget No matching version found for @cuna_labs/cli@1.2.3-preview.10.",
      });
    },
  }), /npm pack failed/u);
  assert.equal(attempts, 1);
});

test("postpublish verification ends with an uncertain outcome after a bounded propagation window", async () => {
  let attempts = 0;
  await assert.rejects(verifyPublishedRegistry(envelope, "preview", {
    ...clock(),
    propagationDeadlineMs: 2_500,
    execute: async (_command, args) => {
      assert.equal(args[0], "pack");
      attempts += 1;
      throw Object.assign(new Error("not yet visible"), { stderr: "npm error code E404" });
    },
  }), /Publication outcome requires reconciliation.*do not publish again blindly/u);
  assert.equal(attempts, 2);
});

test("postpublish verification stops on candidate-byte mismatch without retry", async () => {
  let attempts = 0;
  await assert.rejects(verifyPublishedRegistry(envelope, "preview", {
    ...clock(),
    propagationDeadlineMs: 10_000,
    execute: async (_command, args) => {
      attempts += 1;
      assert.equal(args[0], "pack");
      const destination = args[args.indexOf("--pack-destination") + 1];
      await writeFile(path.join(destination, "cli-1.2.3-preview.1.tgz"), "different bytes");
      return { stdout: "" };
    },
  }), /Registry tarball differs from admitted candidate bytes/u);
  assert.equal(attempts, 1);
});

test("postpublish verification stops on a permanent registry rejection", async () => {
  let attempts = 0;
  await assert.rejects(verifyPublishedRegistry(envelope, "preview", {
    ...clock(),
    propagationDeadlineMs: 10_000,
    execute: async () => {
      attempts += 1;
      throw Object.assign(new Error("not authorized"), { stderr: "npm error code E403" });
    },
  }), /not authorized/u);
  assert.equal(attempts, 1);
});
