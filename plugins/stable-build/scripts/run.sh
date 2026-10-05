#!/bin/sh
# stable-build hook launcher (Claude Code and Codex). Usage: sh run.sh <guard|session-start>
# Dormant until consent: exits 0 without starting node unless
# $STABLE_BUILD_HOME/config.json (default ~/.stable-build/config.json) contains "guard": true
# (any spaces or tabs around the colon, on one line; guard/consent.mjs applies the same test).
# Other keys never open the gate: a config.json that only saves "language" (install.sh) keeps both hooks
# dormant, and the scripts read that language (guard/prefs.mjs) only after this gate has passed.
# Fails open: exits 0 when node is missing, and always exits 0 after node, with node's stderr discarded,
# so a missing or broken plugin file (a module that cannot load, an old node) never shows as a hook
# error. The guard's findings go out as JSON on stdout (additionalContext for the agent, a one-line
# systemMessage for the user), never as exit 2.
H="${STABLE_BUILD_HOME:-$HOME/.stable-build}"
grep -Eq '"guard"[[:space:]]*:[[:space:]]*true' "$H/config.json" 2>/dev/null || exit 0   # consent gate, no node spawn
command -v node >/dev/null 2>&1 || exit 0                          # fail open
node "$(dirname "$0")/$1.mjs" 2>/dev/null                           # stdout passes through
exit 0                                                             # fail open, even if node could not load a module
