use tree_sitter::Parser;

use crate::ir::models::{ApiEndpoint, FileIR, Function, Module};
use crate::utils::hash;

pub fn parse_file(source: &str, file_path: &str) -> FileIR {
    let mut parser = Parser::new();
    if let Err(e) = parser.set_language(&tree_sitter_php::language_php()) {
        log::warn!("Failed to set PHP language: {}", e);
        return empty_file_ir(source, file_path);
    }

    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => {
            log::warn!("Failed to parse PHP file: {}", file_path);
            return empty_file_ir(source, file_path);
        }
    };

    let root = tree.root_node();
    let source_bytes = source.as_bytes();

    let mut functions = Vec::new();
    let mut imports = Vec::new();
    let mut exports = Vec::new();
    let mut apis = Vec::new();

    collect_php_nodes(
        &root,
        source_bytes,
        file_path,
        &mut functions,
        &mut imports,
        &mut exports,
        &mut apis,
    );

    let module = Module {
        path: file_path.to_string(),
        language: "php".to_string(),
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

fn collect_php_nodes(
    node: &tree_sitter::Node,
    source_bytes: &[u8],
    file_path: &str,
    functions: &mut Vec<Function>,
    imports: &mut Vec<String>,
    exports: &mut Vec<String>,
    apis: &mut Vec<ApiEndpoint>,
) {
    for i in 0..node.child_count() {
        let child = match node.child(i) {
            Some(c) => c,
            None => continue,
        };

        match child.kind() {
            "namespace_use_declaration" => {
                if let Ok(text) = child.utf8_text(source_bytes) {
                    let imp = text
                        .trim()
                        .trim_start_matches("use ")
                        .trim_end_matches(';')
                        .trim()
                        .to_string();
                    if !imp.is_empty() {
                        imports.push(imp);
                    }
                }
            }
            "function_definition" => {
                if let Some(f) = parse_php_function(&child, source_bytes, file_path) {
                    exports.push(f.name.clone());
                    functions.push(f);
                }
            }
            "class_declaration" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    if let Ok(name) = name_node.utf8_text(source_bytes) {
                        exports.push(name.to_string());
                    }
                }
                // Parse methods
                if let Some(body) = child.child_by_field_name("body") {
                    for j in 0..body.child_count() {
                        if let Some(member) = body.child(j) {
                            if member.kind() == "method_declaration" {
                                if let Some(f) =
                                    parse_php_function(&member, source_bytes, file_path)
                                {
                                    functions.push(f);
                                }
                            }
                        }
                    }
                }
            }
            "expression_statement" => {
                // Check for Laravel route definitions
                if let Ok(text) = child.utf8_text(source_bytes) {
                    if let Some(api) =
                        detect_laravel_api(text, file_path, child.start_position().row + 1)
                    {
                        apis.push(api);
                    }
                }
            }
            _ => {
                collect_php_nodes(
                    &child,
                    source_bytes,
                    file_path,
                    functions,
                    imports,
                    exports,
                    apis,
                );
            }
        }
    }
}

fn parse_php_function(
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

    let inputs = extract_php_params(node, source_bytes);
    let calls = extract_php_calls(full_text);
    let func_hash = hash::hash_function(&signature, full_text);

    Some(Function {
        id: format!("fn:{}::{}", file_path, name),
        name,
        file: file_path.to_string(),
        language: "php".to_string(),
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

fn extract_php_params(node: &tree_sitter::Node, source_bytes: &[u8]) -> Vec<String> {
    let mut params = Vec::new();
    if let Some(param_list) = node.child_by_field_name("parameters") {
        for i in 0..param_list.named_child_count() {
            if let Some(param) = param_list.named_child(i) {
                if param.kind() == "simple_parameter" || param.kind() == "property_promotion_parameter" {
                    if let Some(name_node) = param.child_by_field_name("name") {
                        if let Ok(pname) = name_node.utf8_text(source_bytes) {
                            params.push(pname.trim_start_matches('$').to_string());
                        }
                    }
                }
            }
        }
    }
    params
}

fn extract_php_calls(body: &str) -> Vec<String> {
    let mut calls = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("//") || trimmed.starts_with("/*") || trimmed.starts_with("*") {
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
                        || chars[start - 1] == '\\'
                        || chars[start - 1] == ':'
                        || chars[start - 1] == '-'
                        || chars[start - 1] == '>')
                {
                    start -= 1;
                }
                if start < end {
                    let call_name: String = chars[start..end].iter().collect();
                    // Clean up arrow operator
                    let call_name = call_name.trim_start_matches("->").to_string();
                    if !call_name.is_empty()
                        && !is_php_keyword(&call_name)
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

fn is_php_keyword(s: &str) -> bool {
    matches!(
        s,
        "if" | "else"
            | "elseif"
            | "while"
            | "for"
            | "foreach"
            | "return"
            | "function"
            | "class"
            | "new"
            | "echo"
            | "print"
            | "isset"
            | "empty"
            | "unset"
            | "array"
            | "list"
            | "switch"
            | "case"
            | "break"
            | "continue"
            | "try"
            | "catch"
            | "finally"
            | "throw"
            | "use"
            | "namespace"
    )
}

fn detect_laravel_api(text: &str, file_path: &str, line: usize) -> Option<ApiEndpoint> {
    let text = text.trim();
    let methods = ["get", "post", "put", "delete", "patch"];

    for method in &methods {
        // Route::get("/path", ...) or Route::post("/path", ...)
        let pattern = format!("Route::{}(", method);
        if text.contains(&pattern) {
            if let Some(route) = extract_php_route(text) {
                let handler = extract_php_handler(text);
                return Some(ApiEndpoint {
                    route,
                    method: method.to_uppercase(),
                    handler: format!("fn:{}::{}", file_path, handler),
                    language: "php".to_string(),
                    file: file_path.to_string(),
                    line,
                });
            }
        }
    }

    None
}

fn extract_php_route(text: &str) -> Option<String> {
    for q in ['"', '\''] {
        if let Some(start) = text.find(q) {
            let rest = &text[start + 1..];
            if let Some(end) = rest.find(q) {
                let route = &rest[..end];
                if route.starts_with('/') {
                    return Some(route.to_string());
                }
            }
        }
    }
    None
}

fn extract_php_handler(text: &str) -> String {
    // Try to find controller@method or [Controller::class, 'method'] pattern
    if text.contains('@') {
        // "UserController@show"
        if let Some(start) = text.rfind('@') {
            let rest = &text[start + 1..];
            let handler: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if !handler.is_empty() {
                return handler;
            }
        }
    }
    "anonymous".to_string()
}

fn empty_file_ir(source: &str, file_path: &str) -> FileIR {
    FileIR {
        functions: Vec::new(),
        module: Module {
            path: file_path.to_string(),
            language: "php".to_string(),
            imports: Vec::new(),
            exports: Vec::new(),
            hash: hash::hash_file(source.as_bytes()),
        },
        apis: Vec::new(),
    }
}
