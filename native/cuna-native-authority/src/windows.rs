use std::ffi::c_void;
use std::fmt::Write as _;
use std::mem::size_of;
use std::os::windows::io::AsRawHandle;
use std::path::{Component, Path, PathBuf};
use std::ptr::{null, null_mut};
use std::thread;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use napi::Result;
use napi::bindgen_prelude::Buffer;
use sha2::{Digest, Sha256};
use windows_sys::Win32::Foundation::{
    CloseHandle, FILETIME, GENERIC_READ, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
    WAIT_OBJECT_0,
};
use windows_sys::Win32::Foundation::{GENERIC_ALL, GENERIC_WRITE, LocalFree, SetHandleInformation};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSidToSidW, GetSecurityInfo, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::Cryptography::{
    CERT_CONTEXT, CERT_FIND_SUBJECT_CERT, CERT_INFO, CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
    CERT_QUERY_FORMAT_FLAG_BINARY, CERT_QUERY_OBJECT_FILE, CERT_SHA1_HASH_PROP_ID,
    CMSG_SIGNER_INFO, CMSG_SIGNER_INFO_PARAM, CertCloseStore, CertFindCertificateInStore,
    CertFreeCertificateContext, CertGetCertificateContextProperty, CryptMsgClose, CryptMsgGetParam,
    CryptQueryObject, HCERTSTORE, PKCS_7_ASN_ENCODING, X509_ASN_ENCODING,
};
use windows_sys::Win32::Security::WinTrust::{
    WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO,
    WTD_CHOICE_FILE, WTD_REVOCATION_CHECK_NONE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE,
    WTD_STATEACTION_VERIFY, WTD_UI_NONE, WinVerifyTrust,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, AclSizeInformation, DACL_SECURITY_INFORMATION,
    GetAce, GetAclInformation, GetLengthSid, INHERIT_ONLY_ACE, IsValidSid, IsWellKnownSid,
    OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES,
    WinBuiltinAdministratorsSid, WinLocalSystemSid,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CreateFileW, DELETE, FILE_APPEND_DATA, FILE_ATTRIBUTE_NORMAL,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_DELETE_CHILD, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_WRITE_ATTRIBUTES,
    FILE_WRITE_DATA, FILE_WRITE_EA, GetFileInformationByHandle, GetFileVersionInfoSizeW,
    GetFileVersionInfoW, GetFinalPathNameByHandleW, OPEN_EXISTING, READ_CONTROL, ReadFile,
    VOLUME_NAME_DOS, VerQueryValueW, WRITE_DAC, WRITE_OWNER, WriteFile,
};
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::System::IO::CancelSynchronousIo;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::SystemInformation::GetSystemWindowsDirectoryW;
use windows_sys::Win32::System::SystemServices::{
    ACCESS_ALLOWED_ACE_TYPE, ACCESS_ALLOWED_OBJECT_ACE_TYPE,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess,
    GetProcessTimes, GetThreadId, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    OpenThread, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION, QueryFullProcessImageNameW,
    ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW, THREAD_SYNCHRONIZE,
    THREAD_TERMINATE, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
};
use windows_sys::Win32::UI::Shell::{FOLDERID_ProgramFiles, SHGetKnownFolderPath};
use zeroize::Zeroize;

use crate::{
    ExchangeInput, ExchangeResult, ProcessObservation, SignatureInput, SignatureObservation,
    invalid, unavailable,
};

const ERROR_EXIT_CODE: u32 = 126;
const CLEANUP_TIMEOUT_MS: u32 = 2_000;
const MAXIMUM_PATH_UNITS: usize = 32_768;
const MAXIMUM_AUTHORITY_BINARY_BYTES: u64 = 128 * 1024 * 1024;
const VS_FIXEDFILEINFO_SIGNATURE: u32 = 0xFEEF_04BD;
const TRUSTED_INSTALLER_SID: &str =
    "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const APPLICABLE_WRITE_RIGHTS: u32 = GENERIC_WRITE
    | GENERIC_ALL
    | FILE_WRITE_DATA
    | FILE_APPEND_DATA
    | FILE_WRITE_EA
    | FILE_WRITE_ATTRIBUTES
    | FILE_DELETE_CHILD
    | DELETE
    | WRITE_DAC
    | WRITE_OWNER;

#[repr(C)]
#[derive(Clone, Copy)]
struct VsFixedFileInfo {
    signature: u32,
    struct_version: u32,
    file_version_ms: u32,
    file_version_ls: u32,
    product_version_ms: u32,
    product_version_ls: u32,
    file_flags_mask: u32,
    file_flags: u32,
    file_os: u32,
    file_type: u32,
    file_subtype: u32,
    file_date_ms: u32,
    file_date_ls: u32,
}

struct OwnedHandle(HANDLE);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
    volume_serial: u32,
    file_index: u64,
}

/// One kernel-owned snapshot of a Program Files path.
///
/// Every ancestor handle denies write/delete sharing.  Keeping the complete chain alive makes a
/// successful value a capability, not a stale boolean observation: neither the leaf nor an
/// ancestor can be renamed or replaced until this value is dropped.
struct ProtectedPath {
    chain: Vec<OwnedHandle>,
    leaf_identity: FileIdentity,
    leaf_size: u64,
}

struct OwnedLocalMemory(*mut c_void);

struct KnownFolderPath(*mut u16);

impl Drop for OwnedLocalMemory {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: LocalFree owns buffers returned by GetSecurityInfo and
            // ConvertStringSidToSidW.  This wrapper is their sole owner.
            unsafe { LocalFree(self.0) };
            self.0 = null_mut();
        }
    }
}

impl Drop for KnownFolderPath {
    fn drop(&mut self) {
        // SAFETY: this pointer is the allocation returned by SHGetKnownFolderPath.
        unsafe { CoTaskMemFree(self.0.cast::<c_void>()) };
    }
}

struct SecretBytes(Vec<u8>);

struct IoWorker<T>(Option<JoinHandle<Result<T>>>);

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

impl<T> IoWorker<T> {
    fn spawn(operation: impl FnOnce() -> Result<T> + Send + 'static) -> Self
    where
        T: Send + 'static,
    {
        Self(Some(thread::spawn(operation)))
    }

    fn join_before(&mut self, deadline: Instant) -> Result<T> {
        let worker = self
            .0
            .as_ref()
            .ok_or_else(|| unavailable("The native I/O worker was already consumed."))?;
        let rust_thread_handle = worker.as_raw_handle().cast::<c_void>();
        // SAFETY: the JoinHandle's kernel thread handle is live through this method.
        let thread_id = unsafe { GetThreadId(rust_thread_handle) };
        if thread_id == 0 {
            return Err(unavailable(
                "The native I/O worker identity is unavailable.",
            ));
        }
        // CancelSynchronousIo requires THREAD_TERMINATE; Rust does not promise that access on the
        // JoinHandle's internal handle, so obtain an explicit least-privilege cancellation handle.
        let thread_handle = OwnedHandle::new(unsafe {
            OpenThread(THREAD_SYNCHRONIZE | THREAD_TERMINATE, 0, thread_id)
        })?;
        // The numeric thread ID can be reused only after the original thread exits. Re-check the
        // authoritative JoinHandle before acting on the ID-derived handle so an exit/reuse race
        // can never cancel an unrelated thread.
        if unsafe { WaitForSingleObject(rust_thread_handle, 0) } == WAIT_OBJECT_0 {
            return self.join_signaled();
        }
        // Give already-completing I/O a short drain window before cancellation. All workers share
        // one deadline, so three joins cannot multiply the cleanup bound.
        let drain = remaining_millis(deadline)?.min(100);
        // SAFETY: the thread handle remains live until the JoinHandle is consumed.
        if unsafe { WaitForSingleObject(thread_handle.raw(), drain) } != WAIT_OBJECT_0 {
            // SAFETY: JoinHandle owns a live Windows thread handle. Cancellation is best-effort;
            // the second bounded wait proves whether the blocked synchronous I/O actually ended.
            unsafe { CancelSynchronousIo(thread_handle.raw()) };
            if unsafe { WaitForSingleObject(thread_handle.raw(), remaining_millis(deadline)?) }
                != WAIT_OBJECT_0
            {
                return Err(unavailable(
                    "The native I/O worker did not terminate within the cleanup bound.",
                ));
            }
        }
        self.join_signaled()
    }

    fn is_finished(&self) -> bool {
        self.0.as_ref().is_none_or(JoinHandle::is_finished)
    }

    fn cancel_if_running(&self) -> Result<()> {
        let Some(worker) = self.0.as_ref() else {
            return Ok(());
        };
        if worker.is_finished() {
            return Ok(());
        }
        let rust_thread_handle = worker.as_raw_handle().cast::<c_void>();
        // SAFETY: the JoinHandle's kernel thread handle is live through this method.
        let thread_id = unsafe { GetThreadId(rust_thread_handle) };
        if thread_id == 0 {
            return Err(unavailable(
                "The native I/O worker identity is unavailable during cleanup.",
            ));
        }
        // SAFETY: the explicit handle is scoped to this cancellation attempt.
        let thread_handle = match OwnedHandle::new(unsafe {
            OpenThread(THREAD_SYNCHRONIZE | THREAD_TERMINATE, 0, thread_id)
        }) {
            Ok(handle) => handle,
            Err(_error) if worker.is_finished() => return Ok(()),
            Err(error) => return Err(error),
        };
        // Do not act on a potentially reused numeric ID after the owned worker has exited.
        if unsafe { WaitForSingleObject(rust_thread_handle, 0) } == WAIT_OBJECT_0 {
            return Ok(());
        }
        // SAFETY: the handle refers to the still-owned worker thread. A false return is harmless
        // when the operation raced to completion; the bounded join below proves termination.
        unsafe { CancelSynchronousIo(thread_handle.raw()) };
        Ok(())
    }

    fn join_signaled(&mut self) -> Result<T> {
        self.0
            .take()
            .ok_or_else(|| unavailable("The native I/O worker was already consumed."))?
            .join()
            .map_err(|_| unavailable("The native I/O worker failed."))?
    }
}

impl<T> Drop for IoWorker<T> {
    fn drop(&mut self) {
        let Some(worker) = self.0.take() else {
            return;
        };
        let raw_handle = worker.as_raw_handle().cast::<c_void>();
        // SAFETY: the JoinHandle owns this kernel handle until `worker` is joined or dropped.
        if unsafe { WaitForSingleObject(raw_handle, 0) } != WAIT_OBJECT_0 {
            // A cleanup failure may not detach a worker holding protected request bytes or a
            // secret-bearing result. Try bounded cancellation; fail-stop if the OS cannot prove
            // termination, which zeroizes the entire process address space.
            let thread_id = unsafe { GetThreadId(raw_handle) };
            if thread_id == 0 {
                std::process::abort();
            }
            let Ok(thread_handle) = OwnedHandle::new(unsafe {
                OpenThread(THREAD_SYNCHRONIZE | THREAD_TERMINATE, 0, thread_id)
            }) else {
                std::process::abort();
            };
            if unsafe { WaitForSingleObject(raw_handle, 0) } != WAIT_OBJECT_0 {
                unsafe { CancelSynchronousIo(thread_handle.raw()) };
                if unsafe { WaitForSingleObject(raw_handle, CLEANUP_TIMEOUT_MS) } != WAIT_OBJECT_0 {
                    std::process::abort();
                }
            }
        }
        // The kernel handle is signaled, so joining is non-blocking and lets the closure/result
        // destructors zeroize their owned secret bytes.
        drop(worker.join());
    }
}

fn settle_io_workers(
    stdin_writer: &mut IoWorker<()>,
    stdout_reader: &mut IoWorker<SecretBytes>,
    stderr_reader: &mut IoWorker<SecretBytes>,
    deadline: Instant,
) -> Result<(SecretBytes, SecretBytes)> {
    let drain_deadline = deadline.min(Instant::now() + Duration::from_millis(100));
    while Instant::now() < drain_deadline
        && !(stdin_writer.is_finished()
            && stdout_reader.is_finished()
            && stderr_reader.is_finished())
    {
        thread::yield_now();
    }

    // Cancel every outstanding worker before waiting for any one of them. This prevents one
    // pathological join from consuming the shared deadline and leaving sibling I/O blocked.
    let cancellation_results = [
        stdin_writer.cancel_if_running(),
        stdout_reader.cancel_if_running(),
        stderr_reader.cancel_if_running(),
    ];
    let stdin_result = stdin_writer.join_before(deadline);
    let stdout_result = stdout_reader.join_before(deadline);
    let stderr_result = stderr_reader.join_before(deadline);

    let mut first_error = cancellation_results.into_iter().find_map(Result::err);
    if let Err(error) = stdin_result {
        first_error.get_or_insert(error);
    }
    let stdout = match stdout_result {
        Ok(bytes) => bytes,
        Err(error) => {
            first_error.get_or_insert(error);
            SecretBytes(Vec::new())
        }
    };
    let stderr = match stderr_result {
        Ok(bytes) => bytes,
        Err(error) => {
            first_error.get_or_insert(error);
            SecretBytes(Vec::new())
        }
    };
    if let Some(error) = first_error {
        return Err(error);
    }
    Ok((stdout, stderr))
}

fn remaining_millis(deadline: Instant) -> Result<u32> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(unavailable("The native I/O cleanup deadline expired."));
    }
    Ok(u32::try_from(remaining.as_millis().max(1)).unwrap_or(u32::MAX))
}

impl OwnedHandle {
    fn new(value: HANDLE) -> Result<Self> {
        if value.is_null() || value == INVALID_HANDLE_VALUE {
            return Err(unavailable(
                "The operating system did not return an owned handle.",
            ));
        }
        Ok(Self(value))
    }

    const fn raw(&self) -> HANDLE {
        self.0
    }

    fn is_valid(&self) -> bool {
        !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE
    }

    fn close(&mut self) {
        if self.is_valid() {
            // SAFETY: this type uniquely owns the handle and clears it immediately after close.
            unsafe { CloseHandle(self.0) };
            self.0 = null_mut();
        }
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        self.close();
    }
}

// SAFETY: HANDLE values are kernel object references. Ownership is moved into one reader thread
// and the RAII wrapper closes the handle exactly once after that thread finishes.
unsafe impl Send for OwnedHandle {}

struct OwnedAttributeList {
    storage: Vec<usize>,
}

impl OwnedAttributeList {
    fn with_handle_list(handles: &[HANDLE]) -> Result<Self> {
        let mut bytes = 0_usize;
        // SAFETY: the documented size-query call uses a null list and writes only `bytes`.
        unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &raw mut bytes) };
        if bytes == 0 || bytes > 1024 * 1024 {
            return Err(unavailable(
                "The restricted inherited-handle list size is invalid.",
            ));
        }
        let words = bytes.div_ceil(size_of::<usize>());
        let mut result = Self {
            storage: vec![0_usize; words],
        };
        // SAFETY: word storage is suitably aligned and spans at least the queried byte count.
        if unsafe { InitializeProcThreadAttributeList(result.raw(), 1, 0, &raw mut bytes) } == 0 {
            return Err(unavailable(
                "The restricted inherited-handle list could not be initialized.",
            ));
        }
        // SAFETY: both the initialized attribute list and handle slice remain live through process
        // creation; the byte length exactly covers the HANDLE array.
        if unsafe {
            UpdateProcThreadAttribute(
                result.raw(),
                0,
                usize::try_from(PROC_THREAD_ATTRIBUTE_HANDLE_LIST)
                    .map_err(|_| unavailable("Handle-list attribute overflow."))?,
                handles.as_ptr().cast::<c_void>(),
                size_of_val(handles),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(unavailable(
                "The restricted inherited-handle list could not be populated.",
            ));
        }
        Ok(result)
    }

    const fn raw(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast::<c_void>()
    }
}

impl Drop for OwnedAttributeList {
    fn drop(&mut self) {
        if !self.storage.is_empty() {
            // SAFETY: this list was initialized successfully and is deleted exactly once.
            unsafe { DeleteProcThreadAttributeList(self.raw()) };
        }
    }
}

fn create_kill_on_close_job() -> Result<OwnedHandle> {
    // SAFETY: null security/name pointers request an unnamed job with default security.
    let job = OwnedHandle::new(unsafe { CreateJobObjectW(null(), null()) })?;
    let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: job is live and the information pointer/size exactly match the selected class.
    if unsafe {
        SetInformationJobObject(
            job.raw(),
            JobObjectExtendedLimitInformation,
            (&raw const information).cast::<c_void>(),
            u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                .map_err(|_| unavailable("Job information size overflow."))?,
        )
    } == 0
    {
        return Err(unavailable(
            "The descendant-containment job could not be configured.",
        ));
    }
    Ok(job)
}

fn minimal_environment_block() -> Result<Vec<u16>> {
    let system_root = system_windows_directory()?;
    if system_root.is_empty()
        || system_root.len() > MAXIMUM_PATH_UNITS
        || system_root.contains(['\0', '\r', '\n', '='])
    {
        return Err(unavailable("The Windows system-root authority is invalid."));
    }
    let mut block = format!("SystemRoot={system_root}\0")
        .encode_utf16()
        .collect::<Vec<_>>();
    block.push(0);
    Ok(block)
}

fn system_windows_directory() -> Result<String> {
    let mut path = vec![0_u16; MAXIMUM_PATH_UNITS];
    let capacity = u32::try_from(path.len())
        .map_err(|_| unavailable("The Windows directory buffer is invalid."))?;
    // SAFETY: the UTF-16 output buffer is writable for exactly `capacity` code units.
    let length = unsafe { GetSystemWindowsDirectoryW(path.as_mut_ptr(), capacity) };
    if length == 0 || length >= capacity {
        return Err(unavailable(
            "The operating system Windows directory is unavailable.",
        ));
    }
    String::from_utf16(&path[..usize::try_from(length).unwrap_or(path.len())])
        .map_err(|_| unavailable("The operating system Windows directory is invalid."))
}

fn terminate_and_verify_process(process: &OwnedHandle) -> Result<()> {
    // SAFETY: the process handle is uniquely owned by this exchange and the process is still
    // suspended on the only call paths that use this helper.
    if unsafe { TerminateProcess(process.raw(), ERROR_EXIT_CODE) } == 0 {
        return Err(unavailable(
            "The uncontained suspended process could not be terminated.",
        ));
    }
    // SAFETY: bounded wait on the same owned process handle proves termination before returning.
    if unsafe { WaitForSingleObject(process.raw(), CLEANUP_TIMEOUT_MS) } != WAIT_OBJECT_0 {
        return Err(unavailable(
            "The uncontained suspended process termination could not be verified.",
        ));
    }
    Ok(())
}

pub fn verify_signature(input: &SignatureInput) -> Result<SignatureObservation> {
    if input.platform != "win32" || input.architecture != current_architecture() {
        return Err(invalid(
            "The requested signature platform does not match this addon.",
        ));
    }
    validate_cuna_system_component_executable(&input.executable, &input.architecture, None)?;
    let protected_executable = protect_program_files_path(&input.executable, false)?;
    let binary_sha256 = file_sha256_handle(&protected_executable)?;
    let file_version = file_version(&input.executable)?;
    let fingerprint = authenticode_fingerprint(&input.executable)?;
    Ok(SignatureObservation {
        valid: !fingerprint.is_empty(),
        // This is true only while `protected_executable` owns the leaf and every ancestor handle,
        // after owner/DACL, reparse, hard-link, canonical path, volume and file-ID checks pass.
        location_protected: true,
        binary_sha256,
        file_version,
        kind: "authenticode".to_owned(),
        publisher_certificate_fingerprint: fingerprint,
    })
}

#[allow(clippy::too_many_lines)]
pub fn exchange(mut input: ExchangeInput) -> Result<ExchangeResult> {
    exchange_with_fault(&mut input, None, None, true)
}

#[allow(dead_code)]
#[derive(Clone, Copy, Eq, PartialEq)]
enum ExchangeFault {
    BeforeJobCreation,
    BeforeJobAssignment,
}

#[allow(clippy::too_many_lines)]
fn exchange_with_fault(
    input: &mut ExchangeInput,
    fault: Option<ExchangeFault>,
    observed_pid: Option<&std::sync::atomic::AtomicU32>,
    require_cuna_root: bool,
) -> Result<ExchangeResult> {
    #[cfg(not(test))]
    let _ = (fault, observed_pid);
    if input.expected.platform != "win32"
        || input.expected.architecture != current_architecture()
        || input.expected.signature.kind != "authenticode"
    {
        input.request.as_mut().zeroize();
        return Err(invalid(
            "The expected Windows authority identity is invalid.",
        ));
    }
    if require_cuna_root {
        if let Err(error) = validate_cuna_system_component_executable(
            &input.expected.executable,
            &input.expected.architecture,
            Some(&input.expected.package_version),
        ) {
            input.request.as_mut().zeroize();
            return Err(error);
        }
        let executable_parent = Path::new(&input.expected.executable)
            .parent()
            .and_then(Path::to_str);
        if executable_parent != Some(input.expected.working_directory.as_str())
            || executable_parent
                .map(|parent| Path::new(parent).join("cuna-native-bridge.manifest.json"))
                != Some(PathBuf::from(&input.expected.manifest_path))
        {
            input.request.as_mut().zeroize();
            return Err(unavailable(
                "The Windows native bridge metadata is outside its versioned MSI directory.",
            ));
        }
    }

    let protected_request = SecretBytes(input.request.as_ref().to_vec());
    input.request.as_mut().zeroize();

    // Deny write/delete sharing before any identity read and retain the handle until the child has
    // exited. This closes path replacement between admission, CreateProcessW and protected stdin.
    let admitted_executable = protect_program_files_path_with_scope(
        &input.expected.executable,
        false,
        require_cuna_root,
    )?;
    let admitted_file_identity = admitted_executable.leaf_identity;
    if file_sha256_handle(&admitted_executable)? != input.expected.binary_sha256 {
        input.request.as_mut().zeroize();
        return Err(unavailable(
            "The locked native bridge bytes differ from the admitted release.",
        ));
    }
    let executable_wide = wide(&input.expected.executable);
    let working_directory_wide = wide(&input.expected.working_directory);
    let mut stdin_read = null_mut();
    let mut stdin_write = null_mut();
    let mut stdout_read = null_mut();
    let mut stdout_write = null_mut();
    let mut stderr_read = null_mut();
    let mut stderr_write = null_mut();
    let security = SECURITY_ATTRIBUTES {
        nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>())
            .map_err(|_| unavailable("Native structure size overflow."))?,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };

    // SAFETY: all output pointers reference initialized HANDLE slots and `security` remains live.
    let pipes_created = unsafe {
        CreatePipe(
            &raw mut stdin_read,
            &raw mut stdin_write,
            &raw const security,
            0,
        ) != 0
            && CreatePipe(
                &raw mut stdout_read,
                &raw mut stdout_write,
                &raw const security,
                0,
            ) != 0
            && CreatePipe(
                &raw mut stderr_read,
                &raw mut stderr_write,
                &raw const security,
                0,
            ) != 0
    };
    if !pipes_created {
        close_if_valid(stdin_read);
        close_if_valid(stdin_write);
        close_if_valid(stdout_read);
        close_if_valid(stdout_write);
        close_if_valid(stderr_read);
        close_if_valid(stderr_write);
        input.request.as_mut().zeroize();
        return Err(unavailable("The owned process pipes could not be created."));
    }
    let child_stdin = OwnedHandle::new(stdin_read)?;
    let parent_stdin = OwnedHandle::new(stdin_write)?;
    let parent_stdout = OwnedHandle::new(stdout_read)?;
    let child_stdout = OwnedHandle::new(stdout_write)?;
    let parent_stderr = OwnedHandle::new(stderr_read)?;
    let child_stderr = OwnedHandle::new(stderr_write)?;
    // SAFETY: these valid parent handles are made non-inheritable before process creation.
    if unsafe { SetHandleInformation(parent_stdin.raw(), HANDLE_FLAG_INHERIT, 0) } == 0
        || unsafe { SetHandleInformation(parent_stdout.raw(), HANDLE_FLAG_INHERIT, 0) } == 0
        || unsafe { SetHandleInformation(parent_stderr.raw(), HANDLE_FLAG_INHERIT, 0) } == 0
    {
        input.request.as_mut().zeroize();
        return Err(unavailable(
            "The parent pipe handles could not be isolated.",
        ));
    }

    let inherited_handles = [child_stdin.raw(), child_stdout.raw(), child_stderr.raw()];
    let mut attributes = OwnedAttributeList::with_handle_list(&inherited_handles)?;
    let startup_info = STARTUPINFOW {
        cb: u32::try_from(size_of::<STARTUPINFOEXW>())
            .map_err(|_| unavailable("Native structure size overflow."))?,
        dwFlags: STARTF_USESTDHANDLES,
        hStdInput: child_stdin.raw(),
        hStdOutput: child_stdout.raw(),
        hStdError: child_stderr.raw(),
        ..STARTUPINFOW::default()
    };
    let startup = STARTUPINFOEXW {
        StartupInfo: startup_info,
        lpAttributeList: attributes.raw(),
    };
    // An explicit minimal Unicode environment keeps only the non-secret system-root authority
    // required by the Windows runtime. API keys, cloud credentials, proxies, and parent state are
    // never inherited by the signed bridge.
    let mut environment_block = minimal_environment_block()?;
    let mut process_information = PROCESS_INFORMATION::default();
    // SAFETY: application/current-directory strings are NUL terminated, inherited standard
    // handles remain live, and the output structure is valid for the synchronous call.
    let created = unsafe {
        CreateProcessW(
            executable_wide.as_ptr(),
            null_mut(),
            null(),
            null(),
            1,
            CREATE_NO_WINDOW
                | CREATE_SUSPENDED
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            environment_block.as_mut_ptr().cast::<c_void>(),
            working_directory_wide.as_ptr(),
            (&raw const startup).cast::<STARTUPINFOW>(),
            &raw mut process_information,
        )
    };
    drop(child_stdin);
    drop(child_stdout);
    drop(child_stderr);
    if created == 0 {
        input.request.as_mut().zeroize();
        return Err(unavailable(
            "CreateProcessW could not create the native bridge.",
        ));
    }
    let process = OwnedHandle::new(process_information.hProcess)?;
    let thread_handle = OwnedHandle::new(process_information.hThread)?;
    #[cfg(test)]
    if let Some(pid) = observed_pid {
        pid.store(
            process_information.dwProcessId,
            std::sync::atomic::Ordering::SeqCst,
        );
    }
    #[cfg(test)]
    if fault == Some(ExchangeFault::BeforeJobCreation) {
        terminate_and_verify_process(&process)?;
        return Err(unavailable("Injected failure before job creation."));
    }
    let mut job = match create_kill_on_close_job() {
        Ok(job) => job,
        Err(error) => {
            terminate_and_verify_process(&process)?;
            return Err(error);
        }
    };
    #[cfg(test)]
    if fault == Some(ExchangeFault::BeforeJobAssignment) {
        terminate_and_verify_process(&process)?;
        return Err(unavailable("Injected failure before job assignment."));
    }
    // SAFETY: both handles are live and the process is still suspended, so no descendant can race
    // assignment into the kill-on-close containment boundary.
    if unsafe { AssignProcessToJobObject(job.raw(), process.raw()) } == 0 {
        terminate_and_verify_process(&process)?;
        return Err(unavailable(
            "The owned process could not be assigned to descendant containment.",
        ));
    }

    let result = (|| -> Result<ExchangeResult> {
        let loaded_executable = process_image_path(process.raw())?;
        if !same_windows_path(&loaded_executable, &input.expected.executable) {
            return Err(unavailable(
                "The loaded process image path differs from the admitted executable.",
            ));
        }
        let loaded_executable_handle =
            protect_program_files_path_with_scope(&loaded_executable, false, require_cuna_root)?;
        if loaded_executable_handle.leaf_identity != admitted_file_identity {
            return Err(unavailable(
                "The loaded process image file identity differs from the admitted handle.",
            ));
        }
        let binary_sha256 = file_sha256_handle(&loaded_executable_handle)?;
        let observed_version = file_version(&loaded_executable)?;
        let fingerprint = authenticode_fingerprint(&loaded_executable)?;
        if binary_sha256 != input.expected.binary_sha256
            || observed_version != input.expected.file_version
            || fingerprint != input.expected.signature.publisher_certificate_fingerprint
        {
            return Err(unavailable(
                "The loaded process image is not the admitted signed artifact.",
            ));
        }
        let creation_time = process_creation_time(process.raw())?;
        let process_instance_id = format!(
            "win32-handle:{:08X}:{creation_time:016X}:{binary_sha256}",
            process_information.dwProcessId
        );
        // SAFETY: the primary thread handle is live and was returned suspended by CreateProcessW.
        if unsafe { ResumeThread(thread_handle.raw()) } == u32::MAX {
            return Err(unavailable(
                "The verified native bridge could not be resumed.",
            ));
        }
        let stdout_limit = input.maximum_output_bytes;
        let stderr_limit = input.maximum_output_bytes;
        let mut stdin_writer = IoWorker::spawn(move || {
            let result = write_all(parent_stdin.raw(), protected_request.as_slice());
            drop(parent_stdin);
            result
        });
        let mut stdout_reader =
            IoWorker::spawn(move || read_bounded(&parent_stdout, stdout_limit).map(SecretBytes));
        let mut stderr_reader =
            IoWorker::spawn(move || read_bounded(&parent_stderr, stderr_limit).map(SecretBytes));
        // SAFETY: the process handle remains owned and live for the bounded wait.
        let wait = unsafe { WaitForSingleObject(process.raw(), input.timeout_ms) };
        if wait != WAIT_OBJECT_0 {
            // SAFETY: the job contains the verified child and every descendant. Termination closes
            // inherited pipes so bounded joins cannot be held open by a surviving grandchild.
            unsafe { TerminateJobObject(job.raw(), ERROR_EXIT_CODE) };
            // Closing a kill-on-close job is the fallback when explicit termination itself fails.
            // It also prevents any descendant from retaining an inherited pipe during the joins.
            job.close();
            // SAFETY: bounded cleanup wait on the same owned process handle.
            unsafe { WaitForSingleObject(process.raw(), CLEANUP_TIMEOUT_MS) };
            let cleanup_deadline =
                Instant::now() + Duration::from_millis(CLEANUP_TIMEOUT_MS.into());
            let (_stdout, _stderr) = settle_io_workers(
                &mut stdin_writer,
                &mut stdout_reader,
                &mut stderr_reader,
                cleanup_deadline,
            )?;
            return Err(unavailable("The owned native bridge timed out."));
        }
        // The main process may have spawned descendants that inherited pipe handles. End the job
        // before joining I/O so only a fully closed process tree can prove cleanup.
        // SAFETY: job is live and uniquely owned by this exchange.
        let descendants_terminated = unsafe { TerminateJobObject(job.raw(), ERROR_EXIT_CODE) } != 0;
        // Close the job before joining I/O. KILL_ON_JOB_CLOSE is a second, kernel-owned guarantee
        // that no descendant can retain an inherited handle indefinitely.
        job.close();
        let cleanup_deadline = Instant::now() + Duration::from_millis(CLEANUP_TIMEOUT_MS.into());
        let (stdout, stderr) = settle_io_workers(
            &mut stdin_writer,
            &mut stdout_reader,
            &mut stderr_reader,
            cleanup_deadline,
        )?;
        let mut exit_code = 0_u32;
        // SAFETY: the process is signaled and the output pointer is valid.
        if unsafe { GetExitCodeProcess(process.raw(), &raw mut exit_code) } == 0 {
            return Err(unavailable(
                "The owned native bridge exit status is unavailable.",
            ));
        }
        if !descendants_terminated {
            return Err(unavailable(
                "The owned process descendants could not be terminated.",
            ));
        }
        let stderr_present = !stderr.as_slice().is_empty();
        Ok(ExchangeResult {
            exit_code: i32::try_from(exit_code).unwrap_or(-1),
            signal: None,
            stdout: Buffer::from(stdout.into_vec()),
            stderr_present,
            cleanup_proven: true,
            observation: ProcessObservation {
                pid: process_information.dwProcessId,
                platform: "win32".to_owned(),
                architecture: current_architecture().to_owned(),
                executable: loaded_executable,
                binary_sha256,
                file_version: observed_version,
                loaded_image_verified: true,
                process_instance_verified: true,
                process_instance_id,
            },
        })
    })();
    if result.is_err() && job.is_valid() {
        // SAFETY: failure before normal exit terminates the entire uniquely owned job.
        unsafe { TerminateJobObject(job.raw(), ERROR_EXIT_CODE) };
        unsafe { WaitForSingleObject(process.raw(), 2_000) };
    }
    input.request.as_mut().zeroize();
    result
}

fn process_image_path(process: HANDLE) -> Result<String> {
    let mut buffer = vec![0_u16; MAXIMUM_PATH_UNITS];
    let mut length =
        u32::try_from(buffer.len()).map_err(|_| unavailable("Path capacity overflow."))?;
    // SAFETY: the process handle is live, the buffer spans `length` UTF-16 units, and the length
    // output remains valid for the call.
    if unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &raw mut length) } == 0
    {
        return Err(unavailable(
            "The loaded process image path could not be inspected.",
        ));
    }
    buffer.truncate(usize::try_from(length).map_err(|_| unavailable("Path length overflow."))?);
    String::from_utf16(&buffer)
        .map_err(|_| unavailable("The loaded process image path is invalid."))
}

fn validate_cuna_system_component_executable(
    path: &str,
    architecture: &str,
    expected_version: Option<&str>,
) -> Result<()> {
    let program_files = program_files_directory()?;
    let root = PathBuf::from(program_files).join("Cuna").join("Native");
    let relative = Path::new(path)
        .strip_prefix(&root)
        .map_err(|_| unavailable("The Windows native bridge is outside the Cuna MSI root."))?;
    let components = relative
        .components()
        .map(|component| match component {
            Component::Normal(value) => value
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| unavailable("The Cuna MSI path is not Unicode.")),
            _ => Err(unavailable("The Cuna MSI path is not canonical.")),
        })
        .collect::<Result<Vec<_>>>()?;
    if components.len() != 3
        || !valid_package_version(&components[0])
        || expected_version.is_some_and(|version| components[0] != version)
        || components[1] != architecture
        || components[2] != "cuna-native-bridge.exe"
    {
        return Err(unavailable(
            "The Windows native bridge does not match the versioned Cuna MSI layout.",
        ));
    }
    Ok(())
}

fn valid_package_version(value: &str) -> bool {
    let (core, suffix) = if let Some((core, suffix)) = value.split_once('-') {
        (core, Some(suffix))
    } else {
        (value, None)
    };
    let numeric = core.split('.').collect::<Vec<_>>();
    numeric.len() == 3
        && numeric.iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part == &"0" || !part.starts_with('0'))
        })
        && suffix.is_none_or(|suffix| {
            !suffix.is_empty()
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
        })
}

/// Acquire an immutable, ACL-admitted path capability below the OS-owned Program Files root.
///
/// This intentionally rejects npm's global package directory: npm installs are normally owned by
/// the interactive user and cannot authorize secrets or browser launch.  The release seam is an
/// MSI-installed system component below `Program Files\\Cuna`; the registry package may discover
/// that component, but it may never copy or repair it with a lifecycle script.
fn protect_program_files_path(path: &str, directory: bool) -> Result<ProtectedPath> {
    protect_program_files_path_with_scope(path, directory, true)
}

fn protect_program_files_path_with_scope(
    path: &str,
    directory: bool,
    require_cuna_root: bool,
) -> Result<ProtectedPath> {
    let program_files = program_files_directory()?;
    let root_prefix = if require_cuna_root {
        format!("{}\\Cuna\\", program_files.trim_end_matches(['\\', '/']))
    } else {
        format!("{}\\", program_files.trim_end_matches(['\\', '/']))
    };
    if path.contains('/')
        || !path.starts_with(&root_prefix)
        || Path::new(path)
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(unavailable(
            "The native artifact is not below the operating-system Program Files authority.",
        ));
    }

    let suffix = path
        .strip_prefix(&root_prefix)
        .ok_or_else(|| unavailable("The protected native path prefix is invalid."))?;
    let components = Path::new(suffix)
        .components()
        .map(|component| match component {
            Component::Normal(value) => Ok(value.to_owned()),
            _ => Err(unavailable("The protected native path is not canonical.")),
        })
        .collect::<Result<Vec<_>>>()?;
    if components.is_empty() {
        return Err(unavailable("The protected native path has no leaf."));
    }

    let trusted_installer = trusted_installer_sid()?;
    let mut current = if require_cuna_root {
        PathBuf::from(&program_files).join("Cuna")
    } else {
        PathBuf::from(&program_files)
    };
    let mut chain = Vec::with_capacity(components.len() + 1);
    let root = open_locked_path(&program_files, true)?;
    let root_identity = inspect_protected_handle(&root, &program_files, true, &trusted_installer)?;
    let root_volume = root_identity.volume_serial;
    chain.push(root);
    if require_cuna_root {
        let cuna_root = current
            .to_str()
            .ok_or_else(|| unavailable("The Cuna system-component root is not Unicode."))?;
        let cuna_handle = open_locked_path(cuna_root, true)?;
        let cuna_identity =
            inspect_protected_handle(&cuna_handle, cuna_root, true, &trusted_installer)?;
        if cuna_identity.volume_serial != root_volume {
            return Err(unavailable(
                "The Cuna system-component root crosses a volume boundary.",
            ));
        }
        chain.push(cuna_handle);
    }

    let mut leaf_identity = root_identity;
    let mut leaf_size = 0_u64;
    for (index, component) in components.iter().enumerate() {
        current.push(component);
        let is_leaf = index + 1 == components.len();
        let is_directory = !is_leaf || directory;
        let expected = current
            .to_str()
            .ok_or_else(|| unavailable("The protected native path is not Unicode."))?;
        let handle = open_locked_path(expected, is_directory)?;
        let identity =
            inspect_protected_handle(&handle, expected, is_directory, &trusted_installer)?;
        if identity.volume_serial != root_volume {
            return Err(unavailable(
                "The protected native path crosses an unexpected volume boundary.",
            ));
        }
        if is_leaf {
            let information = file_information(handle.raw())?;
            leaf_size =
                (u64::from(information.nFileSizeHigh) << 32) | u64::from(information.nFileSizeLow);
            leaf_identity = identity;
        }
        chain.push(handle);
    }
    Ok(ProtectedPath {
        chain,
        leaf_identity,
        leaf_size,
    })
}

fn program_files_directory() -> Result<String> {
    let mut raw = null_mut();
    let folder_id = FOLDERID_ProgramFiles;
    // SAFETY: SHGetKnownFolderPath allocates one NUL-terminated string for this process; the
    // wrapper frees it with CoTaskMemFree after copying.
    let status = unsafe { SHGetKnownFolderPath(&raw const folder_id, 0, null_mut(), &raw mut raw) };
    if status < 0 || raw.is_null() {
        return Err(unavailable(
            "The operating-system Program Files authority is unavailable.",
        ));
    }
    let owned = KnownFolderPath(raw);
    let mut length = 0_usize;
    // SAFETY: the API promises a NUL-terminated string.  The explicit global path bound prevents
    // an unbounded scan if the contract is violated by the OS.
    while length < MAXIMUM_PATH_UNITS && unsafe { *owned.0.add(length) } != 0 {
        length += 1;
    }
    if length == 0 || length == MAXIMUM_PATH_UNITS {
        return Err(unavailable(
            "The operating-system Program Files path is invalid.",
        ));
    }
    // SAFETY: the preceding scan proved exactly `length` initialized non-NUL code units.
    String::from_utf16(unsafe { std::slice::from_raw_parts(owned.0, length) })
        .map_err(|_| unavailable("The operating-system Program Files path is invalid."))
}

fn open_locked_path(path: &str, directory: bool) -> Result<OwnedHandle> {
    let path = wide(path);
    let flags = FILE_FLAG_OPEN_REPARSE_POINT
        | if directory {
            FILE_FLAG_BACKUP_SEMANTICS
        } else {
            FILE_ATTRIBUTE_NORMAL
        };
    // SAFETY: path is NUL-terminated.  Omitting FILE_SHARE_WRITE and FILE_SHARE_DELETE blocks
    // content mutation, rename, hard-link deletion and ancestor replacement for this handle's
    // complete RAII lifetime.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            if directory {
                READ_CONTROL | FILE_READ_ATTRIBUTES
            } else {
                GENERIC_READ | READ_CONTROL
            },
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            flags,
            null_mut(),
        )
    };
    OwnedHandle::new(handle)
        .map_err(|_| unavailable("The protected native path could not be locked."))
}

fn inspect_protected_handle(
    handle: &OwnedHandle,
    expected_path: &str,
    directory: bool,
    trusted_installer: &OwnedLocalMemory,
) -> Result<FileIdentity> {
    let information = file_information(handle.raw())?;
    let is_directory = information.dwFileAttributes
        & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_DIRECTORY
        != 0;
    if is_directory != directory
        || information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (!directory && information.nNumberOfLinks != 1)
    {
        return Err(unavailable(
            "The protected native path is a reparse point, hard link, or unexpected file type.",
        ));
    }
    if !same_windows_path(&final_path(handle.raw())?, expected_path) {
        return Err(unavailable(
            "The protected native handle resolves to a different canonical path.",
        ));
    }
    verify_owner_and_dacl(handle.raw(), trusted_installer)?;
    Ok(FileIdentity {
        volume_serial: information.dwVolumeSerialNumber,
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
    })
}

fn file_information(handle: HANDLE) -> Result<BY_HANDLE_FILE_INFORMATION> {
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: handle is live and the output is valid for the synchronous call.
    if unsafe { GetFileInformationByHandle(handle, &raw mut information) } == 0 {
        return Err(unavailable(
            "The protected native file identity could not be inspected.",
        ));
    }
    Ok(information)
}

fn final_path(handle: HANDLE) -> Result<String> {
    let mut buffer = vec![0_u16; MAXIMUM_PATH_UNITS];
    let capacity = u32::try_from(buffer.len())
        .map_err(|_| unavailable("The canonical path buffer is invalid."))?;
    // SAFETY: handle is live and the output buffer spans `capacity` UTF-16 units.
    let length = unsafe {
        GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), capacity, VOLUME_NAME_DOS)
    };
    if length == 0 || length >= capacity {
        return Err(unavailable(
            "The protected native canonical path is unavailable.",
        ));
    }
    buffer.truncate(usize::try_from(length).map_err(|_| unavailable("Path length overflow."))?);
    let value = String::from_utf16(&buffer)
        .map_err(|_| unavailable("The protected native canonical path is invalid."))?;
    Ok(value.strip_prefix(r"\\?\").unwrap_or(&value).to_owned())
}

fn trusted_installer_sid() -> Result<OwnedLocalMemory> {
    let sid_text = wide(TRUSTED_INSTALLER_SID);
    let mut sid: PSID = null_mut();
    // SAFETY: sid_text is NUL-terminated and `sid` receives one LocalAlloc allocation.
    if unsafe { ConvertStringSidToSidW(sid_text.as_ptr(), &raw mut sid) } == 0 || sid.is_null() {
        return Err(unavailable(
            "The TrustedInstaller SID authority is unavailable.",
        ));
    }
    Ok(OwnedLocalMemory(sid))
}

fn privileged_sid(sid: PSID, trusted_installer: &OwnedLocalMemory) -> bool {
    // SAFETY: callers pass a SID view backed by a live security descriptor or LocalAlloc block;
    // validation occurs before any equality or well-known-SID query.
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return false;
    }
    // SAFETY: every SID comes from a validated security descriptor or LocalAlloc allocation that
    // remains live through this check.
    unsafe {
        IsWellKnownSid(sid, WinLocalSystemSid) != 0
            || IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != 0
            || windows_sys::Win32::Security::EqualSid(sid, trusted_installer.0) != 0
    }
}

fn verify_owner_and_dacl(handle: HANDLE, trusted_installer: &OwnedLocalMemory) -> Result<()> {
    let mut owner: PSID = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: all outputs are initialized; the returned descriptor owns the SID/ACL views and is
    // retained until every ACE inspection completes.
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &raw mut owner,
            null_mut(),
            &raw mut dacl,
            null_mut(),
            &raw mut descriptor,
        )
    };
    if status != 0 || descriptor.is_null() || dacl.is_null() {
        return Err(unavailable(
            "The protected native owner or DACL is unavailable.",
        ));
    }
    let _descriptor = OwnedLocalMemory(descriptor);
    if !privileged_sid(owner, trusted_installer) {
        return Err(unavailable(
            "The protected native path owner is not an admitted system principal.",
        ));
    }

    verify_dacl_write_grants(dacl, trusted_installer)
}

fn verify_dacl_write_grants(dacl: *mut ACL, trusted_installer: &OwnedLocalMemory) -> Result<()> {
    let mut size = ACL_SIZE_INFORMATION::default();
    // SAFETY: dacl points inside the live descriptor and size has the exact requested layout.
    if unsafe {
        GetAclInformation(
            dacl,
            (&raw mut size).cast::<c_void>(),
            u32::try_from(size_of::<ACL_SIZE_INFORMATION>())
                .map_err(|_| unavailable("ACL information size overflow."))?,
            AclSizeInformation,
        )
    } == 0
    {
        return Err(unavailable("The protected native DACL is invalid."));
    }
    for index in 0..size.AceCount {
        let mut raw_ace = null_mut();
        // SAFETY: GetAce validates the index against the live ACL.
        if unsafe { GetAce(dacl, index, &raw mut raw_ace) } == 0 || raw_ace.is_null() {
            return Err(unavailable("The protected native DACL ACE is invalid."));
        }
        // SAFETY: every ACE begins with ACE_HEADER and GetAce returned a live ACE pointer.
        let header = unsafe { &*raw_ace.cast::<windows_sys::Win32::Security::ACE_HEADER>() };
        if u32::from(header.AceFlags) & INHERIT_ONLY_ACE != 0 {
            continue;
        }
        let allowed = matches!(
            u32::from(header.AceType),
            ACCESS_ALLOWED_ACE_TYPE | ACCESS_ALLOWED_OBJECT_ACE_TYPE | 4 | 9 | 11
        );
        if !allowed {
            continue;
        }
        if usize::from(header.AceSize) < size_of::<ACCESS_ALLOWED_ACE>() + 4 {
            return Err(unavailable(
                "The protected native allowed ACE is truncated.",
            ));
        }
        // Every access-allowed ACE family has its mask immediately after ACE_HEADER.
        // SAFETY: the preceding size check proves the mask word is present and aligned at byte 4.
        let mask = unsafe {
            raw_ace
                .cast::<u8>()
                .add(size_of::<windows_sys::Win32::Security::ACE_HEADER>())
                .cast::<u32>()
                .read_unaligned()
        };
        if mask & APPLICABLE_WRITE_RIGHTS == 0 {
            continue;
        }
        if u32::from(header.AceType) != ACCESS_ALLOWED_ACE_TYPE {
            // Conditional/object-specific grants are not simple trustee grants; admitting them
            // would require evaluating their object GUID and condition expression. Fail closed.
            return Err(unavailable(
                "The protected native DACL contains a conditional write grant.",
            ));
        }
        // SAFETY: ACCESS_ALLOWED_ACE was size-checked and SidStart begins its variable SID bytes.
        let ace = raw_ace.cast::<ACCESS_ALLOWED_ACE>();
        let sid = unsafe { (&raw const (*ace).SidStart).cast_mut().cast::<c_void>() };
        // SAFETY: the ACE has at least a SID header; IsValidSid/GetLengthSid inspect the SID while
        // the descriptor remains live. The explicit length comparison confines it to this ACE.
        if unsafe { IsValidSid(sid) } == 0
            || usize::try_from(unsafe { GetLengthSid(sid) }).unwrap_or(usize::MAX)
                > usize::from(header.AceSize).saturating_sub(8)
        {
            return Err(unavailable(
                "The protected native DACL trustee SID is invalid.",
            ));
        }
        if !privileged_sid(sid, trusted_installer) {
            return Err(unavailable(
                "The protected native DACL grants mutation to an untrusted principal.",
            ));
        }
    }
    Ok(())
}

fn file_sha256_handle(path: &ProtectedPath) -> Result<String> {
    if path.leaf_size > MAXIMUM_AUTHORITY_BINARY_BYTES {
        return Err(unavailable(
            "The protected native binary exceeds its size bound.",
        ));
    }
    let leaf = path
        .chain
        .last()
        .ok_or_else(|| unavailable("The protected native path has no leaf handle."))?;
    let mut position = 0_i64;
    // SAFETY: leaf is a synchronous readable file handle and position is an initialized output.
    if unsafe {
        windows_sys::Win32::Storage::FileSystem::SetFilePointerEx(
            leaf.raw(),
            0,
            &raw mut position,
            windows_sys::Win32::Storage::FileSystem::FILE_BEGIN,
        )
    } == 0
    {
        return Err(unavailable(
            "The protected native binary could not be rewound.",
        ));
    }
    let before = file_information(leaf.raw())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let mut read = 0_u32;
        // SAFETY: the buffer is writable for its full u32-bounded length and leaf is live.
        if unsafe {
            ReadFile(
                leaf.raw(),
                buffer.as_mut_ptr(),
                u32::try_from(buffer.len()).map_err(|_| unavailable("Hash buffer overflow."))?,
                &raw mut read,
                null_mut(),
            )
        } == 0
        {
            buffer.zeroize();
            return Err(unavailable(
                "The protected native binary could not be hashed.",
            ));
        }
        if read == 0 {
            break;
        }
        let read = usize::try_from(read).map_err(|_| unavailable("Hash read overflow."))?;
        total = total
            .checked_add(u64::try_from(read).map_err(|_| unavailable("Hash size overflow."))?)
            .ok_or_else(|| unavailable("Hash size overflow."))?;
        if total > MAXIMUM_AUTHORITY_BINARY_BYTES {
            buffer.zeroize();
            return Err(unavailable(
                "The protected native binary exceeds its size bound.",
            ));
        }
        hasher.update(&buffer[..read]);
    }
    buffer.zeroize();
    let after = file_information(leaf.raw())?;
    if total != path.leaf_size
        || file_identity_from_information(&before) != file_identity_from_information(&after)
        || before.nFileSizeHigh != after.nFileSizeHigh
        || before.nFileSizeLow != after.nFileSizeLow
        || before.ftLastWriteTime.dwHighDateTime != after.ftLastWriteTime.dwHighDateTime
        || before.ftLastWriteTime.dwLowDateTime != after.ftLastWriteTime.dwLowDateTime
    {
        return Err(unavailable(
            "The protected native binary changed while it was being hashed.",
        ));
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn file_identity_from_information(information: &BY_HANDLE_FILE_INFORMATION) -> FileIdentity {
    FileIdentity {
        volume_serial: information.dwVolumeSerialNumber,
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
    }
}

fn process_creation_time(process: HANDLE) -> Result<u64> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: the process handle is live and all FILETIME outputs are initialized.
    if unsafe {
        GetProcessTimes(
            process,
            &raw mut creation,
            &raw mut exit,
            &raw mut kernel,
            &raw mut user,
        )
    } == 0
    {
        return Err(unavailable(
            "The process-instance creation identity is unavailable.",
        ));
    }
    Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
}

fn file_version(path: &str) -> Result<String> {
    let path = wide(path);
    let mut ignored = 0_u32;
    // SAFETY: path is a live NUL-terminated UTF-16 string and the output pointer is valid.
    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), &raw mut ignored) };
    if size == 0 || size > 16 * 1024 * 1024 {
        return Err(unavailable("The executable file version is unavailable."));
    }
    let mut bytes =
        vec![0_u8; usize::try_from(size).map_err(|_| unavailable("Version size overflow."))?];
    // SAFETY: the output buffer spans exactly `size` bytes.
    if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, bytes.as_mut_ptr().cast::<c_void>()) }
        == 0
    {
        bytes.zeroize();
        return Err(unavailable(
            "The executable file version could not be read.",
        ));
    }
    let root = wide("\\");
    let mut value: *mut c_void = null_mut();
    let mut length = 0_u32;
    // SAFETY: version bytes are live, the root query is NUL terminated, and outputs are valid.
    if unsafe {
        VerQueryValueW(
            bytes.as_ptr().cast::<c_void>(),
            root.as_ptr(),
            &raw mut value,
            &raw mut length,
        )
    } == 0
        || value.is_null()
        || usize::try_from(length).unwrap_or(0) < size_of::<VsFixedFileInfo>()
    {
        bytes.zeroize();
        return Err(unavailable("The executable fixed file version is invalid."));
    }
    // SAFETY: VerQueryValueW returned at least one complete VS_FIXEDFILEINFO structure.
    let info = unsafe { *(value.cast::<VsFixedFileInfo>()) };
    bytes.zeroize();
    if info.signature != VS_FIXEDFILEINFO_SIGNATURE {
        return Err(unavailable(
            "The executable fixed file version signature is invalid.",
        ));
    }
    Ok(format!(
        "{}.{}.{}.{}",
        info.file_version_ms >> 16,
        info.file_version_ms & 0xffff,
        info.file_version_ls >> 16,
        info.file_version_ls & 0xffff
    ))
}

fn authenticode_fingerprint(path: &str) -> Result<String> {
    let path = wide(path);
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: u32::try_from(size_of::<WINTRUST_FILE_INFO>())
            .map_err(|_| unavailable("Native trust structure size overflow."))?,
        pcwszFilePath: path.as_ptr(),
        hFile: null_mut(),
        pgKnownSubject: null_mut(),
    };
    let mut data = WINTRUST_DATA {
        cbStruct: u32::try_from(size_of::<WINTRUST_DATA>())
            .map_err(|_| unavailable("Native trust structure size overflow."))?,
        dwUIChoice: WTD_UI_NONE,
        // WinVerifyTrust validates the embedded Authenticode chain and timestamp. Revocation is
        // deliberately not fetched at runtime: release admission owns the offline revocation and
        // publisher-certificate evidence, while this addon must work without an ambient network.
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwProvFlags: WTD_REVOCATION_CHECK_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 {
            pFile: &raw mut file,
        },
        dwStateAction: WTD_STATEACTION_VERIFY,
        ..WINTRUST_DATA::default()
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    // SAFETY: `data` and its file union member reference live, correctly sized structures.
    let trust_status = unsafe {
        WinVerifyTrust(
            null_mut(),
            &raw mut action,
            (&raw mut data).cast::<c_void>(),
        )
    };
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    // SAFETY: closes the WinVerifyTrust state created by the immediately preceding verification.
    unsafe {
        WinVerifyTrust(
            null_mut(),
            &raw mut action,
            (&raw mut data).cast::<c_void>(),
        )
    };
    if trust_status != 0 {
        return Err(unavailable(&format!(
            "Authenticode verification rejected the executable (0x{trust_status:08X})."
        )));
    }
    signer_fingerprint(&path)
}

fn signer_fingerprint(path: &[u16]) -> Result<String> {
    let mut encoding = 0_u32;
    let mut content = 0_u32;
    let mut format = 0_u32;
    let mut store: HCERTSTORE = null_mut();
    let mut message: *mut c_void = null_mut();
    // SAFETY: the object pointer references a live NUL-terminated UTF-16 path; every output slot
    // is initialized and owned by this function on success.
    if unsafe {
        CryptQueryObject(
            CERT_QUERY_OBJECT_FILE,
            path.as_ptr().cast::<c_void>(),
            CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
            CERT_QUERY_FORMAT_FLAG_BINARY,
            0,
            &raw mut encoding,
            &raw mut content,
            &raw mut format,
            &raw mut store,
            &raw mut message,
            null_mut(),
        )
    } == 0
    {
        return Err(unavailable(
            "The Authenticode signer certificate is unavailable.",
        ));
    }
    let result = (|| -> Result<String> {
        let mut signer_size = 0_u32;
        // SAFETY: `message` is the live handle returned by CryptQueryObject.
        if unsafe {
            CryptMsgGetParam(
                message,
                CMSG_SIGNER_INFO_PARAM,
                0,
                null_mut(),
                &raw mut signer_size,
            )
        } == 0
            || signer_size < u32::try_from(size_of::<CMSG_SIGNER_INFO>()).unwrap_or(u32::MAX)
            || signer_size > 1024 * 1024
        {
            return Err(unavailable("The Authenticode signer record is invalid."));
        }
        let signer_words = usize::try_from(signer_size)
            .map_err(|_| unavailable("Signer size overflow."))?
            .div_ceil(size_of::<u64>());
        let mut signer_bytes = vec![0_u64; signer_words];
        // SAFETY: the word-aligned signer buffer spans at least `signer_size` bytes.
        if unsafe {
            CryptMsgGetParam(
                message,
                CMSG_SIGNER_INFO_PARAM,
                0,
                signer_bytes.as_mut_ptr().cast::<c_void>(),
                &raw mut signer_size,
            )
        } == 0
        {
            signer_bytes.zeroize();
            return Err(unavailable(
                "The Authenticode signer record could not be read.",
            ));
        }
        // SAFETY: the size check above proves the returned buffer contains CMSG_SIGNER_INFO.
        let signer = unsafe { &*(signer_bytes.as_ptr().cast::<CMSG_SIGNER_INFO>()) };
        let search = CERT_INFO {
            Issuer: signer.Issuer,
            SerialNumber: signer.SerialNumber,
            ..CERT_INFO::default()
        };
        // SAFETY: `store` is live and `search` borrows issuer/serial blobs from signer_bytes,
        // which remains live through the lookup.
        let certificate = unsafe {
            CertFindCertificateInStore(
                store,
                X509_ASN_ENCODING | PKCS_7_ASN_ENCODING,
                0,
                CERT_FIND_SUBJECT_CERT,
                (&raw const search).cast::<c_void>(),
                null(),
            )
        };
        if certificate.is_null() {
            signer_bytes.zeroize();
            return Err(unavailable(
                "The Authenticode signing certificate was not found.",
            ));
        }
        let fingerprint = certificate_sha1(certificate);
        // SAFETY: the context is the exact value returned by CertFindCertificateInStore.
        unsafe { CertFreeCertificateContext(certificate) };
        signer_bytes.zeroize();
        fingerprint
    })();
    // SAFETY: these are the exact resources returned by CryptQueryObject.
    unsafe {
        if !message.is_null() {
            CryptMsgClose(message);
        }
        if !store.is_null() {
            CertCloseStore(store, 0);
        }
    }
    result
}

fn certificate_sha1(certificate: *const CERT_CONTEXT) -> Result<String> {
    let mut length = 0_u32;
    // SAFETY: certificate is a live context and the null output queries the required size.
    if unsafe {
        CertGetCertificateContextProperty(
            certificate,
            CERT_SHA1_HASH_PROP_ID,
            null_mut(),
            &raw mut length,
        )
    } == 0
        || length != 20
    {
        return Err(unavailable(
            "The Authenticode certificate fingerprint is invalid.",
        ));
    }
    let mut bytes = [0_u8; 20];
    // SAFETY: the fixed buffer spans the required SHA-1 certificate property length.
    if unsafe {
        CertGetCertificateContextProperty(
            certificate,
            CERT_SHA1_HASH_PROP_ID,
            bytes.as_mut_ptr().cast::<c_void>(),
            &raw mut length,
        )
    } == 0
    {
        bytes.zeroize();
        return Err(unavailable(
            "The Authenticode certificate fingerprint could not be read.",
        ));
    }
    let fingerprint = bytes
        .iter()
        .fold(String::with_capacity(40), |mut output, byte| {
            let _ = write!(output, "{byte:02X}");
            output
        });
    bytes.zeroize();
    Ok(fingerprint)
}

fn write_all(handle: HANDLE, bytes: &[u8]) -> Result<()> {
    let mut offset = 0_usize;
    while offset < bytes.len() {
        let remaining = bytes.len() - offset;
        let count = u32::try_from(remaining).map_err(|_| invalid("The request is too large."))?;
        let mut written = 0_u32;
        // SAFETY: the pipe handle is live and the input slice spans `count` bytes.
        if unsafe {
            WriteFile(
                handle,
                bytes[offset..].as_ptr(),
                count,
                &raw mut written,
                null_mut(),
            )
        } == 0
            || written == 0
        {
            return Err(unavailable(
                "Protected stdin could not be delivered to the owned process.",
            ));
        }
        offset += usize::try_from(written).map_err(|_| unavailable("Write size overflow."))?;
    }
    Ok(())
}

fn read_bounded(handle: &OwnedHandle, maximum: u32) -> Result<Vec<u8>> {
    let mut result = Vec::new();
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let mut read = 0_u32;
        // SAFETY: the pipe handle is owned by this thread and the output buffer is valid.
        let succeeded = unsafe {
            ReadFile(
                handle.raw(),
                buffer.as_mut_ptr(),
                u32::try_from(buffer.len()).map_err(|_| unavailable("Read size overflow."))?,
                &raw mut read,
                null_mut(),
            )
        };
        if succeeded == 0 || read == 0 {
            break;
        }
        let read = usize::try_from(read).map_err(|_| unavailable("Read size overflow."))?;
        if result.len().saturating_add(read) > usize::try_from(maximum).unwrap_or(usize::MAX) {
            result.zeroize();
            buffer.zeroize();
            return Err(unavailable(
                "The native process output exceeded its admitted bound.",
            ));
        }
        result.extend_from_slice(&buffer[..read]);
    }
    buffer.zeroize();
    Ok(result)
}

fn same_windows_path(left: &str, right: &str) -> bool {
    left.replace('/', "\\")
        .eq_ignore_ascii_case(&right.replace('/', "\\"))
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn close_if_valid(handle: HANDLE) {
    if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
        // SAFETY: used only during partial pipe construction before ownership wrappers exist.
        unsafe { CloseHandle(handle) };
    }
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

#[cfg(test)]
mod tests {
    use std::env;
    use std::ffi::c_void;
    use std::fs;
    use std::mem::size_of;
    use std::path::PathBuf;
    use std::process::Command;
    use std::ptr::null_mut;
    use std::sync::atomic::AtomicU32;
    use std::sync::{Mutex, MutexGuard, PoisonError};
    use std::time::{Duration, Instant};

    use napi::bindgen_prelude::Buffer;
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_INVALID_PARAMETER, GetLastError, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::Security::{
        ACL, ACL_REVISION, AddAccessAllowedAceEx, AddAccessDeniedAceEx, CreateWellKnownSid, GetAce,
        INHERIT_ONLY_ACE, InitializeAcl, SECURITY_MAX_SID_SIZE, WinLocalSystemSid, WinWorldSid,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };

    use super::{
        ExchangeFault, FILE_WRITE_DATA, GENERIC_READ, authenticode_fingerprint,
        exchange_with_fault, file_sha256_handle, file_version, inspect_protected_handle,
        minimal_environment_block, open_locked_path, program_files_directory,
        protect_program_files_path, protect_program_files_path_with_scope,
        system_windows_directory, trusted_installer_sid, validate_cuna_system_component_executable,
        verify_dacl_write_grants,
    };
    use crate::{ExchangeInput, ExpectedDescriptor, ExpectedSignature};

    static NATIVE_REAL_HOST_TEST: Mutex<()> = Mutex::new(());
    const REAL_HOST_OPERATION_BOUND: Duration = Duration::from_secs(15);

    struct EnvironmentRestore {
        name: &'static str,
        value: Option<std::ffi::OsString>,
    }

    impl EnvironmentRestore {
        fn replace(name: &'static str, value: &str) -> Self {
            let original = env::var_os(name);
            // SAFETY: every real-host test is serialized by NATIVE_REAL_HOST_TEST and the guard
            // restores the process environment before releasing that mutex.
            unsafe { env::set_var(name, value) };
            Self {
                name,
                value: original,
            }
        }
    }

    impl Drop for EnvironmentRestore {
        fn drop(&mut self) {
            // SAFETY: the serial real-host-test guard still precedes this guard on the stack.
            unsafe {
                if let Some(value) = self.value.as_ref() {
                    env::set_var(self.name, value);
                } else {
                    env::remove_var(self.name);
                }
            }
        }
    }

    fn native_real_host_test() -> MutexGuard<'static, ()> {
        NATIVE_REAL_HOST_TEST
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn signed_node_executable() -> PathBuf {
        PathBuf::from(env::var_os("ProgramFiles").unwrap_or_else(|| "C:\\Program Files".into()))
            .join("nodejs")
            .join("node.exe")
    }

    fn unique_temporary_directory(label: &str) -> PathBuf {
        let unique = format!(
            "cuna-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        env::temp_dir().join(unique)
    }

    fn well_known_sid(kind: i32) -> napi::Result<Vec<usize>> {
        let bytes = usize::try_from(SECURITY_MAX_SID_SIZE)
            .map_err(|_| crate::unavailable("The SID fixture size is invalid."))?;
        let mut storage = vec![0_usize; bytes.div_ceil(size_of::<usize>())];
        let mut size = SECURITY_MAX_SID_SIZE;
        // SAFETY: word storage is aligned and spans SECURITY_MAX_SID_SIZE bytes; size is a live
        // in/out value and a null domain SID is required for well-known SIDs.
        if unsafe {
            CreateWellKnownSid(
                kind,
                null_mut(),
                storage.as_mut_ptr().cast::<c_void>(),
                &raw mut size,
            )
        } == 0
        {
            return Err(crate::unavailable(
                "The well-known SID fixture could not be created.",
            ));
        }
        Ok(storage)
    }

    fn acl_fixture(entries: &[(bool, u32, u32, i32)]) -> napi::Result<Vec<usize>> {
        let bytes = 1024_usize;
        let mut storage = vec![0_usize; bytes.div_ceil(size_of::<usize>())];
        let acl = storage.as_mut_ptr().cast::<ACL>();
        // SAFETY: word storage is aligned and spans the declared ACL byte length.
        if unsafe {
            InitializeAcl(
                acl,
                u32::try_from(bytes).map_err(|_| crate::unavailable("ACL fixture overflow."))?,
                ACL_REVISION,
            )
        } == 0
        {
            return Err(crate::unavailable(
                "The ACL fixture could not be initialized.",
            ));
        }
        for &(allow, flags, mask, sid_kind) in entries {
            let mut sid = well_known_sid(sid_kind)?;
            // SAFETY: ACL storage and the validated well-known SID remain live for this call.
            let added = unsafe {
                if allow {
                    AddAccessAllowedAceEx(
                        acl,
                        ACL_REVISION,
                        flags,
                        mask,
                        sid.as_mut_ptr().cast::<c_void>(),
                    )
                } else {
                    AddAccessDeniedAceEx(
                        acl,
                        ACL_REVISION,
                        flags,
                        mask,
                        sid.as_mut_ptr().cast::<c_void>(),
                    )
                }
            };
            if added == 0 {
                return Err(crate::unavailable(
                    "The ACL fixture ACE could not be added.",
                ));
            }
        }
        Ok(storage)
    }

    fn expected_node() -> napi::Result<ExpectedDescriptor> {
        let executable = signed_node_executable();
        let executable = executable
            .to_str()
            .ok_or_else(|| crate::unavailable("The Windows system path is not Unicode."))?
            .to_owned();
        let binary_sha256 = file_sha256_handle(&protect_program_files_path_with_scope(
            &executable,
            false,
            false,
        )?)?;
        let observed_version = file_version(&executable)?;
        let fingerprint = authenticode_fingerprint(&executable)?;
        Ok(ExpectedDescriptor {
            protocol: "cuna.native-bridge.v1".to_owned(),
            platform: "win32".to_owned(),
            architecture: super::current_architecture().to_owned(),
            package_version: "test-only".to_owned(),
            native_version: "test-only".to_owned(),
            file_version: observed_version,
            executable,
            working_directory: env::temp_dir().to_string_lossy().into_owned(),
            manifest_path: "test-only".to_owned(),
            maximum_credential_bytes: 16 * 1024,
            binary_sha256,
            manifest_sha256: "0".repeat(64),
            sbom_sha256: "0".repeat(64),
            provenance_sha256: "0".repeat(64),
            signature: ExpectedSignature {
                kind: "authenticode".to_owned(),
                publisher_certificate_fingerprint: fingerprint,
            },
        })
    }

    fn exchange_program_files_test(
        mut input: ExchangeInput,
    ) -> napi::Result<crate::ExchangeResult> {
        exchange_with_fault(&mut input, None, None, false)
    }

    #[test]
    fn signed_owned_process_exchange_binds_identity_before_stdin() -> napi::Result<()> {
        let _guard = native_real_host_test();
        let request = b"console.log('cuna-authority');process.exit(0)\r\n".to_vec();
        let result = exchange_program_files_test(ExchangeInput {
            expected: expected_node()?,
            request: Buffer::from(request),
            timeout_ms: 10_000,
            maximum_output_bytes: 4 * 1024,
        })?;

        assert_eq!(result.exit_code, 0);
        assert!(result.cleanup_proven);
        assert!(result.observation.loaded_image_verified);
        assert!(result.observation.process_instance_verified);
        assert!(
            result
                .observation
                .process_instance_id
                .starts_with("win32-handle:")
        );
        assert!(
            String::from_utf8_lossy(result.stdout.as_ref()).contains("cuna-authority"),
            "the protected stdin command did not execute"
        );
        Ok(())
    }

    #[test]
    fn production_exchange_rejects_a_signed_binary_outside_the_cuna_msi_root() -> napi::Result<()> {
        let _guard = native_real_host_test();
        let result = crate::exchange(ExchangeInput {
            expected: expected_node()?,
            request: Buffer::from(b"console.log('must-not-run')\r\n".to_vec()),
            timeout_ms: 10_000,
            maximum_output_bytes: 4 * 1024,
        });
        let Err(error) = result else {
            panic!("production exchange admitted a non-Cuna Program Files binary");
        };
        assert!(error.reason.contains("Cuna MSI root"));
        Ok(())
    }

    #[test]
    fn dacl_parser_causally_rejects_every_untrusted_or_ambiguous_write_grant() -> napi::Result<()> {
        let trusted_installer = trusted_installer_sid()?;
        let safe_read = acl_fixture(&[(true, 0, GENERIC_READ, WinWorldSid)])?;
        assert!(
            verify_dacl_write_grants(
                safe_read.as_ptr().cast_mut().cast::<ACL>(),
                &trusted_installer,
            )
            .is_ok()
        );

        let trusted_write = acl_fixture(&[(true, 0, FILE_WRITE_DATA, WinLocalSystemSid)])?;
        assert!(
            verify_dacl_write_grants(
                trusted_write.as_ptr().cast_mut().cast::<ACL>(),
                &trusted_installer,
            )
            .is_ok()
        );

        let inherited_only =
            acl_fixture(&[(true, INHERIT_ONLY_ACE, FILE_WRITE_DATA, WinWorldSid)])?;
        assert!(
            verify_dacl_write_grants(
                inherited_only.as_ptr().cast_mut().cast::<ACL>(),
                &trusted_installer,
            )
            .is_ok()
        );

        let untrusted_write = acl_fixture(&[(true, 0, FILE_WRITE_DATA, WinWorldSid)])?;
        assert!(
            verify_dacl_write_grants(
                untrusted_write.as_ptr().cast_mut().cast::<ACL>(),
                &trusted_installer,
            )
            .is_err()
        );

        let deny_then_allow = acl_fixture(&[
            (false, 0, FILE_WRITE_DATA, WinWorldSid),
            (true, 0, FILE_WRITE_DATA, WinWorldSid),
        ])?;
        assert!(
            verify_dacl_write_grants(
                deny_then_allow.as_ptr().cast_mut().cast::<ACL>(),
                &trusted_installer,
            )
            .is_err()
        );

        let mut conditional = acl_fixture(&[(true, 0, FILE_WRITE_DATA, WinWorldSid)])?;
        let mut raw_ace = null_mut();
        // SAFETY: the initialized ACL has exactly one ACE and remains live through mutation/check.
        assert_ne!(
            unsafe { GetAce(conditional.as_mut_ptr().cast::<ACL>(), 0, &raw mut raw_ace,) },
            0
        );
        // SAFETY: every ACE begins with a writable ACE_HEADER inside this owned fixture.
        unsafe {
            (*raw_ace.cast::<windows_sys::Win32::Security::ACE_HEADER>()).AceType = 9;
        }
        assert!(
            verify_dacl_write_grants(conditional.as_mut_ptr().cast::<ACL>(), &trusted_installer,)
                .is_err()
        );

        let mut truncated = acl_fixture(&[(true, 0, FILE_WRITE_DATA, WinWorldSid)])?;
        raw_ace = null_mut();
        // SAFETY: the initialized ACL has one ACE; this deliberate mutation exercises fail-closed
        // structural validation without dereferencing beyond the owned ACL buffer.
        assert_ne!(
            unsafe { GetAce(truncated.as_mut_ptr().cast::<ACL>(), 0, &raw mut raw_ace,) },
            0
        );
        unsafe {
            (*raw_ace.cast::<windows_sys::Win32::Security::ACE_HEADER>()).AceSize = 12;
        }
        assert!(
            verify_dacl_write_grants(truncated.as_mut_ptr().cast::<ACL>(), &trusted_installer,)
                .is_err()
        );
        Ok(())
    }

    #[test]
    fn program_files_authority_ignores_poisoned_environment_and_admits_real_acl_chain()
    -> napi::Result<()> {
        let _guard = native_real_host_test();
        let observed = program_files_directory()?;
        let signed_node = signed_node_executable();
        let poisoned = EnvironmentRestore::replace("ProgramFiles", "C:\\attacker-controlled");
        assert_eq!(program_files_directory()?, observed);
        let result = protect_program_files_path_with_scope(
            signed_node
                .to_str()
                .ok_or_else(|| crate::unavailable("The Windows system path is not Unicode."))?,
            false,
            false,
        );
        if let Err(error) = result {
            panic!(
                "the real Program Files chain was rejected: {}",
                error.reason
            );
        }
        drop(poisoned);
        Ok(())
    }

    #[test]
    fn msi_layout_is_exactly_version_architecture_and_bridge_file() -> napi::Result<()> {
        let root = PathBuf::from(program_files_directory()?)
            .join("Cuna")
            .join("Native");
        let admitted = root
            .join("1.2.3-rc.1")
            .join("x64")
            .join("cuna-native-bridge.exe");
        assert!(
            validate_cuna_system_component_executable(
                admitted.to_string_lossy().as_ref(),
                "x64",
                Some("1.2.3-rc.1"),
            )
            .is_ok()
        );
        for rejected in [
            root.join("1.2.3")
                .join("arm64")
                .join("cuna-native-bridge.exe"),
            root.join("1.2.4")
                .join("x64")
                .join("cuna-native-bridge.exe"),
            root.join("1.2.3")
                .join("x64")
                .join("subdir")
                .join("cuna-native-bridge.exe"),
            root.join("1.2.3")
                .join("x64")
                .join("cuna-native-authority.node"),
        ] {
            assert!(
                validate_cuna_system_component_executable(
                    rejected.to_string_lossy().as_ref(),
                    "x64",
                    Some("1.2.3"),
                )
                .is_err()
            );
        }
        Ok(())
    }

    #[test]
    fn npm_style_user_owned_location_and_parent_acl_are_rejected() -> napi::Result<()> {
        let root = unique_temporary_directory("mutable-acl");
        fs::create_dir_all(&root)
            .map_err(|_| crate::unavailable("The ACL fixture could not be created."))?;
        let file = root.join("cuna-native-authority.node");
        fs::write(&file, b"fixture")
            .map_err(|_| crate::unavailable("The ACL fixture could not be written."))?;
        assert!(protect_program_files_path(file.to_string_lossy().as_ref(), false).is_err());
        let trusted_installer = trusted_installer_sid()?;
        let directory = open_locked_path(root.to_string_lossy().as_ref(), true)?;
        let Err(error) = inspect_protected_handle(
            &directory,
            root.to_string_lossy().as_ref(),
            true,
            &trusted_installer,
        ) else {
            panic!("a user-owned parent was admitted");
        };
        assert!(error.reason.contains("owner") || error.reason.contains("DACL"));
        drop(directory);
        fs::remove_dir_all(&root)
            .map_err(|_| crate::unavailable("The ACL fixture could not be removed."))?;
        Ok(())
    }

    #[test]
    fn held_leaf_and_parent_handles_prevent_swap_and_delete() -> napi::Result<()> {
        let root = unique_temporary_directory("swap-lock");
        fs::create_dir_all(&root)
            .map_err(|_| crate::unavailable("The swap fixture could not be created."))?;
        let file = root.join("authority.node");
        let replacement = root.join("replacement.node");
        fs::write(&file, b"admitted")
            .and_then(|()| fs::write(&replacement, b"replacement"))
            .map_err(|_| crate::unavailable("The swap fixture could not be written."))?;
        let parent_handle = open_locked_path(root.to_string_lossy().as_ref(), true)?;
        let leaf_handle = open_locked_path(file.to_string_lossy().as_ref(), false)?;
        assert!(fs::rename(&replacement, &file).is_err());
        assert!(fs::remove_file(&file).is_err());
        assert!(fs::rename(&root, root.with_extension("moved")).is_err());
        drop(leaf_handle);
        drop(parent_handle);
        fs::remove_dir_all(&root)
            .map_err(|_| crate::unavailable("The swap fixture could not be removed."))?;
        Ok(())
    }

    #[test]
    fn hard_link_and_reparse_leafs_are_rejected_before_acl_admission() -> napi::Result<()> {
        let root = unique_temporary_directory("link-mutation");
        fs::create_dir_all(&root)
            .map_err(|_| crate::unavailable("The link fixture could not be created."))?;
        let original = root.join("original.node");
        let hard_link = root.join("hard-link.node");
        fs::write(&original, b"fixture")
            .and_then(|()| fs::hard_link(&original, &hard_link))
            .map_err(|_| crate::unavailable("The hard-link fixture could not be created."))?;
        let trusted_installer = trusted_installer_sid()?;
        for candidate in [&original, &hard_link] {
            let handle = open_locked_path(candidate.to_string_lossy().as_ref(), false)?;
            let Err(error) = inspect_protected_handle(
                &handle,
                candidate.to_string_lossy().as_ref(),
                false,
                &trusted_installer,
            ) else {
                panic!("a hard-linked file was admitted");
            };
            assert!(error.reason.contains("hard link"));
        }
        let target = root.join("junction-target");
        let reparse = root.join("junction");
        fs::create_dir(&target)
            .map_err(|_| crate::unavailable("The junction target could not be created."))?;
        let command = PathBuf::from(system_windows_directory()?)
            .join("System32")
            .join("cmd.exe");
        let status = Command::new(command)
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&reparse)
            .arg(&target)
            .status()
            .map_err(|_| crate::unavailable("The junction fixture could not be executed."))?;
        if !status.success() {
            return Err(crate::unavailable(
                "The junction fixture could not be created.",
            ));
        }
        let handle = open_locked_path(reparse.to_string_lossy().as_ref(), true)?;
        let Err(error) = inspect_protected_handle(
            &handle,
            reparse.to_string_lossy().as_ref(),
            true,
            &trusted_installer,
        ) else {
            panic!("an operating-system reparse point was admitted");
        };
        assert!(error.reason.contains("reparse point"));
        drop(handle);
        fs::remove_dir(&reparse)
            .and_then(|()| fs::remove_dir_all(&root))
            .map_err(|_| crate::unavailable("The link fixture could not be removed."))?;
        Ok(())
    }

    #[test]
    fn owned_process_receives_no_ambient_parent_environment() -> napi::Result<()> {
        let _guard = native_real_host_test();
        let trusted_system_root = system_windows_directory()?;
        let poisoned_parent = EnvironmentRestore::replace("SystemRoot", "C:\\attacker-controlled");
        let expected_block = format!("SystemRoot={trusted_system_root}\0\0")
            .encode_utf16()
            .collect::<Vec<_>>();
        assert_eq!(minimal_environment_block()?, expected_block);
        drop(poisoned_parent);
        let request = b"console.log(Object.keys(process.env).join(','));console.log(process.env.SystemRoot)\r\n".to_vec();
        let result = exchange_program_files_test(ExchangeInput {
            expected: expected_node()?,
            request: Buffer::from(request),
            timeout_ms: 10_000,
            maximum_output_bytes: 4 * 1024,
        })?;
        let output = String::from_utf8_lossy(result.stdout.as_ref());
        let mut lines = output.lines();
        assert_eq!(lines.next(), Some("SystemRoot"));
        assert_eq!(lines.next(), Some(trusted_system_root.as_str()));
        assert_eq!(lines.next(), None);
        Ok(())
    }

    #[test]
    fn suspended_process_is_terminated_before_every_job_containment_failure() -> napi::Result<()> {
        let _guard = native_real_host_test();
        for fault in [
            ExchangeFault::BeforeJobCreation,
            ExchangeFault::BeforeJobAssignment,
        ] {
            let pid = AtomicU32::new(0);
            let mut input = ExchangeInput {
                expected: expected_node()?,
                request: Buffer::from(b"console.log('must-not-run')\r\n".to_vec()),
                timeout_ms: 10_000,
                maximum_output_bytes: 4 * 1024,
            };
            assert!(exchange_with_fault(&mut input, Some(fault), Some(&pid), false).is_err());
            assert_terminated(pid.load(std::sync::atomic::Ordering::SeqCst));
            assert!(input.request.as_ref().iter().all(|byte| *byte == 0));
        }
        Ok(())
    }

    #[test]
    fn blocked_stdin_is_cancelled_by_the_bounded_job_timeout() -> napi::Result<()> {
        let _guard = native_real_host_test();
        let mut request = b"process.stdin.pause();setInterval(()=>{},1000)\r\n".to_vec();
        request.resize(16 * 1024, b' ');
        let expected = expected_node()?;
        let started = Instant::now();
        let result = exchange_program_files_test(ExchangeInput {
            expected,
            request: Buffer::from(request),
            timeout_ms: 300,
            maximum_output_bytes: 4 * 1024,
        });
        assert!(result.is_err());
        assert!(started.elapsed() < REAL_HOST_OPERATION_BOUND);
        Ok(())
    }

    #[test]
    fn descendant_pipe_handles_cannot_outlive_cleanup_proof() -> napi::Result<()> {
        let _guard = native_real_host_test();
        let request = b"require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']}).unref();console.log('spawned');process.exit(0)\r\n".to_vec();
        let expected = expected_node()?;
        let started = Instant::now();
        let result = exchange_program_files_test(ExchangeInput {
            expected,
            request: Buffer::from(request),
            timeout_ms: 10_000,
            maximum_output_bytes: 8 * 1024,
        })?;
        assert!(result.cleanup_proven);
        assert!(String::from_utf8_lossy(result.stdout.as_ref()).contains("spawned"));
        assert!(started.elapsed() < REAL_HOST_OPERATION_BOUND);
        Ok(())
    }

    fn assert_terminated(pid: u32) {
        assert_ne!(pid, 0);
        // SAFETY: OpenProcess is a read-only observation of the exact PID captured at creation.
        let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if process.is_null() {
            // SAFETY: this is read immediately after the failing OpenProcess call.
            assert_eq!(unsafe { GetLastError() }, ERROR_INVALID_PARAMETER);
            return;
        }
        // SAFETY: the handle is live and closed immediately after the zero-time observation.
        let wait = unsafe { WaitForSingleObject(process, 0) };
        unsafe { CloseHandle(process) };
        assert_eq!(
            wait, WAIT_OBJECT_0,
            "faulted suspended child is still running"
        );
    }
}
