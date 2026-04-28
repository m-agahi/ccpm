use sha2::{Digest, Sha256};

/// SHA256 hash of a byte slice, returned as a lowercase hex string.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

/// Hash a function by concatenating its signature and body.
pub fn hash_function(signature: &str, body: &str) -> String {
    let combined = format!("{}{}", signature, body);
    sha256_hex(combined.as_bytes())
}

/// Hash a file's full contents.
pub fn hash_file(content: &[u8]) -> String {
    sha256_hex(content)
}
