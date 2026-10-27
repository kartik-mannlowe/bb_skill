---
description: Brewboard - verify the current user and connection, sign in (--login) or sign out (--logout)
argument-hint: "[--login | --logout]"
---
Run `/bb init` by reading ~/.bb/skill/SKILL.md and following its init workflow. Execute only that workflow. If the arguments include `--login`, follow its sign-in step only: run `bb.py init --login --launch --format table`, which opens the sign-in in a new terminal, and print its output verbatim. Never run `bb.py init --login` or `bb.py init` yourself, not even with `!`: they need a real terminal for the hidden password prompt. If the arguments include `--logout`, follow its sign-out step only (`bb.py init --logout --format table`, output printed verbatim). Never ask the user to paste a password or API secret into the chat.

Arguments (may be empty):
$ARGUMENTS
