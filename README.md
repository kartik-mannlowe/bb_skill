# Brewboard Skill

One command installs the Brewboard `/bb` skill for **Claude Code, Codex CLI, OpenCode and
Antigravity CLI** and signs you in to your Brewboard (ERPNext) server. You can then work with your
Brewboard projects, tasks, tickets, cycles, time logs and minutes of meeting from inside your coding
agent.

```bash
npx --yes --package=github:kartik-mannlowe/bb_skill brewboard-skill
```

## What it does

1. **System check (read-only).** Checks the OS, Node.js, Python, write access, disk space, which
   coding agents are installed, which terminal can host the sign-in, an existing installation,
   and whether a saved Brewboard sign-in still works. A missing prerequisite stops here and
   nothing is changed. A missing agent only means that agent is skipped.
2. **Install.** Copies the skill to `~/.bb/skill/` and adds the integration for every detected
   agent (table below). Other commands, skills and settings are left alone. Any Brewboard file
   that is replaced is first copied to `~/.bb/backups/`. Running it again changes nothing unless
   the package changed.
3. **Sign in, if needed.** If there is no working sign-in, it asks:

   ```
   Brewboard authentication required

   Would you like to sign in to Brewboard now?
   ❯ Yes — open a new terminal tab to configure authentication
     Cancel — exit the login workflow
   ```

   **Yes** opens a terminal tab (Ptyxis, GNOME Terminal, Konsole or Xfce Terminal) that asks for
   your server URL, your login ID or email, and your password (hidden). Over SSH, in a container or
   without a desktop it runs in the current terminal instead. **Cancel** asks for nothing and
   changes nothing.
4. **Start your agent** in a new terminal tab and use `/bb`.

Example system check:

```
System check
      Check              Result                     Action
  ok  Operating system   linux 7.0.0 (x64)
  ok  Node.js            24.21.0
  ok  Python             3.14.4 (python3)
  ok  Claude Code        installed 2.1.296          install → ~/.claude/commands/*.md (slash commands)
  --  Codex CLI          not installed              skipped; rerun after installing it
  ok  OpenCode           installed 1.18.35          install → ~/.config/opencode/commands/*.md + ~/.agents/skills/bb
  ok  Antigravity CLI    installed 1.3.3            install → ~/.gemini/config/skills/bb/SKILL.md
  ok  Terminal           new tab via ptyxis         sign-in opens a new tab
  --  Brewboard sign-in  missing                    offer sign-in
```

## Agents

| Agent | Installed to | How you use it | Verified |
|---|---|---|---|
| Claude Code | `~/.claude/commands/bb.md` and `bb-*.md` | `/bb` (menu), `/bb list_tasks …`, shortcuts `/bb-list_tasks`, `/bb-log_time`, … | commands load in Claude Code 2.1.296 |
| Codex CLI | `~/.agents/skills/bb/SKILL.md` (user Agent Skill) | `$bb list_tasks …`, or ask about Brewboard in plain words. Codex has no custom slash commands. | discovered by Codex 0.162.1 (`codex debug prompt-input`) |
| OpenCode | `~/.config/opencode/commands/bb*.md` + the shared `~/.agents/skills/bb` | `/bb`, `/bb list_tasks …`, shortcuts `/bb-list_tasks`, … | commands and one `bb` skill discovered by OpenCode 1.18.35 (`opencode debug config` / `debug skill`) |
| Antigravity CLI | `~/.gemini/config/skills/bb/SKILL.md` (global skill) | `/bb list_tasks …` (a skill is a slash command) | discovered by agy 1.3.3 (`agy -p /skills`) |

All four read the same skill (`~/.bb/skill/SKILL.md`) and talk to Brewboard only through its
whitelisted HTTP API (`brewboard_backend.api.*`); no MCP server is involved. OpenCode also loads
skills from `~/.agents/skills`, so Brewboard does not put a second `bb` skill in
`~/.config/opencode/skills` (that would make two skills with the same name). Copies left there or
in `~/.gemini/antigravity-cli/skills` by older manual installs are moved to the backup folder.

Install for some agents only: `--agents claude,codex` (ids: `claude`, `codex`, `opencode`,
`antigravity`). An agent installed later is added the next time you run the command.

## Requirements

| | |
|---|---|
| OS | Linux or macOS (Windows: use WSL) |
| Node.js | 18.17 or newer |
| Python | 3.8 or newer, as `python3`, with `ssl` (the skill's client `bb.py` uses only the standard library) |
| Agents | any of the four above (none is required to install; each is optional) |
| Brewboard | a server running the `brewboard_backend` app, and a Brewboard user with a BB role |

## Sign-in and credential storage

- The server URL must use `https://`. Plain `http://` is accepted only for `localhost` /
  `127.0.0.1` / `::1`. Redirects are refused, so the password cannot be forwarded elsewhere.
- Before asking for anything, it checks that the server is a Brewboard backend
  (`GET /api/method/brewboard_backend.api.health.ping`). It never falls back to a generic ERPNext
  login.
- It signs in with **`POST /api/method/brewboard_backend.api.auth.login_and_get_keys`**, then
  checks the returned key and secret with `auth.get_current_user` before saving them.
- Saved to `~/.bb/config.json` (directory `0700`, file `0600`, written atomically): server URL,
  API key and secret, and non-secret details (time, user, credential ID and expiry). The password
  is never stored or logged, and never passed as an argument, environment variable or URL.
- The installed `bb.py` must accept the saved file before success is reported; otherwise the
  previous configuration is restored. Only one sign-in can run at a time.
- `--check` and every normal run only *read* the saved sign-in. Nothing signs in or rotates a
  credential on its own.

### Per-client credentials vs. one shared secret

Brewboard servers with **per-client credentials** (the *Brewboard API Credential* DocType) give
the CLI its own credential: signing in here does not sign you out of the web UI, and vice versa.
**Older servers keep one API secret per account and replace it on every sign-in.** The installer
detects this *before* asking for your password, explains that continuing will sign you out of the
web UI (and that a later web UI sign-in will sign the CLI out), and sends nothing unless you
choose **Continue**.

## Commands

```bash
npx --yes --package=github:kartik-mannlowe/bb_skill brewboard-skill               # check, install/update, sign-in if needed
npx --yes --package=github:kartik-mannlowe/bb_skill brewboard-skill --check       # read-only system + sign-in check
npx --yes --package=github:kartik-mannlowe/bb_skill brewboard-skill --login       # sign in (again) now, in a new tab
npx --yes --package=github:kartik-mannlowe/bb_skill brewboard-skill --login --here  # sign in inside this terminal
npx --yes --package=github:kartik-mannlowe/bb_skill brewboard-skill --agents claude,opencode
npx --yes --package=github:kartik-mannlowe/bb_skill brewboard-skill --no-login    # install/update only
npx --yes --package=github:kartik-mannlowe/bb_skill brewboard-skill --uninstall
npx --yes --package=github:kartik-mannlowe/bb_skill brewboard-skill --help | --version
```

`--check` exits 0 when everything works, 3 when you are not signed in, and 1 when a prerequisite
is missing.

Brewboard subcommands (what works depends on your Brewboard role): `init`, `list_projects`,
`list_tasks [status] [limit]`, `list_tickets` (`tickets`), `cycles`, `log_time`, `timesheets`,
`create_mom`, `moms`, `show <type> <ID>`, `find <query>`, `status`.

## Recovering from problems

| You see | Do |
|---|---|
| *Cannot install: … Nothing was changed.* | Fix the listed prerequisite (Node.js, Python, permissions, disk) and run again. |
| An agent shows `FAILED` | The others are installed; fix that agent's directory permissions and run again. |
| *the saved credentials are no longer accepted* | `--check` shows why (revoked, expired, or on older servers replaced by a later sign-in); then `--login`. |
| *does not serve the Brewboard backend API* | Use your Brewboard backend URL. |
| *Refusing plain http://* | Use `https://`. |
| *Invalid login ID or password* | Retry (3 attempts per run). Repeated failures may lock the account (server policy). |
| *Two-factor authentication is enabled* | The server refuses API sign-in for 2FA accounts; ask an administrator. |
| No tab opens / SSH / container | `--login --here`. |
| *Another Brewboard sign-in is already running* | Finish or close that tab (a stale lock clears after 30 minutes). |

## Uninstalling

```bash
python3 ~/.bb/skill/scripts/bb.py logout     # optional: revoke this CLI's credential on the server first
npx --yes --package=github:kartik-mannlowe/bb_skill brewboard-skill --uninstall
```

`--uninstall` removes `~/.bb/skill/` and exactly the agent files recorded in `~/.bb/installed.json`
that are unchanged since Brewboard wrote them. A file you edited is kept and listed. Your other
commands and skills, the agents' own folders, `~/.bb/config.json`, `~/.bb/state.json` and
`~/.bb/backups/` are kept. Delete those yourself when you no longer need them.

## Development

```bash
npm test                 # unit + integration tests: temporary HOMEs, mock Brewboard server, and
                         # real-CLI discovery checks for any agent installed here (BB_SKIP_AGENT_E2E=1 skips them)
npm run check-sync       # dist/ still matches the canonical connector?
npm run pack:check       # what `npm pack` would ship (allowlist + secret patterns)
npm pack && HOME=$(mktemp -d) npx --yes --package=./brewboard-skill-0.1.0.tgz brewboard-skill --check
```

### Keeping the skill in sync

`dist/` is generated from the canonical Brewboard connector (`brewboard_skill/files/bb-connector`):
the skill (`skill/brewboard`), the Claude Code and OpenCode command adapters, and the Agent Skill
pointer. Edit them there, run the connector's `./sync-copies.sh` (it generates the OpenCode
adapters), then here:

```bash
npm run sync             # copies only the allowlisted files; rewrites dist/manifest.json (sha256 per file)
npm test                 # includes the drift check
```

`BB_CONNECTOR_SRC=/path/to/bb-connector` points the sync at another checkout. The installer refuses
a `dist/` file whose hash does not match the manifest.

### Releasing

1. `npm run sync`, `npm test`, `npm run pack:check`.
2. Bump `version` in `package.json` (semver), commit, and push to `main`. Users get it from the
   next `npx` run. To pin a release, tag it and use
   `github:kartik-mannlowe/bb_skill#v0.1.0`.
3. npm registry publication is not set up: `"private": true` stays until a license is chosen and
   the package name is checked on npm.

## License

No license has been granted (`"license": "UNLICENSED"`). The skill comes from the internal
Brewboard connector, which has no license file. Choose one before distributing outside your
organisation.
