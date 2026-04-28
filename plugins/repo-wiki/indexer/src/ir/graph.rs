use std::collections::{HashMap, HashSet};

use crate::ir::models::{
    CallGraph, CallGraphEdge, DependencyEdge, DependencyGraph, FileIR, Function,
};

/// Build a call graph from all parsed functions.
///
/// For each function, attempt to resolve names in `calls` to known function IDs.
/// If a call target matches a known function name, emit an edge.
pub fn build_call_graph(all_files: &[FileIR]) -> CallGraph {
    // Build a lookup: function name -> list of function IDs
    let mut name_to_ids: HashMap<&str, Vec<&str>> = HashMap::new();
    for file_ir in all_files {
        for func in &file_ir.functions {
            name_to_ids
                .entry(func.name.as_str())
                .or_default()
                .push(func.id.as_str());
        }
    }

    let mut edges: Vec<CallGraphEdge> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();

    for file_ir in all_files {
        for func in &file_ir.functions {
            for call in &func.calls {
                let call_name = call.rsplit('.').next().unwrap_or(call.as_str());
                if let Some(target_ids) = name_to_ids.get(call_name) {
                    for &target_id in target_ids {
                        if target_id != func.id {
                            let key = (func.id.clone(), target_id.to_string());
                            if seen.insert(key) {
                                edges.push(CallGraphEdge {
                                    from: func.id.clone(),
                                    to: target_id.to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    CallGraph { edges }
}

/// Build a file-level dependency graph from module imports.
///
/// For each module, check if any of its imports match the path (stem) of another module.
pub fn build_dependency_graph(all_files: &[FileIR]) -> DependencyGraph {
    let mut node_set: HashSet<String> = HashSet::new();
    let mut edges: Vec<DependencyEdge> = Vec::new();
    let mut seen_edges: HashSet<(String, String)> = HashSet::new();

    // Collect all module paths
    let module_paths: Vec<&str> = all_files.iter().map(|f| f.module.path.as_str()).collect();

    for file_ir in all_files {
        node_set.insert(file_ir.module.path.clone());
        for import in &file_ir.module.imports {
            for &other_path in &module_paths {
                if other_path == file_ir.module.path {
                    continue;
                }
                // Match import to module path stem or full path
                let stem = std::path::Path::new(other_path)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("");
                let without_ext = other_path.trim_end_matches(
                    &std::path::Path::new(other_path)
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| format!(".{}", e))
                        .unwrap_or_default(),
                );
                // Convert path separators for comparison
                let import_normalized = import.replace('.', "/");
                if import == stem
                    || import == without_ext
                    || import_normalized == without_ext
                    || import.contains(stem) && !stem.is_empty()
                {
                    let key = (file_ir.module.path.clone(), other_path.to_string());
                    if seen_edges.insert(key) {
                        node_set.insert(other_path.to_string());
                        edges.push(DependencyEdge {
                            from: file_ir.module.path.clone(),
                            to: other_path.to_string(),
                        });
                    }
                }
            }
        }
    }

    let mut nodes: Vec<String> = node_set.into_iter().collect();
    nodes.sort();

    DependencyGraph { nodes, edges }
}

/// Collect all functions from parsed files.
pub fn collect_functions(all_files: &[FileIR]) -> Vec<Function> {
    all_files
        .iter()
        .flat_map(|f| f.functions.clone())
        .collect()
}
