// ccpmcwf 8.9.13 (yaadgaar #121): build wf_96b5611c-9da (yadgarhq/iam-db) stopped at callers after both
// judges approved: "changes code the sealed changed_symbols does not map: IamDbService
// (src/service/handlers.rs:28), IamDb (src/service/identity.rs:17), IamDb (src/service/seam.rs:15)".
// The tree only ADDED methods to those impl blocks. The roles say a plain new method is an addition
// (no mapping), and changed_defs.py says so too, but two kinds of added line broke the rule:
// a doc or line comment above the new member, and the closing line of its multi-line signature
// ("    ) -> Result<..> {"), which sits at the member's own indent. Both were attributed to the
// enclosing impl or class. Generic impl headers (impl<T> X<T>) were no definition at all, so a new
// member there was unattributed. These tests run the shipped program on git trees.
//
// Run: node --test plugins/*/tests/*.test.mjs (under the memory cap, see CI)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPTS_SRC, HAVE_PY, scratchRepo, sh, spawnSync } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROG = join(SCRIPTS_SRC, "changed_defs.py");

function defsOf(path, before, after) {
  const wt = scratchRepo("fleet-8913-");
  try {
    writeFileSync(join(wt, path), before);
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-qm", "base");
    const base = sh(wt, "git", "rev-parse", "HEAD").trim();
    writeFileSync(join(wt, path), after);
    sh(wt, "git", "add", "-A");
    const tree = sh(wt, "git", "write-tree").trim();
    const r = spawnSync("python3", ["-I", PROG, wt, base, tree, "[]"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    return { defs: o.defs.map((d) => d.name + "@" + d.at), unattributed: o.unattributed };
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
}

const A = "    fn a(&self) -> i32 {\n        1\n    }\n";
const HEADS = {
  "impl X": "impl X {\n",
  "impl Trait for X": "impl Trait for X {\n",
  "impl<T> X<T>": "impl<T> X<T> {\n",
  "impl<T: Into<Vec<u8>>> Trait for X<T>": "impl<T: Into<Vec<u8>>> Trait for X<T> {\n",
};
// the incident's shape: a doc comment, then an async method whose signature rustfmt split
const INCIDENT =
  "\n    /// `LookupUser`: the id of the live user.\n    ///\n    /// A READ.\n    pub(super) async fn find_user(\n        &self,\n        r: LookupUserRequest,\n    ) -> Result<Response<LookupUserResponse>, Status> {\n        Ok(Response::new(r.into()))\n    }\n";
const NEW = {
  "a one-line signature": "\n    fn b(&self) -> i32 {\n        2\n    }\n",
  "a doc comment": "\n    /// b is two.\n    fn b(&self) -> i32 {\n        2\n    }\n",
  "a line comment": "\n    // b is two.\n    fn b(&self) -> i32 {\n        2\n    }\n",
  "a multi-line signature": "\n    pub async fn b(\n        &self,\n        x: i32,\n    ) -> Result<i32, Status> {\n        Ok(x)\n    }\n",
  "a doc comment and a multi-line signature (the incident)": INCIDENT,
};

test("8.9.13 (#121): a new method in an existing Rust impl block is an addition, with a doc comment or a multi-line signature too", { skip: !HAVE_PY }, () => {
  for (const [hn, h] of Object.entries(HEADS)) {
    const base = "use x;\n\n" + h + A + "}\n";
    for (const [cn, c] of Object.entries(NEW)) {
      const o = defsOf("a.rs", base, "use x;\n\n" + h + A + c + "}\n");
      assert.deepEqual(o, { defs: [], unattributed: [] }, hn + ": " + cn);
    }
    // a whole new impl block is an addition too
    assert.deepEqual(defsOf("a.rs", "use x;\n", base), { defs: [], unattributed: [] }, hn + ": a new impl block");
  }
});

test("8.9.13 (#121): what the program still names in a Rust impl block (fail closed)", { skip: !HAVE_PY }, () => {
  const names = { "impl X": "X", "impl Trait for X": "Trait", "impl<T> X<T>": "X", "impl<T: Into<Vec<u8>>> Trait for X<T>": "Trait" };
  for (const [hn, h] of Object.entries(HEADS)) {
    const base = "use x;\n\n" + h + A + "}\n";
    const after = (c) => defsOf("a.rs", base, "use x;\n\n" + h + A + c + "}\n");
    const impl = [names[hn] + "@a.rs:3"];
    // a changed body of an existing method names that method
    assert.deepEqual(defsOf("a.rs", base, "use x;\n\n" + h + A.replace("        1", "        3") + "}\n").defs, ["a@a.rs:4"], hn);
    // a comment added inside an existing method body still names that method
    assert.deepEqual(defsOf("a.rs", base, "use x;\n\n" + h + A.replace("        1", "        // why\n        1") + "}\n").defs, ["a@a.rs:4"], hn);
    // an attribute on a new method may be a macro: it names the impl, a doc comment above it too
    assert.deepEqual(after("\n    #[tracing::instrument]\n    fn b(&self) -> i32 {\n        2\n    }\n").defs, impl, hn + ": #[attr]");
    assert.deepEqual(after("\n    /// b\n    #[tracing::instrument]\n    fn b(&self) -> i32 {\n        2\n    }\n").defs, impl, hn + ": doc + #[attr]");
    // an item line of the impl itself after a new multi-line method names the impl
    assert.deepEqual(after(NEW["a multi-line signature"] + "    const Z: i32 = sabotage();\n").defs, impl, hn + ": a const after the new method");
    // a comment with no definition after it is a changed line, as before
    assert.deepEqual(after("    // a note\n").defs, impl, hn + ": a lone comment");
  }
  // a line with code between block comments is no comment: an impl item line above a new method names the impl
  const base = "use x;\n\nimpl X {\n" + A + "}\n";
  assert.deepEqual(defsOf("a.rs", base, "use x;\n\nimpl X {\n" + A + "\n    /* a */ const Z: i32 = s(); /* b */\n    fn b(&self) -> i32 {\n        2\n    }\n}\n").defs, ["X@a.rs:3"]);
  // known limit: a generic header split over lines (where clause) is no definition; its new members stay unattributed
  const w = "impl<T> Trait<T> for X<T>\nwhere\n    T: Clone,\n{\n";
  assert.deepEqual(defsOf("a.rs", "use x;\n\n" + w + A + "}\n", "use x;\n\n" + w + A + NEW["a one-line signature"] + "}\n").unattributed, ["a.rs:9"]);
});

test("8.9.13 (#121): the same two fixes in Python: a black-style or commented new method records neither the class nor its neighbour", { skip: !HAVE_PY }, () => {
  const BASE = "class A:\n    def x(self):\n        return 1\n";
  assert.deepEqual(defsOf("k.py", BASE, BASE + "\n    def y(\n        self,\n    ) -> int:\n        return 2\n"), { defs: [], unattributed: [] });
  assert.deepEqual(defsOf("k.py", BASE, BASE + "\n    # y is two\n    def y(self):\n        return 2\n"), { defs: [], unattributed: [] });
  // a class-body statement after the new method's signature still names the class
  assert.deepEqual(defsOf("k.py", BASE, BASE + "\n    def y(\n        self,\n    ) -> int:\n        return 2\n    z = sabotage()\n").defs, ["A@k.py:1"]);
  // a comment above a decorated new method names the class, as the decorator does
  assert.deepEqual(defsOf("k.py", BASE, BASE + "\n    # y\n    @sabotage\n    def y(self):\n        return 2\n").defs, ["A@k.py:1"]);
  // a #! line is no comment: at column 0 it is module level, as before
  assert.deepEqual(defsOf("m.py", "def f():\n    return 1\n", "#!/x\ndef f():\n    return 1\n").unattributed, ["m.py:1"]);
});

test("8.9.13 (#121): in JS a line with code between block comments is no comment", { skip: !HAVE_PY }, () => {
  const F = "export function a() {\n  return 1;\n}\n";
  // at column 0 above a new function: module-level code, unattributed
  assert.deepEqual(defsOf("a.js", F, F + "/* a */ sabotage(); /* b */\nfunction f() {\n  return 2;\n}\n"), { defs: [], unattributed: ["a.js:3"] });
  // a class-field initializer above a new method names the class
  const C = "export class C {\n  a() {\n    return 1;\n  }\n}\n";
  assert.deepEqual(defsOf("c.js", C, "export class C {\n  a() {\n    return 1;\n  }\n\n  /* a */ x = sabotage(); /* b */\n  b() {\n    return 2;\n  }\n}\n").defs, ["C@c.js:1"]);
});

test("8.9.13 (#121): a column-0 comment always counts as a changed line (a coding cookie, a pragma, a doc comment)", { skip: !HAVE_PY }, () => {
  const P = "def f():\n    return 1\n";
  // a coding cookie above a new column-0 function is module level, as before
  assert.deepEqual(defsOf("m.py", P, "# -*- coding: latin-1 -*-\n" + P.replace("def f", "def g():\n    return 0\n\n\ndef f")).unattributed, ["m.py:1"]);
  assert.deepEqual(defsOf("m.py", P, P + "\n\n# pragma\ndef g():\n    return 2\n").unattributed, ["m.py:2"]);
  // a Rust doc comment at column 0 above a new column-0 item too
  assert.deepEqual(defsOf("a.rs", "fn a() {}\n", "fn a() {}\n\n/// b\nconst B: usize = 32;\n").unattributed, ["a.rs:1"]);
  // an indented comment that ends a container, then a new column-0 definition: the comment names the container
  const K = "class A:\n    def x(self):\n        return 1\n";
  assert.deepEqual(defsOf("k.py", K, K + "    # tail\n\n\ndef g():\n    return 2\n").defs, ["A@k.py:1"]);
});

test("8.9.13 (#121): the planner and plan-audit roles state the impl rule the program applies", () => {
  const plan = readFileSync(join(HERE, "..", "roles", "scope-and-plan.md"), "utf8");
  const audit = readFileSync(join(HERE, "..", "roles", "plan-audit.md"), "utf8");
  for (const k of [
    "A Rust `impl` block counts as the class, named by the first name after `impl` and its generics (the trait in `impl Trait for X`)",
    "A comment or doc comment above a new member and the closing line of its multi-line signature are part of that addition",
    "A `#[...]` attribute on a new Rust method is a decorator",
  ]) assert.ok(plan.includes(k), "scope-and-plan: " + k);
  assert.ok(
    audit.includes(
      "A plan step that adds a decorated method (`@...`, Rust `#[...]`) or a nested class to an existing class or `impl` block, or that changes a field or an item line directly in it, changes that class: the class (for `impl Trait for X`, the trait) missing from the map → `plan_defect`. A plain new method, with or without a doc comment, is an addition and needs no entry.",
    ),
    "plan-audit: the impl rule is a refusal",
  );
});
