use tree_sitter::Parser;

use crate::ir::models::{ApiEndpoint, FileIR, Function, Module};
use crate::utils::hash;

pub fn parse_file(source: &str, file_path: &str) -> FileIR {
    let mut parser = Parser::new();
    if let Err(e) = parser.set_language(&tree_sitter_java::LANGUAGE.into()) {
        log::warn!("Failed to set Java language: {}", e);
        return empty_file_ir(source, file_path);
    }

    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => {
            log::warn!("Failed to parse Java file: {}", file_path);
            return empty_file_ir(source, file_path);
        }
    };

    let root = tree.root_node();
    let source_bytes = source.as_bytes();

    let mut functions = Vec::new();
    let mut imports = Vec::new();
    let mut exports = Vec::new();
    let mut apis = Vec::new();

    collect_java_nodes(
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
        language: "java".to_string(),
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

fn collect_java_nodes(
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
            "import_declaration" => {
                if let Ok(text) = child.utf8_text(source_bytes) {
                    let imp = text
                        .trim()
                        .trim_start_matches("import ")
                        .trim_start_matches("static ")
                        .trim_end_matches(';')
                        .trim()
                        .to_string();
                    if !imp.is_empty() {
                        imports.push(imp);
                    }
                }
            }
            "class_declaration" | "interface_declaration" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    if let Ok(name) = name_node.utf8_text(source_bytes) {
                        // Check for public modifier
                        let is_public = has_modifier(&child, source_bytes, "public");
                        if is_public {
                            exports.push(name.to_string());
                        }
                    }
                }
                // Recurse into class body
                if let Some(body) = child.child_by_field_name("body") {
                    collect_java_class_body(
                        &body,
                        source_bytes,
                        file_path,
                        functions,
                        apis,
                        exports,
                    );
                }
            }
            _ => {
                collect_java_nodes(
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

fn collect_java_class_body(
    body: &tree_sitter::Node,
    source_bytes: &[u8],
    file_path: &str,
    functions: &mut Vec<Function>,
    apis: &mut Vec<ApiEndpoint>,
    exports: &mut Vec<String>,
) {
    for i in 0..body.child_count() {
        let child = match body.child(i) {
            Some(c) => c,
            None => continue,
        };

        if child.kind() == "method_declaration" || child.kind() == "constructor_declaration" {
            // Check for Spring annotations before the method
            let mut annotations = Vec::new();

            // Look at preceding siblings for annotations (they're siblings in the class body)
            // Actually, annotations in Java are children of the method node or preceding siblings
            // In tree-sitter-java, annotations can be modifiers of the method
            if let Ok(method_text) = child.utf8_text(source_bytes) {
                // Check for annotations in the text before the method
                for line in method_text.lines() {
                    let trimmed = line.trim();
                    if trimmed.starts_with('@') {
                        annotations.push(trimmed.to_string());
                    }
                }
            }

            if let Some(f) = parse_java_method(&child, source_bytes, file_path) {
                // Check Spring annotations
                for ann in &annotations {
                    if let Some(api) = detect_spring_api(ann, &f, file_path) {
                        apis.push(api);
                    }
                }
                if has_modifier(&child, source_bytes, "public") {
                    exports.push(f.name.clone());
                }
                functions.push(f);
            }
        }

        // Also check children that are annotated methods
        if child.kind() == "class_declaration" || child.kind() == "interface_declaration" {
            if let Some(inner_body) = child.child_by_field_name("body") {
                collect_java_class_body(&inner_body, source_bytes, file_path, functions, apis, exports);
            }
        }
    }
}

fn parse_java_method(
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
        .find(|l| l.contains('('))
        .unwrap_or_else(|| full_text.lines().next().unwrap_or(""))
        .trim()
        .trim_end_matches('{')
        .trim()
        .to_string();

    let inputs = extract_java_params(node, source_bytes);
    let calls = extract_java_calls(full_text);
    let func_hash = hash::hash_function(&signature, full_text);

    Some(Function {
        id: format!("fn:{}::{}", file_path, name),
        name,
        file: file_path.to_string(),
        language: "java".to_string(),
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

fn extract_java_params(node: &tree_sitter::Node, source_bytes: &[u8]) -> Vec<String> {
    let mut params = Vec::new();
    if let Some(param_list) = node.child_by_field_name("parameters") {
        for i in 0..param_list.named_child_count() {
            if let Some(param) = param_list.named_child(i) {
                if param.kind() == "formal_parameter" || param.kind() == "spread_parameter" {
                    if let Some(name_node) = param.child_by_field_name("name") {
                        if let Ok(pname) = name_node.utf8_text(source_bytes) {
                            params.push(pname.to_string());
                        }
                    }
                }
            }
        }
    }
    params
}

fn extract_java_calls(body: &str) -> Vec<String> {
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
                let mut end = i;
                // Skip generic params
                if end > 0 && chars[end - 1] == '>' {
                    let mut depth = 1;
                    let mut j = end.saturating_sub(2);
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
                        || chars[start - 1] == '.')
                {
                    start -= 1;
                }
                if start < end {
                    let call_name: String = chars[start..end].iter().collect();
                    if !call_name.is_empty()
                        && !is_java_keyword(&call_name)
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

fn is_java_keyword(s: &str) -> bool {
    matches!(
        s,
        "if" | "else"
            | "while"
            | "for"
            | "return"
            | "class"
            | "interface"
            | "import"
            | "package"
            | "new"
            | "instanceof"
            | "switch"
            | "case"
            | "break"
            | "continue"
            | "try"
            | "catch"
            | "finally"
            | "throw"
            | "throws"
            | "void"
            | "public"
            | "private"
            | "protected"
            | "static"
            | "final"
            | "abstract"
            | "synchronized"
            | "super"
            | "this"
    )
}

fn has_modifier(node: &tree_sitter::Node, source_bytes: &[u8], modifier: &str) -> bool {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "modifiers" {
                if let Ok(text) = child.utf8_text(source_bytes) {
                    return text.contains(modifier);
                }
            }
        }
    }
    false
}

fn detect_spring_api(annotation: &str, func: &Function, file_path: &str) -> Option<ApiEndpoint> {
    let ann = annotation.trim().trim_start_matches('@');

    let mapping_methods = [
        ("GetMapping", "GET"),
        ("PostMapping", "POST"),
        ("PutMapping", "PUT"),
        ("DeleteMapping", "DELETE"),
        ("PatchMapping", "PATCH"),
    ];

    for (mapping, method) in &mapping_methods {
        if ann.starts_with(mapping) {
            let route = extract_spring_route(ann).unwrap_or_else(|| "/".to_string());
            return Some(ApiEndpoint {
                route,
                method: method.to_string(),
                handler: format!("fn:{}::{}", file_path, func.name),
                language: "java".to_string(),
                file: file_path.to_string(),
                line: func.line,
            });
        }
    }

    if ann.starts_with("RequestMapping") {
        let route = extract_spring_route(ann).unwrap_or_else(|| "/".to_string());
        let method = if ann.contains("GET") {
            "GET"
        } else if ann.contains("POST") {
            "POST"
        } else if ann.contains("PUT") {
            "PUT"
        } else if ann.contains("DELETE") {
            "DELETE"
        } else {
            "GET"
        };
        return Some(ApiEndpoint {
            route,
            method: method.to_string(),
            handler: format!("fn:{}::{}", file_path, func.name),
            language: "java".to_string(),
            file: file_path.to_string(),
            line: func.line,
        });
    }

    None
}

fn extract_spring_route(ann: &str) -> Option<String> {
    // Look for quoted string
    if let Some(start) = ann.find('"') {
        let rest = &ann[start + 1..];
        if let Some(end) = rest.find('"') {
            let route = &rest[..end];
            return Some(route.to_string());
        }
    }
    None
}

fn empty_file_ir(source: &str, file_path: &str) -> FileIR {
    FileIR {
        functions: Vec::new(),
        module: Module {
            path: file_path.to_string(),
            language: "java".to_string(),
            imports: Vec::new(),
            exports: Vec::new(),
            hash: hash::hash_file(source.as_bytes()),
        },
        apis: Vec::new(),
    }
}
