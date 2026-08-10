use std::ffi::c_void;

use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_CANCELLED, ERROR_NOT_FOUND, FILETIME, GetLastError,
};
use windows_sys::Win32::Security::Credentials::{
    CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree, CredReadW,
    CredWriteW,
};
use windows_sys::Win32::System::SystemServices::{
    PROCESS_MITIGATION_CHILD_PROCESS_POLICY, PROCESS_MITIGATION_CHILD_PROCESS_POLICY_0,
};
use windows_sys::Win32::System::Threading::{
    ProcessChildProcessPolicy, SetProcessMitigationPolicy,
};
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use zeroize::Zeroize;

use crate::protocol::{Operation, Request, Response, Status};

const WINDOWS_GENERIC_CREDENTIAL_LIMIT: usize = 2_560;
const NO_CHILD_PROCESS_CREATION: u32 = 1;

pub fn dispatch(request: &Request) -> Response {
    if requires_child_process_mitigation(request.operation) && !deny_child_process_creation() {
        return Response::empty(Status::Unavailable);
    }
    match request.operation {
        Operation::Probe => Response::empty(Status::Ok),
        Operation::Read => read(&request.target),
        Operation::Replace => replace(&request.target, &request.payload),
        Operation::Delete => delete(&request.target),
        Operation::OpenBrowser => open_browser(&request.payload),
    }
}

fn read(target: &str) -> Response {
    let mut target = wide(target);
    let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
    // SAFETY: `target` is NUL-terminated and lives through the call; the output pointer is owned
    // by Credential Manager on success and is released exactly once with `CredFree` below.
    let succeeded =
        unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &raw mut credential) };
    if succeeded == 0 {
        target.zeroize();
        return Response::empty(status_from_last_error());
    }
    if credential.is_null() {
        target.zeroize();
        return Response::empty(Status::Corrupt);
    }
    // SAFETY: a successful CredReadW returns a valid CREDENTIALW pointer until CredFree.
    let (blob, size) = unsafe {
        let value = &*credential;
        (value.CredentialBlob, value.CredentialBlobSize as usize)
    };
    // SAFETY: Credential Manager guarantees that a non-null blob spans CredentialBlobSize bytes.
    // A null pointer is accepted only for the explicit zero-length case handled by the helper.
    let protected = match unsafe { copy_credential_blob(blob, size) } {
        Ok(value) => value,
        Err(status) => {
            // SAFETY: `credential` is the exact allocation returned by CredReadW.
            unsafe { CredFree(credential.cast::<c_void>()) };
            target.zeroize();
            return Response::empty(status);
        }
    };
    // SAFETY: the blob is mutable Credential Manager memory and remains valid until CredFree.
    if size > 0 {
        unsafe { secure_zero(blob, size) };
    }
    // SAFETY: `credential` is the exact allocation returned by CredReadW.
    unsafe { CredFree(credential.cast::<c_void>()) };
    target.zeroize();
    Response::protected(protected)
}

const fn requires_child_process_mitigation(operation: Operation) -> bool {
    !matches!(operation, Operation::OpenBrowser)
}

fn deny_child_process_creation() -> bool {
    let policy = PROCESS_MITIGATION_CHILD_PROCESS_POLICY {
        Anonymous: PROCESS_MITIGATION_CHILD_PROCESS_POLICY_0 {
            Flags: NO_CHILD_PROCESS_CREATION,
        },
    };
    // SAFETY: `policy` is the documented fixed-size policy structure and remains live for the
    // synchronous call. Failure is handled by refusing credential operations.
    unsafe {
        SetProcessMitigationPolicy(
            ProcessChildProcessPolicy,
            (&raw const policy).cast::<c_void>(),
            std::mem::size_of::<PROCESS_MITIGATION_CHILD_PROCESS_POLICY>(),
        ) != 0
    }
}

unsafe fn copy_credential_blob(blob: *mut u8, size: usize) -> Result<Vec<u8>, Status> {
    if size > WINDOWS_GENERIC_CREDENTIAL_LIMIT || (size > 0 && blob.is_null()) {
        return Err(Status::Corrupt);
    }
    if size == 0 {
        return Ok(Vec::new());
    }
    // SAFETY: the caller guarantees a non-null Credential Manager allocation spanning `size`
    // bytes. The zero-length case returned before constructing a slice.
    Ok(unsafe { std::slice::from_raw_parts(blob, size) }.to_vec())
}

fn replace(target: &str, protected: &[u8]) -> Response {
    if protected.len() > WINDOWS_GENERIC_CREDENTIAL_LIMIT {
        return Response::empty(Status::InvalidRequest);
    }
    let mut target = wide(target);
    let mut protected = protected.to_vec();
    let blob_size = u32::try_from(protected.len()).unwrap_or(u32::MAX);
    let credential = CREDENTIALW {
        Flags: 0,
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_mut_ptr(),
        Comment: std::ptr::null_mut(),
        LastWritten: FILETIME::default(),
        CredentialBlobSize: blob_size,
        CredentialBlob: protected.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: std::ptr::null_mut(),
        TargetAlias: std::ptr::null_mut(),
        UserName: std::ptr::null_mut(),
    };
    // SAFETY: every pointer in `credential` is either null or points to live mutable storage for
    // the duration of the synchronous call; sizes match the provided allocations.
    let succeeded = unsafe { CredWriteW(&raw const credential, 0) };
    protected.zeroize();
    target.zeroize();
    if succeeded == 0 {
        Response::empty(status_from_last_error())
    } else {
        Response::empty(Status::Ok)
    }
}

fn delete(target: &str) -> Response {
    let mut target = wide(target);
    // SAFETY: `target` is NUL-terminated and lives through the synchronous call.
    let succeeded = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
    target.zeroize();
    if succeeded == 0 {
        Response::empty(status_from_last_error())
    } else {
        Response::empty(Status::Ok)
    }
}

fn open_browser(payload: &[u8]) -> Response {
    let Ok(url) = std::str::from_utf8(payload) else {
        return Response::empty(Status::InvalidRequest);
    };
    if !url.starts_with("https://") || url.contains('\0') || url.len() > 8_192 {
        return Response::empty(Status::InvalidRequest);
    }
    let mut operation = wide("open");
    let mut url = wide(url);
    // SAFETY: both strings are NUL-terminated and live through the call. Cuna invokes no
    // intermediary executable here; downstream OS/browser telemetry remains an external
    // admission obligation and is not proven by this call succeeding.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            url.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    operation.zeroize();
    url.zeroize();
    if (result as isize) > 32 {
        Response::empty(Status::Ok)
    } else {
        Response::empty(Status::Unavailable)
    }
}

fn status_from_last_error() -> Status {
    // SAFETY: GetLastError has no preconditions and is read immediately after the failed call.
    match unsafe { GetLastError() } {
        ERROR_NOT_FOUND => Status::Absent,
        ERROR_ACCESS_DENIED | ERROR_CANCELLED => Status::Denied,
        _ => Status::Unavailable,
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe fn secure_zero(pointer: *mut u8, length: usize) {
    for index in 0..length {
        // SAFETY: the caller proves the allocation spans `length` mutable bytes. Volatile writes
        // prevent the compiler from removing the wipe before CredFree.
        unsafe { pointer.add(index).write_volatile(0) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_length_null_blob_never_constructs_a_slice() {
        // SAFETY: the helper explicitly accepts a null pointer only when the requested size is 0.
        let copied = unsafe { copy_credential_blob(std::ptr::null_mut(), 0) }.unwrap();
        assert!(copied.is_empty());
    }

    #[test]
    fn non_empty_null_and_oversized_blobs_fail_closed() {
        // SAFETY: both invalid shapes are rejected before the pointer can be dereferenced.
        assert_eq!(
            unsafe { copy_credential_blob(std::ptr::null_mut(), 1) }.unwrap_err(),
            Status::Corrupt
        );
        let mut bytes = vec![0_u8; WINDOWS_GENERIC_CREDENTIAL_LIMIT + 1];
        // SAFETY: the allocation is valid, but the declared size exceeds the admitted limit and
        // is rejected before a slice is constructed.
        assert_eq!(
            unsafe { copy_credential_blob(bytes.as_mut_ptr(), bytes.len()) }.unwrap_err(),
            Status::Corrupt
        );
        bytes.zeroize();
    }

    #[test]
    fn browser_handoff_is_the_only_operation_allowed_to_create_a_child() {
        assert!(requires_child_process_mitigation(Operation::Probe));
        assert!(requires_child_process_mitigation(Operation::Read));
        assert!(requires_child_process_mitigation(Operation::Replace));
        assert!(requires_child_process_mitigation(Operation::Delete));
        assert!(!requires_child_process_mitigation(Operation::OpenBrowser));
    }
}
