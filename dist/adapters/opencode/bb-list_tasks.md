---
description: Brewboard - list and select tasks
---
Run `/bb list_tasks [status] [limit]`: follow the list_tasks workflow, "Task and ticket list arguments", "Selecting records" and "Task and ticket attachments" in ~/.bb/skill/SKILL.md (read it if you have not).

Fetch with `python3 ~/.bb/skill/scripts/bb.py tasks --limit <limit> --format table` (if no project is selected, run list_projects first). Always make a fresh `bb.py` call for this list, even if the same list was shown earlier in the conversation; never reuse earlier output. Default limit is 5; always pass `--limit`. If the last argument is an integer it is the limit, everything before it is the status. A limit that is not a positive integer (`0`, `-3`, `2.5`) is rejected: explain `/bb list_tasks [status] [limit]` and ask again. If a status was given, pass it too: `bb.py tasks --status '<status>' --limit <limit> --format table` (comma-separate several). If bb.py answers `bad_input` with a `valid` list, show those statuses and ask. Never filter, trim or re-sort the output yourself. Listing never downloads attachments.

Status and limit (may be empty):
$ARGUMENTS

Record selection (same for this command and for the /bb menu): print the `--format table` output verbatim as chat text (heading, table, "Showing N of M" line, fetched-at line, prompt), then end your turn so the user types the ID. Do NOT use a question tool or any native selector to pick the record, do not number the rows, and do not re-type, summarise or trim the table. Accept only an ID from the ID column (case-insensitive); if the reply is not one, list the valid IDs and ask again. Exactly one record: show the table and select it; none: the output says so.

On a pick run `bb.py ctx set-task <ID> --file -` with `{"title": "<subject>"}` on stdin (quoted heredoc, see "Shell safety" in SKILL.md), then, without being asked, `bb.py get task <ID>`, `bb.py attachments task <ID> --download "$(mktemp -d)"` and `bb.py download '<url>' --dir <same dir>` (URL percent-encoded, single-quoted) for each file or image referenced in the description; open what was downloaded (screenshots are working context). Only then give a 2 to 4 line brief with an Attachments line. Never invent attachments; say when one exists but could not be retrieved.
