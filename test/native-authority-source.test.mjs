import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

async function source(...segments) {
  return readFile(path.join(root, ...segments), "utf8");
}

test("native authority is a private Node-API workspace crate, never a fabricated package artifact", async () => {
  const [workspace, crate, build] = await Promise.all([
    source("native", "Cargo.toml"),
    source("native", "cuna-native-authority", "Cargo.toml"),
    source("native", "cuna-native-authority", "build.rs"),
  ]);
  assert.match(workspace, /members = \["cuna-native-authority", "cuna-native-bridge"\]/u);
  assert.match(crate, /publish = false/u);
  assert.match(crate, /crate-type = \["cdylib"\]/u);
  assert.match(crate, /napi = \{ version = "=3\.12\.1"/u);
  assert.match(crate, /napi-build = "=2\.4\.1"/u);
  assert.match(build, /napi_build::setup\(\)/u);
});

test("Windows authority owns a suspended process and verifies its live identity before protected stdin", async () => {
  const windows = await source("native", "cuna-native-authority", "src", "windows.rs");
  const create = windows.indexOf("CreateProcessW(");
  const livePath = windows.indexOf("process_image_path(process.raw())", create);
  const signature = windows.indexOf("authenticode_fingerprint(&loaded_executable)", livePath);
  const resume = windows.indexOf("ResumeThread(thread_handle.raw())", signature);
  const protectedInput = windows.indexOf("write_all(parent_stdin.raw()", resume);
  assert.ok(create >= 0 && livePath > create && signature > livePath && resume > signature && protectedInput > resume);
  assert.match(windows, /CREATE_SUSPENDED/u);
  assert.match(windows, /PROC_THREAD_ATTRIBUTE_HANDLE_LIST/u);
  assert.match(windows, /FILE_SHARE_READ/u);
  assert.match(windows, /GetFileInformationByHandle/u);
  assert.match(windows, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/u);
  assert.match(windows, /AssignProcessToJobObject/u);
  assert.match(windows, /TerminateJobObject/u);
  assert.match(windows, /QueryFullProcessImageNameW/u);
  assert.match(windows, /GetProcessTimes/u);
  assert.match(windows, /WinVerifyTrust/u);
});

test("macOS source remains explicitly unavailable until direct code-sign and audit-token authority exists", async () => {
  const macos = await source("native", "cuna-native-authority", "src", "macos.rs");
  assert.match(macos, /Security\.framework validation/u);
  assert.match(macos, /audit-token-bound process instance/u);
  assert.match(macos, /not available in this source build/u);
  assert.doesNotMatch(macos, /Command::new\("codesign"\)/u);
});

test("production never lets a native addon attest the bytes that Node then loads", async () => {
  const production = await source("src", "credentials", "native-production.ts");
  assert.doesNotMatch(production, /function loadAuthorityAddon|createRequire\(import\.meta\.url\)\(file\)/u);
  assert.match(production, /signed native module loader authority is not admitted/u);
  assert.match(production, /substitute the addon between admission and LoadLibrary/u);
});
