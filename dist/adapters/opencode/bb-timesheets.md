---
description: Brewboard - list my time logs
---
Run `/bb timesheets [period]` by reading ~/.bb/skill/SKILL.md and following its timesheets workflow. Execute only that workflow.

Resolve the period to absolute dates (default: the last 7 days) and fetch with `python3 ~/.bb/skill/scripts/bb.py timesheets --since <YYYY-MM-DD> [--until <YYYY-MM-DD>] --limit 10 --format table`. Always make a fresh `bb.py` call for this list, even if the same list was shown earlier in the conversation; never reuse earlier output. Print the output verbatim.

Period (may be empty):
$ARGUMENTS
