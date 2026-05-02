---
name: repo-wiki
description: >
  Incremental, merge-safe repository documentation system. Generates and
  updates wiki pages under .local-review/wiki/ using SHA256 hash-based change
  detection. Preserves manual notes, avoids full overwrites, and deprecates
  removed entities. Triggers on "repo wiki", "wiki update", "document repo",
  "generate docs", "update wiki", "repo-wiki".
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# repo-wiki

Incremental documentation system for repository analysis pipelines. All output
goes to `.local-review/wiki/`. Every run compares new analysis against existing
docs and updates only what changed.

## Indexer Setup (run once)

The skill relies on `repo-indexer` — a Rust binary bundled at
`${CLAUDE_PLUGIN_ROOT}/indexer/`. Before the first `update`, ensure it is built:

```bash
BINARY="${CLAUDE_PLUGIN_ROOT}/indexer/target/release/repo-indexer"
if [ ! -f "$BINARY" ]; then
  mkdir -p "$(dirname "$BINARY")"
  # Try downloading pre-built binary from the release
  PLUGIN_VERSION=$(python3 -c "
import json, pathlib
mp = pathlib.Path('${CLAUDE_PLUGIN_ROOT}/../../.claude-plugin/marketplace.json')
plugins = json.loads(mp.read_text()).get('plugins', [])
ver = next((p['version'] for p in plugins if p['name'] == 'repo-wiki'), None)
print(ver or '')
" 2>/dev/null)
  ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
  ASSET_URL="https://codeberg.org/maxagahi/ccpm/releases/download/repo-wiki%2Fv${PLUGIN_VERSION}/repo-wiki-indexer-linux-${ARCH}"
  if [ -n "$PLUGIN_VERSION" ] && curl -fsSL -o "$BINARY" "$ASSET_URL" 2>/dev/null; then
    chmod +x "$BINARY"
    echo "Downloaded repo-indexer v${PLUGIN_VERSION}"
  else
    echo "Building repo-indexer from source (requires cargo + gcc)..."
    cargo build --release --manifest-path "${CLAUDE_PLUGIN_ROOT}/indexer/Cargo.toml"
  fi
fi
```

**Pre-built binaries** are attached to each `repo-wiki` release on Codeberg for
`linux/amd64` and `linux/arm64`. Source build fallback requires `cargo` + `gcc`
(~1 min first run).

---

## Arguments

`$ARGUMENTS` — optional subcommand: `update`, `init`, `status`, `deprecate`.
If omitted, infer from context. Most invocations will be `update`.

---

## Output Structure

```
.local-review/wiki/
  overview.md
  architecture.md
  data-models.md
  diagrams.md
  modules/
    <module-id>.md
  functions/
    <function-id>.md
  apis/
    <api-id>.md
```

---

## File Format (required for every wiki file)

```markdown
---
generated_by: repo_wiki
source_file: <relative path from repo root>
entity_id: <fn:module.name | mod:module | api:endpoint>
hash: <SHA256 hex>
last_generated: <YYYY-MM-DD>
---

## AUTO-GENERATED

<content — replaced on update>

---

## MANUAL NOTES

<user content — NEVER touch>
```

The `## MANUAL NOTES` section is always created empty on first write and never
modified thereafter.

---

## Hashing Strategy

Use SHA256. Hashes must be deterministic across runs.

- **Function**: `SHA256(signature + body)` — strip leading/trailing whitespace
  from each before concatenating
- **Module / file**: `SHA256(full file content)`
- **Index files** (overview.md, architecture.md, etc.): `SHA256(serialised IR
section that drives that file)`

Compute hashes with Python (available everywhere):

```bash
python3 -c "
import hashlib, sys
content = sys.stdin.read()
print(hashlib.sha256(content.encode()).hexdigest())
"
```

Or read from the IR JSON fields `functions.json` / `modules.json` when the
Rust indexer has already pre-computed them (field: `hash`).

---

## Change Detection

For each entity in the new IR:

1. Derive the target file path (see Merge Logic below).
2. If the file exists, read its YAML frontmatter and extract `hash`.
3. Compare stored hash with new hash:

| State     | Action                                   |
| --------- | ---------------------------------------- |
| Unchanged | Skip — do not touch the file             |
| Modified  | Replace `## AUTO-GENERATED` section only |
| New       | Create file with both sections           |
| Deleted   | Mark deprecated (preferred) or remove    |

**Never rewrite a file whose hash has not changed.**

---

## Merge Logic

### Per-entity files (functions, modules, APIs)

```
path = .local-review/wiki/<type>/<entity-id>.md
```

Entity ID conventions:

- Functions: `fn:<module>.<name>` → filename `fn-<module>-<name>.md`
- Modules: `mod:<name>` → filename `mod-<name>.md`
- APIs: `api:<method>-<path-slug>` → filename `api-<method>-<path-slug>.md`

Algorithm:

```
for each entity in IR:
    file = derive_path(entity)
    if file exists:
        stored_hash = read_frontmatter(file)["hash"]
        if stored_hash == entity.hash:
            continue  # unchanged
        else:
            replace_auto_generated_section(file, new_content)
            update_frontmatter(file, hash=entity.hash, last_generated=today)
    else:
        create_new_file(file, entity)
```

### Index files (overview.md, architecture.md, diagrams.md, data-models.md)

Same hash-compare + section-replace logic. These are driven by the full
synthesis output, not individual entities.

---

## Update Rules

### Replacing `## AUTO-GENERATED`

The section starts at the `## AUTO-GENERATED` heading and ends at the next
`---` separator (or `## MANUAL NOTES` heading). Replace only that range.

```python
# Pseudocode
parts = file_content.split("## AUTO-GENERATED", 1)
header = parts[0]  # frontmatter + blank line
rest = parts[1]

# Find end of auto-generated section
if "## MANUAL NOTES" in rest:
    _, manual = rest.split("## MANUAL NOTES", 1)
else:
    manual = ""

new_file = (
    updated_frontmatter
    + "\n## AUTO-GENERATED\n\n"
    + new_auto_content
    + "\n\n---\n\n## MANUAL NOTES"
    + manual
)
```

### Creating a new file

```markdown
---
generated_by: repo_wiki
source_file: <path>
entity_id: <id>
hash: <hash>
last_generated: <YYYY-MM-DD>
---

## AUTO-GENERATED

<content>

---

## MANUAL NOTES

<!-- Add your notes here. This section is never overwritten. -->
```

---

## Deletion Handling

When an entity present in the previous wiki is absent from the new IR:

**Option A — Deprecate (preferred):** Prepend a `## STATUS` section:

```markdown
## STATUS

DEPRECATED – no longer present in codebase (detected: <YYYY-MM-DD>)
```

Leave `## MANUAL NOTES` intact.

**Option B — Remove:** Delete the file entirely.

Default is Option A. Use Option B only when the user explicitly passes
`--remove-deleted` or subcommand `deprecate --remove`.

---

## Subcommands

### `update` (default)

Run the full merge pipeline:

1. Read existing wiki files from `.local-review/wiki/` — collect `entity_id →
hash` pairs from YAML frontmatter.
2. Load new IR from `functions.json`, `modules.json` (and any API/model files).
3. For each IR entity, run change detection and apply update rules above.
4. For each wiki file whose entity_id is absent from IR, apply deletion
   handling.
5. Regenerate index files (overview, architecture, etc.) using the same
   hash-compare logic.
6. Report a summary: `N unchanged, N updated, N created, N deprecated`.

### `init`

Scaffold the output directory tree without generating any content:

```bash
mkdir -p .local-review/wiki/{modules,functions,apis}
touch .local-review/wiki/{overview,architecture,data-models,diagrams}.md
```

Each index file gets the standard header + empty sections.

### `status`

Dry-run of `update`: report what would change without writing any files.

Output format:

```
UNCHANGED:  12 entities
MODIFIED:    3 entities  (fn:user.get_user, mod:auth, api:GET-/users)
NEW:         1 entity    (fn:payment.charge)
DEPRECATED:  0 entities
```

### `deprecate --remove`

Re-run deletion detection with Option B (delete files) instead of Option A.
Requires explicit user confirmation before deleting.

### `export-yadgar`

Export all wiki pages and IR files from `.local-review/` to Yadgar's file
queue. Works whether the Yadgar service is running or not — the queue drainer
processes entries when the service is next available.

Also runs automatically at the end of `update` when Yadgar is detected.

---

## Pipeline Orchestration

Full recommended pipeline order:

```
1. indexer        → functions.json, modules.json (with SHA256 hashes)
2. analysis       → enriched IR with call graphs, types, side effects
3. synthesis      → prose descriptions per entity
4. merge          → this skill (repo-wiki update)
5. diagrams       → update diagrams.md
6. yadgar export  → queue wiki + IR entries to Yadgar (if installed)
```

### Running the indexer (step 1)

```bash
BINARY="${CLAUDE_PLUGIN_ROOT}/indexer/target/release/repo-indexer"
"$BINARY" /path/to/target/repo
# IR files written to /path/to/target/repo/.local-review/ir/
```

The IR files (`functions.json`, `modules.json`, etc.) are then read by the
merge phase to drive wiki generation.

The skill can be run at step 4 regardless of whether earlier stages used the
Rust indexer or a Python/other tool — as long as the IR includes `hash` fields.

---

## Yadgar Integration

When Yadgar is installed on the system (detected by `~/.yadgar/` or
`$YADGAR_DATA_DIR` existing), export wiki and IR output to Yadgar's durable
file queue. The queue drainer picks up entries the next time the service runs —
no live connection required.

### Detection

```bash
YADGAR_DATA="${YADGAR_DATA_DIR:-$HOME/.yadgar}"
if [ -d "$YADGAR_DATA" ]; then
  echo "Yadgar detected at $YADGAR_DATA — will export"
fi
```

### Export Script

Run after `update` completes (or standalone via `export-yadgar`):

````bash
python3 << 'YADGAR_EXPORT'
import json, os, sys, time, uuid
from pathlib import Path

yadgar_base = Path(os.environ.get("YADGAR_DATA_DIR", Path.home() / ".yadgar"))
if not yadgar_base.exists():
    print("Yadgar not detected — skipping export")
    sys.exit(0)

queue_dir = yadgar_base / "queue"
queue_dir.mkdir(parents=True, exist_ok=True)

wiki_dir = Path(".local-review/wiki")
ir_dir   = Path(".local-review/ir")
count    = 0

def enqueue(op: str, payload: dict) -> None:
    global count
    record_id = str(uuid.uuid4())
    data  = {"op": op, "id": record_id, "payload": payload, "ts": time.time()}
    fname = f"{int(time.time() * 1000):016d}_{record_id}.json"
    tmp   = queue_dir / (fname + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False))
    tmp.rename(queue_dir / fname)  # atomic on POSIX
    count += 1

def parse_frontmatter(text: str) -> dict:
    if not text.startswith("---"):
        return {}
    try:
        end = text.index("---", 3)
    except ValueError:
        return {}
    fm = {}
    for line in text[3:end].strip().splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            fm[k.strip()] = v.strip()
    return fm

# --- wiki pages ---
# Title = entity_id from frontmatter (e.g. "fn:seed.py::seed_project").
# Tags  = [entity_id_prefix, subdir] where subdir is "modules", "functions", etc.
if wiki_dir.exists():
    for md_file in sorted(wiki_dir.rglob("*.md")):
        content   = md_file.read_text()
        fm        = parse_frontmatter(content)
        entity_id = fm.get("entity_id", md_file.stem)
        subdir    = md_file.parent.name
        prefix    = entity_id.split(":")[0] if ":" in entity_id else "wiki"
        tags      = [prefix] + ([subdir] if subdir not in ("wiki", ".") else [])
        enqueue("wiki_add", {
            "title":      entity_id,
            "content":    content,
            "category":   "reference",
            "tags":       tags,
            "confidence": "high",
            "append":     False,
        })

# --- IR files ---
# Files under 65 000 bytes are embedded as fenced JSON blocks.
# Larger files get a summary page (keys, size, line count).
_MAX_BYTES = 65_000
if ir_dir.exists():
    for ir_file in sorted(ir_dir.glob("*.json")):
        raw   = ir_file.read_text()
        title = f"ir: {ir_file.stem}"
        if len(raw.encode()) <= _MAX_BYTES:
            content = f"# {title}\n\n```json\n{raw}\n```\n"
        else:
            try:
                data     = json.loads(raw)
                top_keys = list(data.keys())[:20] if isinstance(data, dict) else []
            except json.JSONDecodeError:
                top_keys = []
            content = (
                f"# {title}\n\n"
                f"**File**: `{ir_file}`  \n"
                f"**Size**: {len(raw):,} bytes / {raw.count(chr(10)):,} lines  \n"
                f"**Top-level keys**: {top_keys}\n\n"
                f"> File too large to embed in full ({len(raw):,} bytes).\n"
                f"> Access the raw file at `.local-review/ir/{ir_file.name}`.\n"
            )
        enqueue("wiki_add", {
            "title":      title,
            "content":    content,
            "category":   "reference",
            "tags":       ["ir", ir_file.stem],
            "confidence": "high",
            "append":     False,
        })

print(f"Queued {count} entries → {queue_dir}")
YADGAR_EXPORT
````

### Title Derivation

| Source    | Title used              | Example                    |
| --------- | ----------------------- | -------------------------- |
| Wiki file | `entity_id` frontmatter | `fn:seed.py::seed_project` |
| IR file   | `ir: <stem>`            | `ir: functions`            |

If a wiki file has no frontmatter, `entity_id` falls back to the filename stem.

---

## Merge Phase Prompt (for sub-agent use)

When delegating the merge step to a sub-agent, use this prompt:

```
You are a documentation merge engine.

Input:
- existing wiki files from .local-review/wiki/
- new generated documentation (provided below)
- IR hashes (provided below)

Task:
- detect changes using hash comparison
- update only modified AUTO-GENERATED sections
- preserve all MANUAL NOTES sections verbatim
- avoid unnecessary rewrites

Rules:
- NEVER overwrite entire files
- ONLY replace AUTO-GENERATED sections
- KEEP MANUAL NOTES intact
- USE hash comparison — skip unchanged entities
- Mark missing entities as DEPRECATED; do not delete unless instructed
```

---

## Safety Guarantees

- No full overwrites — always section-replace
- No loss of manual content — `## MANUAL NOTES` is append-only
- Deterministic file paths — entity IDs map 1:1 to filenames
- Stable entity IDs — derived from module + name, not line numbers
- Minimal file churn — unchanged hashes produce zero writes

---

## Example: Updated Function File

```markdown
---
generated_by: repo_wiki
source_file: src/user.py
entity_id: fn:user.get_user
hash: abc123def456
last_generated: 2026-04-27
---

## AUTO-GENERATED

### Function: get_user

- **Inputs:** `user_id: int`
- **Outputs:** `User` object
- **Side effects:** DB read query

### Calls

- `db.fetch_user`

---

## MANUAL NOTES

- This function is performance critical
- Consider adding a caching layer
```

---

## Notes

- Run `init` once per repo before the first `update`.
- The IR files (`functions.json`, `modules.json`) must include a `hash` field
  per entity; if the indexer does not produce them, compute hashes on the fly
  from `signature + body` content.
- All paths in frontmatter (`source_file`) are relative to the repo root.
- The `.local-review/` directory should be in `.gitignore` unless the team
  wants to version the generated docs.
