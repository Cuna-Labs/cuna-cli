import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { compileExclusionPolicy } from "../dist/workspace/index.js";

// The Machine evaluates this CLI's exclusion policy itself when it captures a
// workspace (infra edge/assets/agent-session-supervisor.py,
// WorkspaceExclusionPolicy), and proves it has the same policy by recomputing
// its digest. Both sides are held to one file: this copy of the infra fixture
// edge/test/fixtures/cli-exclusion-policy-vectors.json (sha256 58c6ec98…).
// A change to the policy here that this test catches needs the vectors
// regenerated and the Machine's port changed with them; otherwise the Machine
// skips other paths than this folder does, and a skipped path the folder holds
// reads as a deletion (BL-7, 2026-10-03).

const vectors = JSON.parse(await readFile(new URL("./fixtures/guest-exclusion-policy-vectors.json", import.meta.url), "utf8"));

// A vector holds file contents; read them as readPolicyFile does, which
// strips one leading byte-order mark.
function fileText(content) {
  return content === null ? "" : new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(content, "utf8"));
}

function sources(vector) {
  return [
    { source: "gitignore", text: fileText(vector.gitignore) },
    { source: "cunaignore", text: fileText(vector.cunaignore) },
  ];
}

test("this CLI reproduces every policy digest and decision the Machine's port is held to", () => {
  assert.ok(vectors.policies.length >= 15);
  for (const vector of vectors.policies) {
    const policy = compileExclusionPolicy(sources(vector), vectors.capabilities);
    assert.equal(policy.digest, vector.digest, vector.name);
    assert.equal(policy.ruleCount, vector.rule_count, vector.name);
    for (const [path, kind, excluded] of vector.decisions) {
      assert.equal(policy.decide(path, kind).excluded, excluded, `${vector.name}: ${kind} ${JSON.stringify(path)}`);
    }
  }
});

test("this CLI refuses every policy the Machine's port refuses, with the same reason", () => {
  for (const vector of vectors.invalid) {
    assert.throws(() => compileExclusionPolicy(sources(vector), vectors.capabilities),
      (error) => error.code === vector.code && error.details?.reason === vector.reason, vector.name);
  }
});

test("the BL-7 policy pair has the digest the Machine proves it by", () => {
  const policy = compileExclusionPolicy(sources(vectors.bl7), vectors.capabilities);
  assert.equal(policy.digest, vectors.bl7.digest);
});
