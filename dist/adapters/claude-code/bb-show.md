---
description: Brewboard - show one project, task, ticket, cycle, MoM or timesheet
argument-hint: "<project|task|issue|cycle|mom|timesheet> <ID>"
---
Run `/bb show <type> <ID>` by reading ~/.bb/skill/SKILL.md and following its show workflow. Execute only that workflow.

Fetch with `python3 ~/.bb/skill/scripts/bb.py get <type> <ID> --format table` (a fresh call every time) and print the output. For a task or ticket, first run "Task and ticket attachments" from SKILL.md (attachments and description files, opened), then print the record with an Attachments line.

Type and ID:
$ARGUMENTS
