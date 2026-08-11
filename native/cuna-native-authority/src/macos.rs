use std::ffi::{CStr, CString, c_char, c_int, c_short, c_void};
use std::fmt::Write as _;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::mem::{size_of, zeroed};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};

use napi::Result;
use napi::bindgen_prelude::Buffer;
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::{
    ExchangeInput, ExchangeResult, ProcessObservation, SignatureInput, SignatureObservation,
    invalid, unavailable,
};

type CfIndex = isize;
type CfTypeId = usize;
type CfTypeRef = *const c_void;
type CfAllocatorRef = *const c_void;
type CfArrayRef = *const c_void;
type CfBooleanRef = *const c_void;
type CfDataRef = *const c_void;
type CfDictionaryRef = *const c_void;
type CfNumberRef = *const c_void;
type CfStringRef = *const c_void;
type CfUrlRef = *const c_void;
type OsStatus = i32;
type SecCsFlags = u32;
type SecCodeRef = *const c_void;
type SecStaticCodeRef = *const c_void;
type SecAssessmentRef = *const c_void;

const ERR_SEC_SUCCESS: OsStatus = 0;
const CHECK_ALL_ARCHITECTURES: SecCsFlags = 1 << 0;
const CHECK_NESTED_CODE: SecCsFlags = 1 << 4;
const STRICT_VALIDATE: SecCsFlags = 1 << 5;
const SIGNING_INFORMATION: SecCsFlags = 1 << 1;
const MAXIMUM_BINARY_BYTES: u64 = 32 * 1024 * 1024;
const POSIX_SPAWN_SETSIGDEF: c_short = 0x0004;
const POSIX_SPAWN_SETSIGMASK: c_short = 0x0008;
const POSIX_SPAWN_SETPGROUP: c_short = 0x0002;
const POSIX_SPAWN_START_SUSPENDED: c_short = 0x0080;
const POSIX_SPAWN_CLOEXEC_DEFAULT: c_short = 0x4000;
const PROC_PIDUNIQIDENTIFIERINFO: c_int = 17;
const F_SETNOSIGPIPE: c_int = 73;
const CF_NUMBER_SINT32_TYPE: c_int = 3;
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
const IO_POLL_SLICE_MS: c_int = 25;
const PROCESS_PATH_CAPACITY: usize = 4_096;

// This source contains the direct macOS process/audit/signing prerequisite, but the public
// synchronous N-API contract cannot yet carry cancellation, a process group cannot contain a
// deliberately escaping descendant, and immutable package-root authority is not yet available.
// Keep the exchange unreachable before any secret copy or process creation until all three
// obligations are implemented and proven by macOS runtime tests.
const fn owned_exchange_runtime_admitted() -> bool {
    false
}

#[repr(C)]
struct CfDictionaryKeyCallBacks {
    version: CfIndex,
    retain: *const c_void,
    release: *const c_void,
    copy_description: *const c_void,
    equal: *const c_void,
    hash: *const c_void,
}

#[repr(C)]
struct CfDictionaryValueCallBacks {
    version: CfIndex,
    retain: *const c_void,
    release: *const c_void,
    copy_description: *const c_void,
    equal: *const c_void,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct AuditToken {
    values: [u32; 8],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct ProcessUniqueIdentifierInfo {
    executable_uuid: [u8; 16],
    unique_id: u64,
    parent_unique_id: u64,
    id_version: i32,
    original_parent_id_version: i32,
    reserved_2: u64,
    reserved_3: u64,
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFTypeDictionaryKeyCallBacks: CfDictionaryKeyCallBacks;
    static kCFTypeDictionaryValueCallBacks: CfDictionaryValueCallBacks;

    fn CFArrayGetCount(array: CfArrayRef) -> CfIndex;
    fn CFArrayGetValueAtIndex(array: CfArrayRef, index: CfIndex) -> CfTypeRef;
    fn CFBooleanGetValue(value: CfBooleanRef) -> u8;
    fn CFDataGetBytePtr(data: CfDataRef) -> *const u8;
    fn CFDataGetLength(data: CfDataRef) -> CfIndex;
    fn CFDictionaryGetValue(dictionary: CfDictionaryRef, key: *const c_void) -> *const c_void;
    fn CFGetTypeID(value: CfTypeRef) -> CfTypeId;
    fn CFArrayGetTypeID() -> CfTypeId;
    fn CFBooleanGetTypeID() -> CfTypeId;
    fn CFDataGetTypeID() -> CfTypeId;
    fn CFDataCreate(allocator: CfAllocatorRef, bytes: *const u8, length: CfIndex) -> CfDataRef;
    fn CFDictionaryCreate(
        allocator: CfAllocatorRef,
        keys: *const CfTypeRef,
        values: *const CfTypeRef,
        count: CfIndex,
        key_callbacks: *const CfDictionaryKeyCallBacks,
        value_callbacks: *const CfDictionaryValueCallBacks,
    ) -> CfDictionaryRef;
    fn CFRelease(value: CfTypeRef);
    fn CFNumberCreate(
        allocator: CfAllocatorRef,
        number_type: c_int,
        value: *const c_void,
    ) -> CfNumberRef;
    fn CFURLCreateFromFileSystemRepresentation(
        allocator: CfAllocatorRef,
        bytes: *const u8,
        length: CfIndex,
        is_directory: u8,
    ) -> CfUrlRef;
}

#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    static kSecCodeInfoCertificates: CfStringRef;
    static kSecCodeInfoUnique: CfStringRef;
    static kSecAssessmentAssessmentVerdict: CfStringRef;
    static kSecGuestAttributeAudit: CfStringRef;
    static kSecGuestAttributePid: CfStringRef;

    fn SecStaticCodeCreateWithPath(
        path: CfUrlRef,
        flags: SecCsFlags,
        code: *mut SecStaticCodeRef,
    ) -> OsStatus;
    fn SecStaticCodeCheckValidityWithErrors(
        code: SecStaticCodeRef,
        flags: SecCsFlags,
        requirement: CfTypeRef,
        errors: *mut CfTypeRef,
    ) -> OsStatus;
    fn SecCodeCopySigningInformation(
        code: CfTypeRef,
        flags: SecCsFlags,
        information: *mut CfDictionaryRef,
    ) -> OsStatus;
    fn SecCodeCopyGuestWithAttributes(
        host: SecCodeRef,
        attributes: CfDictionaryRef,
        flags: SecCsFlags,
        guest: *mut SecCodeRef,
    ) -> OsStatus;
    fn SecCodeCheckValidityWithErrors(
        code: SecCodeRef,
        flags: SecCsFlags,
        requirement: CfTypeRef,
        errors: *mut CfTypeRef,
    ) -> OsStatus;
    fn SecCertificateCopyData(certificate: CfTypeRef) -> CfDataRef;
    fn SecAssessmentCreate(
        path: CfUrlRef,
        flags: u64,
        context: CfDictionaryRef,
        errors: *mut CfTypeRef,
    ) -> SecAssessmentRef;
    fn SecAssessmentCopyResult(
        assessment: SecAssessmentRef,
        flags: u64,
        errors: *mut CfTypeRef,
    ) -> CfDictionaryRef;
}

unsafe extern "C" {
    fn posix_spawn_file_actions_addchdir_np(
        actions: *mut libc::posix_spawn_file_actions_t,
        path: *const c_char,
    ) -> c_int;
    fn proc_pidpath_audittoken(
        token: *const AuditToken,
        buffer: *mut c_void,
        buffer_size: u32,
    ) -> c_int;
}

struct OwnedCf(CfTypeRef);

impl OwnedCf {
    fn new(value: CfTypeRef, reason: &str) -> Result<Self> {
        if value.is_null() {
            Err(unavailable(reason))
        } else {
            Ok(Self(value))
        }
    }

    const fn get(&self) -> CfTypeRef {
        self.0
    }

    fn data(bytes: &[u8]) -> Result<Self> {
        let length = CfIndex::try_from(bytes.len())
            .map_err(|_| unavailable("The native identity data is too large."))?;
        // SAFETY: bytes remains live while CoreFoundation copies it.
        let value = unsafe { CFDataCreate(null(), bytes.as_ptr(), length) };
        Self::new(value, "The native identity data could not be created.")
    }

    fn number_i32(value: i32) -> Result<Self> {
        // SAFETY: value remains live while CoreFoundation copies the fixed-width integer.
        let number = unsafe {
            CFNumberCreate(
                null(),
                CF_NUMBER_SINT32_TYPE,
                (&raw const value).cast::<c_void>(),
            )
        };
        Self::new(number, "The native PID selector could not be created.")
    }
}

impl Drop for OwnedCf {
    fn drop(&mut self) {
        // SAFETY: every OwnedCf contains one +1 CoreFoundation/Security reference.
        unsafe { CFRelease(self.0) };
    }
}

pub fn verify_signature(input: &SignatureInput) -> Result<SignatureObservation> {
    if input.platform != "darwin" || input.architecture != current_architecture() {
        return Err(invalid(
            "The requested signature platform does not match this addon.",
        ));
    }
    let url = file_url(&input.executable)?;
    let code = static_code(&url)?;
    validate_code_signature(&code)?;
    validate_gatekeeper_assessment(&url)?;
    let publisher_certificate_fingerprint = leaf_certificate_fingerprint(&code)?;
    let binary_sha256 = file_sha256(&input.executable)?;

    Ok(SignatureObservation {
        valid: true,
        // Runtime package-root mutability must be proven by the signed loader/installer. A valid
        // Developer ID signature and Gatekeeper verdict do not make a user-writable path safe.
        location_protected: false,
        binary_sha256,
        // The bridge's Mach-O version is release-bound by the native package manifest. It cannot
        // become admissible while location_protected is false, so source builds expose no trust.
        file_version: format!("{}.0", env!("CARGO_PKG_VERSION")),
        kind: "developer_id_notarized".to_owned(),
        publisher_certificate_fingerprint,
    })
}

pub fn exchange(mut input: ExchangeInput) -> Result<ExchangeResult> {
    exchange_owned(&mut input)
}

#[allow(clippy::too_many_lines)]
fn exchange_owned(input: &mut ExchangeInput) -> Result<ExchangeResult> {
    if input.expected.platform != "darwin"
        || input.expected.architecture != current_architecture()
        || input.expected.signature.kind != "developer_id_notarized"
    {
        input.request.as_mut().zeroize();
        return Err(invalid("The expected macOS authority identity is invalid."));
    }

    if !owned_exchange_runtime_admitted() {
        input.request.as_mut().zeroize();
        return Err(unavailable(
            "The macOS owned exchange is runtime-disabled until cancellation, descendant containment, and immutable location authority are proven.",
        ));
    }

    let protected_request = SecretBytes(input.request.as_ref().to_vec());
    input.request.as_mut().zeroize();

    // Keep the admitted file descriptor open for the complete exchange. A descriptor cannot stop
    // an untrusted writable directory from replacing a pathname, which is why package-root
    // immutability remains a separate release admission obligation. It does give this exchange a
    // stable inode/hash to compare with the live process path in addition to Code Signing's
    // kernel-bound dynamic identity.
    let admitted_file = open_admitted_executable(&input.expected.executable)?;
    let admitted_identity = file_identity(&admitted_file)?;
    let binary_sha256 = file_sha256_handle(&admitted_file)?;
    if binary_sha256 != input.expected.binary_sha256 {
        return Err(unavailable(
            "The admitted native executable digest differs from the release descriptor.",
        ));
    }
    let url = file_url(&input.expected.executable)?;
    let static_code = static_code(&url)?;
    validate_code_signature(&static_code)?;
    validate_gatekeeper_assessment(&url)?;
    let static_fingerprint = leaf_certificate_fingerprint(&static_code)?;
    if static_fingerprint != input.expected.signature.publisher_certificate_fingerprint {
        return Err(unavailable(
            "The admitted native signing certificate differs from the release descriptor.",
        ));
    }
    let mut static_unique = code_unique_identity(&static_code)?;

    let (child_stdin, parent_stdin) = pipe_pair()?;
    let (parent_stdout, child_stdout) = pipe_pair()?;
    let (parent_stderr, child_stderr) = pipe_pair()?;
    set_nonblocking(parent_stdin.as_raw_fd())?;
    set_nonblocking(parent_stdout.as_raw_fd())?;
    set_nonblocking(parent_stderr.as_raw_fd())?;
    set_no_sigpipe(parent_stdin.as_raw_fd())?;

    let executable = c_string(&input.expected.executable, "native executable")?;
    let working_directory = c_string(&input.expected.working_directory, "working directory")?;
    let mut actions = OwnedSpawnActions::new()?;
    actions.add_dup2(child_stdin.as_raw_fd(), libc::STDIN_FILENO)?;
    actions.add_dup2(child_stdout.as_raw_fd(), libc::STDOUT_FILENO)?;
    actions.add_dup2(child_stderr.as_raw_fd(), libc::STDERR_FILENO)?;
    for descriptor in [
        child_stdin.as_raw_fd(),
        parent_stdin.as_raw_fd(),
        parent_stdout.as_raw_fd(),
        child_stdout.as_raw_fd(),
        parent_stderr.as_raw_fd(),
        child_stderr.as_raw_fd(),
    ] {
        if descriptor > libc::STDERR_FILENO {
            actions.add_close(descriptor)?;
        }
    }
    actions.add_chdir(&working_directory)?;

    let mut attributes = OwnedSpawnAttributes::new()?;
    attributes.configure_closed_child()?;
    let mut child_pid: libc::pid_t = 0;
    let mut argv = [executable.as_ptr().cast_mut(), null_mut()];
    // Deliberately empty: the signed bridge receives no API keys, cloud credentials, proxy
    // settings, dynamic-loader controls, HOME, PATH, or arbitrary parent state.
    let mut environment: [*mut c_char; 1] = [null_mut()];
    // SAFETY: every pointer references live storage for this synchronous call. File actions copy
    // their descriptors and the child is returned stopped before any of its code can execute.
    let spawn_status = unsafe {
        libc::posix_spawn(
            &raw mut child_pid,
            executable.as_ptr(),
            actions.raw(),
            attributes.raw(),
            argv.as_mut_ptr(),
            environment.as_mut_ptr(),
        )
    };
    if spawn_status != 0 || child_pid <= 0 {
        static_unique.zeroize();
        return Err(unavailable(
            "posix_spawn could not create the native bridge.",
        ));
    }
    drop(child_stdin);
    drop(child_stdout);
    drop(child_stderr);

    let mut child = OwnedChild::new(child_pid);
    let result = (|| -> Result<ExchangeResult> {
        child.require_stopped()?;
        child.require_owned_process_group()?;

        let parent_identity = process_unique_identity(unsafe { libc::getpid() })?;
        let process_identity = process_unique_identity(child_pid)?;
        if process_identity.unique_id == 0
            || process_identity.parent_unique_id != parent_identity.unique_id
            || process_identity.id_version <= 0
            || process_identity
                .executable_uuid
                .iter()
                .all(|byte| *byte == 0)
        {
            return Err(unavailable(
                "The spawned native bridge is not bound to this parent process instance.",
            ));
        }
        let audit_token = audit_token_for(child_pid, process_identity.id_version)?;
        let loaded_executable = process_path_for_audit_token(&audit_token)?;
        let expected_path = canonical_path(&input.expected.executable)?;
        if canonical_path(&loaded_executable)? != expected_path {
            return Err(unavailable(
                "The audit-token process path differs from the admitted executable.",
            ));
        }
        let loaded_file = open_admitted_executable(&loaded_executable)?;
        if file_identity(&loaded_file)? != admitted_identity {
            return Err(unavailable(
                "The loaded native executable inode differs from the admitted file descriptor.",
            ));
        }

        let dynamic_code = dynamic_code_for_process(child_pid, &audit_token)?;
        validate_dynamic_code(&dynamic_code)?;
        let mut dynamic_unique = code_unique_identity(&dynamic_code)?;
        let unique_matches = constant_time_equal(&static_unique, &dynamic_unique);
        dynamic_unique.zeroize();
        if !unique_matches {
            return Err(unavailable(
                "The loaded code-directory identity differs from the admitted signed artifact.",
            ));
        }
        let dynamic_fingerprint = leaf_certificate_fingerprint(&dynamic_code)?;
        if dynamic_fingerprint != static_fingerprint
            || dynamic_fingerprint != input.expected.signature.publisher_certificate_fingerprint
        {
            return Err(unavailable(
                "The loaded native signing identity differs from the admitted artifact.",
            ));
        }
        static_unique.zeroize();

        child.resume()?;
        let deadline = Instant::now() + Duration::from_millis(u64::from(input.timeout_ms));
        let io = exchange_io(
            &mut child,
            parent_stdin,
            parent_stdout,
            parent_stderr,
            &protected_request,
            usize::try_from(input.maximum_output_bytes)
                .map_err(|_| unavailable("The native output limit is invalid."))?,
            deadline,
        )?;
        child.terminate_descendants_and_verify()?;

        let file_version = format!("{}.0", env!("CARGO_PKG_VERSION"));
        let process_instance_id = format!(
            "darwin-audit:{child_pid}:{:08X}:{:016X}:{binary_sha256}",
            process_identity.id_version, process_identity.unique_id,
        );
        Ok(ExchangeResult {
            exit_code: io.exit_code,
            signal: io.signal,
            stdout: Buffer::from(io.stdout.into_vec()),
            stderr_present: io.stderr_present,
            cleanup_proven: true,
            observation: ProcessObservation {
                pid: u32::try_from(child_pid)
                    .map_err(|_| unavailable("The native child PID is invalid."))?,
                platform: "darwin".to_owned(),
                architecture: current_architecture().to_owned(),
                executable: loaded_executable,
                binary_sha256,
                file_version,
                loaded_image_verified: true,
                process_instance_verified: true,
                process_instance_id,
            },
        })
    })();
    static_unique.zeroize();
    if result.is_err() {
        let _ = child.terminate_tree_and_verify();
    }
    input.request.as_mut().zeroize();
    result
}

#[derive(Eq, PartialEq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

struct SecretBytes(Vec<u8>);

impl SecretBytes {
    fn as_slice(&self) -> &[u8] {
        &self.0
    }

    fn into_vec(mut self) -> Vec<u8> {
        std::mem::take(&mut self.0)
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

struct ExchangeIoResult {
    exit_code: i32,
    signal: Option<String>,
    stdout: SecretBytes,
    stderr_present: bool,
}

struct OwnedSpawnActions(libc::posix_spawn_file_actions_t);

impl OwnedSpawnActions {
    fn new() -> Result<Self> {
        let mut raw = null_mut();
        // SAFETY: raw is a valid output slot and is destroyed exactly once by Drop.
        if unsafe { libc::posix_spawn_file_actions_init(&raw mut raw) } != 0 {
            return Err(unavailable(
                "The native spawn file actions are unavailable.",
            ));
        }
        Ok(Self(raw))
    }

    const fn raw(&self) -> *const libc::posix_spawn_file_actions_t {
        &raw const self.0
    }

    fn add_dup2(&mut self, descriptor: RawFd, target: RawFd) -> Result<()> {
        // SAFETY: the action object is initialized and both descriptors are nonnegative.
        if unsafe { libc::posix_spawn_file_actions_adddup2(&raw mut self.0, descriptor, target) }
            != 0
        {
            return Err(unavailable("The native spawn pipe mapping failed."));
        }
        Ok(())
    }

    fn add_close(&mut self, descriptor: RawFd) -> Result<()> {
        // SAFETY: the action object is initialized and the descriptor is nonnegative.
        if unsafe { libc::posix_spawn_file_actions_addclose(&raw mut self.0, descriptor) } != 0 {
            return Err(unavailable("The native spawn descriptor isolation failed."));
        }
        Ok(())
    }

    fn add_chdir(&mut self, directory: &CStr) -> Result<()> {
        // SAFETY: the action object is initialized and directory is a live NUL-terminated path.
        if unsafe { posix_spawn_file_actions_addchdir_np(&raw mut self.0, directory.as_ptr()) } != 0
        {
            return Err(unavailable(
                "The native spawn working directory was refused.",
            ));
        }
        Ok(())
    }
}

impl Drop for OwnedSpawnActions {
    fn drop(&mut self) {
        // SAFETY: the object was initialized successfully and is destroyed exactly once.
        unsafe { libc::posix_spawn_file_actions_destroy(&raw mut self.0) };
    }
}

struct OwnedSpawnAttributes(libc::posix_spawnattr_t);

impl OwnedSpawnAttributes {
    fn new() -> Result<Self> {
        let mut raw = null_mut();
        // SAFETY: raw is a valid output slot and is destroyed exactly once by Drop.
        if unsafe { libc::posix_spawnattr_init(&raw mut raw) } != 0 {
            return Err(unavailable("The native spawn attributes are unavailable."));
        }
        Ok(Self(raw))
    }

    const fn raw(&self) -> *const libc::posix_spawnattr_t {
        &raw const self.0
    }

    fn configure_closed_child(&mut self) -> Result<()> {
        // A zero process-group value means the child's PID becomes its process-group ID. This is
        // established by the kernel before the suspended child can create a descendant.
        // SAFETY: the initialized attribute object remains live through posix_spawn.
        if unsafe { libc::posix_spawnattr_setpgroup(&raw mut self.0, 0) } != 0 {
            return Err(unavailable(
                "The native child process group could not be isolated.",
            ));
        }
        // Reset every signal disposition that POSIX permits and begin with an empty signal mask.
        let mut defaults = unsafe { zeroed::<libc::sigset_t>() };
        let mut mask = unsafe { zeroed::<libc::sigset_t>() };
        // SAFETY: both sigset values are initialized output objects.
        if unsafe { libc::sigfillset(&raw mut defaults) } != 0
            || unsafe { libc::sigemptyset(&raw mut mask) } != 0
            || unsafe { libc::posix_spawnattr_setsigdefault(&raw mut self.0, &raw const defaults) }
                != 0
            || unsafe { libc::posix_spawnattr_setsigmask(&raw mut self.0, &raw const mask) } != 0
        {
            return Err(unavailable(
                "The native child signal state could not be isolated.",
            ));
        }
        let flags = POSIX_SPAWN_SETPGROUP
            | POSIX_SPAWN_SETSIGDEF
            | POSIX_SPAWN_SETSIGMASK
            | POSIX_SPAWN_START_SUSPENDED
            | POSIX_SPAWN_CLOEXEC_DEFAULT;
        // SAFETY: the initialized attribute object remains live through posix_spawn.
        if unsafe { libc::posix_spawnattr_setflags(&raw mut self.0, flags) } != 0 {
            return Err(unavailable(
                "The native child containment flags were refused.",
            ));
        }
        Ok(())
    }
}

impl Drop for OwnedSpawnAttributes {
    fn drop(&mut self) {
        // SAFETY: the object was initialized successfully and is destroyed exactly once.
        unsafe { libc::posix_spawnattr_destroy(&raw mut self.0) };
    }
}

struct OwnedChild {
    pid: libc::pid_t,
    reaped: bool,
    process_group_verified: bool,
}

impl OwnedChild {
    const fn new(pid: libc::pid_t) -> Self {
        Self {
            pid,
            reaped: false,
            process_group_verified: false,
        }
    }

    fn require_stopped(&mut self) -> Result<()> {
        let deadline = Instant::now() + Duration::from_millis(500);
        loop {
            let mut status = 0;
            // SAFETY: status is a valid output slot and this object uniquely owns the child PID.
            let observed = unsafe {
                libc::waitpid(self.pid, &raw mut status, libc::WUNTRACED | libc::WNOHANG)
            };
            if observed == self.pid {
                if libc::WIFSTOPPED(status) && libc::WSTOPSIG(status) == libc::SIGSTOP {
                    return Ok(());
                }
                if libc::WIFEXITED(status) || libc::WIFSIGNALED(status) {
                    self.reaped = true;
                }
                return Err(unavailable(
                    "The native bridge did not remain suspended for identity admission.",
                ));
            }
            if observed < 0 && last_errno() != libc::EINTR {
                return Err(unavailable(
                    "The suspended native child could not be observed.",
                ));
            }
            if Instant::now() >= deadline {
                return Err(unavailable(
                    "The native child suspension could not be proven.",
                ));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn require_owned_process_group(&mut self) -> Result<()> {
        // SAFETY: getpgid is a read-only query and the child is still suspended.
        if unsafe { libc::getpgid(self.pid) } != self.pid {
            return Err(unavailable(
                "The native child is not contained in its owned process group.",
            ));
        }
        self.process_group_verified = true;
        Ok(())
    }

    fn resume(&self) -> Result<()> {
        // SAFETY: this object uniquely owns a child proven stopped in its own process group.
        if unsafe { libc::kill(self.pid, libc::SIGCONT) } != 0 {
            return Err(unavailable(
                "The verified native child could not be resumed.",
            ));
        }
        Ok(())
    }

    fn try_wait(&mut self) -> Result<Option<i32>> {
        if self.reaped {
            return Ok(None);
        }
        let mut information = unsafe { zeroed::<libc::siginfo_t>() };
        // WNOWAIT observes termination while deliberately retaining the zombie. That keeps the
        // PID/process-group identity reserved until every descendant has been signaled, closing a
        // PID-reuse race between main-child exit observation and process-group cleanup.
        // SAFETY: information is a valid output object and this guard uniquely owns the PID.
        let observed = unsafe {
            libc::waitid(
                libc::P_PID,
                u32::try_from(self.pid)
                    .map_err(|_| unavailable("The native child PID is invalid."))?,
                &raw mut information,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if observed != 0 {
            if last_errno() == libc::EINTR {
                return Ok(None);
            }
            return Err(unavailable("The native child exit could not be observed."));
        }
        if information.si_pid == 0 {
            return Ok(None);
        }
        if information.si_pid != self.pid {
            return Err(unavailable(
                "The native wait identity did not match the owned child.",
            ));
        }
        if self.process_group_verified {
            self.kill_owned_group()?;
        }
        let mut status = 0;
        // SAFETY: WNOWAIT proved this exact child is already terminated, so this reap cannot block.
        let reaped = unsafe { libc::waitpid(self.pid, &raw mut status, 0) };
        if reaped == self.pid {
            self.reaped = true;
            return Ok(Some(status));
        }
        if reaped < 0 && last_errno() == libc::EINTR {
            return Ok(None);
        }
        Err(unavailable("The native child exit status is unavailable."))
    }

    fn terminate_descendants_and_verify(&self) -> Result<()> {
        if !self.reaped {
            return Err(unavailable(
                "Descendant cleanup cannot precede native child exit observation.",
            ));
        }
        self.require_group_absent()
    }

    fn terminate_tree_and_verify(&mut self) -> Result<()> {
        if self.process_group_verified {
            self.kill_owned_group()?;
        } else if !self.reaped {
            // Before process-group proof, address only the still-owned PID; never use an
            // unverified negative PID as a kill target.
            // SAFETY: the child PID has not been reaped and remains uniquely owned by this guard.
            let killed = unsafe { libc::kill(self.pid, libc::SIGKILL) };
            if killed != 0 && last_errno() != libc::ESRCH {
                return Err(unavailable(
                    "The unverified suspended child could not be killed.",
                ));
            }
        }
        self.reap_bounded()?;
        if self.process_group_verified {
            self.require_group_absent()?;
        }
        Ok(())
    }

    fn kill_owned_group(&self) -> Result<()> {
        if !self.process_group_verified {
            return Err(unavailable("The native process group was never verified."));
        }
        // SAFETY: the negative PID addresses only the child-owned process group proven above.
        let killed = unsafe { libc::kill(-self.pid, libc::SIGKILL) };
        if killed != 0 && last_errno() != libc::ESRCH {
            return Err(unavailable(
                "The native descendant process group could not be killed.",
            ));
        }
        Ok(())
    }

    fn reap_bounded(&mut self) -> Result<()> {
        if self.reaped {
            return Ok(());
        }
        let deadline = Instant::now() + CLEANUP_TIMEOUT;
        loop {
            if self.try_wait()?.is_some() || self.reaped {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(unavailable(
                    "The native child termination could not be proven.",
                ));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn require_group_absent(&self) -> Result<()> {
        let deadline = Instant::now() + CLEANUP_TIMEOUT;
        loop {
            // SAFETY: signal 0 observes whether any member of the verified group still exists.
            if unsafe { libc::kill(-self.pid, 0) } != 0 && last_errno() == libc::ESRCH {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(unavailable("Native descendants remained after cleanup."));
            }
            // Do not signal the group again after reaping the leader: once the original group is
            // absent, its numeric ID can be reused by an unrelated process. Observation is safe;
            // a second post-reap kill would not be.
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.terminate_tree_and_verify();
    }
}

#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
fn exchange_io(
    child: &mut OwnedChild,
    parent_stdin: OwnedFd,
    parent_stdout: OwnedFd,
    parent_stderr: OwnedFd,
    request: &SecretBytes,
    maximum_output_bytes: usize,
    deadline: Instant,
) -> Result<ExchangeIoResult> {
    let mut parent_stdin = Some(parent_stdin);
    let mut parent_stdout = Some(parent_stdout);
    let mut parent_stderr = Some(parent_stderr);
    let mut request_offset = 0_usize;
    let mut stdout = SecretBytes(Vec::new());
    let mut stderr = SecretBytes(Vec::new());
    let mut exit_status = None;

    loop {
        if request_offset == request.as_slice().len() {
            parent_stdin.take();
        }
        if exit_status.is_some() && parent_stdout.is_none() && parent_stderr.is_none() {
            break;
        }
        if Instant::now() >= deadline {
            return Err(unavailable("The owned native bridge timed out."));
        }

        let mut descriptors = [
            libc::pollfd {
                fd: parent_stdin.as_ref().map_or(-1, AsRawFd::as_raw_fd),
                events: libc::POLLOUT,
                revents: 0,
            },
            libc::pollfd {
                fd: parent_stdout.as_ref().map_or(-1, AsRawFd::as_raw_fd),
                events: libc::POLLIN | libc::POLLHUP,
                revents: 0,
            },
            libc::pollfd {
                fd: parent_stderr.as_ref().map_or(-1, AsRawFd::as_raw_fd),
                events: libc::POLLIN | libc::POLLHUP,
                revents: 0,
            },
        ];
        let remaining_ms = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(u128::try_from(IO_POLL_SLICE_MS).unwrap_or(25));
        let poll_timeout = c_int::try_from(remaining_ms)
            .unwrap_or(IO_POLL_SLICE_MS)
            .max(1);
        // SAFETY: descriptors is a live fixed-size array for the bounded poll call.
        let polled = unsafe {
            libc::poll(
                descriptors.as_mut_ptr(),
                libc::nfds_t::try_from(descriptors.len())
                    .map_err(|_| unavailable("The native poll descriptor count is invalid."))?,
                poll_timeout,
            )
        };
        if polled < 0 && last_errno() != libc::EINTR {
            return Err(unavailable("The native bridge pipes could not be polled."));
        }

        if let Some(stdin) = parent_stdin.as_ref()
            && descriptors[0].revents & (libc::POLLOUT | libc::POLLERR | libc::POLLHUP) != 0
        {
            if descriptors[0].revents & libc::POLLOUT == 0 {
                return Err(unavailable(
                    "The native bridge closed stdin before admission.",
                ));
            }
            let remaining = &request.as_slice()[request_offset..];
            // SAFETY: remaining is a live byte slice and stdin is the uniquely owned pipe writer.
            let written = unsafe {
                libc::write(
                    stdin.as_raw_fd(),
                    remaining.as_ptr().cast::<c_void>(),
                    remaining.len(),
                )
            };
            if written > 0 {
                request_offset = request_offset
                    .checked_add(
                        usize::try_from(written)
                            .map_err(|_| unavailable("The native stdin write count is invalid."))?,
                    )
                    .ok_or_else(|| unavailable("The native stdin offset overflowed."))?;
            } else if written < 0 && !matches!(last_errno(), libc::EAGAIN | libc::EINTR) {
                return Err(unavailable("Protected stdin could not be delivered."));
            }
        }

        if let Some(output) = parent_stdout.as_ref() {
            let eof = drain_bounded(output.as_raw_fd(), &mut stdout.0, maximum_output_bytes)?;
            if eof {
                parent_stdout.take();
            }
        }
        if let Some(output) = parent_stderr.as_ref() {
            let eof = drain_bounded(output.as_raw_fd(), &mut stderr.0, maximum_output_bytes)?;
            if eof {
                parent_stderr.take();
            }
        }

        if exit_status.is_none() {
            exit_status = child.try_wait()?;
            if exit_status.is_some() && request_offset != request.as_slice().len() {
                return Err(unavailable(
                    "The native bridge exited before protected stdin was delivered.",
                ));
            }
        }
    }

    let status = exit_status.ok_or_else(|| unavailable("The native child never exited."))?;
    let (exit_code, signal) = if libc::WIFEXITED(status) {
        (libc::WEXITSTATUS(status), None)
    } else if libc::WIFSIGNALED(status) {
        let number = libc::WTERMSIG(status);
        (-1, Some(format!("SIG{number}")))
    } else {
        return Err(unavailable(
            "The native child returned an invalid wait status.",
        ));
    };
    Ok(ExchangeIoResult {
        exit_code,
        signal,
        stdout,
        stderr_present: !stderr.0.is_empty(),
    })
}

fn drain_bounded(descriptor: RawFd, output: &mut Vec<u8>, maximum: usize) -> Result<bool> {
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        // SAFETY: buffer is a live writable array and descriptor is an owned nonblocking pipe.
        let read = unsafe {
            libc::read(
                descriptor,
                buffer.as_mut_ptr().cast::<c_void>(),
                buffer.len(),
            )
        };
        if read == 0 {
            buffer.zeroize();
            return Ok(true);
        }
        if read < 0 {
            let error = last_errno();
            buffer.zeroize();
            return if matches!(error, libc::EAGAIN | libc::EINTR) {
                Ok(false)
            } else {
                Err(unavailable("The native bridge output could not be read."))
            };
        }
        let count = usize::try_from(read)
            .map_err(|_| unavailable("The native output read count is invalid."))?;
        if output
            .len()
            .checked_add(count)
            .is_none_or(|length| length > maximum)
        {
            buffer.zeroize();
            return Err(unavailable("The native bridge exceeded its output limit."));
        }
        output.extend_from_slice(&buffer[..count]);
        buffer[..count].zeroize();
    }
}

fn pipe_pair() -> Result<(OwnedFd, OwnedFd)> {
    let mut descriptors = [-1; 2];
    // SAFETY: descriptors is a valid two-element output array.
    if unsafe { libc::pipe(descriptors.as_mut_ptr()) } != 0 {
        return Err(unavailable(
            "The owned native process pipes could not be created.",
        ));
    }
    // SAFETY: successful pipe returns two distinct owned descriptors.
    let read = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
    // SAFETY: successful pipe returns two distinct owned descriptors.
    let write = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
    set_close_on_exec(read.as_raw_fd())?;
    set_close_on_exec(write.as_raw_fd())?;
    Ok((read, write))
}

fn set_close_on_exec(descriptor: RawFd) -> Result<()> {
    // SAFETY: descriptor is live and F_GETFD/F_SETFD only mutate its descriptor flags.
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0
    {
        return Err(unavailable(
            "The native pipe close-on-exec flag could not be set.",
        ));
    }
    Ok(())
}

fn set_nonblocking(descriptor: RawFd) -> Result<()> {
    // SAFETY: descriptor is live and F_GETFL/F_SETFL only mutate its status flags.
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        return Err(unavailable(
            "The native pipe nonblocking flag could not be set.",
        ));
    }
    Ok(())
}

fn set_no_sigpipe(descriptor: RawFd) -> Result<()> {
    // SAFETY: F_SETNOSIGPIPE is Darwin's documented per-descriptor suppression for pipe writes.
    if unsafe { libc::fcntl(descriptor, F_SETNOSIGPIPE, 1) } < 0 {
        return Err(unavailable(
            "The native stdin SIGPIPE guard could not be set.",
        ));
    }
    Ok(())
}

fn process_unique_identity(pid: libc::pid_t) -> Result<ProcessUniqueIdentifierInfo> {
    let mut identity = ProcessUniqueIdentifierInfo::default();
    let size = c_int::try_from(size_of::<ProcessUniqueIdentifierInfo>())
        .map_err(|_| unavailable("The native process identity size is invalid."))?;
    // SAFETY: identity is a writable structure of the exact size declared to proc_pidinfo.
    let observed = unsafe {
        libc::proc_pidinfo(
            pid,
            PROC_PIDUNIQIDENTIFIERINFO,
            0,
            (&raw mut identity).cast::<c_void>(),
            size,
        )
    };
    if observed != size {
        return Err(unavailable(
            "The native process-instance identity is unavailable.",
        ));
    }
    Ok(identity)
}

fn audit_token_for(pid: libc::pid_t, id_version: i32) -> Result<AuditToken> {
    // XNU's csops_audittoken authority binds val[5] to PID and val[7] to the kernel's
    // monotonically changing PID version. The other fields are intentionally zero: this token is
    // a process-instance selector, never an authorization credential.
    Ok(AuditToken {
        values: [
            0,
            0,
            0,
            0,
            0,
            u32::try_from(pid).map_err(|_| unavailable("The native child PID is invalid."))?,
            0,
            u32::try_from(id_version)
                .map_err(|_| unavailable("The native child PID version is invalid."))?,
        ],
    })
}

fn process_path_for_audit_token(token: &AuditToken) -> Result<String> {
    let mut path = vec![0_u8; PROCESS_PATH_CAPACITY];
    // SAFETY: path is a writable buffer and token has the exact Darwin audit-token layout.
    let observed = unsafe {
        proc_pidpath_audittoken(
            token,
            path.as_mut_ptr().cast::<c_void>(),
            u32::try_from(path.len())
                .map_err(|_| unavailable("The native process path buffer is invalid."))?,
        )
    };
    if observed <= 0 {
        path.zeroize();
        return Err(unavailable(
            "The kernel rejected the native child audit-token process identity.",
        ));
    }
    let value = CStr::from_bytes_until_nul(&path)
        .map_err(|_| unavailable("The native process path is not terminated."))?
        .to_str()
        .map_err(|_| unavailable("The native process path is not UTF-8."))?
        .to_owned();
    path.zeroize();
    Ok(value)
}

fn dynamic_code_for_process(pid: libc::pid_t, token: &AuditToken) -> Result<OwnedCf> {
    let pid_number = OwnedCf::number_i32(pid)?;
    let token_bytes = unsafe {
        // SAFETY: AuditToken is repr(C), contains only eight u32 values, and remains live while
        // CoreFoundation copies its bytes into an immutable CFData.
        std::slice::from_raw_parts(
            std::ptr::from_ref(token).cast::<u8>(),
            size_of::<AuditToken>(),
        )
    };
    let token_data = OwnedCf::data(token_bytes)?;
    let attributes = dictionary(&[
        (
            unsafe { kSecGuestAttributePid.cast::<c_void>() },
            pid_number.get(),
        ),
        (
            unsafe { kSecGuestAttributeAudit.cast::<c_void>() },
            token_data.get(),
        ),
    ])?;
    let mut code: SecCodeRef = null();
    // SAFETY: attributes owns both selectors and code is a valid output slot. Supplying both PID
    // and audit token directs the kernel to reject any disagreement, including PID reuse.
    let status =
        unsafe { SecCodeCopyGuestWithAttributes(null(), attributes.get(), 0, &raw mut code) };
    if status != ERR_SEC_SUCCESS {
        return Err(unavailable(
            "Security.framework could not resolve the audit-token child code identity.",
        ));
    }
    OwnedCf::new(
        code,
        "Security.framework returned no dynamic child code identity.",
    )
}

fn validate_dynamic_code(code: &OwnedCf) -> Result<()> {
    let mut errors: CfTypeRef = null();
    // SAFETY: code is a live dynamic SecCode reference and errors is a valid output slot.
    let status = unsafe {
        SecCodeCheckValidityWithErrors(code.get(), STRICT_VALIDATE, null(), &raw mut errors)
    };
    if !errors.is_null() {
        // SAFETY: Security returned errors with +1 ownership.
        unsafe { CFRelease(errors) };
    }
    if status != ERR_SEC_SUCCESS {
        return Err(unavailable(
            "The loaded native child failed dynamic code-signing validation.",
        ));
    }
    Ok(())
}

fn code_unique_identity(code: &OwnedCf) -> Result<Vec<u8>> {
    let information = signing_information(code)?;
    // SAFETY: information is a CFDictionary and the imported key is process-lifetime storage.
    let unique =
        unsafe { CFDictionaryGetValue(information.get(), kSecCodeInfoUnique.cast::<c_void>()) };
    if unique.is_null() || unsafe { CFGetTypeID(unique) } != unsafe { CFDataGetTypeID() } {
        return Err(unavailable(
            "The native code-directory identity is unavailable.",
        ));
    }
    // SAFETY: the type check proves unique is CFData owned by the live information dictionary.
    let length = unsafe { CFDataGetLength(unique) };
    let length = usize::try_from(length)
        .map_err(|_| unavailable("The native code-directory identity is too large."))?;
    if !(20..=64).contains(&length) {
        return Err(unavailable(
            "The native code-directory identity has an invalid size.",
        ));
    }
    // SAFETY: the live CFData owns a stable non-empty byte range.
    let bytes = unsafe { CFDataGetBytePtr(unique) };
    if bytes.is_null() {
        return Err(unavailable("The native code-directory identity is empty."));
    }
    // SAFETY: CFDataGetLength and CFDataGetBytePtr describe the same allocation.
    Ok(unsafe { std::slice::from_raw_parts(bytes, length) }.to_vec())
}

fn signing_information(code: &OwnedCf) -> Result<OwnedCf> {
    let mut information: CfDictionaryRef = null();
    // SAFETY: code is live and information is a valid output slot.
    let status = unsafe {
        SecCodeCopySigningInformation(code.get(), SIGNING_INFORMATION, &raw mut information)
    };
    if status != ERR_SEC_SUCCESS {
        return Err(unavailable(
            "The native signing information is unavailable.",
        ));
    }
    OwnedCf::new(
        information,
        "Security.framework returned no signing information.",
    )
}

fn dictionary(entries: &[(CfTypeRef, CfTypeRef)]) -> Result<OwnedCf> {
    let count = CfIndex::try_from(entries.len())
        .map_err(|_| unavailable("The native identity dictionary is too large."))?;
    let keys: Vec<CfTypeRef> = entries.iter().map(|(key, _)| *key).collect();
    let values: Vec<CfTypeRef> = entries.iter().map(|(_, value)| *value).collect();
    // SAFETY: entries remain live for the call and standard callbacks retain every object.
    let result = unsafe {
        CFDictionaryCreate(
            null(),
            keys.as_ptr(),
            values.as_ptr(),
            count,
            &raw const kCFTypeDictionaryKeyCallBacks,
            &raw const kCFTypeDictionaryValueCallBacks,
        )
    };
    OwnedCf::new(
        result,
        "The native identity dictionary could not be created.",
    )
}

fn open_admitted_executable(path: &str) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| unavailable("The native executable could not be opened without symlinks."))?;
    let metadata = file
        .metadata()
        .map_err(|_| unavailable("The native executable metadata is unavailable."))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAXIMUM_BINARY_BYTES {
        return Err(unavailable(
            "The native executable is not a bounded regular file.",
        ));
    }
    Ok(file)
}

fn file_identity(file: &File) -> Result<FileIdentity> {
    let metadata = file
        .metadata()
        .map_err(|_| unavailable("The native executable identity is unavailable."))?;
    Ok(FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

fn file_sha256_handle(file: &File) -> Result<String> {
    let mut file = file
        .try_clone()
        .map_err(|_| unavailable("The native executable handle could not be cloned."))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|_| unavailable("The native executable handle could not be rewound."))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
    let result = (|| -> Result<String> {
        loop {
            let count = file
                .read(&mut buffer)
                .map_err(|_| unavailable("The native executable could not be read."))?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        Ok(hex(&hasher.finalize(), false))
    })();
    buffer.zeroize();
    result
}

fn canonical_path(path: &str) -> Result<String> {
    std::fs::canonicalize(path)
        .map_err(|_| unavailable("The native executable path could not be canonicalized."))?
        .into_os_string()
        .into_string()
        .map_err(|_| unavailable("The native executable path is not UTF-8."))
}

fn c_string(value: &str, label: &str) -> Result<CString> {
    CString::new(value).map_err(|_| invalid(&format!("The {label} contains a NUL byte.")))
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (left, right) in left.iter().zip(right) {
        difference |= left ^ right;
    }
    difference == 0
}

fn last_errno() -> c_int {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn file_url(path: &str) -> Result<OwnedCf> {
    let length = CfIndex::try_from(path.len())
        .map_err(|_| invalid("The native executable path is too long."))?;
    // SAFETY: path bytes remain live for the synchronous constructor call.
    let url = unsafe { CFURLCreateFromFileSystemRepresentation(null(), path.as_ptr(), length, 0) };
    OwnedCf::new(url, "The native executable URL could not be created.")
}

fn static_code(url: &OwnedCf) -> Result<OwnedCf> {
    let mut code: SecStaticCodeRef = null();
    // SAFETY: url is a live CFURL and code is a valid output slot.
    let status = unsafe { SecStaticCodeCreateWithPath(url.get(), 0, &raw mut code) };
    if status != ERR_SEC_SUCCESS {
        return Err(unavailable(
            "Security.framework could not create the native code identity.",
        ));
    }
    OwnedCf::new(code, "Security.framework returned no native code identity.")
}

fn validate_code_signature(code: &OwnedCf) -> Result<()> {
    let mut errors: CfTypeRef = null();
    // SAFETY: code is a live SecStaticCode reference. The optional error is released below.
    let status = unsafe {
        SecStaticCodeCheckValidityWithErrors(
            code.get(),
            CHECK_ALL_ARCHITECTURES | CHECK_NESTED_CODE | STRICT_VALIDATE,
            null(),
            &raw mut errors,
        )
    };
    if !errors.is_null() {
        // SAFETY: Security returned errors with +1 ownership.
        unsafe { CFRelease(errors) };
    }
    if status != ERR_SEC_SUCCESS {
        return Err(unavailable(
            "The native Developer ID signature is invalid or incomplete.",
        ));
    }
    Ok(())
}

fn validate_gatekeeper_assessment(url: &OwnedCf) -> Result<()> {
    let mut errors: CfTypeRef = null();
    // SAFETY: url is live; default assessment policy is intentionally used for execution.
    let assessment = unsafe { SecAssessmentCreate(url.get(), 0, null(), &raw mut errors) };
    if !errors.is_null() {
        // SAFETY: Security returned errors with +1 ownership.
        unsafe { CFRelease(errors) };
    }
    let assessment = OwnedCf::new(
        assessment,
        "Gatekeeper did not admit the native executable.",
    )?;
    let mut result_errors: CfTypeRef = null();
    // SAFETY: assessment is live and the result/error output slots are valid.
    let result = unsafe { SecAssessmentCopyResult(assessment.get(), 0, &raw mut result_errors) };
    if !result_errors.is_null() {
        // SAFETY: Security returned errors with +1 ownership.
        unsafe { CFRelease(result_errors) };
    }
    let result = OwnedCf::new(result, "Gatekeeper returned no assessment result.")?;
    // SAFETY: result is a CFDictionary and the imported key is process-lifetime storage.
    let verdict = unsafe {
        CFDictionaryGetValue(
            result.get(),
            kSecAssessmentAssessmentVerdict.cast::<c_void>(),
        )
    };
    if verdict.is_null()
        // SAFETY: a non-null dictionary value can be type-checked before use.
        || unsafe { CFGetTypeID(verdict) } != unsafe { CFBooleanGetTypeID() }
        // SAFETY: the type check proves verdict is a CFBoolean.
        || unsafe { CFBooleanGetValue(verdict) } == 0
    {
        return Err(unavailable(
            "Gatekeeper did not admit the native executable for execution.",
        ));
    }
    Ok(())
}

fn leaf_certificate_fingerprint(code: &OwnedCf) -> Result<String> {
    let mut information: CfDictionaryRef = null();
    // SAFETY: code is live and information is a valid output slot.
    let status = unsafe {
        SecCodeCopySigningInformation(code.get(), SIGNING_INFORMATION, &raw mut information)
    };
    if status != ERR_SEC_SUCCESS {
        return Err(unavailable(
            "The native signing certificate chain is unavailable.",
        ));
    }
    let information = OwnedCf::new(
        information,
        "The native signing information is unavailable.",
    )?;
    // SAFETY: information is a CFDictionary and the imported key is process-lifetime storage.
    let certificates = unsafe {
        CFDictionaryGetValue(information.get(), kSecCodeInfoCertificates.cast::<c_void>())
    };
    if certificates.is_null()
        // SAFETY: a non-null dictionary value can be type-checked before use.
        || unsafe { CFGetTypeID(certificates) } != unsafe { CFArrayGetTypeID() }
        // SAFETY: the type check proves certificates is a CFArray.
        || unsafe { CFArrayGetCount(certificates) } < 1
    {
        return Err(unavailable(
            "The native signing certificate chain is empty.",
        ));
    }
    // SAFETY: the array has at least one entry and owns it for the array lifetime.
    let leaf = unsafe { CFArrayGetValueAtIndex(certificates, 0) };
    // SAFETY: a SecCertificate in the signing chain is accepted by SecCertificateCopyData.
    let data = unsafe { SecCertificateCopyData(leaf) };
    let data = OwnedCf::new(data, "The native signing certificate is unreadable.")?;
    // SAFETY: data is a live CFData reference.
    if unsafe { CFGetTypeID(data.get()) } != unsafe { CFDataGetTypeID() } {
        return Err(unavailable(
            "The native signing certificate has an invalid representation.",
        ));
    }
    // SAFETY: the live CFData owns a stable byte range.
    let length = unsafe { CFDataGetLength(data.get()) };
    let length = usize::try_from(length)
        .map_err(|_| unavailable("The native signing certificate is too large."))?;
    // SAFETY: CFDataGetBytePtr is valid for the live data reference.
    let bytes = unsafe { CFDataGetBytePtr(data.get()) };
    if length == 0 || bytes.is_null() {
        return Err(unavailable("The native signing certificate is empty."));
    }
    // SAFETY: CFDataGetLength and CFDataGetBytePtr describe the same allocation.
    let digest = Sha256::digest(unsafe { std::slice::from_raw_parts(bytes, length) });
    Ok(hex(&digest, true))
}

fn file_sha256(path: &str) -> Result<String> {
    let mut file =
        File::open(path).map_err(|_| unavailable("The native executable could not be opened."))?;
    let metadata = file
        .metadata()
        .map_err(|_| unavailable("The native executable metadata is unavailable."))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAXIMUM_BINARY_BYTES {
        return Err(unavailable(
            "The native executable is not a bounded regular file.",
        ));
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| unavailable("The native executable could not be read."))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    buffer.zeroize();
    Ok(hex(&hasher.finalize(), false))
}

fn hex(bytes: &[u8], uppercase: bool) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        if uppercase {
            let _ = write!(output, "{byte:02X}");
        } else {
            let _ = write!(output, "{byte:02x}");
        }
    }
    output
}

const fn current_architecture() -> &'static str {
    #[cfg(target_arch = "x86_64")]
    {
        "x64"
    }
    #[cfg(target_arch = "aarch64")]
    {
        "arm64"
    }
}
