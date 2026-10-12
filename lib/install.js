"use strict";
// Installs dist/ for the core skill and each detected agent.
// - Idempotent: unchanged files are left alone; changed or removed ones are first copied to
//   ~/.bb/backups/install-<timestamp>/.
// - Ownership: every file written is recorded in ~/.bb/installed.json (path, sha256, agents), so
//   uninstall and later updates remove only Brewboard's own, unmodified files.
// - Isolation: a failure for one agent is reported and does not stop the others; a failure of
//   the core skill stops the install.
// - Never touches config.json, state.json, or files Brewboard did not create.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { writable, isBrewboardFile } = require("./agents");

const KEEP_BACKUPS = 10;
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const ownedFile = (paths) => path.join(paths.bbHome, "installed.json");

function readManifest(distDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(distDir, "manifest.json"), "utf8"));
  for (const f of manifest.files) {
    if (sha(fs.readFileSync(path.join(distDir, f.path))) !== f.sha256) {
      throw new Error(`packaged file ${f.path} does not match its manifest entry`);
    }
  }
  return manifest;
}

function readOwned(paths) {
  try { return JSON.parse(fs.readFileSync(ownedFile(paths), "utf8")); } catch { return { files: {} }; }
}

function atomicWrite(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

function removeEmptyParents(file, stopAt) {
  let dir = path.dirname(file);
  while (dir.startsWith(stopAt) && dir !== stopAt) {
    try { fs.rmdirSync(dir); } catch { return; } // not empty, or gone
    dir = path.dirname(dir);
  }
}

function install(paths, { agents = [], now = new Date(), version = "0" } = {}) {
  const manifest = readManifest(paths.distDir);
  const byPath = new Map(manifest.files.map((f) => [f.path, f]));
  const owned = readOwned(paths);
  const newOwned = {};
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backupRoot = path.join(paths.backupsDir, `install-${stamp}`);
  const summary = { core: null, agents: {}, backupDir: null };

  const backup = (file) => {
    const rel = path.relative(paths.home, file);
    const dest = path.join(backupRoot, rel.startsWith("..") ? path.basename(file) : rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.copyFileSync(file, dest);
    summary.backupDir = backupRoot;
  };
  const written = new Set(); // a shared target (the Agent Skill) is written once per run

  const place = (from, to, agentId, res) => {
    const f = byPath.get(from);
    if (!f) throw new Error(`missing packaged file ${from}`);
    (newOwned[to] = newOwned[to] || { sha256: f.sha256, agents: [] }).agents.push(agentId);
    if (written.has(to)) { res.shared.push(to); return; } // already placed for another agent this run
    written.add(to);
    const mode = parseInt(f.mode, 8);
    const content = fs.readFileSync(path.join(paths.distDir, from));
    if (fs.existsSync(to)) {
      if (sha(fs.readFileSync(to)) === f.sha256) {
        if ((fs.statSync(to).mode & 0o777) !== mode) fs.chmodSync(to, mode);
        res.unchanged.push(to);
        return;
      }
      backup(to);
      atomicWrite(to, content, mode);
      res.updated.push(to);
      return;
    }
    atomicWrite(to, content, mode);
    res.created.push(to);
  };
  const fresh = () => ({ status: null, created: [], updated: [], unchanged: [], shared: [], removed: [], error: null });

  // Core skill: everything below ~/.bb/skill is Brewboard's.
  fs.mkdirSync(paths.bbHome, { recursive: true, mode: 0o700 });
  const core = fresh();
  const coreTargets = manifest.files.filter((f) => f.path.startsWith("skill/"))
    .map((f) => ({ from: f.path, to: path.join(paths.skillDir, f.path.slice("skill/".length)) }));
  for (const t of coreTargets) place(t.from, t.to, "core", core);
  const wanted = new Set(coreTargets.map((t) => t.to));
  for (const file of walk(paths.skillDir)) {
    if (wanted.has(file)) continue;
    if (!file.includes(`${path.sep}__pycache__${path.sep}`)) { backup(file); core.removed.push(file); }
    fs.rmSync(file, { force: true });
  }
  core.status = statusOf(core);
  summary.core = core;

  const dist = manifest.files.map((f) => f.path);
  for (const agent of agents) {
    const res = fresh();
    summary.agents[agent.id] = res;
    try {
      const targets = agent.targets(agent.ap, dist);
      const blocked = targets.filter((t) => !written.has(t.to) && !writable(t.to)).map((t) => path.dirname(t.to));
      if (blocked.length) throw new Error(`no write access to ${[...new Set(blocked)].join(", ")}`);
      for (const t of targets) place(t.from, t.to, agent.id, res);
      // Files this agent got from an earlier version but no longer ships (only if unmodified).
      for (const [file, info] of Object.entries(owned.files || {})) {
        if (!(info.agents || []).includes(agent.id) || newOwned[file] || !fs.existsSync(file)) continue;
        if (sha(fs.readFileSync(file)) === info.sha256) { backup(file); fs.rmSync(file); res.removed.push(file); }
      }
      // Copies left by older manual installs at paths the agent does not (or should not) read.
      for (const file of agent.legacy(agent.ap)) {
        if (!newOwned[file] && fs.existsSync(file) && isBrewboardFile(file)) {
          backup(file); fs.rmSync(file); res.removed.push(file);
          removeEmptyParents(file, paths.home);
        }
      }
      res.status = statusOf(res);
    } catch (e) {
      res.status = "failed";
      res.error = e.message;
    }
  }

  // Keep ownership records of agents skipped this time, so a later uninstall still finds their files.
  for (const [file, info] of Object.entries(owned.files || {})) {
    const ids = info.agents || [];
    if (!newOwned[file] && fs.existsSync(file) && !ids.includes("core") && !ids.some((id) => summary.agents[id])) {
      newOwned[file] = info;
    }
  }
  atomicWrite(ownedFile(paths), JSON.stringify({ version, updated: now.toISOString(), files: newOwned }, null, 2) + "\n", 0o644);
  pruneBackups(paths.backupsDir);
  summary.validation = validate(newOwned);
  return summary;
}

function statusOf(r) {
  if (r.created.length && !r.updated.length && !r.unchanged.length && !r.removed.length) return "installed";
  if (r.created.length || r.updated.length || r.removed.length) return "updated";
  return "unchanged";
}

function validate(ownedFiles) {
  const bad = Object.entries(ownedFiles).filter(([file, info]) =>
    !fs.existsSync(file) || sha(fs.readFileSync(file)) !== info.sha256).map(([file]) => file);
  return { ok: bad.length === 0, mismatched: bad, files: Object.keys(ownedFiles).length };
}

function pruneBackups(dir) {
  if (!fs.existsSync(dir)) return;
  const runs = fs.readdirSync(dir).filter((n) => n.startsWith("install-")).sort();
  for (const old of runs.slice(0, Math.max(0, runs.length - KEEP_BACKUPS))) {
    fs.rmSync(path.join(dir, old), { recursive: true, force: true });
  }
}

// Removes ~/.bb/skill and the files recorded in installed.json that are still unmodified.
// A recorded file the user has edited is kept and reported.
function uninstall(paths) {
  const owned = readOwned(paths);
  const removed = [], keptModified = [];
  for (const [file, info] of Object.entries(owned.files || {})) {
    if (file.startsWith(paths.skillDir + path.sep) || !fs.existsSync(file)) continue;
    if (sha(fs.readFileSync(file)) === info.sha256) {
      fs.rmSync(file); removed.push(file);
      removeEmptyParents(file, paths.home);
    } else keptModified.push(file);
  }
  if (fs.existsSync(paths.skillDir)) { fs.rmSync(paths.skillDir, { recursive: true, force: true }); removed.push(paths.skillDir); }
  fs.rmSync(ownedFile(paths), { force: true });
  const kept = [paths.configFile, path.join(paths.bbHome, "state.json")].filter((p) => fs.existsSync(p));
  return { removed, keptModified, kept };
}

function installedAgents(paths) {
  const ids = new Set();
  for (const info of Object.values(readOwned(paths).files || {})) (info.agents || []).forEach((a) => ids.add(a));
  ids.delete("core");
  return [...ids];
}

module.exports = { install, uninstall, validate, readManifest, readOwned, installedAgents, atomicWrite };
