# Changelog

## [1.1.3] - 2026-10-31

### Changed

- Pre-built `repo-indexer` binaries now download from GitHub releases (`https://github.com/m-agahi/ccpm/releases/download/repo-wiki%2Fv<version>/...`). Codeberg is no longer the release host.
- `repository` URL now points to https://github.com/m-agahi/ccpm.

## [1.1.2] - 2026-05-19

### Fixed

- Updated tree-sitter parser source files to use v0.25 static API (`LANGUAGE.into()` instead of `language()`)

### Changed

- Republished v1.1.2 release on Codeberg to attach prebuilt indexer binaries (`linux/amd64` and `linux/arm64`). The original v1.1.1 release tag exists but has empty assets due to a CI build failure (now fixed in CI workflow alongside this republish).

## [1.1.1] - 2026-05-16

### Changed

- Bumped tree-sitter dependency constraints: `tree-sitter` `0.22` → `0.25`; grammar crates updated to their actual latest versions (each crate has independent versioning: rust→0.24, python/js/go→0.25, java/typescript→0.23, php→0.24)

## [1.1.0] - 2026-05-02

### Added

- `export-yadgar` subcommand — exports all `.local-review/wiki/` pages and `.local-review/ir/` files to Yadgar's durable file queue; works whether the Yadgar service is running or not (queue drainer picks up entries on next start)
- Yadgar auto-export runs automatically at the end of `update` when Yadgar is detected (`~/.yadgar/` or `$YADGAR_DATA_DIR` exists)
- IR files under 65 KB are embedded as fenced JSON blocks; larger files (callgraph, functions) get a summary page with key count, size, and top-level keys
- Title derivation documented: wiki pages use `entity_id` from frontmatter; IR files use `ir: <stem>`

## [1.0.3] - 2026-04-29

### Changed

- Minor internal update

## [1.0.2] - 2026-04-28

### Changed

- Minor internal update

## [1.0.1] - 2026-04-28

### Changed

- Minor internal update

## [1.0.0] - 2026-04-27

### Added

- Initial release
- `indexer/` — Rust CLI (`repo-indexer`) for multi-language AST parsing (Python, Rust, JS, TS, Go, Java, PHP) using tree-sitter; outputs `functions.json`, `modules.json`, `callgraph.json`, `dependencies.graph.json`, `apis.json` to `.local-review/ir/`; parallel file processing via rayon; SHA256 hashing per entity
- `update` subcommand — full merge pipeline with SHA256 hash-based change detection
- `init` subcommand — scaffold `.local-review/wiki/` directory tree
- `status` subcommand — dry-run showing what would change without writing files
- `deprecate --remove` subcommand — delete deprecated wiki files with confirmation
- Section-level merge: replaces only `## AUTO-GENERATED` content, never touches `## MANUAL NOTES`
- Deterministic entity ID scheme: `fn:<module>.<name>`, `mod:<name>`, `api:<method>-<path-slug>`
- YAML frontmatter on every wiki file with `hash`, `source_file`, `entity_id`, `last_generated`
- Deletion handling: deprecated entities marked with `## STATUS` block (Option A default)
- Index file support: `overview.md`, `architecture.md`, `data-models.md`, `diagrams.md`
- Merge phase prompt for sub-agent delegation
- Safety guarantees: no full overwrites, no manual content loss, minimal file churn
