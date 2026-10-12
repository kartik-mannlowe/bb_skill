#!/usr/bin/env node
// Maintainer tool (not shipped): copies the distributable Brewboard skill from the canonical
// connector into dist/ and writes dist/manifest.json (sha256 + mode of every file).
//
//   npm run sync                 copy from the connector (default path below, or BB_CONNECTOR_SRC)
//   npm run check-sync           exit 1 if dist/ differs from the connector (drift check)
//
// Only the allowlist below is copied: the skill (SKILL.md, reference/, scripts/bb.py, bbclient/*.py)
// and the agent adapters (Claude Code and OpenCode commands, the shared Agent Skill pointer). Mock API, tests, backups, packages and docs stay out.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const SRC = process.env.BB_CONNECTOR_SRC ||
  path.join(os.homedir(), "Documents/Workspace/brewboard_skill/files/bb-connector");
const DIST = path.join(__dirname, "..", "dist");
const ALLOW = [
  { from: "skill/brewboard", to: "skill", include: (rel) => rel === "SKILL.md" || /^reference\/[\w.-]+\.md$/.test(rel) ||
      rel === "scripts/bb.py" || /^scripts\/bbclient\/[\w]+\.py$/.test(rel) },
  { from: "adapters/claude-code", to: "adapters/claude-code", include: (rel) => /^bb[\w-]*\.md$/.test(rel) },
  // Generated in the connector from the Claude Code adapters (sync-copies.sh): OpenCode commands.
  { from: "adapters/opencode", to: "adapters/opencode", include: (rel) => /^bb[\w-]*\.md$/.test(rel) },
  // The Agent Skill pointer (name: bb), used for Codex, OpenCode (~/.agents/skills) and Antigravity.
  { from: "adapters/antigravity", to: "adapters/agent-skill", include: (rel) => rel === "bb.md" },
];
const FORBIDDEN = /(^|\/)(\.env|config\.json|state\.json|db\.json|.*\.(tgz|pem|key|sqlite))$|__pycache__|\.venv/;

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  });
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function plan() {
  const files = [];
  for (const rule of ALLOW) {
    const root = path.join(SRC, rule.from);
    if (!fs.existsSync(root)) throw new Error(`connector path missing: ${root}`);
    for (const rel of walk(root).filter(rule.include).sort()) {
      const target = `${rule.to}/${rel}`;
      if (FORBIDDEN.test(target)) throw new Error(`refusing to package ${target}`);
      const content = fs.readFileSync(path.join(root, rel));
      files.push({ path: target, sha256: sha(content), mode: rel === "scripts/bb.py" ? 0o755 : 0o644, content });
    }
  }
  return files;
}

function main() {
  const files = plan();
  const manifest = { source: "brewboard_skill/files/bb-connector (canonical connector)",
                     files: files.map(({ path: p, sha256, mode }) => ({ path: p, sha256, mode: mode.toString(8) })) };
  if (process.argv.includes("--check")) {
    const current = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8"));
    const a = JSON.stringify(current.files), b = JSON.stringify(manifest.files);
    if (a !== b) {
      console.error("dist/ is out of date with the connector: run `npm run sync`.");
      process.exit(1);
    }
    console.log(`dist/ matches the connector (${files.length} files).`);
    return;
  }
  fs.rmSync(DIST, { recursive: true, force: true });
  for (const f of files) {
    const out = path.join(DIST, f.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, f.content, { mode: f.mode });
    fs.chmodSync(out, f.mode);
  }
  fs.writeFileSync(path.join(DIST, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Synced ${files.length} files from ${SRC} into dist/.`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
module.exports = { plan, SRC };
