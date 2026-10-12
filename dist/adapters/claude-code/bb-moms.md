---
description: Brewboard - list and open minutes of meeting
argument-hint: "[search]"
---
Run `/bb moms [search]` by reading ~/.bb/skill/SKILL.md and following its moms workflow. Execute only that workflow.

Fetch with `python3 ~/.bb/skill/scripts/bb.py moms [--search "<text>"] --limit 10 --format table` (if no project is selected, run list_projects first, unless the user wants all projects: `--all-projects`). Always make a fresh `bb.py` call for this list, even if the same list was shown earlier in the conversation; never reuse earlier output. Print the output verbatim and end your turn so the user types a MoM ID; then `bb.py get mom <ID> --format table`. Do NOT use AskUserQuestion to pick a record and never offer row numbers.

Search (may be empty):
$ARGUMENTS
