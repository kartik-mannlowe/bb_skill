---
description: Brewboard - projects, tasks, tickets, cycles, time, meetings and search
---
Run the /bb Brewboard workflow. Read ~/.bb/skill/SKILL.md and follow it.

Subcommand and arguments: $ARGUMENTS

If no subcommand was given, show the Brewboard home screen exactly as the "Menu" section of SKILL.md describes: use your native selection UI if you have one (paged as in SKILL.md), otherwise the numbered list SKILL.md describes for other agents.

All Brewboard data comes from `python3 ~/.bb/skill/scripts/bb.py`, which calls the Brewboard backend's whitelisted HTTP API. Do not use MCP tools or call ERPNext URLs yourself for Brewboard data.

Menu routing: each option runs the SKILL.md workflow of the same name, exactly as its direct command does. The native selector is only for this menu. When Projects, Tasks, Tickets, Cycles, Time Logs or Meetings is chosen (now or later in the conversation), fetch afresh with `bb.py ... --format table` (Tasks and Tickets: `--limit 5` unless the user gives a limit, as in "Task and ticket list arguments"), print the output verbatim, and end your turn so the user types the record ID. Do NOT use a question tool to pick a record and never offer row numbers. The `Sel` column marks an already-selected record with `*`; the ID column holds only the record ID.

Attachments: whenever a task or ticket becomes the active record (picked from the menu, a direct command, find, show, or named by ID), follow "Task and ticket attachments" in SKILL.md automatically before any work: `bb.py get`, `bb.py attachments <type> <ID> --download <tmpdir>`, and `bb.py download` for files in the description; open what was downloaded. Same behaviour for the menu and the direct commands.
