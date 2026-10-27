---
description: Brewboard - verify the current user and connection, or sign out (--logout)
---
Run `/bb init` by reading ~/.bb/skill/SKILL.md and following its init workflow. Execute only that workflow. If the arguments include `--logout`, follow its sign-out step only (`bb.py init --logout --format table`, output printed verbatim). Never ask the user to paste an API secret or password into the chat: they run `python3 ~/.bb/skill/scripts/bb.py init` (or `init --login`) in their own terminal.

Arguments (may be empty):
$ARGUMENTS
