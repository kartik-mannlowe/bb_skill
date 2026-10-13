"use strict";
// Installs dist/ for the core skill and each detected agent, recording ownership in
// ~/.bb/installed.json (see tracking.js) so updates and uninstall touch only Brewboard's files.
// - A file that existed before Brewboard first wrote it is kept in ~/.bb/backups/originals/ and
//   restored by uninstall. A Brewboard file replaced by an update goes to ~/.bb/backups/install-<ts>/.
// - Old Brewboard copies at paths an agent should not read are moved to ~/.bb/backups/originals/.
// - Directories are created one level at a time and recorded, so uninstall removes only those.
// - Idempotent; a failure for one agent does not stop the others; config.json and state.json are
//   never touched here.
const fs = require("fs");
const path = require("path");
const { writable, isBrewboardFile } = require("./agents");
const tracking = require("./tracking");

const KEEP_BACKUPS = 10;
const { sha } = tracking;

function readManifest(distDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(distDir, "manifest.json"), "utf8"));
  for (const f of manifest.files) {
    if (sha(fs.readFileSync(path.join(distDir, f.path))) !== f.sha256) {
      throw new Error(`packaged file ${f.path} does not match its manifest entry`);
    }
  }
  return manifest;
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

function install(paths, { agents = [], now = new Date(), version = "0" } = {}) {
  const manifest = readManifest(paths.distDir);
  const byPath = new Map(manifest.files.map((f) => [f.path, f]));
  const t = tracking.loadForUpdate(paths);
  const previous = t.files;
  const files = {};
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(paths.backupsDir, `install-${stamp}`);
  const summary = { core: null, agents: {}, backupDir: null };

  tracking.ensureDir(t, paths.bbHome, 0o700);
  const writeFile = (file, content, mode) => {
    tracking.ensureDir(t, path.dirname(file));
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  };
  const copyTo = (file, dest) => {
    tracking.ensureDir(t, path.dirname(dest), 0o700);
    fs.copyFileSync(file, dest);
    return dest;
  };
  const runBackup = (file) => { // a Brewboard file being replaced or dropped by an update
    const rel = path.relative(paths.home, file);
    copyTo(file, path.join(runDir, rel.startsWith("..") ? path.basename(file) : rel));
    summary.backupDir = runDir;
  };
  const keepOriginal = (file) => { // a file that was there before Brewboard
    const dest = tracking.originalPathFor(paths, file);
    if (!fs.existsSync(dest)) copyTo(file, dest);
    return dest;
  };

  const written = new Set();
  const place = (from, to, agentId, res) => {
    const f = byPath.get(from);
    if (!f) throw new Error(`missing packaged file ${from}`);
    const prev = previous[to];
    const rec = files[to] || (files[to] = { sha256: f.sha256, agents: [], mode: f.mode,
                                            created: prev ? prev.created : null, original: prev ? prev.original : null });
    rec.agents.push(agentId);
    if (written.has(to)) { res.shared.push(to); return; }
    written.add(to);
    const mode = parseInt(f.mode, 8);
    const content = fs.readFileSync(path.join(paths.distDir, from));
    if (fs.existsSync(to)) {
      if (sha(fs.readFileSync(to)) === f.sha256) {
        if ((fs.statSync(to).mode & 0o777) !== mode) fs.chmodSync(to, mode);
        if (rec.created === null && !prev) rec.created = false; // identical file already there (not ours)
        res.unchanged.push(to);
        return;
      }
      if (prev) runBackup(to); // our earlier version (or the user's edit of it)
      else { rec.original = keepOriginal(to); rec.created = false; } // someone else's file: keep to restore
      writeFile(to, content, mode);
      res.updated.push(to);
      return;
    }
    if (rec.created === null) rec.created = !prev || prev.created !== false;
    writeFile(to, content, mode);
    res.created.push(to);
  };
  const fresh = () => ({ status: null, created: [], updated: [], unchanged: [], shared: [], removed: [], error: null });

  // Drop a file this install no longer ships: back it up, then put back what was there before Brewboard.
  const retire = (file, info, res) => {
    if (!fs.existsSync(file)) return;
    if (sha(fs.readFileSync(file)) !== info.sha256) { files[file] = info; return; } // edited: keep tracking it
    runBackup(file);
    fs.rmSync(file);
    res.removed.push(file);
    if (info.original && fs.existsSync(info.original)) fs.renameSync(info.original, file);
  };

  // Core skill: everything below ~/.bb/skill is Brewboard's.
  const core = fresh();
  const coreTargets = manifest.files.filter((f) => f.path.startsWith("skill/"))
    .map((f) => ({ from: f.path, to: path.join(paths.skillDir, f.path.slice("skill/".length)) }));
  for (const tg of coreTargets) place(tg.from, tg.to, "core", core);
  const wanted = new Set(coreTargets.map((tg) => tg.to));
  for (const file of walk(paths.skillDir)) {
    if (wanted.has(file)) continue;
    if (!file.includes(`${path.sep}__pycache__${path.sep}`)) { runBackup(file); core.removed.push(file); }
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
      const blocked = targets.filter((tg) => !written.has(tg.to) && !writable(tg.to)).map((tg) => path.dirname(tg.to));
      if (blocked.length) throw new Error(`no write access to ${[...new Set(blocked)].join(", ")}`);
      for (const tg of targets) place(tg.from, tg.to, agent.id, res);
      for (const [file, info] of Object.entries(previous)) {
        if ((info.agents || []).includes(agent.id) && !files[file] && !wanted.has(file)) retire(file, info, res);
      }
      // Old Brewboard copies at paths the agent does not (or should not) read: moved aside, restorable.
      for (const file of agent.legacy(agent.ap)) {
        if (!files[file] && fs.existsSync(file) && isBrewboardFile(file)) {
          let backup = tracking.originalPathFor(paths, file);
          if (fs.existsSync(backup)) backup += `.${Date.now()}`; // never overwrite an earlier backup
          tracking.ensureDir(t, path.dirname(backup), 0o700);
          const content = fs.readFileSync(file);
          fs.renameSync(file, backup);
          t.moved = t.moved.filter((m) => m.path !== file);
          t.moved.push({ path: file, backup, sha256: sha(content), agent: agent.id,
                         mode: (fs.statSync(backup).mode & 0o777).toString(8) });
          res.removed.push(file);
        }
      }
      res.status = statusOf(res);
    } catch (e) {
      res.status = "failed";
      res.error = e.message;
    }
  }

  // Keep the records of agents skipped this time, so uninstall still finds their files.
  for (const [file, info] of Object.entries(previous)) {
    const ids = info.agents || [];
    if (!files[file] && fs.existsSync(file) && !ids.includes("core") && !ids.some((id) => summary.agents[id])) files[file] = info;
  }
  t.files = files;
  t.version = version;
  if (summary.backupDir && !t.backup_runs.includes(runDir)) t.backup_runs.push(runDir);
  t.backup_runs = pruneBackups(paths.backupsDir, t.backup_runs);
  tracking.writeTracking(paths, t);
  summary.validation = validate(files);
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

// Keeps the newest KEEP_BACKUPS update backups. Originals (~/.bb/backups/originals) are never pruned.
function pruneBackups(dir, runs) {
  if (!fs.existsSync(dir)) return runs;
  const all = fs.readdirSync(dir).filter((n) => n.startsWith("install-")).sort();
  const drop = new Set(all.slice(0, Math.max(0, all.length - KEEP_BACKUPS)).map((n) => path.join(dir, n)));
  for (const old of drop) fs.rmSync(old, { recursive: true, force: true });
  return runs.filter((r) => !drop.has(r));
}

function installedAgents(paths) {
  const ids = new Set();
  for (const info of Object.values(tracking.loadForUpdate(paths).files)) (info.agents || []).forEach((a) => ids.add(a));
  ids.delete("core");
  return [...ids];
}

// Kept for callers that import it from here; the implementation lives in uninstall.js.
function readOwned(paths) { return tracking.loadForUpdate(paths); }

module.exports = { install, validate, readManifest, readOwned, installedAgents };
