"use strict";
// check-dist verifies dist/ against its manifest (content, executable bit, missing and extra entries) and that
// the generated files (OpenCode commands, manifest) are what `npm run build` makes; it never writes.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { main, verifyDist, verifyGenerated } = require("../scripts/check-dist");
const { build, toOpencode } = require("../scripts/build-dist");

const CLAUDE_BB = "---\ndescription: d\nargument-hint: \"[x]\"\n---\nDo NOT use AskUserQuestion to pick a record.\n";
const FILES = [
  ["skill/SKILL.md", "# skill\n"],
  ["skill/scripts/bb.py", "print('bb')\n"],
  ["skill/scripts/bbclient/api.py", "API = 1\n"],
  ["adapters/claude-code/bb.md", CLAUDE_BB],
];

// A small dist/ made consistent by the real build step.
function fixture() {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "bbnpx-dist-"));
  for (const [rel, text] of FILES) {
    fs.mkdirSync(path.dirname(path.join(dist, rel)), { recursive: true });
    fs.writeFileSync(path.join(dist, rel), text);
  }
  build(dist, () => {});
  const out = { log: [], error: [] };
  const run = () => main({ dist, log: (s) => out.log.push(s), error: (s) => out.error.push(s) });
  return { dist, out, run, cleanup: () => fs.rmSync(dist, { recursive: true, force: true }) };
}

// Every entry, its mode and content: proves the check changed nothing.
function snapshot(dir) {
  const rows = [];
  const visit = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      rows.push([path.relative(dir, full), fs.lstatSync(full).mode, e.isFile() ? fs.readFileSync(full, "hex") : null]);
      if (e.isDirectory()) visit(full);
    }
  };
  visit(dir);
  return JSON.stringify(rows);
}

test("the shipped dist/ matches its manifest and its generated files are current", () => {
  assert.deepStrictEqual(verifyDist(), []);
  assert.deepStrictEqual(verifyGenerated(), []);
});

test("the build reads only this repository: the OpenCode commands are generated from the Claude Code ones", () => {
  const out = toOpencode(CLAUDE_BB);
  assert.doesNotMatch(out, /argument-hint|AskUserQuestion/);
  assert.match(out, /Do NOT use a question tool to pick a record\./);
  assert.throws(() => toOpencode("Call AskUserQuestion now."), /no OpenCode rule/);
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "build-dist.js"), "utf8");
  assert.doesNotMatch(src, /homedir|Documents|Workspace|bb-connector|BB_CONNECTOR/);
});

test("a consistent dist/ passes, and the build marks only bb.py executable", () => {
  const f = fixture();
  try {
    assert.strictEqual(f.run(), 0, f.out.error.join("\n"));
    assert.match(f.out.log.at(-1), /generated files are current \(5 files\)/);
    const m = JSON.parse(fs.readFileSync(path.join(f.dist, "manifest.json"), "utf8"));
    assert.deepStrictEqual(m.files.map((x) => [x.path, x.mode]), [
      ["skill/SKILL.md", "644"], ["skill/scripts/bb.py", "755"], ["skill/scripts/bbclient/api.py", "644"],
      ["adapters/claude-code/bb.md", "644"], ["adapters/opencode/bb.md", "644"]]);
    assert.doesNotMatch(m.source, /connector/);
  } finally { f.cleanup(); }
});

test("a checkout made under a different umask passes (only the executable bit is compared)", () => {
  const f = fixture();
  try {
    fs.chmodSync(path.join(f.dist, "skill/SKILL.md"), 0o664);
    fs.chmodSync(path.join(f.dist, "skill/scripts/bb.py"), 0o775);
    assert.strictEqual(f.run(), 0, f.out.error.join("\n"));
  } finally { f.cleanup(); }
});

const BREAKS = {
  "a hand-edited packaged file": (d) => fs.appendFileSync(path.join(d, "skill/SKILL.md"), "manual edit\n"),
  "a missing packaged file": (d) => fs.rmSync(path.join(d, "skill/scripts/bbclient/api.py")),
  "a changed file mode": (d) => fs.chmodSync(path.join(d, "skill/scripts/bb.py"), 0o644),
  "an unexpected file": (d) => fs.writeFileSync(path.join(d, "skill/stray.md"), "x"),
  "an unexpected directory": (d) => fs.mkdirSync(path.join(d, "skill/scripts/bbclient/__pycache__")),
  "a symlink in place of a packaged file": (d) => {
    const p = path.join(d, "skill/SKILL.md");
    fs.renameSync(p, `${p}.real`);
    fs.symlinkSync(`${p}.real`, p);
  },
  "a missing manifest": (d) => fs.rmSync(path.join(d, "manifest.json")),
  "an edited manifest hash": (d) => {
    const p = path.join(d, "manifest.json");
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    m.files[0].sha256 = "0".repeat(64);
    fs.writeFileSync(p, JSON.stringify(m));
  },
  "a manifest path that escapes dist/": (d) => {
    const p = path.join(d, "manifest.json");
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    m.files.push({ path: "../package.json", sha256: "0".repeat(64), mode: "644" });
    fs.writeFileSync(p, JSON.stringify(m));
  },
  "a Claude Code command edited without rebuilding": (d) => fs.appendFileSync(path.join(d, "adapters/claude-code/bb.md"), "more\n"),
  "a hand-edited generated OpenCode command": (d) => fs.appendFileSync(path.join(d, "adapters/opencode/bb.md"), "x\n"),
  "a missing generated OpenCode command": (d) => fs.rmSync(path.join(d, "adapters/opencode/bb.md")),
  "an OpenCode command without a Claude Code source": (d) => fs.writeFileSync(path.join(d, "adapters/opencode/bb-x.md"), "x"),
};

for (const [what, breakIt] of Object.entries(BREAKS)) {
  test(`check-dist detects ${what} and changes nothing`, () => {
    const f = fixture();
    try {
      breakIt(f.dist);
      const before = snapshot(f.dist);
      assert.strictEqual(f.run(), 1, `${what} was not detected`);
      assert.match(f.out.error.join("\n"), /dist\/ is not consistent/);
      assert.strictEqual(snapshot(f.dist), before, "check-dist must not write");
    } finally { f.cleanup(); }
  });
}

test("check-dist names each problem", () => {
  const f = fixture();
  try {
    fs.appendFileSync(path.join(f.dist, "skill/SKILL.md"), "edit\n");
    fs.rmSync(path.join(f.dist, "adapters/opencode/bb.md"));
    fs.chmodSync(path.join(f.dist, "skill/scripts/bb.py"), 0o644);
    fs.writeFileSync(path.join(f.dist, "skill/stray.md"), "x");
    f.run();
    const text = f.out.error.join("\n");
    assert.match(text, /skill\/SKILL\.md differs from its manifest entry/);
    assert.match(text, /missing adapters\/opencode\/bb\.md/);
    assert.match(text, /adapters\/opencode\/bb\.md is missing \(generated from adapters\/claude-code\/bb\.md\)/);
    assert.match(text, /skill\/scripts\/bb\.py has mode 644, expected 755/);
    assert.match(text, /unexpected file skill\/stray\.md/);
    assert.match(text, /manifest\.json is out of date/);
  } finally { f.cleanup(); }
});

test("build refuses to package bytecode, local config or secrets", () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.dist, "skill/scripts/bbclient/__pycache__"));
    fs.writeFileSync(path.join(f.dist, "skill/scripts/bbclient/__pycache__/api.cpython-312.pyc"), "x");
    assert.throws(() => build(f.dist, () => {}), /not allowed in dist\//);
    fs.rmSync(path.join(f.dist, "skill/scripts/bbclient/__pycache__"), { recursive: true });
    fs.writeFileSync(path.join(f.dist, "skill/config.json"), "{}");
    assert.throws(() => build(f.dist, () => {}), /skill\/config\.json/);
  } finally { f.cleanup(); }
});

test("build refuses a symlink instead of writing it into the manifest", () => {
  const f = fixture();
  try {
    fs.symlinkSync("../SKILL.md", path.join(f.dist, "skill/scripts/link.md"));
    const before = fs.readFileSync(path.join(f.dist, "manifest.json"), "utf8");
    assert.throws(() => build(f.dist, () => {}), /skill\/scripts\/link\.md is not a regular file/);
    assert.strictEqual(fs.readFileSync(path.join(f.dist, "manifest.json"), "utf8"), before, "manifest untouched");
  } finally { f.cleanup(); }
});

test("build then check-dist round-trips: a rebuilt dist/ is consistent again", () => {
  const f = fixture();
  try {
    fs.appendFileSync(path.join(f.dist, "adapters/claude-code/bb.md"), "Use AskUserQuestion or any native selector.\n");
    assert.strictEqual(f.run(), 1);
    build(f.dist, () => {});
    assert.strictEqual(f.run(), 0, f.out.error.join("\n"));
    assert.match(fs.readFileSync(path.join(f.dist, "adapters/opencode/bb.md"), "utf8"), /a question tool or any native selector/);
  } finally { f.cleanup(); }
});
