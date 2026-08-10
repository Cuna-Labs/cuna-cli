#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

mod protocol;

#[cfg(windows)]
mod windows;

#[cfg(target_os = "macos")]
mod macos;

use std::io::{self, Read, Write};

use protocol::{Request, Response, Status};
use zeroize::Zeroize;

const MAXIMUM_REQUEST_BYTES: u64 = 16 * 1024;

fn main() {
    let response = execute();
    let mut encoded = response.encode();
    let write_result = io::stdout().lock().write_all(&encoded);
    encoded.zeroize();
    if write_result.is_err() {
        std::process::exit(74);
    }
}

fn execute() -> Response {
    let mut bytes = Vec::new();
    let read_result = io::stdin()
        .lock()
        .take(MAXIMUM_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes);
    if read_result.is_err() {
        bytes.zeroize();
        return Response::empty(Status::InternalError);
    }
    if u64::try_from(bytes.len()).map_or(true, |length| length > MAXIMUM_REQUEST_BYTES) {
        bytes.zeroize();
        return Response::empty(Status::InvalidRequest);
    }

    let parsed = Request::parse(&bytes);
    bytes.zeroize();
    match parsed {
        Ok(mut request) => {
            let response = dispatch(&request);
            request.zeroize();
            response
        }
        Err(status) => Response::empty(status),
    }
}

fn dispatch(request: &Request) -> Response {
    #[cfg(windows)]
    {
        windows::dispatch(request)
    }

    #[cfg(target_os = "macos")]
    {
        macos::dispatch(request)
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = request;
        Response::empty(Status::Unavailable)
    }
}
