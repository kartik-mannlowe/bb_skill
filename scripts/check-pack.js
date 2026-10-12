#!/usr/bin/env node
// Maintainer tool: lists what `npm pack` would publish and fails on anything outside the allowlist
// or anything that looks like a secret, local config, backup, cache or mock data.
"use strict";
const { spawnSync } = require("child_process");
const path = require("path");

const r = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
const files = JSON.parse(r.stdout)[0].files.map((f) => f.path).sort();
const bad = files.filter((f) => !/^(bin\/|lib\/|dist\/|README\.md$|package\.json$)/.test(f) ||
  /\.env|config\.json|state\.json|db\.json|backup|__pycache__|\.venv|mock|\.pem$|\.key$/i.test(f));
files.forEach((f) => console.log(`  ${f}`));
if (bad.length) { console.error(`\nNot allowed in the package:\n  ${bad.join("\n  ")}`); process.exit(1); }
console.log(`\n${files.length} files, all allowlisted.`);
