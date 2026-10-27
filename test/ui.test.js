"use strict";
// Installer presentation: colour/symbol rules, the shared banner art, banner placement (once, TTY only, never
// for --help/--version/uninstall or captured output) and the system-check layout at different widths.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { PassThrough } = require("stream");
const ui = require("../lib/ui");
const { preflight, renderPreflight } = require("../lib/preflight");
const { main } = require("../lib/cli");
const { tmpHome, mockServer, fakeTty, drive, KEY, PASSWORD } = require("./helpers");
const { detectAgents } = require("../lib/agents");
// Simulated agent detection (as in preflight.test.js): the named CLIs exist with version 9.9.9.
const fakeDetect = (present) => (opts) => detectAgents({ ...opts, whichFn: (b) => (present.includes(b) ? `/bin/${b}` : null),
                                                        versionFn: () => "9.9.9", exists: () => false });

const UTF8 = { LANG: "en_US.UTF-8", TERM: "xterm-256color" };
const BIN = path.join(__dirname, "..", "bin", "brewboard-skill.js");
const TAGLINE = "Your workspace. Your workflow.";
const sink = (isTTY = false, columns = 100) => {
  const s = new PassThrough();
  let t = "";
  s.on("data", (c) => (t += c));
  s.text = () => t;
  if (isTTY) { s.isTTY = true; s.columns = columns; }
  return s;
};
const count = (text, s) => text.split(s).length - 1;

test("colour only on a TTY, never with NO_COLOR or TERM=dumb; ASCII symbols outside UTF-8 locales", () => {
  assert.strictEqual(ui.colorEnabled({ isTTY: true }, UTF8), true);
  assert.strictEqual(ui.colorEnabled({ isTTY: false }, UTF8), false);
  assert.strictEqual(ui.colorEnabled({ isTTY: true }, { ...UTF8, NO_COLOR: "1" }), false);
  assert.strictEqual(ui.colorEnabled({ isTTY: true }, { ...UTF8, NO_COLOR: "" }), true);
  assert.strictEqual(ui.colorEnabled({ isTTY: true }, { ...UTF8, TERM: "dumb" }), false);
  assert.strictEqual(ui.unicodeEnabled(UTF8), true);
  assert.strictEqual(ui.unicodeEnabled({ LANG: "C" }), false);
  assert.strictEqual(ui.unicodeEnabled({ ...UTF8, BB_ASCII: "1" }), false);
  const plain = ui.createStyle({ isTTY: false }, { LANG: "C" });
  assert.strictEqual(plain.status("error", "Failed"), "XX Failed");
  assert.strictEqual(plain.status("ok", "Done"), "ok Done");
  const rich = ui.createStyle({ isTTY: true, columns: 90 }, UTF8);
  assert.strictEqual(rich.status("ok", "Done"), "\x1b[32m✓\x1b[0m Done");
  assert.strictEqual(rich.width(), 90);
});

test("the installer and bb.py share one banner file, and it ships in the package", () => {
  assert.strictEqual(ui.ART_FILE, path.join(__dirname, "..", "dist", "skill", "assets", "banner.txt"));
  const art = ui.loadArt();
  assert.deepStrictEqual(Object.keys(art), ["small", "mini", "tagline"]);
  assert.strictEqual(art.tagline, TAGLINE);
  for (const line of [...art.small, ...art.mini]) assert.match(line, /^[\x20-\x7e]*[^ ]$/, "printable ASCII, no trailing space");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "dist", "manifest.json"), "utf8"));
  assert.ok(manifest.files.some((f) => f.path === "skill/assets/banner.txt"));
  const py = fs.readFileSync(path.join(__dirname, "..", "dist", "skill", "scripts", "bbclient", "ui.py"), "utf8");
  assert.match(py, /parents\[2\] \/ "assets" \/ "banner\.txt"/);
});

test("the banner never overflows the terminal and degrades to a one-line wordmark", () => {
  for (const width of [120, 80, 57, 50, 40, 36, 30]) {
    const lines = ui.bannerLines({ width, version: "0.2.0" });
    assert.ok(lines.every((l) => l.length <= width), `${width}: ${JSON.stringify(lines)}`);
    assert.ok(lines.join("\n").includes("v0.2.0"));
  }
  assert.strictEqual(ui.bannerLines({ width: 80 }).length, 5);
  assert.strictEqual(ui.bannerLines({ width: 50 }).length, 4);
  assert.deepStrictEqual(ui.bannerLines({ width: 32 }), [ui.WORDMARK, TAGLINE]);
  assert.deepStrictEqual(ui.bannerLines({ width: 25 }), [ui.WORDMARK, "Your workspace.", "Your workflow."]);
  assert.deepStrictEqual(ui.bannerLines({ width: 80, art: {} }), [ui.WORDMARK, TAGLINE], "missing art file");
});

test("printBanner prints once per process, never clears the screen, and honours NO_COLOR", () => {
  ui.resetBanner();
  const out = sink(true);
  assert.strictEqual(ui.printBanner(out, ui.createStyle(out, UTF8), { version: "1.2.3" }), true);
  assert.strictEqual(ui.printBanner(out, ui.createStyle(out, UTF8), { version: "1.2.3" }), false);
  assert.strictEqual(count(out.text(), TAGLINE), 1);
  assert.match(out.text(), /\x1b\[1;36m/);
  assert.doesNotMatch(out.text(), /\x1b\[2J|\x1b\[H|\x1b\[\d*[ABCDK]/, "no clearing or cursor movement");
  ui.resetBanner();
  const plain = sink(true);
  ui.printBanner(plain, ui.createStyle(plain, { ...UTF8, NO_COLOR: "1" }), {});
  assert.doesNotMatch(plain.text(), /\x1b/);
  ui.resetBanner();
});

// Rows as preflight() builds them (group, label, state); the decision fields are irrelevant to the panel.
const R = (group, label, state, extra = {}) => ({ group, label, state, check: label, level: "pass", result: "", action: "", ...extra });
const PANEL = { rows: [
  R("Runtime", "Linux x64", "ok"), R("Runtime", "Node.js 24.21.0", "ok"), R("Runtime", "Python not found", "error"),
  R("Permissions", "Home directory", "ok"), R("Permissions", "Brewboard configuration", "ok"), R("Permissions", "Disk space", "ok"),
  R("Integrations", "Claude Code 9.9.9", "ok"), R("Integrations", "Codex CLI not detected", "skip"),
  R("Integrations", "OpenCode (not writable)", "warn", { hint: "OpenCode: its configuration folder is not writable, so it is skipped. Fix the permissions and run again." }),
  R("Brewboard", "Skill not installed", "todo"), R("Brewboard", "Sign-in required", "todo"),
] };

test("readiness panel: grouped, two per line when wide, one per line when narrow, never wider than the terminal", () => {
  const plainUtf8 = ui.createStyle({ isTTY: false }, UTF8);
  const wide = renderPreflight(PANEL, plainUtf8, 100);
  const groups = wide.split("\n").filter((l) => /^ {2}[A-Z][a-z]+$/.test(l)).map((l) => l.trim());
  assert.deepStrictEqual(groups, ["Runtime", "Permissions", "Integrations", "Brewboard"]);
  assert.match(wide, /^ {2}SYSTEM READINESS$/m);
  assert.match(wide, /^ {2}✓ {2}Linux x64 +✓ {2}Node\.js 24\.21\.0$/m, "two checks per line");
  assert.match(wide, /^ {2}✗ {2}Python not found$/m);
  assert.match(wide, /– {2}Codex CLI not detected/, "an absent integration is not shown as present");
  assert.doesNotMatch(wide, /✓ {2}Codex/);
  assert.match(wide, /^ {2}○ {2}Skill not installed +○ {2}Sign-in required$/m);
  assert.match(wide, /! OpenCode: its configuration folder is not writable/, "non-blocking problems get one hint line");
  for (const width of [100, 72, 50, 40]) {
    const text = ui.stripAnsi(renderPreflight(PANEL, ui.createStyle({ isTTY: true }, UTF8), width));
    for (const line of text.split("\n")) assert.ok(line.length <= width, `${width}: ${JSON.stringify(line)}`);
  }
  const narrow = renderPreflight(PANEL, plainUtf8, 50);
  assert.match(narrow, /^ {2}✓ {2}Linux x64$/m, "one check per line");
  const ascii = renderPreflight(PANEL, ui.createStyle({ isTTY: false }, { LANG: "C" }), 100);
  assert.match(ascii, /^ {2}XX {2}Python not found$/m);
  assert.match(ascii, /^ {2}\.\. {2}Skill not installed/m);
  assert.match(ascii, /-- {2}Codex CLI not detected/);
});

test("readiness panel colours: blockers red, problems and pending steps amber, absent items dim; nothing without a TTY", () => {
  const coloured = renderPreflight(PANEL, ui.createStyle({ isTTY: true }, UTF8), 100);
  assert.match(coloured, /\x1b\[31m✗\x1b\[0m {2}\x1b\[31mPython not found\x1b\[0m/);
  assert.match(coloured, /\x1b\[33m○\x1b\[0m {2}\x1b\[33mSkill not installed/);
  assert.match(coloured, /\x1b\[2m–\x1b\[0m {2}\x1b\[2mCodex CLI not detected/);
  assert.match(coloured, /\x1b\[32m✓\x1b\[0m {2}Linux x64/);
  assert.doesNotMatch(renderPreflight(PANEL, ui.createStyle({ isTTY: false }, UTF8), 100), /\x1b/);
  assert.doesNotMatch(renderPreflight(PANEL, ui.createStyle({ isTTY: true }, { ...UTF8, NO_COLOR: "1" }), 100), /\x1b/);
  assert.doesNotMatch(renderPreflight(PANEL, ui.createStyle({ isTTY: true }, { ...UTF8, TERM: "dumb" }), 100), /\x1b|✓/);
});

test("the real preflight labels carry versions and states, never paths or install locations", async () => {
  const h = tmpHome();
  try {
    const r = await preflight({ paths: h.paths, env: h.env, detect: fakeDetect(["claude", "agy"]),
                                authCheckFn: async () => ({ status: "not_configured" }) });
    const text = renderPreflight(r, ui.createStyle({ isTTY: false }, UTF8), 100);
    assert.match(text, /Claude Code 9\.9\.9/);
    assert.match(text, /Antigravity CLI 9\.9\.9/);
    assert.match(text, /Codex CLI not detected/);
    assert.match(text, /Python \d+\.\d+\.\d+/);
    assert.match(text, /Node\.js \d+\.\d+\.\d+/);
    assert.doesNotMatch(text, new RegExp(h.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no home path");
    assert.doesNotMatch(text, /~\/|install →|slash command|Agent Skill|Check +Result +Action|\.md\b/);
  } finally { h.cleanup(); }
});

test("--help and --version stay plain even on a terminal; captured output never gets the banner", async () => {
  ui.resetBanner();
  for (const flag of ["--help", "--version"]) {
    const out = sink(true);
    assert.strictEqual(await main([flag], { env: UTF8, stdout: out, stderr: sink() }), 0);
    assert.doesNotMatch(out.text(), /\x1b|Your workspace/);
  }
  const r = spawnSync(process.execPath, [BIN, "--check"], { encoding: "utf8", env: { ...process.env, ...UTF8, HOME: "/nonexistent-bb-home" } });
  assert.doesNotMatch(r.stdout, /Your workspace|\x1b\[/, "piped stdout: no banner, no colour");
});

test("an interactive install: banner once, readiness panel, compact summary; no paths, no Action column, no agent list", async () => {
  ui.resetBanner();
  const h = tmpHome();
  try {
    fs.mkdirSync(path.join(h.home, ".claude"));  // simulated: Claude Code's config folder exists (CLI not on PATH)
    const out = sink(true, 100);
    const code = await main(["--no-login"], { env: { ...h.env, ...UTF8 }, stdin: new PassThrough(), stdout: out, stderr: sink() });
    assert.strictEqual(code, 0, out.text());
    const text = ui.stripAnsi(out.text());
    assert.strictEqual(count(text, TAGLINE), 1);
    assert.ok(text.indexOf(TAGLINE) < text.indexOf("SYSTEM READINESS"));
    assert.ok(text.indexOf("SYSTEM READINESS") < text.indexOf("INSTALLATION COMPLETE"));
    assert.match(text, new RegExp(`v${require("../package.json").version.replace(/\./g, "\\.")}`));
    assert.match(text, /✓ {2}Brewboard skill installed/);
    assert.match(text, /✓ {2}1 coding-agent integration configured\n +Claude Code\n/);
    assert.doesNotMatch(text, new RegExp(h.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no absolute paths");
    assert.doesNotMatch(text, /~\/|install →|installed: |Action|slash command|Agent Skill|backed up|Subcommands|start `claude`/);
    assert.ok(text.split("\n").length < 40, `compact: ${text.split("\n").length} lines`);
    // signed in + an agent configured: the one closing line
    assert.match(require("../lib/messages").ready(h.paths, ui.PLAIN), /Brewboard is ready\. Open your coding agent/);
  } finally { h.cleanup(); ui.resetBanner(); }
});

test("summary when nothing could be configured, and the not-ready message without agents", async () => {
  const h = tmpHome();
  try {
    const out = sink(false);
    assert.strictEqual(await main(["--no-login"], { env: h.env, stdin: new PassThrough(), stdout: out, stderr: sink() }), 0);
    assert.match(out.text(), /INSTALLATION COMPLETE/);
    assert.match(out.text(), /No coding agent configured/);
    assert.match(out.text(), /No coding agent detected: Brewboard is installed/);
    assert.match(require("../lib/messages").ready(h.paths, ui.PLAIN), /no coding agent is set up yet/);
  } finally { h.cleanup(); }
});

test("uninstall gets no banner", async () => {
  ui.resetBanner();
  const h = tmpHome();
  try {
    const out = sink(true);
    await main(["uninstall", "--dry-run"], { env: { ...h.env, ...UTF8 }, stdin: new PassThrough(), stdout: out, stderr: sink() });
    assert.doesNotMatch(out.text(), /Your workspace/);
  } finally { h.cleanup(); ui.resetBanner(); }
});

test("when sign-in falls back to this terminal, the banner is still shown only once", async () => {
  ui.resetBanner();
  const h = tmpHome();
  const srv = await mockServer();
  try {
    const tty = fakeTty();
    tty.output.isTTY = true;
    tty.output.columns = 100;
    const deps = { noGuiReason: () => null, findTerminal: () => ({ name: "ptyxis" }),
                   launchTab: async () => ({ ok: false, error: "ptyxis not found" }) };
    const run = main(["--login"], { env: { ...h.env, ...UTF8, NO_COLOR: "1" }, stdin: tty.input, stdout: tty.output, stderr: sink(), deps });
    await drive(tty, [{ waitFor: "server URL:", send: [srv.url, KEY.enter] },
                      { waitFor: "login ID or email:", send: ["dev@bb.test", KEY.enter] },
                      { waitFor: "password:", send: [PASSWORD, KEY.enter] }]);
    assert.strictEqual(await run, 0, tty.text());
    assert.strictEqual(count(tty.text(), TAGLINE), 1);
    assert.match(tty.text(), /✓ Brewboard authentication configured successfully\./);
    assert.doesNotMatch(tty.text(), /\x1b\[\d+(;\d+)*m/, "NO_COLOR: no colour codes");
  } finally { await srv.close(); h.cleanup(); ui.resetBanner(); }
});

test("very narrow terminals: the wordmark and tagline still fit (down to 16 columns)", () => {
  for (const width of [29, 24, 20, 16]) {
    const lines = ui.bannerLines({ width, version: "0.2.0" });
    assert.ok(lines.every((l) => l.length <= width), `${width}: ${JSON.stringify(lines)}`);
    assert.ok(lines.includes("v0.2.0"));
  }
  assert.deepStrictEqual(ui.logo(12), ["BREWBOARD"]);
  const out = new PassThrough();
  let text = "";
  out.on("data", (c) => (text += c));
  out.isTTY = true; out.columns = 22;
  ui.resetBanner();
  ui.printBanner(out, ui.createStyle(out, { ...UTF8, NO_COLOR: "1" }), { version: "0.2.0" });
  ui.resetBanner();
  assert.ok(text.split("\n").every((l) => l.length <= 22), JSON.stringify(text));
});
