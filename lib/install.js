"use strict";
// Installs dist/ for the core skill and each detected agent, recording ownership in
// ~/.bb/installed.json (see tracking.js) so updates and uninstall touch only Brewboard's files.
// - A file that existed before Brewboard first wrote it is kept in ~/.bb/backups/originals/ and
//   restored by uninstall. A Brewboard file replaced by an update goes to ~/.bb/backups/install-<ts>/.
// - Old Brewboard copies at paths an agent should not read are moved to ~/.bb/backups/originals/.
// - Directories are created one level at a time and recorded, so uninstall removes only those.
// - Crash-safe: the record is saved before each file is written or moved, so an interrupted run never
//   leaves a Brewboard file that the next run would mistake for one that was there before.
// - A record that cannot be read is never overwritten: it is the only proof of what Brewboard owns.
// - A target that is a folder, a symbolic link or unreadable fails that agent with a plain message.
// - Idempotent; a failure for one agent does not stop the others; config.json and state.json are
//   never touched here.
const fs = require("fs");
const path = require("path");
const { writable, isBrewboardFile } = require("./agents");
const tracking = require("./tracking");

const KEEP_BACKUPS = 10;
const { sha } = tracking;

class InstallError extends Error {}

function readManifest(distDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(distDir, "manifest.json"), "utf8"));
  for (const f of manifest.files) {
    if (sha(fs.readFileSync(path.join(distDir, f.path))) !== f.sha256) {
      throw new Error(`packaged file ${f.path} does not match its manifest entry`);
    }
  }
  return manifest;
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function walk(dir) {
  if (!isDir(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

// Why the installer cannot read or replace `file`, in words; null when it can (or nothing is there).
function blockedReason(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) {
    if (e.code === "ENOENT") return null;
    if (e.code === "ENOTDIR") return `${file} cannot be created: part of its folder path is a file`;
    return `${file} cannot be inspected (${e.code || e.message})`;
  }
  if (st.isSymbolicLink()) return `${file} is a symbolic link; Brewboard does not replace links (move it aside and run again)`;
  if (st.isDirectory()) return `${file} is a folder, not a file; move it aside and run again`;
  if (!st.isFile()) return `${file} is not a regular file; move it aside and run again`;
  try { fs.accessSync(file, fs.constants.R_OK); } catch {
    return `${file} cannot be read (permission denied); fix its permissions or move it aside`;
  }
  return null;
}

// Temp files an interrupted run left next to `file` (`<name>.<pid>.tmp`, the installer's own naming).
function removeStaleTemps(file) {
  const base = path.basename(file);
  let names;
  try { names = fs.readdirSync(path.dirname(file)); } catch { return; }
  for (const n of names) {
    if (n.startsWith(`${base}.`) && /^\.\d+\.tmp$/.test(n.slice(base.length))) {
      fs.rmSync(path.join(path.dirname(file), n), { force: true });
    }
  }
}

function install(paths, { agents = [], now = new Date(), version = "0" } = {}) {
  const manifest = readManifest(paths.distDir);
  const byPath = new Map(manifest.files.map((f) => [f.path, f]));
  const t = tracking.readTracking(paths) || tracking.empty(); // TrackingError: refuse, never overwrite
  const previous = { ...t.files };
  const files = {};
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(paths.backupsDir, `install-${stamp}`);
  const summary = { core: null, agents: {}, backupDir: null };
  const save = () => tracking.writeTracking(paths, t);

  tracking.ensureDir(t, paths.bbHome, 0o700);
  removeStaleTemps(tracking.trackingFile(paths));
  // The record for `file` (and for the folders about to be created for it) is saved before they
  // exist, so a crash in between leaves a record of something missing (harmless), never a Brewboard
  // file or folder without a record.
  const writeFile = (file, content, mode, rec) => {
    for (let d = path.dirname(file); !fs.existsSync(d) && path.dirname(d) !== d; d = path.dirname(d)) {
      if (!t.dirs.includes(d)) t.dirs.push(d);
    }
    t.files = { ...t.files, [file]: rec };
    save();
    tracking.ensureDir(t, path.dirname(file));
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, content, { mode });
      fs.chmodSync(tmp, mode);
      fs.renameSync(tmp, file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
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
    if (written.has(to)) { files[to].agents.push(agentId); res.shared.push(to); return; }
    const blocked = blockedReason(to);
    if (blocked) throw new InstallError(blocked);
    removeStaleTemps(to);
    const prev = previous[to];
    const rec = { sha256: f.sha256, agents: [agentId], mode: f.mode,
                  created: prev ? prev.created : null, original: prev ? prev.original : null };
    const mode = parseInt(f.mode, 8);
    const content = fs.readFileSync(path.join(paths.distDir, from));
    const done = (list) => { files[to] = rec; written.add(to); list.push(to); };
    if (fs.existsSync(to)) {
      if (sha(fs.readFileSync(to)) === f.sha256) {
        if ((fs.statSync(to).mode & 0o777) !== mode) fs.chmodSync(to, mode);
        if (rec.created === null && !prev) rec.created = false; // identical file already there (not ours)
        done(res.unchanged);
        return;
      }
      if (prev) runBackup(to); // our earlier version (or the user's edit of it)
      else { rec.original = keepOriginal(to); rec.created = false; } // someone else's file: keep to restore
      writeFile(to, content, mode, rec);
      done(res.updated);
      return;
    }
    if (rec.created === null) rec.created = !prev || prev.created !== false;
    writeFile(to, content, mode, rec);
    done(res.created);
  };
  const fresh = () => ({ status: null, created: [], updated: [], unchanged: [], shared: [], removed: [], error: null });

  // Drop a file this install no longer ships: back it up, then put back what was there before Brewboard
  // (also when an interrupted run already removed Brewboard's copy but did not restore the original).
  const retire = (file, info, res) => {
    let current = null;
    try { current = fs.lstatSync(file).isFile() ? sha(fs.readFileSync(file)) : "not a file"; } catch (e) {
      if (e.code !== "ENOENT") current = "unreadable";
    }
    if (current !== null && current !== info.sha256) { files[file] = info; return; } // edited or replaced: keep tracking it
    if (current !== null) {
      runBackup(file);
      fs.rmSync(file);
      res.removed.push(file);
    }
    if (info.original && fs.existsSync(info.original) && !fs.existsSync(file)) fs.renameSync(info.original, file);
  };

  // Core skill: everything below ~/.bb/skill is Brewboard's.
  const core = fresh();
  const coreTargets = manifest.files.filter((f) => f.path.startsWith("skill/"))
    .map((f) => ({ from: f.path, to: path.join(paths.skillDir, f.path.slice("skill/".length)) }));
  try {
    for (const tg of coreTargets) place(tg.from, tg.to, "core", core);
  } catch (e) {
    throw new InstallError(`the core skill could not be installed: ${e.message}`);
  }
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
      // The move is recorded before it happens, so an interrupted run cannot lose track of the copy.
      for (const file of agent.legacy(agent.ap)) {
        if (!files[file] && fs.existsSync(file) && isBrewboardFile(file)) {
          let backup = tracking.originalPathFor(paths, file);
          if (fs.existsSync(backup)) backup += `.${Date.now()}`; // never overwrite an earlier backup
          tracking.ensureDir(t, path.dirname(backup), 0o700);
          const content = fs.readFileSync(file);
          t.moved = t.moved.filter((m) => m.path !== file);
          t.moved.push({ path: file, backup, sha256: sha(content), agent: agent.id,
                         mode: (fs.statSync(file).mode & 0o777).toString(8) });
          save();
          try { fs.renameSync(file, backup); } catch (e) {
            t.moved = t.moved.filter((m) => m.path !== file);
            throw e;
          }
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
  save();
  summary.validation = validate(files);
  return summary;
}

function statusOf(r) {
  if (r.created.length && !r.updated.length && !r.unchanged.length && !r.removed.length) return "installed";
  if (r.created.length || r.updated.length || r.removed.length) return "updated";
  return "unchanged";
}

// Owned files whose content is not what the record says (missing, changed or unreadable). Never throws.
function validate(ownedFiles) {
  const bad = Object.entries(ownedFiles).filter(([file, info]) => {
    try { return sha(fs.readFileSync(file)) !== info.sha256; } catch { return true; }
  }).map(([file]) => file);
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

module.exports = { install, validate, readManifest, readOwned, installedAgents, blockedReason, InstallError };
