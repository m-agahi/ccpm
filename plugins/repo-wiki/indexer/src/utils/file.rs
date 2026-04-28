use std::path::Path;

/// Detect language from file extension.
pub fn detect_language(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?;
    match ext {
        "py" => Some("python"),
        "rs" => Some("rust"),
        "js" => Some("javascript"),
        "ts" => Some("typescript"),
        "go" => Some("go"),
        "java" => Some("java"),
        "php" => Some("php"),
        _ => None,
    }
}

/// Check if a directory component should be ignored.
pub fn is_ignored_dir(name: &str) -> bool {
    matches!(name, ".git" | "node_modules" | "target" | "vendor")
}
