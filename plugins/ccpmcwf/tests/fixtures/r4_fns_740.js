// fleet 7.4.0 (931e844) R4 functions, frozen for the 8.0.0 non-weakening tests (v800_r4_gaps). Do not edit.
const TEST_INPUTS = {
  pytest: ["pyproject.toml", "setup.py", "uv.lock", "poetry.lock", "Pipfile.lock"],
  npm: ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".npmrc"],
  jest: ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".npmrc"],
  cargo: ["Cargo.toml", "Cargo.lock", "build.rs", "config", "config.toml"],
  go: ["go.mod", "go.sum", "go.work"],
};
// 7.4.0 (#29 N4): the setup and config files jest and vitest load, by basename
const JEST_SETUP_RE = /^(jest|vitest)\.(setup|config)\.|^setupTests\.|\.setup\.[cm]?[jt]sx?$/;
// 7.4.0 (#29 N2): an entry "dir/" holds every path under it
function pathsHit(list, p) {
  return list.some((x) => x === p || (x.slice(-1) === "/" && p.indexOf(x) === 0));
}
// 7.4.0 (#29 N5): sh:<path> for a command that runs a repo script (its sourced files, read at a rev), else null
function shTargetOf(cmd) {
  const t = String(cmd || "").trim().split(/[ \t]+/);
  const s = /^(ba|da|k|z)?sh$/.test(t[0]) ? relPath(t[1]) : t[0].indexOf("/") >= 0 ? relPath(t[0]) : null;
  return s ? "sh:" + normPath(s) : null;
}
// npm:<script> for an npm, pnpm or yarn test_cmd, else null
function npmTargetOf(cmd) {
  const t = String(cmd || "").trim().split(/[ \t]+/);
  if ((t[0] === "npm" || t[0] === "pnpm" || t[0] === "yarn") && t[1] === "test") return "npm:test";
  if (t[0] === "npm" && t[1] === "run" && t[2]) return "npm:" + t[2];
  return null;
}
// does test_cmd run the file p; a shape this cannot read runs every file (fail closed)
function testCmdRuns(cmd, p, makePaths) {
  const t = String(cmd || "").trim().split(/[ \t]+/).filter((x) => x && x !== PATHS_TOKEN);
  if (!t.length) return true;
  const b = p.split("/").pop();
  const script = (x) => (x && x.charAt(0) !== "-" && relPath(x) ? normPath(relPath(x)) === p : true);
  // a shell script: also the files it sources (no sh: entry: every file)
  const sp = makePaths ? makePaths[shTargetOf(t.join(" "))] : null;
  const shell = (x) => script(x) || !Array.isArray(sp) || pathsHit(sp, p);
  if (/^(ba|da|k|z)?sh$/.test(t[0])) return shell(t[1]);
  if ((t[0] === "python" || t[0] === "python3") && t[1] !== "-m") return script(t[1]);
  if (t[0].indexOf("/") >= 0) return shell(t[0]);
  const pre = testRunnerPrefix(t);
  if (!pre) return true;
  if (pre.kind === "make") return cmdRuns("make " + t[1], p, makePaths, true);
  // npm/pnpm/yarn: the manifest and lock files, and the repo paths scripts.<name> names at d (unread: every file)
  if (pre.kind === "npm") {
    const np = makePaths ? makePaths[npmTargetOf(t.join(" "))] : null;
    if (!Array.isArray(np)) return true;
    return TEST_INPUTS.npm.indexOf(b) >= 0 || pathsHit(np, p);
  }
  if (pre.kind === "jest" && JEST_SETUP_RE.test(b)) return true;
  if (pre.kind === "cargo" && (b === "config" || b === "config.toml")) return p.split("/").slice(-2, -1)[0] === ".cargo";
  return !TEST_INPUTS[pre.kind] || TEST_INPUTS[pre.kind].indexOf(b) >= 0;
}
// does the command cmd run the file p (its script, a Makefile, .mk file or make recipe, the pre-commit config)
// 7.4.0 (#29): r4 (the update-branch refusal) also reads "dir/" entries and a shell script's sh: entry
// (none: every file); the obligations gate keeps exact paths
function cmdRuns(cmd, p, makePaths, r4) {
  const words = cmd.trim().split(/[ \t]+/);
  const script = parseCheckCmd(cmd).script || null;
  const b = p.split("/").pop();
  const recipe = words[0] === "make" && makePaths && Array.isArray(makePaths[words[1]]) ? makePaths[words[1]] : [];
  const st = r4 ? shTargetOf(cmd) : null;
  return !!(
    (script && p === normPath(script)) ||
    (st && (!makePaths || !Array.isArray(makePaths[st]) || pathsHit(makePaths[st], p))) ||
    (words[0] === "make" && (/^(GNUmakefile|makefile|Makefile)$/.test(b) || /\.mk$/.test(b) || (r4 ? pathsHit(recipe, p) : recipe.indexOf(p) >= 0))) ||
    (words[0] === "pre-commit" && b === ".pre-commit-config.yaml")
  );
}
