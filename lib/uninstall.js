"use strict";
// Uninstall: driven by ~/.bb/installed.json (tracking.js), never by filename patterns alone.
//
//   planUninstall()     read-only: what would be removed, restored, kept, and why (also --dry-run)
//   executeUninstall()  carries out a plan; each step can fail on its own; a retry continues
//
// Safe by default:
//   - removes only tracked files whose content is unchanged since Brewboard wrote them;
//   - an edited tracked file is kept and reported; --force removes it only if the record proves
//     the installer created it (created: true);
//   - files that were there before Brewboard (and old copies Brewboard moved aside) are put back,
//     unless something now occupies the path: then the backup is kept and the conflict reported;
//   - ~/.bb/config.json: removed if the installer's sign-in created it and it is unchanged;
//     the user's earlier file is restored if the installer replaced one; otherwise left alone;
//   - only directories the installer created are removed, and only when empty;
//   - installed.json is deleted only when nothing tracked is left; otherwise it keeps the rest.
const fs = require("fs");
const path = require("path");
const tracking = require("./tracking");
const { isBrewboardFile } = require("./agents");
const lock = require("./lock");

const { sha } = tracking;

// What is at `file` now: null (nothing), {hash} for a readable regular file, or {problem} in words
// (a folder, a link or an unreadable file there is never removed, restored over or hashed).
function inspect(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) {
    return e.code === "ENOENT" || e.code === "ENOTDIR" ? null : { problem: `cannot be inspected (${e.code || e.message})` };
  }
  if (st.isSymbolicLink()) return { problem: "is now a symbolic link" };
  if (st.isDirectory()) return { problem: "is now a folder" };
  if (!st.isFile()) return { problem: "is not a regular file" };
  try { return { hash: sha(fs.readFileSync(file)) }; } catch (e) {
    return { problem: `cannot be read (${e.code === "EACCES" ? "permission denied" : e.code || e.message})` };
  }
}

// Known Brewboard locations, used only to *report* leftovers when no tracking record exists.
function knownLocations(paths) {
  const home = paths.home;
  return [
    paths.skillDir,
    path.join(home, ".agents", "skills", "bb", "SKILL.md"),
    path.join(home, ".gemini", "antigravity-cli", "skills", "bb", "SKILL.md"),
    path.join(home, ".gemini", "config", "skills", "bb", "SKILL.md"),
    ...(() => { // Codex shortcut skills
      const dir = path.join(home, ".codex", "skills");
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^bb-[a-z-]+$/.test(n)).map((n) => path.join(dir, n, "SKILL.md")) : [];
    })(),
    ...[[".claude", "skills"], [".gemini", "antigravity-cli", "skills"]].flatMap((p) => { // per-subcommand entries
      const dir = path.join(home, ...p);
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^bb[ -][a-z_-]+$/.test(n)).map((n) => path.join(dir, n, "SKILL.md")) : [];
    }),
    ...["claude", "opencode"].flatMap((k) => {
      const dir = k === "claude" ? path.join(home, ".claude", "commands") : path.join(home, ".config", "opencode", "commands");
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^bb([-_ ][\w-]+)?\.md$/.test(n)).map((n) => path.join(dir, n)) : [];
    }),
  ].filter((p) => fs.existsSync(p) && (fs.statSync(p).isDirectory() || isBrewboardFile(p)));
}

function walk(dir) {
  try { if (!fs.statSync(dir).isDirectory()) return []; } catch { return []; }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? [full + path.sep, ...walk(full)] : [full];
  });
}

function planUninstall(paths, { force = false, removeBackups = false } = {}) {
  const plan = { remove: [], forceRemove: [], restore: [], keep: [], conflicts: [], gone: [], manual: [],
                 config: null, dirs: [], backups: [], trackingFile: tracking.trackingFile(paths), blocked: null,
                 schema: null };
  const held = lock.inspect(paths.lockFile);
  if (held && held.active) { plan.blocked = `a Brewboard sign-in is running (pid ${held.pid}); finish it first`; return plan; }
  if (held) plan.staleLock = paths.lockFile;

  let t;
  try { t = tracking.readTracking(paths); } catch (e) {
    plan.blocked = `${e.message}. Nothing can be removed safely without it; review the files below by hand.`;
    plan.manual = knownLocations(paths);
    return plan;
  }
  if (!t) {
    plan.manual = knownLocations(paths);
    plan.none = true;
    return plan;
  }
  plan.schema = t.schema;

  const occupied = new Set(); // paths that will still hold something after the plan runs
  for (const [file, info] of Object.entries(t.files)) {
    const now = inspect(file);
    const exists = now !== null;
    const unchanged = exists && now.hash === info.sha256;
    const item = { path: file, agents: info.agents || [], created: info.created, original: info.original };
    if (now && now.problem) { plan.keep.push({ ...item, reason: `${now.problem}; left alone` }); occupied.add(file); continue; }
    if (!exists) plan.gone.push(item);
    else if (unchanged) plan.remove.push(item);
    else if (force && info.created === true) plan.forceRemove.push(item);
    else { plan.keep.push({ ...item, reason: info.created === true ? "changed since Brewboard wrote it (use --force to remove)"
                                              : info.created === false ? "changed since Brewboard wrote it; the earlier file stays in the backup"
                                                                       : "changed, and the record does not show who created it" });
           occupied.add(file); continue; }
    if (info.original) {
      if (!fs.existsSync(info.original)) plan.conflicts.push({ path: file, backup: info.original, reason: "backup is missing" });
      else plan.restore.push({ path: file, from: info.original });
    } else if (info.created === false && exists) {
      // Was already there (identical) before Brewboard: not ours to delete.
      plan.remove = plan.remove.filter((x) => x.path !== file);
      plan.keep.push({ ...item, reason: "was already there before Brewboard installed it" });
      occupied.add(file);
    } else if (info.created === null && exists && unchanged) {
      item.note = "0.1.0 record: whether a file existed before is unknown; any earlier copy is in ~/.bb/backups/install-*";
    }
  }
  for (const m of t.moved) {
    if (!fs.existsSync(m.backup)) {
      // Recorded, but the move itself never happened (an interrupted install): nothing to put back.
      if (m.sha256 && (inspect(m.path) || {}).hash === m.sha256) continue;
      plan.conflicts.push({ path: m.path, backup: m.backup, reason: "backup is missing" });
      continue;
    }
    if (fs.existsSync(m.path) || occupied.has(m.path)) { plan.conflicts.push({ path: m.path, backup: m.backup, reason: "the path is in use now" }); continue; }
    plan.restore.push({ path: m.path, from: m.backup, moved: true });
  }

  // Generated files Brewboard's own skill produces when it runs (Python bytecode), and anything
  // else unexpected inside the skill directory.
  for (const p of walk(paths.skillDir)) {
    if (p.endsWith(path.sep)) continue;
    if (p.includes(`${path.sep}__pycache__${path.sep}`)) plan.remove.push({ path: p, generated: true });
    else if (!t.files[p]) plan.manual.push(p);
  }

  const c = t.config;
  if (c && c.path) {
    const now = inspect(c.path);
    const exists = now !== null;
    const unchanged = exists && now.hash === c.sha256;
    if (now && now.problem) {
      plan.config = { action: "keep", path: c.path, reason: `${now.problem}; left alone` };
    } else if (exists && !unchanged && !(force && c.created)) {
      plan.config = { action: "keep", path: c.path, reason: "changed since the installer's sign-in wrote it" +
                      (c.created ? " (use --force to remove)" : `; your earlier file stays at ${c.original}`) };
    } else if (c.created) {
      plan.config = exists ? { action: "remove", path: c.path, forced: !unchanged } : { action: "gone", path: c.path };
    } else if (c.original && fs.existsSync(c.original)) {
      plan.config = { action: "restore", path: c.path, from: c.original };
    } else {
      plan.config = { action: "keep", path: c.path, reason: "your earlier configuration's backup is missing" };
    }
  } else if (fs.existsSync(paths.configFile)) {
    plan.config = { action: "keep", path: paths.configFile, reason: "not created by this installer" };
  }

  plan.dirs = [...t.dirs].sort((a, b) => b.length - a.length);
  plan.backups = t.backup_runs.filter((d) => fs.existsSync(d));
  plan.removeBackups = removeBackups;
  return plan;
}

function hasWork(plan) {
  return !plan.blocked && Boolean(plan.remove.length || plan.forceRemove.length || plan.restore.length ||
    (plan.config && ["remove", "restore"].includes(plan.config.action)) || plan.staleLock ||
    (plan.removeBackups && plan.backups.length) || (!plan.none && fs.existsSync(plan.trackingFile)));
}

function executeUninstall(paths, plan) {
  const r = { removed: [], restored: [], kept: plan.keep.map((k) => k.path), conflicts: plan.conflicts.map((c) => c.path),
              failed: [], manual: [...plan.manual], dirsRemoved: [], configRemoved: false, configRestored: false,
              trackingRemoved: false };
  const step = (label, p, fn) => { try { fn(); return true; } catch (e) { r.failed.push({ path: p, step: label, error: e.message }); return false; } };
  const restored = new Set();

  for (const item of [...plan.remove, ...plan.forceRemove]) {
    if (step("remove", item.path, () => fs.rmSync(item.path, { force: true }))) r.removed.push(item.path);
  }
  for (const item of plan.restore) {
    if (fs.existsSync(item.path)) { r.conflicts.push(item.path); continue; } // e.g. its removal failed
    step("restore", item.path, () => {
      fs.mkdirSync(path.dirname(item.path), { recursive: true });
      fs.renameSync(item.from, item.path);
      r.restored.push(item.path); restored.add(item.path);
    });
  }
  if (plan.config && plan.config.action === "remove") {
    if (step("remove", plan.config.path, () => fs.rmSync(plan.config.path, { force: true }))) r.configRemoved = true;
  } else if (plan.config && plan.config.action === "restore") {
    step("restore", plan.config.path, () => {
      const tmp = `${plan.config.path}.${process.pid}.tmp`;
      fs.copyFileSync(plan.config.from, tmp);
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, plan.config.path);
      fs.rmSync(plan.config.from);
      r.configRestored = true;
    });
  }
  if (plan.staleLock) step("remove", plan.staleLock, () => fs.rmSync(plan.staleLock, { force: true }));
  if (plan.removeBackups) {
    for (const d of plan.backups) if (step("remove", d, () => fs.rmSync(d, { recursive: true, force: true }))) r.removed.push(d);
  }

  // Empty directories inside the skill folder (e.g. __pycache__) go with it.
  for (const d of walk(paths.skillDir).filter((p) => p.endsWith(path.sep)).sort((a, b) => b.length - a.length)) {
    try { fs.rmdirSync(d); } catch { /* not empty */ }
  }
  try { fs.rmdirSync(paths.skillDir); r.dirsRemoved.push(paths.skillDir); } catch { /* not empty (untracked files) or gone */ }

  // What is still tracked after this run (so a retry can pick it up).
  let t = null;
  try { t = tracking.readTracking(paths); } catch { t = null; }
  if (t) {
    const failedPaths = new Set(r.failed.map((f) => f.path));
    const remainingFiles = {};
    const remainingMoved = t.moved.filter((m) => fs.existsSync(m.backup) && !restored.has(m.path));
    for (const [file, info] of Object.entries(t.files)) {
      const stillOurs = fs.existsSync(file) && !restored.has(file) &&
        (failedPaths.has(file) || plan.keep.some((k) => k.path === file));
      const pendingRestore = info.original && fs.existsSync(info.original) && !restored.has(file);
      if (stillOurs) remainingFiles[file] = info;
      // Our file is gone but its original could not be put back (path in use): from now on this is
      // only a pending restore, so a retry never mistakes whatever occupies the path for Brewboard's.
      else if (pendingRestore) remainingMoved.push({ path: file, backup: info.original, sha256: null, agent: (info.agents || [])[0] });
    }
    const configPending = Boolean(t.config && plan.config && (plan.config.action === "keep" ||
      (plan.config.action === "remove" && !r.configRemoved) || (plan.config.action === "restore" && !r.configRestored)));
    const left = Object.keys(remainingFiles).length || remainingMoved.length || configPending;
    if (left) {
      step("update", plan.trackingFile, () => tracking.writeTracking(paths, { ...t, files: remainingFiles, moved: remainingMoved,
        config: configPending ? t.config : null, backup_runs: plan.removeBackups ? [] : t.backup_runs }));
    } else if (step("remove", plan.trackingFile, () => fs.rmSync(plan.trackingFile, { force: true }))) {
      r.trackingRemoved = true;
    }
  }
  // Directories the installer created: removed only when empty, deepest first (rmdir refuses otherwise).
  for (const d of plan.dirs) {
    try { fs.rmdirSync(d); r.dirsRemoved.push(d); } catch { /* not empty, or already gone */ }
  }
  return r;
}

function exitCode(r) {
  if (r.failed.length) return 1;
  if (r.kept.length || r.conflicts.length || r.manual.length) return 2;
  return 0;
}

module.exports = { planUninstall, executeUninstall, hasWork, exitCode, knownLocations };
