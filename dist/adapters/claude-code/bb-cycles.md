---
description: Brewboard - list cycles and their tasks
argument-hint: "[status]"
---
Run `/bb cycles [status]` by reading ~/.bb/skill/SKILL.md and following its cycles workflow. Execute only that workflow.

Fetch with `python3 ~/.bb/skill/scripts/bb.py cycles --limit 10 --format table` (add `--status Active|Upcoming|Completed` if given; if no project is selected, run list_projects first). Always make a fresh `bb.py` call for this list, even if the same list was shown earlier in the conversation; never reuse earlier output. Print the output verbatim and end your turn so the user types a cycle ID; then `bb.py get cycle <ID> --format table`. Do NOT use AskUserQuestion to pick a record and never offer row numbers.

Status (may be empty):
$ARGUMENTS
