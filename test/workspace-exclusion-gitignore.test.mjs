import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// PRD-PM-002 (`prds/product-model/PRD-PM-002-local-folder-resolution.md`) Fact 2 (S3) and S9.
// Every assertion below calls the real product functions from the built
// artifact -- never a reimplementation of the compiler's condition -- so a
// regression in `src/workspace/exclusion.ts` fails exactly these tests.
import { compileExclusionPolicy, createWorkspaceManifest } from "../dist/workspace/index.js";
import { computeWorkspaceManifestRoot } from "../dist/sync/index.js";

const linuxCapabilities = Object.freeze({
  platform: "linux",
  caseSensitive: true,
  unicodeNormalization: "preserving",
  symlinks: true,
  atomicRename: true,
  maximumComponentBytes: 255,
  maximumPathBytes: 4_096,
});

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "runa-exclusion-test-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return directory;
}

function policyFor(text) {
  return compileExclusionPolicy([{ source: "gitignore", text }], linuxCapabilities);
}

// --- Defect 1: the ignore compiler must be gitignore-compatible ------------
//
// Table format: one gitignore ruleset against several (wirePath, kind) probes.
// `wirePath` uses the CLI's internal forward-slash wire representation
// (`src/workspace/paths.ts:25` refuses a leading "/", so no case below starts
// a *path* with "/" -- only *patterns* do, per gitignore's own root anchor).
// Deliberately synthetic component names ("widget_modules", "generated_out")
// rather than the real "node_modules"/"dist" -- both of those now ALSO carry
// an immutable default (defect 2, S9), which runs before any user rule is
// even consulted (`decide()`'s `immutableDecision` short-circuit). Testing
// the compiler itself with real dependency-tree names would pass whether or
// not the compiler fix worked, because the immutable default alone would
// excluded them -- exactly the "test that proves nothing" this task warns
// against. The end-to-end test below uses real `node_modules` on purpose,
// to prove the practical outcome; this table isolates the compiler.
const GITIGNORE_CASES = [
  {
    name: "leading slash anchors to the root and does not match nested occurrences",
    rules: "/widget_modules\n",
    probes: [
      { path: "widget_modules", kind: "directory", excluded: true },
      { path: "packages/api/widget_modules", kind: "directory", excluded: false },
    ],
  },
  {
    name: "trailing slash is directory-only and matches at any depth",
    rules: "widget_modules/\n",
    probes: [
      { path: "widget_modules", kind: "directory", excluded: true },
      { path: "packages/api/widget_modules", kind: "directory", excluded: true },
      // A literal *file* named `widget_modules` is not a directory, so a
      // directory-only pattern must not silently swallow it.
      { path: "widget_modules", kind: "file", excluded: false },
    ],
  },
  {
    name: "a root-level '**/' prefix matches at the root, not only nested",
    rules: "**/widget_modules\n",
    probes: [
      { path: "widget_modules", kind: "directory", excluded: true },
      { path: "src/widget_modules", kind: "directory", excluded: true },
    ],
  },
  {
    name: "a bare pattern with no slash matches at any depth (the one form that already worked)",
    rules: "widget_modules\n",
    probes: [
      { path: "widget_modules", kind: "directory", excluded: true },
      { path: "packages/api/widget_modules", kind: "directory", excluded: true },
    ],
  },
  {
    name: "negation re-includes a specific match against the same policy",
    rules: "*.log\n!important.log\n",
    probes: [
      { path: "debug.log", kind: "file", excluded: true },
      { path: "important.log", kind: "file", excluded: false },
    ],
  },
  {
    name: "trailing '/**' excludes everything inside a directory but not the directory entry itself",
    rules: "generated_out/**\n",
    probes: [
      { path: "generated_out", kind: "directory", excluded: false },
      { path: "generated_out/generated.js", kind: "file", excluded: true },
      { path: "generated_out/nested/generated.js", kind: "file", excluded: true },
    ],
  },
  {
    name: "mid-pattern '**' matches zero or more whole directories",
    rules: "a/**/b\n",
    probes: [
      { path: "a/b", kind: "file", excluded: true },
      { path: "a/x/b", kind: "file", excluded: true },
      { path: "a/x/y/b", kind: "file", excluded: true },
      { path: "a/x/c", kind: "file", excluded: false },
    ],
  },
];

for (const { name, rules, probes } of GITIGNORE_CASES) {
  test(`gitignore compiler: ${name}`, () => {
    const policy = policyFor(rules);
    for (const probe of probes) {
      const decision = policy.decide(probe.path, probe.kind);
      assert.equal(
        decision.excluded,
        probe.excluded,
        `pattern ${JSON.stringify(rules)} against ${probe.path} (${probe.kind}): expected excluded=${probe.excluded}, got ${decision.excluded}`,
      );
    }
  });
}

test("gitignore compiler: a backslash on one line does not invalidate the whole policy", () => {
  // Real gitignore treats '\' as an escape character, not a fatal syntax
  // error. A Windows-authored line such as `generated_out\build` must not
  // blow up every other rule in the same file. `widget_modules` (not the
  // real, immutably-excluded `node_modules`) keeps this test isolated to the
  // compiler, per the note above the GITIGNORE_CASES table.
  const rules = "widget_modules/\ngenerated_out\\build\n";
  assert.doesNotThrow(() => policyFor(rules));
  const policy = policyFor(rules);
  // The other, well-formed rule in the same policy must still take effect.
  assert.equal(policy.decide("widget_modules", "directory").excluded, true);
});

test("gitignore compiler: an escaped leading '!' is a literal pattern, not a negation", () => {
  const policy = policyFor("\\!important\n");
  const decision = policy.decide("!important", "file");
  assert.equal(decision.excluded, true);
});

test("workspace-sync-product-service consequence: a real node_modules/ ignore line now excludes the real tree end-to-end", async (t) => {
  const root = await temporaryDirectory(t);
  await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
  await writeFile(join(root, "node_modules", "left-pad", "index.js"), "module.exports = () => {};\n");
  await writeFile(join(root, "source.ts"), "export const safe = true;\n");
  const policy = policyFor("node_modules/\n");
  const manifest = await createWorkspaceManifest({ root, policy, capabilities: linuxCapabilities });
  const paths = manifest.entries.map((entry) => entry.path);
  assert.deepEqual(paths, ["source.ts"]);
});

test("workspace-sync-product-service.ts:410-416 site: a real on-disk .gitignore with a trailing-slash rule is honored end-to-end", async (t) => {
  // Exercises `computeWorkspaceManifestRoot`, the exact function the PRD
  // names as reading `.gitignore` from disk (`readProjectExclusionPolicy` at
  // workspace-sync-product-service.ts:410-416) -- not just the in-memory
  // compiler. `widget_modules` (not `node_modules`) isolates this from
  // defect 2's immutable default, so this specifically proves the disk-read
  // site now benefits from the fixed trailing-slash compiler behavior.
  const withIgnored = await temporaryDirectory(t);
  await writeFile(join(withIgnored, ".gitignore"), "widget_modules/\n");
  await mkdir(join(withIgnored, "widget_modules", "left-pad"), { recursive: true });
  await writeFile(join(withIgnored, "widget_modules", "left-pad", "index.js"), "module.exports = () => {};\n");
  await writeFile(join(withIgnored, "source.ts"), "export const safe = true;\n");
  const rootWithIgnoredTree = await computeWorkspaceManifestRoot({
    localRoot: withIgnored,
    filesystemCapabilities: linuxCapabilities,
  });

  // Same `.gitignore` file present in both fixtures -- it is itself an
  // ordinary, unexcluded manifest entry, so the *only* difference between
  // the two roots being compared must be the widget_modules tree itself.
  const bare = await temporaryDirectory(t);
  await writeFile(join(bare, ".gitignore"), "widget_modules/\n");
  await writeFile(join(bare, "source.ts"), "export const safe = true;\n");
  const rootWithoutTree = await computeWorkspaceManifestRoot({
    localRoot: bare,
    filesystemCapabilities: linuxCapabilities,
  });

  // If `widget_modules/` had not actually excluded the tree, its content
  // would change the manifest root and this equality would fail.
  assert.equal(rootWithIgnoredTree, rootWithoutTree);
});

// --- Defect 2: defaults that must never depend on the user's ignore file ---

const DEPENDENCY_AND_BUILD_TREES = [
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "target",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".gradle",
  ".terraform",
  "vendor",
];

test("immutable defaults: .git is excluded entirely, not only alongside 'credentials'", () => {
  const policy = compileExclusionPolicy([], linuxCapabilities);
  const asDirectory = policy.decide(".git", "directory");
  assert.equal(asDirectory.excluded, true);
  assert.equal(asDirectory.immutable, true);
  const objectFile = policy.decide(".git/objects/pack/pack-abc.pack", "file");
  assert.equal(objectFile.excluded, true);
  assert.equal(objectFile.immutable, true);
  // Worktrees represent `.git` as a *file*, not a directory (PRD S6). The
  // exclusion must not depend on it being a directory.
  const asFile = policy.decide(".git", "file");
  assert.equal(asFile.excluded, true);
  assert.equal(asFile.immutable, true);
});

test("immutable defaults: .git exclusion is an exact component match, not a substring match", () => {
  const policy = compileExclusionPolicy([], linuxCapabilities);
  assert.equal(policy.decide("legit", "directory").excluded, false);
  assert.equal(policy.decide("gitbook", "directory").excluded, false);
  assert.equal(policy.decide("src/gitconfig.ts", "file").excluded, false);
});

for (const component of DEPENDENCY_AND_BUILD_TREES) {
  test(`immutable defaults: '${component}' is excluded with no ignore file present`, () => {
    const policy = compileExclusionPolicy([], linuxCapabilities);
    const rootLevel = policy.decide(component, "directory");
    assert.equal(rootLevel.excluded, true, `${component} at root must be immutably excluded`);
    assert.equal(rootLevel.immutable, true, `${component} at root must be marked immutable, not a user rule`);
    const nested = policy.decide(`packages/api/${component}`, "directory");
    assert.equal(nested.excluded, true, `${component} nested must be immutably excluded`);
  });
}

test("immutable defaults: node_modules and .git are excluded end-to-end with zero rule sources at all", async (t) => {
  const root = await temporaryDirectory(t);
  await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
  await writeFile(join(root, "node_modules", "left-pad", "index.js"), "module.exports = () => {};\n");
  await mkdir(join(root, ".git", "objects"), { recursive: true });
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  await mkdir(join(root, "vendor"), { recursive: true });
  await writeFile(join(root, "vendor", "lib.go"), "package vendor\n");
  await writeFile(join(root, "source.ts"), "export const safe = true;\n");
  // No .gitignore, no .cunaignore: nothing here depends on a user rule.
  const policy = compileExclusionPolicy([], linuxCapabilities);
  const manifest = await createWorkspaceManifest({ root, policy, capabilities: linuxCapabilities });
  const paths = manifest.entries.map((entry) => entry.path);
  assert.deepEqual(paths, ["source.ts"]);
});

test("immutable defaults negative control: an ordinary source directory is not swept up by the new defaults", () => {
  const policy = compileExclusionPolicy([], linuxCapabilities);
  assert.equal(policy.decide("src", "directory").excluded, false);
  assert.equal(policy.decide("src/lib.ts", "file").excluded, false);
  // 'distribution-notes.md' shares a prefix with 'dist' but is a different
  // component entirely -- the check must be exact, not a prefix match.
  assert.equal(policy.decide("distribution-notes.md", "file").excluded, false);
});
