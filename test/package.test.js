"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const pkg = require("../package.json");

test("package metadata: bin, engines, allowlist, no dependencies, not publishable by accident", () => {
  assert.deepStrictEqual(pkg.bin, { "brewboard-skill": "bin/brewboard-skill.js" });
  assert.deepStrictEqual(pkg.files, ["bin/", "lib/", "dist/"]);
  assert.deepStrictEqual(pkg.dependencies, {});
  assert.strictEqual(pkg.private, true);
  assert.ok(pkg.engines.node);
});

test("npm pack contains only the allowlist and nothing secret", () => {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: ROOT, encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
  const files = JSON.parse(r.stdout)[0].files.map((f) => f.path);
  for (const f of files) {
    assert.match(f, /^(bin\/|lib\/|dist\/|package\.json$|README\.md$)/, f);
    assert.doesNotMatch(f, /\.env|config\.json|state\.json|db\.json|backup|__pycache__|\.venv|mock|test/i, f);
  }
  assert.ok(files.includes("dist/skill/scripts/bb.py"));
  assert.ok(files.includes("dist/adapters/claude-code/bb.md"));
});

test("running the packaged bb.py leaves no bytecode in the package", async () => {
  const { authCheck } = require("../lib/check");
  const { resolvePaths } = require("../lib/paths");
  const os = require("os");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bbnpx-pyc-"));
  try {
    const paths = resolvePaths({ HOME: home });
    await authCheck({ paths: { ...paths, bbPy: path.join(ROOT, "dist/skill/scripts/bb.py") }, env: { ...process.env, HOME: home } });
    const pyc = spawnSync("find", [path.join(ROOT, "dist"), "-name", "__pycache__"], { encoding: "utf8" }).stdout.trim();
    assert.strictEqual(pyc, "");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("nothing in the shipped code passes a password through argv, env or URLs", () => {
  for (const f of fs.readdirSync(path.join(ROOT, "lib"))) {
    const src = fs.readFileSync(path.join(ROOT, "lib", f), "utf8");
    assert.doesNotMatch(src, /--password|PASSWORD=|env\.\w*PASS|\?pwd=/i, f);
    assert.doesNotMatch(src, /\beval\(|shell:\s*true|execSync\(/, f);
  }
});
