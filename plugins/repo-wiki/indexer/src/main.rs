mod ir;
mod parser;
mod utils;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rayon::prelude::*;
use walkdir::WalkDir;

use crate::ir::graph;
use crate::ir::models::{ApiEndpoint, CallGraph, DependencyGraph, FileIR, Module};
use crate::utils::file::{detect_language, is_ignored_dir};

fn main() {
    env_logger::init();

    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: repo-indexer <path>");
        std::process::exit(1);
    }

    let root_path = PathBuf::from(&args[1]);
    if !root_path.is_dir() {
        eprintln!("Error: '{}' is not a directory", root_path.display());
        std::process::exit(1);
    }

    log::info!("Scanning directory: {}", root_path.display());

    // Collect all candidate files first
    let files: Vec<PathBuf> = WalkDir::new(&root_path)
        .into_iter()
        .filter_entry(|entry| {
            if entry.file_type().is_dir() {
                let name = entry.file_name().to_str().unwrap_or("");
                !is_ignored_dir(name)
            } else {
                true
            }
        })
        .filter_map(|entry| {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    log::warn!("Error walking directory: {}", e);
                    return None;
                }
            };
            if entry.file_type().is_file() {
                let path = entry.path().to_path_buf();
                if detect_language(&path).is_some() {
                    return Some(path);
                }
            }
            None
        })
        .collect();

    log::info!("Found {} source files to process", files.len());

    // Parse files in parallel using rayon
    let results: Mutex<Vec<FileIR>> = Mutex::new(Vec::new());

    files.par_iter().for_each(|file_path| {
        match process_file(file_path, &root_path) {
            Some(file_ir) => {
                // Lock is held only briefly for the push
                if let Ok(mut vec) = results.lock() {
                    vec.push(file_ir);
                }
            }
            None => {
                log::debug!("Skipped file: {}", file_path.display());
            }
        }
    });

    let all_files = results.into_inner().unwrap_or_default();

    log::info!("Successfully parsed {} files", all_files.len());

    // Build output structures
    let functions = graph::collect_functions(&all_files);
    let modules: Vec<Module> = all_files.iter().map(|f| f.module.clone()).collect();
    let call_graph = graph::build_call_graph(&all_files);
    let dep_graph = graph::build_dependency_graph(&all_files);
    let apis: Vec<ApiEndpoint> = all_files.iter().flat_map(|f| f.apis.clone()).collect();

    // Write output
    let output_dir = root_path.join(".local-review").join("ir");
    if let Err(e) = write_output(&output_dir, &functions, &modules, &call_graph, &dep_graph, &apis) {
        eprintln!("Error writing output: {}", e);
        std::process::exit(1);
    }

    log::info!("Output written to {}", output_dir.display());
    println!(
        "Indexed {} files, {} functions, {} API endpoints",
        modules.len(),
        functions.len(),
        apis.len()
    );
}

fn process_file(file_path: &Path, root_path: &Path) -> Option<FileIR> {
    let language = detect_language(file_path)?;

    let source = match fs::read_to_string(file_path) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("Failed to read file {}: {}", file_path.display(), e);
            return None;
        }
    };

    let relative_path = file_path
        .strip_prefix(root_path)
        .unwrap_or(file_path)
        .to_str()
        .unwrap_or("")
        .replace('\\', "/"); // Normalize path separators

    parser::parse_file(&source, &relative_path, language)
}

fn write_output(
    output_dir: &Path,
    functions: &[ir::models::Function],
    modules: &[Module],
    call_graph: &CallGraph,
    dep_graph: &DependencyGraph,
    apis: &[ApiEndpoint],
) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(output_dir)?;

    let functions_json = serde_json::to_string_pretty(functions)?;
    fs::write(output_dir.join("functions.json"), functions_json)?;

    let modules_json = serde_json::to_string_pretty(modules)?;
    fs::write(output_dir.join("modules.json"), modules_json)?;

    let callgraph_json = serde_json::to_string_pretty(call_graph)?;
    fs::write(output_dir.join("callgraph.json"), callgraph_json)?;

    let depgraph_json = serde_json::to_string_pretty(dep_graph)?;
    fs::write(output_dir.join("dependencies.graph.json"), depgraph_json)?;

    let apis_json = serde_json::to_string_pretty(apis)?;
    fs::write(output_dir.join("apis.json"), apis_json)?;

    Ok(())
}
