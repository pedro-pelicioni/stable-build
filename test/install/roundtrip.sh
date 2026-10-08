#!/usr/bin/env bash
# Install round trip for install.sh.
#
#   test/install/roundtrip.sh
#       Host-free (CI default). fake-bin/{claude,codex,arc-studio,npm,curl} log every argv and
#       emulate their output from state files; fake-bin/uname fixes the platform (Darwin arm64 unless
#       SB_FAKE_UNAME_S/M say otherwise). curl serves Arc Foundry releases from a fixture directory
#       built here and fails loudly on any other URL, so no run touches the network, a real npm
#       prefix or the real HOME. Scenarios: install -> reinstall (read calls only) ->
#       update -> ref switch -> uninstall on a seeded --prefix; pre-existing Circle/Arc Studio/
#       marketplace entries are kept; no-TTY and agent-session runs skip third-party installs;
#       Claude-only host with 0 Circle skills; dry runs; bad flags; root refusal; truncated
#       downloads; uninstall keeps foreign files in STABLE_BUILD_HOME; CDPATH; quoted one-liners.
#       Languages (L*): a pt-BR lifecycle whose saved choice is reused by --update and --uninstall;
#       --lang (both forms, every alias), STABLE_BUILD_LANG, English by default (the locale is
#       never read) and their precedence; invalid values exit 1; a config.json created only for the language is
#       removed on uninstall; an invalid config.json; no --prefix. TTY: the language prompt on a
#       pseudo-terminal (tty-drive.py, needs python3): choosing 2 makes the rest Portuguese.
#       Installer v2: one confirmation in a terminal ("n" changes nothing; a typo is asked again and
#       never counts as yes), quiet output with install.log (--verbose prints it), Arc Studio CLI via
#       npm + plugin + sign-in (F/N/T scenarios; a node switch; the sign-in alone has its own
#       question), Arc Foundry download, checksum, install and PATH lines (recorded sha256, bash
#       profiles, a login shell switch), --update, --uninstall, and fresh interactive installs (Claude
#       Code alone, and with Codex) whose transcripts are printed and held to a line budget.
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
    -h|--help) sed -n '2,35p' "$0"; exit 0 ;;
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
# The system tools, minus every program the installer must only ever reach as a stub. Several PATHs
# here leave a stub out on purpose (no arc-studio, so the installer uses npm; no npm; no codex) and
# fall through to these directories: a real arc-studio there (an npm global prefix of /usr, as on
# Arch, after `sudo npm i -g`) would run a real `arc-studio whoami` and `arc-studio login`, a real
# npm would install from the registry, a real codex or claude would add marketplaces from GitHub,
# and a real curl would download. Linked as is otherwise, /usr/bin first, as on /usr/bin:/bin.
SYS_BIN="$WORK/sys-bin"; mkdir -p "$SYS_BIN"
for d in /usr/bin /bin; do ln -s "$d"/* "$SYS_BIN"/ 2>/dev/null || true; done
for t in arc-studio arc-forge arc-cast arc-anvil npm npx claude codex curl wget; do rm -f "$SYS_BIN/$t"; done
SYS_PATH=$SYS_BIN
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
# Arc Foundry releases as GitHub serves them: arc-foundry-<tag>-<target>.tar.gz and .sha256, each
# holding fake forge, cast and anvil scripts that print a version.
FOUNDRY_FIX="$WORK/foundry-releases"
sha256_file() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{ print $1 }'; else sha256sum "$1" | awk '{ print $1 }'; fi; }
make_foundry() { # $1 tag, [$2 broken: binaries that exit 1, like a build the machine cannot run]
  local tag=$1 broken=${2:-} tgt d t name
  for tgt in aarch64-apple-darwin x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu; do
    d="$WORK/foundry-src/$tag-$tgt"; mkdir -p "$d" "$FOUNDRY_FIX/$tag"
    for t in forge cast anvil; do
      if [ "$broken" = broken ]; then
        printf '#!/bin/sh\necho "%s: cannot execute binary file" >&2\nexit 1\n' "$t" >"$d/$t"
      else
        printf '#!/bin/sh\necho "%s %s (fake arc-foundry %s)"\n' "$t" "${tag#v}" "$tgt" >"$d/$t"
      fi
      chmod 755 "$d/$t"
    done
    name="arc-foundry-$tag-$tgt.tar.gz"
    (cd "$d" && COPYFILE_DISABLE=1 tar -czf "$FOUNDRY_FIX/$tag/$name" forge cast anvil)
    printf '%s  %s\n' "$(sha256_file "$FOUNDRY_FIX/$tag/$name")" "$name" >"$FOUNDRY_FIX/$tag/$name.sha256"
  done
}
make_foundry v0.8.0-2
make_foundry v0.8.0-3
make_foundry v0.9.0-broken broken

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
log_has_no_commands() { ! grep -q '^[$] ' "$1"; }
json_has() { grep -Fq -- "\"$2\"" "$1"; }
json_lacks() { ! grep -Fq -- "\"$2\"" "$1"; }

is_read_call() {
  case "$1" in
    "claude --version"|"claude plugin --help"|"claude plugin marketplace list --json"|"claude plugin list --json"|"claude mcp list"|"claude mcp get "*) return 0 ;;
    "codex --version"|"codex plugin --help"|"codex plugin marketplace list --json"|"codex plugin list --json"|"codex mcp get "*) return 0 ;;
    "arc-studio --version"|"arc-studio whoami"|"npm prefix -g") return 0 ;;
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
called_re() { grep -Eq -- "$1" "$LOG"; }
# line number of the first call that starts with $1 (0 when absent), for order checks
call_at() { awk -v p="$1" 'index($0, p) == 1 { print NR; found = 1; exit } END { if (!found) print 0 }' "$LOG"; }
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
mode755() { [ -f "$1" ] && [ -n "$(find "$1" -prune -perm 0755)" ]; }
foundry_installed() { # $1 bin dir, $2 version
  local t
  for t in forge cast anvil; do
    mode755 "$1/arc-$t" || return 1
    "$1/arc-$t" --version | grep -q "^$t $2 " || return 1
  done
}
foundry_absent() { [ ! -e "$1/arc-forge" ] && [ ! -e "$1/arc-cast" ] && [ ! -e "$1/arc-anvil" ]; }
# the bin directory holds the three binaries and nothing else (no staging directory or temp file)
only_foundry_files() { [ "$(cd "$1" && find . -mindepth 1 -print | LC_ALL=C sort | tr '\n' ' ')" = "./arc-anvil ./arc-cast ./arc-forge " ]; }
RC_MARK='# added by stable-build (Arc Foundry)'
# shellcheck disable=SC2016 # the line as it is written to the rc file
RC_PATHLINE='export PATH="$HOME/.local/bin:$PATH"'
no_rc_files() { [ ! -e "$1/.zshrc" ] && [ ! -e "$1/.bashrc" ] && [ ! -e "$1/.bash_profile" ]; }
# $1 was called, and before $2 (prefixes of argv-log lines)
called_before() { local a b; a=$(call_at "$1"); b=$(call_at "$2"); [ "$a" -gt 0 ] && [ "$b" -gt "$a" ]; }

STUB_PATH="$FAKEBIN:$TOOLS:$SYS_PATH"
# npm, curl and uname are stubbed on every PATH used here, so nothing reaches the network
CLAUDE_ONLY="$WORK/claude-only-bin"; mkdir -p "$CLAUDE_ONLY"
for t in claude arc-studio npm curl uname; do ln -s "$FAKEBIN/$t" "$CLAUDE_ONLY/$t"; done
# claude and codex, but no arc-studio on PATH: the installer gets the Arc Studio CLI through npm
NOSTUDIO="$WORK/no-studio-bin"; mkdir -p "$NOSTUDIO"
for t in claude codex npm curl uname; do ln -s "$FAKEBIN/$t" "$NOSTUDIO/$t"; done
NOSTUDIO_PATH="$NOSTUDIO:$TOOLS:$SYS_PATH"
VER=$(sed -n 's/^  SB_VERSION=//p' "$INSTALL")

# run_inst HOME PATH "EXTRA ENV" installer-args... ; output -> $OUT, exit code -> $RC, argv log reset first
run_inst() {
  local h=$1 p=$2 extra=$3; shift 3
  : >"$LOG"
  mkdir -p "$h"
  set +e
  # SHELL is set because bash fills an unset SHELL from the login shell of whoever runs the tests;
  # /bin/sh means "no rc file to edit" unless a test sets SHELL=/bin/zsh or /bin/bash.
  # shellcheck disable=SC2086 # extra is a list of VAR=value words
  env -i HOME="$h" PATH="$p" TMPDIR="$WORK" LANG=C SHELL=/bin/sh STABLE_BUILD_NO_TTY=1 SB_FAKE_LOG="$LOG" SB_FAKE_REPOS="$REPOS" \
    SB_FAKE_ARC_PKG="$ARCPKG" SB_FAKE_FOUNDRY_DIR="$FOUNDRY_FIX" $extra bash "$INSTALL" "$@" >"$OUT" 2>&1 </dev/null
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
sys_path_clean() { # none of the stubbed programs resolves through the system part of every PATH
  local t
  for t in arc-studio arc-forge arc-cast arc-anvil npm npx claude codex curl wget; do
    if PATH=$SYS_PATH command -v "$t" >/dev/null 2>&1; then printf '        on the system PATH: %s\n' "$t"; return 1; fi
  done
  PATH=$SYS_PATH command -v bash >/dev/null 2>&1 && PATH=$SYS_PATH command -v tar >/dev/null 2>&1
}
check "the system PATH under the stubs has bash and tar, and no arc-studio, Foundry, npm, claude, codex or curl" sys_path_clean
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
  run_inst "$H" "$TOOLS:$SYS_PATH" "" --uninstall --yes --prefix="$WORK/nohost-un"
  check "no host CLI and no manifest: --uninstall exits 1 with the same hints" test "$RC" = 1
  check "and says so" out_has "needs Claude Code"
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
check "--yes: no sign-in (nobody to click Authorize), no arc-studio login/logout" not_called "arc-studio log"
check "--yes: the sign-in hint instead" out_has "  – Arc Studio: sign in later with: arc-studio login"
check "MCP health check asks only for our servers (no 'claude mcp list')" not_called "claude mcp list"
expect_calls "claude mcp get plugin:stable-build-mcp:arc-docs" "claude mcp get plugin:stable-build-mcp:circle-codegen"
check "MCP health check reports both servers connected" out_has "  ✓ MCP servers: arc-docs, circle-codegen (connected)"
check "--yes does not call arc-studio whoami" not_called "arc-studio whoami"
check "--yes asks nothing" out_lacks "Continue?"
check "no Circle disclaimer block any more (the terms URL is in the confirmation)" out_lacks "Circle's disclaimer"
check "rescue-style Circle skills are named once, in the closing lines" out_has "Some Circle skills can lead to paid services (use-circle-cli); review them in /plugin."
check "header: one line with the hosts and node" test "$(head -n 1 "$OUT" | sed 's/ · Node .*//')" = "stable-build $VER · Claude Code 2.1.280 · Codex 0.160.0"
check "no plan table outside --dry-run" out_lacks "Plan:"
check "one status line per component" out_has "  ✓ stable-build $VER"
check "Arc Studio found on PATH: no npm install" not_called "npm install"
check "Arc Foundry: the latest tag from the GitHub API" called_re '^curl -fsSL --retry 2 -o .*/foundry-latest\.json https://api\.github\.com/repos/circlefin/arc-foundry/releases/latest$'
check "Arc Foundry: the archive for aarch64-apple-darwin and its .sha256" called_re '^curl .* https://github\.com/circlefin/arc-foundry/releases/download/v0\.8\.0-2/arc-foundry-v0\.8\.0-2-aarch64-apple-darwin\.tar\.gz\.sha256$'
check "Arc Foundry status line" out_has "  ✓ Arc Foundry v0.8.0-2 (arc-forge, arc-cast, arc-anvil)"
check "Arc Foundry in the sandbox's ~/.local/bin, mode 755, each runs" foundry_installed "$P1/.local/bin" 0.8.0-2
check "an unknown shell gets a PATH hint, not an rc edit" out_has "; add $P1/.local/bin to PATH: export PATH="
check "no rc file written for an unknown shell" no_rc_files "$P1"
check "raw CLI output stays out of the terminal" out_lacks "Successfully installed plugin"
check "no command lines without --verbose" no_mutation_lines
check "raw CLI output goes to install.log" grep -q "Successfully installed plugin: stable-build@stable-build" "$P1/.stable-build/install.log"
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
check "language saved next to the consent (en, the default)" cfg_true "$P1/.stable-build/config.json" "c.language === 'en' && c.guard === true"
check "manifest: language en" mf_true "$M1" "m.language === 'en'"
check "manifest: Arc Foundry ours (tag, target, binDir, version); Arc Studio CLI found, not ours" mf_true "$M1" "m.tools.arcFoundry.addedByUs === true && m.tools.arcFoundry.tag === 'v0.8.0-2' && m.tools.arcFoundry.target === 'aarch64-apple-darwin' && m.tools.arcFoundry.binDir === '$P1/.local/bin' && /^forge 0.8.0-2/.test(m.tools.arcFoundry.version) && m.tools.arcStudioCli.addedByUs === false && !m.tools.arcFoundry.pathLine"
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
check "update reports Circle skills added and removed" out_has "    changed since the last run: +use-gateway -use-arc"
check "update does not print the pre-update version as current" not_line "  ✓ stable-build 0.1.0"
check "update status line shows the new version and the old one" out_has "  ✓ stable-build 0.1.1 (was 0.1.0)"
check "header names the mode" out_has "stable-build $VER (update) · "
check "no section titles without --verbose" not_line "Circle skills"
check "Arc Foundry: --update checks the latest release; same tag, so no download" called_re '^curl .*releases/latest$'
check "Arc Foundry: nothing downloaded when the tag is unchanged" not_called "/releases/download/"
check "Arc Foundry: status line" out_has "  ✓ Arc Foundry v0.8.0-2 (arc-forge, arc-cast, arc-anvil)"
check "Arc Studio CLI not added by this installer: --update leaves it to its owner" not_called "npm install"
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
check "Arc Studio sign-in note (this installer registered it)" out_has "Arc Studio sign-in is untouched: arc-studio logout was not run."
check "Arc Studio CLI not ours: no npm uninstall" not_called "npm uninstall"
check "Arc Foundry binaries removed" foundry_absent "$P1/.local/bin"
check "says so" out_has "  ✓ Removed Arc Foundry from $P1/.local/bin"
check "install.log removed with the state directory" test ! -e "$P1/.stable-build/install.log"
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
check "the manual rm takes install.log too, so the rmdir after it works" out_has "  rm -f \"$P1B/.stable-build/manifest.json\" \"$P1B/.stable-build/config.json\" \"$P1B/.stable-build/install.log\"; rmdir \"$P1B/.stable-build\""
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
check "no question without a terminal" out_lacks "Continue?"
check "Circle not installed without a yes" not_called "circle-skills@circle"
check "Circle marketplace not added without a yes" not_called "claude plugin marketplace add circlefin/skills"
check "Arc Studio not registered without a yes" not_called "arc-studio skills install"
check "no npm install without a yes" not_called "npm install"
check "no Arc Foundry download without a yes" not_called "curl"
check "no rc file written without a yes" no_rc_files "$P3"
check "one hint line names what needs a yes, and how to add it (rerun, so --uninstall can remove it)" out_has "  – Not added without your yes: Circle's skills, Arc Studio, Arc Foundry, the guard. To add them, rerun in a terminal: curl -fsSL https://raw.githubusercontent.com/pedro-pelicioni/stable-build/main/install.sh | bash -s -- --prefix='$P3'"
check "only stable-build is listed as done" out_has "  ✓ stable-build "
expect_calls "claude plugin install stable-build@stable-build"
check "--no-mcp: no MCP plugin" not_called "stable-build-mcp"
check "guard stays off: config.json holds only the language" cfg_true "$P3/.stable-build/config.json" "keys === 'language,schemaVersion' && c.language === 'en'"
check "guard stays off: the hooks' consent gate stays closed" gate_closed "$P3/.stable-build/config.json"
check "manifest: guard disabled; config.json created (for the language)" mf_true "$P3/.stable-build/manifest.json" "m.guard.enabled === false && m.files['config.json'].createdByUs === true && m.language === 'en'"
check "the no-terminal default is not recorded as a decline" mf_true "$P3/.stable-build/manifest.json" "!m.guard.declinedAt"
show_out_on_fail "$F0"
F0=$FAILS
run_inst "$H3" "$STUB_PATH" "" --prefix="$P3" --no-mcp --no-circle --no-studio --update --yes
check "--update --yes asks nothing" out_lacks "Continue?"
check "--update --yes leaves the guard off" guard_off "$P3/.stable-build/config.json"
check "--update explains how to turn it on" out_has "--update never turns it on"
run_inst "$H3" "$STUB_PATH" "" --prefix="$P3" --no-mcp --no-hooks --yes
check "rerun with --yes adds Circle and Arc Studio" called "claude plugin install circle-skills@circle"
check "--no-hooks is recorded as a decline" mf_true "$P3/.stable-build/manifest.json" "typeof m.guard.declinedAt === 'string' && m.guard.enabled === false"
run_inst "$H3" "$STUB_PATH" "" --prefix="$P3" --no-mcp --yes
check "a later install --yes keeps a declined guard off" guard_off "$P3/.stable-build/config.json"
check "it says the guard was declined" out_has "  – Guard: off (declined on "
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
check "and names what it left out" out_has "  – Not added without your yes: Circle's skills, Arc Studio, Arc Foundry, the guard."
check "no Arc Foundry download in an agent session" not_called "curl"
check "Circle not installed" not_called "circle-skills@circle"
check "Arc Studio not registered" not_called "arc-studio skills install"
check "guard stays off" guard_off "$P3B/.stable-build/config.json"
expect_calls "claude plugin install stable-build@stable-build"
show_out_on_fail "$F0"

# ================================================================ S3c: no terminal, every gate live
section "S3c no terminal, no --yes, zsh, no arc-studio anywhere: stable-build and its MCP plugin only"
# Here the installer would want npm (no arc-studio), curl (Arc Foundry) and ~/.zshrc (zsh, and
# ~/.local/bin not on PATH), so each "not without a yes" check can fail.
P3C="$WORK/p3c"; seed_prefix "$P3C"; printf '# my zshrc\n' >"$P3C/.zshrc"; cp "$P3C/.zshrc" "$WORK/p3c-zshrc.before"
F0=$FAILS
run_inst "$WORK/h3c" "$NOSTUDIO_PATH" "SHELL=/bin/zsh STABLE_BUILD_NO_TTY=1" --prefix="$P3C"
check "install exits 0" test "$RC" = 0
expect_calls \
  "claude plugin install stable-build@stable-build" "codex plugin add stable-build@stable-build" \
  "claude plugin install stable-build-mcp@stable-build" "codex plugin add stable-build-mcp@stable-build"
check "the MCP plugin is reported" out_has "  ✓ MCP servers: arc-docs, circle-codegen"
check "no npm install of the Arc Studio CLI without a yes" not_called "npm install"
npm_reads_only() { ! { grep '^npm ' "$LOG" | grep -vxq 'npm prefix -g'; }; }
check "npm is only asked for its prefix" npm_reads_only
check "no Arc Foundry download without a yes" not_called "curl"
check "the .zshrc untouched without a yes" cmp -s "$P3C/.zshrc" "$WORK/p3c-zshrc.before"
check "no binary in ~/.local/bin" test ! -e "$P3C/.local"
check "nothing under the sandbox's npm prefix" test ! -e "$P3C/.npm-global"
check "Circle not installed" not_called "circle-skills@circle"
check "the hint names all four" out_has "  – Not added without your yes: Circle's skills, Arc Studio, Arc Foundry, the guard."
check "guard stays off" guard_off "$P3C/.stable-build/config.json"
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
check "uninstall plan names the files it removes" out_has "manifest.json, config.json (guard consent, language), install.log; the directory only if then empty"
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
(cd "$H8/work" && env -i HOME="$H8" PATH="$STUB_PATH" TMPDIR="$WORK" LANG=C SHELL=/bin/sh SB_FAKE_LOG="$LOG" \
  SB_FAKE_REPOS="$REPOS" SB_FAKE_ARC_PKG="$ARCPKG" SB_FAKE_FOUNDRY_DIR="$FOUNDRY_FIX" CDPATH="$H8/projects" \
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
check "the update/remove line quotes the prefix" out_has "--update or --uninstall, plus --prefix='$P8'."
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
check "plan: Arc Foundry for this platform, tag from the GitHub API" out_has "install aarch64-apple-darwin, latest release (GitHub API) (asks first)"
check "plan: the Arc Studio sign-in waits for a person" out_has "skipped: nobody can answer here; sign in later"
check "plan keeps the full header" out_has "  language: en (default)"
check "dry run downloads nothing" not_called "curl"
run_inst "$WORK/h5" "$STUB_PATH" "STABLE_BUILD_FOUNDRY_TAG=v0.8.0-3 SHELL=/bin/bash" --prefix="$P5" --dry-run
check "plan: STABLE_BUILD_FOUNDRY_TAG" out_has "install aarch64-apple-darwin, tag v0.8.0-3 from STABLE_BUILD_FOUNDRY_TAG (asks first)"
check "plan: bash on macOS puts the PATH lines in ~/.bash_profile" out_has "$P5/.bash_profile"
check "that dry run made only read calls too" only_reads

# ================================================================ F: Arc Foundry
QUIET_F="--no-circle --no-studio --no-mcp"

section "F1 Arc Foundry: download, checksum, install, two PATH lines in ~/.zshrc; rerun; uninstall"
PF="$WORK/pf"; mkdir -p "$PF"; HF="$WORK/hf"
printf '# my zshrc\nalias ll="ls -l"' >"$PF/.zshrc"   # no newline at the end
cp "$PF/.zshrc" "$WORK/zshrc.before"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$HF" "$STUB_PATH" "SHELL=/bin/zsh" --prefix="$PF" --yes $QUIET_F
check "install exits 0" test "$RC" = 0
check "arc-forge, arc-cast, arc-anvil in the sandbox's ~/.local/bin, mode 755, each runs" foundry_installed "$PF/.local/bin" 0.8.0-2
check "status line names the rc file" out_has "  ✓ Arc Foundry v0.8.0-2 (arc-forge, arc-cast, arc-anvil), on PATH via $PF/.zshrc in new terminals"
{ cat "$WORK/zshrc.before"; printf '\n%s\n%s\n' "$RC_MARK" "$RC_PATHLINE"; } >"$WORK/zshrc.expected"
check ".zshrc: a newline, then exactly the two lines; the rest kept" cmp -s "$PF/.zshrc" "$WORK/zshrc.expected"
check "manifest: the PATH lines (file, ours, separator added, file not created)" mf_true "$PF/.stable-build/manifest.json" "m.tools.arcFoundry.pathLine.addedByUs === true && m.tools.arcFoundry.pathLine.file === '$PF/.zshrc' && m.tools.arcFoundry.pathLine.separatorAdded === true && !m.tools.arcFoundry.pathLine.createdFile"
check "nothing outside the sandbox" is_empty_dir "$HF"
show_out_on_fail "$F0"
cp "$PF/.zshrc" "$WORK/zshrc.after"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$HF" "$STUB_PATH" "SHELL=/bin/zsh" --prefix="$PF" --yes $QUIET_F
check "rerun exits 0" test "$RC" = 0
check "rerun makes only read calls (no download)" only_reads
check "rerun adds no second pair of lines" cmp -s "$PF/.zshrc" "$WORK/zshrc.after"
check "rerun reports Arc Foundry as present" out_has "  ✓ Arc Foundry v0.8.0-2 (arc-forge, arc-cast, arc-anvil)"
check "and, as ~/.local/bin is not on this PATH, where new terminals get it from" out_has "  ✓ Arc Foundry v0.8.0-2 (arc-forge, arc-cast, arc-anvil), on PATH via $PF/.zshrc in new terminals"
show_out_on_fail "$F0"
F0=$FAILS
run_inst "$HF" "$STUB_PATH" "SHELL=/bin/zsh" --prefix="$PF" --uninstall --dry-run
check "uninstall plan names the binaries and the rc file" out_has "$PF/.zshrc"
check "the plan removes nothing" foundry_installed "$PF/.local/bin" 0.8.0-2
run_inst "$HF" "$STUB_PATH" "SHELL=/bin/zsh" --prefix="$PF" --uninstall --yes
check "uninstall exits 0" test "$RC" = 0
check "the binaries are gone" foundry_absent "$PF/.local/bin"
check ".zshrc is byte for byte what it was before the install" cmp -s "$PF/.zshrc" "$WORK/zshrc.before"
check "says so" out_has "  ✓ Removed the 2 PATH lines stable-build added to $PF/.zshrc"
check "the empty ~/.local/bin it created is gone too" test ! -e "$PF/.local"
check "state directory removed" test ! -e "$PF/.stable-build"
show_out_on_fail "$F0"

section "F1b Linux x86_64 with bash: the gnu archive, a new ~/.bashrc, deleted again on uninstall"
PFL="$WORK/pfl"; mkdir -p "$PFL"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$WORK/hfl" "$STUB_PATH" "SB_FAKE_UNAME_S=Linux SB_FAKE_UNAME_M=x86_64 SHELL=/bin/bash" --prefix="$PFL" --yes $QUIET_F
check "install exits 0" test "$RC" = 0
check "the x86_64-unknown-linux-gnu archive" called_re '/releases/download/v0\.8\.0-2/arc-foundry-v0\.8\.0-2-x86_64-unknown-linux-gnu\.tar\.gz$'
check "installed" foundry_installed "$PFL/.local/bin" 0.8.0-2
printf '%s\n%s\n' "$RC_MARK" "$RC_PATHLINE" >"$WORK/bashrc.expected"
check ".bashrc created with the two lines" cmp -s "$PFL/.bashrc" "$WORK/bashrc.expected"
check "manifest: the rc file was created by the installer" mf_true "$PFL/.stable-build/manifest.json" "m.tools.arcFoundry.pathLine.createdFile === true && m.tools.arcFoundry.target === 'x86_64-unknown-linux-gnu'"
run_inst "$WORK/hfl" "$STUB_PATH" "SB_FAKE_UNAME_S=Linux SB_FAKE_UNAME_M=x86_64 SHELL=/bin/bash" --prefix="$PFL" --uninstall --yes
check "uninstall exits 0" test "$RC" = 0
check "the ~/.bashrc it created (now empty) is deleted" test ! -e "$PFL/.bashrc"
check "the binaries are gone" foundry_absent "$PFL/.local/bin"
show_out_on_fail "$F0"

section "F2 a checksum mismatch installs nothing and is not fatal"
PF2="$WORK/pf2"; mkdir -p "$PF2"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$WORK/hf2" "$STUB_PATH" "SB_FAKE_SHA_BAD=1 SHELL=/bin/zsh" --prefix="$PF2" --yes $QUIET_F
check "install exits 0" test "$RC" = 0
check "one ✗ line" out_has "  ✗ Arc Foundry: checksum mismatch, nothing installed"
check "no binary" foundry_absent "$PF2/.local/bin"
check "no rc file" test ! -e "$PF2/.zshrc"
check "manifest: Arc Foundry not recorded" mf_true "$PF2/.stable-build/manifest.json" "!(m.tools && m.tools.arcFoundry && m.tools.arcFoundry.addedByUs)"
check "the rest installed" out_has "  ✓ stable-build "
check "the guard still turned on" grep -q '"guard": *true' "$PF2/.stable-build/config.json"
show_out_on_fail "$F0"

section "F3 no prebuilt archive (Intel Mac): one line, no download"
PF3="$WORK/pf3"; mkdir -p "$PF3"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$WORK/hf3" "$STUB_PATH" "SB_FAKE_UNAME_S=Darwin SB_FAKE_UNAME_M=x86_64" --prefix="$PF3" --yes $QUIET_F
check "install exits 0" test "$RC" = 0
check "names the platform and the build-from-source docs" out_has "  – Arc Foundry: no prebuilt binary for Darwin/x86_64; build from source: https://github.com/circlefin/arc-foundry#building-from-source"
check "no download" not_called "curl"
check "no binary" foundry_absent "$PF3/.local/bin"
show_out_on_fail "$F0"

section "F4 an arc-forge the installer did not write is left alone"
PF4="$WORK/pf4"; mkdir -p "$PF4/.local/bin"; printf '#!/bin/sh\necho mine\n' >"$PF4/.local/bin/arc-forge"; chmod 755 "$PF4/.local/bin/arc-forge"
cp "$PF4/.local/bin/arc-forge" "$WORK/foreign-forge"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$WORK/hf4" "$STUB_PATH" "SHELL=/bin/zsh" --prefix="$PF4" --yes $QUIET_F
check "install exits 0" test "$RC" = 0
check "no download" not_called "curl"
check "reported as found" out_has "  ✓ Arc Foundry: found at $PF4/.local/bin/arc-forge"
check "found in ~/.local/bin but not on PATH: the line says how to put it there (no rc edit)" out_has "  ✓ Arc Foundry: found at $PF4/.local/bin/arc-forge; add $PF4/.local/bin to PATH: export PATH="
check "no rc file written for a binary it did not install" test ! -e "$PF4/.zshrc"
check "not overwritten" cmp -s "$PF4/.local/bin/arc-forge" "$WORK/foreign-forge"
check "manifest: not ours" mf_true "$PF4/.stable-build/manifest.json" "m.tools.arcFoundry.addedByUs === false"
run_inst "$WORK/hf4" "$STUB_PATH" "SHELL=/bin/zsh" --prefix="$PF4" --uninstall --yes
check "uninstall exits 0" test "$RC" = 0
check "uninstall keeps it" cmp -s "$PF4/.local/bin/arc-forge" "$WORK/foreign-forge"
show_out_on_fail "$F0"
PF4B="$WORK/pf4b"; mkdir -p "$PF4B/.local/bin"; printf 'mine\n' >"$PF4B/.local/bin/arc-cast"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$WORK/hf4b" "$STUB_PATH" "SHELL=/bin/zsh" --prefix="$PF4B" --yes $QUIET_F
check "a foreign arc-cast (arc-forge missing): exits 0" test "$RC" = 0
check "nothing installed, and it says why" out_has "  – Arc Foundry: $PF4B/.local/bin/arc-cast exists and was not installed by stable-build; nothing installed"
f4b_kept() { [ "$(cat "$PF4B/.local/bin/arc-cast")" = mine ] && [ ! -e "$PF4B/.local/bin/arc-forge" ]; }
check "arc-cast kept, arc-forge not written" f4b_kept
check "no rc edit either" test ! -e "$PF4B/.zshrc"
show_out_on_fail "$F0"

section "F5 --no-foundry; STABLE_BUILD_FOUNDRY_TAG; a GitHub API failure; an invalid tag"
PF5="$WORK/pf5"; mkdir -p "$PF5"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$WORK/hf5" "$STUB_PATH" "SHELL=/bin/zsh" --prefix="$PF5" --yes --no-foundry $QUIET_F
check "--no-foundry: exits 0" test "$RC" = 0
check "--no-foundry: no download" not_called "curl"
check "--no-foundry: one line" out_has "  – Arc Foundry: skipped (--no-foundry)"
check "--no-foundry: no rc file" test ! -e "$PF5/.zshrc"
# shellcheck disable=SC2086
run_inst "$WORK/hf5" "$STUB_PATH" "STABLE_BUILD_FOUNDRY_TAG=v0.8.0-3" --prefix="$PF5" --yes $QUIET_F
check "STABLE_BUILD_FOUNDRY_TAG: no GitHub API call" not_called "releases/latest"
check "STABLE_BUILD_FOUNDRY_TAG: that release is installed" foundry_installed "$PF5/.local/bin" 0.8.0-3
check "manifest: tag v0.8.0-3" mf_true "$PF5/.stable-build/manifest.json" "m.tools.arcFoundry.tag === 'v0.8.0-3'"
PF5B="$WORK/pf5b"; mkdir -p "$PF5B"
# shellcheck disable=SC2086
run_inst "$WORK/hf5" "$STUB_PATH" "SB_FAKE_CURL_API_FAIL=1" --prefix="$PF5B" --yes $QUIET_F
check "GitHub API failure: exits 0" test "$RC" = 0
check "GitHub API failure: one ✗ line" out_has "  ✗ Arc Foundry: could not read the latest release from GitHub; nothing installed"
check "GitHub API failure: nothing installed" foundry_absent "$PF5B/.local/bin"
# shellcheck disable=SC2086
run_inst "$WORK/hf5" "$STUB_PATH" "STABLE_BUILD_FOUNDRY_TAG=1.0;rm" --prefix="$PF5B" --yes $QUIET_F
check "an invalid STABLE_BUILD_FOUNDRY_TAG is reported and the latest release is used" out_has "STABLE_BUILD_FOUNDRY_TAG=1.0;rm is not a release tag such as v0.8.0-2; using the latest release"
check "it installed the latest release" foundry_installed "$PF5B/.local/bin" 0.8.0-2
show_out_on_fail "$F0"

section "F6 --update replaces the Arc Foundry this installer added when a newer release is out"
PF6="$WORK/pf6"; mkdir -p "$PF6"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$WORK/hf6" "$STUB_PATH" "" --prefix="$PF6" --yes $QUIET_F
check "install v0.8.0-2" foundry_installed "$PF6/.local/bin" 0.8.0-2
# shellcheck disable=SC2086
run_inst "$WORK/hf6" "$STUB_PATH" "SB_FAKE_FOUNDRY_TAG=v0.8.0-3" --prefix="$PF6" --update --yes $QUIET_F
check "--update exits 0" test "$RC" = 0
check "--update installs the newer release" foundry_installed "$PF6/.local/bin" 0.8.0-3
check "status line shows the new tag and the old one" out_has "  ✓ Arc Foundry v0.8.0-3 (was v0.8.0-2) (arc-forge, arc-cast, arc-anvil)"
check "manifest: tag v0.8.0-3, still ours" mf_true "$PF6/.stable-build/manifest.json" "m.tools.arcFoundry.tag === 'v0.8.0-3' && m.tools.arcFoundry.addedByUs === true"
check "manifest: the sha256 of each binary it wrote" mf_true "$PF6/.stable-build/manifest.json" "['arc-forge','arc-cast','arc-anvil'].every((n) => /^[0-9a-f]{64}$/.test(m.tools.arcFoundry.sha256[n]))"
show_out_on_fail "$F0"

section "F7 bash on macOS with only ~/.profile: the lines go there, and no ~/.bash_profile hides it"
PF7="$WORK/pf7"; mkdir -p "$PF7"
# shellcheck disable=SC2016 # the user's own line, written as is
printf 'export PATH="$HOME/mytools:$PATH"\n' >"$PF7/.profile"; cp "$PF7/.profile" "$WORK/pf7-profile.before"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$WORK/hf7" "$STUB_PATH" "SHELL=/bin/bash" --prefix="$PF7" --yes $QUIET_F
check "install exits 0" test "$RC" = 0
check "no ~/.bash_profile created (bash would stop reading ~/.profile)" test ! -e "$PF7/.bash_profile"
{ cat "$WORK/pf7-profile.before"; printf '%s\n%s\n' "$RC_MARK" "$RC_PATHLINE"; } >"$WORK/pf7-profile.expected"
check ".profile: the two lines appended, the rest kept" cmp -s "$PF7/.profile" "$WORK/pf7-profile.expected"
check "status line names ~/.profile" out_has "on PATH via $PF7/.profile in new terminals"
check "manifest: ~/.profile, not created by the installer" mf_true "$PF7/.stable-build/manifest.json" "m.tools.arcFoundry.pathLine.file === '$PF7/.profile' && m.tools.arcFoundry.pathLine.createdFile === false"
# shellcheck disable=SC2086
run_inst "$WORK/hf7" "$STUB_PATH" "SHELL=/bin/bash" --prefix="$PF7" --uninstall --yes
check "uninstall exits 0" test "$RC" = 0
check ".profile byte for byte as before" cmp -s "$PF7/.profile" "$WORK/pf7-profile.before"
PF7B="$WORK/pf7b-not-created"
run_inst "$WORK/hf7" "$STUB_PATH" "SHELL=/bin/bash" --prefix="$PF7B" --dry-run
check "dry run with no profile at all: a new ~/.bash_profile" out_has "$PF7B/.bash_profile"
PF7C="$WORK/pf7c"; mkdir -p "$PF7C"; : >"$PF7C/.bash_login"; : >"$PF7C/.profile"
run_inst "$WORK/hf7" "$STUB_PATH" "SHELL=/bin/bash" --prefix="$PF7C" --dry-run
check "dry run with ~/.bash_login and ~/.profile: ~/.bash_login, the one bash reads" out_has "$PF7C/.bash_login"
show_out_on_fail "$F0"

section "F8 the login shell changed (zsh, then bash): no second rc file; uninstall takes out the first one's lines"
PF8="$WORK/pf8"; mkdir -p "$PF8"; printf 'alias z=1\n' >"$PF8/.zshrc"; cp "$PF8/.zshrc" "$WORK/pf8-zshrc.before"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$WORK/hf8" "$STUB_PATH" "SHELL=/bin/zsh" --prefix="$PF8" --yes $QUIET_F
check "zsh install: the lines go into ~/.zshrc" grep -Fxq "$RC_MARK" "$PF8/.zshrc"
# shellcheck disable=SC2086
run_inst "$WORK/hf8" "$STUB_PATH" "SHELL=/bin/bash SB_FAKE_FOUNDRY_TAG=v0.8.0-3" --prefix="$PF8" --update --yes $QUIET_F
check "--update under bash exits 0" test "$RC" = 0
check "--update installs the newer release" foundry_installed "$PF8/.local/bin" 0.8.0-3
check "no ~/.bash_profile written while ~/.zshrc holds the recorded lines" test ! -e "$PF8/.bash_profile"
check "the PATH hint instead" out_has "; add $PF8/.local/bin to PATH: export PATH="
check "manifest: the record still names ~/.zshrc" mf_true "$PF8/.stable-build/manifest.json" "m.tools.arcFoundry.pathLine.file === '$PF8/.zshrc'"
# shellcheck disable=SC2086
run_inst "$WORK/hf8" "$STUB_PATH" "SHELL=/bin/bash" --prefix="$PF8" --uninstall --yes
check "uninstall exits 0" test "$RC" = 0
check ".zshrc byte for byte as before the install" cmp -s "$PF8/.zshrc" "$WORK/pf8-zshrc.before"
show_out_on_fail "$F0"

section "F9 the rc flags describe the lines in the file now: a re-add after the user took them out"
PF9="$WORK/pf9"; mkdir -p "$PF9"; printf 'alias x=1' >"$PF9/.zshrc"   # no newline at the end
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$WORK/hf9" "$STUB_PATH" "SHELL=/bin/zsh" --prefix="$PF9" --yes $QUIET_F
check "first add: a separating newline, recorded" mf_true "$PF9/.stable-build/manifest.json" "m.tools.arcFoundry.pathLine.separatorAdded === true"
printf 'alias x=1\nalias y=2\n' >"$PF9/.zshrc"; cp "$PF9/.zshrc" "$WORK/pf9-zshrc.user"   # the user took our lines out
# shellcheck disable=SC2086
run_inst "$WORK/hf9" "$STUB_PATH" "SHELL=/bin/zsh SB_FAKE_FOUNDRY_TAG=v0.8.0-3" --prefix="$PF9" --update --yes $QUIET_F
check "--update adds the two lines again, with no separator this time" mf_true "$PF9/.stable-build/manifest.json" "m.tools.arcFoundry.pathLine.separatorAdded === false && m.tools.arcFoundry.pathLine.createdFile === false"
# shellcheck disable=SC2086
run_inst "$WORK/hf9" "$STUB_PATH" "SHELL=/bin/zsh" --prefix="$PF9" --uninstall --yes
check "uninstall keeps the newline the user wrote: the file is exactly theirs" cmp -s "$PF9/.zshrc" "$WORK/pf9-zshrc.user"
show_out_on_fail "$F0"

section "F10 binaries that do not run are never put in place, and a rerun tries again instead of reporting them"
PF10="$WORK/pf10"; mkdir -p "$PF10"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$WORK/hf10" "$STUB_PATH" "SHELL=/bin/zsh STABLE_BUILD_FOUNDRY_TAG=v0.9.0-broken" --prefix="$PF10" --yes $QUIET_F
check "install exits 0 (not fatal)" test "$RC" = 0
check "one ✗ line" out_has "  ✗ Arc Foundry: arc-forge --version failed with this release, so nothing was changed; see $PF10/.stable-build/install.log"
check "no binary left" foundry_absent "$PF10/.local/bin"
check "the ~/.local/bin it would have created is not left behind" test ! -e "$PF10/.local"
check "no rc edit" test ! -e "$PF10/.zshrc"
check "manifest: nothing recorded for Arc Foundry" mf_true "$PF10/.stable-build/manifest.json" "!(m.tools && m.tools.arcFoundry)"
# shellcheck disable=SC2086
run_inst "$WORK/hf10" "$STUB_PATH" "SHELL=/bin/zsh STABLE_BUILD_FOUNDRY_TAG=v0.9.0-broken" --prefix="$PF10" --yes $QUIET_F
check "rerun: downloads and tries again" called_re '/releases/download/v0\.9\.0-broken/'
check "rerun: ✗ again, never ✓" out_lacks "  ✓ Arc Foundry"
# shellcheck disable=SC2086
run_inst "$WORK/hf10" "$STUB_PATH" "SHELL=/bin/zsh" --prefix="$PF10" --yes $QUIET_F
check "a release that runs installs on the next run" foundry_installed "$PF10/.local/bin" 0.8.0-2
show_out_on_fail "$F0"

section "F11 an arc-forge the user put in place of ours: --update does not overwrite it, --uninstall keeps it"
PF11="$WORK/pf11"; mkdir -p "$PF11"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$WORK/hf11" "$STUB_PATH" "" --prefix="$PF11" --yes $QUIET_F
check "install v0.8.0-2" foundry_installed "$PF11/.local/bin" 0.8.0-2
printf '#!/bin/sh\necho "forge built from source"\n' >"$PF11/.local/bin/arc-forge"; chmod 755 "$PF11/.local/bin/arc-forge"
cp "$PF11/.local/bin/arc-forge" "$WORK/pf11-forge.user"
# shellcheck disable=SC2086
run_inst "$WORK/hf11" "$STUB_PATH" "SB_FAKE_FOUNDRY_TAG=v0.8.0-3" --prefix="$PF11" --update --yes $QUIET_F
check "--update exits 0" test "$RC" = 0
check "--update leaves the user's arc-forge as it is" cmp -s "$PF11/.local/bin/arc-forge" "$WORK/pf11-forge.user"
check "--update says it is not the installer's" out_has "  ✓ Arc Foundry: found at $PF11/.local/bin/arc-forge"
check "--update downloads nothing" not_called "/releases/download/"
run_inst "$WORK/hf11" "$STUB_PATH" "" --prefix="$PF11" --uninstall --yes
check "uninstall exits 0" test "$RC" = 0
check "uninstall keeps the user's arc-forge" cmp -s "$PF11/.local/bin/arc-forge" "$WORK/pf11-forge.user"
check "and removes the two that are still ours" test ! -e "$PF11/.local/bin/arc-cast" -a ! -e "$PF11/.local/bin/arc-anvil"
check "it says both" out_has "  ✓ Removed Arc Foundry from $PF11/.local/bin"
check "the kept line" out_has "  – Kept $PF11/.local/bin/arc-forge: it is no longer the file stable-build installed"
show_out_on_fail "$F0"
PF12="$WORK/pf12"; mkdir -p "$PF12"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$WORK/hf12" "$STUB_PATH" "" --prefix="$PF12" --yes $QUIET_F
mkdir -p "$PF12/mine"
for t in forge cast anvil; do
  printf 'mine\n' >"$PF12/mine/$t"; rm -f "$PF12/.local/bin/arc-$t"; ln -s "$PF12/mine/$t" "$PF12/.local/bin/arc-$t"
done
run_inst "$WORK/hf12" "$STUB_PATH" "" --prefix="$PF12" --uninstall --yes
check "all three replaced by symlinks: uninstall exits 0" test "$RC" = 0
check "all three kept" test -L "$PF12/.local/bin/arc-forge" -a -L "$PF12/.local/bin/arc-cast" -a -L "$PF12/.local/bin/arc-anvil"
check "no 'Removed Arc Foundry' line when nothing was removed" out_lacks "Removed Arc Foundry"
check "only the kept line" out_has "  – Kept $PF12/.local/bin/arc-forge, $PF12/.local/bin/arc-cast, $PF12/.local/bin/arc-anvil: it is no longer the file stable-build installed"
show_out_on_fail "$F0"

section "F13 a bin directory it cannot write to: --update fails on its line and leaves the installed release as it was"
PF13="$WORK/pf13"; mkdir -p "$PF13"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$WORK/hf13" "$STUB_PATH" "" --prefix="$PF13" --yes $QUIET_F
check "install v0.8.0-2" foundry_installed "$PF13/.local/bin" 0.8.0-2
chmod 555 "$PF13/.local/bin"
# shellcheck disable=SC2086
run_inst "$WORK/hf13" "$STUB_PATH" "SB_FAKE_FOUNDRY_TAG=v0.8.0-3" --prefix="$PF13" --update --yes $QUIET_F
chmod 755 "$PF13/.local/bin"
check "--update exits 0 (not fatal)" test "$RC" = 0
check "one ✗ line" out_has "  ✗ Arc Foundry: could not write to $PF13/.local/bin; nothing installed"
check "the installed release still runs, unchanged" foundry_installed "$PF13/.local/bin" 0.8.0-2
check "nothing left next to it but the three binaries" only_foundry_files "$PF13/.local/bin"
check "manifest: still v0.8.0-2" mf_true "$PF13/.stable-build/manifest.json" "m.tools.arcFoundry.tag === 'v0.8.0-2' && /^forge 0.8.0-2/.test(m.tools.arcFoundry.version)"
show_out_on_fail "$F0"

section "F14 a backslash in --prefix and TMPDIR: the checksum matches, and --update and --uninstall still know the binaries as ours"
# shasum and sha256sum put a backslash before the digest of a file whose name holds one
PF14="$WORK/pf14\\b"; TMP14="$WORK/tmp\\14"; mkdir -p "$PF14" "$TMP14"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$WORK/hf14" "$STUB_PATH" "TMPDIR=$TMP14" --prefix="$PF14" --yes $QUIET_F
check "install exits 0" test "$RC" = 0
check "the downloaded archive matches its .sha256" out_lacks "checksum mismatch"
check "installed" foundry_installed "$PF14/.local/bin" 0.8.0-2
check "manifest: each recorded sha256 is 64 hex digits" mf_true "$PF14/.stable-build/manifest.json" "['arc-forge','arc-cast','arc-anvil'].every((n) => /^[0-9a-f]{64}$/.test(m.tools.arcFoundry.sha256[n]))"
# shellcheck disable=SC2086
run_inst "$WORK/hf14" "$STUB_PATH" "TMPDIR=$TMP14 SB_FAKE_FOUNDRY_TAG=v0.8.0-3" --prefix="$PF14" --update --yes $QUIET_F
check "--update replaces its own binaries" foundry_installed "$PF14/.local/bin" 0.8.0-3
run_inst "$WORK/hf14" "$STUB_PATH" "TMPDIR=$TMP14" --prefix="$PF14" --uninstall --yes
check "uninstall exits 0" test "$RC" = 0
check "uninstall removes them" foundry_absent "$PF14/.local/bin"
show_out_on_fail "$F0"

section "F15 a dangling ~/.zshrc symlink is not followed: nothing is created at its far end, the PATH hint instead"
PF15="$WORK/pf15"; mkdir -p "$PF15/dotfiles"; ln -s "$PF15/dotfiles/zshrc" "$PF15/.zshrc"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$WORK/hf15" "$STUB_PATH" "SHELL=/bin/zsh" --prefix="$PF15" --yes $QUIET_F
check "install exits 0" test "$RC" = 0
check "installed" foundry_installed "$PF15/.local/bin" 0.8.0-2
check "the PATH hint instead of an rc edit" out_has "  ✓ Arc Foundry v0.8.0-2 (arc-forge, arc-cast, arc-anvil); add $PF15/.local/bin to PATH: export PATH="
check "no file created at the far end of the link" test ! -e "$PF15/dotfiles/zshrc"
check "the link is still a link" test -L "$PF15/.zshrc"
check "manifest: no PATH lines recorded" mf_true "$PF15/.stable-build/manifest.json" "!m.tools.arcFoundry.pathLine"
run_inst "$WORK/hf15" "$STUB_PATH" "SHELL=/bin/zsh" --prefix="$PF15" --uninstall --yes
check "uninstall exits 0" test "$RC" = 0
check "uninstall keeps the user's link" test -L "$PF15/.zshrc" -a ! -e "$PF15/dotfiles/zshrc"
show_out_on_fail "$F0"

section "F16 an interrupt while the new binaries are staged leaves nothing behind, and the installed release as it was"
PF16="$WORK/pf16"; mkdir -p "$PF16"
INTBIN="$WORK/interrupt-bin"; mkdir -p "$INTBIN"
# a cp that copies, then sends TERM to the installer that ran it, as a Ctrl+C during the copies does
# shellcheck disable=SC2016 # the stub's own "$@" and $PPID
printf '#!/bin/sh\n/bin/cp "$@" || exit $?\nkill -TERM "$PPID"\n' >"$INTBIN/cp"; chmod 755 "$INTBIN/cp"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$WORK/hf16" "$STUB_PATH" "" --prefix="$PF16" --yes $QUIET_F
check "install v0.8.0-2" foundry_installed "$PF16/.local/bin" 0.8.0-2
# shellcheck disable=SC2086
run_inst "$WORK/hf16" "$INTBIN:$STUB_PATH" "SB_FAKE_FOUNDRY_TAG=v0.8.0-3" --prefix="$PF16" --update --yes $QUIET_F
check "TERM during the copies stops the run (exit 130)" test "$RC" = 130
check "the copy had started" called_re '/releases/download/v0\.8\.0-3/'
check "nothing left next to the binaries: the staging directory went with the run" only_foundry_files "$PF16/.local/bin"
check "the installed release still runs, unchanged" foundry_installed "$PF16/.local/bin" 0.8.0-2
check "manifest: still v0.8.0-2" mf_true "$PF16/.stable-build/manifest.json" "m.tools.arcFoundry.tag === 'v0.8.0-2'"
show_out_on_fail "$F0"

section "F17 --update to a release that does not run here keeps the release that works"
PF17="$WORK/pf17"; mkdir -p "$PF17"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$WORK/hf17" "$STUB_PATH" "SHELL=/bin/zsh" --prefix="$PF17" --yes $QUIET_F
check "install v0.8.0-2" foundry_installed "$PF17/.local/bin" 0.8.0-2
cp "$PF17/.zshrc" "$WORK/pf17-zshrc.after"
# shellcheck disable=SC2086
run_inst "$WORK/hf17" "$STUB_PATH" "SHELL=/bin/zsh SB_FAKE_FOUNDRY_TAG=v0.9.0-broken" --prefix="$PF17" --update --yes $QUIET_F
check "--update exits 0 (not fatal)" test "$RC" = 0
check "one ✗ line: nothing changed" out_has "  ✗ Arc Foundry: arc-forge --version failed with this release, so nothing was changed; see $PF17/.stable-build/install.log"
check "the release that works is still installed, and runs" foundry_installed "$PF17/.local/bin" 0.8.0-2
check "nothing left next to it" only_foundry_files "$PF17/.local/bin"
check "manifest: still v0.8.0-2 and ours, with its version" mf_true "$PF17/.stable-build/manifest.json" "m.tools.arcFoundry.tag === 'v0.8.0-2' && m.tools.arcFoundry.addedByUs === true && /^forge 0.8.0-2/.test(m.tools.arcFoundry.version)"
check "the PATH lines untouched" cmp -s "$PF17/.zshrc" "$WORK/pf17-zshrc.after"
# shellcheck disable=SC2086
run_inst "$WORK/hf17" "$STUB_PATH" "SHELL=/bin/zsh SB_FAKE_FOUNDRY_TAG=v0.8.0-3" --prefix="$PF17" --update --yes $QUIET_F
check "a later --update to a release that runs replaces it (still known as ours)" foundry_installed "$PF17/.local/bin" 0.8.0-3
run_inst "$WORK/hf17" "$STUB_PATH" "SHELL=/bin/zsh" --prefix="$PF17" --uninstall --yes
check "uninstall exits 0" test "$RC" = 0
check "uninstall removes the binaries" foundry_absent "$PF17/.local/bin"
check "and the .zshrc it created" test ! -e "$PF17/.zshrc"
show_out_on_fail "$F0"

# ================================================================ N: the Arc Studio CLI through npm
section "N1 Arc Studio CLI via npm (sandboxed prefix), then its plugin; --update; uninstall in order"
PN="$WORK/pn"; seed_prefix "$PN"; HN1="$WORK/hn1"
F0=$FAILS
run_inst "$HN1" "$NOSTUDIO_PATH" "" --prefix="$PN" --yes --no-circle --no-mcp --no-foundry
check "install exits 0" test "$RC" = 0
check "npm install of the CLI" called "npm install -g @circle-fin/arc-studio-cli@latest"
check "into the sandbox (npm_config_prefix=\$PREFIX/.npm-global)" test -L "$PN/.npm-global/bin/arc-studio"
check "then its Claude Code plugin" called_before "npm install -g" "arc-studio skills install --tool claude-code"
check "the plugin is installed" called "claude plugin install arc-studio@arc-studio-cli -y"
check "status line" out_has "  ✓ Arc Studio CLI 1.2.1 and its Claude Code plugin (in Codex, use the stable-build studio-delegate skill)"
check "npm's bin is not on PATH here: one hint" out_has "    $PN/.npm-global/bin is not on PATH; add it there to run arc-studio by name"
check "--yes: no sign-in" not_called "arc-studio login"
check "manifest: the npm package is ours, with its version and npm prefix" mf_true "$PN/.stable-build/manifest.json" "m.tools.arcStudioCli.addedByUs === true && m.tools.arcStudioCli.version === '1.2.1' && m.tools.arcStudioCli.package === '@circle-fin/arc-studio-cli' && m.tools.arcStudioCli.prefix === '$PN/.npm-global'"
check "nothing outside the sandbox" is_empty_dir "$HN1"
show_out_on_fail "$F0"
F0=$FAILS
run_inst "$HN1" "$NOSTUDIO_PATH" "" --prefix="$PN" --yes --no-circle --no-mcp --no-foundry
check "rerun: exits 0" test "$RC" = 0
check "rerun: the CLI is found in npm's prefix; only read calls" only_reads
show_out_on_fail "$F0"
F0=$FAILS
run_inst "$HN1" "$NOSTUDIO_PATH" "SB_FAKE_STUDIO_VERSION=1.2.2" --prefix="$PN" --update --yes --no-circle --no-mcp --no-foundry
check "--update: npm install of the latest CLI again (added by this installer)" called "npm install -g @circle-fin/arc-studio-cli@latest"
check "--update: then its marketplace is refreshed" called_before "npm install -g @circle-fin/arc-studio-cli@latest" "claude plugin marketplace update arc-studio-cli"
check "--update: and its Claude Code plugin updated (Claude Code runs its own copy)" called_before "claude plugin marketplace update arc-studio-cli" "claude plugin update arc-studio@arc-studio-cli"
check "--update: status line shows the new version and the old one" out_has "  ✓ Arc Studio CLI 1.2.2 (was 1.2.1) and its Claude Code plugin"
check "--update: manifest version" mf_true "$PN/.stable-build/manifest.json" "m.tools.arcStudioCli.version === '1.2.2'"
show_out_on_fail "$F0"
F0=$FAILS
run_inst "$HN1" "$NOSTUDIO_PATH" "SB_FAKE_STUDIO_VERSION=1.2.3 SB_FAKE_CLAUDE_UPDATE_FAIL=arc-studio@arc-studio-cli" --prefix="$PN" --update --yes --no-circle --no-mcp --no-foundry
check "--update: a failed plugin update is not fatal" test "$RC" = 0
check "--update: one ✗ line with the command" out_has "  ✗ Arc Studio: its Claude Code plugin was not updated; run: HOME='$PN' CLAUDE_CONFIG_DIR='$PN/.claude' CODEX_HOME='$PN/.codex' claude plugin update arc-studio@arc-studio-cli"
check "--update: the rest still ran" called "claude plugin update stable-build@stable-build"
show_out_on_fail "$F0"
F0=$FAILS
run_inst "$HN1" "$NOSTUDIO_PATH" "" --prefix="$PN" --uninstall --yes
check "uninstall exits 0" test "$RC" = 0
check "the plugin first, then npm uninstall" called_before "claude plugin uninstall arc-studio@arc-studio-cli" "npm uninstall -g @circle-fin/arc-studio-cli"
check "the CLI is gone from the sandbox" test ! -e "$PN/.npm-global/bin/arc-studio"
check "says so" out_has "  ✓ Removed the Arc Studio CLI (npm uninstall -g @circle-fin/arc-studio-cli)"
check "the sign-in is never touched" not_called "arc-studio logout"
check "and it says so" out_has "Arc Studio sign-in is untouched: arc-studio logout was not run."
check "state directory removed" test ! -e "$PN/.stable-build"
check "seed preserved" seed_intact "$PN"
show_out_on_fail "$F0"

section "N2 npm cannot install globally: one ✗ line with the fix, no plugin, no sign-in, not fatal"
PN2="$WORK/pn2"; mkdir -p "$PN2"
F0=$FAILS
run_inst "$WORK/hn2" "$NOSTUDIO_PATH" "SB_FAKE_NPM_FAIL=1" --prefix="$PN2" --yes --no-circle --no-mcp --no-foundry
check "install exits 0" test "$RC" = 0
check "the ✗ line" out_has "  ✗ Arc Studio CLI: npm could not install globally; use a Node version manager (nvm, fnm) or run: sudo npm install -g @circle-fin/arc-studio-cli"
check "no plugin registration" not_called "arc-studio skills install"
check "no sign-in" not_called "arc-studio login"
check "npm's raw error stays in the log" out_lacks "EACCES"
check "and is in install.log" grep -q "npm error code EACCES" "$PN2/.stable-build/install.log"
check "manifest: no Arc Studio CLI recorded as ours" mf_true "$PN2/.stable-build/manifest.json" "!(m.tools && m.tools.arcStudioCli && m.tools.arcStudioCli.addedByUs)"
check "the rest installed, guard on" grep -q '"guard": *true' "$PN2/.stable-build/config.json"
show_out_on_fail "$F0"

section "N3 no npm at all: one line, nothing else changes"
NONPM="$WORK/no-npm-bin"; mkdir -p "$NONPM"
for t in claude curl uname; do ln -s "$FAKEBIN/$t" "$NONPM/$t"; done
# SYS_PATH has no npm (a distro Node.js puts one in /usr/bin, and a real npm here would install
# Circle's CLI from the registry)
PN3="$WORK/pn3"; mkdir -p "$PN3"
if PATH="$NONPM:$TOOLS:$SYS_PATH" command -v npm >/dev/null 2>&1; then
  echo "  skip  an npm is still on the no-npm PATH: $(PATH="$NONPM:$TOOLS:$SYS_PATH" command -v npm)"
else
  run_inst "$WORK/hn3" "$NONPM:$TOOLS:$SYS_PATH" "" --prefix="$PN3" --yes --no-circle --no-mcp --no-foundry
  check "install exits 0" test "$RC" = 0
  check "names the npm command to run later" out_has "  – Arc Studio CLI: npm not found; install Node.js with npm, then run: npm install -g @circle-fin/arc-studio-cli@latest"
  check "no npm call of any kind" not_called "npm "
  check "nothing installed under the sandbox's npm prefix" test ! -e "$PN3/.npm-global"
fi

section "N4 a node switch between runs (another npm prefix): --update and --uninstall act only where the CLI went"
# no --prefix here (it pins npm to the sandbox): a throwaway HOME, and the fake npm's global prefix
# set per run with SB_FAKE_NPM_PREFIX, as switching node versions with nvm or fnm does
HN4="$WORK/hn4"; mkdir -p "$HN4"; NODEA="$HN4/nodeA"; NODEB="$HN4/nodeB"
QUIET_N="--no-circle --no-mcp --no-foundry --no-hooks"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$HN4" "$NOSTUDIO_PATH" "SB_FAKE_NPM_PREFIX=$NODEA" --yes $QUIET_N
check "install exits 0" test "$RC" = 0
check "the CLI went into the first prefix" test -L "$NODEA/bin/arc-studio"
check "manifest: that prefix" mf_true "$HN4/.stable-build/manifest.json" "m.tools.arcStudioCli.prefix === '$NODEA'"
# the user installs a copy of their own under the other node version
env -i HOME="$HN4" PATH="$STUB_PATH" SB_FAKE_NPM_PREFIX="$NODEB" npm install -g @circle-fin/arc-studio-cli@latest >/dev/null
# shellcheck disable=SC2086
run_inst "$HN4" "$NOSTUDIO_PATH" "SB_FAKE_NPM_PREFIX=$NODEB SB_FAKE_STUDIO_VERSION=1.2.2" --update --yes $QUIET_N
check "--update under the other prefix exits 0" test "$RC" = 0
check "--update leaves the user's own copy alone (no npm install)" not_called "npm install"
# shellcheck disable=SC2086
run_inst "$HN4" "$NOSTUDIO_PATH" "SB_FAKE_NPM_PREFIX=$NODEB" --uninstall --yes
check "uninstall exits 0" test "$RC" = 0
check "uninstall removes the copy it installed, in the first prefix" test ! -e "$NODEA/bin/arc-studio" -a ! -e "$NODEA/lib/node_modules/@circle-fin/arc-studio-cli"
check "and keeps the user's copy in the other one" test -L "$NODEB/bin/arc-studio" -a -d "$NODEB/lib/node_modules/@circle-fin/arc-studio-cli"
check "says so" out_has "  ✓ Removed the Arc Studio CLI (npm uninstall -g @circle-fin/arc-studio-cli)"
show_out_on_fail "$F0"
HN5="$WORK/hn5"; mkdir -p "$HN5"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$HN5" "$NOSTUDIO_PATH" "SB_FAKE_NPM_PREFIX=$HN5/nodeA" --yes $QUIET_N
rm -rf "$HN5/nodeA/lib/node_modules/@circle-fin" "$HN5/nodeA/bin/arc-studio"   # removed by hand (or that node version was deleted)
run_inst "$HN5" "$NOSTUDIO_PATH" "SB_FAKE_NPM_PREFIX=$HN5/nodeB" --uninstall --yes
check "a CLI already gone: uninstall exits 0" test "$RC" = 0
check "no npm uninstall (nothing of ours to remove)" not_called "npm uninstall"
check "no claim that it removed it" out_lacks "Removed the Arc Studio CLI"
check "one line says it was already gone" out_has "  – Arc Studio CLI: already gone from ~/nodeA, so there was nothing to remove"
check "state directory removed" test ! -e "$HN5/.stable-build"
show_out_on_fail "$F0"

section "N5 uninstall with no host CLI, then without claude: Arc Foundry and the PATH lines go, the npm package waits for its plugin"
PN5="$WORK/pn5"; seed_prefix "$PN5"; HN5X="$WORK/hn5x"
printf 'alias z=1\n' >"$PN5/.zshrc"; cp "$PN5/.zshrc" "$WORK/pn5-zshrc.before"
NOHOST="$WORK/no-host-bin"; mkdir -p "$NOHOST"
for t in npm curl uname; do ln -s "$FAKEBIN/$t" "$NOHOST/$t"; done
NOCLAUDE="$WORK/no-claude-bin"; mkdir -p "$NOCLAUDE"
for t in codex npm curl uname; do ln -s "$FAKEBIN/$t" "$NOCLAUDE/$t"; done
F0=$FAILS
run_inst "$HN5X" "$NOSTUDIO_PATH" "SHELL=/bin/zsh" --prefix="$PN5" --yes --no-circle --no-mcp
check "install exits 0" test "$RC" = 0
check "manifest: the npm CLI, its plugin, Arc Foundry and the PATH lines are ours" mf_true "$PN5/.stable-build/manifest.json" "m.tools.arcStudioCli.addedByUs === true && m.hosts.claude.plugins['arc-studio@arc-studio-cli'].addedByUs === true && m.tools.arcFoundry.addedByUs === true && m.tools.arcFoundry.pathLine.addedByUs === true"
run_inst "$HN5X" "$NOHOST:$TOOLS:$SYS_PATH" "SHELL=/bin/zsh" --prefix="$PN5" --uninstall --yes
check "no host CLI: --uninstall runs, and ends incomplete (exit 1)" test "$RC" = 1
check "not stopped by the 'needs Claude Code' error" out_lacks "needs Claude Code"
check "Arc Foundry removed" foundry_absent "$PN5/.local/bin"
check ".zshrc byte for byte as before the install" cmp -s "$PN5/.zshrc" "$WORK/pn5-zshrc.before"
check "the npm package is kept while its Claude Code plugin is still registered" not_called "npm uninstall"
check "it says why" out_has "  – Arc Studio CLI: kept for now; its Claude Code plugin has to be removed first, and the claude CLI is not available"
check "the CLI is still there" test -L "$PN5/.npm-global/bin/arc-studio"
check "the reason the run is incomplete" out_has "Claude Code entries are recorded but the claude CLI is not available"
check "the manifest is kept for a retry" test -f "$PN5/.stable-build/manifest.json"
run_inst "$HN5X" "$NOCLAUDE:$TOOLS:$SYS_PATH" "SHELL=/bin/zsh" --prefix="$PN5" --uninstall --yes
check "codex but no claude: exits 1" test "$RC" = 1
check "the Codex entries go" called "codex plugin remove stable-build@stable-build"
check "still no npm uninstall before the plugin" not_called "npm uninstall"
run_inst "$HN5X" "$NOSTUDIO_PATH" "SHELL=/bin/zsh" --prefix="$PN5" --uninstall --yes
check "with claude back: exits 0" test "$RC" = 0
check "the plugin first, then the npm package" called_before "claude plugin uninstall arc-studio@arc-studio-cli" "npm uninstall -g @circle-fin/arc-studio-cli"
check "the CLI is gone" test ! -e "$PN5/.npm-global/bin/arc-studio"
check "state directory removed" test ! -e "$PN5/.stable-build"
check "seed preserved" seed_intact "$PN5"
show_out_on_fail "$F0"

section "N6 'arc-studio skills install' fails after adding its marketplace: recorded as ours, so uninstall removes it before the npm package"
PN6="$WORK/pn6"; mkdir -p "$PN6"; HN6="$WORK/hn6"
F0=$FAILS
run_inst "$HN6" "$NOSTUDIO_PATH" "SB_FAKE_CLAUDE_INSTALL_FAIL=arc-studio@arc-studio-cli" --prefix="$PN6" --yes --no-circle --no-mcp --no-foundry
check "exits 1" test "$RC" = 1
check "the error" out_has "stable-build: error: arc-studio skills install failed"
check "the CLI had added its marketplace" called "claude plugin marketplace add $ARCPKG --scope user"
check "manifest: that marketplace is ours, like the npm package" mf_true "$PN6/.stable-build/manifest.json" "m.hosts.claude.marketplaces['arc-studio-cli'].addedByUs === true && m.tools.arcStudioCli.addedByUs === true"
run_inst "$HN6" "$NOSTUDIO_PATH" "" --prefix="$PN6" --yes --no-circle --no-mcp --no-foundry
check "a rerun installs the plugin: exits 0" test "$RC" = 0
check "manifest: the marketplace it finds there stays recorded as ours" mf_true "$PN6/.stable-build/manifest.json" "m.hosts.claude.marketplaces['arc-studio-cli'].addedByUs === true && m.hosts.claude.plugins['arc-studio@arc-studio-cli'].addedByUs === true"
run_inst "$HN6" "$NOSTUDIO_PATH" "" --prefix="$PN6" --uninstall --yes
check "uninstall exits 0" test "$RC" = 0
check "the marketplace is removed, before the npm package it points into" called_before "claude plugin marketplace remove arc-studio-cli" "npm uninstall -g @circle-fin/arc-studio-cli"
fake_cli "$PN6" claude plugin marketplace list --json >"$WORK/pn6-mkts.json"
check "no arc-studio-cli marketplace left in Claude Code" json_lacks "$WORK/pn6-mkts.json" arc-studio-cli
show_out_on_fail "$F0"

# ================================================================ V: --verbose and failures
section "V1 --verbose prints commands and raw output; without it they only go to install.log"
PV="$WORK/pv"; mkdir -p "$PV"
F0=$FAILS
run_inst "$WORK/hv" "$STUB_PATH" "" --prefix="$PV" --yes --verbose --no-circle --no-studio --no-foundry
check "exits 0" test "$RC" = 0
check "--verbose: the command" out_has "    \$ claude plugin install stable-build@stable-build"
check "--verbose: its raw output" out_has "      Successfully installed plugin: stable-build@stable-build (scope: user)"
check "--verbose: the full header" out_has "  language: en (default)"
check "--verbose: section titles" out_has "stable-build plugin"
check "--verbose: where the manifest and log are" out_has "Manifest: $PV/.stable-build/manifest.json · log: $PV/.stable-build/install.log"
check "--verbose: still no plan table" out_lacks "Plan:"
check "the log holds the same output" grep -q "Successfully installed plugin: stable-build@stable-build" "$PV/.stable-build/install.log"
show_out_on_fail "$F0"

section "V2 a fatal failure shows the end of that command's output and the log path"
REPOS_BROKEN="$WORK/repos-broken"; mkdir -p "$REPOS_BROKEN/pedro-pelicioni"
cp -R "$REPOS/pedro-pelicioni/stable-build" "$REPOS_BROKEN/pedro-pelicioni/stable-build"
printf '%s\n' '{"name":"stable-build","owner":{"name":"fixture"},"plugins":[]}' >"$REPOS_BROKEN/pedro-pelicioni/stable-build/.claude-plugin/marketplace.json"
PV2="$WORK/pv2"; mkdir -p "$PV2"
F0=$FAILS
run_inst "$WORK/hv2" "$CLAUDE_ONLY:$TOOLS:$SYS_PATH" "SB_FAKE_REPOS=$REPOS_BROKEN" --prefix="$PV2" --yes --no-circle --no-studio --no-foundry
check "exits 1" test "$RC" = 1
check "the error" out_has "stable-build: error: could not install stable-build@stable-build"
check "the command's own output, indented" out_has '    | Plugin "stable-build" not found in marketplace "stable-build"'
check "the log path" out_has "  Full log: $PV2/.stable-build/install.log"
show_out_on_fail "$F0"

section "C an old Codex without 'codex plugin' is a short suffix of the header"
OLDCODEX="$WORK/old-codex-bin"; mkdir -p "$OLDCODEX"
# shellcheck disable=SC2016 # the stub's own $1
printf '#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.40.0" ;; *) echo "error: unrecognized subcommand" >&2; exit 2 ;; esac\n' >"$OLDCODEX/codex"
chmod 755 "$OLDCODEX/codex"
for t in claude arc-studio npm curl uname; do ln -s "$FAKEBIN/$t" "$OLDCODEX/$t"; done
PC="$WORK/pc"; mkdir -p "$PC"
run_inst "$WORK/hc" "$OLDCODEX:$TOOLS:$SYS_PATH" "" --prefix="$PC" --yes --no-circle --no-studio --no-foundry --no-mcp
check "exits 0" test "$RC" = 0
check "header suffix" test "$(head -n 1 "$OUT" | sed 's/ · Node [^ ]* / · Node X /')" = "stable-build $VER · Claude Code 2.1.280 · Node X · Codex skipped (needs a newer Codex)"
check "no separate warning paragraph" out_lacks "has no 'codex plugin' command"
run_inst "$WORK/hc" "$OLDCODEX:$TOOLS:$SYS_PATH" "" --prefix="$PC" --dry-run
check "--dry-run keeps the full warning" out_has "this Codex CLI (0.40.0) has no 'codex plugin' command"

# ================================================================ L1: pt-BR lifecycle
section "L1 pt-BR lifecycle: install --lang=pt-BR; reinstall, update and uninstall reuse the saved language"
PL="$WORK/pl"; seed_prefix "$PL"; HL="$WORK/hl"
CL="$PL/.stable-build/config.json"; ML="$PL/.stable-build/manifest.json"
F0=$FAILS
run_inst "$HL" "$STUB_PATH" "" --prefix="$PL" --yes --lang=pt-BR
check "install exits 0" test "$RC" = 0
for s in "  ✓ skills da Circle: 3 " "  ✓ stable-build " "  ✓ servidores MCP: arc-docs, circle-codegen (conectados)" \
  "  ✓ CLI do Arc Studio 1.2.1 e o plugin dela para o Claude Code (no Codex, use a skill studio-delegate do stable-build)" \
  "  – Arc Studio: faça login depois com: arc-studio login" "  ✓ Arc Foundry v0.8.0-2 (arc-forge, arc-cast, arc-anvil); adicione " \
  "  ✓ Guard ligado (só avisa): confere cada edição com as regras da Arc" "Concluído. Abra o Claude Code ou o Codex no seu projeto e pergunte: \"Sam, o que eu construo na Arc?\"" \
  "Seu time: Tim (arquiteto) · Bobbilee (PM) · Sam (analista) · Joshua (UX) · Pedro (dev) · Mike (tech writer)" \
  "Algumas skills da Circle podem levar a serviços pagos (use-circle-cli); revise-as em /plugin." \
  "O stable-build é um projeto comunitário, sem afiliação com a Circle."; do
  check "pt-BR: $s" out_has "$s"
done
check "--yes asks nothing" out_lacks "Continuar?"
check "commands stay out of the terminal without --verbose" no_mutation_lines
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
check "it uses the saved language" out_has "Concluído."
check "reinstall makes only read calls" only_reads
check "manifest unchanged" cmp -s "$ML" "$WORK/ml.before"
check "config.json unchanged" cmp -s "$CL" "$WORK/cl.before"
check "no English in the installer's own lines" no_english_leak
show_out_on_fail "$F0"
run_inst "$HL" "$STUB_PATH" "" --prefix="$PL" --dry-run
check "a dry run names the saved language and its source" out_has "  idioma: pt-BR (salvo)"
check "plan line: language already saved" out_has "idioma pt-BR (já salvo)"
F0=$FAILS
run_inst "$HL" "$STUB_PATH" "" --prefix="$PL" --update --yes
check "--update exits 0" test "$RC" = 0
check "--update uses the saved language" out_has "(atualização)"
check "no section titles without --verbose" not_line "Atualizações"
check "update status line in Portuguese" out_has "  ✓ Arc Foundry v0.8.0-2 (arc-forge, arc-cast, arc-anvil)"
expect_calls "claude plugin update stable-build@stable-build" "codex plugin marketplace upgrade stable-build"
check "no English in the installer's own lines" no_english_leak
show_out_on_fail "$F0"
run_inst "$HL" "$STUB_PATH" "" --prefix="$PL" --uninstall --dry-run
check "--uninstall --dry-run in Portuguese" out_has "Simulação: nada foi alterado."
check "the plan names the state files" out_has "manifest.json, config.json (consentimento do guard, idioma), install.log; o diretório só se ficar vazio"
check "--uninstall --dry-run makes only read calls" only_reads
F0=$FAILS
run_inst "$HL" "$STUB_PATH" "" --prefix="$PL" --uninstall --yes
check "--uninstall exits 0" test "$RC" = 0
check "--uninstall uses the saved language" out_has "(desinstalação) · "
check "Arc Foundry removed, in Portuguese" out_has "  ✓ Arc Foundry removido de $PL/.local/bin"
check "removal in Portuguese" out_has "Removido. Verificado com 'claude plugin list' / 'codex plugin list': não sobrou nenhuma entrada do stable-build."
check "Circle question in Portuguese" out_has "  Remover também o plugin de skills da Circle (foi este instalador que o adicionou)? [S/n] S (--yes)"
check "no English in the installer's own lines" no_english_leak
check "state directory removed (config.json included)" test ! -e "$PL/.stable-build"
check "seed preserved" seed_intact "$PL"
check "no residue" no_residue "$PL"
show_out_on_fail "$F0"

# ================================================================ L2: where the language comes from
section "L2 --lang (both forms, aliases), STABLE_BUILD_LANG, English by default, precedence (dry runs)"
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
check "STABLE_BUILD_LANG=pt-BR: the dry-run plan is in Portuguese too" lang_hdr "STABLE_BUILD_LANG=pt-BR" "  idioma: pt-BR (STABLE_BUILD_LANG)"
check "the dry-run plan is in Portuguese" out_has "Simulação: nada foi alterado."
# English is the default everywhere: a Portuguese locale never switches the installer
check "LANG=pt_BR.UTF-8 with no terminal: English, no prompt" lang_hdr "LANG=pt_BR.UTF-8" "  language: en (default)"
check "--yes with LANG=pt_BR.UTF-8: English, no prompt" lang_hdr "LANG=pt_BR.UTF-8" "  language: en (default)" --yes
check "LC_ALL=pt_BR.UTF-8: English" lang_hdr "LC_ALL=pt_BR.UTF-8" "  language: en (default)"
check "LC_MESSAGES=pt_BR.UTF-8: English" lang_hdr "LC_MESSAGES=pt_BR.UTF-8 LANG=pt_BR.UTF-8" "  language: en (default)"
check "pt_PT locale: English" lang_hdr "LANG=pt_PT.UTF-8" "  language: en (default)"
check "no locale variable set: English" lang_hdr "LANG=" "  language: en (default)"
check "agent session (CLAUDECODE=1) with a pt locale: English, no prompt" lang_hdr "CLAUDECODE=1 LANG=pt_BR.UTF-8" "  language: en (default)"
if (exec </dev/tty) 2>/dev/null; then
  echo "  skip  this shell has a terminal, so a run without STABLE_BUILD_NO_TTY would prompt"
else
  check "no terminal at all (STABLE_BUILD_NO_TTY unset): English, no prompt" lang_hdr "STABLE_BUILD_NO_TTY= LANG=pt_BR.UTF-8" "  language: en (default)"
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
run_inst "$HG" "$STUB_PATH" "STABLE_BUILD_LANG=pt-BR" --prefix="$PG" --yes --no-circle --no-studio --no-mcp --no-hooks
check "install exits 0" test "$RC" = 0
check "config.json holds only the language" cfg_true "$CG" "keys === 'language,schemaVersion' && c.language === 'pt-BR' && c.schemaVersion === 1"
check "the hooks' consent gate stays closed" gate_closed "$CG"
check "manifest: config.json created by the installer; language; guard off" mf_true "$MG" "m.files['config.json'].createdByUs === true && m.language === 'pt-BR' && m.guard.enabled === false"
check "summary: guard off, in Portuguese" out_has "  – Guard: desligado (--no-hooks)"
show_out_on_fail "$F0"
F0=$FAILS
run_inst "$HG" "$STUB_PATH" "LANG=pt_BR.UTF-8" --prefix="$PG" --yes --no-circle --no-studio --no-mcp --lang=en
check "rerun with --lang=en exits 0" test "$RC" = 0
check "it switches to English" out_has "Done. Open Claude Code"
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
check "the saved choice beats the locale" out_has "Removed. Verified with"
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
check "the language saved in the manifest is reused" out_has "Removido."
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
check "--update in the saved language" out_has "(atualização) · "
check "no English in the installer's own lines" no_english_leak
run_inst "$HN" "$STUB_PATH" "$SBN" --uninstall --yes
check "--uninstall exits 0" test "$RC" = 0
check "--uninstall in the saved language" out_has "Removido."
check "STABLE_BUILD_HOME removed" test ! -e "$HN/sb"
check "no residue in HOME" no_residue "$HN"
show_out_on_fail "$F0"

# ================================================================ TTY: the two questions on a terminal
if command -v python3 >/dev/null 2>&1 && python3 -c 'import pty, select' 2>/dev/null; then
section "TTY language prompt and the one confirmation on a pseudo-terminal (python3 pty)"
TTYD="$HERE/tty-drive.py"
# run_tty HOME "EXTRA ENV" [--expect TEXT --send REPLY]...   (installer arguments: $TTY_ARGS; PATH: $TTY_PATH)
# The installer runs with the pty as its controlling terminal, stdin and stdout; the transcript
# (prompts, echoed answers, output) goes to $OUT. The driver answers each --expect with its --send
# and exits 124 if an expected prompt never shows, or if the run waits on a prompt nobody expected.
TTY_PATH=$STUB_PATH
run_tty() {
  local h=$1 extra=$2
  shift 2
  : >"$LOG"; mkdir -p "$h"
  set +e
  # shellcheck disable=SC2086 # extra and TTY_ARGS are lists of words (no spaces inside)
  python3 "$TTYD" --timeout 60 --transcript "$OUT" "$@" \
    -- env -i HOME="$h" PATH="$TTY_PATH" TMPDIR="$WORK" LANG=C SHELL=/bin/sh SB_FAKE_LOG="$LOG" SB_FAKE_REPOS="$REPOS" \
    SB_FAKE_ARC_PKG="$ARCPKG" SB_FAKE_FOUNDRY_DIR="$FOUNDRY_FIX" $extra bash "$INSTALL" $TTY_ARGS
  RC=$?
  set -e
}
# how many questions the transcript shows (the language menu and every [Y/n]-style prompt)
questions() { grep -cE '\(Enter = [12]\): |\[[YySs]/[nN]\]|\[[yYsS]/N\]' "$OUT" || true; }
QUIET="--no-circle --no-studio --no-mcp --no-foundry"

PT1="$WORK/pt1"; seed_prefix "$PT1"
F0=$FAILS
TTY_ARGS="--prefix=$PT1 $QUIET"
run_tty "$WORK/ht1" "" --expect "Language / Idioma:" --send 2 --expect "Continuar? [S/n]" --send s
check "choosing 2, then answering s: exits 0" test "$RC" = 0
check "the language prompt is the first thing shown" test "$(head -n 1 "$OUT")" = "stable-build $VER: installer / instalador"
check "the menu, defaulting to English" test "$(sed -n 2p "$OUT")" = "Language / Idioma: [1] English  [2] Português (Brasil)  (Enter = 1): 2"
check "the choice is not echoed: the one-line header comes next" test "$(sed -n 3p "$OUT" | cut -d' ' -f1-4)" = "stable-build $VER · Claude"
check "the confirmation, in Portuguese" out_has "O stable-build $VER prepara o Claude Code e o Codex para apps construídos na Arc:"
check "it lists stable-build with the guard" out_has "  • stable-build: um time de 6 especialistas (skills) e o guard de pegadinhas da Arc (só avisa)"
check "exactly two questions" test "$(questions)" = 2
for s in "  ✓ stable-build " "  ✓ Guard ligado (só avisa): confere cada edição com as regras da Arc" "Concluído." "Seu time: Tim (arquiteto)"; do
  check "then Portuguese: $s" out_has "$s"
done
check "no English in the installer's own lines" no_english_leak
check "config.json: pt-BR and the guard on (answered s)" cfg_true "$PT1/.stable-build/config.json" "c.language === 'pt-BR' && c.guard === true"
check "manifest: language pt-BR" mf_true "$PT1/.stable-build/manifest.json" "m.language === 'pt-BR'"
show_out_on_fail "$F0"
F0=$FAILS
run_tty "$WORK/ht1" ""
check "rerun in a terminal: no prompt at all (saved language, nothing missing)" test "$RC" = 0
check "it does not ask for the language again" out_lacks "Language / Idioma"
check "nor for a confirmation" test "$(questions)" = 0
check "it uses the saved language" out_has "Concluído."
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
run_tty "$WORK/ht2" "LANG=pt_BR.UTF-8" --expect "(Enter = 1): " --send '' --expect "Continue? [Y/n]" --send n
check "LANG=pt_BR.UTF-8: the menu still defaults to English, and Enter keeps it; 'n' exits 0" test "$RC" = 0
check "the confirmation is in English" out_has "stable-build $VER sets up Claude Code and Codex for apps built on Arc:"
check "'n' at the confirmation: one line" out_has "Nothing changed. To leave parts out, rerun with --no-circle, --no-studio, --no-login, --no-foundry or --no-hooks (see --help)."
check "'n' makes no mutating call" only_reads
check "'n' writes nothing: not even the language or a log" is_empty_dir "$PT2"
show_out_on_fail "$F0"

# An answer that is not a yes or a no is asked again: a typo or a stray space never counts as the
# default yes (that yes would accept Circle's terms, install from npm and edit an rc file)
PT2B="$WORK/pt2b"; mkdir -p "$PT2B"
F0=$FAILS
TTY_ARGS="--prefix=$PT2B --lang=en $QUIET"
run_tty "$WORK/ht2b" "" --expect "Continue? [Y/n]" --send nope --expect "Type y (yes) or n (no)" --send 'n '
check "'nope' is asked again, then 'n ' (a trailing space) is a no: exits 0" test "$RC" = 0
check "the retry line" out_has "  Type y (yes) or n (no), or press Enter for the default."
check "'nope', then 'n ': nothing changed" out_has "Nothing changed. To leave parts out"
check "'nope', then 'n ': no mutating call" only_reads
check "'nope', then 'n ': nothing written" is_empty_dir "$PT2B"
show_out_on_fail "$F0"
F0=$FAILS
run_tty "$WORK/ht2b" "" --expect "Continue? [Y/n]" --send x --expect "Type y (yes)" --send '?' --expect "Type y (yes)" --send yy
check "three answers that are neither yes nor no count as no: exits 0" test "$RC" = 0
check "three bad answers: nothing changed" out_has "Nothing changed. To leave parts out"
check "three bad answers: no mutating call" only_reads
check "three bad answers: nothing written" is_empty_dir "$PT2B"
show_out_on_fail "$F0"
F0=$FAILS
TTY_ARGS="--prefix=$PT2B --lang=pt-BR $QUIET"
run_tty "$WORK/ht2b" "" --expect "Continuar? [S/n]" --send talvez --expect "Digite s (sim)" --send '  S  '
check "pt-BR: an unknown answer is asked again in Portuguese; '  S  ' (spaces around it) is a yes" test "$RC" = 0
check "pt-BR: the retry line" out_has "  Digite s (sim) ou n (não), ou tecle Enter para o padrão."
check "pt-BR: then it installs" out_has "  ✓ stable-build "
check "no English in the installer's own lines" no_english_leak
show_out_on_fail "$F0"

PT3="$WORK/pt3"; mkdir -p "$PT3"
F0=$FAILS
TTY_ARGS="--prefix=$PT3 $QUIET"
run_tty "$WORK/ht3" "LANG=pt_BR.UTF-8" --expect "Idioma:" --send 9 --expect "Digite 1 ou 2." --send 1 --expect "Continue? [Y/n]" --send ''
check "an invalid answer is asked again; then 1 picks English; Enter accepts" test "$RC" = 0
check "retry hint is bilingual" out_has "  Type 1 or 2. / Digite 1 ou 2."
check "the confirmation is in English" out_has "stable-build $VER sets up Claude Code and Codex for apps built on Arc:"
check "the rest is English" out_has "Done. Open Claude Code or Codex in your project"
check "config.json: en, and the guard on (Enter is yes)" cfg_true "$PT3/.stable-build/config.json" "c.language === 'en' && c.guard === true"
show_out_on_fail "$F0"

PT4="$WORK/pt4-not-created"
TTY_ARGS="--prefix=$PT4 --dry-run --yes"
run_tty "$WORK/ht4" "LANG=pt_BR.UTF-8"
check "--yes in a terminal: no language prompt" out_lacks "Language / Idioma"
check "--yes in a terminal with a pt locale: English" out_has "  language: en (default)"
TTY_ARGS="--prefix=$PT4 --dry-run --lang=en"
run_tty "$WORK/ht4" "LANG=pt_BR.UTF-8"
check "--lang in a terminal: no prompt" out_lacks "Language / Idioma"
check "--lang in a terminal: used" out_has "  language: en (--lang)"
check "a dry run in a terminal asks nothing" test "$(questions)" = 0
TTY_ARGS="--prefix=$PT4 --dry-run"
run_tty "$WORK/ht4" "STABLE_BUILD_LANG=pt-BR"
check "STABLE_BUILD_LANG in a terminal: no prompt" out_lacks "Language / Idioma"
check "STABLE_BUILD_LANG in a terminal: used" out_has "  idioma: pt-BR (STABLE_BUILD_LANG)"
run_tty "$WORK/ht4" "CLAUDECODE=1 LANG=pt_BR.UTF-8"
check "agent session in a terminal: no prompt" out_lacks "Language / Idioma"
check "agent session in a terminal with a pt locale: English" out_has "  language: en (default)"
check "these dry runs create nothing" test ! -e "$PT4"

section "T5 a fresh interactive install (no --prefix, throwaway HOME): two questions, everything set up"
# Claude Code, an old Codex without `codex plugin`, npm whose global bin is on PATH, no arc-studio,
# zsh with an existing ~/.zshrc: the situation from the bug report.
FRESHBIN="$WORK/fresh-bin"; mkdir -p "$FRESHBIN"
for t in claude npm curl uname; do ln -s "$FAKEBIN/$t" "$FRESHBIN/$t"; done
ln -s "$OLDCODEX/codex" "$FRESHBIN/codex"
HT5="$WORK/ht5"; mkdir -p "$HT5"
printf '# my zshrc\nalias ll="ls -l"' >"$HT5/.zshrc"
cp "$HT5/.zshrc" "$WORK/t5-zshrc.before"
TTY_PATH="$FRESHBIN:$HT5/.npm-global/bin:$TOOLS:$SYS_PATH"
TTY_ARGS=""
F0=$FAILS
run_tty "$HT5" "SHELL=/bin/zsh" --expect "(Enter = 1): " --send '' --expect "Continue? [Y/n]" --send ''
cp "$OUT" "$WORK/fresh-transcript.txt"
check "exits 0" test "$RC" = 0
check "exactly two questions: the language and the one confirmation" test "$(questions)" = 2
check "header with the Codex suffix" test "$(sed -n 3p "$OUT" | sed 's/ · Node [^ ]* / · Node X /')" = "stable-build $VER · Claude Code 2.1.280 · Node X · Codex skipped (needs a newer Codex)"
check "confirmation title" out_has "stable-build $VER sets up Claude Code for apps built on Arc:"
for s in "  • stable-build: a 6-person team of skills and the Arc gotcha guard (advisory)" \
  "  • Arc docs MCP and Circle codegen MCP" \
  "  • Circle's skills (Circle Developer Terms: https://console.circle.com/legal/developer-terms)" \
  "  • Arc Studio CLI (npm) and its Claude Code plugin, then sign-in in your browser" \
  "  • Arc Foundry (arc-forge, arc-cast, arc-anvil) in ~/.local/bin, on PATH via ~/.zshrc"; do
  check "bullet: ${s#  • }" grep -Fxq -- "$s" "$OUT"
done
T5_LINES=$(grep -cv '^\[fake arc-studio\]' "$OUT" || true)
check "at most 25 lines, not counting the sign-in's own output ($T5_LINES)" test "$T5_LINES" -le 25
check "npm install of the CLI, then its plugin, then the sign-in" called_before "npm install -g @circle-fin/arc-studio-cli@latest" "arc-studio skills install --tool claude-code"
check "the sign-in after the plugin" called_before "arc-studio skills install --tool claude-code" "arc-studio login"
check "the sign-in on the terminal, with the real HOME (no --paste)" called "arc-studio login"
check "signed in" out_has "  ✓ Arc Studio: signed in"
check "the sign-in's own output is shown" out_has "[fake arc-studio] Opening your browser to authorize this machine"
check "Arc Foundry in ~/.local/bin" foundry_installed "$HT5/.local/bin" 0.8.0-2
{ cat "$WORK/t5-zshrc.before"; printf '\n%s\n%s\n' "$RC_MARK" "$RC_PATHLINE"; } >"$WORK/t5-zshrc.expected"
check ".zshrc: the two lines appended, the rest kept" cmp -s "$HT5/.zshrc" "$WORK/t5-zshrc.expected"
check "status line for Arc Foundry names ~/.zshrc" out_has "  ✓ Arc Foundry v0.8.0-2 (arc-forge, arc-cast, arc-anvil), on PATH via ~/.zshrc in new terminals"
check "no raw CLI output" out_lacks "Successfully installed plugin"
check "no raw npm output" out_lacks "added 87 packages"
check "the raw output is in ~/.stable-build/install.log" grep -q "added 87 packages" "$HT5/.stable-build/install.log"
check "guard on, language en" cfg_true "$HT5/.stable-build/config.json" "c.guard === true && c.language === 'en'"
check "manifest: npm package, Arc Foundry and the PATH lines are ours" mf_true "$HT5/.stable-build/manifest.json" "m.tools.arcStudioCli.addedByUs === true && m.tools.arcFoundry.addedByUs === true && m.tools.arcFoundry.pathLine.file === '$HT5/.zshrc'"
check "the closing lines" out_has 'Done. Open Claude Code in your project and ask: "Sam, what should I build on Arc?"'
show_out_on_fail "$F0"
printf '  info  fresh interactive install, %s lines without the sign-in output:\n' "$T5_LINES"
sed 's/^/        | /' "$WORK/fresh-transcript.txt"
cp "$HT5/.zshrc" "$WORK/t5-zshrc.after"
F0=$FAILS
run_tty "$HT5" "SHELL=/bin/zsh"
check "rerun in a terminal: exits 0, no question (signed in, nothing missing)" test "$RC" = 0
check "rerun: no question" test "$(questions)" = 0
check "rerun: only read calls (arc-studio whoami included)" only_reads
check "rerun: whoami was the sign-in check" called "arc-studio whoami"
check "rerun: no second pair of PATH lines" cmp -s "$HT5/.zshrc" "$WORK/t5-zshrc.after"
show_out_on_fail "$F0"
F0=$FAILS
TTY_ARGS="--uninstall"
run_tty "$HT5" "SHELL=/bin/zsh" --expect "Remove Circle's skills plugin too (this installer added it)? [Y/n]" --send ''
check "uninstall exits 0" test "$RC" = 0
check "Arc Foundry removed" foundry_absent "$HT5/.local/bin"
check ".zshrc byte for byte as before the install" cmp -s "$HT5/.zshrc" "$WORK/t5-zshrc.before"
check "the npm package removed (after the plugin)" called_before "claude plugin uninstall arc-studio@arc-studio-cli" "npm uninstall -g @circle-fin/arc-studio-cli"
check "the CLI is gone" test ! -e "$HT5/.npm-global/bin/arc-studio"
check "the sign-in is untouched (no logout, credentials kept)" not_called "arc-studio logout"
check "credentials kept" test -f "$HT5/.arc-studio/fake-signed-in"
check "state directory removed" test ! -e "$HT5/.stable-build"
check "no residue" no_residue "$HT5"
show_out_on_fail "$F0"

section "T5b the same fresh install with Claude Code and a Codex that has 'codex plugin': same line budget"
FRESHBIN2="$WORK/fresh-bin-2"; mkdir -p "$FRESHBIN2"
for t in claude codex npm curl uname; do ln -s "$FAKEBIN/$t" "$FRESHBIN2/$t"; done
HT5B="$WORK/ht5b"; mkdir -p "$HT5B"; printf '# my zshrc\n' >"$HT5B/.zshrc"
TTY_PATH="$FRESHBIN2:$HT5B/.npm-global/bin:$TOOLS:$SYS_PATH"
TTY_ARGS=""
F0=$FAILS
run_tty "$HT5B" "SHELL=/bin/zsh" --expect "(Enter = 1): " --send '' --expect "Continue? [Y/n]" --send ''
cp "$OUT" "$WORK/fresh-transcript-2.txt"
check "exits 0" test "$RC" = 0
check "exactly two questions" test "$(questions)" = 2
check "confirmation title names both hosts" out_has "stable-build $VER sets up Claude Code and Codex for apps built on Arc:"
check "the Codex hooks line is there" out_has "  Codex: open /hooks in Codex and trust the stable-build hooks"
T5B_LINES=$(grep -cv '^\[fake arc-studio\]' "$OUT" || true)
check "at most 25 lines with both hosts too, not counting the sign-in's own output ($T5B_LINES)" test "$T5B_LINES" -le 25
show_out_on_fail "$F0"
printf '  info  fresh interactive install with both hosts, %s lines without the sign-in output:\n' "$T5B_LINES"
sed 's/^/        | /' "$WORK/fresh-transcript-2.txt"
TTY_PATH=$STUB_PATH

section "T6-T9 Arc Studio sign-in: already signed in, a failed sign-in, --no-login, --yes"
PT6="$WORK/pt6"; mkdir -p "$PT6/.arc-studio"; : >"$PT6/.arc-studio/fake-signed-in"
F0=$FAILS
TTY_ARGS="--prefix=$PT6 --lang=en --no-circle --no-mcp --no-foundry"
run_tty "$WORK/ht6" "" --expect "Continue? [Y/n]" --send ''
check "already signed in: exits 0" test "$RC" = 0
check "already signed in: the bullet has no sign-in" grep -Fxq "  • Arc Studio's Claude Code plugin" "$OUT"
check "already signed in: whoami, no login" not_called "arc-studio login"
check "already signed in: status line" out_has "  ✓ Arc Studio: signed in"
show_out_on_fail "$F0"
PT7="$WORK/pt7"; mkdir -p "$PT7"
F0=$FAILS
TTY_ARGS="--prefix=$PT7 --lang=en --no-circle --no-mcp --no-foundry"
run_tty "$WORK/ht7" "SB_FAKE_STUDIO_LOGIN_FAIL=1" --expect "Continue? [Y/n]" --send ''
check "a failed sign-in is not fatal: exits 0" test "$RC" = 0
check "the bullet includes the sign-in" grep -Fxq "  • Arc Studio's Claude Code plugin, then sign-in in your browser" "$OUT"
check "--prefix: the sign-in uses --paste (the token stays in the sandbox)" called "arc-studio login --paste"
check "one ✗ line with the hint" out_has "  ✗ Arc Studio: not signed in; sign in later with: arc-studio login"
check "the run goes on: guard on" grep -q '"guard": *true' "$PT7/.stable-build/config.json"
show_out_on_fail "$F0"
PT8="$WORK/pt8"; mkdir -p "$PT8"
F0=$FAILS
TTY_ARGS="--prefix=$PT8 --lang=en --no-circle --no-mcp --no-foundry --no-login"
run_tty "$WORK/ht8" "" --expect "Continue? [Y/n]" --send ''
check "--no-login: exits 0" test "$RC" = 0
check "--no-login: the bullet has no sign-in" grep -Fxq "  • Arc Studio's Claude Code plugin" "$OUT"
check "--no-login: no whoami, no login" not_called "arc-studio log"
check "--no-login: no sign-in check either" not_called "arc-studio whoami"
check "--no-login: the hint" out_has "  – Arc Studio: sign in later with: arc-studio login"
show_out_on_fail "$F0"
PT9="$WORK/pt9"; mkdir -p "$PT9"
F0=$FAILS
TTY_ARGS="--prefix=$PT9 --yes --no-circle --no-mcp --no-foundry"
run_tty "$WORK/ht9" ""
check "--yes in a terminal: exits 0 without any question" test "$RC" = 0
check "--yes in a terminal: no question" test "$(questions)" = 0
check "--yes in a terminal: no sign-in" not_called "arc-studio login"
check "--yes in a terminal: the hint" out_has "  – Arc Studio: sign in later with: arc-studio login"
show_out_on_fail "$F0"

section "T10 only the sign-in is missing (after --yes): its own question, and a no skips just the sign-in"
F0=$FAILS
TTY_ARGS="--prefix=$PT9 --update --no-circle --no-mcp --no-foundry"
run_tty "$WORK/ht9" "" --expect "Sign in to Arc Studio now (it opens your browser)? [Y/n]" --send n
check "--update, 'n' to the sign-in: exits 0" test "$RC" = 0
check "one question, not the whole confirmation" test "$(questions)" = 1
check "no 'Continue?'" out_lacks "Continue?"
check "the update still runs" called "claude plugin update stable-build@stable-build"
check "the marketplace too" called "claude plugin marketplace update stable-build"
check "no sign-in" not_called "arc-studio login"
check "the hint says how to stop the question" out_has "  – Arc Studio: sign in later with: arc-studio login (--no-login skips this question)"
check "no 'Nothing changed'" out_lacks "Nothing changed"
show_out_on_fail "$F0"
F0=$FAILS
TTY_ARGS="--prefix=$PT9 --no-circle --no-mcp --no-foundry"
run_tty "$WORK/ht9" "" --expect "Sign in to Arc Studio now" --send no
check "a rerun, 'no' to the sign-in: exits 0" test "$RC" = 0
check "a rerun, 'no': only read calls" only_reads
check "a rerun, 'no': no sign-in" not_called "arc-studio login"
show_out_on_fail "$F0"
F0=$FAILS
run_tty "$WORK/ht9" "" --expect "Sign in to Arc Studio now" --send ''
check "a rerun, Enter: exits 0" test "$RC" = 0
check "Enter signs in (--paste under --prefix)" called "arc-studio login --paste"
check "signed in" out_has "  ✓ Arc Studio: signed in"
run_tty "$WORK/ht9" ""
check "signed in now: the next rerun asks nothing" test "$(questions)" = 0
check "and exits 0" test "$RC" = 0
show_out_on_fail "$F0"

section "T11 --update in a terminal, 'n' to what it offers to add: the update still runs, only those items are skipped"
# An install nobody could answer (stable-build and its MCP plugin only), as for a v0.1.0 user before
# Arc Studio and Arc Foundry were offered; then --update at a terminal, answering n.
PT11="$WORK/pt11"; seed_prefix "$PT11"
F0=$FAILS
run_inst "$WORK/ht11" "$NOSTUDIO_PATH" "SHELL=/bin/zsh" --prefix="$PT11"
check "the no-terminal install exits 0" test "$RC" = 0
TTY_PATH=$NOSTUDIO_PATH
TTY_ARGS="--prefix=$PT11 --update"
run_tty "$WORK/ht11" "SHELL=/bin/zsh" --expect "Add these too? [Y/n]" --send n
check "--update, 'n': exits 0" test "$RC" = 0
check "one question" test "$(questions)" = 1
check "the title says the update runs either way" out_has "stable-build $VER: the update runs either way. Not set up here yet:"
check "stable-build itself is not on the list (the update covers it)" out_lacks "  • stable-build:"
for s in "  • Circle's skills (Circle Developer Terms: https://console.circle.com/legal/developer-terms)" \
  "  • Arc Studio CLI (npm) and its Claude Code plugin, then sign-in in your browser" \
  "  • Arc Foundry (arc-forge, arc-cast, arc-anvil) in $PT11/.local/bin, on PATH via $PT11/.zshrc"; do
  check "bullet: ${s#  • }" grep -Fxq -- "$s" "$OUT"
done
check "no 'Nothing changed': the update goes on" out_lacks "Nothing changed"
expect_calls \
  "claude plugin marketplace update stable-build" "claude plugin update stable-build@stable-build" \
  "claude plugin update stable-build-mcp@stable-build" "codex plugin marketplace upgrade stable-build" \
  "codex plugin add stable-build@stable-build"
check "the update's status line" out_has "  ✓ stable-build "
check "'n': no npm install" not_called "npm install"
check "'n': no Arc Foundry download" not_called "/releases/"
check "'n': no Circle" not_called "circle-skills@circle"
check "'n': no sign-in" not_called "arc-studio login"
check "'n': no rc file" test ! -e "$PT11/.zshrc"
check "one line names what was left out, and how to add it" out_has "  – Not added (you said no): Circle's skills, Arc Studio, Arc Foundry. To add them later, rerun: curl -fsSL https://raw.githubusercontent.com/pedro-pelicioni/stable-build/main/install.sh | bash -s -- --prefix='$PT11'"
check "manifest: still nothing third-party recorded" mf_true "$PT11/.stable-build/manifest.json" "!(m.tools && (m.tools.arcStudioCli || m.tools.arcFoundry)) && !m.hosts.claude.plugins['circle-skills@circle']"
show_out_on_fail "$F0"
F0=$FAILS
run_tty "$WORK/ht11" "SHELL=/bin/zsh" --expect "Add these too? [Y/n]" --send ''
check "--update, Enter: exits 0" test "$RC" = 0
check "Enter adds them: the CLI from npm" called "npm install -g @circle-fin/arc-studio-cli@latest"
check "Arc Foundry" foundry_installed "$PT11/.local/bin" 0.8.0-2
check "Circle's plugin" called "claude plugin install circle-skills@circle"
check "and the update still ran" called "claude plugin update stable-build@stable-build"
show_out_on_fail "$F0"
TTY_PATH=$STUB_PATH
else
  echo "  skip  python3 with pty is not available: the terminal prompt is not tested"
fi

else
# ================================================================ real Claude Code
section "real claude: read-safe round trip in a throwaway HOME"
REAL=$(command -v claude || true)
[ -n "$REAL" ] || { echo "claude is not on PATH" >&2; exit 2; }
REALBIN="$WORK/real-bin"; mkdir -p "$REALBIN"; ln -s "$REAL" "$REALBIN/claude"
# the stubs keep these runs off the network and off the real npm prefix (Arc Foundry and Arc
# Studio are skipped with --no-foundry and --no-studio anyway)
for t in curl npm; do ln -s "$FAKEBIN/$t" "$REALBIN/$t"; done
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
run_inst "$RH" "$RPATH" "$EXTRA" --prefix="$RP" --yes --no-studio --no-foundry $CIRCLE_FLAG
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
run_inst "$RH" "$RPATH" "$EXTRA" --prefix="$RP" --yes --no-studio --no-foundry $CIRCLE_FLAG
check "reinstall exits 0" test "$RC" = 0
check "reinstall runs no mutating command (nothing new in install.log)" log_has_no_commands "$RP/.stable-build/install.log"
check "reinstall leaves Claude Code state unchanged" test "$(snapshot)" = "$S_BEFORE"
check "reinstall leaves the manifest unchanged" cmp -s "$RP/.stable-build/manifest.json" "$WORK/rm.before"
F0=$FAILS
# shellcheck disable=SC2086
run_inst "$RH" "$RPATH" "$EXTRA" --prefix="$RP" --update --yes --verbose --no-studio --no-foundry $CIRCLE_FLAG
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
run_inst "$RH" "$RPATH" "STABLE_BUILD_SOURCE=$FIX" --prefix="$RP2" --yes --no-studio --no-foundry --no-circle --no-mcp --no-hooks --lang=pt-BR
check "install exits 0" test "$RC" = 0
check "install in Portuguese" out_has "Concluído."
check "no English in the installer's own lines" no_english_leak
check "config.json holds only the language" cfg_true "$RP2/.stable-build/config.json" "keys === 'language,schemaVersion' && c.language === 'pt-BR'"
show_out_on_fail "$F0"
(cd "$RP2" && rc2 plugin marketplace remove stable-build >/dev/null 2>&1) || true
(cd "$RP2" && rc2 plugin list --json) >"$WORK/real-plugins.json"
check "marketplace remove also uninstalled stable-build@stable-build" json_lacks "$WORK/real-plugins.json" stable-build@stable-build
run_inst "$RH" "$RPATH" "STABLE_BUILD_SOURCE=$FIX" --prefix="$RP2" --yes --no-studio --no-foundry --no-circle --no-mcp --no-hooks
check "rerun exits 0" test "$RC" = 0
check "rerun uses the saved language" out_has "Concluído."
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
