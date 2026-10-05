#!/usr/bin/env bash
# Install round trip for install.sh.
#
#   test/install/roundtrip.sh
#       Host-free (CI default). fake-bin/{claude,codex,arc-studio} log every argv and emulate
#       list/get output from state files. Scenarios: install -> reinstall (read calls only) ->
#       update -> ref switch -> uninstall on a seeded --prefix; pre-existing Circle/Arc Studio/
#       marketplace entries are kept; no-TTY and agent-session runs skip third-party installs;
#       Claude-only host with 0 Circle skills; dry runs; bad flags; root refusal; truncated
#       downloads; uninstall keeps foreign files in STABLE_BUILD_HOME; CDPATH; quoted one-liners.
#       Languages (L*): a pt-BR lifecycle whose saved choice is reused by --update and --uninstall;
#       --lang (both forms, every alias), STABLE_BUILD_LANG, LC_ALL/LC_MESSAGES/LANG detection and
#       their precedence; invalid values exit 1; a config.json created only for the language is
#       removed on uninstall; an invalid config.json; no --prefix. TTY: the language prompt on a
#       pseudo-terminal (tty-drive.py, needs python3): choosing 2 makes the rest Portuguese.
#
#   test/install/roundtrip.sh --real-claude [--circle-source=DIR] [--source=DIR]
#       The same lifecycle with the real `claude` binary, local-path marketplaces only (a
#       generated fixture by default, or --source=DIR such as the repo root), Circle from
#       --circle-source=DIR (a local circlefin/skills clone) or skipped. codex and arc-studio are
#       kept off PATH. Also runs `claude plugin validate --strict` on the fixtures (and, for
#       information, on the repo root), and a pt-BR install whose saved language the rerun and the
#       uninstall reuse.
#
#   --keep   keep the work directory for inspection
#
# Every installer run uses `env -i`, a throwaway HOME and --prefix inside a mktemp directory, and
# STABLE_BUILD_NO_TTY=1 unless a test is about the terminal (so a run from an interactive shell
# never stops at a prompt). The real ~/.claude, ~/.codex and ~/.stable-build are never read or written.
#
# shellcheck disable=SC2317,SC2329 # predicates below run indirectly through check()
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd -P)
ROOT=$(cd "$HERE/../.." && pwd -P)
INSTALL="$ROOT/install.sh"
FAKEBIN="$HERE/fake-bin"
SEED="$HERE/seed"

REAL_CLAUDE=0; CIRCLE_SOURCE=''; SB_SOURCE=''; KEEP=0
for a in "$@"; do
  case "$a" in
    --real-claude) REAL_CLAUDE=1 ;;
    --circle-source=*) CIRCLE_SOURCE=${a#--circle-source=} ;;
    --source=*) SB_SOURCE=${a#--source=} ;;
    --keep) KEEP=1 ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 2; }
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sb-roundtrip.XXXXXX")
WORK=$(cd "$WORK" && pwd -P)
cleanup() { if [ "$KEEP" = 1 ]; then echo "work dir kept: $WORK"; else rm -rf "$WORK"; fi; }
trap cleanup EXIT

PASS=0; FAILS=0
ok() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$*"; }
bad() { FAILS=$((FAILS + 1)); printf '  FAIL  %s\n' "$*"; }
check() { local desc=$1; shift; if "$@"; then ok "$desc"; else bad "$desc"; fi; }
section() { printf '\n== %s\n' "$*"; }

# ---------------------------------------------------------------- tools on PATH
TOOLS="$WORK/tools"; mkdir -p "$TOOLS"
ln -s "$(command -v node)" "$TOOLS/node"
if command -v git >/dev/null 2>&1; then ln -s "$(command -v git)" "$TOOLS/git"; HAVE_GIT=1; else HAVE_GIT=0; fi
SYS_PATH=/usr/bin:/bin
LOG="$WORK/argv.log"; : >"$LOG"
OUT="$WORK/out.txt"

# ---------------------------------------------------------------- fixtures
write() { mkdir -p "$(dirname "$1")"; cat >"$1"; }
git_commit() {
  [ "$HAVE_GIT" = 1 ] || return 0
  (cd "$1" && git -c init.defaultBranch=master init -q . && git add -A \
    && git -c user.name=fixture -c user.email=fixture@example.invalid commit -qm fixture)
}
make_circle() { # $1 dir, $2 version, rest: skill names
  local d=$1 v=$2 s; shift 2
  write "$d/.claude-plugin/marketplace.json" <<'EOF'
{"name":"circle","owner":{"name":"fixture"},"metadata":{"description":"Test fixture standing in for circlefin/skills"},"plugins":[{"name":"circle-skills","source":"./plugins/circle","description":"Fixture"}]}
EOF
  write "$d/.agents/plugins/marketplace.json" <<'EOF'
{"name":"circle-skills","interface":{"displayName":"Circle Skills"},"plugins":[{"name":"circle","source":{"source":"local","path":"./plugins/circle"},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"Coding"}]}
EOF
  write "$d/plugins/circle/.claude-plugin/plugin.json" <<EOF
{"name":"circle","version":"$v","description":"Fixture","author":{"name":"fixture"},"license":"Apache-2.0"}
EOF
  for s in "$@"; do
    local extra=''
    if [ "$s" = use-circle-cli ]; then extra=' Also use as a rescue when the agent thinks it cannot do something.'; fi
    write "$d/plugins/circle/skills/$s/SKILL.md" <<EOF
---
name: $s
description: Fixture skill $s.$extra
---
Fixture.
EOF
  done
}
make_ours() { # $1 dir, $2 version
  local d=$1 v=$2
  write "$d/.claude-plugin/marketplace.json" <<'EOF'
{"name":"stable-build","owner":{"name":"stable-build test fixture"},"metadata":{"description":"Test fixture for the installer round trip"},"plugins":[{"name":"stable-build","source":"./plugins/stable-build","description":"Fixture plugin"},{"name":"stable-build-mcp","source":"./plugins/stable-build-mcp","description":"Fixture MCP plugin"}]}
EOF
  write "$d/.agents/plugins/marketplace.json" <<'EOF'
{"name":"stable-build","interface":{"displayName":"stable-build"},"plugins":[{"name":"stable-build","source":{"source":"local","path":"./plugins/stable-build"},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"Coding"},{"name":"stable-build-mcp","source":{"source":"local","path":"./plugins/stable-build-mcp"},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"Coding"}]}
EOF
  write "$d/plugins/stable-build/.claude-plugin/plugin.json" <<EOF
{"name":"stable-build","version":"$v","description":"Fixture plugin","author":{"name":"stable-build test fixture"},"license":"MIT"}
EOF
  write "$d/plugins/stable-build/skills/guide/SKILL.md" <<'EOF'
---
name: guide
description: Fixture skill for the installer round trip. Use only in tests.
---
Fixture.
EOF
  write "$d/plugins/stable-build-mcp/.claude-plugin/plugin.json" <<EOF
{"name":"stable-build-mcp","version":"$v","description":"Fixture MCP plugin","author":{"name":"stable-build test fixture"},"license":"MIT"}
EOF
  write "$d/plugins/stable-build-mcp/.mcp.json" <<'EOF'
{"mcpServers":{"arc-docs":{"type":"http","url":"https://docs.arc.io/mcp"},"circle-codegen":{"type":"http","url":"https://api.circle.com/v1/codegen/mcp"}}}
EOF
}
make_studio_pkg() {
  write "$1/.claude-plugin/marketplace.json" <<'EOF'
{"name":"arc-studio-cli","owner":{"name":"fixture"},"plugins":[{"name":"arc-studio","source":"./agent-skills/arc-studio"}]}
EOF
  write "$1/agent-skills/arc-studio/.claude-plugin/plugin.json" <<'EOF'
{"name":"arc-studio","version":"1.1.3","author":{"name":"fixture"}}
EOF
  write "$1/agent-skills/arc-studio/SKILL.md" <<'EOF'
---
name: arc-studio
description: Fixture.
---
EOF
}

REPOS="$WORK/repos"
make_circle "$REPOS/circlefin/skills" 1.6.0 use-arc use-circle-cli use-usdc
git_commit "$REPOS/circlefin/skills"
CIRCLE_SHA=''; if [ "$HAVE_GIT" = 1 ]; then CIRCLE_SHA=$(git -C "$REPOS/circlefin/skills" rev-parse HEAD); fi
make_ours "$REPOS/pedro-pelicioni/stable-build" 0.1.0
REPOS_EMPTY="$WORK/repos-empty"
make_circle "$REPOS_EMPTY/circlefin/skills" 1.6.0
make_ours "$REPOS_EMPTY/pedro-pelicioni/stable-build" 0.1.0
ARCPKG="$WORK/npm/lib/node_modules/@circle-fin/arc-studio-cli"
make_studio_pkg "$ARCPKG"

# ---------------------------------------------------------------- helpers
seed_prefix() {
  mkdir -p "$1"
  cp -R "$SEED/claude" "$1/.claude"
  cp -R "$SEED/codex" "$1/.codex"
  find "$1" -name '*.seed' | while IFS= read -r f; do mv "$f" "${f%.seed}"; done
}
settings_equiv() { # seed settings vs current, allowing empty objects Claude Code leaves behind
  node -e '
    const fs = require("fs");
    const [a, b] = process.argv.slice(1);
    const seed = JSON.parse(fs.readFileSync(a, "utf8"));
    const cur = JSON.parse(fs.readFileSync(b, "utf8"));
    for (const k of ["enabledPlugins", "extraKnownMarketplaces"]) {
      if (!(k in seed) && cur[k] && typeof cur[k] === "object" && Object.keys(cur[k]).length === 0) delete cur[k];
    }
    const canon = (v) => Array.isArray(v) ? v.map(canon) : (v && typeof v === "object")
      ? Object.keys(v).sort().reduce((o, k) => { o[k] = canon(v[k]); return o; }, {}) : v;
    process.exit(JSON.stringify(canon(seed)) === JSON.stringify(canon(cur)) ? 0 : 1);
  ' "$1" "$2"
}
seed_intact() {
  settings_equiv "$SEED/claude/settings.json" "$1/.claude/settings.json" \
    && cmp -s "$SEED/claude/skills/code-review/SKILL.md.seed" "$1/.claude/skills/code-review/SKILL.md" \
    && cmp -s "$SEED/codex/config.toml" "$1/.codex/config.toml"
}
# Paths under the prefix whose name contains stable-build, minus CLI bookkeeping:
#   Library/Caches/claude-cli-nodejs/* (Claude Code's per-cwd cache) and plugin cache version
#   directories that Claude Code marked with .orphaned_at for its own garbage collection.
residue() {
  local p v n f rest
  (cd "$1" && find . -mindepth 1 -print) | grep -i 'stable-build' >"$WORK/residue.txt" || true
  while IFS= read -r p; do
    case "$p" in ./Library/Caches/claude-cli-nodejs/*) continue ;; esac
    case "$p" in
      ./.claude/plugins/cache/*)
        n=$(printf '%s' "$p" | awk -F/ '{ print NF }')
        if [ "$n" -ge 7 ]; then
          v=$(printf '%s' "$p" | cut -d/ -f1-7)
          [ -f "$1/$v/.orphaned_at" ] && continue
        else
          rest=0
          while IFS= read -r f; do [ -f "$f/.orphaned_at" ] || rest=1; done <<EOF
$(find "$1/$p" -mindepth $((7 - n)) -maxdepth $((7 - n)) -type d)
EOF
          [ "$rest" = 0 ] && continue
        fi
        ;;
    esac
    printf '%s\n' "$p"
  done <"$WORK/residue.txt"
}
no_residue() {
  local r l
  r=$(residue "$1")
  [ -n "$r" ] || return 0
  while IFS= read -r l; do printf '        residue: %s\n' "$l"; done <<EOF
$r
EOF
  return 1
}
is_empty_dir() { [ -d "$1" ] && [ -z "$(find "$1" -mindepth 1 -print | head -n 1)" ]; }
no_mutation_lines() { ! grep -q '^    [$] ' "$OUT"; }
json_has() { grep -Fq -- "\"$2\"" "$1"; }
json_lacks() { ! grep -Fq -- "\"$2\"" "$1"; }

is_read_call() {
  case "$1" in
    "claude --version"|"claude plugin --help"|"claude plugin marketplace list --json"|"claude plugin list --json"|"claude mcp list"|"claude mcp get "*) return 0 ;;
    "codex --version"|"codex plugin --help"|"codex plugin marketplace list --json"|"codex plugin list --json"|"codex mcp get "*) return 0 ;;
    "arc-studio --version") return 0 ;;
  esac
  return 1
}
only_reads() {
  local l rc=0
  while IFS= read -r l; do
    is_read_call "$l" || { printf '        mutating call: %s\n' "$l"; rc=1; }
  done <"$LOG"
  return "$rc"
}
called() { grep -Fxq -- "$1" "$LOG"; }
not_called() { ! grep -Fq -- "$1" "$LOG"; }
log_empty() { [ ! -s "$LOG" ]; }
no_scoped_remove() { ! grep -q '^claude plugin marketplace remove .*--scope' "$LOG"; }
out_has() { grep -Fq -- "$1" "$OUT"; }
out_lacks() { ! grep -Fq -- "$1" "$OUT"; }
not_line() { ! grep -Fxq -- "$1" "$OUT"; }
mf_true() { # $1 manifest, $2 JS expression over m
  node -e "const m = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); process.exit(($2) ? 0 : 1);" "$1"
}
cfg_true() { # $1 config.json, $2 JS expression over c and keys (its keys, sorted, comma-joined)
  node -e "const c = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); const keys = Object.keys(c).sort().join(','); process.exit(($2) ? 0 : 1);" "$1"
}
# The hooks' consent gate, exactly as plugins/stable-build/scripts/run.sh tests it: closed unless
# config.json has "guard": true. A config.json that holds only the language keeps it closed.
gate_closed() { ! grep -Eq '"guard"[[:space:]]*:[[:space:]]*true' "$1" 2>/dev/null; }
# guard off: no consent file, or one without a "guard" key (the language alone)
guard_off() { gate_closed "$1" && { [ ! -e "$1" ] || ! grep -q '"guard"' "$1"; }; }
# English words in the installer's own lines of $OUT: not the commands it runs ("    $ ...") or their
# output (6+ spaces), not the bilingual language menu; quoted commands, paths and flags removed.
# "a", "no", "do", "use" and "remove" are left out: they are Portuguese words too.
ENGLISH_RE='the|and|is|are|was|not|with|from|this|that|your|you|for|of|in|it|to|on|run|rerun|skipped|installed|added|removed|already|nothing|done|next|plan|state|language|warning|error|kept|keep|still|here|only|when|will|cannot|does|must|needs|stays'
english_words() {
  grep -v -e '^    [$] ' -e '^      ' -e 'installer / instalador' -e 'Language / Idioma' -e 'Type 1 or 2\. / Digite 1 ou 2\.' "$OUT" \
    | sed -e "s/'[^']*'//g" -e 's#[^ ]*/[^ ]*##g' -e 's/--*[a-z][a-z-]*//g' \
    | grep -oiwE "$ENGLISH_RE" | tr '[:upper:]' '[:lower:]' | sort -u | tr '\n' ' ' || true
}
no_english_leak() {
  local w
  w=$(english_words)
  [ -z "$w" ] || { printf '        English words: %s\n' "$w"; return 1; }
}
has_english() { [ -n "$(english_words)" ]; }
expect_calls() { local c; for c in "$@"; do check "called: $c" called "$c"; done; }

STUB_PATH="$FAKEBIN:$TOOLS:$SYS_PATH"
CLAUDE_ONLY="$WORK/claude-only-bin"; mkdir -p "$CLAUDE_ONLY"
ln -s "$FAKEBIN/claude" "$CLAUDE_ONLY/claude"; ln -s "$FAKEBIN/arc-studio" "$CLAUDE_ONLY/arc-studio"

# run_inst HOME PATH "EXTRA ENV" installer-args... ; output -> $OUT, exit code -> $RC, argv log reset first
run_inst() {
  local h=$1 p=$2 extra=$3; shift 3
  : >"$LOG"
  mkdir -p "$h"
  set +e
  # shellcheck disable=SC2086 # extra is a list of VAR=value words
  env -i HOME="$h" PATH="$p" TMPDIR="$WORK" LANG=C STABLE_BUILD_NO_TTY=1 SB_FAKE_LOG="$LOG" SB_FAKE_REPOS="$REPOS" \
    SB_FAKE_ARC_PKG="$ARCPKG" $extra bash "$INSTALL" "$@" >"$OUT" 2>&1 </dev/null
  RC=$?
  set -e
}
# fake CLI call inside a prefix (to pre-populate state)
fake_cli() {
  local pfx=$1; shift
  env -i HOME="$pfx" CLAUDE_CONFIG_DIR="$pfx/.claude" CODEX_HOME="$pfx/.codex" PATH="$STUB_PATH" \
    SB_FAKE_REPOS="$REPOS" SB_FAKE_ARC_PKG="$ARCPKG" "$@" </dev/null
}
show_out_on_fail() { if [ "$FAILS" -gt "${1:-0}" ]; then sed 's/^/        | /' "$OUT"; fi; }

# ================================================================ static checks
section "static"
check "bash -n install.sh" bash -n "$INSTALL"
check "last line is: { main \"\$@\"; }" test "$(tail -n 1 "$INSTALL")" = "{ main \"\$@\"; }"
only_main_defined() { # everything but the last line: defines main, runs nothing
  # shellcheck disable=SC2016 # the inner script is meant for the child bash
  [ "$(env -i PATH="$SYS_PATH" bash -c 'eval "$(sed "\$d" "$1")"; declare -F' _ "$INSTALL")" = "declare -f main" ]
}
check "without its last line the script only defines main()" only_main_defined
if command -v shellcheck >/dev/null 2>&1; then
  check "shellcheck -s bash install.sh" shellcheck -s bash "$INSTALL"
else
  echo "  skip  shellcheck is not installed here (CI runs it)"
fi

if [ "$REAL_CLAUDE" = 0 ]; then
# ================================================================ truncated downloads
section "truncated downloads make no call and write nothing"
SIZE=$(wc -c <"$INSTALL" | tr -d ' ')
TAIL=$(tail -n 1 "$INSTALL" | wc -c | tr -d ' ')
# every cut inside the last line (except dropping only its final newline, which is the whole command)
CUTS="1 500 2000 4096 8192 16384 32768 $((SIZE / 2))"
c=$((SIZE - TAIL)); while [ "$c" -le $((SIZE - 2)) ]; do CUTS="$CUTS $c"; c=$((c + 1)); done
for cut in $CUTS; do
  [ "$cut" -lt "$SIZE" ] || continue
  H="$WORK/trunc-$cut"; mkdir -p "$H"; : >"$LOG"
  set +e
  head -c "$cut" "$INSTALL" | env -i HOME="$H" PATH="$STUB_PATH" TMPDIR="$WORK" SB_FAKE_LOG="$LOG" \
    SB_FAKE_REPOS="$REPOS" bash >/dev/null 2>&1
  set -e
  if log_empty && is_empty_dir "$H"; then ok "head -c $cut install.sh | bash"; else bad "head -c $cut install.sh | bash (calls: $(tr '\n' ';' <"$LOG"))"; fi
done

# ================================================================ argument handling and guards
section "arguments, root refusal, missing hosts"
H="$WORK/args"
run_inst "$H" "$STUB_PATH" "" --bogus
check "unknown flag exits 1" test "$RC" = 1
check "unknown flag makes no CLI call" log_empty
run_inst "$H" "$STUB_PATH" "" --update --uninstall
check "--update with --uninstall exits 1" test "$RC" = 1
run_inst "$H" "$STUB_PATH" "" --prefix=
check "empty --prefix exits 1" test "$RC" = 1
run_inst "$H" "$STUB_PATH" "" "--ref=v1;rm -rf x"
check "unsafe --ref exits 1" test "$RC" = 1
check "rejected arguments make no CLI call" log_empty
run_inst "$H" "$STUB_PATH" "" --help
check "--help exits 0" test "$RC" = 0
ROOTBIN="$WORK/rootbin"; mkdir -p "$ROOTBIN"; printf '#!/bin/sh\necho 0\n' >"$ROOTBIN/id"; chmod +x "$ROOTBIN/id"
run_inst "$H" "$ROOTBIN:$STUB_PATH" "" --yes --prefix="$WORK/root-prefix"
check "running as root (uid 0) exits 1" test "$RC" = 1
check "root refusal message" out_has "refusing to run as root"
check "root refusal makes no CLI call" log_empty
check "root refusal creates no prefix" test ! -e "$WORK/root-prefix"
run_inst "$H" "$TOOLS:$SYS_PATH" "" --yes --prefix="$WORK/nohost"
if PATH=$SYS_PATH command -v claude >/dev/null 2>&1 || PATH=$SYS_PATH command -v codex >/dev/null 2>&1; then
  echo "  skip  a claude/codex binary is in $SYS_PATH"
else
  check "no host CLI exits 1" test "$RC" = 1
  check "no host CLI prints install hints" out_has "needs Claude Code"
fi
run_inst "$H" "$CLAUDE_ONLY:$TOOLS:$SYS_PATH" "SB_FAKE_CLAUDE_VERSION=2.1.100" --yes --prefix="$WORK/oldclaude"
check "Claude Code older than 2.1.280 with no other host exits 1" test "$RC" = 1
check "old Claude Code makes no mutating call" only_reads
if ! PATH=$SYS_PATH command -v node >/dev/null 2>&1; then
  run_inst "$H" "$FAKEBIN:$SYS_PATH" "" --yes --prefix="$WORK/nonode"
  check "missing node exits 1" test "$RC" = 1
  check "missing node makes no CLI call" log_empty
fi

# ================================================================ S1: full lifecycle
section "S1 install on a seeded prefix (claude + codex + arc-studio stubs, --yes)"
P1="$WORK/p1"; seed_prefix "$P1"; H1="$WORK/h1"
F0=$FAILS
run_inst "$H1" "$STUB_PATH" "" --prefix="$P1" --yes
check "install exits 0" test "$RC" = 0
expect_calls \
  "claude plugin marketplace add circlefin/skills --scope user" \
  "claude plugin install circle-skills@circle" \
  "codex plugin marketplace add circlefin/skills --ref master" \
  "codex plugin add circle@circle-skills" \
  "claude plugin marketplace add pedro-pelicioni/stable-build --scope user" \
  "claude plugin install stable-build@stable-build" \
  "codex plugin marketplace add pedro-pelicioni/stable-build --ref main" \
  "codex plugin add stable-build@stable-build" \
  "claude plugin install stable-build-mcp@stable-build" \
  "codex plugin add stable-build-mcp@stable-build" \
  "arc-studio skills install --tool claude-code" \
  "claude plugin install arc-studio@arc-studio-cli -y"
check "never calls arc-studio login/logout/whoami" not_called "arc-studio login"
check "MCP health check asks only for our servers (no 'claude mcp list')" not_called "claude mcp list"
expect_calls "claude mcp get plugin:stable-build-mcp:arc-docs" "claude mcp get plugin:stable-build-mcp:circle-codegen"
check "MCP health check reports both servers connected" out_has "plugin:stable-build-mcp:circle-codegen connected"
check "never calls arc-studio whoami" not_called "arc-studio whoami"
check "Circle disclaimer and developer terms shown" out_has "https://console.circle.com/legal/developer-terms"
check "rescue-style Circle skills are named" out_has "use-circle-cli"
check "nothing written to the throwaway HOME (all under --prefix)" is_empty_dir "$H1"
M1="$P1/.stable-build/manifest.json"
check "manifest written" test -f "$M1"
check "manifest: Claude marketplaces addedByUs" mf_true "$M1" "m.hosts.claude.marketplaces['stable-build'].addedByUs === true && m.hosts.claude.marketplaces.circle.addedByUs === true && m.hosts.claude.marketplaces['arc-studio-cli'].addedByUs === true"
check "manifest: Claude plugins addedByUs" mf_true "$M1" "['stable-build@stable-build','stable-build-mcp@stable-build','circle-skills@circle','arc-studio@arc-studio-cli'].every((k) => m.hosts.claude.plugins[k].addedByUs === true)"
check "manifest: Codex entries addedByUs" mf_true "$M1" "m.hosts.codex.marketplaces['stable-build'].addedByUs && m.hosts.codex.marketplaces['circle-skills'].addedByUs && ['stable-build@stable-build','stable-build-mcp@stable-build','circle@circle-skills'].every((k) => m.hosts.codex.plugins[k].addedByUs === true)"
check "manifest: Circle skills, version, repo" mf_true "$M1" "m.circle.skills.join(',') === 'use-arc,use-circle-cli,use-usdc' && m.circle.pluginVersion === '1.6.0' && m.circle.repo === 'circlefin/skills'"
if [ -n "$CIRCLE_SHA" ]; then check "manifest: Circle SHA from the marketplace checkout" mf_true "$M1" "m.circle.sha === '$CIRCLE_SHA'"; fi
check "manifest: ref main, prefix, guard on, versions" mf_true "$M1" "m.ref === 'main' && m.prefix === '$P1' && m.guard.enabled === true && m.hosts.claude.plugins['stable-build-mcp@stable-build'].version === '0.1.0' && m.files['config.json'].createdByUs === true && m.hosts.claude.cli === '2.1.280' && m.schemaVersion === 1"
check "guard consent written (matches run.sh's grep)" grep -q '"guard": *true' "$P1/.stable-build/config.json"
check "language saved next to the consent (LANG=C: en, detected)" cfg_true "$P1/.stable-build/config.json" "c.language === 'en' && c.guard === true"
check "manifest: language en" mf_true "$M1" "m.language === 'en'"
check "header names the language and where it came from" out_has "  language: en (detected from LANG)"
check "the English-word detector used on pt-BR runs finds English here" has_english
show_out_on_fail "$F0"

section "S1 reinstall: read calls only, nothing rewritten"
cp "$M1" "$WORK/m1.before"; cp "$P1/.stable-build/config.json" "$WORK/c1.before"
F0=$FAILS
run_inst "$H1" "$STUB_PATH" "" --prefix="$P1" --yes
check "reinstall exits 0" test "$RC" = 0
check "reinstall makes only read calls" only_reads
check "manifest unchanged" cmp -s "$M1" "$WORK/m1.before"
check "config.json unchanged" cmp -s "$P1/.stable-build/config.json" "$WORK/c1.before"
show_out_on_fail "$F0"

section "S1 dry runs make read calls only"
run_inst "$H1" "$STUB_PATH" "" --prefix="$P1" --update --dry-run
check "--update --dry-run exits 0" test "$RC" = 0
check "--update --dry-run makes only read calls" only_reads
check "--update --dry-run prints the plan" out_has "Plan:"
run_inst "$H1" "$STUB_PATH" "" --prefix="$P1" --uninstall --dry-run
check "--uninstall --dry-run exits 0" test "$RC" = 0
check "--uninstall --dry-run makes only read calls" only_reads
check "--uninstall --dry-run keeps the manifest" test -f "$M1"

section "S1 update (new stable-build and Circle versions; Circle skill set changed; Arc Studio npm dir moved)"
make_ours "$REPOS/pedro-pelicioni/stable-build" 0.1.1
rm -rf "$REPOS/circlefin/skills/plugins/circle/skills/use-arc"
make_circle "$REPOS/circlefin/skills" 1.7.0 use-circle-cli use-usdc use-gateway
git_commit "$REPOS/circlefin/skills"
mv "$ARCPKG" "$ARCPKG.moved"
F0=$FAILS
run_inst "$H1" "$STUB_PATH" "SB_FAKE_ARC_PKG=$ARCPKG.moved" --prefix="$P1" --update --yes
check "update exits 0" test "$RC" = 0
expect_calls \
  "claude plugin marketplace update stable-build" \
  "claude plugin update stable-build@stable-build" \
  "claude plugin update stable-build-mcp@stable-build" \
  "codex plugin marketplace upgrade stable-build" \
  "codex plugin add stable-build@stable-build" \
  "codex plugin add stable-build-mcp@stable-build" \
  "claude plugin marketplace update circle" \
  "claude plugin update circle-skills@circle" \
  "codex plugin marketplace upgrade circle-skills" \
  "codex plugin add circle@circle-skills" \
  "claude plugin marketplace remove arc-studio-cli" \
  "arc-studio skills install --tool claude-code" \
  "claude plugin marketplace add $ARCPKG.moved --scope user"
check "update reports Circle skills added and removed" out_has "+use-gateway -use-arc"
check "update does not print the pre-update version as current" out_lacks "Claude Code: stable-build@stable-build 0.1.0"
check "update summary shows the new version and the old one" out_has "stable-build@stable-build 0.1.1 (was 0.1.0)"
check "no empty 'Circle skills' section in update mode (reported under Updates)" not_line "Circle skills"
check "manifest: Arc Studio entries still recorded as ours" mf_true "$M1" "m.hosts.claude.plugins['arc-studio@arc-studio-cli'].addedByUs === true && m.hosts.claude.marketplaces['arc-studio-cli'].addedByUs === true"
check "manifest: new versions and skill list" mf_true "$M1" "m.hosts.claude.plugins['stable-build@stable-build'].version === '0.1.1' && m.hosts.claude.plugins['stable-build-mcp@stable-build'].version === '0.1.1' && m.circle.pluginVersion === '1.7.0' && m.circle.skills.join(',') === 'use-circle-cli,use-gateway,use-usdc'"
check "manifest: ownership flags kept" mf_true "$M1" "m.hosts.claude.plugins['circle-skills@circle'].addedByUs === true && m.hosts.claude.marketplaces['stable-build'].addedByUs === true"
show_out_on_fail "$F0"

section "S1 update with --ref=v0.2.0 re-adds our marketplace and reinstalls"
F0=$FAILS
run_inst "$H1" "$STUB_PATH" "SB_FAKE_ARC_PKG=$ARCPKG.moved" --prefix="$P1" --update --ref=v0.2.0 --yes
check "ref switch exits 0" test "$RC" = 0
expect_calls \
  "claude plugin marketplace remove stable-build" \
  "claude plugin marketplace add pedro-pelicioni/stable-build@v0.2.0 --scope user" \
  "claude plugin install stable-build@stable-build" \
  "claude plugin install stable-build-mcp@stable-build" \
  "codex plugin marketplace remove stable-build" \
  "codex plugin marketplace add pedro-pelicioni/stable-build --ref v0.2.0"
check "no redundant marketplace update right after the re-add" not_called "claude plugin marketplace update stable-build"
check "manifest: ref v0.2.0, still ours" mf_true "$M1" "m.ref === 'v0.2.0' && m.hosts.claude.marketplaces['stable-build'].addedByUs === true"
fake_cli "$P1" claude plugin list --json >"$WORK/p1-plugins.json"
check "both stable-build plugins installed after the switch" grep -q '"stable-build-mcp@stable-build"' "$WORK/p1-plugins.json"
fake_cli "$P1" claude plugin marketplace list --json >"$WORK/p1-mkts.json"
check "marketplace pinned to v0.2.0" grep -q '"ref": "v0.2.0"' "$WORK/p1-mkts.json"
show_out_on_fail "$F0"

section "S1 rerun without --ref keeps v0.2.0 and makes read calls only"
run_inst "$H1" "$STUB_PATH" "SB_FAKE_ARC_PKG=$ARCPKG.moved" --prefix="$P1" --yes
check "rerun exits 0" test "$RC" = 0
check "rerun makes only read calls" only_reads
check "manifest ref still v0.2.0" mf_true "$M1" "m.ref === 'v0.2.0'"

section "S1 uninstall"
F0=$FAILS
run_inst "$H1" "$STUB_PATH" "SB_FAKE_ARC_PKG=$ARCPKG.moved" --prefix="$P1" --uninstall --yes
check "uninstall exits 0" test "$RC" = 0
expect_calls \
  "codex plugin remove stable-build-mcp@stable-build" \
  "codex plugin remove stable-build@stable-build" \
  "codex plugin marketplace remove stable-build" \
  "claude plugin uninstall stable-build-mcp@stable-build" \
  "claude plugin uninstall stable-build@stable-build" \
  "claude plugin marketplace remove stable-build" \
  "claude plugin uninstall arc-studio@arc-studio-cli" \
  "claude plugin marketplace remove arc-studio-cli" \
  "codex plugin remove circle@circle-skills" \
  "codex plugin marketplace remove circle-skills" \
  "claude plugin uninstall circle-skills@circle" \
  "claude plugin marketplace remove circle"
check "uninstall never calls arc-studio logout" not_called "arc-studio logout"
check "Arc Studio sign-in note (this installer registered it)" out_has "Arc Studio sign-in is untouched"
check "Claude marketplaces removed without --scope (a scoped remove leaves them listed)" no_scoped_remove
check "state directory removed" test ! -e "$P1/.stable-build"
check "seed preserved (settings deep-equal, skill and config.toml byte-identical)" seed_intact "$P1"
check "no stable-build residue under the prefix" no_residue "$P1"
fake_cli "$P1" claude plugin list --json >"$WORK/p1-plugins.json"
fake_cli "$P1" codex plugin list --json >"$WORK/p1-xplugins.json"
check "Claude Code lists no plugins" grep -qx '\[\]' "$WORK/p1-plugins.json"
check "Codex lists no plugins" node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).installed.length === 0 ? 0 : 1)' "$WORK/p1-xplugins.json"
show_out_on_fail "$F0"

section "S1 second uninstall: nothing left, so nothing to remove, exits 0"
run_inst "$H1" "$STUB_PATH" "" --prefix="$P1" --uninstall --yes
check "exits 0" test "$RC" = 0
check "says there is nothing to remove" out_has "Nothing to remove"
check "makes only read calls" only_reads

section "S1b uninstall with no manifest but a stable-build entry listed: manual steps for the sandbox, exits 1"
P1B="$WORK/p1b"; mkdir -p "$P1B"
fake_cli "$P1B" claude plugin marketplace add pedro-pelicioni/stable-build --scope user >/dev/null
run_inst "$WORK/h1b" "$STUB_PATH" "" --prefix="$P1B" --uninstall --yes
check "exits 1" test "$RC" = 1
check "explains why" out_has "No manifest"
check "manual steps target the sandbox, not the real ~/.claude" out_has "HOME='$P1B' CLAUDE_CONFIG_DIR='$P1B/.claude' CODEX_HOME='$P1B/.codex' claude plugin marketplace remove stable-build"
check "makes only read calls" only_reads
mv "$ARCPKG.moved" "$ARCPKG"

# ================================================================ S2: pre-existing entries are kept
section "S2 pre-existing Circle, Arc Studio, stable-build marketplace and user-scope arc-docs MCP"
P2="$WORK/p2"; seed_prefix "$P2"; H2="$WORK/h2"
fake_cli "$P2" claude plugin marketplace add circlefin/skills --scope user >/dev/null
fake_cli "$P2" claude plugin install circle-skills@circle >/dev/null
fake_cli "$P2" claude plugin marketplace add pedro-pelicioni/stable-build --scope user >/dev/null
fake_cli "$P2" arc-studio skills install --tool claude-code >/dev/null
F0=$FAILS
run_inst "$H2" "$STUB_PATH" "SB_FAKE_USER_MCP=arc-docs" --prefix="$P2" --yes
check "install exits 0" test "$RC" = 0
check "Circle marketplace not re-added" not_called "claude plugin marketplace add circlefin/skills"
check "Circle plugin not reinstalled" not_called "claude plugin install circle-skills@circle"
check "our marketplace not re-added" not_called "claude plugin marketplace add pedro-pelicioni/stable-build"
check "Arc Studio not re-registered" not_called "arc-studio skills install"
check "Claude MCP plugin skipped (user-scope arc-docs exists)" not_called "claude plugin install stable-build-mcp@stable-build"
check "skip is explained" out_has "user-scope MCP server(s) arc-docs"
expect_calls "claude plugin install stable-build@stable-build" "codex plugin add stable-build-mcp@stable-build" "codex plugin add circle@circle-skills"
M2="$P2/.stable-build/manifest.json"
check "manifest: pre-existing entries recorded addedByUs:false" mf_true "$M2" "m.hosts.claude.marketplaces.circle.addedByUs === false && m.hosts.claude.plugins['circle-skills@circle'].addedByUs === false && m.hosts.claude.plugins['arc-studio@arc-studio-cli'].addedByUs === false && m.hosts.claude.marketplaces['arc-studio-cli'].addedByUs === false && m.hosts.claude.marketplaces['stable-build'].addedByUs === false"
check "manifest: our plugin addedByUs:true" mf_true "$M2" "m.hosts.claude.plugins['stable-build@stable-build'].addedByUs === true"
show_out_on_fail "$F0"
F0=$FAILS
run_inst "$H2" "$STUB_PATH" "SB_FAKE_USER_MCP=arc-docs" --prefix="$P2" --uninstall --yes
check "uninstall exits 0" test "$RC" = 0
check "Circle plugin kept" not_called "claude plugin uninstall circle-skills@circle"
check "Circle marketplace kept" not_called "claude plugin marketplace remove circle"
check "Arc Studio plugin kept" not_called "claude plugin uninstall arc-studio@arc-studio-cli"
check "pre-existing stable-build marketplace kept" not_called "claude plugin marketplace remove stable-build"
expect_calls "claude plugin uninstall stable-build@stable-build" "codex plugin remove circle@circle-skills"
check "kept entries are reported" out_has "Kept (present before stable-build was installed)"
fake_cli "$P2" claude plugin list --json >"$WORK/p2-plugins.json"
check "circle-skills@circle still installed" json_has "$WORK/p2-plugins.json" circle-skills@circle
check "arc-studio@arc-studio-cli still installed" json_has "$WORK/p2-plugins.json" arc-studio@arc-studio-cli
check "stable-build@stable-build removed" json_lacks "$WORK/p2-plugins.json" stable-build@stable-build
check "state directory removed" test ! -e "$P2/.stable-build"
show_out_on_fail "$F0"

# ================================================================ S3: defaults without a terminal
section "S3 no terminal, no --yes: third-party installs skipped, guard stays off; --no-mcp"
P3="$WORK/p3"; seed_prefix "$P3"; H3="$WORK/h3"
F0=$FAILS
run_inst "$H3" "$STUB_PATH" "STABLE_BUILD_NO_TTY=1" --prefix="$P3" --no-mcp
check "install exits 0" test "$RC" = 0
check "Circle prompt answered no without a terminal" out_has "Install Circle's skills plugin? [Y/n] N (no terminal: skipped"
check "Circle not installed without a yes" not_called "circle-skills@circle"
check "Circle marketplace not added without a yes" not_called "claude plugin marketplace add circlefin/skills"
check "Arc Studio not registered without a yes" not_called "arc-studio skills install"
check "prints how to add Circle later (rerun, so --uninstall can remove it)" out_has "To add them later, rerun this installer in a terminal"
expect_calls "claude plugin install stable-build@stable-build"
check "--no-mcp: no MCP plugin" not_called "stable-build-mcp"
check "guard stays off: config.json holds only the language" cfg_true "$P3/.stable-build/config.json" "keys === 'language,schemaVersion' && c.language === 'en'"
check "guard stays off: the hooks' consent gate stays closed" gate_closed "$P3/.stable-build/config.json"
check "manifest: guard disabled; config.json created (for the language)" mf_true "$P3/.stable-build/manifest.json" "m.guard.enabled === false && m.files['config.json'].createdByUs === true && m.language === 'en'"
check "the no-terminal default is not recorded as a decline" mf_true "$P3/.stable-build/manifest.json" "!m.guard.declinedAt"
show_out_on_fail "$F0"
F0=$FAILS
run_inst "$H3" "$STUB_PATH" "" --prefix="$P3" --no-mcp --no-circle --no-studio --update --yes
check "--update --yes does not ask about the guard" out_lacks "Turn the guard on?"
check "--update --yes leaves the guard off" guard_off "$P3/.stable-build/config.json"
check "--update explains how to turn it on" out_has "--update never turns it on"
run_inst "$H3" "$STUB_PATH" "" --prefix="$P3" --no-mcp --no-hooks --yes
check "rerun with --yes adds Circle and Arc Studio" called "claude plugin install circle-skills@circle"
check "--no-hooks is recorded as a decline" mf_true "$P3/.stable-build/manifest.json" "typeof m.guard.declinedAt === 'string' && m.guard.enabled === false"
run_inst "$H3" "$STUB_PATH" "" --prefix="$P3" --no-mcp --yes
check "a later install --yes keeps a declined guard off" guard_off "$P3/.stable-build/config.json"
check "it says the guard was declined" out_has "Off: declined on"
run_inst "$H3" "$STUB_PATH" "" --prefix="$P3" --no-mcp --update --yes
check "a later --update --yes keeps a declined guard off" guard_off "$P3/.stable-build/config.json"
check "manifest: guard still disabled" mf_true "$P3/.stable-build/manifest.json" "m.guard.enabled === false"
run_inst "$H3" "$STUB_PATH" "STABLE_BUILD_NO_TTY=1" --prefix="$P3" --uninstall
check "uninstall (defaults) exits 0" test "$RC" = 0
check "Circle removed by default when this installer added it" called "claude plugin uninstall circle-skills@circle"
check "config.json (created for the language) removed with the state directory" test ! -e "$P3/.stable-build"
check "seed preserved" seed_intact "$P3"
check "no residue" no_residue "$P3"
show_out_on_fail "$F0"

# ================================================================ S3b: agent session without --yes
section "S3b agent session (CLAUDECODE=1), no --yes: no prompt, no third-party install"
P3B="$WORK/p3b"; seed_prefix "$P3B"
F0=$FAILS
run_inst "$WORK/h3b" "$STUB_PATH" "CLAUDECODE=1" --prefix="$P3B" --no-mcp
check "install exits 0" test "$RC" = 0
check "warns about the agent session" out_has "this looks like a Claude Code or Codex session"
check "Circle not installed" not_called "circle-skills@circle"
check "Arc Studio not registered" not_called "arc-studio skills install"
check "guard stays off" guard_off "$P3B/.stable-build/config.json"
expect_calls "claude plugin install stable-build@stable-build"
show_out_on_fail "$F0"

# ================================================================ S7: uninstall keeps what it did not write
section "S7 STABLE_BUILD_HOME shared with other files; HOME// spelling; uninstall deletes only its own files"
H7="$WORK/h7"; mkdir -p "$H7/shared/sub" "$H7/Documents"
echo keep >"$H7/shared/important.txt"; echo keep >"$H7/shared/sub/notes"; echo keep >"$H7/Documents/thesis.txt"
F0=$FAILS
run_inst "$H7" "$STUB_PATH" "STABLE_BUILD_HOME=$H7/shared" --yes --no-circle --no-studio --no-mcp
check "install into a shared STABLE_BUILD_HOME exits 0" test "$RC" = 0
check "manifest written there" test -f "$H7/shared/manifest.json"
run_inst "$H7" "$STUB_PATH" "STABLE_BUILD_HOME=$H7/shared" --uninstall --dry-run
check "uninstall plan names the files it removes" out_has "manifest.json, config.json (guard consent, language); the directory only if then empty"
run_inst "$H7" "$STUB_PATH" "STABLE_BUILD_HOME=$H7/shared" --uninstall --yes
check "uninstall exits 0" test "$RC" = 0
check "user files kept" test -f "$H7/shared/important.txt" -a -f "$H7/shared/sub/notes"
check "manifest and consent removed" test ! -e "$H7/shared/manifest.json" -a ! -e "$H7/shared/config.json"
check "says the directory was kept" out_has "Kept ~/shared"
run_inst "$H7" "$STUB_PATH" "STABLE_BUILD_HOME=$H7//" --yes --no-circle --no-studio --no-mcp
check "install with STABLE_BUILD_HOME=HOME// exits 0" test "$RC" = 0
run_inst "$H7" "$STUB_PATH" "STABLE_BUILD_HOME=$H7//" --uninstall --yes
check "uninstall with STABLE_BUILD_HOME=HOME// exits 0" test "$RC" = 0
check "HOME and its files survive" test -f "$H7/Documents/thesis.txt" -a -f "$H7/shared/important.txt"
check "manifest removed from HOME" test ! -e "$H7/manifest.json"
mkdir -p "$H7/other"; echo '{"theme":"dark"}' >"$H7/other/config.json"
run_inst "$H7" "$STUB_PATH" "STABLE_BUILD_HOME=$H7/other" --yes --no-circle --no-studio --no-mcp --no-hooks
check "the language is added to a foreign config.json, its keys kept" cfg_true "$H7/other/config.json" "keys === 'language,theme' && c.theme === 'dark' && c.language === 'en'"
check "manifest: language added to config.json, file not created by the installer" mf_true "$H7/other/manifest.json" "m.files['config.json'].languageAddedByUs === true && !m.files['config.json'].createdByUs"
run_inst "$H7" "$STUB_PATH" "STABLE_BUILD_HOME=$H7/other" --uninstall --yes
check "a config.json that is not a stable-build consent file is kept" grep -q theme "$H7/other/config.json"
check "only the key the installer added is taken out of it" cfg_true "$H7/other/config.json" "keys === 'theme'"
check "says it kept the file" out_has "Removed stable-build's settings from"
show_out_on_fail "$F0"

# ================================================================ S8: CDPATH and quoted one-liners
section "S8 relative --prefix with CDPATH set; prefix with spaces in the printed one-liners"
H8="$WORK/h8"; mkdir -p "$H8/work" "$H8/projects/sandbox"; echo keep >"$H8/projects/sandbox/keep.txt"
F0=$FAILS
: >"$LOG"
set +e
(cd "$H8/work" && env -i HOME="$H8" PATH="$STUB_PATH" TMPDIR="$WORK" LANG=C SB_FAKE_LOG="$LOG" \
  SB_FAKE_REPOS="$REPOS" SB_FAKE_ARC_PKG="$ARCPKG" CDPATH="$H8/projects" \
  bash "$INSTALL" --yes --no-circle --no-studio --no-mcp --prefix=sandbox >"$OUT" 2>&1 </dev/null)
RC=$?
set -e
check "install exits 0" test "$RC" = 0
check "prefix resolved against the working directory, not CDPATH" test -f "$H8/work/sandbox/.stable-build/manifest.json"
check "CDPATH target untouched" test "$(ls -A "$H8/projects/sandbox")" = keep.txt
check "no directory with a newline in its name" test "$(find "$H8" -name '*
*' | wc -l | tr -d ' ')" = 0
P8="$WORK/pre fix"
run_inst "$H8" "$STUB_PATH" "" --yes --no-circle --no-studio --no-mcp --prefix="$P8"
check "install into a prefix with a space exits 0" test "$RC" = 0
check "uninstall one-liner quotes the prefix" out_has "--uninstall --prefix='$P8'"
show_out_on_fail "$F0"

# ================================================================ S4: Claude only, Circle with 0 skills
section "S4 Claude Code only; Circle plugin with 0 skills fails loudly; uninstall still cleans up"
P4="$WORK/p4"; seed_prefix "$P4"; H4="$WORK/h4"
F0=$FAILS
run_inst "$H4" "$CLAUDE_ONLY:$TOOLS:$SYS_PATH" "SB_FAKE_REPOS=$REPOS_EMPTY" --prefix="$P4" --yes --no-studio
check "install exits non-zero" test "$RC" != 0
check "error names 0 skills" out_has "0 skills were found"
check "no codex call without a codex binary" not_called "codex "
check "stops before installing stable-build" not_called "claude plugin install stable-build@stable-build"
check "manifest records the Circle entries it added" mf_true "$P4/.stable-build/manifest.json" "m.hosts.claude.marketplaces.circle.addedByUs === true && m.hosts.claude.plugins['circle-skills@circle'].addedByUs === true && !m.hosts.codex"
show_out_on_fail "$F0"
run_inst "$H4" "$CLAUDE_ONLY:$TOOLS:$SYS_PATH" "SB_FAKE_REPOS=$REPOS_EMPTY" --prefix="$P4" --uninstall --yes
check "uninstall exits 0" test "$RC" = 0
check "names only the host it listed" out_has "Verified with 'claude plugin list': no stable-build entries left."
check "no Arc Studio sign-in note when it never registered Arc Studio" out_lacks "Arc Studio sign-in"
expect_calls "claude plugin uninstall circle-skills@circle" "claude plugin marketplace remove circle"
check "seed preserved" seed_intact "$P4"
check "no residue" no_residue "$P4"

# ================================================================ S6: uninstall --no-circle --no-studio keeps them
section "S6 uninstall with --no-circle --no-studio keeps Circle and Arc Studio even when ours"
P6="$WORK/p6"; seed_prefix "$P6"
run_inst "$WORK/h6" "$STUB_PATH" "" --prefix="$P6" --yes
check "install exits 0" test "$RC" = 0
run_inst "$WORK/h6" "$STUB_PATH" "" --prefix="$P6" --uninstall --yes --no-circle --no-studio
check "uninstall exits 0" test "$RC" = 0
check "Circle kept" not_called "circle-skills@circle"
check "Arc Studio kept" not_called "arc-studio@arc-studio-cli"
expect_calls "claude plugin uninstall stable-build@stable-build" "claude plugin marketplace remove stable-build"
check "state directory removed" test ! -e "$P6/.stable-build"

# ================================================================ S5: dry run on a fresh prefix
section "S5 --dry-run on a prefix that does not exist"
P5="$WORK/p5-not-created"
run_inst "$WORK/h5" "$STUB_PATH" "" --prefix="$P5" --dry-run
check "dry run exits 0" test "$RC" = 0
check "dry run makes only read calls" only_reads
check "dry run creates nothing" test ! -e "$P5"
check "plan lists our marketplace" out_has "add pedro-pelicioni/stable-build (user scope)"

# ================================================================ L1: pt-BR lifecycle
section "L1 pt-BR lifecycle: install --lang=pt-BR; reinstall, update and uninstall reuse the saved language"
PL="$WORK/pl"; seed_prefix "$PL"; HL="$WORK/hl"
CL="$PL/.stable-build/config.json"; ML="$PL/.stable-build/manifest.json"
F0=$FAILS
run_inst "$HL" "$STUB_PATH" "" --prefix="$PL" --yes --lang=pt-BR
check "install exits 0" test "$RC" = 0
check "header names the language and its source" out_has "  idioma: pt-BR (--lang)"
for s in "Plano:" "Skills da Circle" "Plugin stable-build" "Servidores MCP" "Guard de edição" "Concluído." \
  "Próximos passos:" "  Idioma: pt-BR (mude em qualquer execução com --lang=en ou --lang=pt-BR)" \
  "  Aviso legal da Circle: os resultados podem conter erros" "  Guard ligado: gravado em"; do
  check "pt-BR: $s" out_has "$s"
done
check "prompts answered by --yes show S/N" out_has "  Instalar o plugin de skills da Circle? [S/n] S (--yes)"
check "the guard prompt too" out_has "  Ligar o guard? [s/N] S (--yes)"
check "commands stay as they are" out_has "    \$ claude plugin install stable-build@stable-build"
expect_calls "claude plugin install stable-build@stable-build" "codex plugin add stable-build@stable-build" "arc-studio skills install --tool claude-code"
check "no English in the installer's own lines" no_english_leak
check "config.json: language pt-BR next to the guard consent" cfg_true "$CL" "c.language === 'pt-BR' && c.guard === true && c.schemaVersion === 1"
check "manifest: language pt-BR; config.json created by the installer" mf_true "$ML" "m.language === 'pt-BR' && m.files['config.json'].createdByUs === true"
show_out_on_fail "$F0"
cp "$ML" "$WORK/ml.before"; cp "$CL" "$WORK/cl.before"
F0=$FAILS
run_inst "$HL" "$STUB_PATH" "" --help --prefix="$PL"
check "--help before --prefix follows the language saved there" out_has "Uso: install.sh [opções]"
check "--help makes no call" log_empty
run_inst "$HL" "$STUB_PATH" "" --prefix="$PL" --help
check "--help after --prefix too" out_has "Uso: install.sh [opções]"
show_out_on_fail "$F0"
F0=$FAILS
run_inst "$HL" "$STUB_PATH" "" --prefix="$PL" --yes
check "reinstall (LANG=C, no --lang) exits 0" test "$RC" = 0
check "it uses the saved language" out_has "  idioma: pt-BR (salvo)"
check "plan line: language already saved" out_has "idioma pt-BR (já salvo)"
check "reinstall makes only read calls" only_reads
check "manifest unchanged" cmp -s "$ML" "$WORK/ml.before"
check "config.json unchanged" cmp -s "$CL" "$WORK/cl.before"
check "no English in the installer's own lines" no_english_leak
show_out_on_fail "$F0"
F0=$FAILS
run_inst "$HL" "$STUB_PATH" "" --prefix="$PL" --update --yes
check "--update exits 0" test "$RC" = 0
check "--update uses the saved language" out_has "(atualização)"
check "update section in Portuguese" not_line "Updates"
check "update section title" out_has "Atualizações"
expect_calls "claude plugin update stable-build@stable-build" "codex plugin marketplace upgrade stable-build"
check "no English in the installer's own lines" no_english_leak
show_out_on_fail "$F0"
run_inst "$HL" "$STUB_PATH" "" --prefix="$PL" --uninstall --dry-run
check "--uninstall --dry-run in Portuguese" out_has "Simulação: nada foi alterado."
check "the plan names the state files" out_has "manifest.json, config.json (consentimento do guard, idioma); o diretório só se ficar vazio"
check "--uninstall --dry-run makes only read calls" only_reads
F0=$FAILS
run_inst "$HL" "$STUB_PATH" "" --prefix="$PL" --uninstall --yes
check "--uninstall exits 0" test "$RC" = 0
check "--uninstall uses the saved language" out_has "  idioma: pt-BR (salvo)"
check "removal in Portuguese" out_has "Removido. Verificado com 'claude plugin list' / 'codex plugin list': não sobrou nenhuma entrada do stable-build."
check "Circle question in Portuguese" out_has "  Remover também o plugin de skills da Circle (foi este instalador que o adicionou)? [S/n] S (--yes)"
check "no English in the installer's own lines" no_english_leak
check "state directory removed (config.json included)" test ! -e "$PL/.stable-build"
check "seed preserved" seed_intact "$PL"
check "no residue" no_residue "$PL"
show_out_on_fail "$F0"

# ================================================================ L2: where the language comes from
section "L2 --lang (both forms, aliases), STABLE_BUILD_LANG, LC_ALL/LC_MESSAGES/LANG and precedence (dry runs)"
LD="$WORK/l2-not-created"
# $1 extra env, $2 expected header line, rest: installer arguments (after --prefix=LD --dry-run)
lang_hdr() {
  local extra=$1 want=$2; shift 2
  run_inst "$WORK/hl2" "$STUB_PATH" "$extra" --prefix="$LD" --dry-run "$@"
  [ "$RC" = 0 ] && out_has "$want" && out_lacks "Language / Idioma" && [ ! -e "$LD" ] && only_reads
}
for a in en english EN English; do
  check "--lang=$a -> en" lang_hdr "LANG=pt_BR.UTF-8" "  language: en (--lang)" --lang="$a"
done
for a in pt pt-br pt_BR pt-BR PT-BR Pt_Br portugues português Português PORTUGUÊS; do
  check "--lang=$a -> pt-BR" lang_hdr "" "  idioma: pt-BR (--lang)" --lang="$a"
done
check "--lang pt (value as the next argument)" lang_hdr "" "  idioma: pt-BR (--lang)" --lang pt
check "--lang en before other flags" lang_hdr "LANG=pt_BR.UTF-8" "  language: en (--lang)" --lang en --no-mcp
check "STABLE_BUILD_LANG=pt_BR" lang_hdr "STABLE_BUILD_LANG=pt_BR" "  idioma: pt-BR (STABLE_BUILD_LANG)"
check "STABLE_BUILD_LANG=english beats a pt locale" lang_hdr "STABLE_BUILD_LANG=english LANG=pt_BR.UTF-8" "  language: en (STABLE_BUILD_LANG)"
check "--lang beats STABLE_BUILD_LANG" lang_hdr "STABLE_BUILD_LANG=pt-BR" "  language: en (--lang)" --lang=en
check "LANG=pt_BR.UTF-8 with no terminal: detected, no prompt" lang_hdr "LANG=pt_BR.UTF-8" "  idioma: pt-BR (detectado a partir de LANG)"
check "the dry-run plan is in Portuguese too" out_has "Simulação: nada foi alterado."
check "--yes with LANG=pt_BR.UTF-8: detected, no prompt" lang_hdr "LANG=pt_BR.UTF-8" "  idioma: pt-BR (detectado a partir de LANG)" --yes
check "LC_ALL beats LANG" lang_hdr "LC_ALL=C LANG=pt_BR.UTF-8" "  language: en (detected from LC_ALL)"
check "LC_MESSAGES beats LANG" lang_hdr "LC_MESSAGES=pt_BR.UTF-8 LANG=en_US.UTF-8" "  idioma: pt-BR (detectado a partir de LC_MESSAGES)"
check "LC_ALL beats LC_MESSAGES" lang_hdr "LC_ALL=pt_BR.UTF-8 LC_MESSAGES=en_US.UTF-8" "  idioma: pt-BR (detectado a partir de LC_ALL)"
check "pt_PT counts as Portuguese" lang_hdr "LANG=pt_PT.UTF-8" "  idioma: pt-BR (detectado a partir de LANG)"
check "no locale variable set: English" lang_hdr "LANG=" "  language: en (default)"
check "agent session (CLAUDECODE=1) with a pt locale: detected, no prompt" lang_hdr "CLAUDECODE=1 LANG=pt_BR.UTF-8" "  idioma: pt-BR (detectado a partir de LANG)"
if (exec </dev/tty) 2>/dev/null; then
  echo "  skip  this shell has a terminal, so a run without STABLE_BUILD_NO_TTY would prompt"
else
  check "no terminal at all (STABLE_BUILD_NO_TTY unset): detected, no prompt" lang_hdr "STABLE_BUILD_NO_TTY= LANG=pt_BR.UTF-8" "  idioma: pt-BR (detectado a partir de LANG)"
fi

# ================================================================ L3: invalid values
section "L3 an unknown language exits 1 with a bilingual error, before any call or write"
LX="$WORK/l3-not-created"; HX="$WORK/hl3"
lang_rejected() { [ "$RC" = 1 ] && log_empty && [ ! -e "$LX" ] && is_empty_dir "$HX"; }
run_inst "$HX" "$STUB_PATH" "" --yes --prefix="$LX" --lang=fr
check "--lang=fr exits 1, no call, nothing written" lang_rejected
check "error in English" out_has "stable-build: error: unknown language 'fr' (supported: en, pt-BR)"
check "and in Portuguese" out_has "stable-build: erro: idioma desconhecido 'fr' (suportados: en, pt-BR)"
run_inst "$HX" "$STUB_PATH" "" --yes --prefix="$LX" --lang
check "--lang without a value exits 1" lang_rejected
check "says it needs a value, in both languages" out_has "--lang precisa de um valor: en ou pt-BR"
run_inst "$HX" "$STUB_PATH" "" --yes --prefix="$LX" --lang=
check "--lang= exits 1" lang_rejected
run_inst "$HX" "$STUB_PATH" "STABLE_BUILD_LANG=xx" --yes --prefix="$LX"
check "STABLE_BUILD_LANG=xx exits 1" lang_rejected
check "error names the variable, in both languages" out_has "stable-build: erro: STABLE_BUILD_LANG=xx não é um idioma suportado (en, pt-BR)"
run_inst "$HX" "$STUB_PATH" "STABLE_BUILD_LANG=pt-BR" --yes --prefix="$LX" --lang=pt-PT
check "an invalid --lang is not rescued by a valid STABLE_BUILD_LANG" lang_rejected

# ================================================================ L4: config.json for the language only
section "L4 config.json created only for the language (no guard): gate closed, --lang changes it, uninstall removes it"
PG="$WORK/pg"; seed_prefix "$PG"; HG="$WORK/hg"; CG="$PG/.stable-build/config.json"; MG="$PG/.stable-build/manifest.json"
F0=$FAILS
run_inst "$HG" "$STUB_PATH" "LANG=pt_BR.UTF-8" --prefix="$PG" --yes --no-circle --no-studio --no-mcp --no-hooks
check "install exits 0" test "$RC" = 0
check "config.json holds only the language" cfg_true "$CG" "keys === 'language,schemaVersion' && c.language === 'pt-BR' && c.schemaVersion === 1"
check "the hooks' consent gate stays closed" gate_closed "$CG"
check "manifest: config.json created by the installer; language; guard off" mf_true "$MG" "m.files['config.json'].createdByUs === true && m.language === 'pt-BR' && m.guard.enabled === false"
check "summary: guard off, in Portuguese" out_has "  Guard: desligado"
show_out_on_fail "$F0"
F0=$FAILS
run_inst "$HG" "$STUB_PATH" "LANG=pt_BR.UTF-8" --prefix="$PG" --yes --no-circle --no-studio --no-mcp --lang=en
check "rerun with --lang=en exits 0" test "$RC" = 0
check "it switches to English" out_has "  language: en (--lang)"
check "plan line: save language en" out_has "save language en"
check "rerun makes only read calls" only_reads
check "config.json: language en, still no guard" cfg_true "$CG" "keys === 'language,schemaVersion' && c.language === 'en'"
check "manifest: language en, ownership kept" mf_true "$MG" "m.language === 'en' && m.files['config.json'].createdByUs === true"
show_out_on_fail "$F0"
cp "$CG" "$WORK/cg.before"
run_inst "$HG" "$STUB_PATH" "" --prefix="$PG" --yes --dry-run --lang=pt-BR
check "a dry run with --lang does not save it" cmp -s "$CG" "$WORK/cg.before"
check "the dry-run plan says it would save it" out_has "salvar o idioma pt-BR"
F0=$FAILS
run_inst "$HG" "$STUB_PATH" "LANG=pt_BR.UTF-8" --prefix="$PG" --uninstall --yes
check "uninstall exits 0" test "$RC" = 0
check "the saved choice beats the locale" out_has "  language: en (saved)"
check "config.json removed (created by the installer)" test ! -e "$CG"
check "state directory removed" test ! -e "$PG/.stable-build"
check "seed preserved" seed_intact "$PG"
check "no residue" no_residue "$PG"
show_out_on_fail "$F0"

# ================================================================ L5: an invalid config.json
section "L5 an invalid config.json is left alone; the language is still recorded in the manifest and reused"
PI="$WORK/pi"; HI="$WORK/hi"; mkdir -p "$PI/.stable-build"; printf '{not json' >"$PI/.stable-build/config.json"
F0=$FAILS
run_inst "$HI" "$STUB_PATH" "" --prefix="$PI" --yes --no-circle --no-studio --no-mcp --lang=pt-BR
check "install exits 0" test "$RC" = 0
check "warns in Portuguese that the language is not saved there" out_has "não é um JSON válido, então a escolha de idioma não é salva nele"
check "config.json untouched" test "$(cat "$PI/.stable-build/config.json")" = '{not json'
check "manifest: language pt-BR" mf_true "$PI/.stable-build/manifest.json" "m.language === 'pt-BR' && !(m.files || {})['config.json']"
run_inst "$HI" "$STUB_PATH" "" --prefix="$PI" --uninstall --yes
check "uninstall exits 0" test "$RC" = 0
check "the language saved in the manifest is reused" out_has "  idioma: pt-BR (salvo)"
check "config.json kept, untouched" test "$(cat "$PI/.stable-build/config.json")" = '{not json'
check "manifest removed" test ! -e "$PI/.stable-build/manifest.json"
check "says the directory was kept" out_has "foi mantido: ele guarda arquivos que o stable-build não gravou."
show_out_on_fail "$F0"

# ================================================================ L6: no --prefix
section "L6 no --prefix: STABLE_BUILD_HOME holds the choice; --help, errors, --update and --uninstall follow it"
HN="$WORK/hn"; mkdir -p "$HN"; SBN="STABLE_BUILD_HOME=$HN/sb"
F0=$FAILS
run_inst "$HN" "$STUB_PATH" "$SBN" --yes --no-circle --no-studio --no-mcp --no-hooks --lang=pt
check "install exits 0" test "$RC" = 0
check "config.json in STABLE_BUILD_HOME: language pt-BR" cfg_true "$HN/sb/config.json" "c.language === 'pt-BR'"
run_inst "$HN" "$STUB_PATH" "$SBN" --help
check "--help follows the saved language" out_has "Uso: install.sh [opções]"
check "--help makes no call" log_empty
run_inst "$HN" "$STUB_PATH" "$SBN STABLE_BUILD_LANG=en" --dry-run
check "STABLE_BUILD_LANG beats the saved choice" out_has "  language: en (STABLE_BUILD_LANG)"
check "a dry run does not save it" cfg_true "$HN/sb/config.json" "c.language === 'pt-BR'"
run_inst "$HN" "$STUB_PATH" "$SBN" --bogus
check "unknown option exits 1" test "$RC" = 1
check "and is reported in the saved language" out_has "stable-build: opção desconhecida: --bogus"
run_inst "$HN" "$STUB_PATH" "$SBN" --update --uninstall
check "--update --uninstall error in the saved language" out_has "stable-build: erro: --update e --uninstall não podem ser usados juntos"
run_inst "$HN" "$STUB_PATH" "$SBN" --update --yes --no-circle --no-studio --no-mcp
check "--update exits 0" test "$RC" = 0
check "--update in the saved language" out_has "  idioma: pt-BR (salvo)"
check "no English in the installer's own lines" no_english_leak
run_inst "$HN" "$STUB_PATH" "$SBN" --uninstall --yes
check "--uninstall exits 0" test "$RC" = 0
check "--uninstall in the saved language" out_has "Removido."
check "STABLE_BUILD_HOME removed" test ! -e "$HN/sb"
check "no residue in HOME" no_residue "$HN"
show_out_on_fail "$F0"

# ================================================================ TTY: the language prompt
if command -v python3 >/dev/null 2>&1 && python3 -c 'import pty, select' 2>/dev/null; then
section "TTY language prompt on a pseudo-terminal (python3 pty)"
TTYD="$HERE/tty-drive.py"
# run_tty HOME "EXTRA ENV" [--expect TEXT --send REPLY]...   (installer arguments: $TTY_ARGS)
# The installer runs with the pty as its controlling terminal, stdin and stdout; the transcript
# (prompts, echoed answers, output) goes to $OUT. The driver answers each --expect with its --send
# and exits 124 if an expected prompt never shows, or if the run waits on a prompt nobody expected.
run_tty() {
  local h=$1 extra=$2
  shift 2
  : >"$LOG"; mkdir -p "$h"
  set +e
  # shellcheck disable=SC2086 # extra and TTY_ARGS are lists of words (no spaces inside)
  python3 "$TTYD" --timeout 60 --transcript "$OUT" "$@" \
    -- env -i HOME="$h" PATH="$STUB_PATH" TMPDIR="$WORK" LANG=C SB_FAKE_LOG="$LOG" SB_FAKE_REPOS="$REPOS" \
    SB_FAKE_ARC_PKG="$ARCPKG" $extra bash "$INSTALL" $TTY_ARGS
  RC=$?
  set -e
}
QUIET="--no-circle --no-studio --no-mcp"
VER=$(sed -n 's/^  SB_VERSION=//p' "$INSTALL")

PT1="$WORK/pt1"; seed_prefix "$PT1"
F0=$FAILS
TTY_ARGS="--prefix=$PT1 $QUIET"
run_tty "$WORK/ht1" "" --expect "Language / Idioma:" --send 2 --expect "Ligar o guard? [s/N]" --send s
check "choosing 2, then answering s: exits 0" test "$RC" = 0
check "the language prompt is the first thing shown" test "$(head -n 1 "$OUT")" = "stable-build $VER: installer / instalador"
check "the menu, defaulting to English under LANG=C" test "$(sed -n 2p "$OUT")" = "Language / Idioma: [1] English  [2] Português (Brasil)  (Enter = 1): 2"
check "the choice is confirmed in Portuguese" test "$(sed -n 3p "$OUT")" = "  Idioma: português do Brasil (pt-BR)"
check "header: pt-BR (escolhido)" out_has "  idioma: pt-BR (escolhido)"
for s in "Plano:" "Plugin stable-build" "Guard de edição" "  Guard ligado: gravado em" "Concluído." "Próximos passos:"; do
  check "then Portuguese: $s" out_has "$s"
done
check "no English in the installer's own lines" no_english_leak
check "config.json: pt-BR and the guard on (answered s)" cfg_true "$PT1/.stable-build/config.json" "c.language === 'pt-BR' && c.guard === true"
check "manifest: language pt-BR" mf_true "$PT1/.stable-build/manifest.json" "m.language === 'pt-BR'"
show_out_on_fail "$F0"
F0=$FAILS
run_tty "$WORK/ht1" ""
check "rerun in a terminal: no prompt at all (saved language, guard already on)" test "$RC" = 0
check "it does not ask for the language again" out_lacks "Language / Idioma"
check "it uses the saved language" out_has "  idioma: pt-BR (salvo)"
check "rerun makes only read calls" only_reads
show_out_on_fail "$F0"
F0=$FAILS
TTY_ARGS="--prefix=$PT1 --uninstall"
run_tty "$WORK/ht1" ""
check "uninstall in a terminal: exits 0, no prompt" test "$RC" = 0
check "uninstall in the saved language" out_has "Removido."
check "no English in the installer's own lines" no_english_leak
check "state directory removed" test ! -e "$PT1/.stable-build"
check "no residue" no_residue "$PT1"
show_out_on_fail "$F0"

PT2="$WORK/pt2"; mkdir -p "$PT2"
F0=$FAILS
TTY_ARGS="--prefix=$PT2 $QUIET"
run_tty "$WORK/ht2" "LANG=pt_BR.UTF-8" --expect "(Enter = 2): " --send '' --expect "Ligar o guard? [s/N]" --send n
check "LANG=pt_BR.UTF-8: Enter keeps the detected Portuguese" test "$RC" = 0
check "confirmed" out_has "  Idioma: português do Brasil (pt-BR)"
check "a 'no' at the terminal is recorded" out_has "  O guard continua desligado. As próximas execuções não perguntam de novo"
check "manifest: declined, language pt-BR" mf_true "$PT2/.stable-build/manifest.json" "typeof m.guard.declinedAt === 'string' && m.language === 'pt-BR'"
check "config.json: the language only" cfg_true "$PT2/.stable-build/config.json" "keys === 'language,schemaVersion'"
show_out_on_fail "$F0"

PT3="$WORK/pt3"; mkdir -p "$PT3"
F0=$FAILS
TTY_ARGS="--prefix=$PT3 $QUIET"
run_tty "$WORK/ht3" "LANG=pt_BR.UTF-8" --expect "Idioma:" --send 9 --expect "Digite 1 ou 2." --send 1 --expect "Turn the guard on? [y/N]" --send ''
check "an invalid answer is asked again; then 1 picks English" test "$RC" = 0
check "retry hint is bilingual" out_has "  Type 1 or 2. / Digite 1 ou 2."
check "confirmed in English" out_has "  Language: English (en)"
check "header: en (chosen)" out_has "  language: en (chosen)"
check "the rest is English" out_has "Done."
check "config.json: en" cfg_true "$PT3/.stable-build/config.json" "c.language === 'en' && !('guard' in c)"
show_out_on_fail "$F0"

PT4="$WORK/pt4-not-created"
TTY_ARGS="--prefix=$PT4 --dry-run --yes"
run_tty "$WORK/ht4" "LANG=pt_BR.UTF-8"
check "--yes in a terminal: no language prompt" out_lacks "Language / Idioma"
check "--yes in a terminal: the locale decides" out_has "  idioma: pt-BR (detectado a partir de LANG)"
TTY_ARGS="--prefix=$PT4 --dry-run --lang=en"
run_tty "$WORK/ht4" "LANG=pt_BR.UTF-8"
check "--lang in a terminal: no prompt" out_lacks "Language / Idioma"
check "--lang in a terminal: used" out_has "  language: en (--lang)"
TTY_ARGS="--prefix=$PT4 --dry-run"
run_tty "$WORK/ht4" "STABLE_BUILD_LANG=pt-BR"
check "STABLE_BUILD_LANG in a terminal: no prompt" out_lacks "Language / Idioma"
check "STABLE_BUILD_LANG in a terminal: used" out_has "  idioma: pt-BR (STABLE_BUILD_LANG)"
run_tty "$WORK/ht4" "CLAUDECODE=1 LANG=pt_BR.UTF-8"
check "agent session in a terminal: no prompt" out_lacks "Language / Idioma"
check "agent session in a terminal: the locale decides" out_has "  idioma: pt-BR (detectado a partir de LANG)"
check "these dry runs create nothing" test ! -e "$PT4"
else
  echo "  skip  python3 with pty is not available: the terminal prompt is not tested"
fi

else
# ================================================================ real Claude Code
section "real claude: read-safe round trip in a throwaway HOME"
REAL=$(command -v claude || true)
[ -n "$REAL" ] || { echo "claude is not on PATH" >&2; exit 2; }
REALBIN="$WORK/real-bin"; mkdir -p "$REALBIN"; ln -s "$REAL" "$REALBIN/claude"
RPATH="$REALBIN:$TOOLS:$SYS_PATH"
FIX="$WORK/fixture-marketplace"
if [ -n "$SB_SOURCE" ]; then FIX=$(cd "$SB_SOURCE" && pwd -P); else make_ours "$FIX" 0.1.0; fi
RH="$WORK/real-home"; mkdir -p "$RH"
VH="$WORK/validate-home"; mkdir -p "$VH"
real_claude() { env -i HOME="$VH" CLAUDE_CONFIG_DIR="$VH/.claude" PATH="$RPATH" TMPDIR="$WORK" "$REAL" "$@" </dev/null; }
check "claude plugin validate --strict (marketplace source)" real_claude plugin validate --strict "$FIX"
for p in stable-build stable-build-mcp; do
  check "claude plugin validate --strict (plugins/$p)" real_claude plugin validate --strict "$FIX/plugins/$p"
done
if [ -f "$ROOT/.claude-plugin/marketplace.json" ] && [ "$FIX" != "$ROOT" ]; then
  if real_claude plugin validate --strict "$ROOT" >"$WORK/validate-root.txt" 2>&1; then
    echo "  info  repo root passes claude plugin validate --strict"
  else
    echo "  info  repo root does not pass claude plugin validate --strict yet (other components in progress):"
    sed 's/^/        | /' "$WORK/validate-root.txt" | head -20
  fi
fi
EXTRA="STABLE_BUILD_SOURCE=$FIX"
CIRCLE_FLAG=--no-circle
if [ -n "$CIRCLE_SOURCE" ]; then
  EXTRA="$EXTRA STABLE_BUILD_CIRCLE_SOURCE=$(cd "$CIRCLE_SOURCE" && pwd -P)"; CIRCLE_FLAG=''
fi
RP="$WORK/real-prefix"; seed_prefix "$RP"
snapshot() { (cd "$RP/.claude" && cat settings.json plugins/installed_plugins.json plugins/known_marketplaces.json 2>/dev/null) | shasum | cut -c1-40; }
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$RH" "$RPATH" "$EXTRA" --prefix="$RP" --yes --no-studio $CIRCLE_FLAG
check "install exits 0" test "$RC" = 0
env -i HOME="$RP" CLAUDE_CONFIG_DIR="$RP/.claude" PATH="$RPATH" "$REAL" plugin list --json </dev/null >"$WORK/real-plugins.json"
check "stable-build@stable-build installed" grep -q '"stable-build@stable-build"' "$WORK/real-plugins.json"
check "stable-build-mcp@stable-build installed" grep -q '"stable-build-mcp@stable-build"' "$WORK/real-plugins.json"
if [ -n "$CIRCLE_SOURCE" ]; then
  check "circle-skills@circle installed" grep -q '"circle-skills@circle"' "$WORK/real-plugins.json"
  check "manifest lists Circle skills" mf_true "$RP/.stable-build/manifest.json" "m.circle.skills.length > 0"
fi
check "guard consent written" grep -q '"guard": *true' "$RP/.stable-build/config.json"
check "language saved next to it" cfg_true "$RP/.stable-build/config.json" "c.language === 'en'"
show_out_on_fail "$F0"
S_BEFORE=$(snapshot); cp "$RP/.stable-build/manifest.json" "$WORK/rm.before"
# shellcheck disable=SC2086
run_inst "$RH" "$RPATH" "$EXTRA" --prefix="$RP" --yes --no-studio $CIRCLE_FLAG
check "reinstall exits 0" test "$RC" = 0
check "reinstall runs no mutating command" no_mutation_lines
check "reinstall leaves Claude Code state unchanged" test "$(snapshot)" = "$S_BEFORE"
check "reinstall leaves the manifest unchanged" cmp -s "$RP/.stable-build/manifest.json" "$WORK/rm.before"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$RH" "$RPATH" "$EXTRA" --prefix="$RP" --update --yes --no-studio $CIRCLE_FLAG
check "update exits 0" test "$RC" = 0
check "update ran claude plugin update" out_has "\$ claude plugin update stable-build@stable-build"
show_out_on_fail "$F0"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$RH" "$RPATH" "$EXTRA" --prefix="$RP" --uninstall --yes
check "uninstall exits 0" test "$RC" = 0
env -i HOME="$RP" CLAUDE_CONFIG_DIR="$RP/.claude" PATH="$RPATH" "$REAL" plugin list --json </dev/null >"$WORK/real-plugins.json"
env -i HOME="$RP" CLAUDE_CONFIG_DIR="$RP/.claude" PATH="$RPATH" "$REAL" plugin marketplace list --json </dev/null >"$WORK/real-mkts.json"
check "no plugins left" grep -qx '\[\]' "$WORK/real-plugins.json"
check "no marketplaces left" grep -qx '\[\]' "$WORK/real-mkts.json"
check "state directory removed" test ! -e "$RP/.stable-build"
check "seed preserved (settings deep-equal, skill and config.toml byte-identical)" seed_intact "$RP"
check "no stable-build residue (orphaned plugin caches allowed)" no_residue "$RP"
check "throwaway HOME untouched" is_empty_dir "$RH"
show_out_on_fail "$F0"

section "real claude: removing a marketplace uninstalls its plugins, and a rerun reinstalls them (in pt-BR)"
# This is the premise of the --update --ref switch (remove + re-add, then reinstall). The install
# chooses pt-BR; the rerun and the uninstall get it from config.json.
RP2="$WORK/real-prefix-2"; mkdir -p "$RP2"
rc2() { env -i HOME="$RP2" CLAUDE_CONFIG_DIR="$RP2/.claude" PATH="$RPATH" "$REAL" "$@" </dev/null; }
F0=$FAILS
run_inst "$RH" "$RPATH" "STABLE_BUILD_SOURCE=$FIX" --prefix="$RP2" --yes --no-studio --no-circle --no-mcp --no-hooks --lang=pt-BR
check "install exits 0" test "$RC" = 0
check "install in Portuguese" out_has "Concluído."
check "no English in the installer's own lines" no_english_leak
check "config.json holds only the language" cfg_true "$RP2/.stable-build/config.json" "keys === 'language,schemaVersion' && c.language === 'pt-BR'"
show_out_on_fail "$F0"
(cd "$RP2" && rc2 plugin marketplace remove stable-build >/dev/null 2>&1) || true
(cd "$RP2" && rc2 plugin list --json) >"$WORK/real-plugins.json"
check "marketplace remove also uninstalled stable-build@stable-build" json_lacks "$WORK/real-plugins.json" stable-build@stable-build
run_inst "$RH" "$RPATH" "STABLE_BUILD_SOURCE=$FIX" --prefix="$RP2" --yes --no-studio --no-circle --no-mcp --no-hooks
check "rerun exits 0" test "$RC" = 0
check "rerun uses the saved language" out_has "  idioma: pt-BR (salvo)"
(cd "$RP2" && rc2 plugin list --json) >"$WORK/real-plugins.json"
check "rerun re-added the marketplace and reinstalled the plugin" grep -q '"stable-build@stable-build"' "$WORK/real-plugins.json"
check "manifest still records the marketplace as ours" mf_true "$RP2/.stable-build/manifest.json" "m.hosts.claude.marketplaces['stable-build'].addedByUs === true"
F0=$FAILS
run_inst "$RH" "$RPATH" "STABLE_BUILD_SOURCE=$FIX" --prefix="$RP2" --uninstall --yes
check "uninstall exits 0" test "$RC" = 0
check "uninstall in the saved language" out_has "Removido."
check "no English in the installer's own lines" no_english_leak
check "state directory removed (config.json created for the language)" test ! -e "$RP2/.stable-build"
check "no residue" no_residue "$RP2"
check "throwaway HOME still untouched" is_empty_dir "$RH"
show_out_on_fail "$F0"
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAILS"
[ "$FAILS" = 0 ]
