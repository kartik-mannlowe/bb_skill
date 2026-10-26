---
description: Brewboard - search tasks, tickets, meetings, time logs, projects and cycles
argument-hint: "<query>"
---
Run `/bb find` by reading ~/.bb/skill/SKILL.md and following its find workflow. Execute only that workflow. Run `python3 ~/.bb/skill/scripts/bb.py find '<keywords>' --format table` (keywords as in "Shell safety" in SKILL.md) afresh and print the output, including its "Searched:" line. When a found task or ticket is the record the answer is about, or the user selects one by ID, apply "Task and ticket attachments" from SKILL.md to it automatically before answering or working on it.

Query:
$ARGUMENTS
