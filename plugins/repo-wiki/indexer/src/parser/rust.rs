use tree_sitter::Parser;

use crate::ir::models::{FileIR, Function, Module};
use crate::utils::hash;

pub fn parse_file(source: &str, file_path: &str) -> FileIR {
    let mut parser = Parser::new();
    // tree-sitter-rust 0.21 is compatible with tree-sitter 0.22
    if let Err(e) = parser.set_language(&tree_sitter_rust::LANGUAGE.into()) {
        log::warn!("Failed to set Rust language: {}", e);
        return empty_file_ir(source, file_path);
    }

    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => {
            log::warn!("Failed to parse Rust file: {}", file_path);
            return empty_file_ir(source, file_path);
        }
    };

    let root = tree.root_node();
    let source_bytes = source.as_bytes();

    let mut functions = Vec::new();
    let mut imports = Vec::new();
    let mut exports = Vec::new();

    for i in 0..root.child_count() {
        let node = match root.child(i) {
            Some(n) => n,
            None => continue,
        };

        match node.kind() {
            "use_declaration" => {
                if let Ok(text) = node.utf8_text(source_bytes) {
                    // Extract the import path from "use foo::bar;"
                    let import = text
                        .trim_start_matches("use ")
                        .trim_end_matches(';')
                        .trim()
                        .to_string();
                    imports.push(import);
                }
            }
            "function_item" => {
                let is_pub = node
                    .child(0)
                    .map(|c| c.kind() == "visibility_modifier")
                    .unwrap_or(false);

                let func = parse_function_item(&node, source_bytes, file_path);
                if let Some(f) = func {
                    if is_pub {
                        exports.push(f.name.clone());
                    }
                    functions.push(f);
                }
            }
            "impl_item" => {
                // Parse methods inside impl blocks
                for j in 0..node.child_count() {
                    if let Some(child) = node.child(j) {
                        if child.kind() == "declaration_list" {
                            for k in 0..child.child_count() {
                                if let Some(item) = child.child(k) {
                                    if item.kind() == "function_item" {
                                        let is_pub = item
                                            .child(0)
                                            .map(|c| c.kind() == "visibility_modifier")
                                            .unwrap_or(false);
                                        if let Some(f) =
                                            parse_function_item(&item, source_bytes, file_path)
                                        {
                                            if is_pub {
                                                exports.push(f.name.clone());
                                            }
                                            functions.push(f);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            "struct_item" | "enum_item" | "type_item" => {
                let is_pub = node
                    .child(0)
                    .map(|c| c.kind() == "visibility_modifier")
                    .unwrap_or(false);
                if is_pub {
                    if let Some(name_node) = node.child_by_field_name("name") {
                        if let Ok(name) = name_node.utf8_text(source_bytes) {
                            exports.push(name.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let module = Module {
        path: file_path.to_string(),
        language: "rust".to_string(),
        imports,
        exports,
        hash: hash::hash_file(source_bytes),
    };

    FileIR {
        functions,
        module,
        apis: Vec::new(), // Rust API detection not implemented
    }
}

fn parse_function_item(
    node: &tree_sitter::Node,
    source_bytes: &[u8],
    file_path: &str,
) -> Option<Function> {
    let name_node = node.child_by_field_name("name")?;
    let name = name_node.utf8_text(source_bytes).ok()?.to_string();

    let line = node.start_position().row + 1; // 1-indexed for output

    let signature = node.utf8_text(source_bytes).ok().map(|text| {
        // Extract up to the opening brace as the signature
        text.split('{').next().unwrap_or(text).trim().to_string()
    }).unwrap_or_default();

    let body = node.utf8_text(source_bytes).ok().unwrap_or("");

    // Extract parameter names
    let mut inputs = Vec::new();
    if let Some(params) = node.child_by_field_name("parameters") {
        for j in 0..params.named_child_count() {
            if let Some(param) = params.named_child(j) {
                if param.kind() == "parameter" || param.kind() == "self_parameter" {
                    if let Some(pattern) = param.child_by_field_name("pattern") {
                        if let Ok(pname) = pattern.utf8_text(source_bytes) {
                            inputs.push(pname.to_string());
                        }
                    } else if param.kind() == "self_parameter" {
                        inputs.push("self".to_string());
                    }
                }
            }
        }
    }

    // Extract function calls from body (simple heuristic: identifiers followed by '(')
    let calls = extract_calls_from_body(body);

    let is_async = signature.contains("async ");

    let func_hash = hash::hash_function(&signature, body);

    Some(Function {
        id: format!("fn:{}::{}", file_path, name),
        name,
        file: file_path.to_string(),
        language: "rust".to_string(),
        line,
        signature,
        inputs,
        outputs: Vec::new(),
        calls,
        side_effects: Vec::new(),
        is_async,
        hash: func_hash,
    })
}

/// Simple heuristic to extract function call names from a body string.
fn extract_calls_from_body(body: &str) -> Vec<String> {
    let mut calls = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Match patterns like `name(` or `name::<...>(`
    for line in body.lines() {
        let trimmed = line.trim();
        // Skip comments
        if trimmed.starts_with("//") || trimmed.starts_with("/*") {
            continue;
        }
        let chars: Vec<char> = trimmed.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] == '(' && i > 0 {
                // Walk backwards to find the function name
                let mut end = i;
                // Skip generic params
                if end > 0 && chars[end - 1] == '>' {
                    let mut depth = 1;
                    let mut j = end - 2;
                    while j > 0 && depth > 0 {
                        if chars[j] == '>' {
                            depth += 1;
                        } else if chars[j] == '<' {
                            depth -= 1;
                        }
                        j -= 1;
                    }
                    end = j + 1;
                }
                let mut start = end;
                while start > 0
                    && (chars[start - 1].is_alphanumeric()
                        || chars[start - 1] == '_'
                        || chars[start - 1] == '.'
                        || chars[start - 1] == ':')
                {
                    start -= 1;
                }
                if start < end {
                    let call_name: String = chars[start..end].iter().collect();
                    let call_name = call_name.trim_start_matches(':').to_string();
                    if !call_name.is_empty()
                        && !is_rust_keyword(&call_name)
                        && seen.insert(call_name.clone())
                    {
                        calls.push(call_name);
                    }
                }
            }
            i += 1;
        }
    }

    calls
}

fn is_rust_keyword(s: &str) -> bool {
    matches!(
        s,
        "if" | "else"
            | "while"
            | "for"
            | "loop"
            | "match"
            | "return"
            | "let"
            | "mut"
            | "fn"
            | "pub"
            | "use"
            | "mod"
            | "struct"
            | "enum"
            | "impl"
            | "trait"
            | "where"
            | "type"
            | "const"
            | "static"
            | "unsafe"
            | "extern"
            | "crate"
            | "self"
            | "super"
            | "as"
            | "in"
            | "ref"
            | "move"
            | "async"
            | "await"
    )
}

fn empty_file_ir(source: &str, file_path: &str) -> FileIR {
    FileIR {
        functions: Vec::new(),
        module: Module {
            path: file_path.to_string(),
            language: "rust".to_string(),
            imports: Vec::new(),
            exports: Vec::new(),
            hash: hash::hash_file(source.as_bytes()),
        },
        apis: Vec::new(),
    }
}
