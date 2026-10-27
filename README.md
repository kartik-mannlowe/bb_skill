# Brewboard Skill

Brewboard Skill adds a `/bb` command to your coding agent. It lets you work with Brewboard, the ERPNext-based project and time-tracking service, without leaving the terminal: browse projects, tasks and tickets, log time, write minutes of meeting, and search across all of them.

This repository contains the one-line installer and the skill it installs. The skill talks to an existing Brewboard backend over that backend's HTTP API. The backend itself is not part of this repository.

Supported agents: **Claude Code**, **Codex CLI**, **OpenCode** and **Antigravity CLI**.

## Features

- **Projects, tasks and tickets:** list them with status filters and a row limit, select one by its ID, and open any record with `show`. Selecting a task or ticket also retrieves its attachments.
- **Cycles:** browse the cycles of the selected project.
- **Time logging:** log time on a task (or on a new task created in the same step) and list your recent time logs. Time logs are saved as Draft.
- **Minutes of meeting:** draft minutes from notes or a transcript and save them, optionally turning open action items into tasks. You can also list and search earlier minutes.
- **Search:** find tasks, tickets, minutes, time logs, projects and cycles.
- **Changes after confirmation:** update task and ticket fields, your own draft time logs, and minutes. Every write is shown to you first and runs only after you confirm.
- **Saved working context:** the selected project, task and tickets are remembered between sessions.
- **Sign-in and connection checks:** `/bb init` verifies the server, the credential and your Brewboard roles. `/bb init --login` opens the sign-in in a new terminal, and `/bb init --logout` signs you out.
- **Installer:** a read-only system check, install and update for every detected agent, guided sign-in, recovery, and an uninstall that removes only what the installer added.

The Brewboard API does not offer some operations: submitting or cancelling timesheets, time logs without a task, logging time for another employee, deleting tasks, tickets or time logs, and editing projects. The skill refuses these with `api_unsupported` before sending anything to the server.

## Requirements

- **Linux or macOS.** Windows is not supported; use WSL.
- **Node.js 18.17 or newer**, to run the installer through `npx`.
- **Python 3.8 or newer** as `python3`. The skill's client uses only the standard library, so there are no Python packages to install.
- **Git**, which `npx` uses to fetch the installer from GitHub.
- **At least one supported coding agent**, installed and run at least once.
- **A Brewboard backend** that you can reach (over HTTPS; plain HTTP is accepted only for `localhost`), plus a Brewboard account. Your Brewboard role decides what you can do: Project Managers and Project Users can log time and write minutes.

## Quick start

### 1. Install

```sh
npx --yes --package=github:kartik-mannlowe/bb_skill brewboard-skill
```

The installer:

1. Shows a read-only system check: operating system, Node.js, Python, permissions, detected agents and the saved sign-in.
2. Installs the skill and configures every detected agent. An agent counts as detected when its command is on your `PATH` or its configuration folder exists. Use `--agents claude,codex` to configure only some of them.
3. Checks whether you are signed in. If you are not, it offers to sign you in now.

To see the check without installing anything, add `--check`.

### 2. Sign in

Sign-in asks for your Brewboard server URL, your login ID and your password. The password is hidden as you type, and it is never saved.

On a Linux desktop, sign-in opens in a new terminal tab or window. Otherwise, or with `--here`, it runs in the current terminal. To sign in again later, use `/bb init --login` from your coding agent (see [Signing in from your coding agent](#signing-in-from-your-coding-agent)), or the installer:

```sh
npx --yes --package=github:kartik-mannlowe/bb_skill brewboard-skill --login          # new terminal tab or window
npx --yes --package=github:kartik-mannlowe/bb_skill brewboard-skill --login --here   # this terminal (SSH, no desktop)
```

### 3. Use it

Start your coding agent as usual and open the Brewboard menu:

```text
/bb
```

The menu shows your saved sign-in and context, and offers every workflow (Projects, Tasks, Tickets, Cycles, Log Time, Time Logs, Create MoM, Meetings, Find, Status and Authentication). You can also call a workflow directly:

```text
/bb init                    check the connection and who you are signed in as
/bb init --login            sign in, in a new terminal tab or window
/bb list_projects           pick the project to work on
/bb list_tasks Open 10      open tasks of the selected project (default limit: 5)
/bb list_tickets            tickets of the selected project
/bb log_time 2h API review  log time; you confirm before anything is saved
/bb init --logout           sign out
```

Lists are printed as tables. To select a record, type its ID (for example `TASK-2026-00009`).

In **Codex**, write `$bb` instead of `/bb` (for example `$bb list_tasks`). Codex has no custom slash commands.

## Supported agents

| Agent | How to use it | Tested with |
|---|---|---|
| Claude Code | `/bb`, `/bb <subcommand>`, plus shortcuts such as `/bb-list_tasks`, `/bb-log_time` and `/bb-init --login` | 2.1.296 |
| Codex CLI | `$bb <subcommand>`, or ask about Brewboard in plain words | 0.162.1 |
| OpenCode | `/bb`, `/bb <subcommand>`, the same `/bb-…` shortcuts, or plain words | 1.18.35 |
| Antigravity CLI | `/bb <subcommand>`, or plain words | 1.3.1 |

The system check warns when an installed agent is older than the version it was tested with. If you install an agent after Brewboard, run the install command again.

## Authentication and security

- **Per-client credential.** Signing in creates a credential for this CLI only, so signing in or out of the Brewboard web UI does not affect it. It lasts until it expires (the server sets the lifetime) or is revoked.
- **Older backends.** If a backend cannot issue per-client credentials, the installer explains that signing in would replace your account's single API secret, which also signs out the web UI. It continues only if you confirm.
- **Where it is saved.** The credential and server URL are stored in `~/.bb/config.json` with mode `600`. Your password is never stored. The skill never asks for a password or secret in the agent chat, and never prints the config file there.
- **Environment variables.** `BB_URL`, `BB_API_KEY` and `BB_API_SECRET`, if set, override the saved configuration.
- **Redirects.** The client never follows HTTP redirects, because a redirect could send your credentials to another server. A redirecting address fails with `redirect_refused`.

### Signing in from your coding agent

Signing in asks for a hidden password, which needs a real terminal. A coding agent runs commands without one, so `/bb init --login` opens a terminal for you:

1. Type `/bb init --login`. In Codex, type `$bb init --login`. In Claude Code and OpenCode, `/bb-init --login` works too.
2. A new terminal tab or window opens and runs the Brewboard sign-in. Enter the server URL (press Enter to keep the saved one), your login ID and your password **in that terminal**. Never type them into the agent chat; the agent never asks for them.
3. When the terminal says you are signed in, press Enter to close it, go back to the agent and run `/bb init` to check the connection.

The agent reports only that the sign-in terminal opened. It does not report the sign-in result itself, so `/bb init` is how you confirm it. If a sign-in terminal is already open, running `/bb init --login` again opens nothing new.

**Which terminal opens.** The terminal you are working in, if it can run a command in a new tab or window; otherwise your system's default terminal; otherwise the first supported terminal installed. Set `BB_TERMINAL` to one of the names below to choose one, or to `none` to never open a terminal.

| Opens | `BB_TERMINAL` names | Verified |
|---|---|---|
| A new tab | `ptyxis` | Yes: Ptyxis on an Ubuntu desktop session (Wayland) |
| A new tab | `gnome-terminal`, `konsole`, `xfce4-terminal` | No |
| A new window | `kitty`, `alacritty`, `foot`, `xterm`, `x-terminal-emulator` (your system's default terminal) | No |

Terminals that cannot start a command in a new tab from the command line, such as Warp, are not used; the sign-in opens in another supported terminal instead.

**When no terminal can be opened** (over SSH, in a container, without a graphical session, on macOS, or with no supported terminal installed), `/bb init --login` explains why and shows the exact command to run in a terminal of your own, for example:

```sh
python3 ~/.bb/skill/scripts/bb.py init --login
```

Opening a terminal is implemented for Linux desktops only; on macOS you always get this manual command. Codex runs commands in a sandbox, which may prevent it from opening a terminal; this has not been tested, and you then get the manual command too.

**What the new terminal receives.** Only the command that starts the sign-in, as an argument list with no shell involved. Passwords and API secrets are never put on a command line, and the `BB_URL`, `BB_API_KEY` and `BB_API_SECRET` overrides are removed from the new terminal's environment.

### Signing out

`/bb init --logout` (or `python3 ~/.bb/skill/scripts/bb.py init --logout` in a terminal) removes the saved credential from `~/.bb/config.json`. It keeps the server URL and your selected project, task and tickets. What happens on the server depends on the kind of credential:

- **A per-client credential** created by sign-in is revoked on the server too. The output says so only when the server confirms it.
- **Your account's own API key pair**, if you configured one, is removed only on this computer. It stays valid on the server until it is rotated, and the output says so.

Signing out when you are already signed out is not an error. If the config file cannot be written, the command fails with `file_error` and reports that nothing was removed.

To see or revoke the credentials of your other signed-in clients, run `python3 ~/.bb/skill/scripts/bb.py credentials` (with `--revoke <ID>` or `--revoke-others`).

## Updating

Run the install command again. It updates the skill and the agent integrations. Before replacing a file, it copies the old version to `~/.bb/backups/install-<time>/`, keeping only the most recent of these backups. Files that existed before Brewboard was first installed are kept in `~/.bb/backups/originals/`, and uninstall puts them back.

## Uninstalling

```sh
npx --yes --package=github:kartik-mannlowe/bb_skill brewboard-skill uninstall --dry-run   # preview
npx --yes --package=github:kartik-mannlowe/bb_skill brewboard-skill uninstall             # asks, then removes
```

Uninstall removes only the files the installer recorded, and only if they are unchanged. It puts back files that were there before Brewboard, and deletes the saved sign-in only if the installer created it. Options:

- `--force`: also remove installer-created files that you changed.
- `--remove-backups`: also delete the update backups.
- `--yes`: skip the confirmation. Required when not running in a terminal.

The exit code is `2` when something was kept.

## Troubleshooting

Start with the read-only check. It exits with `3` when you are not signed in:

```sh
npx --yes --package=github:kartik-mannlowe/bb_skill brewboard-skill --check
```

| Symptom | What to do |
|---|---|
| `npm error … An unknown git error occurred` | Git is missing. Install Git, then run the command again. |
| `Cannot install: …` (missing Python, old Node.js, unwritable home or `~/.bb`) | Fix the item the check names, then run the installer again. Nothing was changed. |
| An agent shows as "not detected" | Install the agent (its command must be on `PATH`) or run it once so its configuration folder exists, then run the installer again. |
| "No coding agent configured" | The skill is installed but no agent was found. Add a supported agent and run the installer again. |
| `not_configured` | You are not signed in. Run `/bb init --login` in your agent, or the installer with `--login`. |
| `credentials_rejected` | The server no longer accepts the saved credential (expired or revoked). Sign in again with `/bb init --login`. |
| `terminal_unavailable` | `/bb init --login` could not open a terminal; the message says why. Run the command it shows in a terminal of your own. |
| "A Brewboard sign-in is already open in another terminal" | Finish the sign-in in that terminal, then run `/bb init`. If you closed it, try again after a minute. |
| `unreachable` | Check the server URL, your VPN, and that the Brewboard server is running. |
| `not_brewboard` | The URL answers but is not a Brewboard backend. Sign in again with the right address. |
| `redirect_refused` | The saved address redirects elsewhere. Sign in again with the address it redirects to. |
| `forbidden` | Your Brewboard role or project membership does not allow the operation. Ask a project manager. |
| `write_outcome_unknown` | A write was sent but no answer came back. Check your time logs or minutes before retrying. |
| The installer cannot open a sign-in tab | Use `--login --here` to sign in in the current terminal. |
| "Another Brewboard sign-in is already running" | Finish or close the other sign-in first. |
| "installed files do not match the package" | The installed files failed their integrity check. Run the installer again. |

`npx --yes --package=github:kartik-mannlowe/bb_skill brewboard-skill --help` lists every installer option and the files it manages.

## Development

The repository is self-contained: the installer, the skill and its Python client, the agent adapters, the build step that generates some of them, the tests and the package-integrity checks. It does not depend on any other checkout.

```text
bin/, lib/                 the npx installer (Node.js, no dependencies)
dist/skill/                the skill: SKILL.md, the bb.py client, reference and assets
dist/adapters/             agent adapters (Claude Code, OpenCode, shared Agent Skill)
dist/manifest.json         sha256 and file mode of every packaged file
scripts/                   build and verification tools (not packaged)
test/                      Node.js tests; test/python holds the Python client tests
```

| Command | Purpose |
|---|---|
| `npm run build` | Regenerates the OpenCode commands from the Claude Code ones and rewrites `dist/manifest.json`. Run it after editing anything in `dist/`. |
| `npm test` | Runs all Node.js tests and the Python client tests. Needs `python3`. |
| `npm run check-dist` | Read-only check that `dist/` matches its manifest and that the generated files are current. |
| `npm run pack:check` | Lists what `npm pack` would include and fails on anything outside the allowlist or anything that looks like a secret or local file. |

Tests run against temporary home directories and a mock backend. They never touch your real `~/.bb` or a real server. The agent discovery tests in `test/agents-e2e.test.js` run only for the agent CLIs installed on your machine; set `BB_SKIP_AGENT_E2E=1` to skip them. Because the minimum supported Node.js version is 18.17, also run the suite on Node 18 before a release, for example with `nvm exec 18 npm test`.

## Version and status

The package version is `0.2.0`, defined in `package.json`. The package is private and not published to npm. The install command always installs the current `main` branch of this repository, which may include changes made after the `0.2.0` release commit.
