#!/usr/bin/env node
// Maintainer tool: lists what `npm pack` would publish and fails on anything outside the allowlist
// or anything that looks like a secret, local config, backup, cache or mock data.
// README.md is allowed because npm always packs it; the installer copies only what dist/manifest.json lists.
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const r = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
const files = JSON.parse(r.stdout)[0].files.map((f) => f.path).sort();
const bad = files.filter((f) => !/^(bin\/|lib\/|dist\/|package\.json$|README\.md$)/.test(f) ||
  /\.env|config\.json|state\.json|db\.json|backup|__pycache__|\.venv|mock|\.pem$|\.key$/i.test(f));
// dist/ ships exactly the files dist/manifest.json lists (plus the manifest itself); `npm run check-dist` verifies their content.
const listed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "dist", "manifest.json"), "utf8")).files
  .map((f) => `dist/${f.path}`);
bad.push(...files.filter((f) => f.startsWith("dist/") && f !== "dist/manifest.json" && !listed.includes(f))
  .map((f) => `${f} (not in dist/manifest.json)`));
bad.push(...listed.filter((f) => !files.includes(f)).map((f) => `${f} (in dist/manifest.json but not packed)`));
files.forEach((f) => console.log(`  ${f}`));
if (bad.length) { console.error(`\nNot allowed in the package:\n  ${bad.join("\n  ")}`); process.exit(1); }
console.log(`\n${files.length} files, all allowlisted.`);
