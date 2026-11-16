# fleet: infra:callers on-disk handoff for large caller relays (L2178, yaadgaar #44)

Status: draft (plan round 2, the third planner round, after the plan-audit verdicts plan_defect of rounds 0 and 1; RCA-corrected). Fleet 7.1.1 -> 7.2.0.
Component: fleet.

## Request

yaadgaar #44 (L2178): the `infra:callers` relay mis-copies the occurrence list, even on the
digest retry; run wf_0e5677ad-a03 failed on it. It was seen again in wf_6b013dff-eb5 (L2190,
fleet 7.0.0), where the digest retry recovered. The brief asks: change large relays to hand off
through an on-disk file instead of copying the text through the model relay. Related: L2028
(relays that grow), L2142 (digest retry, fixed in 7.1.1).

ADR-1195 (open) already states the rule this plan applies to the caller check: "No field that a
relay agent must copy may grow with the repo's file count. Programs keep full maps in run scratch
outside the worktree and relay digests, counts and capped samples". The hasher follows it since
5.0.5; `callers.py` does not.

## Premise check (HEAD f36f3b3)

The defect still holds on HEAD: nothing in the caller relay changed since 6.3.0.

- `scripts/callers.py:93-101` prints the whole result inline (`occurrences`, `capped`,
  `auto_dont_care`, `doctest_md`, `program`, `digest`). The only size bound is the 65536-byte
  relay cap (`callers.py:98`), past which the workflow halves the batch
  (`src/build-task-run.js:4446-4452`).
- `callersPrompt` (`src:2819-2829`) asks one agent to copy every list entry exactly. The tier is
  haiku (`["infra:callers", "haiku"]` in `INFRA_TIER`).
- `callerGrep` (`src:4436-4475`) halts `failed` when the relay misses the program digest
  (`src:4461-4462`) after the one digest retry of `dispatch`/`digestRetry` (`src:3485-3495`).

Primary evidence: run wf_c04c41b0-5ee (this task's own plan run, fleet 7.1.1; journal and agent
records checked). The callers program printed 25,915 bytes for 15 symbols, 381 hits, 102 of them
doc or lock hits left to auto (digest `bb39d4e3...`), well under the 65536 cap. Round
`infra:callers:audit-fix` relayed this identical output (same digest) on haiku and passed. Round
`infra:callers:audit-fix-2` relayed the same bytes on haiku and missed the digest by key-boundary
bleed (RCA); its digest retry `infra:callers:audit-fix-2:digest-retry`, also on haiku, failed the
same way, and the run stopped `failed`. Round 0 (`infra:callers`: 25,788 bytes, 14 symbols, digest
`547fa0f4...`) relayed fine. So the copy fails at random on the same input: the 65536-byte cap
does not bound it, and a retry on the same model does not fix it. Only not copying the list does.

Earlier evidence, unverified (figures from the task body; the run record was not re-checked):
wf_0e5677ad-a03 (fleet 6.3.2): 11 symbols in one batch, 60 doc or lock hits, largest symbol 56
hits. The program printed about 16 KB; each relay was about 34 KB of JSON. All relays ran on
haiku; rounds `infra:callers:audit-fix` and `infra:callers:audit-fix-2` each missed the digest,
the second retry missed again, and the run stopped.

File:line references in the sources: the task body has none to re-map. The round-0 findings cite
lines at f36f3b3; they are current (re-checked).

## Design

The hasher pattern (content-addressed file in the run scratch, relay only a summary) plus
batch-wide 50-entry read pages for the lists the script must see, with a read budget and a
per-file memo so the agent count stays bounded.

### callers.py: three modes

1. **Inline** (unchanged arguments `<worktree> <plan_path> <symbols json> <cap>`): unchanged
   output when the printed JSON is at most `INLINE_CAP = 8192` bytes. Over it, print nothing and
   exit non-zero with
   `FLEET_CALLERS_ON_DISK: the callers output is over the 8192-byte inline cap (<n> bytes; symbols: <s1, s2, ...>)`
   (symbols joined with `', '`, cut at 300 characters as the existing marker does). The check runs
   before the existing `RELAY_CAP` `if` (`callers.py:99`), so an inline output over 65536 bytes also
   gets this marker; the `RELAY_CAP` branch is unreachable in inline mode and stays byte-identical.
2. **File mode**: `callers.py file <worktree> <plan_path> <symbols json> <cap> <scratch_dir>`.
   Same grep and auto rules as inline (it runs lines 39-96 unchanged). It writes `text` (the exact
   inline JSON, UTF-8, no trailing newline) to
   `<scratch_dir>/callers/callers-<sha256 of those bytes>.json`: create `<scratch_dir>/callers`
   if missing, write a temp file in that dir, then `os.replace` onto the final name (the same
   content gives the same name and bytes, so a concurrent or repeated run is harmless). It prints
   only the summary
   `{symbols: {<s>: {count, sha256, auto_count, path_count, paths_sha256}}, capped, doctest_md, file, args, program, digest}`:
   - `sha256` = sha256 of `json.dumps(sorted(hits), separators=(',', ':'), ensure_ascii=False)`
     in UTF-8; `auto_count` = the number of auto doc or lock hits; `path_count` and
     `paths_sha256` = the number and the same hash of the sorted unique paths of the hits (a
     hit's path is the text before its last `:`). A capped symbol: `count` 0, `sha256` and
     `paths_sha256` of `[]` (`4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`),
     `auto_count` 0, `path_count` 0.
   - Why a path hash (round-1 finding on AC9): the update-merge check R5 reads only paths
     (`at()` cuts the line, `src:6812-6816`). The sealed map is from plan time, and the coder's
     commits shift lines, so a line-level hash at the update merge differs on nearly every real
     build. The path hash lets R5 compare path sets: a line shift needs no read.
   - `args` = the five arguments after the mode word, as given. `digest` covers
     `symbols, capped, doctest_md, file, args` plus `program`, as every program's digest does.
   - Summary cap: a printed summary over `INLINE_CAP` (8192) bytes exits non-zero with
     `FLEET_CALLERS_RELAY_CAP: the callers summary is over the 8192-byte inline cap (<n> bytes; symbols: ...)`.
     The workflow then halves the batch (the existing halving rule). The summary holds two 64-hex
     hashes per symbol (line level and path level); about 205 bytes per symbol plus the name
     twice (the entry key and the echoed symbol list), plus about 400 bytes of `file`, `program`
     and `digest`. So 30 names of 15 characters are about 7.4 KB and fit; 30 names of 20
     characters or more split once (2 more file dispatches).
   - A write failure (mkdir, write or rename) exits non-zero, stdout empty, stderr starting
     `FLEET_CALLERS_FILE: cannot write the callers file`. Another argument count exits with stderr
     starting `FLEET_CALLERS_FILE: `.
3. **Read mode**: `callers.py read <file> <part> <symbols json> <page>`, `part` = `all`,
   `auto` or `paths`. One read pages over ALL listed symbols at once:
   - `L` = for each listed symbol in code-point order, its sorted entries (`all`: the
     occurrences; `auto`: its auto doc or lock hits; `paths`: the sorted unique paths of its
     occurrences), as (symbol, entry) pairs. `page.count = max(1, ceil(len(L) / 50))`
     (`PAGE = 50`). Page `k` = `L[50k : 50k+50]`.
   - Prints `{part, page: {index, count}, hits: {<s>: [...]}, auto: {<s>: [...]}, args, program, digest}`:
     `hits[s]` = the page's entries of `s` in order; `auto[s]` = for `all`, the indices into
     `hits[s]` of its auto hits, for `auto`, every index of `hits[s]`, for `paths`, no key (the
     `auto` map is `{}`). A symbol with no entry on the page has no key in either map. `args` = the four arguments after the mode word.
   - Refusals (non-zero exit, empty stdout, stderr starting `FLEET_CALLERS_READ: `): another
     argument count; a basename other than `callers-<64 lowercase hex>.json`; a path that is not a
     regular file (a symlink or a directory); bytes that do not hash to the name; a file that is
     not a callers object; a part other than `all`/`auto`/`paths`; symbols that are not a non-empty JSON
     list of distinct strings; a symbol that is not a key of the file's `occurrences`; a page
     that is not `0` or `[1-9][0-9]*`, or is not below `page.count`.
   - A printed page over 65536 bytes (only with very long paths) exits with
     `FLEET_CALLERS_RELAY_CAP: the callers output is over the 65536-byte relay cap (<n> bytes; symbols: <symbols on that page>)`.
     Read mode runs before line 39, where `RELAY_CAP` (`:98`) is not yet defined, so it uses a new
     constant `READ_CAP = 65536` of the same value; `RELAY_CAP`'s line stays unchanged.

**Build-time definition check (changed_defs.py) — hard rules for the coder.** `changed_defs.py`
classes every top-level `name = ...` line as a definition (`TOP_ASSIGN`, `changed_defs.py:58`),
and it attributes an added INDENTED line to the nearest base definition above it with a smaller
indent (`enclosing`, `changed_defs.py:228`). The top-level names `G, occ, capped, cfg,
all_docs, included, doctest, auto, out, text, RELAY_CAP` (`callers.py:40-98`) are not in
`changed_symbols` and are too common to map. So:

- `callers.py` lines 1-101 stay byte-identical: no base line is edited, moved or deleted.
- Every added line is either inside a NEW column-0 `def` (its body is an addition) or a
  column-0 single-line statement (a new name's assignment, a call, or `if <cond>: <call>` on one
  line). No added indented line outside a new function. No added assignment to a name that
  already has a top-level definition in the file, and no new function named like an existing
  one (`clean_path`, `base`, `doc_or_lock`, `grep`).
- Placement: the new constants, the new functions, the read-mode dispatch (which exits) and the
  file-mode argument handling (record `<scratch_dir>`, then delete the mode word from
  `sys.argv` so that line 39 reads `<worktree> <plan_path> <symbols json> <cap>`) go between
  line 38 and line 39. The file-mode exit and the `INLINE_CAP` check go between line 96 and
  line 99, as column-0 lines; the file-mode exit comes first, so a file-mode run never reaches
  either cap check of the inline mode.
- Those column-0 lines are module-level changes with no enclosing definition, so
  `plugins/fleet/scripts/callers.py` is in `allowed_additions.files`.

### Workflow (src/build-task-run.js)

New constants `CALLERS_DISK_MARK = "FLEET_CALLERS_ON_DISK:"`, `CALLER_PAGE = 50`,
`CALLER_READ_BUDGET = 4`; new prompts `callersFilePrompt` and `callersReadPrompt` (run
`progCmd("callers", ["file", ...])` / `["read", ...]`, digest ids `callers:file` /
`callers:read`, `opts.args` = the arguments after the mode word). A script-memory memo
`callerReads`: content-addressed file path -> `{all: {<s>: hits}, auto: {<s>: hits}}`, kept for
the life of the run (never persisted).

`callerGrep(label, names, worktree, planPath, phaseName, expected, level)` gains `expected` and
`level` (`"line"`, the default, or `"path"`). At line level `expected` is `{symbol: [path:line, ...]}`;
at path level it is `{symbol: [path, ...]}`; a missing symbol counts as `[]`. Queue entries become
`{part, disk}`. Per entry, `lb` = label plus `:b<n>` as today:

1. `disk` false: dispatch `<lb>` inline as today. A relay `failed` whose reason holds
   `FLEET_CALLERS_ON_DISK:` writes the gate line
   `<lb>: the caller output is over the 8192-byte inline cap; on-disk handoff (<n> symbols)` and
   takes the disk path for this entry with the same `lb`. The `FLEET_CALLERS_RELAY_CAP` halving
   branch for the inline relay stays as it is.
2. Disk path: dispatch `<lb>:file`, args `[worktree, planPath, JSON.stringify(part), "100", scratchOf(worktree)]`.
   - `failed` with `FLEET_CALLERS_RELAY_CAP:` (summary over 8192): one symbol -> halt
     `needs_human`, stop gate `callers`,
     `<lb>:file: the caller summary of <s> is over the 8192-byte inline cap; the caller check cannot relay it`;
     else gate line `<lb>:file: <n> symbols are over the summary cap; split in two` and both
     halves go to the front of the queue as `{disk: true}` (no inline dispatch for them).
   - Any other `failed`: halt `failed`, `<lb>:file returned failed: <reason>`.
   - Checks (each miss halts `failed`, reason starting `<lb>:file: `): `requireProgram`; digest
     over `PROGRAM_KEYS["callers:file"]`; `file` equals
     `scratchOf(worktree) + "/callers/callers-" + <64 lowercase hex> + ".json"`
     (`the callers file <file> is not ...`); for every batch symbol an entry with integer
     `count >= 0`, 64-hex `sha256`, integer `0 <= auto_count <= count`, integer
     `0 <= path_count <= count`, 64-hex `paths_sha256`
     (`the summary has no valid entry for <s>`); `capped` and `doctest_md` string lists. No
     upper bound on `count` is checked (the program caps a symbol at 100 hits, and every example
     stays at or below 100 per symbol).
3. Line level (plan rounds), per batch symbol `s` (not capped): `E` = `expected[s]`, normalised
   (`occurrenceKey`), unique, sorted by code point; `e` = sha256 of `canonical(E)`.
   - `e == sha256`: occurrences = `E`; `auto_dont_care[s] = []` (every hit is planner-mapped,
     so the sealed map adds nothing); no read.
   - else, `auto_count > 0`: into the AUTO set. Else: into the ALL set.
   - capped: occurrences `[]`, listed in `capped`, as inline.
4. Reads (batch-wide). For each part, the symbols of its set whose list the memo lacks for this
   file are read together; their pages = `max(1, ceil(Σ n / 50))` (`n` = `auto_count` for auto,
   `count` for all). Labels `<lb>:read:auto:<k>` and `<lb>:read:all:<k>`, args
   `[file, part, JSON.stringify(symbols in code-point order), "<k>"]`.
   - Budget: at most `CALLER_READ_BUDGET` (4) read dispatches per `callerGrep` call (digest or
     args retries and memo hits not counted). A part whose pages do not fit the remaining budget
     is not read: its symbols go to `unread` with their part.
   - Each page relay: `requireProgram`, digest over `PROGRAM_KEYS["callers:read"]`, args,
     `page.index == k`, `page.count` == the computed pages, `hits`/`auto` keys among the listed
     symbols (miss: halt `failed`, `<label>: the read page ...`). `failed` with
     `FLEET_CALLERS_RELAY_CAP:` -> halt `needs_human`, stop gate `callers`,
     `<label>: the occurrences of <symbols> are over the 65536-byte relay cap on one read page (relay size; long paths); the caller check cannot relay them`.
   - AUTO join: per symbol, the joined list must hold `auto_count` entries (else halt `failed`,
     `<lb>:read:auto: the read occurrences of <s> do not match the summary ...`). `U` = sorted
     unique `E ∪ auto list`; `len(U) == count` and `sha256(canonical(U)) == sha256` ->
     occurrences `U`, `auto_dont_care[s]` = the auto list. Else the symbol moves to the ALL set
     (the AUTO phase runs first).
   - ALL join: per symbol, `count` entries hashing to `sha256` (else halt `failed`,
     `<lb>:read:all: the read occurrences of <s> do not match the summary count or sha256`);
     occurrences = the hits, `auto_dont_care[s]` = the hits at the auto indices.
5. Path level (the update merge, `infra:callers:u1`), per batch symbol `s` (not capped): `P` =
   `expected[s]` (`normPath`), unique, sorted by code point; `p` = sha256 of `canonical(P)`.
   - `p == paths_sha256`: `paths[s] = P`; no read. A line shift with the same files lands here.
   - else: into the PATHS set. The AUTO and ALL parts never run at path level (the sealed map
     already holds the auto entries, and R5 needs only paths).
   - PATHS reads, batch-wide as in step 4: pages = `max(1, ceil(Σ path_count / 50))`, labels
     `<lb>:read:paths:<k>`, args `[file, "paths", JSON.stringify(symbols in code-point order), "<k>"]`,
     the same budget, memo and page checks. Join: per symbol, `path_count` entries hashing to
     `paths_sha256` (else halt `failed`,
     `<lb>:read:paths: the read occurrences of <s> do not match the summary count or sha256`);
     `paths[s]` = the joined list.
   - Capped: as today (listed in `capped`; R5 refuses).
6. Result: today's shape plus `unread: {<s>: {part, count, auto_count}}` and
   `paths: {<s>: [path, ...]}` (both `{}` on the inline path; `paths` is `{}` at line level).
   An unread symbol has no `occurrences` and no `paths` entry.

`callerCheck` passes its plan map as `expected`, and turns each `unread` symbol into one finding
(and skips it in the per-hit loops):

- part auto: `<s>: <auto_count> doc or lock hit(s) left to auto dont_care are over the caller read budget (4 reads of 50 entries); map them in changed_symbols (dont_care with a reason)`;
- part all: `<s>: the mapped occurrences differ from git grep -w (<count> hits, <n> mapped) and the hit list is over the caller read budget (4 reads of 50 entries); re-grep and map every hit`.

`updRefusal` R5 (`infra:callers:u1`) calls `callerGrep` at path level, with `expected` = per
symbol the sealed paths of `planFacts.changed_symbols` (`at()` of each occurrence, auto entries
included). It adds every path of `g.paths` to its `occ` list next to the sealed paths and the
inline `g.occurrences` paths, so the moved-file check is the same as today. A non-empty `unread`
refuses:
`the occurrences of <names> at the update merge differ from the sealed map and are over the caller read budget`.

Tables: `PROGRAM_KEYS` gains `"callers:file": ["symbols", "capped", "doctest_md", "file", "args"]`
and `"callers:read": ["part", "page", "hits", "auto", "args"]`. `PROGRAM_OUT.callers` (keyed by
program name, read by `programSchema` at `src:2047`) gains the union of the new keys, as
`parked` merges its modes (`src:1828-1838`): `symbols` (object of `{count: INT, sha256: STR,
auto_count: INT, path_count: INT, paths_sha256: STR}`), `file: STR`, `args: STRS`, `part: STR`, `page: {index: INT, count: INT}`,
`hits: STR_LISTS`, `auto` (object of integer lists). **No `PROGRAM_SLOTS` change**: `nestedMiss`
skips a null slot (`src:3480`), the callers slot is `[null, "callers"]` (`src:1705`), and
`programSlots` matches by the emitted program name, which stays `callers` for all three modes;
the existing `/^infra:callers/` entry serves the new labels. The top-level digest retry for the
new relays goes through `opts.digest` and `digestOnlyMiss` (`src:3466-3472`), which needs only
the `PROGRAM_KEYS` entries. The `INFRA_TIER` prefix `infra:callers` keeps haiku for the new
labels.

### Agent count (MAX_AGENTS 100 per run, `src:204`)

One `callerGrep` call of at most 30 symbols, no summary split:

- inline output at most 8192 bytes: 1 dispatch (unchanged).
- disk path: 1 inline + 1 file + at most 4 reads = at most 6 dispatches; with one digest or
  args retry on each, at most 12. A summary split adds 2 file dispatches per split.
- The memo is keyed by the content-addressed file, whose name hashes the whole inline output,
  the symbol list included. A later round reuses it only when its batch and every hit are
  unchanged: then 2 dispatches. Batches change whenever an audit finds a missed symbol. In
  wf_c04c41b0-5ee, round 0 (digest `547fa0f4...`, 14 symbols) and round 1 (`bb39d4e3...`,
  `SAMPLES` added) differed, so round 1 would read again; only round 2 (the same digest as
  round 1) would hit the memo.
- Plan mode worst case: rounds `infra:callers`, `:audit-fix`, `:audit-fix-2` = 18 (36 with
  every relay retried). Today: 3.
- Update merge (`infra:callers:u1`, path level): 1 inline + 1 file, plus 1 paths read per 50
  symbol-path pairs of the symbols whose path set differs from the sealed one. A paths read is
  the normal case for a task like this one: OB2, OB4 and the new tests name changed symbols
  (the CHANGELOG, the READMEs, the notes, 11 new `v720_*` test files), so they add paths.
  Budget check for this run: the sealed map holds 81 symbol-path pairs (22 unique files),
  2 pages; more than 19 added pairs makes 3. So u1 realistically costs 4-5 dispatches
  (2 + 2-3 reads), within the read budget of 4 (200 pairs); at most 6 (12 with retries). Only a
  build that adds no new path for any changed symbol (line shifts only) needs 2. Today: 1.
- This run's own map (wf_c04c41b0-5ee: 15 symbols, 102 doc or lock hits left to auto over 11
  symbols): round 0 = 1 inline + 1 file + 3 auto pages (`ceil(102 / 50)`) = 5, when the planner
  maps every other hit exactly. Round 1 (`SAMPLES` added: a new file, a memo miss) = 5 again;
  round 2 (the same file) = 2. About 12 for the three plan rounds, against 3 today. The 3 auto
  pages fit the budget of 4, so the worst case above stands. The incident wf_0e5677ad-a03
  (unverified: 11 symbols, 60 doc hits): round 0 = 1 + 1 + 2 = 4.
- Unbounded today-style reads are impossible: past the budget the run gets findings (plan) or a
  refusal (update merge), never more reads. Without the budget, 30 symbols x 100 hits would need
  60 pages per round and stop the run at `agent cap 100 reached`.

### Why not the alternatives

- Lower the cap and keep halving: still copies every hit through a model; no gain for symbols
  the planner mapped exactly. Rejected.
- Do the whole comparison in a program on disk (ADR-1195's strict form): the planner's map lives
  only in the workflow script, which has no filesystem; writing it to disk needs the chunk-writer
  machinery (the L2176/L2187 class). Rejected for this task; the hash comparison gives the same
  "no copy when it matches" result.
- One read per symbol (round 0): one agent per symbol with auto hits, 30 per batch per round,
  which stops a full run at the agent cap. Replaced by batch-wide pages plus the budget.
- Keep `code_sha256` in the summary (round 0): the AUTO join against `sha256` replaces it, and
  every page is digest-checked, so the relay fidelity does not depend on it. Dropped. The
  second hash per symbol is now `paths_sha256`, which the update merge needs (round-1 finding);
  the summary cap (AC10) bounds its size.
- Line-level comparison at the update merge (round 1): the sealed line keys differ from the
  merge on nearly every build, so the disk path read and refused almost every time. Replaced by
  the path-level comparison, because R5 reads only paths.

## Acceptance criteria

Summary:

- AC1 inline cap and the `FLEET_CALLERS_ON_DISK` marker (real program).
- AC2 file mode: content-addressed file, line and path hashes in the summary, write failure
  (real program).
- AC3 read mode: batch-wide 50-entry pages for parts `all`, `auto` and `paths` (real program).
- AC4 read mode refusals and the relay-cap marker (real program).
- AC5 workflow: marker -> `:file`; an exact map needs no read; `auto_dont_care` `[]`.
- AC6 workflow: batch-wide auto reads (exact read count) and part-all reads with today's findings.
- AC7 workflow relay checks: file path, summary entries, joins, page fields, digest and args
  retries.
- AC8 workflow: a read page over the relay cap stops `needs_human`, stop gate `callers`.
- AC9 update-merge grep `infra:callers:u1` on the disk path at path level: a line shift needs no
  read; a changed path set reads part `paths` only (never part `auto`).
- AC10 summary cap: program marker and the workflow's split into disk halves.
- AC11 read budget findings and the per-file memo across plan rounds.

The criteria below are copied from the structured criteria (criteria_r3.json) by a script;
the Given/When/Then text is literal.

### AC1

```text
[unit] callers.py inline mode (arguments <worktree> <plan_path> <symbols json> <cap>) prints the unchanged inline object when the printed JSON is at most 8192 bytes; over 8192 bytes (also over 65536) it prints nothing on stdout and exits non-zero with stderr starting 'FLEET_CALLERS_ON_DISK: the callers output is over the 8192-byte inline cap (<n> bytes; symbols: <symbols joined by ', '>)'
```

Test files: `plugins/fleet/tests/v720_callers_inline_cap.test.mjs`

Example 1 (main):

```text
Given: a git repo (one commit) with 50 files src/services/module_<f % 10>/handlers/request_handler_<f as 2 digits>.py for f = 0..49, each holding, for every symbol sym_name_<i>_long_identifier (i = 0..29), the two lines 'x = sym_name_<i>_long_identifier(1)' and 'y = sym_name_<i>_long_identifier(2)'
When: python3 -I plugins/fleet/scripts/callers.py <repo> docs/plans/x.md '["sym_name_0_long_identifier","sym_name_1_long_identifier"]' 100
Then: exit code != 0; stdout == ''; stderr starts with 'FLEET_CALLERS_ON_DISK: the callers output is over the 8192-byte inline cap (' and contains 'bytes; symbols: sym_name_0_long_identifier, sym_name_1_long_identifier)'
```

Example 2 (boundary):

```text
Given: the same 50-file repo
When: run 1: callers.py <repo> docs/plans/x.md '["sym_name_0_long_identifier"]' 100; run 2: callers.py <repo> docs/plans/x.md '["sym_name_0_long_identifier","sym_name_1_long_identifier"]' 100
Then: run 1 (control, unchanged behaviour): exit 0, stdout is one JSON object with keys occurrences, capped, auto_dont_care, doctest_md, program, digest and occurrences.sym_name_0_long_identifier has 100 entries, stdout at most 8192 bytes; run 2: exit != 0 and stderr starts with 'FLEET_CALLERS_ON_DISK: '
```

Example 3 (boundary):

```text
Given: the same 50-file repo
When: callers.py <repo> docs/plans/x.md '<JSON list of all 30 symbols sym_name_0_long_identifier .. sym_name_29_long_identifier>' 100
Then: exit != 0; stdout == ''; stderr starts with 'FLEET_CALLERS_ON_DISK: the callers output is over the 8192-byte inline cap (' and does not start with 'FLEET_CALLERS_RELAY_CAP'
```

Example 4 (boundary):

```text
Given: the same 50-file repo
When: run 1: callers.py <repo> docs/plans/x.md '["absent_name"]' 100; run 2: callers.py <repo> docs/plans/x.md '["sym_name_2_long_identifier","sym_name_3_long_identifier"]' 100
Then: run 1 (control): exit 0 and stdout JSON has occurrences == {"absent_name": []}, capped == []; run 2: exit != 0 and stderr starts with 'FLEET_CALLERS_ON_DISK: '
```

Don't care:

```text
- the byte count <n> in the marker (only that it is a decimal number)
```

```text
- the 300-character cut of the symbol list
```

```text
- stderr after the fixed prefix
```

```text
- the control runs (single symbol, no-hit symbol) are unchanged-behaviour controls under the non-goal 'no change to plans whose callers output is at most 8192 bytes'; each is paired with a RED run in the same example
```

```text
- failure paths (timeout, partial write, concurrency): the program writes only to stdout; git grep failure behaviour is unchanged
```

### AC2

```text
[unit] callers.py file mode (callers.py file <worktree> <plan_path> <symbols json> <cap> <scratch_dir>) writes the full inline JSON text to <scratch_dir>/callers/callers-<sha256 of the file bytes>.json (temp file then rename) and prints only {symbols: {<s>: {count, sha256, auto_count, path_count, paths_sha256}}, capped, doctest_md, file, args, program, digest}, where sha256 is the sha256 of json.dumps(sorted hits, separators=(',', ':'), ensure_ascii=False) in UTF-8, auto_count the number of auto doc or lock hits, path_count and paths_sha256 the number and the same hash of the sorted unique paths (text before the last ':') of the hits; a capped symbol has count 0, sha256 and paths_sha256 of '[]', auto_count 0 and path_count 0; a write failure exits non-zero with empty stdout and stderr starting 'FLEET_CALLERS_FILE: cannot write the callers file'; another argument count exits non-zero with stderr starting 'FLEET_CALLERS_FILE: '
```

Test files: `plugins/fleet/tests/v720_callers_file_mode.test.mjs`

Property:

```text
the file's sha256 equals the 64 hex in its name
```

Example 1 (main):

```text
Given: a git repo (one commit) with src/a.py = 'foo()\n\nfoo()\n' and README.md = 'x\nfoo\n'; an empty scratch dir S
When: python3 -I plugins/fleet/scripts/callers.py file <repo> docs/plans/x.md '["foo"]' 100 S
Then: exit 0; stdout JSON has symbols == {"foo": {"count": 3, "sha256": "84048ae2c9d38392fc0b8888ebb4cda38a23ad15c39f161fd299260d9546cff7", "auto_count": 1, "path_count": 2, "paths_sha256": "5dcffd5e752a42faea01117f350cba43ae8288d1ff98a0033f4378efc4dd8ad1"}}, capped == [], doctest_md == [], args == [<repo>, "docs/plans/x.md", "[\"foo\"]", "100", S], no key 'occurrences'; file == S + '/callers/callers-' + H + '.json' where H is the sha256 of that file's bytes; json.loads(file) has occurrences.foo == ["README.md:2", "src/a.py:1", "src/a.py:3"] and auto_dont_care.foo == ["README.md:2"]; S/callers holds exactly one file
```

Example 2 (boundary):

```text
Given: the same repo plus src/c.py with 101 lines 'bar()'; empty scratch dir S
When: callers.py file <repo> docs/plans/x.md '["bar"]' 100 S
Then: exit 0; symbols.bar == {"count": 0, "sha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "auto_count": 0, "path_count": 0, "paths_sha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"}; capped == ["bar"]
```

Example 3 (boundary):

```text
Given: the AC2 main repo; scratch dir S
When: run callers.py file <repo> docs/plans/x.md '["foo"]' 100 S twice
Then: both exit 0 with the same file value; S/callers holds exactly one file and its bytes are unchanged after run 2
```

Example 4 (failure):

```text
Given: the AC2 main repo; scratch dir T where T/callers is a regular file; a second empty scratch dir S
When: run 1: callers.py file <repo> docs/plans/x.md '["foo"]' 100 T; run 2 (control): the same with S
Then: run 1: exit != 0, stdout == '', stderr starts with 'FLEET_CALLERS_FILE: cannot write the callers file'; run 2: exit 0 and stdout JSON has key 'file'
```

Example 5 (refusal):

```text
Given: the AC2 main repo
When: callers.py file <repo> docs/plans/x.md '["foo"]' 100 (no scratch dir argument)
Then: exit != 0; stdout == ''; stderr starts with 'FLEET_CALLERS_FILE: '
```

Don't care:

```text
- the temp file name used before the rename
```

```text
- stderr after the fixed prefix
```

```text
- key order in the printed JSON
```

```text
- the program and digest values (only that digest is 64 lowercase hex)
```

```text
- partial write: the rename makes the final file all-or-nothing; a concurrent run with the same content writes the same name and bytes (covered by the repeat example)
```

```text
- timeout: no network or wait; git grep behaviour unchanged
```

### AC3

```text
[unit] callers.py read mode (callers.py read <file> <part> <symbols json> <page>) pages over ALL listed symbols at once and prints {part, page: {index, count}, hits, auto, args, program, digest}: the list L is, per listed symbol in code-point order, its hits sorted by code point (part all), its auto doc or lock hits sorted (part auto) or the sorted unique paths of its hits (part paths); page <page> holds L[50*page : 50*page+50]; hits[s] = the page's entries of s in order; auto[s] = for part all the indices into hits[s] of its auto hits, for part auto every index of hits[s], for part paths no key (auto is {}); a symbol with no entry on the page has no key in hits or auto; page.count = max(1, ceil(len(L) / 50)); args = the four arguments after the mode word
```

Test files: `plugins/fleet/tests/v720_callers_read_mode.test.mjs`

Property:

```text
joining hits[s] over pages 0..count-1 gives the symbol's full sorted list for the part
```

Example 1 (main):

```text
Given: a git repo with src/a.py = 'foo()\n\nfoo()\n', README.md = 'x\nfoo\n', src/b.py = 'x\nbaz()\n'; F = the file written by callers.py file <repo> docs/plans/x.md '["baz","foo"]' 100 S
When: callers.py read F all '["baz","foo"]' 0
Then: exit 0; part == 'all'; page == {"index": 0, "count": 1}; hits == {"baz": ["src/b.py:2"], "foo": ["README.md:2", "src/a.py:1", "src/a.py:3"]}; auto == {"baz": [], "foo": [0]}; args == [F, "all", "[\"baz\",\"foo\"]", "0"]
```

Example 2 (main):

```text
Given: the same F
When: callers.py read F auto '["baz","foo"]' 0
Then: exit 0; page == {"index": 0, "count": 1}; hits == {"foo": ["README.md:2"]}; auto == {"foo": [0]}; no key baz in hits or auto
```

Example 3 (main):

```text
Given: the same F
When: callers.py read F paths '["baz","foo"]' 0
Then: exit 0; part == 'paths'; page == {"index": 0, "count": 1}; hits == {"baz": ["src/b.py"], "foo": ["README.md", "src/a.py"]}; auto == {}
```

Example 4 (boundary):

```text
Given: a repo with src/m.py of 60 lines 'many()'; F = file mode output for '["many"]' cap 100
When: run 1: read F all '["many"]' 0; run 2: read F all '["many"]' 1
Then: run 1: page == {"index": 0, "count": 2}, hits.many has 50 entries starting 'src/m.py:1', 'src/m.py:10', 'src/m.py:11'; run 2: page == {"index": 1, "count": 2}, hits.many == ["src/m.py:55", "src/m.py:56", "src/m.py:57", "src/m.py:58", "src/m.py:59", "src/m.py:6", "src/m.py:60", "src/m.py:7", "src/m.py:8", "src/m.py:9"], auto == {"many": []}
```

Example 5 (boundary):

```text
Given: a repo with src/p.py of 30 lines 'aa1()' and src/q.py of 30 lines 'aa2()'; F = file mode output for '["aa1","aa2"]' cap 100
When: run 1: read F all '["aa2","aa1"]' 0; run 2: read F all '["aa2","aa1"]' 1
Then: run 1: page.count == 2, hits.aa1 has 30 entries, hits.aa2 has 20 entries; run 2: hits has only key aa2 with 10 entries, no key aa1 in hits or auto
```

Example 6 (boundary):

```text
Given: a repo where 'nothing_here' has no hit; F = file mode output for '["nothing_here"]' cap 100
When: read F all '["nothing_here"]' 0
Then: exit 0; page == {"index": 0, "count": 1}; hits == {}; auto == {}
```

Don't care:

```text
- key order in the printed JSON
```

```text
- the program and digest values (only that digest is 64 lowercase hex)
```

```text
- failure paths: read mode opens one file read-only; refusals are AC4; no concurrency (the file is immutable once named)
```

### AC4

```text
[unit] callers.py read mode refuses with a non-zero exit, empty stdout and stderr starting 'FLEET_CALLERS_READ: ': another argument count, a basename other than callers-<64 lowercase hex>.json, a path that is not a regular file (symlink or directory), bytes that do not hash to the name, a part other than all, auto or paths, symbols that are not a non-empty JSON list of distinct strings, a symbol that is not a key of the file's occurrences, a page that is not 0 or [1-9][0-9]* or is not below page.count; a page whose printed JSON is over 65536 bytes exits with stderr starting 'FLEET_CALLERS_RELAY_CAP: the callers output is over the 65536-byte relay cap (<n> bytes; symbols: <symbols on the page>)'
```

Test files: `plugins/fleet/tests/v720_callers_read_refusals.test.mjs`

Property:

```text
never-prints on refusal
```

Example 1 (refusal):

```text
Given: F = a valid file from file mode for '["foo"]' (AC2 main repo)
When: each of: read F all '["foo"]' (3 args); read <dir>/callers-ABC.json all '["foo"]' 0; read <a symlink named callers-<hash of F>.json pointing to F> all '["foo"]' 0; read <copy of F with one byte changed, same name> all '["foo"]' 0; read F code '["foo"]' 0; read F all '[]' 0; read F all '["foo","foo"]' 0; read F all '"foo"' 0; read F all '["nope"]' 0; read F all '["foo"]' -1; read F all '["foo"]' 01; read F all '["foo"]' 1
Then: every run: exit != 0, stdout == '', stderr starts with 'FLEET_CALLERS_READ: '
```

Example 2 (boundary):

```text
Given: F as above
When: read F all '["foo"]' 0 (control)
Then: exit 0
```

Example 3 (refusal):

```text
Given: a repo with 7 nested dirs, dir k named 'd' * 200 + str(k) for k = 0..6, and in the innermost dir 50 files 'm' + <f as 3 digits> + '_' + 'x' * 60 + '.py' (f = 0..49), each holding 'huge_symbol()\n'; F = file mode output for '["huge_symbol"]' cap 100
When: read F all '["huge_symbol"]' 0
Then: exit != 0; stdout == ''; stderr starts with 'FLEET_CALLERS_RELAY_CAP: the callers output is over the 65536-byte relay cap (' and contains 'bytes; symbols: huge_symbol)'
```

Don't care:

```text
- stderr text after the fixed prefixes
```

```text
- which check fires first when several apply
```

```text
- timeout and concurrency: one read-only open, no subprocess; a file changed between hash and parse is refused by the hash check
```

### AC5

```text
[unit] workflow: when infra:callers returns failed with a reason holding 'FLEET_CALLERS_ON_DISK:', the workflow writes a gate line, dispatches <lb>:file running callers.py file mode with args [worktree, plan_path, symbols json, '100', scratchOf(worktree)]; for each symbol whose mapped occurrence set (occurrenceKey-normalised, unique, sorted by code point) hashes (sha256 of canonical JSON) to the summary sha256 it dispatches no read, takes the mapped set as its occurrences with auto_dont_care [], and the plan goes on as with an inline relay
```

Test files: `plugins/fleet/tests/v720_callers_disk_exact.test.mjs`

Example 1 (main):

```text
Given: a plan run whose planner maps foo to src/a.py:1 (criterion AC1) and src/a.py:3 (dont_care); stub infra:callers = {status: 'failed', reason: 'FLEET_CALLERS_ON_DISK: the callers output is over the 8192-byte inline cap (9000 bytes; symbols: foo)'}; stub infra:callers:file = summary {symbols: {foo: {count: 2, sha256: '0d6929e120b4a6c7de63332677250787bb7bdaf699bbc8524ef8693ab9161a6c', auto_count: 0, path_count: 1, paths_sha256: 'ab74f77bcbbda6f03ee88a40ee6ca88e13b97ead7f322c07fde1ef785f0e970f'}}, capped: [], doctest_md: [], file: scratchOf(worktree) + '/callers/callers-' + 'a' * 64 + '.json', args: the five args sent} with a valid program and digest
When: the run proceeds
Then: labels include 'infra:callers:file' and no label contains ':read:'; the infra:callers:file prompt runs callers.py with 'file' and args [worktree, plan_path, '["foo"]', '100', scratchOf(worktree)]; logs include 'infra:callers: the caller output is over the 8192-byte inline cap; on-disk handoff (1 symbols)'; role:plan-audit is dispatched; its caller_check.auto_dont_care.foo == [] and no caller finding is routed
```

Example 2 (boundary):

```text
Given: as the main example but the planner maps foo to ' src/a.py:3' and './src/a.py:1' (occurrenceKey normalises both)
When: the run proceeds
Then: no label contains ':read:'; role:plan-audit is dispatched
```

Example 3 (boundary):

```text
Given: stub infra:callers = an ok inline relay with occurrences {foo: ['src/a.py:1', 'src/a.py:3']} (control)
When: the run proceeds
Then: no label 'infra:callers:file'; role:plan-audit is dispatched
```

Don't care:

```text
- gate-line wording other than the pinned line
```

```text
- the order of unrelated labels
```

```text
- failure paths of the file relay (failed, digest miss) are AC7 and AC10
```

```text
- the inline control example is unchanged behaviour (non-goal: no change for outputs of at most 8192 bytes), paired with the RED main example
```

### AC6

```text
[unit] workflow disk path reads, batch-wide: the symbols whose mapped set hash differs from the summary sha256 and whose auto_count > 0 are read together with part auto (labels <lb>:read:auto:<k>, k = 0..pages-1, pages = max(1, ceil(sum of auto_count / 50)), args [file, 'auto', symbols json in code-point order, '<k>']); a symbol whose mapped set united with its auto list hashes to sha256 takes that union as occurrences and its auto list as auto_dont_care, and the sealed map adds each auto hit with dont_care 'auto: non-code file'; every other differing symbol is read with part all (labels <lb>:read:all:<k>, pages over the sum of count) and gets today's findings for unmapped or stale lines
```

Test files: `plugins/fleet/tests/v720_callers_disk_reads.test.mjs`

Example 1 (main):

```text
Given: planner maps b_sym to src/b.py:2; inline relay failed ON_DISK; file summary b_sym = {count: 2, sha256: 'aed7e430798b190baaa0a0db673923920222eceb6d0d58b10b50b1291451a590', auto_count: 1, path_count: 2, paths_sha256: '6b2ddbbe50d3d44a9e1a5202343cb42a369e29406cfcac48ef7dd28e5a400a15'}; stub infra:callers:read:auto:0 = {part: 'auto', page: {index: 0, count: 1}, hits: {b_sym: ['docs/b.md:4']}, auto: {b_sym: [0]}, args: [file, 'auto', '["b_sym"]', '0']} with valid digest
When: the run proceeds
Then: the only read label is 'infra:callers:read:auto:0'; no caller finding; caller_check.auto_dont_care.b_sym == ['docs/b.md:4']; the sealed changed_symbols entry of b_sym holds {at: 'docs/b.md:4', criterion: null, dont_care: 'auto: non-code file'}
```

Example 2 (main):

```text
Given: three symbols a_sym, b_sym, c_sym, each mapped exactly to its code hits, with summaries auto_count 40, 50 and 60 (each sha256 = hash of mapped hits plus its auto hits); read relays return the auto hits in code-point order
When: the run proceeds
Then: read labels are exactly 'infra:callers:read:auto:0', 'infra:callers:read:auto:1', 'infra:callers:read:auto:2'; page 0 args == [file, 'auto', '["a_sym","b_sym","c_sym"]', '0']; no ':read:all:' label; no caller finding
```

Example 3 (refusal):

```text
Given: planner maps b_sym to src/b.py:9 (stale); summary b_sym = {count: 2, sha256: 'aed7e430798b190baaa0a0db673923920222eceb6d0d58b10b50b1291451a590', auto_count: 1, path_count: 2, paths_sha256: '6b2ddbbe50d3d44a9e1a5202343cb42a369e29406cfcac48ef7dd28e5a400a15'}; auto read page returns hits {b_sym: ['docs/b.md:4']}; stub infra:callers:read:all:0 = hits {b_sym: ['docs/b.md:4', 'src/b.py:2']}, auto {b_sym: [0]}, page {index: 0, count: 1}
When: the run proceeds
Then: read labels in order: 'infra:callers:read:auto:0', 'infra:callers:read:all:0'; caller findings include 'b_sym: src/b.py:2 is an occurrence (git grep -w) not mapped in changed_symbols; map it to a criterion or to dont_care with a reason' and 'b_sym: src/b.py:9 is mapped but git grep -w finds no occurrence there (stale line or wrong path; cite lines at the worktree HEAD)'
```

Example 4 (refusal):

```text
Given: planner maps x_sym to src/x.py:2; summary x_sym = {count: 1, sha256: '8146edc58d41c639f6fe85625f99208cdea6a668e2ff175749f09d81b721d6ff', auto_count: 0, path_count: 1, paths_sha256: 'd972a97a86d66627b452ed0a5cf304fb49338cbc7df048358a55ebe28acf219f'}; read all page returns hits {x_sym: ['src/x.py:1']}, auto {x_sym: []}
When: the run proceeds
Then: the only read label is 'infra:callers:read:all:0'; findings include 'x_sym: src/x.py:1 is an occurrence (git grep -w) not mapped ...' and 'x_sym: src/x.py:2 is mapped but git grep -w finds no occurrence there ...'
```

Don't care:

```text
- finding order
```

```text
- gate-line wording
```

```text
- read relay failures and digest misses are AC7/AC8
```

### AC7

```text
[unit] workflow relay checks on the disk path: a file other than scratchOf(worktree)/callers/callers-<64 lowercase hex>.json halts failed with a reason starting '<lb>:file: the callers file '; a summary missing a batch symbol or with an invalid entry (count not an integer >= 0, sha256 or paths_sha256 not 64 hex, auto_count not in 0..count, path_count not in 0..count) halts failed starting '<lb>:file: the summary has no valid entry for <s>'; a read page whose page.index or page.count differs halts failed starting '<label>: the read page'; joined pages whose count or hash differ from the summary halt failed starting '<lb>:read:<part>: the read occurrences of <s> do not match the summary'; a file or read relay that misses its digest gets exactly one '<label>:digest-retry' dispatch and one with other args one '<label>:args-retry'; faithful file and read relays get neither
```

Test files: `plugins/fleet/tests/v720_callers_disk_checks.test.mjs`

Example 1 (refusal):

```text
Given: AC5 main setup but the file summary's file = '/tmp/x/callers/callers-' + 'a' * 64 + '.json'
When: the run proceeds
Then: status failed; reason starts with 'infra:callers:file: the callers file '
```

Example 2 (refusal):

```text
Given: batch ['bar', 'foo'] (both mapped); the file summary has an entry for foo only
When: the run proceeds
Then: status failed; reason starts with 'infra:callers:file: the summary has no valid entry for bar'
```

Example 3 (refusal):

```text
Given: AC5 main setup but foo's entry has auto_count 3 (count 2); run 2: path_count 3; run 3: paths_sha256 'xyz'
When: each run proceeds
Then: each: status failed; reason starts with 'infra:callers:file: the summary has no valid entry for foo'
```

Example 4 (refusal):

```text
Given: AC6 main setup but the infra:callers:read:auto:0 relay has page {index: 1, count: 1}
When: the run proceeds
Then: status failed; reason starts with 'infra:callers:read:auto:0: the read page'
```

Example 5 (refusal):

```text
Given: AC6 main setup but the auto read returns hits {b_sym: ['docs/b.md:4', 'docs/c.md:1']} (auto_count is 1)
When: the run proceeds
Then: status failed; reason starts with 'infra:callers:read:auto: the read occurrences of b_sym do not match the summary'
```

Example 6 (main):

```text
Given: AC5 main setup but the first infra:callers:file relay has a wrong 64-hex digest; infra:callers:file:digest-retry returns the faithful summary
When: the run proceeds
Then: labels contain 'infra:callers:file:digest-retry' exactly once; role:plan-audit is dispatched
```

Example 7 (main):

```text
Given: AC5 main setup but the first infra:callers:file relay echoes args with another worktree (digest valid for that relay); infra:callers:file:args-retry returns the faithful summary
When: the run proceeds
Then: labels contain 'infra:callers:file:args-retry' exactly once; role:plan-audit is dispatched
```

Example 8 (boundary):

```text
Given: AC6 main setup with faithful relays (control paired with the retry examples)
When: the run proceeds
Then: no label ends with ':digest-retry' or ':args-retry'
```

Don't care:

```text
- reason text after the pinned prefixes
```

```text
- no upper bound on count is checked (the program caps at 100 hits; every example stays at or below 100 per symbol)
```

```text
- gate-line wording of the retry
```

```text
- timeout of a relay: handled by the existing dispatch layer, unchanged
```

### AC8

```text
[unit] workflow: a read page relay marked failed with a reason holding 'FLEET_CALLERS_RELAY_CAP:' stops the run needs_human with stop_gate 'callers' and a reason starting '<label>: the occurrences of <symbols> are over the 65536-byte relay cap on one read page'; a summary relay with that marker is AC10
```

Test files: `plugins/fleet/tests/v720_callers_read_cap.test.mjs`

Example 1 (refusal):

```text
Given: planner maps huge_symbol to nothing; inline relay failed ON_DISK; summary huge_symbol = {count: 50, sha256: 64 hex 'c' * 64, auto_count: 0, path_count: 50, paths_sha256: 'd' * 64}; stub infra:callers:read:all:0 = {status: 'failed', reason: 'FLEET_CALLERS_RELAY_CAP: the callers output is over the 65536-byte relay cap (74300 bytes; symbols: huge_symbol)'}
When: the run proceeds
Then: status needs_human; stop_gate 'callers'; reason starts with 'infra:callers:read:all:0: the occurrences of huge_symbol are over the 65536-byte relay cap on one read page'
```

Example 2 (failure):

```text
Given: as above but the read relay is failed with reason 'boom'
When: the run proceeds
Then: status failed (not needs_human); reason contains 'infra:callers:read:all:0'
```

Don't care:

```text
- reason text after the pinned prefix
```

```text
- no retry for a relay-cap marker (the run stops)
```

### AC9

```text
[unit] workflow update merge (R5 in updRefusal): the infra:callers:u1 grep takes the disk path on the FLEET_CALLERS_ON_DISK marker at path level, with expected = the sealed changed_symbols paths per symbol (auto entries included): a symbol whose sealed path set hashes to the summary paths_sha256 needs no read (a line shift with the same files); a differing symbol is read with part paths only (labels infra:callers:u1:read:paths:<k>; never part auto or all at u1) and its paths join R5's moved-file check; differing symbols whose path pages do not fit the read budget refuse with 'the occurrences of <names> at the update merge differ from the sealed map and are over the caller read budget'
```

Test files: `plugins/fleet/tests/v720_callers_update_merge.test.mjs`

Example 1 (main):

```text
Given: a build run that reaches the update merge with blocking re-review findings as tests/v610_update_coder.test.mjs T9 does: sealed guard_verdict occurrences ['src/a.py:10', 'src/y.py:5'], moved ['src/w.py']; stub infra:callers:u1 = {status: 'failed', reason: 'FLEET_CALLERS_ON_DISK: the callers output is over the 8192-byte inline cap (9000 bytes; symbols: guard_verdict)'}; stub infra:callers:u1:file summary guard_verdict = {count: 2, sha256: 'c21a9893c370d3206a171fe3a131602996bb41375de82ec84d837d2e31c72e1b', auto_count: 0, path_count: 2, paths_sha256: '66ca4a655fcd41095974212b8edabb03d71f08c0829fd09e6377e5a1291d3227'}
When: the run proceeds
Then: no label starts with 'infra:callers:u1:read:'; logs include a line containing 'R1-R5 pass -> code rounds on the update merge'
```

Example 2 (refusal):

```text
Given: as the main example but the summary is guard_verdict = {count: 3, sha256: '6176962c118111a700bf7c64fdbc1206b7aac13385048a4302186ed94b639b9b', auto_count: 0, path_count: 3, paths_sha256: 'e27644c1a1452d659f6eb1e9a355da502f8148fea737c573e00a070f4ab0a028'}; stub infra:callers:u1:read:paths:0 = {part: 'paths', page: {index: 0, count: 1}, hits: {guard_verdict: ['src/a.py', 'src/w.py', 'src/y.py']}, auto: {}, args: [file, 'paths', '["guard_verdict"]', '0']}
When: the run proceeds
Then: the only u1 read label is 'infra:callers:u1:read:paths:0'; status needs_human; reason contains 'no coder round: the base change touches files with occurrences of the changed symbols (src/w.py)'
```

Example 3 (main):

```text
Given: as the main example but sealed guard_verdict occurrences are ['README.md:3', 'src/a.py:10', 'src/y.py:5'] and the summary is {count: 3, sha256: '1aad30c3f1aa0926cade9cc1e2578c856c7bd72e6877eec7024a4b397a62c681', auto_count: 1, path_count: 3, paths_sha256: 'c4de482c8cc3db8ae3995cc01b66ea5394b98f9122d116aa5fecfa1486adad50'}
When: the run proceeds
Then: no label starts with 'infra:callers:u1:read:' (no ':read:auto:', ':read:all:' or ':read:paths:'); logs include a line containing 'R1-R5 pass -> code rounds on the update merge'
```

Example 4 (refusal):

```text
Given: as the previous example but the summary is {count: 4, sha256: 'f2a0f115464dad027806ec99407b04490e84c52f844adbe6e4ab0c30729fd753', auto_count: 1, path_count: 4, paths_sha256: '509bdcb819b31726ebccf27c5437353754fbae17f66af308e4d45837d8f2ac86'}; the paths read returns ['README.md', 'src/a.py', 'src/w.py', 'src/y.py']
When: the run proceeds
Then: u1 read labels are exactly ['infra:callers:u1:read:paths:0']; no label contains ':u1:read:auto:' or ':u1:read:all:'; status needs_human; reason contains '(src/w.py)'
```

Example 5 (refusal):

```text
Given: sealed symbols p_one, p_two, p_three, each with one sealed occurrence src/p.py:1; summaries each {count: 84, auto_count: 0, path_count: 84, paths_sha256 not the hash of ['src/p.py']}
When: the run proceeds
Then: no label starts with 'infra:callers:u1:read:'; status needs_human; reason contains 'the occurrences of p_one, p_three, p_two at the update merge differ from the sealed map and are over the caller read budget'
```

Example 6 (boundary):

```text
Given: control: the main example but infra:callers:u1 is an ok inline relay with occurrences {guard_verdict: ['src/a.py:14', 'src/y.py:5']}
When: the run proceeds
Then: no label 'infra:callers:u1:file'; logs include 'R1-R5 pass -> code rounds on the update merge'
```

Don't care:

```text
- the order of names other than code-point order in the budget refusal
```

```text
- the inline control is unchanged behaviour (paired with RED examples)
```

```text
- gate-line wording other than the pinned text
```

### AC10

```text
[unit] summary cap: callers.py file mode whose printed summary is over 8192 bytes exits non-zero, empty stdout, stderr starting 'FLEET_CALLERS_RELAY_CAP: the callers summary is over the 8192-byte inline cap ('; the workflow splits that batch in halves that go straight to the disk path (<lb'>:file, no inline dispatch for them) with the gate line '<lb>:file: <n> symbols are over the summary cap; split in two'; one symbol alone stops needs_human with stop_gate 'callers'
```

Test files: `plugins/fleet/tests/v720_callers_summary_cap.test.mjs`

Example 1 (main):

```text
Given: a repo with src/f.py holding one line '<name>()' per name, names s<i as 2 digits>_ + 'n' * 116 for i = 0..29; scratch dir S
When: run 1: callers.py file <repo> docs/plans/x.md '<JSON list of all 30 names>' 100 S; run 2 (control): the same with the first 10 names
Then: run 1: exit != 0, stdout == '', stderr starts with 'FLEET_CALLERS_RELAY_CAP: the callers summary is over the 8192-byte inline cap ('; run 2: exit 0 and stdout JSON has 10 keys in symbols
```

Example 2 (main):

```text
Given: batch ['s1', 's2', 's3', 's4']; inline relay failed ON_DISK; stub infra:callers:file = {status: 'failed', reason: 'FLEET_CALLERS_RELAY_CAP: the callers summary is over the 8192-byte inline cap (9000 bytes; symbols: s1, s2, s3, s4)'}; stubs infra:callers:b2:file and infra:callers:b3:file = faithful summaries for ['s1','s2'] and ['s3','s4'] that match the map
When: the run proceeds
Then: logs include 'infra:callers:file: 4 symbols are over the summary cap; split in two'; labels include 'infra:callers:b2:file' and 'infra:callers:b3:file' and not 'infra:callers:b2' or 'infra:callers:b3'; role:plan-audit is dispatched
```

Example 3 (refusal):

```text
Given: batch ['s1']; inline relay failed ON_DISK; infra:callers:file failed with the summary RELAY_CAP marker
When: the run proceeds
Then: status needs_human; stop_gate 'callers'; reason starts with 'infra:callers:file: the caller summary of s1 is over the 8192-byte inline cap'
```

Don't care:

```text
- the byte count in the marker
```

```text
- reason text after the pinned prefix
```

### AC11

```text
[unit] read budget and memo: at most CALLER_READ_BUDGET = 4 read dispatches per callerGrep call (retries not counted); a part whose pages do not fit the remaining budget is not read, and callerCheck gives each such symbol one finding (part auto: '<s>: <auto_count> doc or lock hit(s) left to auto dont_care are over the caller read budget (4 reads of 50 entries); map them in changed_symbols (dont_care with a reason)'; part all: '<s>: the mapped occurrences differ from git grep -w (<count> hits, <n> mapped) and the hit list is over the caller read budget (4 reads of 50 entries); re-grep and map every hit'); lists already read for the same file earlier in the run are reused with no dispatch
```

Test files: `plugins/fleet/tests/v720_callers_read_budget.test.mjs`

Example 1 (refusal):

```text
Given: symbols r_one, r_two, r_three, each mapped to its 0 code hits (no map entry); summaries each {count: 84, auto_count: 84, path_count: 84} with sha256 not the hash of []; total auto 252 -> 6 pages
When: the plan run proceeds
Then: no label contains ':read:'; caller findings include 'r_one: 84 doc or lock hit(s) left to auto dont_care are over the caller read budget (4 reads of 50 entries); map them in changed_symbols (dont_care with a reason)' and the same for r_three and r_two
```

Example 2 (refusal):

```text
Given: symbols t_one, t_two, t_three, each mapped to 1 occurrence; summaries each {count: 84, auto_count: 0, path_count: 1} with sha256 not the hash of the mapped one; total 252 -> 6 pages
When: the plan run proceeds
Then: no label contains ':read:'; findings include 't_one: the mapped occurrences differ from git grep -w (84 hits, 1 mapped) and the hit list is over the caller read budget (4 reads of 50 entries); re-grep and map every hit' and the same for t_three and t_two
```

Example 3 (boundary):

```text
Given: symbols u_one, u_two each with auto_count 100 (both auto-only, mapped none): total 200 -> 4 pages
When: the plan run proceeds
Then: read labels are exactly 'infra:callers:read:auto:0' .. 'infra:callers:read:auto:3'; no budget finding
```

Example 4 (main):

```text
Given: AC6 main setup (b_sym, one auto read); role:plan-audit refuses once (plan_defect); the audit-fix round's infra:callers:audit-fix is failed ON_DISK and infra:callers:audit-fix:file returns the same file value and summary
When: the run proceeds
Then: labels include 'infra:callers:read:auto:0' and not 'infra:callers:audit-fix:read:auto:0'; the audit-fix round's caller_check.auto_dont_care.b_sym == ['docs/b.md:4']
```

Don't care:

```text
- finding order
```

```text
- the memo is never persisted (a resumed run reads again)
```

## STRIDE (trust boundary: the scratch file and the agent relays of the new modes)

- Spoofing: the script accepts only `file` = `<scratch>/callers/callers-<64 hex>.json` (AC7);
  read mode refuses another basename and a symlink (AC4); the args check catches a run on
  other arguments (AC7).
- Tampering: read mode refuses a file whose bytes do not hash to its name (AC4); every relay is
  digest-checked, and every joined list is checked against the summary count and hash (AC7).
- Repudiation: not applicable (no actor identity; gate lines log each handoff).
- Information disclosure: the file holds repo paths and line numbers only, in the run scratch
  outside the worktree; no new exposure (non-goal: scratch cleanup).
- Denial of service: 50-entry pages, a 65536-byte page cap (AC4, AC8), the 8192-byte summary
  cap (AC10), the read budget (AC11), the 100-hit cap per symbol.
- Elevation of privilege: read mode opens one file read-only and runs no subprocess; the agent
  runs only the printed command (prompt rule as today).

## Repo obligations (coder steps)

- OB1 version bump 7.1.1 -> 7.2.0 (pre-commit hook `validate-plugin-versions`,
  `tests/v4_s2.test.mjs` version checks). Production: `FLEET_VERSION` (`src:119`), then the dist
  via OB3; `.claude-plugin/marketplace.json:134`; root `README.md:160` (`### fleet (v7.2.0)`).
  Test mirrors (`7.1.1` -> `7.2.0`, regex `7\.1\.1` -> `7\.2\.0`):
  `tests/harness.mjs:1085` (`SCRIPTS_DIR`); `tests/v4_s1.test.mjs:127, 331, 333-335, 337-341,
343, 347, 368, 377, 683, 697-699`; `tests/v4_s3.test.mjs:555, 616`; `tests/v5_roles.test.mjs:25`
  (in `realProbe`), `:250`; `tests/v600_s3.test.mjs:36` (`TPL`), `:112`;
  `tests/build_task_run.test.mjs:211, 6285, 6983, 8693`; `tests/v403_schema_types.test.mjs:1129`;
  `tests/v622_fixes.test.mjs:617`. Comment lines and `v711_*` test names that name 7.1.1 as the
  release of L2142 stay.
- OB2 changelog: `plugins/fleet/CHANGELOG.md`, a new top `## [7.2.0] - 2026-11-16` entry with a
  Deploy note (update the plugin to 7.2.0, start a new session) and Changed/Added items for the
  three modes, the disk path, the read budget and the memo (hook `check-changelog`).
- OB3 generated: `node plugins/fleet/scripts/gen.mjs` (the `callers` entry of `PROGRAM_SHA256`
  changes with `callers.py`), then `node plugins/fleet/scripts/build-workflow.mjs`; commit
  `plugins/fleet/workflows/build-task-run.js` as built (`tests/v631_dist.test.mjs`,
  `tests/v701_build_parity.test.mjs`). No new program file.
- OB4 docs: `plugins/fleet/README.md`, the caller-check paragraph (inline cap, on-disk handoff,
  summary hash, pages, read budget). `plugins/fleet/docs/build-task-run-notes.md`: one line under
  the `before callerCheck` block (outside the quoted 5.0.9 text, which stays verbatim).
- OB5 test registries:
  - harness `PROGRAM_LABELS` (`tests/harness.mjs:1219`): three MUTUALLY EXCLUSIVE callers
    entries. `tests/v402_file_sha.test.mjs:99-101` (`harnessSlots`) accepts a label only when exactly one entry
    matches it. Use
    `/^infra:callers(?!.*:(file|read)(:|$))/` -> `K("callers")` (the narrowed catch-all at `:1245`),
    `/^infra:callers(:[a-z0-9-]+)*:file(:(digest|args)-retry)?$/` -> `PROGRAM_KEYS["callers:file"] || null`,
    `/^infra:callers(:[a-z0-9-]+)*:read:(all|auto|paths):[0-9]+(:(digest|args)-retry)?$/` -> `PROGRAM_KEYS["callers:read"] || null`
    (the lazy form, as the 7.1.0 `pr_test_block` entry does). Check them against every label:
    prefixes `""`, `:audit-fix`, `:audit-fix-2`, `:u1`, each with or without `:b<n>`; suffixes
    `:digest-retry`, `:args-retry`. Read labels hold no symbol name, so a symbol named `file` or
    `read` cannot collide.
  - `SAMPLES` (`tests/v402_file_sha.test.mjs:33`): add `"infra:callers:file"` and
    `"infra:callers:read:auto:0"`, one per new harness entry (`:155` asserts every entry is
    sampled; `:148` asserts the exactly-one match).
  - `READS` (`tests/v403_schema_types.test.mjs:173`) and `ARRAY_SITES`
    (`tests/build_task_run.test.mjs:5608`): entries for each new typed read in `callerGrep`,
    `callerCheck` and the new helpers, exactly as those checks report them.
  - Any other test that enumerates `PROGRAM_KEYS` ids or caller labels
    (`tests/v507_digest_relays.test.mjs`, `tests/v502_relay_keys.test.mjs`,
    `tests/v4_s1.test.mjs:247`), only as their checks require.
- OB6 existing tests that pin the old inline size, in `tests/v630_flow.test.mjs`: "6.3.0 A1
  (ADR-1195 measure)" (`:139`, 4 x 100 hits printed inline) and "6.3.0 A1 (review M1)" (`:402`,
  the 65536 marker on a 100-hit symbol). Both now meet the 8192 inline cap first: change them to
  assert the `FLEET_CALLERS_ON_DISK` marker. AC4 covers the 65536 marker in read mode.

Test command: `npm test -- <paths>` (`package.json` `"test": "node --test"`; CI runs
`node --test plugins/*/tests/*.test.mjs`). Probe on `plugins/fleet/tests/v630_flow.test.mjs` in a
scratch worktree: exit 0 (19 tests pass).

## Non-goals

- No change to the inline shape or to plans whose callers output is at most 8192 bytes.
  The examples that show this are paired with a RED observable in the same example.
- No program-side comparison of the planner's map (would need the chunk writers; see Design).
- No change to the relay tier: `infra:callers` stays haiku (`INFRA_TIER`, `src:73`), and its digest
  retries run on that same tier (`digestRetry` -> `dispatch` -> `infraModel(label)`, `src:3427`).
  `RELAY_RETRY_MODEL` (`src:115`) serves only the path-check relay retry (`src:3218-3219`); no
  digest retry uses it. Escalating the retry model is yaadgaar #67, tracked separately.
- No removal of the inline `FLEET_CALLERS_RELAY_CAP` halving branch (it is now reached only by a
  stubbed or old relay).
- No cleanup of `<scratch>/callers/` files (the hasher files are not cleaned either).
- No other large relays (state_write, parked write: L2187; refs lists: L2028).
- No change to the per-symbol 100-hit cap (L2166).
- No parallel reads (pages run one after another).

## Open decisions

1. `INLINE_CAP` 8192 bytes, `PAGE` 50 entries and `CALLER_READ_BUDGET` 4 come from one incident
   (wf_c04c41b0-5ee: 25,915 bytes failed, 102 doc hits; unverified wf_0e5677ad-a03: about
   16 KB, 60 doc hits). A smaller cap or budget sends more plans to findings; a larger
   budget costs more agents (task #62). Max may pick other values.
2. The incident's digest retries ran on haiku. Moving the `infra:callers` tier (or its retries) to
   sonnet is a separate, cheap mitigation (yaadgaar #67); this plan does not do it.
3. A plan with more than 200 doc hits left to auto now gets a finding asking the planner to map
   them. Max may prefer a larger budget for auto reads only.
4. Update merge: when the differing symbols hold more than 200 paths in all (4 reads of 50),
   R5 refuses the coder round ("... over the caller read budget"; the run stops `needs_human`
   as other R1-R5 refusals do). Path counts this large need about 3 symbols of 70 or more
   distinct files each, all with a changed file set; Max may prefer a larger budget for
   path reads.

## Risks

- Many test registries enumerate labels and program ids (OB5); a missed one fails the suite, not
  production. The coder runs the full suite.
- `canonical()` must hash a string list exactly as Python's
  `json.dumps(..., separators=(',', ':'), ensure_ascii=False)`; `relayDigestOk` already relies on
  that. Sorting is by code point (`codePointCompare`), not UTF-16 units.
- A single symbol whose summary is over 8192 bytes (only with a huge `doctest_md` list) stops
  `needs_human`, as a single symbol over the relay cap does today.
- The callers.py placement rules above are the only way past the build-time definition check
  without mapping common top-level names; a coder who indents base code stops the build.
