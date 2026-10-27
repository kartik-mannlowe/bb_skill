---
description: Brewboard - log work time
argument-hint: "[duration] [work description]"
---
Run `/bb log_time` by reading ~/.bb/skill/SKILL.md and following its log_time workflow. Execute only that workflow. Every log needs a task (Brewboard has no project-only logs). If a project or task must be picked, print the `--format table` output and let the user type the ID (no AskUserQuestion, no row numbers). Before creating anything, always print the full time-log confirmation table with the actual values (a new task shows as `NEW: "..."`), then ask in plain text "Create this time log? Yes / Change / Cancel" and end your turn so the user types the answer. Run `bb.py log-time ... --format table` once and print its output verbatim; never re-run it after `write_outcome_unknown` or `server_error` without checking `bb.py timesheets` first.

Arguments:
$ARGUMENTS
