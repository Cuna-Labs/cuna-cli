use std::ffi::c_void;
use std::fmt::Write as _;
use std::fs::File;
use std::io::Read;
use std::mem::size_of;
use std::os::windows::io::AsRawHandle;
use std::ptr::{null, null_mut};
use std::thread;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use napi::Result;
use napi::bindgen_prelude::Buffer;
use sha2::{Digest, Sha256};
use windows_sys::Win32::Foundation::SetHandleInformation;
use windows_sys::Win32::Foundation::{
    CloseHandle, FILETIME, GENERIC_READ, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
    WAIT_OBJECT_0,
};
use windows_sys::Win32::Security::Cryptography::{
    CERT_CONTEXT, CERT_FIND_SUBJECT_CERT, CERT_INFO, CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
    CERT_QUERY_FORMAT_FLAG_BINARY, CERT_QUERY_OBJECT_FILE, CERT_SHA1_HASH_PROP_ID,
    CMSG_SIGNER_INFO, CMSG_SIGNER_INFO_PARAM, CertCloseStore, CertFindCertificateInStore,
    CertFreeCertificateContext, CertGetCertificateContextProperty, CryptMsgClose, CryptMsgGetParam,
    CryptQueryObject, HCERTSTORE, PKCS_7_ASN_ENCODING, X509_ASN_ENCODING,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Security::WinTrust::{
    WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO,
    WTD_CHOICE_FILE, WTD_REVOCATION_CHECK_NONE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE,
    WTD_STATEACTION_VERIFY, WTD_UI_NONE, WinVerifyTrust,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ,
    GetFileInformationByHandle, GetFileVersionInfoSizeW, GetFileVersionInfoW, OPEN_EXISTING,
    ReadFile, VerQueryValueW, WriteFile,
};
use windows_sys::Win32::System::IO::CancelSynchronousIo;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::SystemInformation::GetSystemWindowsDirectoryW;
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess,
    GetProcessTimes, GetThreadId, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    OpenThread, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION, QueryFullProcessImageNameW,
    ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW, THREAD_SYNCHRONIZE,
    THREAD_TERMINATE, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
};
use zeroize::Zeroize;

use crate::{
    ExchangeInput, ExchangeResult, ProcessObservation, SignatureInput, SignatureObservation,
    invalid, unavailable,
};

const ERROR_EXIT_CODE: u32 = 126;
const CLEANUP_TIMEOUT_MS: u32 = 2_000;
const MAXIMUM_PATH_UNITS: usize = 32_768;
const VS_FIXEDFILEINFO_SIGNATURE: u32 = 0xFEEF_04BD;

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
    let _locked_executable = open_locked_executable(&input.executable)?;
    let binary_sha256 = file_sha256(&input.executable)?;
    let file_version = file_version(&input.executable)?;
    let fingerprint = authenticode_fingerprint(&input.executable)?;
    Ok(SignatureObservation {
        valid: !fingerprint.is_empty(),
        // ACL proof is intentionally conservative until the release builder supplies and verifies
        // the package-directory security descriptor. A signed file in a mutable location is not
        // admitted merely because its Authenticode signature is valid.
        location_protected: false,
        binary_sha256,
        file_version,
        kind: "authenticode".to_owned(),
        publisher_certificate_fingerprint: fingerprint,
    })
}

#[allow(clippy::too_many_lines)]
pub fn exchange(mut input: ExchangeInput) -> Result<ExchangeResult> {
    exchange_with_fault(&mut input, None, None)
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

    let protected_request = SecretBytes(input.request.as_ref().to_vec());
    input.request.as_mut().zeroize();

    // Deny write/delete sharing before any identity read and retain the handle until the child has
    // exited. This closes path replacement between admission, CreateProcessW and protected stdin.
    let admitted_executable = open_locked_executable(&input.expected.executable)?;
    let admitted_file_identity = file_identity(admitted_executable.raw())?;
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
        let loaded_executable_handle = open_locked_executable(&loaded_executable)?;
        if file_identity(loaded_executable_handle.raw())? != admitted_file_identity {
            return Err(unavailable(
                "The loaded process image file identity differs from the admitted handle.",
            ));
        }
        let binary_sha256 = file_sha256(&loaded_executable)?;
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

fn open_locked_executable(path: &str) -> Result<OwnedHandle> {
    let path = wide(path);
    // SAFETY: path is a live NUL-terminated UTF-16 string. FILE_SHARE_READ intentionally denies
    // concurrent write and delete access for the complete lifetime of the returned owned handle.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    OwnedHandle::new(handle).map_err(|_| {
        unavailable("The admitted executable could not be locked against replacement.")
    })
}

fn file_identity(handle: HANDLE) -> Result<FileIdentity> {
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: handle is live and the output structure is initialized for the synchronous call.
    if unsafe { GetFileInformationByHandle(handle, &raw mut information) } == 0 {
        return Err(unavailable(
            "The admitted executable file identity could not be inspected.",
        ));
    }
    Ok(FileIdentity {
        volume_serial: information.dwVolumeSerialNumber,
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
    })
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

fn file_sha256(path: &str) -> Result<String> {
    let mut file = File::open(path)
        .map_err(|_| unavailable("The executable could not be opened for hashing."))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| unavailable("The executable could not be hashed."))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    buffer.zeroize();
    Ok(format!("{:x}", hasher.finalize()))
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
    use std::path::PathBuf;
    use std::sync::atomic::AtomicU32;
    use std::sync::{Mutex, MutexGuard, PoisonError};
    use std::time::{Duration, Instant};

    use napi::bindgen_prelude::Buffer;
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_INVALID_PARAMETER, GetLastError, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };

    use super::{
        ExchangeFault, authenticode_fingerprint, exchange, exchange_with_fault, file_sha256,
        file_version, minimal_environment_block, system_windows_directory,
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

    fn expected_node() -> napi::Result<ExpectedDescriptor> {
        let executable = signed_node_executable();
        let executable = executable
            .to_str()
            .ok_or_else(|| crate::unavailable("The Windows system path is not Unicode."))?
            .to_owned();
        let binary_sha256 = file_sha256(&executable)?;
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

    #[test]
    fn signed_owned_process_exchange_binds_identity_before_stdin() -> napi::Result<()> {
        let _guard = native_real_host_test();
        let request = b"console.log('cuna-authority');process.exit(0)\r\n".to_vec();
        let result = exchange(ExchangeInput {
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
        let result = exchange(ExchangeInput {
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
            assert!(exchange_with_fault(&mut input, Some(fault), Some(&pid)).is_err());
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
        let result = exchange(ExchangeInput {
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
        let result = exchange(ExchangeInput {
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
