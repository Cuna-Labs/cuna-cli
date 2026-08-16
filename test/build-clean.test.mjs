import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cleanBuildOutput } from "../scripts/clean-build-output.mjs";

test("build cleanup removes stale output and never escapes its repository root", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "runa-build-clean-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const dist = join(root, "dist");
  await mkdir(dist);
  await writeFile(join(dist, "stale-malware-shaped-output.js"), "stale");
  const sentinel = join(root, "sentinel.txt");
  await writeFile(sentinel, "preserve");

  await cleanBuildOutput(root);

  await assert.rejects(access(join(dist, "stale-malware-shaped-output.js")));
  assert.equal(await readFile(sentinel, "utf8"), "preserve");
});
