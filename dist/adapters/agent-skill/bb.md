---
name: bb
description: "Use when the user types /bb or asks about Brewboard projects, tasks, tickets, cycles, time logging, minutes of meeting (MoM) or Brewboard search. Subcommands: init, list_projects, list_tasks, list_tickets, cycles, log_time, timesheets, create_mom, moms, show, find, status."
---
1. Read ~/.bb/skill/SKILL.md and follow it for the rest of this request.
2. The subcommand and its arguments are whatever the user wrote after /bb (`$bb` in Codex). If there is none, show the Brewboard home screen described in the "Menu" section of SKILL.md.
3. Signing in (`init --login`, or any request to sign in to Brewboard) follows the sign-in step of the init section: run `bb.py init --login --launch --format table`, which opens the sign-in in a new terminal. Never run `bb.py init --login` or `bb.py init` yourself: they need a real terminal for the hidden password prompt.
