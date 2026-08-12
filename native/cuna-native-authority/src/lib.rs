#![deny(clippy::unwrap_used, clippy::expect_used)]

use napi::bindgen_prelude::Buffer;
use napi::{Error, Result, Status};
use napi_derive::napi;
use zeroize::Zeroize;

#[cfg(windows)]
mod windows;

#[cfg(target_os = "macos")]
mod macos;

const MAXIMUM_REQUEST_BYTES: usize = 16 * 1024;
const MAXIMUM_OUTPUT_BYTES: u32 = 128 * 1024;
const MINIMUM_TIMEOUT_MS: u32 = 100;
const MAXIMUM_TIMEOUT_MS: u32 = 60_000;

#[napi(object)]
pub struct SignatureInput {
    pub executable: String,
    pub platform: String,
    pub architecture: String,
}

#[napi(object)]
pub struct SignatureObservation {
    pub valid: bool,
    pub location_protected: bool,
    pub binary_sha256: String,
    pub file_version: String,
    pub kind: String,
    pub publisher_certificate_fingerprint: String,
}

#[napi(object)]
pub struct ExpectedDescriptor {
    pub protocol: String,
    pub platform: String,
    pub architecture: String,
    pub package_version: String,
    pub native_version: String,
    pub file_version: String,
    pub executable: String,
    pub working_directory: String,
    pub manifest_path: String,
    pub maximum_credential_bytes: u32,
    pub binary_sha256: String,
    pub manifest_sha256: String,
    pub sbom_sha256: String,
    pub provenance_sha256: String,
    pub signature: ExpectedSignature,
}

#[napi(object)]
pub struct ExpectedSignature {
    pub kind: String,
    pub publisher_certificate_fingerprint: String,
}

#[napi(object)]
pub struct ExchangeInput {
    pub expected: ExpectedDescriptor,
    pub request: Buffer,
    pub timeout_ms: u32,
    pub maximum_output_bytes: u32,
}

#[napi(object)]
pub struct ProcessObservation {
    pub pid: u32,
    pub platform: String,
    pub architecture: String,
    pub executable: String,
    pub binary_sha256: String,
    pub file_version: String,
    pub loaded_image_verified: bool,
    pub process_instance_verified: bool,
    pub process_instance_id: String,
}

#[napi(object)]
pub struct ExchangeResult {
    pub exit_code: i32,
    pub signal: Option<String>,
    pub stdout: Buffer,
    pub stderr_present: bool,
    pub cleanup_proven: bool,
    pub observation: ProcessObservation,
}

#[napi(js_name = "verifySignature")]
/// Verifies the native signature and immutable executable identity.
///
/// # Errors
///
/// Returns an error when the platform, path, signature, or file metadata cannot be proven.
#[allow(clippy::needless_pass_by_value)]
pub fn verify_signature(input: SignatureInput) -> Result<SignatureObservation> {
    validate_path(&input.executable)?;
    validate_platform_architecture(&input.platform, &input.architecture)?;
    #[cfg(windows)]
    {
        return windows::verify_signature(&input);
    }
    #[cfg(target_os = "macos")]
    {
        return macos::verify_signature(&input);
    }
    #[allow(unreachable_code)]
    Err(unavailable(
        "Native signature verification is unavailable on this platform.",
    ))
}

#[napi]
/// Executes one request through an operating-system process instance owned by this addon.
///
/// # Errors
///
/// Returns an error before protected stdin is released if any identity predicate fails, or when
/// bounded I/O, termination, and cleanup cannot be proven.
pub fn exchange(mut input: ExchangeInput) -> Result<ExchangeResult> {
    if let Err(error) = validate_exchange(&input) {
        input.request.as_mut().zeroize();
        return Err(error);
    }
    #[cfg(windows)]
    {
        return windows::exchange(input);
    }
    #[cfg(target_os = "macos")]
    {
        return macos::exchange(input);
    }
    #[allow(unreachable_code)]
    {
        input.request.as_mut().zeroize();
        Err(unavailable(
            "Owned native process exchange is unavailable on this platform.",
        ))
    }
}

fn validate_exchange(input: &ExchangeInput) -> Result<()> {
    validate_path(&input.expected.executable)?;
    validate_path(&input.expected.working_directory)?;
    validate_platform_architecture(&input.expected.platform, &input.expected.architecture)?;
    if input.expected.protocol != "cuna.native-bridge.v1"
        || input.request.is_empty()
        || input.request.len() > MAXIMUM_REQUEST_BYTES
        || input.timeout_ms < MINIMUM_TIMEOUT_MS
        || input.timeout_ms > MAXIMUM_TIMEOUT_MS
        || input.maximum_output_bytes == 0
        || input.maximum_output_bytes > MAXIMUM_OUTPUT_BYTES
        || !is_sha256(&input.expected.binary_sha256)
        || input.expected.file_version.is_empty()
        || input.expected.file_version.len() > 64
    {
        return Err(invalid("The native exchange request is not admissible."));
    }
    Ok(())
}

fn validate_path(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 32_768 || value.contains('\0') {
        return Err(invalid("The native executable path is invalid."));
    }
    Ok(())
}

fn validate_platform_architecture(platform: &str, architecture: &str) -> Result<()> {
    let platform_valid = matches!(platform, "win32" | "darwin");
    let architecture_valid = matches!(architecture, "x64" | "arm64");
    if !platform_valid || !architecture_valid {
        return Err(invalid("The native platform identity is invalid."));
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn invalid(reason: &str) -> Error {
    Error::new(Status::InvalidArg, reason.to_owned())
}

fn unavailable(reason: &str) -> Error {
    Error::new(Status::GenericFailure, reason.to_owned())
}
