use napi::Result;

use crate::{
    ExchangeInput, ExchangeResult, SignatureInput, SignatureObservation, invalid, unavailable,
};

pub fn verify_signature(input: &SignatureInput) -> Result<SignatureObservation> {
    if input.platform != "darwin" || input.architecture != current_architecture() {
        return Err(invalid(
            "The requested signature platform does not match this addon.",
        ));
    }
    // The release contract requires Security.framework validation, notarization evidence, and an
    // audit-token-bound process instance. A path hash or `codesign` child command cannot replace
    // that authority, so source builds remain unavailable until the direct framework adapter is
    // implemented and exercised on both admitted macOS architectures.
    Err(unavailable(
        "The macOS code-sign and notarization authority is not available in this source build.",
    ))
}

pub fn exchange(mut input: ExchangeInput) -> Result<ExchangeResult> {
    input.request.as_mut().fill(0);
    Err(unavailable(
        "The macOS audit-token-owned process authority is not available in this source build.",
    ))
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
