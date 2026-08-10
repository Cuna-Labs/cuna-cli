use std::ffi::c_void;
use std::ptr::{null, null_mut};

use zeroize::Zeroize;

use crate::protocol::{Operation, Request, Response, Status};

type CfIndex = isize;
type CfTypeId = usize;
type OsStatus = i32;
type CfTypeRef = *const c_void;
type CfAllocatorRef = *const c_void;
type CfStringRef = *const c_void;
type CfDataRef = *const c_void;
type CfDictionaryRef = *const c_void;
type CfUrlRef = *const c_void;

const UTF8_ENCODING: u32 = 0x0800_0100;
const MACOS_CREDENTIAL_LIMIT: usize = 2_560;
const ERR_SEC_SUCCESS: OsStatus = 0;
const ERR_SEC_PARAM: OsStatus = -50;
const ERR_SEC_USER_CANCELED: OsStatus = -128;
const ERR_SEC_AUTH_FAILED: OsStatus = -25_293;
const ERR_SEC_DUPLICATE_ITEM: OsStatus = -25_299;
const ERR_SEC_ITEM_NOT_FOUND: OsStatus = -25_300;
const ERR_SEC_INTERACTION_NOT_ALLOWED: OsStatus = -25_308;
const ERR_SEC_DECODE: OsStatus = -26_275;

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

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFBooleanTrue: CfTypeRef;
    static kCFTypeDictionaryKeyCallBacks: CfDictionaryKeyCallBacks;
    static kCFTypeDictionaryValueCallBacks: CfDictionaryValueCallBacks;

    fn CFDataCreate(allocator: CfAllocatorRef, bytes: *const u8, length: CfIndex) -> CfDataRef;
    fn CFDataGetBytePtr(data: CfDataRef) -> *const u8;
    fn CFDataGetLength(data: CfDataRef) -> CfIndex;
    fn CFDataGetTypeID() -> CfTypeId;
    fn CFDictionaryCreate(
        allocator: CfAllocatorRef,
        keys: *const *const c_void,
        values: *const *const c_void,
        count: CfIndex,
        key_callbacks: *const CfDictionaryKeyCallBacks,
        value_callbacks: *const CfDictionaryValueCallBacks,
    ) -> CfDictionaryRef;
    fn CFGetTypeID(value: CfTypeRef) -> CfTypeId;
    fn CFRelease(value: CfTypeRef);
    fn CFStringCreateWithBytes(
        allocator: CfAllocatorRef,
        bytes: *const u8,
        length: CfIndex,
        encoding: u32,
        is_external_representation: u8,
    ) -> CfStringRef;
    fn CFURLCreateWithBytes(
        allocator: CfAllocatorRef,
        bytes: *const u8,
        length: CfIndex,
        encoding: u32,
        base_url: CfUrlRef,
    ) -> CfUrlRef;
}

#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    static kSecClass: CfStringRef;
    static kSecClassGenericPassword: CfStringRef;
    static kSecAttrService: CfStringRef;
    static kSecAttrAccount: CfStringRef;
    static kSecValueData: CfStringRef;
    static kSecReturnData: CfStringRef;
    static kSecMatchLimit: CfStringRef;
    static kSecMatchLimitOne: CfStringRef;
    static kSecUseAuthenticationUI: CfStringRef;
    static kSecUseAuthenticationUIFail: CfStringRef;

    fn SecItemAdd(attributes: CfDictionaryRef, result: *mut CfTypeRef) -> OsStatus;
    fn SecItemCopyMatching(query: CfDictionaryRef, result: *mut CfTypeRef) -> OsStatus;
    fn SecItemDelete(query: CfDictionaryRef) -> OsStatus;
    fn SecItemUpdate(query: CfDictionaryRef, attributes_to_update: CfDictionaryRef) -> OsStatus;
}

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    fn LSOpenCFURLRef(url: CfUrlRef, launched_url: *mut CfUrlRef) -> OsStatus;
}

const SERVICE: &[u8] = b"com.getcuna.cli";

macro_rules! imported {
    ($name:ident) => {{
        // SAFETY: these immutable CoreFoundation/Security constants live for the process lifetime.
        unsafe { $name.cast::<c_void>() }
    }};
}

pub fn dispatch(request: &Request) -> Response {
    match request.operation {
        Operation::Probe => Response::empty(Status::Ok),
        Operation::Read => read(&request.target),
        Operation::Replace => replace(&request.target, &request.payload),
        Operation::Delete => delete(&request.target),
        Operation::OpenBrowser => open_browser(&request.payload),
    }
}

fn read(target: &str) -> Response {
    match read_bytes(target) {
        Ok(Some(bytes)) => Response::protected(bytes),
        Ok(None) => Response::empty(Status::Absent),
        Err(status) => Response::empty(status),
    }
}

fn read_bytes(target: &str) -> Result<Option<Vec<u8>>, Status> {
    let service = OwnedCf::string(SERVICE)?;
    let account = OwnedCf::string(target.as_bytes())?;
    let query = dictionary(&[
        (imported!(kSecClass), imported!(kSecClassGenericPassword)),
        (imported!(kSecAttrService), service.get()),
        (imported!(kSecAttrAccount), account.get()),
        (imported!(kSecReturnData), imported!(kCFBooleanTrue)),
        (imported!(kSecMatchLimit), imported!(kSecMatchLimitOne)),
        (
            imported!(kSecUseAuthenticationUI),
            imported!(kSecUseAuthenticationUIFail),
        ),
    ])?;
    let mut result: CfTypeRef = null();
    // SAFETY: the query owns every referenced value through CoreFoundation callbacks and the
    // output is released exactly once below when Security.framework returns one.
    let status = unsafe { SecItemCopyMatching(query.get(), &raw mut result) };
    if status == ERR_SEC_ITEM_NOT_FOUND {
        return Ok(None);
    }
    if status != ERR_SEC_SUCCESS {
        return Err(status_from_os(status));
    }
    if result.is_null() {
        return Err(Status::Corrupt);
    }
    let result = OwnedCf(result);
    // SAFETY: `result` is a live CF object returned by SecItemCopyMatching.
    if unsafe { CFGetTypeID(result.get()) } != unsafe { CFDataGetTypeID() } {
        return Err(Status::Corrupt);
    }
    // SAFETY: the type check above proves a CFData and its storage remains live through the copy.
    let length = unsafe { CFDataGetLength(result.get()) };
    let length = usize::try_from(length).map_err(|_| Status::Corrupt)?;
    if length > MACOS_CREDENTIAL_LIMIT {
        return Err(Status::Corrupt);
    }
    if length == 0 {
        return Ok(Some(Vec::new()));
    }
    // SAFETY: non-empty CFData exposes a stable byte pointer for its lifetime.
    let pointer = unsafe { CFDataGetBytePtr(result.get()) };
    if pointer.is_null() {
        return Err(Status::Corrupt);
    }
    // SAFETY: CFDataGetLength and CFDataGetBytePtr describe the same immutable allocation.
    Ok(Some(
        unsafe { std::slice::from_raw_parts(pointer, length) }.to_vec(),
    ))
}

fn replace(target: &str, protected: &[u8]) -> Response {
    if protected.is_empty() || protected.len() > MACOS_CREDENTIAL_LIMIT {
        return Response::empty(Status::InvalidRequest);
    }
    let result = replace_once(target, protected).and_then(|()| {
        let mut observed = read_bytes(target)?.ok_or(Status::Unavailable)?;
        let equal = constant_time_equal(&observed, protected);
        observed.zeroize();
        if equal {
            Ok(())
        } else {
            Err(Status::Unavailable)
        }
    });
    match result {
        Ok(()) => Response::empty(Status::Ok),
        Err(status) => Response::empty(status),
    }
}

fn replace_once(target: &str, protected: &[u8]) -> Result<(), Status> {
    let service = OwnedCf::string(SERVICE)?;
    let account = OwnedCf::string(target.as_bytes())?;
    let value = OwnedCf::data(protected)?;
    let query = dictionary(&[
        (imported!(kSecClass), imported!(kSecClassGenericPassword)),
        (imported!(kSecAttrService), service.get()),
        (imported!(kSecAttrAccount), account.get()),
        (
            imported!(kSecUseAuthenticationUI),
            imported!(kSecUseAuthenticationUIFail),
        ),
    ])?;
    let update = dictionary(&[(imported!(kSecValueData), value.get())])?;
    // SAFETY: both dictionaries remain live for the synchronous Security.framework call.
    let update_status = unsafe { SecItemUpdate(query.get(), update.get()) };
    if update_status == ERR_SEC_SUCCESS {
        return Ok(());
    }
    if update_status != ERR_SEC_ITEM_NOT_FOUND {
        return Err(status_from_os(update_status));
    }

    let add = dictionary(&[
        (imported!(kSecClass), imported!(kSecClassGenericPassword)),
        (imported!(kSecAttrService), service.get()),
        (imported!(kSecAttrAccount), account.get()),
        (imported!(kSecValueData), value.get()),
        (
            imported!(kSecUseAuthenticationUI),
            imported!(kSecUseAuthenticationUIFail),
        ),
    ])?;
    // SAFETY: `add` remains live and no result object is requested.
    let add_status = unsafe { SecItemAdd(add.get(), null_mut()) };
    if add_status == ERR_SEC_SUCCESS {
        return Ok(());
    }
    if add_status == ERR_SEC_DUPLICATE_ITEM {
        // Another process won the absent-to-present race. An atomic update followed by the
        // caller's read-back determines the generation observed at acknowledgement time.
        // SAFETY: both dictionaries remain live for the retry.
        let retry = unsafe { SecItemUpdate(query.get(), update.get()) };
        return if retry == ERR_SEC_SUCCESS {
            Ok(())
        } else {
            Err(status_from_os(retry))
        };
    }
    Err(status_from_os(add_status))
}

fn delete(target: &str) -> Response {
    let result = delete_once(target);
    match result {
        Ok(()) => Response::empty(Status::Ok),
        Err(status) => Response::empty(status),
    }
}

fn delete_once(target: &str) -> Result<(), Status> {
    let service = OwnedCf::string(SERVICE)?;
    let account = OwnedCf::string(target.as_bytes())?;
    let query = dictionary(&[
        (imported!(kSecClass), imported!(kSecClassGenericPassword)),
        (imported!(kSecAttrService), service.get()),
        (imported!(kSecAttrAccount), account.get()),
        (
            imported!(kSecUseAuthenticationUI),
            imported!(kSecUseAuthenticationUIFail),
        ),
    ])?;
    // SAFETY: `query` remains live for the synchronous call.
    let status = unsafe { SecItemDelete(query.get()) };
    if status != ERR_SEC_SUCCESS && status != ERR_SEC_ITEM_NOT_FOUND {
        return Err(status_from_os(status));
    }
    // A successful delete is acknowledged only after an independent absence observation.
    read_bytes(target)?.map_or(Ok(()), |mut unexpected| {
        unexpected.zeroize();
        Err(Status::Unavailable)
    })
}

fn open_browser(payload: &[u8]) -> Response {
    if !valid_https_url(payload) {
        return Response::empty(Status::InvalidRequest);
    }
    let Ok(length) = CfIndex::try_from(payload.len()) else {
        return Response::empty(Status::InvalidRequest);
    };
    // SAFETY: payload is live for the call and is validated UTF-8 below by `valid_https_url`.
    let raw_url =
        unsafe { CFURLCreateWithBytes(null(), payload.as_ptr(), length, UTF8_ENCODING, null()) };
    if raw_url.is_null() {
        return Response::empty(Status::InvalidRequest);
    }
    let url = OwnedCf(raw_url);
    // SAFETY: `url` is a valid retained CFURL. LaunchServices owns any browser process creation;
    // Cuna passes no URL through a child argv or environment.
    let status = unsafe { LSOpenCFURLRef(url.get(), null_mut()) };
    if status == 0 {
        Response::empty(Status::Ok)
    } else {
        Response::empty(Status::Unavailable)
    }
}

fn valid_https_url(payload: &[u8]) -> bool {
    payload.len() <= 8_192
        && payload.starts_with(b"https://")
        && std::str::from_utf8(payload).is_ok()
        && !payload
            .iter()
            .any(|byte| *byte == 0 || byte.is_ascii_control())
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

const fn status_from_os(status: OsStatus) -> Status {
    match status {
        ERR_SEC_ITEM_NOT_FOUND => Status::Absent,
        ERR_SEC_AUTH_FAILED | ERR_SEC_USER_CANCELED => Status::Denied,
        ERR_SEC_DECODE => Status::Corrupt,
        ERR_SEC_PARAM => Status::InvalidRequest,
        _ => Status::Unavailable,
    }
}

fn dictionary(entries: &[(CfTypeRef, CfTypeRef)]) -> Result<OwnedCf, Status> {
    let count = CfIndex::try_from(entries.len()).map_err(|_| Status::InternalError)?;
    let keys: Vec<CfTypeRef> = entries.iter().map(|(key, _)| *key).collect();
    let values: Vec<CfTypeRef> = entries.iter().map(|(_, value)| *value).collect();
    // SAFETY: all keys and values remain live for the call. The standard CFType callbacks retain
    // every entry, so the resulting dictionary owns its references independently.
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
    if result.is_null() {
        Err(Status::InternalError)
    } else {
        Ok(OwnedCf(result))
    }
}

struct OwnedCf(CfTypeRef);

impl OwnedCf {
    fn string(bytes: &[u8]) -> Result<Self, Status> {
        let length = CfIndex::try_from(bytes.len()).map_err(|_| Status::InvalidRequest)?;
        // SAFETY: `bytes` remains live for the synchronous creation call; CoreFoundation copies it.
        let value =
            unsafe { CFStringCreateWithBytes(null(), bytes.as_ptr(), length, UTF8_ENCODING, 0) };
        if value.is_null() {
            Err(Status::InvalidRequest)
        } else {
            Ok(Self(value))
        }
    }

    fn data(bytes: &[u8]) -> Result<Self, Status> {
        let length = CfIndex::try_from(bytes.len()).map_err(|_| Status::InvalidRequest)?;
        // SAFETY: `bytes` remains live for the synchronous creation call; CoreFoundation copies it.
        let value = unsafe { CFDataCreate(null(), bytes.as_ptr(), length) };
        if value.is_null() {
            Err(Status::InternalError)
        } else {
            Ok(Self(value))
        }
    }

    const fn get(&self) -> CfTypeRef {
        self.0
    }
}

impl Drop for OwnedCf {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: OwnedCf is constructed only from create/copy-rule CoreFoundation objects
            // and releases each object exactly once.
            unsafe { CFRelease(self.0) };
            self.0 = null();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_validation_rejects_non_https_and_control_bytes() {
        assert!(valid_https_url(
            b"https://app.getcuna.com/cli/continue?nonce=one"
        ));
        assert!(!valid_https_url(b"http://app.getcuna.com/cli/continue"));
        assert!(!valid_https_url(b"https://app.getcuna.com/cli/continue\n"));
        assert!(!valid_https_url(b"https://app.getcuna.com/cli/\xff"));
    }

    #[test]
    fn equality_check_is_length_and_content_sensitive() {
        assert!(constant_time_equal(b"generation-one", b"generation-one"));
        assert!(!constant_time_equal(b"generation-one", b"generation-two"));
        assert!(!constant_time_equal(b"short", b"longer"));
    }
}
