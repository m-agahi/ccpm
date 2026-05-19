use tree_sitter::Parser;

use crate::ir::models::{ApiEndpoint, FileIR, Function, Module};
use crate::utils::hash;

pub fn parse_file(source: &str, file_path: &str) -> FileIR {
    let mut parser = Parser::new();
    if let Err(e) = parser.set_language(&tree_sitter_python::LANGUAGE.into()) {
        log::warn!("Failed to set Python language: {}", e);
        return empty_file_ir(source, file_path);
    }

    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => {
            log::warn!("Failed to parse Python file: {}", file_path);
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
            "import_statement" | "import_from_statement" => {
                if let Ok(text) = node.utf8_text(source_bytes) {
                    let import = extract_python_import(text);
                    if !import.is_empty() {
                        imports.push(import);
                    }
                }
            }
            "function_definition" => {
                if let Some(f) = parse_python_function(&node, source_bytes, file_path) {
                    exports.push(f.name.clone());
                    functions.push(f);
                }
            }
            "decorated_definition" => {
                // Check for API decorators and the inner function
                let mut decorator_texts = Vec::new();
                let mut inner_func = None;

                for j in 0..node.child_count() {
                    if let Some(child) = node.child(j) {
                        match child.kind() {
                            "decorator" => {
                                if let Ok(text) = child.utf8_text(source_bytes) {
                                    decorator_texts.push(text.to_string());
                                }
                            }
                            "function_definition" => {
                                inner_func =
                                    parse_python_function(&child, source_bytes, file_path);
                            }
                            _ => {}
                        }
                    }
                }

                if let Some(f) = inner_func {
                    // Check decorators for API routes
                    for dec in &decorator_texts {
                        if let Some(api) = detect_python_api(dec, &f, file_path) {
                            apis.push(api);
                        }
                    }
                    exports.push(f.name.clone());
                    functions.push(f);
                }
            }
            "class_definition" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    if let Ok(name) = name_node.utf8_text(source_bytes) {
                        exports.push(name.to_string());
                    }
                }
                // Parse methods inside class
                if let Some(body) = node.child_by_field_name("body") {
                    for j in 0..body.child_count() {
                        if let Some(child) = body.child(j) {
                            if child.kind() == "function_definition" {
                                if let Some(f) =
                                    parse_python_function(&child, source_bytes, file_path)
                                {
                                    functions.push(f);
                                }
                            } else if child.kind() == "decorated_definition" {
                                for k in 0..child.child_count() {
                                    if let Some(inner) = child.child(k) {
                                        if inner.kind() == "function_definition" {
                                            if let Some(f) = parse_python_function(
                                                &inner,
                                                source_bytes,
                                                file_path,
                                            ) {
                                                functions.push(f);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let module = Module {
        path: file_path.to_string(),
        language: "python".to_string(),
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

fn parse_python_function(
    node: &tree_sitter::Node,
    source_bytes: &[u8],
    file_path: &str,
) -> Option<Function> {
    let name_node = node.child_by_field_name("name")?;
    let name = name_node.utf8_text(source_bytes).ok()?.to_string();
    let line = node.start_position().row + 1;

    // Build signature from the first line
    let full_text = node.utf8_text(source_bytes).ok().unwrap_or("");
    let signature = full_text
        .lines()
        .next()
        .unwrap_or("")
        .trim_end_matches(':')
        .trim()
        .to_string();

    // Extract parameters
    let mut inputs = Vec::new();
    if let Some(params) = node.child_by_field_name("parameters") {
        for j in 0..params.named_child_count() {
            if let Some(param) = params.named_child(j) {
                match param.kind() {
                    "identifier" => {
                        if let Ok(pname) = param.utf8_text(source_bytes) {
                            if pname != "self" && pname != "cls" {
                                inputs.push(pname.to_string());
                            }
                        }
                    }
                    "typed_parameter" | "default_parameter" | "typed_default_parameter" => {
                        if let Some(name_child) = param.child(0) {
                            if let Ok(pname) = name_child.utf8_text(source_bytes) {
                                if pname != "self" && pname != "cls" {
                                    inputs.push(pname.to_string());
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    let is_async = {
        // Check if parent or node itself starts with "async"
        full_text.starts_with("async ")
    };

    let calls = extract_python_calls(full_text);
    let func_hash = hash::hash_function(&signature, full_text);

    Some(Function {
        id: format!("fn:{}::{}", file_path, name),
        name,
        file: file_path.to_string(),
        language: "python".to_string(),
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

fn extract_python_import(text: &str) -> String {
    let text = text.trim();
    if let Some(rest) = text.strip_prefix("from ") {
        // "from foo.bar import baz" -> "foo.bar"
        rest.split_whitespace().next().unwrap_or("").to_string()
    } else if let Some(rest) = text.strip_prefix("import ") {
        rest.split(',')
            .next()
            .unwrap_or("")
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_string()
    } else {
        String::new()
    }
}

fn extract_python_calls(body: &str) -> Vec<String> {
    let mut calls = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
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
                        && !is_python_keyword(&call_name)
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

fn is_python_keyword(s: &str) -> bool {
    matches!(
        s,
        "if" | "else"
            | "elif"
            | "while"
            | "for"
            | "return"
            | "def"
            | "class"
            | "import"
            | "from"
            | "with"
            | "as"
            | "try"
            | "except"
            | "finally"
            | "raise"
            | "yield"
            | "lambda"
            | "and"
            | "or"
            | "not"
            | "in"
            | "is"
            | "pass"
            | "break"
            | "continue"
            | "assert"
            | "async"
            | "await"
            | "print"
    )
}

fn detect_python_api(decorator: &str, func: &Function, file_path: &str) -> Option<ApiEndpoint> {
    let dec = decorator.trim().trim_start_matches('@');

    // Flask: @app.route("/path", methods=["GET"])
    // FastAPI: @app.get("/path"), @router.get("/path"), @app.post("/path")
    let http_methods = ["get", "post", "put", "delete", "patch"];

    for method in &http_methods {
        let pattern = format!(".{}(", method);
        if let Some(pos) = dec.find(&pattern) {
            let _ = pos;
            if let Some(route) = extract_route_from_decorator(dec) {
                return Some(ApiEndpoint {
                    route,
                    method: method.to_uppercase(),
                    handler: format!("fn:{}::{}", file_path, func.name),
                    language: "python".to_string(),
                    file: file_path.to_string(),
                    line: func.line,
                });
            }
        }
    }

    // @app.route("/path", methods=["GET"])
    if dec.contains(".route(") {
        if let Some(route) = extract_route_from_decorator(dec) {
            let method = if dec.contains("methods=") {
                // Try to extract the first method
                if dec.contains("POST") {
                    "POST"
                } else if dec.contains("PUT") {
                    "PUT"
                } else if dec.contains("DELETE") {
                    "DELETE"
                } else {
                    "GET"
                }
            } else {
                "GET"
            };
            return Some(ApiEndpoint {
                route,
                method: method.to_string(),
                handler: format!("fn:{}::{}", file_path, func.name),
                language: "python".to_string(),
                file: file_path.to_string(),
                line: func.line,
            });
        }
    }

    None
}

fn extract_route_from_decorator(dec: &str) -> Option<String> {
    // Find the first quoted string in the decorator
    let quote_chars = ['"', '\''];
    for &q in &quote_chars {
        if let Some(start) = dec.find(q) {
            let rest = &dec[start + 1..];
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

fn empty_file_ir(source: &str, file_path: &str) -> FileIR {
    FileIR {
        functions: Vec::new(),
        module: Module {
            path: file_path.to_string(),
            language: "python".to_string(),
            imports: Vec::new(),
            exports: Vec::new(),
            hash: hash::hash_file(source.as_bytes()),
        },
        apis: Vec::new(),
    }
}
