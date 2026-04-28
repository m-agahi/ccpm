use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Function {
    pub id: String,
    pub name: String,
    pub file: String,
    pub language: String,
    pub line: usize,
    pub signature: String,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub calls: Vec<String>,
    pub side_effects: Vec<String>,
    pub is_async: bool,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Module {
    pub path: String,
    pub language: String,
    pub imports: Vec<String>,
    pub exports: Vec<String>,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiEndpoint {
    pub route: String,
    pub method: String,
    pub handler: String,
    pub language: String,
    pub file: String,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallGraphEdge {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallGraph {
    pub edges: Vec<CallGraphEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DependencyGraph {
    pub nodes: Vec<String>,
    pub edges: Vec<DependencyEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DependencyEdge {
    pub from: String,
    pub to: String,
}

/// Intermediate result from parsing a single file.
#[derive(Debug, Clone)]
pub struct FileIR {
    pub functions: Vec<Function>,
    pub module: Module,
    pub apis: Vec<ApiEndpoint>,
}
