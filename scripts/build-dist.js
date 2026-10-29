#!/usr/bin/env node
// Maintainer tool (not shipped): regenerates the generated parts of dist/ from the files authored in this
// repository and rewrites dist/manifest.json. It reads nothing outside this repository.
//
//   Authored (edit these)   dist/skill/**                     the skill, its Python client (bb.py) and assets
//                           dist/adapters/claude-code/bb.md   the Claude Code /bb command, also the source of OpenCode's
//                           dist/adapters/agent-skill/bb.md   the shared Agent Skill pointer ($bb, Antigravity's /bb)
//   Generated (never edit)  dist/adapters/opencode/bb.md      from the Claude Code command (toOpencode below)
//                           dist/adapters/opencode/bb <sub>.md         OpenCode    } one suggestion entry per
//                           dist/adapters/claude-skills/bb <sub>/      Claude Code } subcommand, shown and typed
//                           dist/adapters/antigravity-skills/bb-<id>/  Antigravity } as `/bb <sub>` (`$bb <sub>`),
//                           dist/adapters/codex/bb-<id>/SKILL.md       Codex       } from SUBCOMMANDS below
//                           dist/manifest.json                sha256 + mode of every packaged file
//
//   npm run build        regenerate the generated files and the manifest
//   npm run check-dist   verify all of it, read-only (scripts/check-dist.js)
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIST = path.join(__dirname, "..", "dist");
const GROUPS = ["skill/", "adapters/claude-code/", "adapters/claude-skills/", "adapters/opencode/", "adapters/agent-skill/",
                "adapters/antigravity-skills/", "adapters/codex/"];
const EXECUTABLE = new Set(["skill/scripts/bb.py"]);
const FORBIDDEN = /(^|\/)(__pycache__|\.venv|node_modules)(\/|$)|\.(pyc|tgz|pem|key|sqlite)$|(^|\/)(\.env[^/]*|config\.json|state\.json|db\.json)$/;

// OpenCode reads the same command files, minus Claude Code's argument-hint and its AskUserQuestion tool.
const OPENCODE_RULES = [
  [/^argument-hint:.*\n/m, ""],
  ["use the AskUserQuestion tool (four pages), never a numbered list.",
   "use your native selection UI if you have one (paged as in SKILL.md), otherwise the numbered list SKILL.md describes for other agents."],
  ["AskUserQuestion or any native selector", "a question tool or any native selector"],
  ["Do NOT use AskUserQuestion to pick", "Do NOT use a question tool to pick"],
  ["(no AskUserQuestion, no row numbers)", "(no question tool, no row numbers)"],
];

function toOpencode(text, name = "command") {
  let out = text;
  for (const [from, to] of OPENCODE_RULES) out = typeof from === "string" ? out.split(from).join(to) : out.replace(from, to);
  if (/AskUserQuestion/.test(out)) {
    throw new Error(`${name}: mentions AskUserQuestion in a way scripts/build-dist.js has no OpenCode rule for; add one`);
  }
  return out;
}

// {name: content} of the OpenCode commands the Claude Code commands produce.
function expectedOpencode(dist = DIST) {
  const dir = path.join(dist, "adapters", "claude-code");
  return Object.fromEntries(fs.readdirSync(dir).filter((f) => /^bb[\w-]*\.md$/.test(f)).sort()
    .map((f) => [f, toOpencode(fs.readFileSync(path.join(dir, f), "utf8"), f)]));
}

// The twelve subcommands. None of the four CLIs completes a command's arguments, so `/bb ` alone suggests nothing. Each
// CLI does list an entry whose name has a space, though, and picking it types that name: an entry named `bb list_tasks`
// appears as `/bb list_tasks` and types `/bb list_tasks `. On sending, every CLI reads the first word as the command,
// so the text reaches the main `/bb` (`$bb`) with `list_tasks …` as its arguments: the entries only make the
// subcommands discoverable, and the canonical workflow runs exactly as when the user types it. What sets the name
// (checked in each CLI's interactive UI, 2026-10-29):
//   Claude Code 2.1.312  the skill's folder name (a frontmatter `name` changes only the label: picking it would
//                        type the folder name)          ~/.claude/skills/bb list_tasks/SKILL.md
//   OpenCode 1.18.35     the command's file name        ~/.config/opencode/commands/bb list_tasks.md
//   Antigravity 1.4.10   the skill's frontmatter name   ~/.gemini/antigravity-cli/skills/bb-list-tasks/SKILL.md
//   Codex 0.165.0        the skill's frontmatter name   ~/.codex/skills/bb-list-tasks/SKILL.md  ($bb list_tasks)
// The entries still delegate properly if an agent loads one itself (Antigravity and Codex list them to the model).
// An entry is generated only for a subcommand SKILL.md has a "### <sub>" section for.
const SUBCOMMANDS = [
  ["init", "verify the current user and connection, sign in (--login) or sign out (--logout)", "[--login | --logout]"],
  ["list_projects", "list and select projects", ""],
  ["list_tasks", "list and select tasks", "[status] [limit]"],
  ["list_tickets", "list and select tickets", "[status] [limit]"],
  ["cycles", "list cycles and their tasks", "[status]"],
  ["log_time", "log work time", "[duration] [work description]"],
  ["timesheets", "list my time logs", "[period]"],
  ["create_mom", "create minutes of meeting", ""],
  ["moms", "list and open minutes of meeting", "[search]"],
  ["show", "show one project, task, ticket, cycle, MoM or timesheet", "<project|task|issue|cycle|mom|timesheet> <ID>"],
  ["find", "search tasks, tickets, meetings, time logs, projects and cycles", "<query>"],
  ["status", "show the current working context", ""],
];
const codexId = (sub) => `bb-${sub.replace(/_/g, "-")}`;

const SIGN_IN = "Signing in follows the sign-in step of the init section: run `bb.py init --login --launch --format table`, " +
  "which opens the sign-in in a new terminal. Never run `bb.py init --login` or `bb.py init` yourself: they need a real " +
  "terminal for the hidden password prompt.";

// The subcommands the skill in dist/ documents; a partial set means the table and SKILL.md disagree.
function subcommandsIn(dist = DIST) {
  let skill = "";
  try { skill = fs.readFileSync(path.join(dist, "skill", "SKILL.md"), "utf8"); } catch { return []; }
  const have = SUBCOMMANDS.filter(([sub]) => skill.includes(`\n### ${sub}\n`));
  if (have.length && have.length < SUBCOMMANDS.length) {
    const missing = SUBCOMMANDS.filter((r) => !have.includes(r)).map(([sub]) => sub);
    throw new Error(`skill/SKILL.md has no "### <sub>" section for ${missing.join(", ")} (SUBCOMMANDS in scripts/build-dist.js)`);
  }
  return have;
}

// The body every entry shares: it hands its arguments to the subcommand's workflow and nothing else.
function entryBody(sub, main, args) {
  return `Run the Brewboard \`${sub}\` subcommand, exactly as \`${main} ${sub}\` with the arguments below; this entry has ` +
    "no workflow of its own.\n\n" +
    `Read ~/.bb/skill/SKILL.md and follow its ${sub} workflow for the rest of this request.` +
    (sub === "init" ? ` ${SIGN_IN}` : "") + "\n\n" + `Subcommand and arguments: ${sub} ${args}\n`;
}

// A Claude Code skill or OpenCode command (both substitute $ARGUMENTS); its name comes from the folder or file name.
// No argument-hint: Claude Code shows none for these entries, neither in the list nor after one is picked.
function slashEntry(sub, what, { claude }) {
  return "---\n" + `description: "Brewboard - ${what}"\n` +
    (claude ? "disable-model-invocation: true\n" : "") + "---\n" + entryBody(sub, "/bb", "$ARGUMENTS");
}

// An Antigravity or Codex skill: named by its frontmatter, and given no $ARGUMENTS, so the arguments are the text the
// user wrote after the entry's name.
function namedSkill(sub, what, main) {
  return `---\nname: "bb ${sub}"\ndescription: "Brewboard \`${main} ${sub}\`: ${what}. Use when the user selects ` +
    `${main} ${sub}; for anything else about Brewboard use the bb skill."\n---\n` +
    entryBody(sub, main, `(the text the user wrote after \`${main} ${sub}\`, possibly nothing)`);
}

// {dist-relative path: content} of every per-subcommand entry, for all four agents.
function expectedSubcommands(dist = DIST) {
  const out = {};
  for (const [sub, what] of subcommandsIn(dist)) {
    out[`adapters/claude-skills/bb ${sub}/SKILL.md`] = slashEntry(sub, what, { claude: true });
    out[`adapters/opencode/bb ${sub}.md`] = slashEntry(sub, what, { claude: false });
    out[`adapters/antigravity-skills/${codexId(sub)}/SKILL.md`] = namedSkill(sub, what, "/bb");
    out[`adapters/codex/${codexId(sub)}/SKILL.md`] = namedSkill(sub, what, "$bb");
  }
  return out;
}

// Every generated file, {dist-relative path: content}.
function expectedGenerated(dist = DIST) {
  return { ...Object.fromEntries(Object.entries(expectedOpencode(dist)).map(([f, t]) => [`adapters/opencode/${f}`, t])),
           ...expectedSubcommands(dist) };
}

// Relative paths of the files below dir. Symlinks and other non-regular entries are refused: the package ships
// regular files only (check-dist rejects anything else, so the build must not write it into the manifest).
function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (e.isDirectory()) return walk(full, base);
    if (!e.isFile()) throw new Error(`not allowed in dist/ (delete or move them first): ${rel} is not a regular file`);
    return [rel];
  });
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const group = (p) => GROUPS.findIndex((g) => p.startsWith(g));

// The manifest dist/ should have: every packaged file, grouped as the installer expects, with its intended mode.
function manifestFor(dist = DIST) {
  const files = walk(dist).filter((p) => p !== "manifest.json");
  const bad = files.filter((p) => FORBIDDEN.test(p) || group(p) < 0);
  if (bad.length) throw new Error(`not allowed in dist/ (delete or move them first): ${bad.join(", ")}`);
  files.sort((a, b) => group(a) - group(b) || (a < b ? -1 : 1));
  return { source: "this repository: scripts/build-dist.js",
           files: files.map((p) => ({ path: p, sha256: sha(fs.readFileSync(path.join(dist, p))),
                                      mode: EXECUTABLE.has(p) ? "755" : "644" })) };
}

// The folders that hold only generated files: anything in them that the build does not make is removed.
const GENERATED_DIRS = ["adapters/opencode", "adapters/claude-skills", "adapters/antigravity-skills", "adapters/codex"];

function build(dist = DIST, log = console.log) {
  const want = expectedGenerated(dist);
  for (const d of GENERATED_DIRS) { // drop what the build no longer makes, then any folder left empty
    if (!fs.existsSync(path.join(dist, d))) continue;
    for (const rel of walk(path.join(dist, d)).map((f) => `${d}/${f}`)) if (!(rel in want)) fs.rmSync(path.join(dist, rel));
    removeEmptyDirs(path.join(dist, d));
  }
  for (const [rel, text] of Object.entries(want)) {
    fs.mkdirSync(path.dirname(path.join(dist, rel)), { recursive: true });
    fs.writeFileSync(path.join(dist, rel), text);
  }
  const manifest = manifestFor(dist);
  for (const f of manifest.files) fs.chmodSync(path.join(dist, f.path), parseInt(f.mode, 8));
  fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  log(`Built dist/: ${Object.keys(want).length} files generated (OpenCode /bb and ${subcommandsIn(dist).length} subcommand ` +
      `entries per agent), manifest lists ${manifest.files.length} files.`);
  return manifest;
}

function removeEmptyDirs(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) removeEmptyDirs(path.join(dir, e.name));
  if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
}

if (require.main === module) {
  try { build(); } catch (e) { console.error(e.message); process.exit(1); }
}
module.exports = { build, manifestFor, expectedOpencode, expectedSubcommands, expectedGenerated, subcommandsIn, toOpencode,
                   codexId, OPENCODE_RULES, SUBCOMMANDS, GENERATED_DIRS };
