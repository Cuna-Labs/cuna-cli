use std::ffi::c_void;
use std::fmt::Write as _;
use std::fs::File;
use std::io::Read;
use std::ptr::null;

use napi::Result;
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::{
    ExchangeInput, ExchangeResult, SignatureInput, SignatureObservation, invalid, unavailable,
};

type CfIndex = isize;
type CfTypeId = usize;
type CfTypeRef = *const c_void;
type CfAllocatorRef = *const c_void;
type CfArrayRef = *const c_void;
type CfBooleanRef = *const c_void;
type CfDataRef = *const c_void;
type CfDictionaryRef = *const c_void;
type CfStringRef = *const c_void;
type CfUrlRef = *const c_void;
type OsStatus = i32;
type SecCsFlags = u32;
type SecStaticCodeRef = *const c_void;
type SecAssessmentRef = *const c_void;

const ERR_SEC_SUCCESS: OsStatus = 0;
const CHECK_ALL_ARCHITECTURES: SecCsFlags = 1 << 0;
const CHECK_NESTED_CODE: SecCsFlags = 1 << 4;
const STRICT_VALIDATE: SecCsFlags = 1 << 5;
const SIGNING_INFORMATION: SecCsFlags = 1 << 1;
const MAXIMUM_BINARY_BYTES: u64 = 32 * 1024 * 1024;

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
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
    fn CFRelease(value: CfTypeRef);
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
    static kSecAssessmentAssessmentVerdict: CfStringRef;

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
        code: SecStaticCodeRef,
        flags: SecCsFlags,
        information: *mut CfDictionaryRef,
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
    input.request.as_mut().zeroize();
    // Security.framework and Gatekeeper establish the static artifact identity above. Protected
    // stdin still requires a suspended, owned process plus loaded-image and audit-token binding.
    // Do not fall back to std::process::Command or a path-only recheck.
    Err(unavailable(
        "The macOS audit-token-owned process authority is not available in this source build.",
    ))
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
