use tree_sitter::Parser;

use crate::ir::models::{ApiEndpoint, FileIR, Function, Module};
use crate::utils::hash;

/// Parse a JavaScript or TypeScript file.
/// When `is_typescript` is true, uses the TypeScript grammar.
pub fn parse_file(source: &str, file_path: &str, is_typescript: bool) -> FileIR {
    let language_name = if is_typescript {
        "typescript"
    } else {
        "javascript"
    };

    let mut parser = Parser::new();
    let lang = if is_typescript {
        tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
    } else {
        tree_sitter_javascript::LANGUAGE.into()
    };

    if let Err(e) = parser.set_language(&lang) {
        log::warn!("Failed to set {} language: {}", language_name, e);
        return empty_file_ir(source, file_path, language_name);
    }

    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => {
            log::warn!("Failed to parse {} file: {}", language_name, file_path);
            return empty_file_ir(source, file_path, language_name);
        }
    };

    let root = tree.root_node();
    let source_bytes = source.as_bytes();

    let mut functions = Vec::new();
    let mut imports = Vec::new();
    let mut exports = Vec::new();
    let mut apis = Vec::new();

    collect_nodes(&root, source_bytes, file_path, language_name,
        &mut functions, &mut imports, &mut exports, &mut apis);

    let module = Module {
        path: file_path.to_string(),
        language: language_name.to_string(),
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

fn collect_nodes(
    node: &tree_sitter::Node,
    source_bytes: &[u8],
    file_path: &str,
    language_name: &str,
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
            "import_statement" => {
                if let Ok(text) = child.utf8_text(source_bytes) {
                    if let Some(imp) = extract_js_import(text) {
                        imports.push(imp);
                    }
                }
            }
            "export_statement" => {
                // Check for exported function declarations
                for j in 0..child.child_count() {
                    if let Some(inner) = child.child(j) {
                        if inner.kind() == "function_declaration"
                            || inner.kind() == "lexical_declaration"
                        {
                            if let Some(f) = parse_js_function(&inner, source_bytes, file_path, language_name) {
                                exports.push(f.name.clone());
                                functions.push(f);
                            }
                        }
                    }
                }
            }
            "function_declaration" => {
                if let Some(f) = parse_js_function(&child, source_bytes, file_path, language_name) {
                    functions.push(f);
                }
            }
            "lexical_declaration" | "variable_declaration" => {
                // Arrow functions: const foo = (...) => { ... }
                if let Some(f) = parse_js_function(&child, source_bytes, file_path, language_name) {
                    functions.push(f);
                }
            }
            "expression_statement" => {
                // Check for Express-style API routes: app.get("/path", handler)
                if let Ok(text) = child.utf8_text(source_bytes) {
                    if let Some(api) = detect_express_api(text, file_path, language_name, child.start_position().row + 1) {
                        apis.push(api);
                    }
                }
            }
            _ => {
                // Recurse for nested structures (e.g., class bodies)
                collect_nodes(&child, source_bytes, file_path, language_name,
                    functions, imports, exports, apis);
            }
        }
    }
}

fn parse_js_function(
    node: &tree_sitter::Node,
    source_bytes: &[u8],
    file_path: &str,
    language_name: &str,
) -> Option<Function> {
    let full_text = node.utf8_text(source_bytes).ok()?;

    let name = match node.kind() {
        "function_declaration" => {
            node.child_by_field_name("name")
                .and_then(|n| n.utf8_text(source_bytes).ok())
                .map(|s| s.to_string())
        }
        "lexical_declaration" | "variable_declaration" => {
            // const foo = (...) => {}  or  const foo = function() {}
            node.named_child(0)
                .and_then(|declarator| declarator.child_by_field_name("name"))
                .and_then(|n| n.utf8_text(source_bytes).ok())
                .map(|s| s.to_string())
        }
        _ => None,
    }?;

    let line = node.start_position().row + 1;

    let signature = full_text
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();

    let is_async = full_text.contains("async ");

    // Extract parameter names
    let inputs = extract_js_params(node, source_bytes);
    let calls = extract_js_calls(full_text);
    let func_hash = hash::hash_function(&signature, full_text);

    Some(Function {
        id: format!("fn:{}::{}", file_path, name),
        name,
        file: file_path.to_string(),
        language: language_name.to_string(),
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

fn extract_js_params(node: &tree_sitter::Node, source_bytes: &[u8]) -> Vec<String> {
    let mut params = Vec::new();

    // For function_declaration, parameters are a direct child
    // For lexical_declaration, we need to dig into the arrow function
    let param_node = if node.kind() == "function_declaration" {
        node.child_by_field_name("parameters")
    } else {
        // lexical_declaration -> variable_declarator -> arrow_function -> formal_parameters
        node.named_child(0)
            .and_then(|decl| decl.child_by_field_name("value"))
            .and_then(|val| val.child_by_field_name("parameters"))
    };

    if let Some(pnode) = param_node {
        for i in 0..pnode.named_child_count() {
            if let Some(p) = pnode.named_child(i) {
                if let Ok(text) = p.utf8_text(source_bytes) {
                    // Strip type annotations for TS
                    let name = text.split(':').next().unwrap_or(text).trim();
                    let name = name.split('=').next().unwrap_or(name).trim();
                    if !name.is_empty() {
                        params.push(name.to_string());
                    }
                }
            }
        }
    }

    params
}

fn extract_js_import(text: &str) -> Option<String> {
    // import foo from "bar"  or  import { foo } from "bar"  or  const foo = require("bar")
    let text = text.trim().trim_end_matches(';');

    // ES6 imports
    if text.starts_with("import ") {
        if let Some(from_pos) = text.rfind("from ") {
            let path = text[from_pos + 5..].trim().trim_matches(|c| c == '"' || c == '\'');
            return Some(path.to_string());
        }
    }

    // require
    if text.contains("require(") {
        if let Some(start) = text.find("require(") {
            let rest = &text[start + 8..];
            let path = rest.trim_start_matches(|c| c == '"' || c == '\'');
            if let Some(end) = path.find(|c: char| c == '"' || c == '\'' || c == ')') {
                return Some(path[..end].to_string());
            }
        }
    }

    None
}

fn extract_js_calls(body: &str) -> Vec<String> {
    let mut calls = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("//") || trimmed.starts_with("/*") {
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
                        || chars[start - 1] == '.'
                        || chars[start - 1] == '$')
                {
                    start -= 1;
                }
                if start < end {
                    let call_name: String = chars[start..end].iter().collect();
                    if !call_name.is_empty()
                        && !is_js_keyword(&call_name)
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

fn is_js_keyword(s: &str) -> bool {
    matches!(
        s,
        "if" | "else"
            | "while"
            | "for"
            | "return"
            | "function"
            | "var"
            | "let"
            | "const"
            | "class"
            | "import"
            | "export"
            | "from"
            | "new"
            | "typeof"
            | "instanceof"
            | "switch"
            | "case"
            | "break"
            | "continue"
            | "try"
            | "catch"
            | "finally"
            | "throw"
            | "async"
            | "await"
            | "yield"
    )
}

fn detect_express_api(
    text: &str,
    file_path: &str,
    language_name: &str,
    line: usize,
) -> Option<ApiEndpoint> {
    let text = text.trim();
    let methods = ["get", "post", "put", "delete", "patch"];

    for method in &methods {
        // app.get("/path", ...) or router.get("/path", ...)
        let patterns = [
            format!("app.{}(", method),
            format!("router.{}(", method),
        ];
        for pattern in &patterns {
            if text.contains(pattern.as_str()) {
                if let Some(route) = extract_quoted_route(text) {
                    // Try to extract handler name
                    let handler_name = extract_express_handler(text);
                    return Some(ApiEndpoint {
                        route,
                        method: method.to_uppercase(),
                        handler: format!("fn:{}::{}", file_path, handler_name),
                        language: language_name.to_string(),
                        file: file_path.to_string(),
                        line,
                    });
                }
            }
        }
    }

    None
}

fn extract_quoted_route(text: &str) -> Option<String> {
    for q in ['"', '\'', '`'] {
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

fn extract_express_handler(text: &str) -> String {
    // Try to find the handler argument after the route string
    // app.get("/path", handlerName)
    if let Some(comma_pos) = text.find(',') {
        let rest = text[comma_pos + 1..].trim();
        let handler: String = rest
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        if !handler.is_empty() {
            return handler;
        }
    }
    "anonymous".to_string()
}

fn empty_file_ir(source: &str, file_path: &str, language_name: &str) -> FileIR {
    FileIR {
        functions: Vec::new(),
        module: Module {
            path: file_path.to_string(),
            language: language_name.to_string(),
            imports: Vec::new(),
            exports: Vec::new(),
            hash: hash::hash_file(source.as_bytes()),
        },
        apis: Vec::new(),
    }
}
