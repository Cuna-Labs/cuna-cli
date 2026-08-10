use zeroize::Zeroize;

const REQUEST_MAGIC: &[u8; 8] = b"RUNANV01";
const RESPONSE_MAGIC: &[u8; 8] = b"RUNANR01";
const HEADER_BYTES: usize = 15;
const MAXIMUM_TARGET_BYTES: usize = 512;
const MAXIMUM_PAYLOAD_BYTES: usize = 8 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum Operation {
    Probe = 1,
    Read = 2,
    Replace = 3,
    Delete = 4,
    OpenBrowser = 5,
}

impl TryFrom<u8> for Operation {
    type Error = Status;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Probe),
            2 => Ok(Self::Read),
            3 => Ok(Self::Replace),
            4 => Ok(Self::Delete),
            5 => Ok(Self::OpenBrowser),
            _ => Err(Status::Incompatible),
        }
    }
}

#[derive(Debug)]
pub struct Request {
    pub operation: Operation,
    pub target: String,
    pub payload: Vec<u8>,
}

impl Request {
    pub fn parse(bytes: &[u8]) -> Result<Self, Status> {
        if bytes.len() < HEADER_BYTES || bytes.get(..8) != Some(REQUEST_MAGIC) {
            return Err(Status::Incompatible);
        }
        let operation = Operation::try_from(bytes[8])?;
        let target_length = usize::from(u16::from_be_bytes([bytes[9], bytes[10]]));
        let payload_length_u32 = u32::from_be_bytes([bytes[11], bytes[12], bytes[13], bytes[14]]);
        let payload_length =
            usize::try_from(payload_length_u32).map_err(|_| Status::InvalidRequest)?;
        if target_length > MAXIMUM_TARGET_BYTES || payload_length > MAXIMUM_PAYLOAD_BYTES {
            return Err(Status::InvalidRequest);
        }
        let expected = HEADER_BYTES
            .checked_add(target_length)
            .and_then(|length| length.checked_add(payload_length))
            .ok_or(Status::InvalidRequest)?;
        if bytes.len() != expected {
            return Err(Status::InvalidRequest);
        }
        let target_bytes = &bytes[HEADER_BYTES..HEADER_BYTES + target_length];
        let target = std::str::from_utf8(target_bytes).map_err(|_| Status::InvalidRequest)?;
        if target.contains('\0') || !target.is_ascii() {
            return Err(Status::InvalidRequest);
        }
        let payload = bytes[HEADER_BYTES + target_length..].to_vec();
        let request = Self {
            operation,
            target: target.to_owned(),
            payload,
        };
        request.validate_shape()?;
        Ok(request)
    }

    fn validate_shape(&self) -> Result<(), Status> {
        match self.operation {
            Operation::Probe => {
                if !self.target.is_empty() || !self.payload.is_empty() {
                    return Err(Status::InvalidRequest);
                }
            }
            Operation::Read | Operation::Delete => {
                if !valid_credential_target(&self.target) || !self.payload.is_empty() {
                    return Err(Status::InvalidRequest);
                }
            }
            Operation::Replace => {
                if !valid_credential_target(&self.target) || self.payload.is_empty() {
                    return Err(Status::InvalidRequest);
                }
            }
            Operation::OpenBrowser => {
                if !self.target.is_empty() || self.payload.is_empty() {
                    return Err(Status::InvalidRequest);
                }
            }
        }
        Ok(())
    }

    pub fn zeroize(&mut self) {
        self.target.zeroize();
        self.payload.zeroize();
    }
}

fn valid_credential_target(target: &str) -> bool {
    let Some(digest) = target.strip_prefix("runa-cli:v1:") else {
        return false;
    };
    digest.len() == 64
        && digest
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

impl Drop for Request {
    fn drop(&mut self) {
        self.zeroize();
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum Status {
    Ok = 0,
    Absent = 1,
    Denied = 2,
    Unavailable = 3,
    Incompatible = 4,
    Corrupt = 5,
    InvalidRequest = 6,
    InternalError = 7,
}

// Linux compiles the protocol for source-quality verification but intentionally has no
// credential backend to construct every platform response.
#[cfg(not(any(windows, target_os = "macos")))]
const _: [Status; 4] = [Status::Ok, Status::Absent, Status::Denied, Status::Corrupt];

#[derive(Debug)]
pub struct Response {
    status: Status,
    payload: Vec<u8>,
}

impl Response {
    pub const fn empty(status: Status) -> Self {
        Self {
            status,
            payload: Vec::new(),
        }
    }

    #[cfg(any(windows, target_os = "macos"))]
    pub const fn protected(payload: Vec<u8>) -> Self {
        Self {
            status: Status::Ok,
            payload,
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let payload_length = u32::try_from(self.payload.len()).unwrap_or(u32::MAX);
        let mut result = Vec::with_capacity(13 + self.payload.len());
        result.extend_from_slice(RESPONSE_MAGIC);
        result.push(self.status as u8);
        result.extend_from_slice(&payload_length.to_be_bytes());
        result.extend_from_slice(&self.payload);
        result
    }
}

impl Drop for Response {
    fn drop(&mut self) {
        self.payload.zeroize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(operation: u8, target: &[u8], payload: &[u8]) -> Vec<u8> {
        let mut encoded = Vec::new();
        encoded.extend_from_slice(REQUEST_MAGIC);
        encoded.push(operation);
        encoded.extend_from_slice(&u16::try_from(target.len()).unwrap().to_be_bytes());
        encoded.extend_from_slice(&u32::try_from(payload.len()).unwrap().to_be_bytes());
        encoded.extend_from_slice(target);
        encoded.extend_from_slice(payload);
        encoded
    }

    #[test]
    fn parses_closed_binary_shapes() {
        let target = format!("runa-cli:v1:{}", "a".repeat(64));
        let parsed = Request::parse(&request(3, target.as_bytes(), b"secret")).unwrap();
        assert_eq!(parsed.operation, Operation::Replace);
        assert_eq!(parsed.target, target);
        assert_eq!(parsed.payload, b"secret");

        let browser =
            Request::parse(&request(5, b"", b"https://app.getcuna.com/cli/continue")).unwrap();
        assert_eq!(browser.operation, Operation::OpenBrowser);
        assert!(browser.target.is_empty());
    }

    #[test]
    fn rejects_unknown_operations_and_trailing_bytes() {
        assert_eq!(
            Request::parse(&request(99, b"", b"")).unwrap_err(),
            Status::Incompatible
        );
        let mut trailing = request(1, b"", b"");
        trailing.push(0);
        assert_eq!(
            Request::parse(&trailing).unwrap_err(),
            Status::InvalidRequest
        );
    }

    #[test]
    fn rejects_secret_bearing_shape_drift() {
        let target = format!("runa-cli:v1:{}", "a".repeat(64));
        assert_eq!(
            Request::parse(&request(2, target.as_bytes(), b"secret")).unwrap_err(),
            Status::InvalidRequest
        );
        assert_eq!(
            Request::parse(&request(3, target.as_bytes(), b"")).unwrap_err(),
            Status::InvalidRequest
        );
        assert_eq!(
            Request::parse(&request(5, b"target", b"https://example.com")).unwrap_err(),
            Status::InvalidRequest
        );
    }

    #[test]
    fn rejects_credential_targets_outside_the_exact_runa_namespace() {
        for target in [
            "arbitrary-credential",
            "runa-cli:v1:short",
            "runa-cli:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "runa-cli:v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ] {
            assert_eq!(
                Request::parse(&request(2, target.as_bytes(), b"")).unwrap_err(),
                Status::InvalidRequest
            );
        }
    }

    #[test]
    fn rejects_boundary_and_encoding_drift() {
        assert_eq!(
            Request::parse(&request(2, &[0xff], b"")).unwrap_err(),
            Status::InvalidRequest
        );
        assert_eq!(
            Request::parse(&request(2, b"target\0suffix", b"")).unwrap_err(),
            Status::InvalidRequest
        );
        assert_eq!(
            Request::parse(&request(3, b"target", &vec![7; MAXIMUM_PAYLOAD_BYTES + 1]))
                .unwrap_err(),
            Status::InvalidRequest
        );
    }
}
