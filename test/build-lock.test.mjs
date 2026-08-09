import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  acquireExclusiveBuildLock,
  buildLockIdentity,
  buildLockEndpoint,
  BuildLockError,
} from "../scripts/lib/exclusive-build-lock.mjs";

function uniqueRoot(label) {
  return join(tmpdir(), `runa-build-lock-${label}-${process.pid}-${Date.now()}-${Math.random()}`);
}

function listen(server, endpoint) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolveListen);
  });
}

function close(server) {
  return new Promise((resolveClose, reject) => server.close((error) => error === undefined ? resolveClose() : reject(error)));
}

test("overlapping build consumers serialize for the complete critical section", async () => {
  const root = uniqueRoot("serialize");
  const first = await acquireExclusiveBuildLock(root, { timeoutMs: 2_000 });
  let secondEntered = false;
  const secondPromise = acquireExclusiveBuildLock(root, { timeoutMs: 2_000 }).then((lock) => {
    secondEntered = true;
    return lock;
  });

  await new Promise((resolveWait) => setTimeout(resolveWait, 75));
  assert.equal(secondEntered, false);
  await first.release();
  const second = await secondPromise;
  assert.equal(secondEntered, true);
  await second.release();
});

test("lock wait is bounded and cannot evict a live owner", async () => {
  const root = uniqueRoot("timeout");
  const first = await acquireExclusiveBuildLock(root, { timeoutMs: 2_000 });
  await assert.rejects(
    acquireExclusiveBuildLock(root, { timeoutMs: 60 }),
    (error) => error instanceof BuildLockError && error.code === "build_lock_timeout",
  );

  let thirdEntered = false;
  const thirdPromise = acquireExclusiveBuildLock(root, { timeoutMs: 2_000 }).then((lock) => {
    thirdEntered = true;
    return lock;
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  assert.equal(thirdEntered, false);
  await first.release();
  const third = await thirdPromise;
  await third.release();
});

test("foreign endpoint identity fails closed without cleanup or takeover", async () => {
  const root = uniqueRoot("collision");
  const endpoint = buildLockEndpoint(root);
  const foreign = createServer((socket) => socket.end("NOT_RUNA_BUILD_LOCK\n"));
  await listen(foreign, endpoint);
  try {
    await assert.rejects(
      acquireExclusiveBuildLock(root, { timeoutMs: 500 }),
      (error) => error instanceof BuildLockError && error.code === "build_lock_collision",
    );
    assert.equal(foreign.listening, true);
  } finally {
    await close(foreign);
  }
});

test("physical checkout aliases share one build-lock identity", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "runa-build-lock-alias-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  const alias = join(root, "repository-alias");
  await mkdir(repository);
  await symlink(repository, alias, process.platform === "win32" ? "junction" : "dir");

  assert.equal(buildLockIdentity(alias), buildLockIdentity(repository));
  assert.deepEqual(buildLockEndpoint(alias), buildLockEndpoint(repository));

  const owner = await acquireExclusiveBuildLock(repository, { timeoutMs: 2_000 });
  try {
    await assert.rejects(
      acquireExclusiveBuildLock(alias, { timeoutMs: 60 }),
      (error) => error instanceof BuildLockError && error.code === "build_lock_timeout",
    );
  } finally {
    await owner.release();
  }
});

test("an owner crash releases the kernel lock without PID-based stale cleanup", async (context) => {
  const root = uniqueRoot("crash");
  const moduleUrl = new URL("../scripts/lib/exclusive-build-lock.mjs", import.meta.url).href;
  const source = [
    `const { acquireExclusiveBuildLock } = await import(${JSON.stringify(moduleUrl)});`,
    "await acquireExclusiveBuildLock(process.argv[1], { timeoutMs: 2000 });",
    "process.stdout.write('LOCKED\\n');",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source, root], {
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  context.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const [ready] = await once(child.stdout, "data");
  assert.equal(String(ready), "LOCKED\n");

  child.kill("SIGKILL");
  await once(child, "close");
  const replacement = await acquireExclusiveBuildLock(root, { timeoutMs: 2_000 });
  await replacement.release();
});
