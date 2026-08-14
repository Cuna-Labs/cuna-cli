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

test("macOS authority stays closed while retaining audit-bound owned-exchange prerequisites", async () => {
  const macos = await source("native", "cuna-native-authority", "src", "macos.rs");
  const runtimeGate = macos.indexOf("if !owned_exchange_runtime_admitted()");
  const gateZeroize = macos.indexOf("input.request.as_mut().zeroize()", runtimeGate);
  const gateError = macos.indexOf("The macOS owned exchange is runtime-disabled", gateZeroize);
  const secretCopy = macos.indexOf("SecretBytes(input.request.as_ref().to_vec())", runtimeGate);
  const staticCode = macos.indexOf("SecStaticCodeCheckValidityWithErrors(");
  const gatekeeper = macos.indexOf("SecAssessmentCreate(", staticCode);
  const fingerprint = macos.indexOf("leaf_certificate_fingerprint(&static_code)", gatekeeper);
  const spawn = macos.indexOf("libc::posix_spawn(", fingerprint);
  const stopped = macos.indexOf("child.require_stopped()", spawn);
  const instance = macos.indexOf("process_unique_identity(child_pid)", stopped);
  const auditPath = macos.indexOf("process_path_for_audit_token(&audit_token)", instance);
  const dynamicCode = macos.indexOf("dynamic_code_for_process(child_pid, &audit_token)", auditPath);
  const dynamicValidity = macos.indexOf("validate_dynamic_code(&dynamic_code)", dynamicCode);
  const codeDirectory = macos.indexOf("constant_time_equal(&static_unique, &dynamic_unique)", dynamicValidity);
  const resume = macos.indexOf("child.resume()", codeDirectory);
  const protectedInput = macos.indexOf("exchange_io(", resume);
  assert.ok(
    runtimeGate >= 0 && gateZeroize > runtimeGate && gateError > gateZeroize &&
      secretCopy > gateError && spawn > secretCopy &&
      staticCode >= 0 && gatekeeper > staticCode && fingerprint > gatekeeper && spawn > fingerprint &&
      stopped > spawn && instance > stopped && auditPath > instance && dynamicCode > auditPath &&
      dynamicValidity > dynamicCode && codeDirectory > dynamicValidity && resume > codeDirectory &&
      protectedInput > resume,
  );
  assert.match(macos, /const fn owned_exchange_runtime_admitted\(\) -> bool \{\s*false\s*\}/u);
  assert.match(macos, /runtime-disabled until cancellation, descendant containment, and immutable location authority are proven/u);
  assert.match(macos, /CHECK_ALL_ARCHITECTURES \| CHECK_NESTED_CODE \| STRICT_VALIDATE/u);
  assert.match(macos, /kSecAssessmentAssessmentVerdict/u);
  assert.match(macos, /SecCertificateCopyData/u);
  assert.match(macos, /POSIX_SPAWN_START_SUSPENDED/u);
  assert.match(macos, /POSIX_SPAWN_CLOEXEC_DEFAULT/u);
  assert.match(macos, /proc_pidpath_audittoken/u);
  assert.match(macos, /kSecGuestAttributeAudit/u);
  assert.match(macos, /SecCodeCopyGuestWithAttributes/u);
  assert.match(macos, /SecCodeCheckValidityWithErrors/u);
  assert.match(macos, /kSecCodeInfoUnique/u);
  assert.match(macos, /libc::WNOWAIT/u);
  assert.match(macos, /F_SETNOSIGPIPE/u);
  assert.match(macos, /let mut environment: \[\*mut c_char; 1\] = \[null_mut\(\)\]/u);
  assert.match(macos, /terminate_tree_and_verify/u);
  assert.match(macos, /Native descendants remained after cleanup/u);
  assert.match(macos, /location_protected: false/u);
  assert.doesNotMatch(macos, /audit-token-owned process authority is not available/u);
  assert.doesNotMatch(macos, /std::process::Command|Command::new/u);
  assert.doesNotMatch(macos, /Command::new\("codesign"\)/u);
});

test("production never lets a native addon attest the bytes that Node then loads", async () => {
  const production = await source("src", "credentials", "native-production.ts");
  assert.doesNotMatch(production, /function loadAuthorityAddon|createRequire\(import\.meta\.url\)\(file\)/u);
  assert.match(production, /Native authentication is not part of this release/u);
});
