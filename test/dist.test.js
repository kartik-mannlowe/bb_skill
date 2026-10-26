"use strict";
// check-dist verifies dist/ against its own manifest (content, executable bit, missing and extra entries) and never writes.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { main, verifyDist } = require("../scripts/check-dist");

const FILES = [
  ["skill/SKILL.md", "# skill\n", 0o644],
  ["skill/scripts/bb.py", "print('bb')\n", 0o755],
  ["skill/scripts/bbclient/api.py", "API = 1\n", 0o644],
  ["adapters/claude-code/bb.md", "claude\n", 0o644],
];

function fixture() {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "bbnpx-dist-"));
  for (const [rel, text, mode] of FILES) {
    fs.mkdirSync(path.dirname(path.join(dist, rel)), { recursive: true });
    fs.writeFileSync(path.join(dist, rel), text);
    fs.chmodSync(path.join(dist, rel), mode);
  }
  const files = FILES.map(([rel, text, mode]) => ({ path: rel, sha256: crypto.createHash("sha256").update(text).digest("hex"), mode: mode.toString(8) }));
  fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify({ files }));
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

test("the shipped dist/ matches its manifest", () => {
  assert.deepStrictEqual(verifyDist(), []);
});

test("a checkout made under a different umask passes (only the executable bit is compared)", () => {
  const f = fixture();
  try {
    fs.chmodSync(path.join(f.dist, "skill/SKILL.md"), 0o664);
    fs.chmodSync(path.join(f.dist, "skill/scripts/bb.py"), 0o775);
    assert.strictEqual(f.run(), 0, f.out.error.join("\n"));
  } finally { f.cleanup(); }
});

test("a consistent dist/ passes", () => {
  const f = fixture();
  try {
    assert.strictEqual(f.run(), 0, f.out.error.join("\n"));
    assert.match(f.out.log.at(-1), /matches dist\/manifest\.json \(4 files\)/);
  } finally { f.cleanup(); }
});

const BREAKS = {
  "a hand-edited packaged file": (d) => fs.appendFileSync(path.join(d, "skill/SKILL.md"), "manual edit\n"),
  "a missing packaged file": (d) => fs.rmSync(path.join(d, "adapters/claude-code/bb.md")),
  "a changed file mode": (d) => fs.chmodSync(path.join(d, "skill/scripts/bb.py"), 0o644),
  "an unexpected file": (d) => fs.writeFileSync(path.join(d, "skill/stray.md"), "x"),
  "an unexpected directory": (d) => fs.mkdirSync(path.join(d, "skill/scripts/bbclient/__pycache__")),
  "a symlink in place of a packaged file": (d) => {
    const p = path.join(d, "adapters/claude-code/bb.md");
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
};

for (const [what, breakIt] of Object.entries(BREAKS)) {
  test(`check-dist detects ${what} and changes nothing`, () => {
    const f = fixture();
    try {
      breakIt(f.dist);
      const before = snapshot(f.dist);
      assert.strictEqual(f.run(), 1, `${what} was not detected`);
      assert.match(f.out.error.join("\n"), /does not match dist\/manifest\.json/);
      assert.strictEqual(snapshot(f.dist), before, "check-dist must not write");
    } finally { f.cleanup(); }
  });
}

test("check-dist names each problem", () => {
  const f = fixture();
  try {
    fs.appendFileSync(path.join(f.dist, "skill/SKILL.md"), "edit\n");
    fs.rmSync(path.join(f.dist, "adapters/claude-code/bb.md"));
    fs.chmodSync(path.join(f.dist, "skill/scripts/bb.py"), 0o644);
    fs.writeFileSync(path.join(f.dist, "skill/stray.md"), "x");
    f.run();
    const text = f.out.error.join("\n");
    assert.match(text, /skill\/SKILL\.md differs from its manifest entry/);
    assert.match(text, /missing adapters\/claude-code\/bb\.md/);
    assert.match(text, /skill\/scripts\/bb\.py has mode 644, expected 755/);
    assert.match(text, /unexpected file skill\/stray\.md/);
  } finally { f.cleanup(); }
});
