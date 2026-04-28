pub mod go;
pub mod java;
pub mod js;
pub mod php;
pub mod python;
pub mod rust;

use crate::ir::models::FileIR;

/// Parse a file given its source, relative path, and detected language.
pub fn parse_file(source: &str, file_path: &str, language: &str) -> Option<FileIR> {
    match language {
        "rust" => Some(rust::parse_file(source, file_path)),
        "python" => Some(python::parse_file(source, file_path)),
        "javascript" => Some(js::parse_file(source, file_path, false)),
        "typescript" => Some(js::parse_file(source, file_path, true)),
        "go" => Some(go::parse_file(source, file_path)),
        "java" => Some(java::parse_file(source, file_path)),
        "php" => Some(php::parse_file(source, file_path)),
        _ => None,
    }
}
