---
description: Brewboard - list and select projects
---
Run `/bb list_projects`: follow the list_projects workflow and "Selecting records" in ~/.bb/skill/SKILL.md (read it if you have not).

Fetch with `python3 ~/.bb/skill/scripts/bb.py projects --limit 10 --format table`. Always make a fresh `bb.py` call for this list, even if the same list was shown earlier in the conversation; never reuse earlier output.

Record selection (same for this command and for the /bb menu): print the `--format table` output verbatim as chat text (heading, table, "Showing N of M" line, fetched-at line, prompt), then end your turn so the user types the ID. Do NOT use AskUserQuestion or any native selector to pick the record, do not number the rows, and do not re-type, summarise or trim the table. Accept only an ID from the ID column (case-insensitive); if the reply is not one, list the valid IDs and ask again. Exactly one record: show the table and select it; none: the output says so.

On a pick run `bb.py ctx set-project <IDENTIFIER> --file -` with `{"title": "<project name>"}` on stdin (quoted heredoc, see "Shell safety" in SKILL.md) (the ID column is the Brewboard project identifier) and confirm in one line.
