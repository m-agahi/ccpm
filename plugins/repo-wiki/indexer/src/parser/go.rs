use tree_sitter::Parser;

use crate::ir::models::{ApiEndpoint, FileIR, Function, Module};
use crate::utils::hash;

pub fn parse_file(source: &str, file_path: &str) -> FileIR {
    let mut parser = Parser::new();
    if let Err(e) = parser.set_language(&tree_sitter_go::LANGUAGE.into()) {
        log::warn!("Failed to set Go language: {}", e);
        return empty_file_ir(source, file_path);
    }

    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => {
            log::warn!("Failed to parse Go file: {}", file_path);
            return empty_file_ir(source, file_path);
        }
    };

    let root = tree.root_node();
    let source_bytes = source.as_bytes();

    let mut functions = Vec::new();
    let mut imports = Vec::new();
    let mut exports = Vec::new();
    let mut apis = Vec::new();

    for i in 0..root.child_count() {
        let node = match root.child(i) {
            Some(n) => n,
            None => continue,
        };

        match node.kind() {
            "import_declaration" => {
                // Can be single import or import block
                for j in 0..node.child_count() {
                    if let Some(child) = node.child(j) {
                        if child.kind() == "import_spec_list" {
                            for k in 0..child.child_count() {
                                if let Some(spec) = child.child(k) {
                                    if spec.kind() == "import_spec" {
                                        if let Some(path) = spec.child_by_field_name("path") {
                                            if let Ok(text) = path.utf8_text(source_bytes) {
                                                let imp = text.trim_matches('"').to_string();
                                                imports.push(imp);
                                            }
                                        }
                                    }
                                }
                            }
                        } else if child.kind() == "import_spec" {
                            if let Some(path) = child.child_by_field_name("path") {
                                if let Ok(text) = path.utf8_text(source_bytes) {
                                    let imp = text.trim_matches('"').to_string();
                                    imports.push(imp);
                                }
                            }
                        }
                    }
                }
            }
            "function_declaration" => {
                if let Some(f) = parse_go_function(&node, source_bytes, file_path) {
                    // In Go, exported names start with uppercase
                    if f.name.starts_with(|c: char| c.is_uppercase()) {
                        exports.push(f.name.clone());
                    }
                    // Check for HTTP handler registrations in body
                    if let Ok(text) = node.utf8_text(source_bytes) {
                        detect_go_apis(text, file_path, &mut apis);
                    }
                    functions.push(f);
                }
            }
            "method_declaration" => {
                if let Some(f) = parse_go_method(&node, source_bytes, file_path) {
                    if f.name.starts_with(|c: char| c.is_uppercase()) {
                        exports.push(f.name.clone());
                    }
                    functions.push(f);
                }
            }
            _ => {}
        }
    }

    let module = Module {
        path: file_path.to_string(),
        language: "go".to_string(),
        imports,
        exports,
        hash: hash::hash_file(source_bytes),
    };

    FileIR {
        functions,
        module,
        apis,
    }
}

fn parse_go_function(
    node: &tree_sitter::Node,
    source_bytes: &[u8],
    file_path: &str,
) -> Option<Function> {
    let name_node = node.child_by_field_name("name")?;
    let name = name_node.utf8_text(source_bytes).ok()?.to_string();
    let line = node.start_position().row + 1;

    let full_text = node.utf8_text(source_bytes).ok().unwrap_or("");
    let signature = full_text
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .trim_end_matches('{')
        .trim()
        .to_string();

    let inputs = extract_go_params(node, source_bytes);
    let calls = extract_go_calls(full_text);
    let func_hash = hash::hash_function(&signature, full_text);

    Some(Function {
        id: format!("fn:{}::{}", file_path, name),
        name,
        file: file_path.to_string(),
        language: "go".to_string(),
        line,
        signature,
        inputs,
        outputs: Vec::new(),
        calls,
        side_effects: Vec::new(),
        is_async: false,
        hash: func_hash,
    })
}

fn parse_go_method(
    node: &tree_sitter::Node,
    source_bytes: &[u8],
    file_path: &str,
) -> Option<Function> {
    let name_node = node.child_by_field_name("name")?;
    let name = name_node.utf8_text(source_bytes).ok()?.to_string();
    let line = node.start_position().row + 1;

    let full_text = node.utf8_text(source_bytes).ok().unwrap_or("");
    let signature = full_text
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .trim_end_matches('{')
        .trim()
        .to_string();

    let inputs = extract_go_params(node, source_bytes);
    let calls = extract_go_calls(full_text);
    let func_hash = hash::hash_function(&signature, full_text);

    Some(Function {
        id: format!("fn:{}::{}", file_path, name),
        name,
        file: file_path.to_string(),
        language: "go".to_string(),
        line,
        signature,
        inputs,
        outputs: Vec::new(),
        calls,
        side_effects: Vec::new(),
        is_async: false,
        hash: func_hash,
    })
}

fn extract_go_params(node: &tree_sitter::Node, source_bytes: &[u8]) -> Vec<String> {
    let mut params = Vec::new();
    if let Some(param_list) = node.child_by_field_name("parameters") {
        for i in 0..param_list.named_child_count() {
            if let Some(param) = param_list.named_child(i) {
                if param.kind() == "parameter_declaration" {
                    // Parameter name is the first identifier child
                    if let Some(name_node) = param.child(0) {
                        if let Ok(pname) = name_node.utf8_text(source_bytes) {
                            let pname = pname.trim();
                            if !pname.is_empty() && pname != "(" && pname != ")" {
                                params.push(pname.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    params
}

fn extract_go_calls(body: &str) -> Vec<String> {
    let mut calls = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("//") {
            continue;
        }
        let chars: Vec<char> = trimmed.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] == '(' && i > 0 {
                let end = i;
                let mut start = end;
                while start > 0
                    && (chars[start - 1].is_alphanumeric()
                        || chars[start - 1] == '_'
                        || chars[start - 1] == '.')
                {
                    start -= 1;
                }
                if start < end {
                    let call_name: String = chars[start..end].iter().collect();
                    if !call_name.is_empty()
                        && !is_go_keyword(&call_name)
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

fn is_go_keyword(s: &str) -> bool {
    matches!(
        s,
        "if" | "else"
            | "for"
            | "range"
            | "switch"
            | "case"
            | "return"
            | "func"
            | "var"
            | "const"
            | "type"
            | "struct"
            | "interface"
            | "map"
            | "chan"
            | "go"
            | "defer"
            | "select"
            | "package"
            | "import"
    )
}

fn detect_go_apis(body: &str, file_path: &str, apis: &mut Vec<ApiEndpoint>) {
    for (line_num, line) in body.lines().enumerate() {
        let trimmed = line.trim();
        // http.HandleFunc("/path", handler)
        // mux.Handle("/path", handler)
        // mux.HandleFunc("/path", handler)
        let patterns = [
            "http.HandleFunc(",
            "mux.Handle(",
            "mux.HandleFunc(",
            ".HandleFunc(",
            ".Handle(",
        ];
        for pattern in &patterns {
            if trimmed.contains(pattern) {
                if let Some(route) = extract_go_route(trimmed) {
                    let handler = extract_go_handler(trimmed);
                    apis.push(ApiEndpoint {
                        route,
                        method: "GET".to_string(), // Go stdlib doesn't specify method inline
                        handler: format!("fn:{}::{}", file_path, handler),
                        language: "go".to_string(),
                        file: file_path.to_string(),
                        line: line_num + 1,
                    });
                }
            }
        }
    }
}

fn extract_go_route(text: &str) -> Option<String> {
    if let Some(start) = text.find('"') {
        let rest = &text[start + 1..];
        if let Some(end) = rest.find('"') {
            let route = &rest[..end];
            if route.starts_with('/') {
                return Some(route.to_string());
            }
        }
    }
    None
}

fn extract_go_handler(text: &str) -> String {
    // Find the second argument after the route string
    if let Some(first_quote_end) = text.find('"').and_then(|s| {
        text[s + 1..].find('"').map(|e| s + 1 + e + 1)
    }) {
        let rest = text[first_quote_end..].trim().trim_start_matches(',').trim();
        let handler: String = rest
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '.')
            .collect();
        if !handler.is_empty() {
            return handler;
        }
    }
    "anonymous".to_string()
}

fn empty_file_ir(source: &str, file_path: &str) -> FileIR {
    FileIR {
        functions: Vec::new(),
        module: Module {
            path: file_path.to_string(),
            language: "go".to_string(),
            imports: Vec::new(),
            exports: Vec::new(),
            hash: hash::hash_file(source.as_bytes()),
        },
        apis: Vec::new(),
    }
}
