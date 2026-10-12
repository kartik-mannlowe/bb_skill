---
description: Brewboard - list and select tickets
argument-hint: "[status] [limit]"
---
Run `/bb list_tickets [status] [limit]`: follow the list_tickets workflow, "Task and ticket list arguments", "Selecting records" and "Task and ticket attachments" in ~/.bb/skill/SKILL.md (read it if you have not).

Fetch with `python3 ~/.bb/skill/scripts/bb.py tickets --limit <limit> --format table` (if no project is selected, run list_projects first). Always make a fresh `bb.py` call for this list, even if the same list was shown earlier in the conversation; never reuse earlier output. Default limit is 5; always pass `--limit`. If the last argument is an integer it is the limit, everything before it is the status. A limit that is not a positive integer (`0`, `-3`, `2.5`) is rejected: explain `/bb list_tickets [status] [limit]` and ask again. If a status was given, pass it too: `bb.py tickets --status "<status>" --limit <limit> --format table` (comma-separate several). If bb.py answers `bad_input` with a `valid` list, show those statuses and ask. Never filter, trim or re-sort the output yourself. Listing never downloads attachments.

Status and limit (may be empty):
$ARGUMENTS

Record selection (same for this command and for the /bb menu): print the `--format table` output verbatim as chat text (heading, table, "Showing N of M" line, fetched-at line, prompt), then end your turn so the user types the ID. Do NOT use AskUserQuestion or any native selector to pick the record, do not number the rows, and do not re-type, summarise or trim the table. Accept only an ID from the ID column (case-insensitive); if the reply is not one, list the valid IDs and ask again. Exactly one record: show the table and select it; none: the output says so.

Multi-select: accept several IDs or `all`. On a pick run `bb.py ctx set-tickets <ID> ... --titles ...`, then for each ticket, without being asked, `bb.py get issue <ID>`, `bb.py attachments issue <ID> --download "$(mktemp -d)"` and `bb.py download "<url>" --dir <same dir>` for each file or image referenced in the description; open what was downloaded (screenshots are working context). Only then summarise each ticket with an Attachments line. Never invent attachments; say when one exists but could not be retrieved.
