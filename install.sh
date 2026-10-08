#!/usr/bin/env bash
# stable-build installer
#
# Registers the stable-build plugins (skills, edit-time guard hooks, MCP servers) for apps
# built on Arc with Claude Code and Codex through their own plugin CLIs, and sets up what a
# builder needs next to them: Circle's skills plugin, the Arc Studio CLI (npm) with its Claude Code
# plugin and sign-in, and Arc Foundry (arc-forge, arc-cast, arc-anvil in ~/.local/bin). It lists
# what is missing and asks once. Everything it adds is recorded in
# ${STABLE_BUILD_HOME:-$HOME/.stable-build}/manifest.json, and --uninstall removes exactly that.
# It never edits settings.json, .claude.json, config.toml or hooks.json itself; outside its state
# directory it writes only, with your yes, Arc Foundry's three binaries (their sha256 recorded) and
# one shell rc file (two marked PATH lines).
# Raw CLI output goes to $STABLE_BUILD_HOME/install.log (--verbose prints it too).
#
#   curl -fsSL https://raw.githubusercontent.com/pedro-pelicioni/stable-build/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/pedro-pelicioni/stable-build/main/install.sh | bash -s -- --uninstall
#
# Languages: English (en) and Brazilian Portuguese (pt-BR). --lang > STABLE_BUILD_LANG > the choice
# saved in $STABLE_BUILD_HOME/config.json ("language") > a prompt in a terminal (Enter keeps English) > English.
# The locale (LANG, LC_ALL) is never used: English is the default everywhere.
# Every user-facing string lives in the message tables in main() (_msg_en, _msg_pt).
#
# All code lives inside main(). The last line calls it inside a { ...; } group, which bash does not
# run until the closing brace has arrived, so a truncated download runs nothing.
# Requires bash 3.2+, node 20+, and Claude Code 2.1.280+ and/or a Codex CLI with `codex plugin`.
# Arc Studio needs npm; Arc Foundry needs curl, tar and shasum or sha256sum.
#
# Codex steps follow the openai/codex source (codex-rs/cli plugin_cmd.rs and marketplace_cmd.rs
# at 4ad985e). They have not been run against a real codex binary yet: UNVERIFIED.
#
# stable-build is a community project, not affiliated with Circle. MIT license.

main() {
  set -euo pipefail
  umask 022
  unset CDPATH   # `cd rel` must not resolve through CDPATH or print the directory

  # ------------------------------------------------------------------ constants
  SB_VERSION=0.1.0
  GH_SLUG=pedro-pelicioni/stable-build
  RAW_INSTALL="https://raw.githubusercontent.com/$GH_SLUG/main/install.sh"
  ISSUES_URL="https://github.com/$GH_SLUG/issues"
  MIN_CLAUDE=2.1.280            # verified version; the real lower bound is UNVERIFIED
  MIN_NODE=20
  N_MKT=stable-build            # marketplace name in both .claude-plugin and .agents/plugins
  N_PLUGIN=stable-build@stable-build
  N_PLUGIN_MCP=stable-build-mcp@stable-build
  N_C_CIRCLE_MKT=circle         # Circle's Claude Code marketplace
  N_C_CIRCLE=circle-skills@circle
  N_X_CIRCLE_MKT=circle-skills  # Circle's Codex marketplace
  N_X_CIRCLE=circle@circle-skills
  N_STUDIO_MKT=arc-studio-cli   # marketplace shipped inside Circle's Arc Studio CLI npm package
  N_STUDIO=arc-studio@arc-studio-cli
  CIRCLE_REPO=circlefin/skills
  CIRCLE_BRANCH=master          # circlefin/skills has no tags or releases
  CIRCLE_TERMS=https://console.circle.com/legal/developer-terms
  # Arc Studio CLI: https://docs.arc.io/ai/arc-studio-cli (npm, Node 20+; bin arc-studio)
  NPM_PKG=@circle-fin/arc-studio-cli
  # Arc Foundry: https://docs.arc.io/arc/tutorials/install-arc-foundry and
  # https://github.com/circlefin/arc-foundry (assets arc-foundry-<tag>-<target>.tar.gz + .sha256)
  FOUNDRY_REPO=circlefin/arc-foundry
  FOUNDRY_API="https://api.github.com/repos/$FOUNDRY_REPO/releases/latest"
  FOUNDRY_DL="https://github.com/$FOUNDRY_REPO/releases/download"
  FOUNDRY_SRC_DOC="https://github.com/$FOUNDRY_REPO#building-from-source"
  # the two lines added to a shell rc file so ~/.local/bin is on PATH (removed by --uninstall)
  RC_MARKER='# added by stable-build (Arc Foundry)'
  # shellcheck disable=SC2016 # written to the rc file as is: the shell expands it there
  RC_LINE='export PATH="$HOME/.local/bin:$PATH"'

  # ------------------------------------------------------------------ messages
  # msg <id> [args] prints the template for $SB_LANG with printf: each %s takes the next argument,
  # so both tables use the same number and order of %s for an id. Templates are double-quoted
  # (escape \" and \$; \n is a newline). Commands, flags, paths and product names stay in English.
  # test/install/i18n.test.mjs checks that every id used here exists in both tables, that the
  # placeholders match, and that no user-facing literal bypasses msg.
  _msg_en() {
    case $1 in
      # shown before a language is chosen, or when it cannot be: the same text in both tables
      lang_banner) _T="stable-build %s: installer / instalador" ;;
      lang_menu) _T="Language / Idioma: [1] English  [2] Português (Brasil)  (Enter = %s): " ;;
      lang_menu_retry) _T="  Type 1 or 2. / Digite 1 ou 2." ;;
      err_lang_unknown) _T="stable-build: error: unknown language '%s' (supported: en, pt-BR)\nstable-build: erro: idioma desconhecido '%s' (suportados: en, pt-BR)" ;;
      err_lang_missing) _T="stable-build: error: --lang needs a value: en or pt-BR\nstable-build: erro: --lang precisa de um valor: en ou pt-BR" ;;
      err_lang_env) _T="stable-build: error: STABLE_BUILD_LANG=%s is not a supported language (en, pt-BR)\nstable-build: erro: STABLE_BUILD_LANG=%s não é um idioma suportado (en, pt-BR)" ;;
      # language
      lang_src_saved) _T="saved" ;;
      lang_src_prompt) _T="chosen" ;;
      lang_src_default) _T="default" ;;
      col_lang) _T="lang" ;;
      st_lang_save) _T="save language %s" ;;
      st_lang_same) _T="language %s (already saved)" ;;
      st_lang_invalid) _T="not valid JSON: the language is not saved there" ;;
      warn_cfg_lang_invalid) _T="%s is not valid JSON, so the language choice is not saved there; fix or remove it" ;;
      # output helpers and prompts
      pfx_warn) _T="stable-build: warning: " ;;
      pfx_error) _T="stable-build: error: " ;;
      ask_hint_yes) _T="[Y/n]" ;;
      ask_hint_no) _T="[y/N]" ;;
      ans_yes) _T="Y" ;;
      ans_no) _T="N" ;;
      ask_noterm_default) _T="(no terminal: default)" ;;
      ask_noterm_skipped) _T="(no terminal: skipped; it needs a yes from you, so rerun in a terminal or with --yes)" ;;
      ask_retry) _T="  Type y (yes) or n (no), or press Enter for the default." ;;
      fail_log) _T="  Full log: %s" ;;
      usage) _T="stable-build installer %s: skills, guard hooks and MCP servers for apps built on Arc,
for Claude Code and Codex, plus the Arc Studio CLI and Arc Foundry. Community project,
not affiliated with Circle.

Usage: install.sh [options]
  (no option)     list what is missing, ask once, then install it (safe to rerun)
  --update        update stable-build, plus Circle's plugin, Arc Studio and Arc Foundry if this
                  installer added them
  --uninstall     remove only what this installer added (reads \$STABLE_BUILD_HOME/manifest.json)
  --prefix=DIR    sandbox: every CLI call runs with HOME=DIR, so nothing outside DIR is written
  --yes           install everything without asking (this accepts Circle's developer terms and
                  turns the guard on); the Arc Studio sign-in is skipped. A guard you declined
                  earlier stays off, and --update never turns the guard on.
  --no-hooks      leave the edit-time guard off (now and on later runs)
  --no-mcp        skip the stable-build-mcp plugin (arc-docs and circle-codegen MCP servers)
  --no-circle     skip Circle's skills plugin
  --no-studio     skip the Arc Studio CLI, its Claude Code plugin and the sign-in
  --no-login      skip the Arc Studio sign-in (run arc-studio login yourself later)
  --no-foundry    skip Arc Foundry (arc-forge, arc-cast and arc-anvil in ~/.local/bin)
  --dry-run       print the plan and change nothing
  --verbose       print every command and its raw output (it always goes to install.log in
                  \$STABLE_BUILD_HOME)
  --ref=REF       git ref of %s to install (default: main, which moves only at releases)
  --lang=LANG     language of this installer and of the kit's replies: en or pt-BR. Saved for
                  later runs; default: the saved choice, else asked in a terminal (Enter keeps
                  English), else English
  -h, --help      show this help

Environment:
  STABLE_BUILD_HOME          state directory (default: ~/.stable-build)
  STABLE_BUILD_LANG          language, like --lang (en or pt-BR)
  STABLE_BUILD_NO_TTY=1      never prompt: install only stable-build and its MCP plugin
  STABLE_BUILD_FOUNDRY_TAG   Arc Foundry release to install instead of the latest (like v0.8.0-2)
  STABLE_BUILD_SOURCE        development: marketplace source instead of %s (local dir or owner/repo)
  STABLE_BUILD_CIRCLE_SOURCE development: source instead of %s (local dir or owner/repo)\n" ;;
      # arguments and safety
      err_unknown_option) _T="stable-build: unknown option: %s" ;;
      err_update_uninstall) _T="--update and --uninstall cannot be combined" ;;
      err_prefix_empty) _T="--prefix needs a directory" ;;
      err_ref_invalid) _T="--ref must be a branch or tag name (letters, digits, . _ / -)" ;;
      err_root) _T="refusing to run as root. Run it as your normal user; nothing here needs sudo." ;;
      err_home_unset) _T="HOME is not set" ;;
      err_prefix_mkdir) _T="cannot create --prefix directory %s" ;;
      err_mktemp) _T="mktemp failed" ;;
      # preflight and host CLIs
      err_node_missing) _T="node %s+ is required (https://nodejs.org). It writes the manifest and runs the guard." ;;
      err_node_run) _T="could not run node" ;;
      err_node_old) _T="node %s is too old; stable-build needs node %s or newer" ;;
      err_src_dir) _T="source directory not found: %s" ;;
      err_source_env) _T="%s must be a local directory or owner/repo" ;;
      warn_claude_version) _T="could not read 'claude --version'; skipping Claude Code" ;;
      warn_claude_old) _T="Claude Code %s is older than %s, the version this installer is verified on. Run 'claude update' and rerun. Skipping Claude Code." ;;
      warn_claude_noplugin) _T="'claude plugin' is not available in Claude Code %s; skipping Claude Code" ;;
      warn_codex_noplugin) _T="this Codex CLI%s has no 'codex plugin' command; update Codex to use stable-build there. Skipping Codex." ;;
      err_no_host) _T="stable-build needs Claude Code (%s or newer) or a Codex CLI with 'codex plugin'.\n  Claude Code: https://code.claude.com/docs/en/setup\n  Codex:       npm install -g @openai/codex" ;;
      warn_agent_noyes) _T="this looks like a Claude Code or Codex session, where nobody can answer a prompt: only stable-build and its MCP plugin are installed. (Which CODEX_* variables Codex sets is UNVERIFIED.)" ;;
      warn_agent_yes) _T="this looks like a Claude Code or Codex session; --yes answers every prompt for you. (Which CODEX_* variables Codex sets is UNVERIFIED.)" ;;
      # state probe and manifest
      err_cli_failed) _T="'%s' failed: %s" ;;
      warn_codex_list_failed) _T="Codex plugin listing failed, so Codex is skipped: %s" ;;
      err_internal_probe) _T="internal error while reading CLI output" ;;
      err_internal) _T="internal error" ;;
      err_claude_parse) _T="could not parse 'claude plugin ... --json' output from Claude Code %s" ;;
      warn_codex_parse) _T="could not parse 'codex plugin ... --json' output (format UNVERIFIED); skipping Codex" ;;
      err_write) _T="could not write %s" ;;
      err_manifest_invalid) _T="%s is not valid JSON; fix or remove it, then rerun" ;;
      warn_ref_recorded) _T="stable-build is recorded at ref '%s'. Use --update --ref=%s to switch; keeping '%s'." ;;
      err_cmd_failed) _T="%s failed" ;;
      # header and plan (the full header and the plan show with --dry-run and --verbose)
      hdr_short) _T="stable-build %s%s · %s" ;;
      hdr_codex_skipped) _T="Codex skipped (needs a newer Codex)" ;;
      hdr_title) _T="stable-build installer %s (%s%s)" ;;
      hdr_dry) _T=", dry run" ;;
      mode_install) _T="install" ;;
      mode_update) _T="update" ;;
      mode_uninstall) _T="uninstall" ;;
      hdr_claude_unused) _T="claude not used" ;;
      hdr_codex_unused) _T="codex not used" ;;
      hdr_sandbox) _T="  sandbox: %s (HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and STABLE_BUILD_HOME point inside it)" ;;
      hdr_hosts) _T="  hosts: %s; node %s" ;;
      hdr_state) _T="  state: %s" ;;
      hdr_lang) _T="  language: %s (%s)" ;;
      plan) _T="Plan:" ;;
      dry_done) _T="Dry run: nothing changed." ;;
      col_record) _T="record" ;;
      col_guard) _T="guard" ;;
      col_remove) _T="remove" ;;
      st_mf_update) _T="update if anything changed" ;;
      st_mf_create) _T="create" ;;
      st_present) _T="present" ;;
      st_install) _T="install" ;;
      st_install_ask) _T="install (asks first)" ;;
      st_add) _T="add %s" ;;
      st_add_plain) _T="add" ;;
      st_add_ask) _T="add (asks first)" ;;
      st_add_user) _T="add %s (user scope)" ;;
      st_skipped_flag) _T="skipped (%s)" ;;
      st_kept_foreign) _T="kept as is (added outside this installer)" ;;
      # the one confirmation: what is missing, then one question
      cf_title_c) _T="stable-build %s sets up Claude Code for apps built on Arc:" ;;
      cf_title_x) _T="stable-build %s sets up Codex for apps built on Arc:" ;;
      cf_title_cx) _T="stable-build %s sets up Claude Code and Codex for apps built on Arc:" ;;
      cf_title_update) _T="stable-build %s: the update runs either way. Not set up here yet:" ;;
      cf_bullet) _T="  • %s" ;;
      cf_sb_guard) _T="stable-build: a 6-person team of skills and the Arc gotcha guard (advisory)" ;;
      cf_sb) _T="stable-build: a 6-person team of skills" ;;
      cf_guard) _T="the Arc gotcha guard: checks what each edit adds against Arc rules (advisory)" ;;
      cf_mcp_c) _T="Arc docs MCP and Circle codegen MCP" ;;
      cf_mcp_x) _T="Arc docs MCP" ;;
      cf_circle) _T="Circle's skills (Circle Developer Terms: %s)" ;;
      cf_studio_cli_plugin) _T="Arc Studio CLI (npm) and its Claude Code plugin" ;;
      cf_studio_cli) _T="Arc Studio CLI (npm)" ;;
      cf_studio_plugin) _T="Arc Studio's Claude Code plugin" ;;
      cf_studio_then_login) _T=", then sign-in in your browser" ;;
      cf_studio_login) _T="Arc Studio sign-in in your browser" ;;
      cf_foundry_rc) _T="Arc Foundry (arc-forge, arc-cast, arc-anvil) in %s, on PATH via %s" ;;
      cf_foundry) _T="Arc Foundry (arc-forge, arc-cast, arc-anvil) in %s" ;;
      cf_foundry_nopath) _T="Arc Foundry (arc-forge, arc-cast, arc-anvil) in %s (add it to PATH yourself)" ;;
      q_continue) _T="Continue?" ;;
      q_add_too) _T="Add these too?" ;;
      q_signin) _T="Sign in to Arc Studio now (it opens your browser)?" ;;
      cf_declined) _T="Nothing changed. To leave parts out, rerun with --no-circle, --no-studio, --no-login, --no-foundry or --no-hooks (see --help)." ;;
      nt_hint) _T="  – Not added without your yes: %s. To add them, rerun in a terminal: %s" ;;
      nt_declined) _T="  – Not added (you said no): %s. To add them later, rerun: %s" ;;
      nt_circle) _T="Circle's skills" ;;
      nt_guard) _T="the guard" ;;
      # ref switch
      sec_ref_switch) _T="Switching stable-build from ref '%s' to '%s'" ;;
      st_readd_as) _T="remove and re-add as %s (plugins reinstalled below)" ;;
      st_readd_ref) _T="remove and re-add at --ref %s (UNVERIFIED: whether plugins survive)" ;;
      err_mkt_remove) _T="could not remove marketplace %s" ;;
      err_mkt_add) _T="could not add marketplace %s" ;;
      err_xmkt_remove) _T="could not remove Codex marketplace %s" ;;
      err_xmkt_add) _T="could not add Codex marketplace %s" ;;
      # Circle
      sec_circle) _T="Circle skills" ;;
      err_circle_mkt) _T="could not add Circle's marketplace" ;;
      err_circle_xmkt) _T="could not add Circle's Codex marketplace" ;;
      err_install) _T="could not install %s" ;;
      err_codex_add) _T="could not add %s to Codex" ;;
      err_circle_zero) _T="Circle's plugin is installed but 0 skills were found in %s. The upstream layout may have changed; stopping instead of continuing silently. Please report it: %s" ;;
      err_circle_zero_codex) _T="Circle's Codex plugin is installed but 0 skills were found in %s (layout UNVERIFIED for Codex). Please report it: %s" ;;
      ok_circle) _T="  ✓ Circle's skills: %s%s" ;;
      circle_changed) _T="    changed since the last run:%s%s" ;;
      skip_circle_flag) _T="  – Circle's skills: skipped (--no-circle)" ;;
      # stable-build plugin
      sec_ours) _T="stable-build plugin" ;;
      ok_sb) _T="  ✓ stable-build%s" ;;
      warn_load_errors) _T="Claude Code reports load errors for %s: %s" ;;
      # MCP
      sec_mcp) _T="MCP servers" ;;
      st_mcp_install) _T="install (MCP: arc-docs, circle-codegen)" ;;
      st_mcp_user_skip) _T="skip: user-scope MCP '%s' already set up" ;;
      st_mcp_x_add) _T="add (MCP: arc-docs)" ;;
      st_mcp_x_skip) _T="skip: MCP '%s' already set up" ;;
      ok_mcp) _T="  ✓ MCP servers: %s%s" ;;
      mcp_connected) _T=" (connected)" ;;
      skip_mcp_flag) _T="  – MCP servers: skipped (--no-mcp)" ;;
      skip_mcp_user) _T="  – MCP servers: you already have user-scope MCP server(s) %s, so %s is skipped and tools are not duplicated" ;;
      skip_mcp_x_user) _T="  – MCP servers: Codex already has %s configured, so %s is skipped there" ;;
      warn_mcp_not_connected) _T="plugin:stable-build-mcp:%s is not reported as connected yet; check with '%s'" ;;
      # Arc Studio
      sec_studio) _T="Arc Studio" ;;
      st_studio_cli_install) _T="install: npm install -g %s@latest (asks first)" ;;
      st_studio_cli_nonpm) _T="not found, and npm is missing: skipped" ;;
      st_studio_install_ask) _T="arc-studio skills install --tool claude-code (asks first)" ;;
      st_studio_codex) _T="nothing to install; use the stable-build studio-delegate skill" ;;
      st_login_ask) _T="sign in, if not signed in yet (asks first)" ;;
      st_login_later) _T="skipped: nobody can answer here; sign in later" ;;
      ok_studio_cli_plugin) _T="  ✓ Arc Studio CLI%s and its Claude Code plugin%s" ;;
      ok_studio_cli) _T="  ✓ Arc Studio CLI%s%s" ;;
      studio_codex_note) _T=" (in Codex, use the stable-build studio-delegate skill)" ;;
      studio_not_on_path) _T="    %s is not on PATH; add it there to run arc-studio by name" ;;
      fail_npm) _T="  ✗ Arc Studio CLI: npm could not install globally; use a Node version manager (nvm, fnm) or run: sudo npm install -g %s" ;;
      fail_studio_missing) _T="  ✗ Arc Studio CLI: npm finished, but arc-studio was not found on PATH or in %s" ;;
      skip_studio_nonpm) _T="  – Arc Studio CLI: npm not found; install Node.js with npm, then run: npm install -g %s@latest" ;;
      skip_studio_flag) _T="  – Arc Studio: skipped (--no-studio)" ;;
      err_studio_install) _T="arc-studio skills install failed" ;;
      warn_studio_unlisted) _T="arc-studio skills install finished but %s is not listed by 'claude plugin list'" ;;
      ok_signed_in) _T="  ✓ Arc Studio: signed in" ;;
      studio_login_later) _T="  – Arc Studio: sign in later with: arc-studio login" ;;
      studio_login_declined) _T="  – Arc Studio: sign in later with: arc-studio login (--no-login skips this question)" ;;
      fail_login) _T="  ✗ Arc Studio: not signed in; sign in later with: arc-studio login" ;;
      fail_studio_plugin_update) _T="  ✗ Arc Studio: its Claude Code plugin was not updated; run: %s" ;;
      # Arc Foundry
      sec_foundry) _T="Arc Foundry" ;;
      st_foundry_install) _T="install %s, %s (asks first)" ;;
      st_foundry_tag_env) _T="tag %s from STABLE_BUILD_FOUNDRY_TAG" ;;
      st_foundry_tag_latest) _T="latest release (GitHub API)" ;;
      st_foundry_target) _T="no prebuilt binary for %s: skipped" ;;
      st_foundry_update) _T="update if a newer release exists (added by this installer)" ;;
      st_rc_add) _T="add 2 lines that put %s on PATH" ;;
      ok_foundry) _T="  ✓ Arc Foundry%s (arc-forge, arc-cast, arc-anvil)%s" ;;
      ok_foundry_found) _T="  ✓ Arc Foundry: found at %s%s" ;;
      foundry_path_rc) _T=", on PATH via %s in new terminals" ;;
      foundry_path_hint) _T="; add %s to PATH: %s" ;;
      skip_foundry_flag) _T="  – Arc Foundry: skipped (--no-foundry)" ;;
      skip_foundry_target) _T="  – Arc Foundry: no prebuilt binary for %s; build from source: %s" ;;
      skip_foundry_foreign) _T="  – Arc Foundry: %s exists and was not installed by stable-build; nothing installed" ;;
      fail_foundry_tag) _T="  ✗ Arc Foundry: could not read the latest release from GitHub; nothing installed" ;;
      fail_foundry_download) _T="  ✗ Arc Foundry: could not download %s; nothing installed" ;;
      fail_foundry_sha) _T="  ✗ Arc Foundry: checksum mismatch, nothing installed" ;;
      fail_foundry_archive) _T="  ✗ Arc Foundry: the archive does not hold forge, cast and anvil; nothing installed" ;;
      fail_foundry_copy) _T="  ✗ Arc Foundry: could not write to %s; nothing installed" ;;
      fail_foundry_version) _T="  ✗ Arc Foundry: arc-forge --version failed with this release, so nothing was changed; see %s" ;;
      warn_foundry_tag_env) _T="STABLE_BUILD_FOUNDRY_TAG=%s is not a release tag such as v0.8.0-2; using the latest release" ;;
      # updates
      sec_updates) _T="Updates" ;;
      st_update) _T="update" ;;
      st_upgrade) _T="upgrade" ;;
      st_readd) _T="re-add" ;;
      st_update_ours) _T="update (added by this installer)" ;;
      st_upgrade_readd_ours) _T="upgrade + re-add (added by this installer)" ;;
      st_studio_reregister) _T="re-register: its marketplace dir is gone (%s)" ;;
      st_studio_gone_foreign) _T="marketplace dir is gone; not changed (marketplace not added by this installer)" ;;
      st_npm_update) _T="npm install -g %s@latest (added by this installer)" ;;
      err_mkt_update) _T="marketplace update failed" ;;
      err_plugin_update) _T="plugin update failed" ;;
      err_xmkt_upgrade) _T="Codex marketplace upgrade failed" ;;
      err_xplugin_readd) _T="Codex plugin re-add failed" ;;
      err_circle_mkt_update) _T="Circle marketplace update failed" ;;
      err_circle_update) _T="Circle plugin update failed" ;;
      err_circle_xmkt_upgrade) _T="Circle Codex marketplace upgrade failed" ;;
      err_circle_xreadd) _T="Circle Codex plugin re-add failed" ;;
      err_stale_mkt) _T="could not remove the stale %s marketplace" ;;
      warn_studio_gone) _T="the %s marketplace points to a missing directory (%s). Repair it with: %s && %s" ;;
      # guard
      sec_guard) _T="Edit-time guard" ;;
      st_guard_on) _T="already on" ;;
      st_guard_off_kept) _T="already off (kept)" ;;
      st_guard_invalid) _T="unreadable; left as is" ;;
      st_guard_nohooks) _T="skipped (--no-hooks): stays off, not asked again" ;;
      st_guard_declined) _T="declined earlier: stays off" ;;
      st_guard_update) _T="off; --update does not ask" ;;
      st_guard_ask) _T="turn on (asks first)" ;;
      ok_guard_on) _T="  ✓ Guard on (advisory): checks each edit against Arc rules" ;;
      guard_on_already) _T="  ✓ Guard on; turn it off with /stable-build:gotchas" ;;
      guard_off_already) _T="  – Guard: off, as set earlier; turn it on with /stable-build:gotchas" ;;
      warn_cfg_invalid) _T="%s is not valid JSON; leaving it untouched (the guard treats it as off)" ;;
      guard_nohooks) _T="  – Guard: off (--no-hooks), and later runs do not ask; turn it on with /stable-build:gotchas" ;;
      guard_declined) _T="  – Guard: off (declined on %s); turn it on with /stable-build:gotchas" ;;
      guard_update) _T="  – Guard: off; --update never turns it on (use /stable-build:gotchas)" ;;
      warn_sbhome_env) _T="STABLE_BUILD_HOME is %s: set it in the environment Claude Code and Codex run in too, or the hooks will not see this consent" ;;
      guard_codex_trust) _T="  Codex: open /hooks in Codex and trust the stable-build hooks; Codex skips plugin hooks until you do." ;;
      # closing lines
      ver_was) _T=" %s (was %s)" ;;
      fin_done) _T="Done. Open %s in your project and ask: \"Sam, what should I build on Arc?\"" ;;
      fin_host_both) _T="Claude Code or Codex" ;;
      fin_next) _T="Your team: Tim (architect) · Bobbilee (PM) · Sam (analyst) · Joshua (UX) · Pedro (dev) · Mike (tech writer)" ;;
      fin_reload) _T="In a Claude Code session that is already open, run /reload-plugins." ;;
      fin_circle_paid) _T="Some Circle skills can lead to paid services (%s); review them in /plugin." ;;
      fin_sandbox) _T="Sandboxed session:\n  %s\n  %s" ;;
      fin_update_remove) _T="Update or remove: rerun the install command with --update or --uninstall." ;;
      fin_update_remove_pfx) _T="Update or remove: rerun the install command with --update or --uninstall, plus --prefix=%s." ;;
      fin_files) _T="Manifest: %s · log: %s" ;;
      fin_community) _T="stable-build is a community project, not affiliated with Circle." ;;
      # uninstall
      sec_removing) _T="Removing stable-build" ;;
      un_no_manifest) _T="No manifest at %s, so nothing is removed: the installer never guesses what it added." ;;
      un_by_hand) _T="To remove stable-build by hand:" ;;
      un_separate) _T="Circle's plugin (%s, Codex %s) and Arc Studio's plugin (%s) are separate;\nremove them only if you no longer want them." ;;
      st_absent) _T="absent" ;;
      st_keep_foreign) _T="keep (not added by this installer)" ;;
      st_keep_flag) _T="keep (%s)" ;;
      st_keep_circle_flag) _T="keep Circle's plugin (--no-circle)" ;;
      st_remove) _T="remove" ;;
      st_remove_ask) _T="remove (asks first)" ;;
      st_remove_state) _T="manifest.json, config.json (guard consent, language), install.log; the directory only if then empty" ;;
      st_codex_unavailable) _T="codex CLI unavailable: cannot remove recorded Codex entries" ;;
      st_claude_unavailable) _T="claude CLI unavailable: cannot remove recorded Claude Code entries" ;;
      st_npm_unavailable) _T="npm not found: cannot remove the Arc Studio CLI" ;;
      st_studio_cli_gone) _T="already gone from %s: nothing to remove" ;;
      st_studio_cli_wait) _T="keep for now: its Claude Code plugin goes first, and the claude CLI is not available" ;;
      st_rc_remove) _T="remove the 2 lines stable-build added" ;;
      un_blocked_codex) _T="Codex entries are recorded but the codex CLI is not available" ;;
      un_blocked_claude) _T="Claude Code entries are recorded but the claude CLI is not available" ;;
      un_blocked_npm) _T="the Arc Studio CLI is recorded, but npm could not remove it: npm uninstall -g %s" ;;
      q_remove_circle) _T="Remove Circle's skills plugin too (this installer added it)?" ;;
      un_keep_circle) _T="  Keeping Circle's skills plugin." ;;
      un_ok_studio_plugin) _T="  ✓ Removed Arc Studio's Claude Code plugin" ;;
      un_ok_studio_cli) _T="  ✓ Removed the Arc Studio CLI (npm uninstall -g %s)" ;;
      un_studio_cli_gone) _T="  – Arc Studio CLI: already gone from %s, so there was nothing to remove" ;;
      un_studio_cli_wait) _T="  – Arc Studio CLI: kept for now; its Claude Code plugin has to be removed first, and the claude CLI is not available" ;;
      un_ok_circle) _T="  ✓ Removed Circle's skills plugin" ;;
      un_ok_foundry) _T="  ✓ Removed Arc Foundry from %s" ;;
      un_foundry_kept) _T="  – Kept %s: it is no longer the file stable-build installed" ;;
      un_ok_rc) _T="  ✓ Removed the 2 PATH lines stable-build added to %s" ;;
      un_nothing) _T="Nothing to remove: no manifest at %s, and no stable-build entry in %s." ;;
      un_nothing_thirdparty) _T="  Circle's or Arc Studio's plugin is still registered; without a manifest the installer cannot tell\n  who added it, so it is kept. Remove it yourself only if you no longer want it." ;;
      un_incomplete) _T="stable-build: uninstall incomplete; keeping %s so you can retry." ;;
      un_still_present) _T="  still present: %s" ;;
      err_refuse_touch) _T="refusing to touch '%s' (no manifest inside)" ;;
      un_cfg_stripped) _T="  Removed stable-build's settings from %s and kept the file: it holds settings stable-build did not write." ;;
      un_kept_dir) _T="  Kept %s: it holds files stable-build did not write." ;;
      un_removed) _T="Removed. Verified with %s: no stable-build entries left." ;;
      un_kept_preexisting) _T="  Kept (present before stable-build was installed): %s %s" ;;
      un_studio_signin) _T="  Arc Studio sign-in is untouched: arc-studio logout was not run." ;;
      un_codex_trust) _T="  Codex may keep trust entries for removed hooks (UNVERIFIED); review them in /hooks." ;;
      un_reload) _T="  In a running Claude Code session run /reload-plugins." ;;
      *) return 1 ;;
    esac
  }

  _msg_pt() {
    case $1 in
      # mostradas antes de haver um idioma escolhido, ou quando não dá para escolher: o mesmo texto nas duas tabelas
      lang_banner) _T="stable-build %s: installer / instalador" ;;
      lang_menu) _T="Language / Idioma: [1] English  [2] Português (Brasil)  (Enter = %s): " ;;
      lang_menu_retry) _T="  Type 1 or 2. / Digite 1 ou 2." ;;
      err_lang_unknown) _T="stable-build: error: unknown language '%s' (supported: en, pt-BR)\nstable-build: erro: idioma desconhecido '%s' (suportados: en, pt-BR)" ;;
      err_lang_missing) _T="stable-build: error: --lang needs a value: en or pt-BR\nstable-build: erro: --lang precisa de um valor: en ou pt-BR" ;;
      err_lang_env) _T="stable-build: error: STABLE_BUILD_LANG=%s is not a supported language (en, pt-BR)\nstable-build: erro: STABLE_BUILD_LANG=%s não é um idioma suportado (en, pt-BR)" ;;
      # idioma
      lang_src_saved) _T="salvo" ;;
      lang_src_prompt) _T="escolhido" ;;
      lang_src_default) _T="padrão" ;;
      col_lang) _T="idioma" ;;
      st_lang_save) _T="salvar o idioma %s" ;;
      st_lang_same) _T="idioma %s (já salvo)" ;;
      st_lang_invalid) _T="JSON inválido: o idioma não é salvo nele" ;;
      warn_cfg_lang_invalid) _T="%s não é um JSON válido, então a escolha de idioma não é salva nele; corrija ou remova o arquivo" ;;
      # saída e perguntas
      pfx_warn) _T="stable-build: aviso: " ;;
      pfx_error) _T="stable-build: erro: " ;;
      ask_hint_yes) _T="[S/n]" ;;
      ask_hint_no) _T="[s/N]" ;;
      ans_yes) _T="S" ;;
      ans_no) _T="N" ;;
      ask_noterm_default) _T="(sem terminal: padrão)" ;;
      ask_noterm_skipped) _T="(sem terminal: pulado; isto precisa de um sim seu, então rode de novo em um terminal ou com --yes)" ;;
      ask_retry) _T="  Digite s (sim) ou n (não), ou tecle Enter para o padrão." ;;
      fail_log) _T="  Log completo: %s" ;;
      usage) _T="instalador stable-build %s: skills, hooks do guard e servidores MCP para apps construídos na Arc,
para Claude Code e Codex, mais a CLI do Arc Studio e o Arc Foundry. Projeto comunitário,
sem afiliação com a Circle.

Uso: install.sh [opções]
  (sem opção)     lista o que falta, pergunta uma vez e instala (pode rodar de novo quando quiser)
  --update        atualiza o stable-build e também o plugin da Circle, o Arc Studio e o Arc Foundry,
                  se foi este instalador que os adicionou
  --uninstall     remove só o que este instalador adicionou (lê \$STABLE_BUILD_HOME/manifest.json)
  --prefix=DIR    sandbox: toda chamada de CLI roda com HOME=DIR, então nada fora de DIR é gravado
  --yes           instala tudo sem perguntar (isso aceita os termos de desenvolvedor da Circle e liga
                  o guard); o login no Arc Studio fica para depois. Um guard que você recusou antes
                  continua desligado, e --update nunca liga o guard.
  --no-hooks      deixa o guard de edição desligado (agora e nas próximas execuções)
  --no-mcp        pula o plugin stable-build-mcp (servidores MCP arc-docs e circle-codegen)
  --no-circle     pula o plugin de skills da Circle
  --no-studio     pula a CLI do Arc Studio, o plugin dela para o Claude Code e o login
  --no-login      pula o login no Arc Studio (rode arc-studio login você mesmo depois)
  --no-foundry    pula o Arc Foundry (arc-forge, arc-cast e arc-anvil em ~/.local/bin)
  --dry-run       mostra o plano e não altera nada
  --verbose       mostra cada comando e a saída bruta dele (ela sempre vai para o install.log em
                  \$STABLE_BUILD_HOME)
  --ref=REF       ref git de %s a instalar (padrão: main, que só avança nos releases)
  --lang=IDIOMA   idioma deste instalador e das respostas do kit: en ou pt-BR. Fica salvo para as
                  próximas execuções; padrão: a escolha salva; senão, pergunta no terminal (Enter
                  mantém o inglês); senão, inglês
  -h, --help      mostra esta ajuda

Ambiente:
  STABLE_BUILD_HOME          diretório de estado (padrão: ~/.stable-build)
  STABLE_BUILD_LANG          idioma, como --lang (en ou pt-BR)
  STABLE_BUILD_NO_TTY=1      nunca pergunta: instala só o stable-build e o plugin MCP dele
  STABLE_BUILD_FOUNDRY_TAG   release do Arc Foundry a instalar no lugar do mais recente (como v0.8.0-2)
  STABLE_BUILD_SOURCE        desenvolvimento: fonte do marketplace no lugar de %s (diretório local ou owner/repo)
  STABLE_BUILD_CIRCLE_SOURCE desenvolvimento: fonte no lugar de %s (diretório local ou owner/repo)\n" ;;
      # argumentos e segurança
      err_unknown_option) _T="stable-build: opção desconhecida: %s" ;;
      err_update_uninstall) _T="--update e --uninstall não podem ser usados juntos" ;;
      err_prefix_empty) _T="--prefix precisa de um diretório" ;;
      err_ref_invalid) _T="--ref precisa ser um nome de branch ou tag (letras, dígitos, . _ / -)" ;;
      err_root) _T="este instalador não roda como root. Rode com o seu usuário normal; nada aqui precisa de sudo." ;;
      err_home_unset) _T="HOME não está definido" ;;
      err_prefix_mkdir) _T="não foi possível criar o diretório de --prefix %s" ;;
      err_mktemp) _T="o mktemp falhou" ;;
      # verificações iniciais e CLIs
      err_node_missing) _T="é preciso ter o node %s+ (https://nodejs.org). Ele grava o manifesto e roda o guard." ;;
      err_node_run) _T="não foi possível executar o node" ;;
      err_node_old) _T="o node %s é antigo demais; o stable-build precisa do node %s ou mais recente" ;;
      err_src_dir) _T="diretório de origem não encontrado: %s" ;;
      err_source_env) _T="%s precisa ser um diretório local ou owner/repo" ;;
      warn_claude_version) _T="não foi possível ler 'claude --version'; pulando o Claude Code" ;;
      warn_claude_old) _T="o Claude Code %s é mais antigo que a versão %s, em que este instalador foi verificado. Rode 'claude update' e execute de novo. Pulando o Claude Code." ;;
      warn_claude_noplugin) _T="'claude plugin' não está disponível no Claude Code %s; pulando o Claude Code" ;;
      warn_codex_noplugin) _T="este Codex CLI%s não tem o comando 'codex plugin'; atualize o Codex para usar o stable-build nele. Pulando o Codex." ;;
      err_no_host) _T="O stable-build precisa do Claude Code (%s ou mais recente) ou de um Codex CLI com 'codex plugin'.\n  Claude Code: https://code.claude.com/docs/en/setup\n  Codex:       npm install -g @openai/codex" ;;
      warn_agent_noyes) _T="isto parece uma sessão do Claude Code ou do Codex, onde ninguém pode responder a perguntas: só o stable-build e o plugin MCP dele são instalados. (Quais variáveis CODEX_* o Codex define: NÃO VERIFICADO.)" ;;
      warn_agent_yes) _T="isto parece uma sessão do Claude Code ou do Codex; --yes responde a todas as perguntas por você. (Quais variáveis CODEX_* o Codex define: NÃO VERIFICADO.)" ;;
      # leitura de estado e manifesto
      err_cli_failed) _T="'%s' falhou: %s" ;;
      warn_codex_list_failed) _T="a listagem de plugins do Codex falhou, então o Codex foi pulado: %s" ;;
      err_internal_probe) _T="erro interno ao ler a saída das CLIs" ;;
      err_internal) _T="erro interno" ;;
      err_claude_parse) _T="não foi possível interpretar a saída de 'claude plugin ... --json' do Claude Code %s" ;;
      warn_codex_parse) _T="não foi possível interpretar a saída de 'codex plugin ... --json' (formato NÃO VERIFICADO); pulando o Codex" ;;
      err_write) _T="não foi possível gravar %s" ;;
      err_manifest_invalid) _T="%s não é um JSON válido; corrija ou remova o arquivo e rode de novo" ;;
      warn_ref_recorded) _T="o stable-build está registrado na ref '%s'. Use --update --ref=%s para trocar; mantendo '%s'." ;;
      err_cmd_failed) _T="%s falhou" ;;
      # cabeçalho e plano (o cabeçalho completo e o plano aparecem com --dry-run e --verbose)
      hdr_short) _T="stable-build %s%s · %s" ;;
      hdr_codex_skipped) _T="Codex pulado (precisa de um Codex mais novo)" ;;
      hdr_title) _T="instalador stable-build %s (%s%s)" ;;
      hdr_dry) _T=", simulação" ;;
      mode_install) _T="instalação" ;;
      mode_update) _T="atualização" ;;
      mode_uninstall) _T="desinstalação" ;;
      hdr_claude_unused) _T="claude não usado" ;;
      hdr_codex_unused) _T="codex não usado" ;;
      hdr_sandbox) _T="  sandbox: %s (HOME, CLAUDE_CONFIG_DIR, CODEX_HOME e STABLE_BUILD_HOME apontam para dentro dele)" ;;
      hdr_hosts) _T="  hosts: %s; node %s" ;;
      hdr_state) _T="  estado: %s" ;;
      hdr_lang) _T="  idioma: %s (%s)" ;;
      plan) _T="Plano:" ;;
      dry_done) _T="Simulação: nada foi alterado." ;;
      col_record) _T="registro" ;;
      col_guard) _T="guard" ;;
      col_remove) _T="remover" ;;
      st_mf_update) _T="atualizar se algo mudou" ;;
      st_mf_create) _T="criar" ;;
      st_present) _T="presente" ;;
      st_install) _T="instalar" ;;
      st_install_ask) _T="instalar (pergunta antes)" ;;
      st_add) _T="adicionar %s" ;;
      st_add_plain) _T="adicionar" ;;
      st_add_ask) _T="adicionar (pergunta antes)" ;;
      st_add_user) _T="adicionar %s (escopo de usuário)" ;;
      st_skipped_flag) _T="pulado (%s)" ;;
      st_kept_foreign) _T="mantido como está (adicionado fora deste instalador)" ;;
      # a única confirmação: o que falta, depois uma pergunta
      cf_title_c) _T="O stable-build %s prepara o Claude Code para apps construídos na Arc:" ;;
      cf_title_x) _T="O stable-build %s prepara o Codex para apps construídos na Arc:" ;;
      cf_title_cx) _T="O stable-build %s prepara o Claude Code e o Codex para apps construídos na Arc:" ;;
      cf_title_update) _T="stable-build %s: a atualização roda de qualquer forma. Ainda falta aqui:" ;;
      cf_bullet) _T="  • %s" ;;
      cf_sb_guard) _T="stable-build: um time de 6 especialistas (skills) e o guard de pegadinhas da Arc (só avisa)" ;;
      cf_sb) _T="stable-build: um time de 6 especialistas (skills)" ;;
      cf_guard) _T="o guard de pegadinhas da Arc: confere o que cada edição adiciona com as regras da Arc (só avisa)" ;;
      cf_mcp_c) _T="MCP de docs da Arc e MCP de codegen da Circle" ;;
      cf_mcp_x) _T="MCP de docs da Arc" ;;
      cf_circle) _T="skills da Circle (Circle Developer Terms: %s)" ;;
      cf_studio_cli_plugin) _T="CLI do Arc Studio (npm) e o plugin dela para o Claude Code" ;;
      cf_studio_cli) _T="CLI do Arc Studio (npm)" ;;
      cf_studio_plugin) _T="plugin do Arc Studio para o Claude Code" ;;
      cf_studio_then_login) _T=", depois o login pelo navegador" ;;
      cf_studio_login) _T="login no Arc Studio pelo navegador" ;;
      cf_foundry_rc) _T="Arc Foundry (arc-forge, arc-cast, arc-anvil) em %s, no PATH via %s" ;;
      cf_foundry) _T="Arc Foundry (arc-forge, arc-cast, arc-anvil) em %s" ;;
      cf_foundry_nopath) _T="Arc Foundry (arc-forge, arc-cast, arc-anvil) em %s (adicione ao PATH você mesmo)" ;;
      q_continue) _T="Continuar?" ;;
      q_add_too) _T="Adicionar também?" ;;
      q_signin) _T="Fazer login no Arc Studio agora (abre o navegador)?" ;;
      cf_declined) _T="Nada foi alterado. Para deixar partes de fora, rode de novo com --no-circle, --no-studio, --no-login, --no-foundry ou --no-hooks (veja --help)." ;;
      nt_hint) _T="  – Não adicionados sem o seu sim: %s. Para adicioná-los, rode de novo em um terminal: %s" ;;
      nt_declined) _T="  – Não adicionados (você disse não): %s. Para adicioná-los depois, rode de novo: %s" ;;
      nt_circle) _T="skills da Circle" ;;
      nt_guard) _T="o guard" ;;
      # troca de ref
      sec_ref_switch) _T="Trocando o stable-build da ref '%s' para '%s'" ;;
      st_readd_as) _T="remover e adicionar de novo como %s (plugins reinstalados abaixo)" ;;
      st_readd_ref) _T="remover e adicionar de novo em --ref %s (NÃO VERIFICADO: se os plugins continuam instalados)" ;;
      err_mkt_remove) _T="não foi possível remover o marketplace %s" ;;
      err_mkt_add) _T="não foi possível adicionar o marketplace %s" ;;
      err_xmkt_remove) _T="não foi possível remover o marketplace %s do Codex" ;;
      err_xmkt_add) _T="não foi possível adicionar o marketplace %s ao Codex" ;;
      # Circle
      sec_circle) _T="Skills da Circle" ;;
      err_circle_mkt) _T="não foi possível adicionar o marketplace da Circle" ;;
      err_circle_xmkt) _T="não foi possível adicionar o marketplace da Circle ao Codex" ;;
      err_install) _T="não foi possível instalar %s" ;;
      err_codex_add) _T="não foi possível adicionar %s ao Codex" ;;
      err_circle_zero) _T="o plugin da Circle está instalado, mas foram encontradas 0 skills em %s. A estrutura do repositório de origem pode ter mudado; o instalador para aqui em vez de seguir em silêncio. Por favor, reporte: %s" ;;
      err_circle_zero_codex) _T="o plugin da Circle para o Codex está instalado, mas foram encontradas 0 skills em %s (estrutura NÃO VERIFICADA no Codex). Por favor, reporte: %s" ;;
      ok_circle) _T="  ✓ skills da Circle: %s%s" ;;
      circle_changed) _T="    mudaram desde a última execução:%s%s" ;;
      skip_circle_flag) _T="  – skills da Circle: puladas (--no-circle)" ;;
      # plugin stable-build
      sec_ours) _T="Plugin stable-build" ;;
      ok_sb) _T="  ✓ stable-build%s" ;;
      warn_load_errors) _T="o Claude Code relata erros ao carregar %s: %s" ;;
      # MCP
      sec_mcp) _T="Servidores MCP" ;;
      st_mcp_install) _T="instalar (MCP: arc-docs, circle-codegen)" ;;
      st_mcp_user_skip) _T="pular: o MCP '%s' de escopo de usuário já está configurado" ;;
      st_mcp_x_add) _T="adicionar (MCP: arc-docs)" ;;
      st_mcp_x_skip) _T="pular: o MCP '%s' já está configurado" ;;
      ok_mcp) _T="  ✓ servidores MCP: %s%s" ;;
      mcp_connected) _T=" (conectados)" ;;
      skip_mcp_flag) _T="  – servidores MCP: pulados (--no-mcp)" ;;
      skip_mcp_user) _T="  – servidores MCP: você já tem servidor(es) MCP de escopo de usuário %s, então %s foi pulado para não duplicar ferramentas" ;;
      skip_mcp_x_user) _T="  – servidores MCP: o Codex já tem %s configurado, então %s foi pulado nele" ;;
      warn_mcp_not_connected) _T="plugin:stable-build-mcp:%s ainda não aparece como conectado; confira com '%s'" ;;
      # Arc Studio
      sec_studio) _T="Arc Studio" ;;
      st_studio_cli_install) _T="instalar: npm install -g %s@latest (pergunta antes)" ;;
      st_studio_cli_nonpm) _T="não encontrado, e o npm não existe: pulado" ;;
      st_studio_install_ask) _T="arc-studio skills install --tool claude-code (pergunta antes)" ;;
      st_studio_codex) _T="nada a instalar; use a skill studio-delegate do stable-build" ;;
      st_login_ask) _T="fazer login, se ainda não tiver feito (pergunta antes)" ;;
      st_login_later) _T="pulado: ninguém pode responder aqui; faça login depois" ;;
      ok_studio_cli_plugin) _T="  ✓ CLI do Arc Studio%s e o plugin dela para o Claude Code%s" ;;
      ok_studio_cli) _T="  ✓ CLI do Arc Studio%s%s" ;;
      studio_codex_note) _T=" (no Codex, use a skill studio-delegate do stable-build)" ;;
      studio_not_on_path) _T="    %s não está no PATH; adicione-o para rodar arc-studio pelo nome" ;;
      fail_npm) _T="  ✗ CLI do Arc Studio: o npm não conseguiu instalar globalmente; use um gerenciador de versões do Node (nvm, fnm) ou rode: sudo npm install -g %s" ;;
      fail_studio_missing) _T="  ✗ CLI do Arc Studio: o npm terminou, mas arc-studio não foi encontrado no PATH nem em %s" ;;
      skip_studio_nonpm) _T="  – CLI do Arc Studio: npm não encontrado; instale o Node.js com o npm e rode: npm install -g %s@latest" ;;
      skip_studio_flag) _T="  – Arc Studio: pulado (--no-studio)" ;;
      err_studio_install) _T="arc-studio skills install falhou" ;;
      warn_studio_unlisted) _T="arc-studio skills install terminou, mas %s não aparece em 'claude plugin list'" ;;
      ok_signed_in) _T="  ✓ Arc Studio: login feito" ;;
      studio_login_later) _T="  – Arc Studio: faça login depois com: arc-studio login" ;;
      studio_login_declined) _T="  – Arc Studio: faça login depois com: arc-studio login (--no-login pula esta pergunta)" ;;
      fail_login) _T="  ✗ Arc Studio: login não concluído; faça login depois com: arc-studio login" ;;
      fail_studio_plugin_update) _T="  ✗ Arc Studio: o plugin dele para o Claude Code não foi atualizado; rode: %s" ;;
      # Arc Foundry
      sec_foundry) _T="Arc Foundry" ;;
      st_foundry_install) _T="instalar %s, %s (pergunta antes)" ;;
      st_foundry_tag_env) _T="tag %s de STABLE_BUILD_FOUNDRY_TAG" ;;
      st_foundry_tag_latest) _T="último release (API do GitHub)" ;;
      st_foundry_target) _T="não há binário pronto para %s: pulado" ;;
      st_foundry_update) _T="atualizar se houver um release mais novo (adicionado por este instalador)" ;;
      st_rc_add) _T="adicionar 2 linhas que põem %s no PATH" ;;
      ok_foundry) _T="  ✓ Arc Foundry%s (arc-forge, arc-cast, arc-anvil)%s" ;;
      ok_foundry_found) _T="  ✓ Arc Foundry: encontrado em %s%s" ;;
      foundry_path_rc) _T=", no PATH via %s nos terminais novos" ;;
      foundry_path_hint) _T="; adicione %s ao PATH: %s" ;;
      skip_foundry_flag) _T="  – Arc Foundry: pulado (--no-foundry)" ;;
      skip_foundry_target) _T="  – Arc Foundry: não há binário pronto para %s; compile a partir do código-fonte: %s" ;;
      skip_foundry_foreign) _T="  – Arc Foundry: %s já existe e não foi instalado pelo stable-build; nada foi instalado" ;;
      fail_foundry_tag) _T="  ✗ Arc Foundry: não foi possível ler o último release no GitHub; nada foi instalado" ;;
      fail_foundry_download) _T="  ✗ Arc Foundry: não foi possível baixar %s; nada foi instalado" ;;
      fail_foundry_sha) _T="  ✗ Arc Foundry: o checksum não confere, nada foi instalado" ;;
      fail_foundry_archive) _T="  ✗ Arc Foundry: o arquivo baixado não traz forge, cast e anvil; nada foi instalado" ;;
      fail_foundry_copy) _T="  ✗ Arc Foundry: não foi possível gravar em %s; nada foi instalado" ;;
      fail_foundry_version) _T="  ✗ Arc Foundry: arc-forge --version falhou com este release, então nada foi alterado; veja %s" ;;
      warn_foundry_tag_env) _T="STABLE_BUILD_FOUNDRY_TAG=%s não é uma tag de release como v0.8.0-2; usando o último release" ;;
      # atualizações
      sec_updates) _T="Atualizações" ;;
      st_update) _T="atualizar" ;;
      st_upgrade) _T="atualizar (upgrade)" ;;
      st_readd) _T="adicionar de novo" ;;
      st_update_ours) _T="atualizar (adicionado por este instalador)" ;;
      st_upgrade_readd_ours) _T="upgrade + adicionar de novo (adicionado por este instalador)" ;;
      st_studio_reregister) _T="registrar de novo: o diretório do marketplace sumiu (%s)" ;;
      st_studio_gone_foreign) _T="o diretório do marketplace sumiu; nada alterado (marketplace não adicionado por este instalador)" ;;
      st_npm_update) _T="npm install -g %s@latest (adicionado por este instalador)" ;;
      err_mkt_update) _T="a atualização do marketplace falhou" ;;
      err_plugin_update) _T="a atualização do plugin falhou" ;;
      err_xmkt_upgrade) _T="o upgrade do marketplace no Codex falhou" ;;
      err_xplugin_readd) _T="não foi possível adicionar de novo o plugin ao Codex" ;;
      err_circle_mkt_update) _T="a atualização do marketplace da Circle falhou" ;;
      err_circle_update) _T="a atualização do plugin da Circle falhou" ;;
      err_circle_xmkt_upgrade) _T="o upgrade do marketplace da Circle no Codex falhou" ;;
      err_circle_xreadd) _T="não foi possível adicionar de novo o plugin da Circle ao Codex" ;;
      err_stale_mkt) _T="não foi possível remover o marketplace obsoleto %s" ;;
      warn_studio_gone) _T="o marketplace %s aponta para um diretório que não existe mais (%s). Corrija com: %s && %s" ;;
      # guard
      sec_guard) _T="Guard de edição" ;;
      st_guard_on) _T="já ligado" ;;
      st_guard_off_kept) _T="já desligado (mantido)" ;;
      st_guard_invalid) _T="ilegível; deixado como está" ;;
      st_guard_nohooks) _T="pulado (--no-hooks): fica desligado e não pergunta de novo" ;;
      st_guard_declined) _T="recusado antes: fica desligado" ;;
      st_guard_update) _T="desligado; --update não pergunta" ;;
      st_guard_ask) _T="ligar (pergunta antes)" ;;
      ok_guard_on) _T="  ✓ Guard ligado (só avisa): confere cada edição com as regras da Arc" ;;
      guard_on_already) _T="  ✓ Guard ligado; para desligar, use /stable-build:gotchas" ;;
      guard_off_already) _T="  – Guard: desligado, como definido antes; para ligar, use /stable-build:gotchas" ;;
      warn_cfg_invalid) _T="%s não é um JSON válido; o arquivo fica intocado (o guard o trata como desligado)" ;;
      guard_nohooks) _T="  – Guard: desligado (--no-hooks), e as próximas execuções não perguntam; para ligar, use /stable-build:gotchas" ;;
      guard_declined) _T="  – Guard: desligado (recusado em %s); para ligar, use /stable-build:gotchas" ;;
      guard_update) _T="  – Guard: desligado; --update nunca o liga (use /stable-build:gotchas)" ;;
      warn_sbhome_env) _T="STABLE_BUILD_HOME é %s: defina essa variável também no ambiente em que o Claude Code e o Codex rodam, senão os hooks não veem este consentimento" ;;
      guard_codex_trust) _T="  Codex: abra /hooks no Codex e marque os hooks do stable-build como confiáveis; o Codex ignora hooks de plugins até você fazer isso." ;;
      # linhas finais
      ver_was) _T=" %s (antes: %s)" ;;
      fin_done) _T="Concluído. Abra o %s no seu projeto e pergunte: \"Sam, o que eu construo na Arc?\"" ;;
      fin_host_both) _T="Claude Code ou o Codex" ;;
      fin_next) _T="Seu time: Tim (arquiteto) · Bobbilee (PM) · Sam (analista) · Joshua (UX) · Pedro (dev) · Mike (tech writer)" ;;
      fin_reload) _T="Numa sessão do Claude Code que já está aberta, rode /reload-plugins." ;;
      fin_circle_paid) _T="Algumas skills da Circle podem levar a serviços pagos (%s); revise-as em /plugin." ;;
      fin_sandbox) _T="Sessão no sandbox:\n  %s\n  %s" ;;
      fin_update_remove) _T="Para atualizar ou remover: rode o comando de instalação de novo com --update ou --uninstall." ;;
      fin_update_remove_pfx) _T="Para atualizar ou remover: rode o comando de instalação de novo com --update ou --uninstall, mais --prefix=%s." ;;
      fin_files) _T="Manifesto: %s · log: %s" ;;
      fin_community) _T="O stable-build é um projeto comunitário, sem afiliação com a Circle." ;;
      # desinstalação
      sec_removing) _T="Removendo o stable-build" ;;
      un_no_manifest) _T="Não há manifesto em %s, então nada é removido: o instalador nunca tenta adivinhar o que adicionou." ;;
      un_by_hand) _T="Para remover o stable-build manualmente:" ;;
      un_separate) _T="O plugin da Circle (%s, no Codex %s) e o plugin do Arc Studio (%s) são separados;\nremova-os só se não quiser mais usá-los." ;;
      st_absent) _T="ausente" ;;
      st_keep_foreign) _T="manter (não adicionado por este instalador)" ;;
      st_keep_flag) _T="manter (%s)" ;;
      st_keep_circle_flag) _T="manter o plugin da Circle (--no-circle)" ;;
      st_remove) _T="remover" ;;
      st_remove_ask) _T="remover (pergunta antes)" ;;
      st_remove_state) _T="manifest.json, config.json (consentimento do guard, idioma), install.log; o diretório só se ficar vazio" ;;
      st_codex_unavailable) _T="CLI codex indisponível: não dá para remover as entradas registradas do Codex" ;;
      st_claude_unavailable) _T="CLI claude indisponível: não dá para remover as entradas registradas do Claude Code" ;;
      st_npm_unavailable) _T="npm não encontrado: não dá para remover a CLI do Arc Studio" ;;
      st_studio_cli_gone) _T="já não está em %s: nada a remover" ;;
      st_studio_cli_wait) _T="manter por enquanto: o plugin dela para o Claude Code sai primeiro, e a CLI claude não está disponível" ;;
      st_rc_remove) _T="remover as 2 linhas que o stable-build adicionou" ;;
      un_blocked_codex) _T="há entradas do Codex registradas, mas a CLI codex não está disponível" ;;
      un_blocked_claude) _T="há entradas do Claude Code registradas, mas a CLI claude não está disponível" ;;
      un_blocked_npm) _T="a CLI do Arc Studio está registrada, mas o npm não conseguiu removê-la: npm uninstall -g %s" ;;
      q_remove_circle) _T="Remover também o plugin de skills da Circle (foi este instalador que o adicionou)?" ;;
      un_keep_circle) _T="  Mantendo o plugin de skills da Circle." ;;
      un_ok_studio_plugin) _T="  ✓ Plugin do Arc Studio para o Claude Code removido" ;;
      un_ok_studio_cli) _T="  ✓ CLI do Arc Studio removida (npm uninstall -g %s)" ;;
      un_studio_cli_gone) _T="  – CLI do Arc Studio: já não estava em %s, então não havia nada a remover" ;;
      un_studio_cli_wait) _T="  – CLI do Arc Studio: mantida por enquanto; o plugin dela para o Claude Code precisa sair primeiro, e a CLI claude não está disponível" ;;
      un_ok_circle) _T="  ✓ Plugin de skills da Circle removido" ;;
      un_ok_foundry) _T="  ✓ Arc Foundry removido de %s" ;;
      un_foundry_kept) _T="  – %s foi mantido: não é mais o arquivo que o stable-build instalou" ;;
      un_ok_rc) _T="  ✓ As 2 linhas de PATH que o stable-build adicionou foram removidas de %s" ;;
      un_nothing) _T="Nada a remover: não há manifesto em %s nem entrada do stable-build em %s." ;;
      un_nothing_thirdparty) _T="  O plugin da Circle ou do Arc Studio continua registrado; sem manifesto, o instalador não sabe\n  quem o adicionou, então ele é mantido. Remova-o você mesmo só se não quiser mais usá-lo." ;;
      un_incomplete) _T="stable-build: desinstalação incompleta; mantendo %s para você tentar de novo." ;;
      un_still_present) _T="  ainda presente: %s" ;;
      err_refuse_touch) _T="o instalador não mexe em '%s' (não há manifesto dentro)" ;;
      un_cfg_stripped) _T="  As configurações do stable-build foram removidas de %s e o arquivo foi mantido: ele guarda configurações que o stable-build não gravou." ;;
      un_kept_dir) _T="  %s foi mantido: ele guarda arquivos que o stable-build não gravou." ;;
      un_removed) _T="Removido. Verificado com %s: não sobrou nenhuma entrada do stable-build." ;;
      un_kept_preexisting) _T="  Mantidos (já existiam antes da instalação do stable-build): %s %s" ;;
      un_studio_signin) _T="  O login do Arc Studio não foi alterado: arc-studio logout não foi executado." ;;
      un_codex_trust) _T="  O Codex pode manter registros de confiança de hooks removidos (NÃO VERIFICADO); revise-os em /hooks." ;;
      un_reload) _T="  Em uma sessão do Claude Code já aberta, rode /reload-plugins." ;;
      *) return 1 ;;
    esac
  }

  SB_LANG=en
  msg() { # <id> [args]: the template for $SB_LANG (English when an id is missing), no newline
    local id=$1
    shift
    _T=''
    if [ "$SB_LANG" = pt-BR ]; then _msg_pt "$id" || _msg_en "$id" || _T="[$id]"
    else _msg_en "$id" || _T="[$id]"; fi
    # shellcheck disable=SC2059 # the template is the format
    printf -- "$_T" "$@"
  }

  # ------------------------------------------------------------------ output helpers
  say() { printf '%s\n' "$*"; }                       # text that is not prose (commands, blank lines)
  say_t() { msg "$@"; printf '\n'; }                  # message id + args
  err_t() { { msg "$@"; printf '\n'; } >&2; }
  warn_t() { { msg pfx_warn; msg "$@"; printf '\n'; } >&2; }
  die_t() { { msg pfx_error; msg "$@"; printf '\n'; fail_tail; } >&2; exit 1; }
  # after a failed command (without --verbose): the end of its output and where the full log is
  fail_tail() {
    if [ "${MUT_FAILED:-0}" = 1 ] && [ "${VERBOSE:-0}" != 1 ] && [ -s "${SB_WORK:-/nonexistent}/last.out" ]; then
      tail -n 15 "$SB_WORK/last.out" | sed 's/^/    | /'
      msg fail_log "$(tilde "$LOG_FILE")"; printf '\n'
    fi
  }
  # section titles show only with --verbose, above the raw command output
  section() { if [ "$PHASE" = apply ] && [ "$VERBOSE" = 1 ]; then printf '\n'; msg "$@"; printf '\n'; fi; }
  line() { if [ "$PHASE" = plan ]; then printf '  %-8s %-38s %s\n' "$1" "$2" "$3"; fi; }
  # display form of a path: ~ for HOME (outside --prefix)
  # shellcheck disable=SC2088 # a literal ~ for display, never expanded
  tilde() { if [ -z "$PREFIX" ] && [ -n "${HOME:-}" ]; then case "$1" in "$HOME"/*) printf '~/%s' "${1#"$HOME"/}"; return ;; esac; fi; printf '%s' "$1"; }
  now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
  usage() { msg usage "$SB_VERSION" "$GH_SLUG" "$GH_SLUG" "$CIRCLE_REPO"; }

  # ------------------------------------------------------------------ language
  # "en" or "pt-BR" on stdout for an accepted spelling (case-insensitive, surrounding spaces, tabs
  # and newlines ignored, like prefs.mjs); status 1 otherwise.
  # tr runs in the C locale (ASCII only, same on every system), so "Ê" stays as typed; the last
  # pattern is "português" with a decomposed ê (e + U+0302), as some terminals send it.
  norm_lang() {
    local v
    v=$(printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]')
    v=${v#"${v%%[![:space:]]*}"}   # leading whitespace
    v=${v%"${v##*[![:space:]]}"}   # trailing whitespace
    case "$v" in
      en|english) printf 'en' ;;
      pt|pt-br|pt_br|portugues|português|portuguÊs|$'portugue\xcc\x82s') printf 'pt-BR' ;;
      *) return 1 ;;
    esac
  }
  # English is the default everywhere. Portuguese only when asked for: --lang, STABLE_BUILD_LANG,
  # the saved choice or the prompt. The locale (LANG, LC_ALL, LC_MESSAGES) is never read.
  DEFAULT_LANG=en
  # the language saved in <state dir>/config.json (else manifest.json), without needing node; the
  # JSON escapes \t \n \r \f become spaces, which norm_lang trims, as JSON.parse + prefs.mjs would
  read_saved_lang() {
    local f v
    for f in "$1/config.json" "$1/manifest.json"; do
      [ -f "$f" ] || continue
      v=$(sed -n 's/^.*"language"[[:space:]]*:[[:space:]]*"\([^"]*\)".*$/\1/p' "$f" 2>/dev/null | head -n 1 | sed 's/\\[tnrf]/ /g') || v=''
      if [ -n "$v" ] && v=$(norm_lang "$v"); then printf '%s' "$v"; return 0; fi
    done
    return 1
  }
  # the first prompt: a one-line banner, then a bilingual menu on the terminal. The choice is not
  # echoed: everything after it (the confirmation first) is already in that language.
  choose_lang() {
    local def=$DEFAULT_LANG defnum=1 ans tries=0 v
    say_t lang_banner "$SB_VERSION"
    while :; do
      msg lang_menu "$defnum" >/dev/tty
      IFS= read -r ans </dev/tty || ans=''
      case "$ans" in
        '') SB_LANG=$def; break ;;
        1) SB_LANG=en; break ;;
        2) SB_LANG=pt-BR; break ;;
      esac
      if v=$(norm_lang "$ans"); then SB_LANG=$v; break; fi
      tries=$((tries + 1))
      if [ "$tries" -ge 3 ]; then SB_LANG=$def; break; fi
      say_t lang_menu_retry >/dev/tty
    done
    LANG_SRC=prompt
  }
  lang_src_label() {
    case "$LANG_SRC" in
      flag) printf '%s' --lang ;;
      env) printf '%s' STABLE_BUILD_LANG ;;
      saved) msg lang_src_saved ;;
      prompt) msg lang_src_prompt ;;
      *) msg lang_src_default ;;
    esac
  }

  SB_LANG=$DEFAULT_LANG
  # --lang is read before the other arguments, so even their errors use it
  LANG_ARG=''; HAVE_LANG_ARG=0; LANG_SRC=''; _want=0
  for _a in "$@"; do
    if [ "$_want" = 1 ]; then LANG_ARG=$_a; HAVE_LANG_ARG=1; _want=0; continue; fi
    case "$_a" in
      --lang=*) LANG_ARG=${_a#--lang=}; HAVE_LANG_ARG=1 ;;
      --lang) _want=1 ;;
    esac
  done
  if [ "$_want" = 1 ] || { [ "$HAVE_LANG_ARG" = 1 ] && [ -z "$LANG_ARG" ]; }; then err_t err_lang_missing; exit 1; fi
  if [ "$HAVE_LANG_ARG" = 1 ]; then
    SB_LANG=$(norm_lang "$LANG_ARG") || { err_t err_lang_unknown "$LANG_ARG" "$LANG_ARG"; exit 1; }
    LANG_SRC=flag
  elif [ -n "${STABLE_BUILD_LANG:-}" ]; then
    SB_LANG=$(norm_lang "$STABLE_BUILD_LANG") || { err_t err_lang_env "$STABLE_BUILD_LANG" "$STABLE_BUILD_LANG"; exit 1; }
    LANG_SRC='env'
  fi

  # ------------------------------------------------------------------ arguments
  # A bad argument is reported after the saved language is read (below), so the error is in it.
  # After --help the loop still reads --prefix (it says where the saved language is) but ignores
  # anything else, so `--help --bogus` and `--help --prefix` without a value still print the help.
  MODE=install; YES=0; NO_HOOKS=0; NO_MCP=0; NO_STUDIO=0; NO_CIRCLE=0; DRY_RUN=0; SHOW_HELP=0
  NO_FOUNDRY=0; NO_LOGIN=0; VERBOSE=0
  PREFIX_ARG=''; REF_ARG=''; HAVE_PREFIX_ARG=0; HAVE_REF_ARG=0; MODE_SET=''; BAD_ARG=''; HAVE_BAD_ARG=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --prefix=*) PREFIX_ARG=${1#--prefix=}; HAVE_PREFIX_ARG=1 ;;
      --prefix) if [ $# -ge 2 ]; then PREFIX_ARG=$2; HAVE_PREFIX_ARG=1; shift; else [ "$SHOW_HELP" = 1 ] || HAVE_BAD_ARG=1; break; fi ;;
      --ref=*) REF_ARG=${1#--ref=}; HAVE_REF_ARG=1 ;;
      --ref) if [ $# -ge 2 ]; then REF_ARG=$2; HAVE_REF_ARG=1; shift; else [ "$SHOW_HELP" = 1 ] || HAVE_BAD_ARG=1; break; fi ;;
      --lang=*) ;;     # read above
      --lang) shift ;; # read above, with its value
      --update) MODE=update; MODE_SET="$MODE_SET u" ;;
      --uninstall) MODE=uninstall; MODE_SET="$MODE_SET x" ;;
      --yes|-y) YES=1 ;;
      --no-hooks) NO_HOOKS=1 ;;
      --no-mcp) NO_MCP=1 ;;
      --no-studio) NO_STUDIO=1 ;;
      --no-circle) NO_CIRCLE=1 ;;
      --no-foundry) NO_FOUNDRY=1 ;;
      --no-login) NO_LOGIN=1 ;;
      --verbose) VERBOSE=1 ;;
      --dry-run) DRY_RUN=1 ;;
      -h|--help) SHOW_HELP=1 ;;
      *) if [ "$HAVE_BAD_ARG" = 0 ] && [ "$SHOW_HELP" = 0 ]; then BAD_ARG=$1; HAVE_BAD_ARG=1; fi ;;
    esac
    shift
  done

  # A saved choice comes next (read-only: the state directory is not created for this).
  if [ -z "$LANG_SRC" ]; then
    if [ -n "$PREFIX_ARG" ]; then
      _g=$PREFIX_ARG
      case "$_g" in \~|\~/*) _g="${HOME:-}${_g#\~}" ;; esac
      _g="$_g/.stable-build"
    else
      _g="${STABLE_BUILD_HOME:-${HOME:-}/.stable-build}"
    fi
    if _v=$(read_saved_lang "$_g"); then SB_LANG=$_v; LANG_SRC=saved; fi
  fi
  if [ "$HAVE_BAD_ARG" = 1 ]; then
    # an unknown option, or --prefix/--ref without a value: the error, then the help
    if [ -n "$BAD_ARG" ]; then { msg err_unknown_option "$BAD_ARG"; printf '\n\n'; } >&2; fi
    usage >&2
    exit 1
  fi
  if [ "$SHOW_HELP" = 1 ]; then usage; exit 0; fi

  case "$MODE_SET" in *u*x*|*x*u*) die_t err_update_uninstall ;; esac
  if [ "$HAVE_PREFIX_ARG" = 1 ] && [ -z "$PREFIX_ARG" ]; then die_t err_prefix_empty; fi
  if [ "$HAVE_REF_ARG" = 1 ]; then
    case "$REF_ARG" in
      ''|-*|*[!A-Za-z0-9._/-]*) die_t err_ref_invalid ;;
    esac
  fi

  # ------------------------------------------------------------------ safety
  if [ "$(id -u)" = 0 ]; then
    die_t err_root
  fi
  if [ -z "$PREFIX_ARG" ] && [ -z "${HOME:-}" ]; then die_t err_home_unset; fi

  PREFIX=''
  CHILD_HOME=''
  if [ -n "$PREFIX_ARG" ]; then
    case "$PREFIX_ARG" in \~|\~/*) PREFIX_ARG="${HOME:-}${PREFIX_ARG#\~}" ;; esac
    if [ ! -d "$PREFIX_ARG" ] && [ "$DRY_RUN" = 0 ]; then
      mkdir -p -- "$PREFIX_ARG" || die_t err_prefix_mkdir "$PREFIX_ARG"
    fi
    if [ -d "$PREFIX_ARG" ]; then
      PREFIX=$(CDPATH='' cd -- "$PREFIX_ARG" && pwd -P)
    else
      case "$PREFIX_ARG" in /*) PREFIX=$PREFIX_ARG ;; *) PREFIX="$(pwd -P)/$PREFIX_ARG" ;; esac
    fi
    CHILD_HOME=$PREFIX
    SB_HOME="$PREFIX/.stable-build"
  else
    SB_HOME="${STABLE_BUILD_HOME:-$HOME/.stable-build}"
  fi
  MANIFEST="$SB_HOME/manifest.json"
  CONFIG="$SB_HOME/config.json"
  INSTALL_LOG="$SB_HOME/install.log"

  HAVE_TTY=0
  if [ "${STABLE_BUILD_NO_TTY:-}" != 1 ] && (exec </dev/tty) 2>/dev/null; then HAVE_TTY=1; fi
  AGENT_SESSION=0
  if [ -n "${CLAUDECODE:-}" ] || env | grep '^CODEX_' | grep -v '^CODEX_HOME=' >/dev/null 2>&1; then AGENT_SESSION=1; fi
  # In an agent session the terminal belongs to the agent's UI, so nobody can answer a prompt here.
  if [ "$AGENT_SESSION" = 1 ] && [ "$YES" != 1 ]; then HAVE_TTY=0; fi
  # A person can answer here: a terminal and no --yes. Only then is there a confirmation and an
  # Arc Studio sign-in; with --yes everything installs except the sign-in; with nobody to answer only
  # stable-build and stable-build-mcp install (nothing third-party without a person's yes).
  CAN_ANSWER=0
  if [ "$HAVE_TTY" = 1 ] && [ "$YES" != 1 ]; then CAN_ANSWER=1; fi

  # Language, last step: ask in a terminal (the first prompt, before any other output; Enter keeps
  # English); otherwise (no terminal, or --yes) English, without asking.
  if [ -z "$LANG_SRC" ]; then
    if [ "$HAVE_TTY" = 1 ] && [ "$YES" != 1 ]; then choose_lang
    else SB_LANG=$DEFAULT_LANG; LANG_SRC=default; fi
  fi

  SB_WORK=$(mktemp -d "${TMPDIR:-/tmp}/stable-build.XXXXXX") || die_t err_mktemp
  # Arc Foundry stages its binaries in a directory next to their final place (FOUNDRY_STAGE, set
  # only while it exists): a Ctrl+C or TERM in that window takes it out too, so nothing unrecorded
  # is left in ~/.local/bin.
  FOUNDRY_STAGE=''
  trap 'if [ -n "${FOUNDRY_STAGE:-}" ]; then rm -rf -- "$FOUNDRY_STAGE"; fi; rm -rf "$SB_WORK"' EXIT
  trap 'exit 130' INT TERM
  : >"$SB_WORK/facts"
  # Raw output of every command goes to a log: in the temporary directory until the run starts to
  # change things, then $SB_HOME/install.log (overwritten each run). --verbose also prints it.
  LOG_FILE="$SB_WORK/install.log"; : >"$LOG_FILE"
  MUT_FAILED=0
  # A dry run against a --prefix that does not exist yet probes an empty stand-in directory.
  if [ -n "$PREFIX" ] && [ ! -d "$PREFIX" ]; then CHILD_HOME="$SB_WORK/empty-home"; mkdir -p "$CHILD_HOME"; fi
  if [ -n "$PREFIX" ]; then NEUTRAL_DIR=$CHILD_HOME; else NEUTRAL_DIR=$HOME; fi
  [ -d "$NEUTRAL_DIR" ] || NEUTRAL_DIR=$SB_WORK

  # Run a host CLI from a neutral directory (no project-scope settings), with stdin closed and,
  # under --prefix, with every home-like variable pointed into the sandbox.
  host_run() {
    if [ -n "$PREFIX" ]; then
      (cd "$NEUTRAL_DIR" && exec env HOME="$CHILD_HOME" CLAUDE_CONFIG_DIR="$CHILD_HOME/.claude" \
        CODEX_HOME="$CHILD_HOME/.codex" STABLE_BUILD_HOME="$SB_HOME" "$@") </dev/null
    else
      (cd "$NEUTRAL_DIR" && exec "$@") </dev/null
    fi
  }

  # Mutating call: its command line and raw output go to the log (and, with --verbose, to the
  # screen, indented). Callers stop on failure or print one status line.
  mut() {
    local rc=0
    printf '$ %s\n' "$*" >>"$LOG_FILE"
    if [ "$VERBOSE" = 1 ]; then
      printf '    $ %s\n' "$*"
      host_run "$@" 2>&1 | tee -a "$LOG_FILE" | sed 's/^/      /' || rc=$?
    else
      host_run "$@" >"$SB_WORK/last.out" 2>&1 || rc=$?
      cat "$SB_WORK/last.out" >>"$LOG_FILE"
    fi
    if [ "$rc" = 0 ]; then MUT_FAILED=0; else MUT_FAILED=1; fi
    return "$rc"
  }
  # A read-only call whose output only the log needs.
  logged() { printf '$ %s\n' "$*" >>"$LOG_FILE"; host_run "$@" >>"$LOG_FILE" 2>&1; }

  # Prompt on /dev/tty. $1 question (message id), $2 default (Y|N), $3 answer under --yes (Y|N),
  # $4 answer when nobody can be asked (no terminal, or an agent session, without --yes; default $2).
  # Prompts that install or run third-party software pass N here: they need a person's yes.
  # $ASK_INDENT is the prompt's indent (none for the one confirmation).
  yn() { if [ "$1" = Y ]; then msg ans_yes; else msg ans_no; fi; }
  ASK_INDENT='  '
  # At the terminal, spaces around the answer are ignored and only an empty answer (Enter) takes the
  # default. Anything else that is not a yes or a no is asked again, and three of those, or the end of
  # input (Ctrl+D), count as no: a typo never counts as a yes.
  ask() {
    local question hint def=$2 yes_answer=$3 noterm=${4:-$2} answer='' tries=0
    question=$(msg "$1")
    if [ "$def" = Y ]; then hint=$(msg ask_hint_yes); else hint=$(msg ask_hint_no); fi
    if [ "$YES" = 1 ]; then
      printf '%s%s %s %s (--yes)\n' "$ASK_INDENT" "$question" "$hint" "$(yn "$yes_answer")"
      [ "$yes_answer" = Y ]
      return
    fi
    if [ "$HAVE_TTY" != 1 ]; then
      if [ "$noterm" = "$def" ]; then
        printf '%s%s %s %s %s\n' "$ASK_INDENT" "$question" "$hint" "$(yn "$def")" "$(msg ask_noterm_default)"
      else
        printf '%s%s %s %s %s\n' "$ASK_INDENT" "$question" "$hint" "$(yn "$noterm")" "$(msg ask_noterm_skipped)"
      fi
      [ "$noterm" = Y ]
      return
    fi
    while :; do
      printf '%s%s %s ' "$ASK_INDENT" "$question" "$hint" >/dev/tty
      if ! IFS= read -r answer </dev/tty; then
        if [ -z "$answer" ]; then printf '\n' >/dev/tty; return 1; fi
      fi
      answer=${answer#"${answer%%[![:space:]]*}"}   # leading whitespace
      answer=${answer%"${answer##*[![:space:]]}"}   # trailing whitespace
      case "$answer" in
        '') [ "$def" = Y ]; return ;;
        [YySs]|[Yy][Ee][Ss]|[Ss][Ii][Mm]) return 0 ;;
        [Nn]|[Nn][Oo]|[Nn][Aa][Oo]|[Nn]ão|[Nn]ÃO) return 1 ;;
      esac
      tries=$((tries + 1))
      if [ "$tries" -ge 3 ]; then return 1; fi
      say_t ask_retry >/dev/tty
    done
  }

  # $1 >= $2 for dotted numeric versions
  ver_ge() {
    local a=$1 b=$2 x y
    a=${a%%[-+ ]*}; b=${b%%[-+ ]*}
    for _ in 1 2 3 4; do
      x=${a%%.*}; y=${b%%.*}
      case "$x" in ''|*[!0-9]*) x=0 ;; esac
      case "$y" in ''|*[!0-9]*) y=0 ;; esac
      if [ "$x" -gt "$y" ]; then return 0; fi
      if [ "$x" -lt "$y" ]; then return 1; fi
      case "$a" in *.*) a=${a#*.} ;; *) a=0 ;; esac
      case "$b" in *.*) b=${b#*.} ;; *) b=0 ;; esac
    done
    return 0
  }

  is_local_source() { case "$1" in /*|./*|../*|.|..|\~|\~/*) return 0 ;; *) return 1 ;; esac; }
  abs_dir() {
    local p=$1
    case "$p" in \~|\~/*) p="${HOME:-}${p#\~}" ;; esac
    [ -d "$p" ] || die_t err_src_dir "$1"
    (CDPATH='' cd -- "$p" && pwd -P)
  }
  # single-quoted for display in a copy-pasteable command
  shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
  # Host commands printed as copy-paste hints: under --prefix they must target the sandbox too.
  HINT_ENV=''
  if [ -n "$PREFIX" ]; then
    HINT_ENV="HOME=$(shq "$PREFIX") CLAUDE_CONFIG_DIR=$(shq "$PREFIX/.claude") CODEX_HOME=$(shq "$PREFIX/.codex") "
  fi
  hint() { printf '%s%s' "$HINT_ENV" "$*"; }
  # rerunning the installer (it asks again and records what it adds, so --uninstall can remove it)
  RERUN_CMD="curl -fsSL $RAW_INSTALL | bash"
  if [ -n "$PREFIX" ]; then RERUN_CMD="$RERUN_CMD -s -- --prefix=$(shq "$PREFIX")"; fi

  # ------------------------------------------------------------------ preflight
  command -v node >/dev/null 2>&1 || die_t err_node_missing "$MIN_NODE"
  NODE_VER=$(node -p 'process.versions.node' 2>/dev/null) || die_t err_node_run
  ver_ge "$NODE_VER" "$MIN_NODE" || die_t err_node_old "$NODE_VER" "$MIN_NODE"
  HAS_GIT=0; if command -v git >/dev/null 2>&1; then HAS_GIT=1; fi

  # JSON is read and written by a small node helper (the manifest is written with JSON.stringify).
  printf 'const N = %s;\n' "{\"mkt\":\"$N_MKT\",\"plugin\":\"$N_PLUGIN\",\"pluginMcp\":\"$N_PLUGIN_MCP\",\"cCircleMkt\":\"$N_C_CIRCLE_MKT\",\"cCircle\":\"$N_C_CIRCLE\",\"xCircleMkt\":\"$N_X_CIRCLE_MKT\",\"xCircle\":\"$N_X_CIRCLE\",\"studioMkt\":\"$N_STUDIO_MKT\",\"studio\":\"$N_STUDIO\",\"product\":\"stable-build\"}" >"$SB_WORK/helper.cjs"
  read -r -d '' HELPER_JS <<'JS_EOF' || true
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const argv = process.argv.slice(2);
const op = argv.shift();
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };
// CLI output: a JSON document, possibly preceded by notice lines.
function parseOut(f) {
  const t = readText(f);
  if (t == null || !t.trim()) return null;
  try { return JSON.parse(t); } catch (e) { /* fall through */ }
  const lines = t.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i].trimStart()[0];
    if (c === '[' || c === '{') { try { return JSON.parse(lines.slice(i).join('\n')); } catch (e) { /* next */ } }
  }
  return null;
}
const sq = (v) => "'" + String(v == null ? '' : v).replace(/'/g, "'\\''") + "'";
const out = [];
const emit = (k, v) => out.push(k + '=' + sq(v));
const flag = (v) => (v ? '1' : '0');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, data, { mode: 0o644 });
  fs.renameSync(tmp, file);
}
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// config.json: a JSON object, or null when absent, or 'invalid'
function readConfig(f) {
  const t = readText(f);
  if (t == null) return null;
  try { const c = JSON.parse(t); return isObj(c) ? c : 'invalid'; } catch (e) { return 'invalid'; }
}
// keys stable-build writes in config.json (the installer and `guard.mjs --enable/--disable`)
const CONFIG_KEYS = ['schemaVersion', 'guard', 'consentAt', 'revokedAt', 'language'];
const configShapeOurs = (c) => c.schemaVersion === 1 && (typeof c.guard === 'boolean' || typeof c.language === 'string');
const isOursName = (n) => n === N.mkt || String(n).startsWith(N.mkt + '-');
const isOursPlugin = (id) => { const [name, mkt] = String(id).split('@'); return isOursName(name) || mkt === N.mkt; };

if (op === 'probe') {
  const [cmF, cpF, xmF, xpF, mfF, cfgF] = argv;
  // manifest
  let mf = null; const mt = readText(mfF);
  if (mt != null) { try { mf = JSON.parse(mt); } catch (e) { mf = 'invalid'; } }
  emit('MF_STATE', mf === null ? 'absent' : (mf === 'invalid' ? 'invalid' : 'ok'));
  const M = (mf && mf !== 'invalid') ? mf : {};
  const ours = (host, kind, key) => { const e = (((M.hosts || {})[host] || {})[kind] || {})[key]; return e ? e.addedByUs : undefined; };
  const f01 = (v) => (v === true ? '1' : '0');
  emit('MF_REF', M.ref || '');
  emit('MF_C_M_SB', f01(ours('claude', 'marketplaces', N.mkt)));
  emit('MF_C_M_CIRCLE', f01(ours('claude', 'marketplaces', N.cCircleMkt)));
  emit('MF_C_M_STUDIO', f01(ours('claude', 'marketplaces', N.studioMkt)));
  emit('MF_C_P_SB', f01(ours('claude', 'plugins', N.plugin)));
  emit('MF_C_P_SBMCP', f01(ours('claude', 'plugins', N.pluginMcp)));
  emit('MF_C_P_CIRCLE', f01(ours('claude', 'plugins', N.cCircle)));
  emit('MF_C_P_STUDIO', f01(ours('claude', 'plugins', N.studio)));
  emit('MF_X_M_SB', f01(ours('codex', 'marketplaces', N.mkt)));
  emit('MF_X_M_CIRCLE', f01(ours('codex', 'marketplaces', N.xCircleMkt)));
  emit('MF_X_P_SB', f01(ours('codex', 'plugins', N.plugin)));
  emit('MF_X_P_SBMCP', f01(ours('codex', 'plugins', N.pluginMcp)));
  emit('MF_X_P_CIRCLE', f01(ours('codex', 'plugins', N.xCircle)));
  emit('MF_CIRCLE_SKILLS', Array.isArray((M.circle || {}).skills) ? M.circle.skills.join(' ') : '');
  // pre-existing entries (recorded addedByUs:false) are never reported as leftovers
  const kept = (host, kind, key) => ours(host, kind, key) === false;

  // Claude Code: `claude plugin marketplace list --json` and `claude plugin list --json`
  const cm = parseOut(cmF);
  const cmArr = Array.isArray(cm) ? cm : [];
  emit('CM_OK', flag(Array.isArray(cm)));
  const cmFind = (n) => cmArr.find((m) => m && m.name === n);
  const csb = cmFind(N.mkt);
  emit('CM_SB', flag(csb));
  emit('CM_SB_REF', (csb && csb.ref) || '');
  emit('CM_SB_SRC', csb ? (csb.repo || csb.path || csb.url || csb.source || '') : '');
  const cci = cmFind(N.cCircleMkt);
  emit('CM_CIRCLE', flag(cci));
  emit('CM_CIRCLE_LOC', (cci && cci.installLocation) || '');
  const cst = cmFind(N.studioMkt);
  emit('CM_STUDIO', flag(cst));
  emit('CM_STUDIO_PATH', cst ? (cst.path || '') : '');
  const cp = parseOut(cpF);
  const cpArr = Array.isArray(cp) ? cp : [];
  emit('CP_OK', flag(Array.isArray(cp)));
  // user and managed installs count; project/local installs belong to some project
  const cpFind = (id) => cpArr.find((p) => p && p.id === id && (!p.scope || p.scope === 'user' || p.scope === 'managed'));
  const cpEmit = (k, id) => {
    const p = cpFind(id);
    emit('CP_' + k, flag(p));
    emit('CP_' + k + '_VER', (p && p.version) || '');
    emit('CP_' + k + '_PATH', (p && (p.installPath || p.readFromFolder)) || '');
    emit('CP_' + k + '_ERR', (p && Array.isArray(p.errors)) ? p.errors.join('; ') : '');
  };
  cpEmit('SB', N.plugin); cpEmit('SBMCP', N.pluginMcp); cpEmit('CIRCLE', N.cCircle); cpEmit('STUDIO', N.studio);
  const cLeft = [], cKept = [];
  for (const m of cmArr) if (m && isOursName(m.name)) (kept('claude', 'marketplaces', m.name) ? cKept : cLeft).push('marketplace:' + m.name);
  for (const p of cpArr) if (p && isOursPlugin(p.id) && (!p.scope || p.scope === 'user' || p.scope === 'managed')) (kept('claude', 'plugins', p.id) ? cKept : cLeft).push('plugin:' + p.id);
  emit('C_LEFT', cLeft.join(' ')); emit('C_KEPT', cKept.join(' '));

  // Codex: `codex plugin marketplace list --json` -> {marketplaces:[{name,root,marketplaceSource}]}
  //        `codex plugin list --json` -> {installed:[{pluginId,name,marketplaceName,version,...}]}
  const xm = parseOut(xmF);
  const xmArr = (xm && Array.isArray(xm.marketplaces)) ? xm.marketplaces : [];
  emit('XM_OK', flag(xm && Array.isArray(xm.marketplaces)));
  const xmFind = (n) => xmArr.find((m) => m && m.name === n);
  const xsb = xmFind(N.mkt);
  emit('XM_SB', flag(xsb));
  emit('XM_SB_SRC', (xsb && xsb.marketplaceSource && xsb.marketplaceSource.source) || '');
  const xci = xmFind(N.xCircleMkt);
  emit('XM_CIRCLE', flag(xci));
  emit('XM_CIRCLE_ROOT', (xci && xci.root) || '');
  const xp = parseOut(xpF);
  const xpArr = (xp && Array.isArray(xp.installed)) ? xp.installed : [];
  emit('XP_OK', flag(xp && Array.isArray(xp.installed)));
  const xpId = (p) => p.pluginId || (p.name + '@' + p.marketplaceName);
  const xpFind = (id) => xpArr.find((p) => p && p.installed !== false && xpId(p) === id);
  const xpEmit = (k, id) => { const p = xpFind(id); emit('XP_' + k, flag(p)); emit('XP_' + k + '_VER', (p && p.version) || ''); };
  xpEmit('SB', N.plugin); xpEmit('SBMCP', N.pluginMcp); xpEmit('CIRCLE', N.xCircle);
  const xLeft = [], xKept = [];
  for (const m of xmArr) if (m && isOursName(m.name)) (kept('codex', 'marketplaces', m.name) ? xKept : xLeft).push('marketplace:' + m.name);
  for (const p of xpArr) if (p && p.installed !== false && isOursPlugin(xpId(p))) (kept('codex', 'plugins', xpId(p)) ? xKept : xLeft).push('plugin:' + xpId(p));
  emit('X_LEFT', xLeft.join(' ')); emit('X_KEPT', xKept.join(' '));

  // config.json: guard consent and language. "guard" decides only when the key is there, so a
  // file that holds just a language still leaves the guard question open.
  const fileRec = ((M.files || {})['config.json']) || {};
  const created = fileRec.createdByUs === true;
  const c = readConfig(cfgF);
  let guard = '', cfgOurs = false, cfgLang = '', cfgState = 'absent';
  if (c === 'invalid') { guard = 'invalid'; cfgState = 'invalid'; }
  else if (c) {
    cfgState = 'ok';
    if ('guard' in c) guard = c.guard === true ? 'true' : 'false';
    if (typeof c.language === 'string') cfgLang = c.language;
    cfgOurs = created || configShapeOurs(c);
  }
  emit('CFG_STATE', cfgState); emit('CFG_GUARD', guard); emit('CFG_OURS', flag(cfgOurs)); emit('CFG_LANG', cfgLang);
  emit('MF_CFG_CREATED', flag(created)); emit('MF_CFG_LANG_ADDED', flag(fileRec.languageAddedByUs === true));
  // a guard "no" (at the prompt, or --no-hooks) is recorded so later runs neither ask nor turn it on
  const g = M.guard && typeof M.guard === 'object' ? M.guard : {};
  emit('MF_GUARD_DECLINED', typeof g.declinedAt === 'string' ? g.declinedAt : '');
  // tools outside the plugin CLIs: the Arc Studio CLI (npm) and Arc Foundry, with its PATH lines
  const tools = isObj(M.tools) ? M.tools : {};
  const sc = isObj(tools.arcStudioCli) ? tools.arcStudioCli : {};
  emit('MF_STUDIO_CLI', f01(sc.addedByUs)); emit('MF_STUDIO_CLI_PREFIX', typeof sc.prefix === 'string' ? sc.prefix : '');
  const fo = isObj(tools.arcFoundry) ? tools.arcFoundry : {};
  emit('MF_FOUNDRY', f01(fo.addedByUs)); emit('MF_FOUNDRY_TAG', fo.tag || ''); emit('MF_FOUNDRY_DIR', fo.binDir || '');
  emit('MF_FOUNDRY_MKBIN', f01(fo.createdBinDir)); emit('MF_FOUNDRY_MKLOCAL', f01(fo.createdLocalDir));
  // the sha256 of each binary as the installer wrote it: a file there that no longer matches is not ours
  const fsha = isObj(fo.sha256) ? fo.sha256 : {};
  const hex = (v) => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : '');
  emit('MF_FOUNDRY_SHA_FORGE', hex(fsha['arc-forge'])); emit('MF_FOUNDRY_SHA_CAST', hex(fsha['arc-cast'])); emit('MF_FOUNDRY_SHA_ANVIL', hex(fsha['arc-anvil']));
  const pl = isObj(fo.pathLine) ? fo.pathLine : {};
  emit('MF_RC', f01(pl.addedByUs)); emit('MF_RC_FILE', pl.file || '');
  emit('MF_RC_CREATED', f01(pl.createdFile)); emit('MF_RC_SEP', f01(pl.separatorAdded));
  process.stdout.write(out.join('\n') + '\n');
} else if (op === 'merge') {
  // facts: KIND<TAB>a/b/c<TAB>value. B = boolean ORed with the stored value (ownership flags are
  // never reset), F = boolean set, T = text, L = space-separated list, N = null.
  const [mfF, factsF, now, version, ref, prefix] = argv;
  let old = null;
  const t = readText(mfF);
  if (t != null) { try { old = JSON.parse(t); } catch (e) { old = null; } }
  const m = old ? JSON.parse(JSON.stringify(old)) : {
    schemaVersion: 1, product: N.product, version, ref, prefix: prefix || null,
    installedAt: now, updatedAt: now, hosts: {}, circle: {}, files: {}, guard: { enabled: false },
  };
  m.schemaVersion = 1; m.product = N.product; m.version = version; m.ref = ref; m.prefix = prefix || null;
  if (!m.installedAt) m.installedAt = now;
  for (const lineText of (readText(factsF) || '').split('\n')) {
    if (!lineText) continue;
    const parts = lineText.split('\t');
    const kind = parts[0]; const keys = parts[1].split('/'); const v = parts.slice(2).join('\t');
    const last = keys.pop();
    let o = m;
    for (const k of keys) { if (o[k] === null || typeof o[k] !== 'object' || Array.isArray(o[k])) o[k] = {}; o = o[k]; }
    if (kind === 'B') o[last] = o[last] === true || v === 'true';
    else if (kind === 'F') o[last] = v === 'true';
    else if (kind === 'T') o[last] = v;
    else if (kind === 'N') o[last] = null;
    else if (kind === 'L') o[last] = v ? v.split(' ').filter(Boolean) : [];
  }
  const strip = (x) => { const c = JSON.parse(JSON.stringify(x)); delete c.updatedAt; return JSON.stringify(c); };
  if (old && strip(old) === strip(m)) { process.stdout.write('same\n'); process.exit(0); }
  m.updatedAt = now;
  atomicWrite(mfF, JSON.stringify(m, null, 2) + '\n');
  process.stdout.write('changed\n');
} else if (op === 'set-language') {
  // "<created|added|changed> <sha256>", or "invalid" (file left untouched); other keys are kept
  const [cfgF, lang] = argv;
  const c = readConfig(cfgF);
  if (c === 'invalid') { process.stdout.write('invalid\n'); process.exit(0); }
  const kind = c === null ? 'created' : ('language' in c ? 'changed' : 'added');
  const next = c === null ? { schemaVersion: 1 } : c;
  next.language = lang;
  const data = JSON.stringify(next, null, 2) + '\n';
  atomicWrite(cfgF, data);
  process.stdout.write(kind + ' ' + sha256(data) + '\n');
} else if (op === 'write-config') {
  // guard consent: "<created|updated> <sha256>"; other keys (the language among them) are kept
  const [cfgF, now, lang] = argv;
  const c = readConfig(cfgF);
  if (c === 'invalid') process.exit(3); // the caller reports it (err_write), in the user's language
  const next = Object.assign({}, c || { schemaVersion: 1 }, { schemaVersion: 1, guard: true, consentAt: now });
  delete next.revokedAt;
  if (lang) next.language = lang;
  const data = JSON.stringify(next, null, 2) + '\n';
  atomicWrite(cfgF, data);
  process.stdout.write((c === null ? 'created' : 'updated') + ' ' + sha256(data) + '\n');
} else if (op === 'config-uninstall') {
  // removes config.json when stable-build owns it and nothing else is in it; otherwise removes only
  // the keys stable-build wrote. Prints removed | stripped | kept | absent.
  const [cfgF, created, langAdded] = argv;
  const c = readConfig(cfgF);
  let r = 'kept';
  if (c === null) r = 'absent';
  else if (c !== 'invalid') {
    if (created === '1' || configShapeOurs(c)) {
      if (Object.keys(c).every((k) => CONFIG_KEYS.includes(k))) { fs.unlinkSync(cfgF); r = 'removed'; }
      else { for (const k of CONFIG_KEYS) delete c[k]; atomicWrite(cfgF, JSON.stringify(c, null, 2) + '\n'); r = 'stripped'; }
    } else if (langAdded === '1' && 'language' in c) {
      delete c.language; atomicWrite(cfgF, JSON.stringify(c, null, 2) + '\n'); r = 'stripped';
    }
  }
  process.stdout.write(r + '\n');
} else if (op === 'tag') {
  // tag_name of a GitHub "latest release" response, or nothing
  const j = parseOut(argv[0]);
  process.stdout.write(j && typeof j.tag_name === 'string' ? j.tag_name : '');
} else if (op === 'rc-add') {
  // Appends the marker line and the PATH line to a shell rc file, unless the marker is there.
  // Bytes are kept as they are (latin1 maps each byte to one char). A file that does not end with a
  // newline gets one first, recorded so --uninstall can take it out again.
  // Prints present | "created 0" | "added <0|1>" (1: a separating newline was added) | failed.
  // "created" means nothing was at that path: a path that exists but cannot be read (a dangling
  // symlink, a directory) is "failed", so nothing is created at the far end of a link, and the
  // installer gives the PATH hint instead.
  const [f, marker, lineText] = argv;
  let t = null;
  let there = true;
  try { fs.lstatSync(f); } catch (e) { there = false; }
  try { t = fs.readFileSync(f, 'latin1'); } catch (e) { t = null; }
  if (there && t === null) { process.stdout.write('failed\n'); process.exit(0); }
  if (t !== null && t.split(/\r?\n/).includes(marker)) { process.stdout.write('present\n'); process.exit(0); }
  const sep = t !== null && t.length > 0 && !t.endsWith('\n');
  fs.appendFileSync(f, (sep ? '\n' : '') + marker + '\n' + lineText + '\n', { encoding: 'latin1', mode: 0o644 });
  process.stdout.write((t === null ? 'created 0' : 'added ' + (sep ? '1' : '0')) + '\n');
} else if (op === 'rc-has') {
  // "yes" when the rc file holds the marker line (the check rc-add makes), else "no"
  const [f, marker] = argv;
  let t = null;
  try { t = fs.readFileSync(f, 'latin1'); } catch (e) { t = null; }
  process.stdout.write((t !== null && t.split(/\r?\n/).includes(marker) ? 'yes' : 'no') + '\n');
} else if (op === 'rc-remove') {
  // Removes exactly the two lines rc-add wrote (the last such pair), and the newline it added
  // before them when they are still at the end; everything else stays byte for byte. A file the
  // installer created and that is then empty is deleted, unless the path is now a symlink (the
  // user's): then only the lines go. Prints removed | deleted | absent.
  const [f, marker, lineText, sepAdded, created] = argv;
  let t = null;
  try { t = fs.readFileSync(f, 'latin1'); } catch (e) { t = null; }
  const block = marker + '\n' + lineText + '\n';
  let i = t === null ? -1 : t.lastIndexOf(block);
  while (i > 0 && t[i - 1] !== '\n') i = t.lastIndexOf(block, i - 1);
  if (t === null || i < 0) { process.stdout.write('absent\n'); process.exit(0); }
  let start = i;
  if (sepAdded === '1' && i + block.length === t.length && i > 0 && t[i - 1] === '\n') start = i - 1;
  const rest = t.slice(0, start) + t.slice(i + block.length);
  let link = false;
  try { link = fs.lstatSync(f).isSymbolicLink(); } catch (e) { link = false; }
  if (created === '1' && rest === '' && !link) { fs.unlinkSync(f); process.stdout.write('deleted\n'); process.exit(0); }
  fs.writeFileSync(f, rest, 'latin1');
  process.stdout.write('removed\n');
} else {
  process.stderr.write('helper: unknown op ' + op + '\n');
  process.exit(2);
}
JS_EOF
  printf '%s\n' "$HELPER_JS" >>"$SB_WORK/helper.cjs"
  helper() { node "$SB_WORK/helper.cjs" "$@"; }

  # Host CLIs. The plugin subcommands are the only interface used to change host config.
  HAS_CLAUDE=0; CLAUDE_VER=''; HAS_CODEX=0; CODEX_VER=''; CODEX_SKIPPED=0
  if command -v claude >/dev/null 2>&1; then
    CLAUDE_VER=$(host_run claude --version 2>/dev/null | head -n 1) || CLAUDE_VER=''
    CLAUDE_VER=${CLAUDE_VER%% *}
    if [ -z "$CLAUDE_VER" ]; then
      warn_t warn_claude_version
    elif [ "$MODE" != uninstall ] && ! ver_ge "$CLAUDE_VER" "$MIN_CLAUDE"; then
      warn_t warn_claude_old "$CLAUDE_VER" "$MIN_CLAUDE"
    elif ! host_run claude plugin --help >/dev/null 2>&1; then
      warn_t warn_claude_noplugin "$CLAUDE_VER"
    else
      HAS_CLAUDE=1
    fi
  fi
  if command -v codex >/dev/null 2>&1; then
    CODEX_VER=$(host_run codex --version 2>/dev/null | head -n 1) || CODEX_VER=''
    CODEX_VER=${CODEX_VER##* }
    # `codex plugin` has add/list/remove and marketplace add/list/upgrade/remove (source; UNVERIFIED at runtime)
    if host_run codex plugin --help >/dev/null 2>&1; then
      HAS_CODEX=1
    else
      # an old Codex is a short suffix of the header line; the full warning shows with --verbose or --dry-run
      CODEX_SKIPPED=1
      if [ "$VERBOSE" = 1 ] || [ "$DRY_RUN" = 1 ]; then warn_t warn_codex_noplugin "${CODEX_VER:+ ($CODEX_VER)}"; fi
    fi
  fi
  # --uninstall with a manifest goes on without a host CLI: what the installer added outside the
  # plugin CLIs (Arc Foundry, its PATH lines, the npm package) can still go, and the host entries it
  # cannot remove are reported, so the run ends "incomplete" and keeps the manifest for a retry.
  if [ "$HAS_CLAUDE" = 0 ] && [ "$HAS_CODEX" = 0 ] && { [ "$MODE" != uninstall ] || [ ! -f "$MANIFEST" ]; }; then
    err_t err_no_host "$MIN_CLAUDE"
    exit 1
  fi
  if [ "$AGENT_SESSION" = 1 ]; then
    if [ "$YES" != 1 ]; then warn_t warn_agent_noyes; else warn_t warn_agent_yes; fi
  fi

  # ------------------------------------------------------------------ Arc Studio CLI and Arc Foundry (read-only checks)
  # npm under --prefix installs into the sandbox ($PREFIX/.npm-global), so nothing outside it is written.
  HAS_NPM=0; if command -v npm >/dev/null 2>&1; then HAS_NPM=1; fi
  NPM_SANDBOX=''
  if [ -n "$PREFIX" ]; then NPM_SANDBOX="$PREFIX/.npm-global"; fi
  npm_run() { # <host_run|mut|logged> <npm arguments>
    local how=$1
    shift
    if [ -n "$NPM_SANDBOX" ]; then "$how" env "npm_config_prefix=$NPM_SANDBOX" npm "$@"; else "$how" npm "$@"; fi
  }
  # The Arc Studio CLI: on PATH, else in $(npm prefix -g)/bin (npm's global bin is not always on PATH).
  STUDIO_BIN=''; NPM_GLOBAL_PREFIX=''; NPM_GLOBAL_BIN=''; STUDIO_SIGNED_IN=''
  npm_prefix_read() { # NPM_GLOBAL_PREFIX: where `npm install -g` puts packages (read once per run)
    local p=''
    if [ -n "$NPM_GLOBAL_PREFIX" ] || [ "$HAS_NPM" != 1 ]; then return 0; fi
    p=$(npm_run host_run prefix -g 2>/dev/null | head -n 1) || p=''
    NPM_GLOBAL_PREFIX=$p
    if [ -n "$p" ]; then NPM_GLOBAL_BIN="$p/bin"; fi
  }
  studio_find() {
    STUDIO_BIN=''
    if command -v arc-studio >/dev/null 2>&1; then STUDIO_BIN=arc-studio; return 0; fi
    [ "$HAS_NPM" = 1 ] || return 0
    npm_prefix_read
    if [ -n "$NPM_GLOBAL_PREFIX" ] && [ -x "$NPM_GLOBAL_PREFIX/bin/arc-studio" ]; then STUDIO_BIN="$NPM_GLOBAL_PREFIX/bin/arc-studio"; fi
  }
  # The CLI this installer added is in the npm prefix in use now. A node switch (nvm, fnm) changes
  # the prefix, and a copy found there is someone else's: --update leaves it alone. A manifest that
  # recorded no prefix counts as here.
  studio_cli_here() {
    npm_prefix_read
    [ -z "$MF_STUDIO_CLI_PREFIX" ] || [ "$MF_STUDIO_CLI_PREFIX" = "$NPM_GLOBAL_PREFIX" ]
  }
  studio_version() { host_run "$STUDIO_BIN" --version 2>/dev/null | head -n 1 || true; }
  # `arc-studio whoami` checks the stored sign-in over the network: exit 0 when signed in
  studio_whoami() { if logged "$STUDIO_BIN" whoami; then STUDIO_SIGNED_IN=1; else STUDIO_SIGNED_IN=0; fi; }

  # Arc Foundry goes to <home>/.local/bin (the sandbox under --prefix), as its install guide says.
  INSTALL_HOME=${PREFIX:-$HOME}
  FOUNDRY_BIN="$INSTALL_HOME/.local/bin"
  FOUNDRY_PRESENT=0; FOUNDRY_FOUND_AT=''; FOUNDRY_OFF_PATH=0; FOUNDRY_OS=''; FOUNDRY_ARCH=''; FOUNDRY_TARGET=''; FOUNDRY_RC=''; FOUNDRY_TAG=''
  foundry_detect() {
    local out='' f
    FOUNDRY_PRESENT=0; FOUNDRY_FOUND_AT=''; FOUNDRY_OFF_PATH=0
    if command -v arc-forge >/dev/null 2>&1; then
      FOUNDRY_PRESENT=1; FOUNDRY_FOUND_AT=$(command -v arc-forge)
    elif [ -e "$FOUNDRY_BIN/arc-forge" ] || [ -L "$FOUNDRY_BIN/arc-forge" ]; then
      # there, but `arc-forge` does not run by name: the status line says how it gets on PATH
      FOUNDRY_PRESENT=1; FOUNDRY_FOUND_AT="$FOUNDRY_BIN/arc-forge"; FOUNDRY_OFF_PATH=1
    fi
    FOUNDRY_OS=$(uname -s 2>/dev/null) || FOUNDRY_OS=''
    FOUNDRY_ARCH=$(uname -m 2>/dev/null) || FOUNDRY_ARCH=''
    # prebuilt archives exist for these targets only; Intel Macs, Windows and musl build from source
    case "$FOUNDRY_OS/$FOUNDRY_ARCH" in
      Darwin/arm64|Darwin/aarch64) FOUNDRY_TARGET=aarch64-apple-darwin ;;
      Linux/x86_64) FOUNDRY_TARGET=x86_64-unknown-linux-gnu ;;
      Linux/aarch64|Linux/arm64) FOUNDRY_TARGET=aarch64-unknown-linux-gnu ;;
      *) FOUNDRY_TARGET='' ;;
    esac
    if [ "$FOUNDRY_OS" = Linux ] && [ -n "$FOUNDRY_TARGET" ]; then
      if [ -e /etc/alpine-release ]; then FOUNDRY_TARGET=''
      elif command -v ldd >/dev/null 2>&1; then
        out=$(ldd --version 2>&1) || true
        case "$out" in *[Mm][Uu][Ss][Ll]*) FOUNDRY_TARGET='' ;; esac
      fi
    fi
    # the rc file that puts ~/.local/bin on PATH, when it is not there yet (none for other shells)
    FOUNDRY_RC=''
    case ":${PATH:-}:" in
      *":$FOUNDRY_BIN:"*|*":$FOUNDRY_BIN/:"*) ;;
      *)
        out=${SHELL:-}
        case "${out##*/}" in
          zsh) FOUNDRY_RC="$INSTALL_HOME/.zshrc" ;;
          bash)
            if [ "$FOUNDRY_OS" = Darwin ]; then
              # Terminal opens login shells, and a bash login shell reads only the first of these
              # that exists: a new ~/.bash_profile would hide an existing ~/.bash_login or ~/.profile
              FOUNDRY_RC="$INSTALL_HOME/.bash_profile"
              for f in .bash_profile .bash_login .profile; do
                if [ -e "$INSTALL_HOME/$f" ]; then FOUNDRY_RC="$INSTALL_HOME/$f"; break; fi
              done
            else
              FOUNDRY_RC="$INSTALL_HOME/.bashrc"
            fi
            ;;
        esac
        ;;
    esac
    # A dangling symlink (say ~/.zshrc -> a dotfiles file not there yet) is not edited: appending
    # would create a file at the far end of the link. The PATH hint is given instead.
    if [ -n "$FOUNDRY_RC" ] && [ -L "$FOUNDRY_RC" ] && [ ! -e "$FOUNDRY_RC" ]; then FOUNDRY_RC=''; fi
    # The manifest records one rc file. While the lines it recorded are still in another one (the
    # login shell changed since), that file stays the record and no second file is edited: the
    # confirmation and the status line give the PATH hint instead, and --uninstall still finds them.
    if [ -n "$FOUNDRY_RC" ] && [ "$MF_RC" = 1 ] && [ -n "$MF_RC_FILE" ] && [ "$MF_RC_FILE" != "$FOUNDRY_RC" ] \
      && [ "$(helper rc-has "$MF_RC_FILE" "$RC_MARKER" 2>/dev/null)" = yes ]; then
      FOUNDRY_RC=''
    fi
  }
  foundry_on_path() { case ":${PATH:-}:" in *":$FOUNDRY_BIN:"*|*":$FOUNDRY_BIN/:"*) return 0 ;; esac; return 1; }
  valid_tag() { # a release tag such as v0.8.0-2: ^v[0-9][0-9A-Za-z.+-]*$
    case "$1" in v[0-9]*) ;; *) return 1 ;; esac
    case "$1" in *[!0-9A-Za-z.+-]*) return 1 ;; esac
    return 0
  }
  foundry_env_tag() { if [ -n "${STABLE_BUILD_FOUNDRY_TAG:-}" ] && valid_tag "$STABLE_BUILD_FOUNDRY_TAG"; then printf '%s' "$STABLE_BUILD_FOUNDRY_TAG"; fi; }

  # ------------------------------------------------------------------ state probe (read-only)
  # Probe results, set by `eval` of the helper's output (defaults here keep set -u and readers honest).
  CFG_GUARD=''; CFG_OURS=0; CFG_STATE=absent; CFG_LANG=''; MF_CFG_CREATED=0; MF_CFG_LANG_ADDED=0
  MF_GUARD_DECLINED=''; CP_SBMCP_VER=''; XP_SBMCP_VER=''; CM_CIRCLE=0; CM_CIRCLE_LOC=''; CM_OK=0; CM_SB=0; CM_SB_REF=''; CM_SB_SRC=''
  CM_STUDIO=0; CM_STUDIO_PATH=''; CP_CIRCLE=0; CP_CIRCLE_PATH=''; CP_CIRCLE_VER=''; CP_OK=0; CP_SB=0
  CP_SBMCP=0; CP_SB_ERR=''; CP_SB_VER=''; CP_STUDIO=0; CP_STUDIO_VER=''; C_KEPT=''; C_LEFT=''
  MF_CIRCLE_SKILLS=''; MF_C_M_CIRCLE=0; MF_C_M_SB=0; MF_C_M_STUDIO=0; MF_C_P_CIRCLE=0; MF_C_P_SB=0
  MF_C_P_SBMCP=0; MF_C_P_STUDIO=0; MF_REF=''; MF_STATE=''; MF_X_M_CIRCLE=0; MF_X_M_SB=0
  MF_X_P_CIRCLE=0; MF_X_P_SB=0; MF_X_P_SBMCP=0; XM_CIRCLE=0; XM_CIRCLE_ROOT=''; XM_OK=0; XM_SB=0
  XP_CIRCLE=0; XP_CIRCLE_VER=''; XP_OK=0; XP_SB=0; XP_SBMCP=0; XP_SB_VER=''; X_KEPT=''; X_LEFT=''
  MF_STUDIO_CLI=0; MF_STUDIO_CLI_PREFIX=''; MF_FOUNDRY=0; MF_FOUNDRY_TAG=''; MF_FOUNDRY_DIR=''; MF_FOUNDRY_MKBIN=0; MF_FOUNDRY_MKLOCAL=0
  MF_FOUNDRY_SHA_FORGE=''; MF_FOUNDRY_SHA_CAST=''; MF_FOUNDRY_SHA_ANVIL=''
  MF_RC=0; MF_RC_FILE=''; MF_RC_CREATED=0; MF_RC_SEP=0

  probe() {
    local o
    : >"$SB_WORK/cm.json"; : >"$SB_WORK/cp.json"; : >"$SB_WORK/xm.json"; : >"$SB_WORK/xp.json"
    if [ "$HAS_CLAUDE" = 1 ]; then
      host_run claude plugin marketplace list --json >"$SB_WORK/cm.json" 2>"$SB_WORK/err" \
        || die_t err_cli_failed "claude plugin marketplace list --json" "$(head -c 400 "$SB_WORK/err")"
      host_run claude plugin list --json >"$SB_WORK/cp.json" 2>"$SB_WORK/err" \
        || die_t err_cli_failed "claude plugin list --json" "$(head -c 400 "$SB_WORK/err")"
    fi
    if [ "$HAS_CODEX" = 1 ]; then
      if ! host_run codex plugin marketplace list --json >"$SB_WORK/xm.json" 2>"$SB_WORK/err" \
        || ! host_run codex plugin list --json >"$SB_WORK/xp.json" 2>>"$SB_WORK/err"; then
        warn_t warn_codex_list_failed "$(head -c 400 "$SB_WORK/err")"
        HAS_CODEX=0; : >"$SB_WORK/xm.json"; : >"$SB_WORK/xp.json"
      fi
    fi
    o=$(helper probe "$SB_WORK/cm.json" "$SB_WORK/cp.json" "$SB_WORK/xm.json" "$SB_WORK/xp.json" "$MANIFEST" "$CONFIG") \
      || die_t err_internal_probe
    eval "$o"
    if [ "$HAS_CLAUDE" = 1 ] && { [ "$CM_OK" != 1 ] || [ "$CP_OK" != 1 ]; }; then
      die_t err_claude_parse "$CLAUDE_VER"
    fi
    if [ "$HAS_CODEX" = 1 ] && { [ "$XM_OK" != 1 ] || [ "$XP_OK" != 1 ]; }; then
      warn_t warn_codex_parse
      HAS_CODEX=0
      o=$(helper probe "$SB_WORK/cm.json" "$SB_WORK/cp.json" /dev/null /dev/null "$MANIFEST" "$CONFIG") || die_t err_internal
      eval "$o"
    fi
  }

  fact() { printf '%s\t%s\t%s\n' "$1" "$2" "${3-}" >>"$SB_WORK/facts"; }
  # merges the facts into the manifest and writes it (atomically) only when something changed
  save_manifest() {
    [ "$PHASE" = apply ] || return 0
    helper merge "$MANIFEST" "$SB_WORK/facts" "$(now)" "$SB_VERSION" "$REF" "$PREFIX" >/dev/null || die_t err_write "$MANIFEST"
  }
  # after a successful mutation: record ownership, persist, refresh state
  owned() { fact B "$1" true; save_manifest; probe; }

  PHASE=plan
  probe
  if [ "$MF_STATE" = invalid ]; then die_t err_manifest_invalid "$MANIFEST"; fi
  # versions before this run, for the "(was ...)" in the final summary
  OLD_CP_SB_VER=$CP_SB_VER; OLD_XP_SB_VER=$XP_SB_VER

  # ref: --ref, else the ref recorded at install time, else main
  if [ "$HAVE_REF_ARG" = 1 ]; then REF=$REF_ARG; elif [ -n "$MF_REF" ]; then REF=$MF_REF; else REF=main; fi
  REF_SWITCH=0
  if [ "$HAVE_REF_ARG" = 1 ] && [ -n "$MF_REF" ] && [ "$MF_REF" != "$REF" ]; then
    if [ "$MODE" = update ]; then REF_SWITCH=1
    elif [ "$MODE" = install ]; then
      warn_t warn_ref_recorded "$MF_REF" "$REF" "$MF_REF"
      REF=$MF_REF
    fi
  fi

  # sources
  SB_SRC_LOCAL=0
  if [ -n "${STABLE_BUILD_SOURCE:-}" ]; then
    if is_local_source "$STABLE_BUILD_SOURCE"; then
      SRC_SB_C=$(abs_dir "$STABLE_BUILD_SOURCE"); SRC_SB_X=$SRC_SB_C; SRC_SB_X_REF=''; SB_SRC_LOCAL=1
    else
      case "$STABLE_BUILD_SOURCE" in */*/*|*[!A-Za-z0-9._/-]*|-*) die_t err_source_env STABLE_BUILD_SOURCE ;; esac
      SRC_SB_C=$STABLE_BUILD_SOURCE; SRC_SB_X=$STABLE_BUILD_SOURCE; SRC_SB_X_REF=$REF
      if [ "$REF" != main ]; then SRC_SB_C="$STABLE_BUILD_SOURCE@$REF"; fi
    fi
  else
    SRC_SB_C=$GH_SLUG; SRC_SB_X=$GH_SLUG; SRC_SB_X_REF=$REF
    if [ "$REF" != main ]; then SRC_SB_C="$GH_SLUG@$REF"; fi
  fi
  if [ "$SB_SRC_LOCAL" = 1 ]; then REF_SWITCH=0; fi
  CIRCLE_DEFAULT_SRC=1
  if [ -n "${STABLE_BUILD_CIRCLE_SOURCE:-}" ]; then
    CIRCLE_DEFAULT_SRC=0
    if is_local_source "$STABLE_BUILD_CIRCLE_SOURCE"; then
      SRC_CIRCLE_C=$(abs_dir "$STABLE_BUILD_CIRCLE_SOURCE"); SRC_CIRCLE_X=$SRC_CIRCLE_C; SRC_CIRCLE_X_REF=''
    else
      case "$STABLE_BUILD_CIRCLE_SOURCE" in */*/*|*[!A-Za-z0-9._/-]*|-*) die_t err_source_env STABLE_BUILD_CIRCLE_SOURCE ;; esac
      SRC_CIRCLE_C=$STABLE_BUILD_CIRCLE_SOURCE; SRC_CIRCLE_X=$STABLE_BUILD_CIRCLE_SOURCE; SRC_CIRCLE_X_REF=$CIRCLE_BRANCH
    fi
  else
    SRC_CIRCLE_C=$CIRCLE_REPO; SRC_CIRCLE_X=$CIRCLE_REPO; SRC_CIRCLE_X_REF=$CIRCLE_BRANCH
  fi

  codex_mkt_add() { # $1 source, $2 ref (may be empty)
    if [ -n "$2" ]; then mut codex plugin marketplace add "$1" --ref "$2"; else mut codex plugin marketplace add "$1"; fi
  }

  # user-scope MCP servers that would duplicate ours (checked once; read-only)
  MCP_C_USER=''; MCP_X_USER=''
  check_user_mcp() {
    local n
    if [ "$NO_MCP" = 1 ]; then return 0; fi
    if [ "$HAS_CLAUDE" = 1 ] && [ "$CP_SBMCP" != 1 ]; then
      for n in arc-docs circle; do
        if host_run claude mcp get "$n" >"$SB_WORK/mcp.txt" 2>&1 && grep -qi 'scope: *user' "$SB_WORK/mcp.txt"; then
          MCP_C_USER="${MCP_C_USER:+$MCP_C_USER, }$n"
        fi
      done
    fi
    # Our Codex MCP plugin carries arc-docs only. `codex mcp get` exit status: UNVERIFIED.
    if [ "$HAS_CODEX" = 1 ] && [ "$XP_SBMCP" != 1 ]; then
      if host_run codex mcp get arc-docs >/dev/null 2>&1; then MCP_X_USER=arc-docs; fi
    fi
  }

  list_skills() { # names of <dir>/*/SKILL.md
    local f d
    for f in "$1"/*/SKILL.md; do
      [ -f "$f" ] || continue
      d=${f%/SKILL.md}
      printf '%s ' "${d##*/}"
    done
  }
  # shellcheck disable=SC2086 # word splitting is the point
  count_words() { set -- $1; echo $#; }
  # skills whose frontmatter asks to trigger without the user mentioning Circle
  rescue_skills() {
    local f d r=''
    for f in "$1"/*/SKILL.md; do
      [ -f "$f" ] || continue
      if awk 'NR==1 { if ($0 !~ /^---/) exit; next } /^---/ { exit } { print }' "$f" | grep -qiE 'rescue|not mentioned'; then
        d=${f%/SKILL.md}; r="${r:+$r, }${d##*/}"
      fi
    done
    printf '%s' "$r"
  }
  git_sha() { # commit checked out at $1, if it is a git checkout
    if [ "$HAS_GIT" = 1 ] && [ -n "$1" ] && [ -e "$1/.git" ]; then
      git -C "$1" rev-parse HEAD 2>/dev/null || true
    fi
  }

  # ------------------------------------------------------------------ install steps
  # Each step prints plan lines (PHASE=plan) or performs and records actions (PHASE=apply).
  # Every mutation is guarded by a read-only check, so a rerun makes no mutating call.
  JUST_C_M_SB=0; JUST_C_P_SB=0; JUST_C_P_SBMCP=0; JUST_X_M_SB=0; JUST_X_P_SB=0; JUST_X_P_SBMCP=0
  CIRCLE_SKIPPED=0
  OLD_CIRCLE_SKILLS=$MF_CIRCLE_SKILLS

  # The language goes into config.json (other keys kept) and the manifest, first, so the plugin's
  # notices and skills follow it even if a later step stops.
  step_language() {
    local r
    if [ "$CFG_STATE" = invalid ]; then line "$(msg col_lang)" config.json "$(msg st_lang_invalid)"
    elif [ "$CFG_LANG" = "$SB_LANG" ]; then line "$(msg col_lang)" config.json "$(msg st_lang_same "$SB_LANG")"
    else line "$(msg col_lang)" config.json "$(msg st_lang_save "$SB_LANG")"; fi
    [ "$PHASE" = apply ] || return 0
    fact T language "$SB_LANG"
    if [ "$CFG_STATE" = invalid ]; then
      warn_t warn_cfg_lang_invalid "$CONFIG"
    elif [ "$CFG_LANG" != "$SB_LANG" ]; then
      r=$(helper set-language "$CONFIG" "$SB_LANG") || die_t err_write "$CONFIG"
      case "$r" in
        created\ *) fact B files/config.json/createdByUs true ;;
        added\ *) fact B files/config.json/languageAddedByUs true ;;
      esac
      fact T files/config.json/sha256 "${r#* }"
      CFG_LANG=$SB_LANG
    fi
    save_manifest
  }

  step_ref_switch() {
    [ "$REF_SWITCH" = 1 ] || return 0
    section sec_ref_switch "$MF_REF" "$REF"
    if [ "$HAS_CLAUDE" = 1 ] && [ "$CM_SB" = 1 ]; then
      if [ "$MF_C_M_SB" = 1 ]; then
        line claude "marketplace $N_MKT" "$(msg st_readd_as "$SRC_SB_C")"
        if [ "$PHASE" = apply ]; then
          mut claude plugin marketplace remove "$N_MKT" || die_t err_mkt_remove "$N_MKT"
          probe
          mut claude plugin marketplace add "$SRC_SB_C" --scope user || die_t err_mkt_add "$SRC_SB_C"
          JUST_C_M_SB=1; owned "hosts/claude/marketplaces/$N_MKT/addedByUs"
        fi
      else
        line claude "marketplace $N_MKT" "$(msg st_kept_foreign)"
      fi
    fi
    if [ "$HAS_CODEX" = 1 ] && [ "$XM_SB" = 1 ]; then
      if [ "$MF_X_M_SB" = 1 ]; then
        line codex "marketplace $N_MKT" "$(msg st_readd_ref "$REF")"
        if [ "$PHASE" = apply ]; then
          mut codex plugin marketplace remove "$N_MKT" || die_t err_xmkt_remove "$N_MKT"
          probe
          codex_mkt_add "$SRC_SB_X" "$SRC_SB_X_REF" || die_t err_xmkt_add "$SRC_SB_X"
          JUST_X_M_SB=1; owned "hosts/codex/marketplaces/$N_MKT/addedByUs"
        fi
      else
        line codex "marketplace $N_MKT" "$(msg st_kept_foreign)"
      fi
    fi
  }

  # Circle's skills: check that the plugin brought skills, record them, print one status line. Skills
  # written to trigger even when Circle is not mentioned (they can lead to paid services) are named
  # once in the closing lines.
  circle_verify() {
    local dir='' names n xdir xnames sha diff_add='' diff_del='' s detail
    if [ "$HAS_CLAUDE" = 1 ] && [ "$CP_CIRCLE" = 1 ]; then
      dir="$CP_CIRCLE_PATH/skills"
      if [ ! -d "$dir" ] && [ -n "$CM_CIRCLE_LOC" ]; then dir="$CM_CIRCLE_LOC/plugins/circle/skills"; fi
    elif [ "$HAS_CODEX" = 1 ] && [ "$XP_CIRCLE" = 1 ]; then
      dir="$XM_CIRCLE_ROOT/plugins/circle/skills"
    else
      return 0
    fi
    names=$(list_skills "$dir"); n=$(count_words "$names")
    if [ "$n" = 0 ]; then
      die_t err_circle_zero "$dir" "$ISSUES_URL"
    fi
    if [ "$HAS_CODEX" = 1 ] && [ "$XP_CIRCLE" = 1 ] && [ -n "$XM_CIRCLE_ROOT" ]; then
      xdir="$XM_CIRCLE_ROOT/plugins/circle/skills"; xnames=$(list_skills "$xdir")
      if [ "$(count_words "$xnames")" = 0 ]; then
        die_t err_circle_zero_codex "$xdir" "$ISSUES_URL"
      fi
    fi
    sha=''
    if [ "$HAS_CLAUDE" = 1 ] && [ "$CM_CIRCLE" = 1 ]; then sha=$(git_sha "$CM_CIRCLE_LOC"); fi
    if [ -z "$sha" ] && [ "$HAS_CODEX" = 1 ] && [ "$XM_CIRCLE" = 1 ]; then sha=$(git_sha "$XM_CIRCLE_ROOT"); fi
    if [ -z "$sha" ] && [ "$HAS_GIT" = 1 ] && [ "$CIRCLE_DEFAULT_SRC" = 1 ]; then
      sha=$(GIT_TERMINAL_PROMPT=0 git ls-remote "https://github.com/$CIRCLE_REPO.git" "refs/heads/$CIRCLE_BRANCH" 2>/dev/null | awk 'NR==1 { print $1 }') || sha=''
    fi
    names=${names% }
    fact T circle/repo "$CIRCLE_REPO"
    if [ -n "$sha" ]; then fact T circle/sha "$sha"; else fact N circle/sha; fi
    if [ -n "$CP_CIRCLE_VER" ]; then fact T circle/pluginVersion "$CP_CIRCLE_VER"; fi
    if [ -n "$CP_CIRCLE_VER" ]; then fact T "hosts/claude/plugins/$N_C_CIRCLE/version" "$CP_CIRCLE_VER"; fi
    if [ -n "$XP_CIRCLE_VER" ]; then fact T "hosts/codex/plugins/$N_X_CIRCLE/version" "$XP_CIRCLE_VER"; fi
    fact L circle/skills "$names"
    save_manifest
    detail=''
    if [ -n "$CP_CIRCLE_VER" ]; then detail="plugin $CP_CIRCLE_VER"; fi
    if [ -n "$sha" ]; then detail="${detail:+$detail, }$CIRCLE_REPO@$(printf '%s' "$sha" | cut -c1-7)"; fi
    say_t ok_circle "$n" "${detail:+ ($detail)}"
    if [ -n "$OLD_CIRCLE_SKILLS" ]; then
      for s in $names; do case " $OLD_CIRCLE_SKILLS " in *" $s "*) ;; *) diff_add="$diff_add +$s" ;; esac; done
      for s in $OLD_CIRCLE_SKILLS; do case " $names " in *" $s "*) ;; *) diff_del="$diff_del -$s" ;; esac; done
      if [ -n "$diff_add$diff_del" ]; then say_t circle_changed "$diff_add" "$diff_del"; fi
    fi
    CIRCLE_PAID=$(rescue_skills "$dir")
  }

  step_circle() {
    local need=0
    if [ "$NO_CIRCLE" = 1 ]; then
      line circle "-" "$(msg st_skipped_flag --no-circle)"
      if [ "$PHASE" = apply ]; then say_t skip_circle_flag; fi
      return 0
    fi
    if [ "$HAS_CLAUDE" = 1 ]; then
      if [ "$CM_CIRCLE" = 1 ]; then line claude "marketplace $N_C_CIRCLE_MKT" "$(msg st_present)"
      else line claude "marketplace $N_C_CIRCLE_MKT" "$(msg st_add_user "$SRC_CIRCLE_C")"; need=1; fi
      if [ "$CP_CIRCLE" = 1 ]; then line claude "plugin $N_C_CIRCLE" "$(msg st_present)${CP_CIRCLE_VER:+ ($CP_CIRCLE_VER)}"
      else line claude "plugin $N_C_CIRCLE" "$(msg st_install_ask)"; need=1; fi
    fi
    if [ "$HAS_CODEX" = 1 ]; then
      if [ "$XM_CIRCLE" = 1 ]; then line codex "marketplace $N_X_CIRCLE_MKT" "$(msg st_present)"
      else line codex "marketplace $N_X_CIRCLE_MKT" "$(msg st_add "$SRC_CIRCLE_X${SRC_CIRCLE_X_REF:+ --ref $SRC_CIRCLE_X_REF}")"; need=1; fi
      if [ "$XP_CIRCLE" = 1 ]; then line codex "plugin $N_X_CIRCLE" "$(msg st_present)"
      else line codex "plugin $N_X_CIRCLE" "$(msg st_add_ask)"; need=1; fi
    fi
    [ "$PHASE" = apply ] || return 0
    # Installing Circle's plugin accepts Circle's developer terms, so it needs a person's yes (the
    # confirmation lists the terms) or --yes. Without one, the closing hint names it.
    if [ "$need" = 1 ] && [ "$CONSENT" != 1 ]; then CIRCLE_SKIPPED=1; return 0; fi
    # --update with nothing to add reports Circle under "Updates" (circle_verify runs there)
    if [ "$need" = 1 ] || [ "$MODE" != update ]; then section sec_circle; fi
    if [ "$HAS_CLAUDE" = 1 ]; then
      if [ "$CM_CIRCLE" != 1 ]; then
        mut claude plugin marketplace add "$SRC_CIRCLE_C" --scope user || die_t err_circle_mkt
        owned "hosts/claude/marketplaces/$N_C_CIRCLE_MKT/addedByUs"
      else fact B "hosts/claude/marketplaces/$N_C_CIRCLE_MKT/addedByUs" false; fi
      if [ "$CP_CIRCLE" != 1 ]; then
        mut claude plugin install "$N_C_CIRCLE" || die_t err_install "$N_C_CIRCLE"
        owned "hosts/claude/plugins/$N_C_CIRCLE/addedByUs"
      else fact B "hosts/claude/plugins/$N_C_CIRCLE/addedByUs" false; fi
    fi
    if [ "$HAS_CODEX" = 1 ]; then
      if [ "$XM_CIRCLE" != 1 ]; then
        codex_mkt_add "$SRC_CIRCLE_X" "$SRC_CIRCLE_X_REF" || die_t err_circle_xmkt
        owned "hosts/codex/marketplaces/$N_X_CIRCLE_MKT/addedByUs"
      else fact B "hosts/codex/marketplaces/$N_X_CIRCLE_MKT/addedByUs" false; fi
      if [ "$XP_CIRCLE" != 1 ]; then
        mut codex plugin add "$N_X_CIRCLE" || die_t err_codex_add "$N_X_CIRCLE"
        owned "hosts/codex/plugins/$N_X_CIRCLE/addedByUs"
      else fact B "hosts/codex/plugins/$N_X_CIRCLE/addedByUs" false; fi
    fi
    save_manifest
    if [ "$MODE" != update ]; then circle_verify; fi
  }

  # " 0.1.0" for the stable-build plugin, or " 0.1.1 (was 0.1.0)" when this run changed it
  sb_ver_label() {
    if [ "$HAS_CLAUDE" = 1 ]; then ver_label "$CP_SB_VER" "$OLD_CP_SB_VER"; else ver_label "$XP_SB_VER" "$OLD_XP_SB_VER"; fi
  }

  step_ours() {
    if [ "$HAS_CLAUDE" = 1 ]; then
      if [ "$CM_SB" = 1 ]; then line claude "marketplace $N_MKT" "$(msg st_present) (${CM_SB_SRC:-?}${CM_SB_REF:+@$CM_SB_REF})"
      else line claude "marketplace $N_MKT" "$(msg st_add_user "$SRC_SB_C")"; fi
      if [ "$CP_SB" = 1 ]; then line claude "plugin $N_PLUGIN" "$(msg st_present)${CP_SB_VER:+ ($CP_SB_VER)}"
      else line claude "plugin $N_PLUGIN" "$(msg st_install)"; fi
    fi
    if [ "$HAS_CODEX" = 1 ]; then
      if [ "$XM_SB" = 1 ]; then line codex "marketplace $N_MKT" "$(msg st_present)"
      else line codex "marketplace $N_MKT" "$(msg st_add "$SRC_SB_X${SRC_SB_X_REF:+ --ref $SRC_SB_X_REF}")"; fi
      if [ "$XP_SB" = 1 ]; then line codex "plugin $N_PLUGIN" "$(msg st_present)"
      else line codex "plugin $N_PLUGIN" "$(msg st_add_plain)"; fi
    fi
    [ "$PHASE" = apply ] || return 0
    section sec_ours
    if [ "$HAS_CLAUDE" = 1 ]; then
      if [ "$CM_SB" != 1 ]; then
        mut claude plugin marketplace add "$SRC_SB_C" --scope user || die_t err_mkt_add "$SRC_SB_C"
        JUST_C_M_SB=1; owned "hosts/claude/marketplaces/$N_MKT/addedByUs"
      else fact B "hosts/claude/marketplaces/$N_MKT/addedByUs" false; fi
      if [ "$CP_SB" != 1 ]; then
        mut claude plugin install "$N_PLUGIN" || die_t err_install "$N_PLUGIN"
        JUST_C_P_SB=1; owned "hosts/claude/plugins/$N_PLUGIN/addedByUs"
      else fact B "hosts/claude/plugins/$N_PLUGIN/addedByUs" false; fi
      if [ -n "$CP_SB_VER" ]; then fact T "hosts/claude/plugins/$N_PLUGIN/version" "$CP_SB_VER"; fi
      if [ -n "$CP_SB_ERR" ]; then warn_t warn_load_errors "$N_PLUGIN" "$CP_SB_ERR"; fi
    fi
    if [ "$HAS_CODEX" = 1 ]; then
      if [ "$XM_SB" != 1 ]; then
        codex_mkt_add "$SRC_SB_X" "$SRC_SB_X_REF" || die_t err_xmkt_add "$SRC_SB_X"
        JUST_X_M_SB=1; owned "hosts/codex/marketplaces/$N_MKT/addedByUs"
      else fact B "hosts/codex/marketplaces/$N_MKT/addedByUs" false; fi
      if [ "$XP_SB" != 1 ]; then
        mut codex plugin add "$N_PLUGIN" || die_t err_codex_add "$N_PLUGIN"
        JUST_X_P_SB=1; owned "hosts/codex/plugins/$N_PLUGIN/addedByUs"
      else fact B "hosts/codex/plugins/$N_PLUGIN/addedByUs" false; fi
      if [ -n "$XP_SB_VER" ]; then fact T "hosts/codex/plugins/$N_PLUGIN/version" "$XP_SB_VER"; fi
    fi
    save_manifest
    # --update prints this line after the update, with the new version
    if [ "$MODE" != update ] || [ "$JUST_C_P_SB$JUST_X_P_SB" != 00 ]; then say_t ok_sb "$(sb_ver_label)"; fi
  }

  step_mcp() {
    local s servers='' sfx='' bad=''
    if [ "$NO_MCP" = 1 ]; then
      line mcp "-" "$(msg st_skipped_flag --no-mcp)"
      if [ "$PHASE" = apply ]; then say_t skip_mcp_flag; fi
      return 0
    fi
    if [ "$HAS_CLAUDE" = 1 ]; then
      if [ "$CP_SBMCP" = 1 ]; then line claude "plugin $N_PLUGIN_MCP" "$(msg st_present)"
      elif [ -n "$MCP_C_USER" ]; then line claude "plugin $N_PLUGIN_MCP" "$(msg st_mcp_user_skip "$MCP_C_USER")"
      else line claude "plugin $N_PLUGIN_MCP" "$(msg st_mcp_install)"; fi
    fi
    if [ "$HAS_CODEX" = 1 ]; then
      if [ "$XP_SBMCP" = 1 ]; then line codex "plugin $N_PLUGIN_MCP" "$(msg st_present)"
      elif [ -n "$MCP_X_USER" ]; then line codex "plugin $N_PLUGIN_MCP" "$(msg st_mcp_x_skip "$MCP_X_USER")"
      else line codex "plugin $N_PLUGIN_MCP" "$(msg st_mcp_x_add)"; fi
    fi
    [ "$PHASE" = apply ] || return 0
    section sec_mcp
    if [ "$HAS_CLAUDE" = 1 ]; then
      if [ "$CP_SBMCP" = 1 ]; then
        fact B "hosts/claude/plugins/$N_PLUGIN_MCP/addedByUs" false
        servers='arc-docs, circle-codegen'
      elif [ -n "$MCP_C_USER" ]; then
        say_t skip_mcp_user "$MCP_C_USER" "$N_PLUGIN_MCP"
      else
        mut claude plugin install "$N_PLUGIN_MCP" || die_t err_install "$N_PLUGIN_MCP"
        JUST_C_P_SBMCP=1; owned "hosts/claude/plugins/$N_PLUGIN_MCP/addedByUs"
        servers='arc-docs, circle-codegen'
        # health check, ours only: `claude mcp get <name>` connects to that one server (both accept
        # anonymous calls). `claude mcp list` is not used: it would start every server the user has.
        for s in arc-docs circle-codegen; do
          if host_run claude mcp get "plugin:stable-build-mcp:$s" >"$SB_WORK/mcpget.txt" 2>&1 \
            && grep -qi 'status:.*connected' "$SB_WORK/mcpget.txt"; then :
          else bad="$bad $s"; fi
        done
        if [ -z "$bad" ]; then sfx=$(msg mcp_connected); fi
      fi
      if [ "$CP_SBMCP" = 1 ] && [ -n "$CP_SBMCP_VER" ]; then fact T "hosts/claude/plugins/$N_PLUGIN_MCP/version" "$CP_SBMCP_VER"; fi
    fi
    if [ "$HAS_CODEX" = 1 ]; then
      if [ "$XP_SBMCP" = 1 ]; then
        fact B "hosts/codex/plugins/$N_PLUGIN_MCP/addedByUs" false
        servers=${servers:-arc-docs}
      elif [ -n "$MCP_X_USER" ]; then
        say_t skip_mcp_x_user "$MCP_X_USER" "$N_PLUGIN_MCP"
      else
        mut codex plugin add "$N_PLUGIN_MCP" || die_t err_codex_add "$N_PLUGIN_MCP"
        JUST_X_P_SBMCP=1; owned "hosts/codex/plugins/$N_PLUGIN_MCP/addedByUs"
        servers=${servers:-arc-docs}
      fi
      if [ "$XP_SBMCP" = 1 ] && [ -n "$XP_SBMCP_VER" ]; then fact T "hosts/codex/plugins/$N_PLUGIN_MCP/version" "$XP_SBMCP_VER"; fi
    fi
    save_manifest
    if [ -n "$servers" ]; then say_t ok_mcp "$servers" "$sfx"; fi
    for s in $bad; do warn_t warn_mcp_not_connected "$s" "$(hint claude mcp list)"; done
  }

  # The sign-in (device link: it opens the browser and waits for Authorize) runs only with a person
  # at the terminal, after their yes. It needs that terminal, so it does not go through host_run,
  # which closes stdin. Ctrl+C cancels only the sign-in: a trap handler is reset in the child.
  studio_signin() {
    if [ "$LOGIN_DECLINED" = 1 ]; then say_t studio_login_declined; return 0; fi
    if [ "$NO_LOGIN" = 1 ] || [ "$CAN_ANSWER" != 1 ]; then say_t studio_login_later; return 0; fi
    if [ -z "$STUDIO_SIGNED_IN" ]; then studio_whoami; fi
    if [ "$STUDIO_SIGNED_IN" = 1 ]; then say_t ok_signed_in; return 0; fi
    printf '$ %s login\n' "$STUDIO_BIN" >>"$LOG_FILE"
    trap ':' INT
    if [ -n "$PREFIX" ]; then
      # sandbox: HOME is the sandbox, and --paste stores the token in a file there, not the Keychain
      (cd "$NEUTRAL_DIR" && exec env HOME="$CHILD_HOME" CLAUDE_CONFIG_DIR="$CHILD_HOME/.claude" \
        CODEX_HOME="$CHILD_HOME/.codex" STABLE_BUILD_HOME="$SB_HOME" "$STUDIO_BIN" login --paste) </dev/tty >/dev/tty 2>&1 || true
    else
      "$STUDIO_BIN" login </dev/tty >/dev/tty 2>&1 || true
    fi
    trap 'exit 130' INT
    studio_whoami
    if [ "$STUDIO_SIGNED_IN" = 1 ]; then say_t ok_signed_in; else say_t fail_login; fi
  }

  # --update, after npm moved the CLI this installer added to its latest version: Claude Code runs its
  # own copy of the plugin, so the plugin this installer registered follows only after a marketplace
  # and a plugin update. Not fatal. A marketplace directory that is gone is repaired in step_update.
  studio_plugin_refresh() {
    if [ "$HAS_CLAUDE" != 1 ] || [ "$CP_STUDIO" != 1 ] || [ "$MF_C_P_STUDIO" != 1 ]; then return 0; fi
    if [ -z "$CM_STUDIO_PATH" ] || [ ! -d "$CM_STUDIO_PATH" ]; then return 0; fi
    if { [ "$MF_C_M_STUDIO" != 1 ] || mut claude plugin marketplace update "$N_STUDIO_MKT"; } \
      && mut claude plugin update "$N_STUDIO"; then
      probe
    else
      MUT_FAILED=0; say_t fail_studio_plugin_update "$(hint claude plugin update "$N_STUDIO")"
    fi
  }

  # Arc Studio: the CLI (npm), its Claude Code plugin (`arc-studio skills install`), then the sign-in.
  # npm and sign-in failures are not fatal: one line with a hint, and the run goes on.
  step_studio() {
    local had_mkt v='' old='' note=''
    if [ "$NO_STUDIO" = 1 ]; then
      line studio "-" "$(msg st_skipped_flag --no-studio)"
      if [ "$PHASE" = apply ]; then say_t skip_studio_flag; fi
      return 0
    fi
    if [ -n "$STUDIO_BIN" ]; then line studio "arc-studio CLI" "$(msg st_present)"
    elif [ "$HAS_NPM" = 1 ]; then line studio "arc-studio CLI" "$(msg st_studio_cli_install "$NPM_PKG")"
    else line studio "arc-studio CLI" "$(msg st_studio_cli_nonpm)"; fi
    if [ "$MODE" = update ] && [ "$MF_STUDIO_CLI" = 1 ] && [ -n "$STUDIO_BIN" ] && [ "$HAS_NPM" = 1 ] && studio_cli_here; then
      line studio "arc-studio CLI" "$(msg st_npm_update "$NPM_PKG")"
      if [ "$HAS_CLAUDE" = 1 ] && [ "$CP_STUDIO" = 1 ] && [ "$MF_C_P_STUDIO" = 1 ]; then
        line claude "plugin $N_STUDIO" "$(msg st_update_ours)"
      fi
    fi
    if [ "$HAS_CLAUDE" = 1 ] && { [ -n "$STUDIO_BIN" ] || [ "$HAS_NPM" = 1 ]; }; then
      if [ "$CP_STUDIO" = 1 ]; then line claude "plugin $N_STUDIO" "$(msg st_present)${CP_STUDIO_VER:+ ($CP_STUDIO_VER)}"
      else line claude "plugin $N_STUDIO" "$(msg st_studio_install_ask)"; fi
    fi
    if [ "$HAS_CODEX" = 1 ]; then line codex "arc-studio" "$(msg st_studio_codex)"; fi
    if [ -n "$STUDIO_BIN" ] || [ "$HAS_NPM" = 1 ]; then
      if [ "$NO_LOGIN" = 1 ]; then line studio "arc-studio login" "$(msg st_skipped_flag --no-login)"
      elif [ "$CAN_ANSWER" = 1 ]; then line studio "arc-studio login" "$(msg st_login_ask)"
      else line studio "arc-studio login" "$(msg st_login_later)"; fi
    fi
    [ "$PHASE" = apply ] || return 0
    # without a person's yes nothing of Arc Studio is installed; the closing hint names it
    if { [ "$NEED_STUDIO_CLI" = 1 ] || [ "$NEED_STUDIO_PLUGIN" = 1 ]; } && [ "$CONSENT" != 1 ]; then return 0; fi
    section sec_studio
    # 1. the CLI
    if [ -z "$STUDIO_BIN" ]; then
      if [ "$HAS_NPM" != 1 ]; then say_t skip_studio_nonpm "$NPM_PKG"; return 0; fi
      if ! npm_run mut install -g "$NPM_PKG@latest"; then
        say_t fail_npm "$NPM_PKG"; MUT_FAILED=0; return 0
      fi
      studio_find; npm_prefix_read
      if [ -z "$STUDIO_BIN" ]; then say_t fail_studio_missing "$(tilde "${NPM_GLOBAL_BIN:-?}")"; return 0; fi
      v=$(studio_version)
      # the npm prefix it went into, so --update and --uninstall act there and nowhere else
      fact B tools/arcStudioCli/addedByUs true; fact T tools/arcStudioCli/package "$NPM_PKG"
      if [ -n "$NPM_GLOBAL_PREFIX" ]; then fact T tools/arcStudioCli/prefix "$NPM_GLOBAL_PREFIX"; MF_STUDIO_CLI_PREFIX=$NPM_GLOBAL_PREFIX; fi
      if [ -n "$v" ]; then fact T tools/arcStudioCli/version "$v"; fi
      save_manifest
    elif [ "$MODE" = update ] && [ "$MF_STUDIO_CLI" = 1 ] && [ "$HAS_NPM" = 1 ] && studio_cli_here; then
      # --update: the CLI this installer added moves to npm's latest, then its Claude Code plugin
      old=$(studio_version)
      if npm_run mut install -g "$NPM_PKG@latest"; then
        studio_find
        v=$(studio_version)
        if [ -n "$v" ]; then fact T tools/arcStudioCli/version "$v"; fi
        save_manifest
        studio_plugin_refresh
      else
        say_t fail_npm "$NPM_PKG"; MUT_FAILED=0
        v=$old
      fi
      if [ -z "$STUDIO_BIN" ]; then return 0; fi
    else
      if [ "$MF_STUDIO_CLI" != 1 ]; then fact B tools/arcStudioCli/addedByUs false; fi
      v=$(studio_version)
    fi
    # 2. the Claude Code plugin; Circle's CLI runs `claude plugin marketplace add <its npm dir>` and
    #    `claude plugin install arc-studio@arc-studio-cli -y`
    if [ "$HAS_CLAUDE" = 1 ]; then
      if [ "$CP_STUDIO" = 1 ]; then
        fact B "hosts/claude/plugins/$N_STUDIO/addedByUs" false
        if [ "$CM_STUDIO" = 1 ]; then fact B "hosts/claude/marketplaces/$N_STUDIO_MKT/addedByUs" false; fi
      else
        had_mkt=$CM_STUDIO
        if ! mut "$STUDIO_BIN" skills install --tool claude-code; then
          # Circle's CLI adds its marketplace before it installs the plugin: what it added before it
          # failed is recorded as ours first, so --uninstall removes it before the npm package it
          # points into (and a rerun, which finds it there, keeps it recorded as ours)
          probe
          if [ "$had_mkt" != 1 ] && [ "$CM_STUDIO" = 1 ]; then fact B "hosts/claude/marketplaces/$N_STUDIO_MKT/addedByUs" true; fi
          if [ "$CP_STUDIO" = 1 ]; then fact B "hosts/claude/plugins/$N_STUDIO/addedByUs" true; fi
          save_manifest
          MUT_FAILED=1; die_t err_studio_install
        fi
        probe
        if [ "$CP_STUDIO" = 1 ]; then
          fact B "hosts/claude/plugins/$N_STUDIO/addedByUs" true
          if [ -n "$CP_STUDIO_VER" ]; then fact T "hosts/claude/plugins/$N_STUDIO/version" "$CP_STUDIO_VER"; fi
        else
          warn_t warn_studio_unlisted "$N_STUDIO"
        fi
        if [ "$CM_STUDIO" = 1 ]; then
          if [ "$had_mkt" = 1 ]; then fact B "hosts/claude/marketplaces/$N_STUDIO_MKT/addedByUs" false
          else fact B "hosts/claude/marketplaces/$N_STUDIO_MKT/addedByUs" true; fi
        fi
      fi
    fi
    save_manifest
    if [ "$HAS_CODEX" = 1 ]; then note=$(msg studio_codex_note); fi
    if [ "$HAS_CLAUDE" = 1 ] && [ "$CP_STUDIO" = 1 ]; then say_t ok_studio_cli_plugin "$(ver_label "$v" "$old")" "$note"
    else say_t ok_studio_cli "$(ver_label "$v" "$old")" "$note"; fi
    if [ "$STUDIO_BIN" != arc-studio ]; then say_t studio_not_on_path "$(tilde "${STUDIO_BIN%/*}")"; fi
    # 3. the sign-in
    studio_signin
  }

  # ------------------------------------------------------------------ Arc Foundry
  fetch() { # <url> <file>: a download with curl, logged
    local cmd="curl -fsSL --retry 2 -o $2 $1"
    printf '$ %s\n' "$cmd" >>"$LOG_FILE"
    if [ "$VERBOSE" = 1 ]; then printf '    $ %s\n' "$cmd"; fi
    curl -fsSL --retry 2 -o "$2" "$1" >>"$LOG_FILE" 2>&1
  }
  # Read from stdin: with a file name argument, shasum and sha256sum escape a name holding a
  # backslash or a newline and put a backslash before the digest.
  sha256_of() { # lowercase hex digest of a file
    local out
    if command -v shasum >/dev/null 2>&1; then out=$(shasum -a 256 <"$1") || return 1
    elif command -v sha256sum >/dev/null 2>&1; then out=$(sha256sum <"$1") || return 1
    else return 1; fi
    printf '%s' "${out%% *}" | LC_ALL=C tr '[:upper:]' '[:lower:]'
  }
  # FOUNDRY_TAG: STABLE_BUILD_FOUNDRY_TAG when it is a valid tag, else the latest release on GitHub
  foundry_resolve_tag() {
    local t=${STABLE_BUILD_FOUNDRY_TAG:-}
    FOUNDRY_TAG=''
    if [ -n "$t" ]; then
      if valid_tag "$t"; then FOUNDRY_TAG=$t; return 0; fi
      warn_t warn_foundry_tag_env "$t"
    fi
    fetch "$FOUNDRY_API" "$SB_WORK/foundry-latest.json" || return 1
    t=$(helper tag "$SB_WORK/foundry-latest.json" 2>>"$LOG_FILE") || return 1
    valid_tag "$t" || return 1
    FOUNDRY_TAG=$t
  }
  foundry_has_tools() { # <dir>: forge, cast and anvil there as regular files
    local t
    for t in forge cast anvil; do
      if [ ! -f "$1/$t" ] || [ -L "$1/$t" ]; then return 1; fi
    done
    return 0
  }
  # The sha256 the manifest records for arc-<forge|cast|anvil>, as this installer wrote it.
  foundry_sha_recorded() {
    case "$1" in
      forge) printf '%s' "$MF_FOUNDRY_SHA_FORGE" ;;
      cast) printf '%s' "$MF_FOUNDRY_SHA_CAST" ;;
      anvil) printf '%s' "$MF_FOUNDRY_SHA_ANVIL" ;;
    esac
  }
  foundry_sha_set() {
    case "$1" in
      forge) MF_FOUNDRY_SHA_FORGE=$2 ;;
      cast) MF_FOUNDRY_SHA_CAST=$2 ;;
      anvil) MF_FOUNDRY_SHA_ANVIL=$2 ;;
    esac
  }
  # <dir> <forge|cast|anvil>: <dir>/arc-<name> is still the file this installer wrote there: a regular
  # file (not a symlink) whose sha256 is the one the manifest recorded. A file put there since, such
  # as a build from source, is not ours: it is never overwritten or removed.
  foundry_file_ours() {
    local f="$1/arc-$2" want got
    if [ "$MF_FOUNDRY" != 1 ] || [ ! -f "$f" ] || [ -L "$f" ]; then return 1; fi
    want=$(foundry_sha_recorded "$2")
    if [ -z "$want" ]; then return 1; fi
    got=$(sha256_of "$f") || return 1
    [ "$got" = "$want" ]
  }
  foundry_ours() { [ "$MF_FOUNDRY_DIR" = "$FOUNDRY_BIN" ] && foundry_file_ours "$FOUNDRY_BIN" "$1"; }
  # takes out the binaries that are still the files this installer wrote (after a failed install)
  foundry_discard() {
    local t
    for t in forge cast anvil; do
      if foundry_ours "$t"; then rm -f -- "$FOUNDRY_BIN/arc-$t"; fi
    done
  }
  # Takes out the staging directory and, after a failure, the directories this run created for it:
  # <bin dir created now 0|1> <its parent created now 0|1>
  foundry_unstage() {
    if [ -n "$FOUNDRY_STAGE" ]; then rm -rf -- "$FOUNDRY_STAGE"; FOUNDRY_STAGE=''; fi
    if [ "$1" = 1 ]; then rmdir -- "$FOUNDRY_BIN" 2>/dev/null || true; fi
    if [ "$2" = 1 ]; then rmdir -- "${FOUNDRY_BIN%/bin}" 2>/dev/null || true; fi
  }
  # Puts the bin directory on PATH in new terminals: two marked lines in the rc file of the user's
  # shell (zsh: ~/.zshrc; bash on macOS: the first of ~/.bash_profile, ~/.bash_login and ~/.profile
  # that exists, else a new ~/.bash_profile; bash on Linux: ~/.bashrc), added once and recorded.
  # Other shells get a hint instead. Sets FOUNDRY_PATH_SFX for the status line.
  FOUNDRY_PATH_SFX=''
  foundry_path() {
    local r
    FOUNDRY_PATH_SFX=''
    if foundry_on_path; then return 0; fi
    r=failed
    if [ -n "$FOUNDRY_RC" ]; then r=$(helper rc-add "$FOUNDRY_RC" "$RC_MARKER" "$RC_LINE" 2>>"$LOG_FILE") || r=failed; fi
    case "$r" in
      created\ *|added\ *)
        # the flags describe the two lines just added to this file (set on every add, never carried
        # over from an earlier add), so --uninstall gives back exactly the bytes that were there
        fact B tools/arcFoundry/pathLine/addedByUs true; fact T tools/arcFoundry/pathLine/file "$FOUNDRY_RC"
        case "$r" in
          created\ *) fact F tools/arcFoundry/pathLine/createdFile true ;;
          *) fact F tools/arcFoundry/pathLine/createdFile false ;;
        esac
        case "$r" in
          *\ 1) fact F tools/arcFoundry/pathLine/separatorAdded true ;;
          *) fact F tools/arcFoundry/pathLine/separatorAdded false ;;
        esac
        FOUNDRY_PATH_SFX=$(msg foundry_path_rc "$(tilde "$FOUNDRY_RC")")
        ;;
      present) FOUNDRY_PATH_SFX=$(msg foundry_path_rc "$(tilde "$FOUNDRY_RC")") ;;
      *) FOUNDRY_PATH_SFX=$(msg foundry_path_hint "$(tilde "$FOUNDRY_BIN")" "$RC_LINE") ;;
    esac
  }
  # Download the release for this machine and its .sha256, verify, extract, check `arc-forge
  # --version`, then install as arc-forge, arc-cast and arc-anvil (0755), then PATH.
  # $1: the tag this replaces (--update), or empty. Every failure is one line; nothing is fatal, and
  # a failure before the renames leaves ~/.local/bin and the manifest as they were.
  foundry_install() {
    local old=$1 name dir src want got t stage mkbin=0 mklocal=0
    name="arc-foundry-$FOUNDRY_TAG-$FOUNDRY_TARGET.tar.gz"
    dir="$SB_WORK/foundry"
    rm -rf "$dir"; mkdir -p "$dir/x"
    if ! fetch "$FOUNDRY_DL/$FOUNDRY_TAG/$name" "$dir/$name" || ! fetch "$FOUNDRY_DL/$FOUNDRY_TAG/$name.sha256" "$dir/$name.sha256"; then
      rm -rf "$dir"; say_t fail_foundry_download "$name"; return 0
    fi
    # the .sha256 file holds "<64 hex>  <name>"; both digests are compared lowercased
    want=$(awk 'NR == 1 { print $1 }' "$dir/$name.sha256" | LC_ALL=C tr '[:upper:]' '[:lower:]') || want=''
    case "$want" in *[!0-9a-f]*) want='' ;; esac
    got=$(sha256_of "$dir/$name") || got=''
    if [ "${#want}" != 64 ] || [ "$got" != "$want" ]; then
      rm -rf "$dir"; say_t fail_foundry_sha; return 0
    fi
    if ! tar -xzf "$dir/$name" -C "$dir/x" >>"$LOG_FILE" 2>&1; then rm -rf "$dir"; say_t fail_foundry_archive; return 0; fi
    src=''
    for t in "$dir/x" "$dir/x"/*; do
      if [ -d "$t" ] && foundry_has_tools "$t"; then src=$t; break; fi
    done
    if [ -z "$src" ]; then rm -rf "$dir"; say_t fail_foundry_archive; return 0; fi
    # never overwrite a file that is not, byte for byte, the one this installer wrote there
    for t in forge cast anvil; do
      if { [ -e "$FOUNDRY_BIN/arc-$t" ] || [ -L "$FOUNDRY_BIN/arc-$t" ]; } && ! foundry_ours "$t"; then
        rm -rf "$dir"; say_t skip_foundry_foreign "$(tilde "$FOUNDRY_BIN/arc-$t")"; return 0
      fi
    done
    # directories it creates are recorded once the release is in place, so --uninstall can remove
    # them again when empty; after a failure they are taken out again
    if [ ! -d "$FOUNDRY_BIN" ]; then
      mkbin=1
      if [ ! -d "${FOUNDRY_BIN%/bin}" ]; then mklocal=1; fi
    fi
    # The three binaries are staged under their final names in a directory of their own next to
    # their final place (same file system, so the renames below are atomic). Nothing in the bin
    # directory changes until the release has passed its check.
    stage="$FOUNDRY_BIN/.stable-build-foundry-$$"
    if ! mkdir -p "$FOUNDRY_BIN" 2>>"$LOG_FILE" || ! mkdir "$stage" 2>>"$LOG_FILE"; then
      foundry_unstage "$mkbin" "$mklocal"; rm -rf "$dir"; say_t fail_foundry_copy "$(tilde "$FOUNDRY_BIN")"; return 0
    fi
    FOUNDRY_STAGE=$stage
    for t in forge cast anvil; do
      if ! { cp "$src/$t" "$stage/arc-$t" && chmod 0755 "$stage/arc-$t"; } 2>>"$LOG_FILE"; then
        foundry_unstage "$mkbin" "$mklocal"; rm -rf "$dir"; say_t fail_foundry_copy "$(tilde "$FOUNDRY_BIN")"; return 0
      fi
    done
    rm -rf "$dir"
    # The check the install guide asks for, run before anything is replaced: a release that does not
    # run on this machine (built for a newer glibc, say) changes nothing, so --update keeps the
    # release that works and a fresh install records nothing, and a rerun tries again.
    if ! host_run "$stage/arc-forge" --version >"$SB_WORK/forge-version" 2>>"$LOG_FILE"; then
      cat "$SB_WORK/forge-version" >>"$LOG_FILE"
      foundry_unstage "$mkbin" "$mklocal"; say_t fail_foundry_version "$(tilde "$LOG_FILE")"; return 0
    fi
    cat "$SB_WORK/forge-version" >>"$LOG_FILE"
    # recorded before they take their names, with each file's sha256, so later runs and --uninstall
    # can tell them from a file put there since
    fact B tools/arcFoundry/addedByUs true; fact T tools/arcFoundry/binDir "$FOUNDRY_BIN"
    fact T tools/arcFoundry/tag "$FOUNDRY_TAG"; fact T tools/arcFoundry/target "$FOUNDRY_TARGET"
    fact L tools/arcFoundry/binaries "arc-forge arc-cast arc-anvil"
    fact T tools/arcFoundry/version "$(head -n 1 "$SB_WORK/forge-version")"
    if [ "$mkbin" = 1 ]; then fact B tools/arcFoundry/createdBinDir true; fi
    if [ "$mklocal" = 1 ]; then fact B tools/arcFoundry/createdLocalDir true; fi
    for t in forge cast anvil; do
      got=$(sha256_of "$stage/arc-$t") || got=''
      fact T "tools/arcFoundry/sha256/arc-$t" "$got"; foundry_sha_set "$t" "$got"
    done
    save_manifest
    MF_FOUNDRY=1; MF_FOUNDRY_DIR=$FOUNDRY_BIN
    for t in forge cast anvil; do
      if ! mv -f "$stage/arc-$t" "$FOUNDRY_BIN/arc-$t" 2>>"$LOG_FILE"; then
        foundry_unstage 0 0; foundry_discard; say_t fail_foundry_copy "$(tilde "$FOUNDRY_BIN")"; return 0
      fi
    done
    foundry_unstage 0 0
    foundry_path
    save_manifest
    say_t ok_foundry "$(ver_label "$FOUNDRY_TAG" "$old")" "$FOUNDRY_PATH_SFX"
  }
  # The status line's PATH note for an Arc Foundry that is already in the bin directory but does not
  # run by name (FOUNDRY_OFF_PATH): new terminals get it from the rc file that holds the two lines,
  # else the export line to add. Nothing is edited here.
  foundry_path_note() {
    local f
    FOUNDRY_PATH_SFX=''
    [ "$FOUNDRY_OFF_PATH" = 1 ] || return 0
    for f in "$MF_RC_FILE" "$FOUNDRY_RC"; do
      if [ -n "$f" ] && [ "$(helper rc-has "$f" "$RC_MARKER" 2>/dev/null)" = yes ]; then
        FOUNDRY_PATH_SFX=$(msg foundry_path_rc "$(tilde "$f")"); return 0
      fi
    done
    FOUNDRY_PATH_SFX=$(msg foundry_path_hint "$(tilde "$FOUNDRY_BIN")" "$RC_LINE")
  }
  # --update: a newer release replaces the one this installer added
  foundry_update() {
    if [ -z "$FOUNDRY_TARGET" ]; then say_t ok_foundry " $MF_FOUNDRY_TAG" "$FOUNDRY_PATH_SFX"; return 0; fi
    if ! foundry_resolve_tag; then say_t fail_foundry_tag; return 0; fi
    if [ "$FOUNDRY_TAG" = "$MF_FOUNDRY_TAG" ]; then say_t ok_foundry " $MF_FOUNDRY_TAG" "$FOUNDRY_PATH_SFX"; return 0; fi
    foundry_install "$MF_FOUNDRY_TAG"
  }

  step_foundry() {
    local src
    if [ "$NO_FOUNDRY" = 1 ]; then
      line foundry "-" "$(msg st_skipped_flag --no-foundry)"
      if [ "$PHASE" = apply ]; then say_t skip_foundry_flag; fi
      return 0
    fi
    if [ "$FOUNDRY_PRESENT" = 1 ]; then
      line foundry "$(tilde "$FOUNDRY_FOUND_AT")" "$(msg st_present)"
      if [ "$MODE" = update ] && [ "$MF_FOUNDRY" = 1 ]; then line foundry "$(tilde "$MF_FOUNDRY_DIR")" "$(msg st_foundry_update)"; fi
    elif [ -z "$FOUNDRY_TARGET" ]; then
      line foundry "-" "$(msg st_foundry_target "$FOUNDRY_OS/$FOUNDRY_ARCH")"
    else
      if [ -n "$(foundry_env_tag)" ]; then src=$(msg st_foundry_tag_env "$(foundry_env_tag)"); else src=$(msg st_foundry_tag_latest); fi
      line foundry "$(tilde "$FOUNDRY_BIN")" "$(msg st_foundry_install "$FOUNDRY_TARGET" "$src")"
      if [ -n "$FOUNDRY_RC" ]; then line foundry "$(tilde "$FOUNDRY_RC")" "$(msg st_rc_add "$(tilde "$FOUNDRY_BIN")")"; fi
    fi
    [ "$PHASE" = apply ] || return 0
    section sec_foundry
    if [ "$FOUNDRY_PRESENT" = 1 ]; then
      foundry_path_note
      # ours only while arc-forge is still the file this installer wrote; one put there since is the user's
      if [ "$MF_FOUNDRY" = 1 ] && [ -n "$MF_FOUNDRY_TAG" ] && foundry_ours forge; then
        if [ "$MODE" = update ]; then foundry_update; else say_t ok_foundry " $MF_FOUNDRY_TAG" "$FOUNDRY_PATH_SFX"; fi
      else
        if [ "$MF_FOUNDRY" != 1 ]; then fact B tools/arcFoundry/addedByUs false; save_manifest; fi
        say_t ok_foundry_found "$(tilde "$FOUNDRY_FOUND_AT")" "$FOUNDRY_PATH_SFX"
      fi
      return 0
    fi
    # a download, a new command on PATH and an rc-file edit: only with a person's yes or --yes
    [ "$CONSENT" = 1 ] || return 0
    if [ -z "$FOUNDRY_TARGET" ]; then say_t skip_foundry_target "$FOUNDRY_OS/$FOUNDRY_ARCH" "$FOUNDRY_SRC_DOC"; return 0; fi
    if ! foundry_resolve_tag; then say_t fail_foundry_tag; return 0; fi
    foundry_install ''
  }

  step_update() {
    local id
    [ "$MODE" = update ] || return 0
    section sec_updates
    if [ "$HAS_CLAUDE" = 1 ]; then
      if [ "$CM_SB" = 1 ] && [ "$JUST_C_M_SB" != 1 ]; then
        line claude "marketplace $N_MKT" "$(msg st_update)"
        if [ "$PHASE" = apply ]; then mut claude plugin marketplace update "$N_MKT" || die_t err_mkt_update; fi
      fi
      if [ "$CP_SB" = 1 ] && [ "$JUST_C_P_SB" != 1 ]; then
        line claude "plugin $N_PLUGIN" "$(msg st_update)"
        if [ "$PHASE" = apply ]; then mut claude plugin update "$N_PLUGIN" || die_t err_plugin_update; fi
      fi
      if [ "$CP_SBMCP" = 1 ] && [ "$JUST_C_P_SBMCP" != 1 ]; then
        line claude "plugin $N_PLUGIN_MCP" "$(msg st_update)"
        if [ "$PHASE" = apply ]; then mut claude plugin update "$N_PLUGIN_MCP" || die_t err_plugin_update; fi
      fi
    fi
    if [ "$HAS_CODEX" = 1 ]; then
      if [ "$XM_SB" = 1 ] && [ "$JUST_X_M_SB" != 1 ]; then
        line codex "marketplace $N_MKT" "$(msg st_upgrade)"
        if [ "$PHASE" = apply ]; then mut codex plugin marketplace upgrade "$N_MKT" || die_t err_xmkt_upgrade; fi
      fi
      # Re-adding refreshes the installed copy; whether Codex refreshes it by itself is UNVERIFIED.
      for id in "$N_PLUGIN" "$N_PLUGIN_MCP"; do
        if [ "$id" = "$N_PLUGIN" ]; then
          { [ "$XP_SB" = 1 ] && [ "$JUST_X_P_SB" != 1 ]; } || continue
        else
          { [ "$XP_SBMCP" = 1 ] && [ "$JUST_X_P_SBMCP" != 1 ]; } || continue
        fi
        line codex "plugin $id" "$(msg st_readd)"
        if [ "$PHASE" = apply ]; then mut codex plugin add "$id" || die_t err_xplugin_readd; fi
      done
    fi
    # Circle: only when this installer added it
    if [ "$NO_CIRCLE" != 1 ] && [ "$CIRCLE_SKIPPED" != 1 ]; then
      if [ "$HAS_CLAUDE" = 1 ] && [ "$CP_CIRCLE" = 1 ] && { [ "$MF_C_M_CIRCLE" = 1 ] || [ "$MF_C_P_CIRCLE" = 1 ]; }; then
        line claude "plugin $N_C_CIRCLE" "$(msg st_update_ours)"
        if [ "$PHASE" = apply ]; then
          if [ "$CM_CIRCLE" = 1 ]; then mut claude plugin marketplace update "$N_C_CIRCLE_MKT" || die_t err_circle_mkt_update; fi
          mut claude plugin update "$N_C_CIRCLE" || die_t err_circle_update
        fi
      fi
      if [ "$HAS_CODEX" = 1 ] && [ "$XP_CIRCLE" = 1 ] && { [ "$MF_X_M_CIRCLE" = 1 ] || [ "$MF_X_P_CIRCLE" = 1 ]; }; then
        line codex "plugin $N_X_CIRCLE" "$(msg st_upgrade_readd_ours)"
        if [ "$PHASE" = apply ]; then
          if [ "$XM_CIRCLE" = 1 ]; then mut codex plugin marketplace upgrade "$N_X_CIRCLE_MKT" || die_t err_circle_xmkt_upgrade; fi
          mut codex plugin add "$N_X_CIRCLE" || die_t err_circle_xreadd
        fi
      fi
    fi
    if [ "$PHASE" = apply ]; then
      probe
      # step_ours left this line for after the update, so it shows the new version
      if [ "$JUST_C_P_SB$JUST_X_P_SB" = 00 ]; then say_t ok_sb "$(sb_ver_label)"; fi
      if [ "$NO_CIRCLE" != 1 ] && [ "$CIRCLE_SKIPPED" != 1 ]; then circle_verify; fi
    fi
    # Arc Studio: its marketplace is the npm package directory, which moves on npm upgrades or node
    # switches. Re-running `skills install` alone does not repair it, because `marketplace add` of
    # the new directory reports the existing name as already added; so the stale entry is removed
    # first, and only when this installer added it. Claude's handling of a vanished directory
    # marketplace is UNVERIFIED.
    if [ "$NO_STUDIO" != 1 ] && [ -n "$STUDIO_BIN" ] && [ "$HAS_CLAUDE" = 1 ] && [ "$MF_C_P_STUDIO" = 1 ] \
      && [ "$CM_STUDIO" = 1 ] && [ -n "$CM_STUDIO_PATH" ] && [ ! -d "$CM_STUDIO_PATH" ]; then
      if [ "$MF_C_M_STUDIO" = 1 ]; then
        line claude "plugin $N_STUDIO" "$(msg st_studio_reregister "$CM_STUDIO_PATH")"
        if [ "$PHASE" = apply ]; then
          mut claude plugin marketplace remove "$N_STUDIO_MKT" || die_t err_stale_mkt "$N_STUDIO_MKT"
          probe
          mut "$STUDIO_BIN" skills install --tool claude-code || die_t err_studio_install
          probe
          if [ "$CM_STUDIO" = 1 ]; then fact B "hosts/claude/marketplaces/$N_STUDIO_MKT/addedByUs" true; fi
          if [ "$CP_STUDIO" = 1 ]; then fact B "hosts/claude/plugins/$N_STUDIO/addedByUs" true; fi
          save_manifest
        fi
      else
        line claude "plugin $N_STUDIO" "$(msg st_studio_gone_foreign)"
        if [ "$PHASE" = apply ]; then
          warn_t warn_studio_gone "$N_STUDIO_MKT" "$CM_STUDIO_PATH" "$(hint claude plugin marketplace remove "$N_STUDIO_MKT")" "$(hint arc-studio skills install --tool claude-code)"
        fi
      fi
    fi
    if [ "$PHASE" = apply ]; then
      probe
      if [ "$HAS_CLAUDE" = 1 ] && [ -n "$CP_SB_VER" ]; then fact T "hosts/claude/plugins/$N_PLUGIN/version" "$CP_SB_VER"; fi
      if [ "$HAS_CLAUDE" = 1 ] && [ -n "$CP_STUDIO_VER" ] && [ "$CP_STUDIO" = 1 ]; then fact T "hosts/claude/plugins/$N_STUDIO/version" "$CP_STUDIO_VER"; fi
      if [ "$HAS_CODEX" = 1 ] && [ -n "$XP_SB_VER" ]; then fact T "hosts/codex/plugins/$N_PLUGIN/version" "$XP_SB_VER"; fi
      if [ "$HAS_CLAUDE" = 1 ] && [ "$CP_SBMCP" = 1 ] && [ -n "$CP_SBMCP_VER" ]; then fact T "hosts/claude/plugins/$N_PLUGIN_MCP/version" "$CP_SBMCP_VER"; fi
      if [ "$HAS_CODEX" = 1 ] && [ "$XP_SBMCP" = 1 ] && [ -n "$XP_SBMCP_VER" ]; then fact T "hosts/codex/plugins/$N_PLUGIN_MCP/version" "$XP_SBMCP_VER"; fi
      save_manifest
    fi
  }

  step_guard() {
    local r col
    col=$(msg col_guard)
    # An existing "guard" in config.json decides; then --no-hooks or an earlier "no" (both recorded
    # in the manifest, so they stick); --update never turns it on; otherwise it is part of the one
    # confirmation (or --yes). A config.json that only holds the language leaves it open.
    if [ "$CFG_GUARD" = true ]; then line "$col" config.json "$(msg st_guard_on)"
    elif [ "$CFG_GUARD" = false ]; then line "$col" config.json "$(msg st_guard_off_kept)"
    elif [ "$CFG_GUARD" = invalid ]; then line "$col" config.json "$(msg st_guard_invalid)"
    elif [ "$NO_HOOKS" = 1 ]; then line "$col" "-" "$(msg st_guard_nohooks)"
    elif [ -n "$MF_GUARD_DECLINED" ]; then line "$col" "-" "$(msg st_guard_declined)"
    elif [ "$MODE" = update ]; then line "$col" "-" "$(msg st_guard_update)"
    else line "$col" config.json "$(msg st_guard_ask)"; fi
    [ "$PHASE" = apply ] || return 0
    section sec_guard
    if [ "$CFG_GUARD" = true ]; then
      say_t guard_on_already
    elif [ "$CFG_GUARD" = false ]; then
      say_t guard_off_already
    elif [ "$CFG_GUARD" = invalid ]; then
      warn_t warn_cfg_invalid "$CONFIG"
    elif [ "$NO_HOOKS" = 1 ]; then
      say_t guard_nohooks
      if [ -z "$MF_GUARD_DECLINED" ]; then fact T guard/declinedAt "$(now)"; fi
    elif [ -n "$MF_GUARD_DECLINED" ]; then
      say_t guard_declined "$MF_GUARD_DECLINED"
    elif [ "$MODE" = update ]; then
      say_t guard_update
    elif [ "$CONSENT" = 1 ]; then
      r=$(helper write-config "$CONFIG" "$(now)" "$SB_LANG") || die_t err_write "$CONFIG"
      case "$r" in created\ *) fact B files/config.json/createdByUs true ;; esac
      fact T files/config.json/sha256 "${r#* }"
      CFG_GUARD=true
      say_t ok_guard_on
      if [ -z "$PREFIX" ] && [ "$SB_HOME" != "${HOME:-}/.stable-build" ]; then
        warn_t warn_sbhome_env "$SB_HOME"
      fi
    fi
    # without a person's yes the guard stays off (not recorded as declined); the closing hint says so
    if [ "$CFG_GUARD" = true ]; then fact F guard/enabled true; else fact F guard/enabled false; fi
    if [ "$CFG_GUARD" = true ] && [ "$HAS_CODEX" = 1 ] && [ "$XP_SB" = 1 ]; then
      say_t guard_codex_trust
      fact B hosts/codex/hooksTrustPrinted true
    fi
    save_manifest
  }

  # the full header: --dry-run and --verbose
  print_header() {
    local hosts dry='' mode
    if [ "$DRY_RUN" = 1 ]; then dry=$(msg hdr_dry); fi
    if [ "$HAS_CLAUDE" = 1 ]; then hosts="claude $CLAUDE_VER"; else hosts=$(msg hdr_claude_unused); fi
    if [ "$HAS_CODEX" = 1 ]; then hosts="$hosts, codex ${CODEX_VER:-?}"; else hosts="$hosts, $(msg hdr_codex_unused)"; fi
    case "$MODE" in
      update) mode=$(msg mode_update) ;;
      uninstall) mode=$(msg mode_uninstall) ;;
      *) mode=$(msg mode_install) ;;
    esac
    say_t hdr_title "$SB_VERSION" "$mode" "$dry"
    if [ -n "$PREFIX" ]; then say_t hdr_sandbox "$PREFIX"; fi
    say_t hdr_hosts "$hosts" "$NODE_VER"
    say_t hdr_state "$(tilde "$SB_HOME")"
    say_t hdr_lang "$SB_LANG" "$(lang_src_label)"
  }
  # one line: "stable-build 0.1.0 · Claude Code 2.1.293 · Node 26.9.0"
  print_short_header() {
    local parts='' mode=''
    if [ "$HAS_CLAUDE" = 1 ]; then parts="Claude Code $CLAUDE_VER"; fi
    if [ "$HAS_CODEX" = 1 ]; then parts="${parts:+$parts · }Codex ${CODEX_VER:-?}"; fi
    parts="${parts:+$parts · }Node $NODE_VER"
    if [ "$CODEX_SKIPPED" = 1 ]; then parts="$parts · $(msg hdr_codex_skipped)"; fi
    case "$MODE" in
      update) mode=" ($(msg mode_update))" ;;
      uninstall) mode=" ($(msg mode_uninstall))" ;;
    esac
    say_t hdr_short "$SB_VERSION" "$mode" "$parts"
  }

  # " 0.1.1", or " 0.1.1 (was 0.1.0)" when this run changed it; nothing when unknown
  ver_label() {
    if [ -z "$1" ]; then return 0; fi
    if [ -n "${2:-}" ] && [ "$2" != "$1" ]; then msg ver_was "$1" "$2"; else printf ' %s' "$1"; fi
  }

  # ------------------------------------------------------------------ what is missing, and the one question
  NEED_SB=0; NEED_MCP=0; NEED_MCP_C=0; NEED_CIRCLE=0; NEED_STUDIO_CLI=0; NEED_STUDIO_PLUGIN=0; NEED_LOGIN=0
  NEED_FOUNDRY=0; NEED_GUARD=0; NEED_ANY=0; NEED_ASK=0; NEED_LOGIN_ONLY=0; LOGIN_DECLINED=0; CONSENT=0; DECLINED=0; CIRCLE_PAID=''
  compute_needs() {
    if [ "$HAS_CLAUDE" = 1 ] && { [ "$CM_SB" != 1 ] || [ "$CP_SB" != 1 ]; }; then NEED_SB=1; fi
    if [ "$HAS_CODEX" = 1 ] && { [ "$XM_SB" != 1 ] || [ "$XP_SB" != 1 ]; }; then NEED_SB=1; fi
    if [ "$NO_MCP" != 1 ]; then
      if [ "$HAS_CLAUDE" = 1 ] && [ "$CP_SBMCP" != 1 ] && [ -z "$MCP_C_USER" ]; then NEED_MCP=1; NEED_MCP_C=1; fi
      if [ "$HAS_CODEX" = 1 ] && [ "$XP_SBMCP" != 1 ] && [ -z "$MCP_X_USER" ]; then NEED_MCP=1; fi
    fi
    if [ "$NO_CIRCLE" != 1 ]; then
      if [ "$HAS_CLAUDE" = 1 ] && { [ "$CM_CIRCLE" != 1 ] || [ "$CP_CIRCLE" != 1 ]; }; then NEED_CIRCLE=1; fi
      if [ "$HAS_CODEX" = 1 ] && { [ "$XM_CIRCLE" != 1 ] || [ "$XP_CIRCLE" != 1 ]; }; then NEED_CIRCLE=1; fi
    fi
    if [ "$NO_STUDIO" != 1 ]; then
      if [ -z "$STUDIO_BIN" ] && [ "$HAS_NPM" = 1 ]; then NEED_STUDIO_CLI=1; fi
      if [ "$HAS_CLAUDE" = 1 ] && [ "$CP_STUDIO" != 1 ] && { [ -n "$STUDIO_BIN" ] || [ "$NEED_STUDIO_CLI" = 1 ]; }; then NEED_STUDIO_PLUGIN=1; fi
      # the sign-in only where someone can do it; a CLI installed now is checked after the install
      if [ "$NO_LOGIN" != 1 ] && [ "$CAN_ANSWER" = 1 ]; then
        if [ "$NEED_STUDIO_CLI" = 1 ]; then NEED_LOGIN=1
        elif [ -n "$STUDIO_BIN" ]; then
          studio_whoami
          if [ "$STUDIO_SIGNED_IN" != 1 ]; then NEED_LOGIN=1; fi
        fi
      fi
    fi
    if [ "$NO_FOUNDRY" != 1 ] && [ "$FOUNDRY_PRESENT" != 1 ] && [ -n "$FOUNDRY_TARGET" ]; then NEED_FOUNDRY=1; fi
    if [ -z "$CFG_GUARD" ] && [ "$NO_HOOKS" != 1 ] && [ -z "$MF_GUARD_DECLINED" ] && [ "$MODE" != update ]; then NEED_GUARD=1; fi
    if [ "$NEED_SB$NEED_MCP$NEED_CIRCLE$NEED_STUDIO_CLI$NEED_STUDIO_PLUGIN$NEED_LOGIN$NEED_FOUNDRY$NEED_GUARD" != 00000000 ]; then
      NEED_ANY=1
    fi
    # What the one question is about. An install asks about everything missing. --update was asked
    # for already: stable-build and its MCP plugin are part of it (they install without a yes, as
    # with no terminal), so it asks only about what needs a person's yes, and a no skips just that.
    NEED_ASK=$NEED_ANY
    if [ "$MODE" = update ]; then
      NEED_ASK=0
      if [ "$NEED_CIRCLE$NEED_STUDIO_CLI$NEED_STUDIO_PLUGIN$NEED_LOGIN$NEED_FOUNDRY$NEED_GUARD" != 000000 ]; then NEED_ASK=1; fi
    fi
    # everything is in place but the sign-in (a rerun, or --update, after an install with --yes)
    if [ "$NEED_LOGIN" = 1 ] && [ "$NEED_CIRCLE$NEED_STUDIO_CLI$NEED_STUDIO_PLUGIN$NEED_FOUNDRY$NEED_GUARD" = 00000 ] \
      && { [ "$MODE" = update ] || [ "$NEED_SB$NEED_MCP" = 00 ]; }; then
      NEED_LOGIN_ONLY=1
    fi
  }
  # What is missing, as bullets, then "Continue? [Y/n]". A yes covers everything listed: Circle's
  # terms, the guard, the npm install, the download and the rc-file line.
  confirm_all() {
    local s='' ok=0 q=q_continue
    if [ "$MODE" = update ]; then
      # --update: the update itself needs no yes; the list holds only what is not set up yet
      say_t cf_title_update "$SB_VERSION"; q=q_add_too
    else
      if [ "$HAS_CLAUDE" = 1 ] && [ "$HAS_CODEX" = 1 ]; then say_t cf_title_cx "$SB_VERSION"
      elif [ "$HAS_CLAUDE" = 1 ]; then say_t cf_title_c "$SB_VERSION"
      else say_t cf_title_x "$SB_VERSION"; fi
      if [ "$NEED_SB" = 1 ] && [ "$NEED_GUARD" = 1 ]; then say_t cf_bullet "$(msg cf_sb_guard)"
      elif [ "$NEED_SB" = 1 ]; then say_t cf_bullet "$(msg cf_sb)"; fi
      if [ "$NEED_MCP_C" = 1 ]; then say_t cf_bullet "$(msg cf_mcp_c)"
      elif [ "$NEED_MCP" = 1 ]; then say_t cf_bullet "$(msg cf_mcp_x)"; fi
    fi
    if [ "$NEED_CIRCLE" = 1 ]; then say_t cf_bullet "$(msg cf_circle "$CIRCLE_TERMS")"; fi
    if [ "$NEED_STUDIO_CLI" = 1 ] && [ "$NEED_STUDIO_PLUGIN" = 1 ]; then s=$(msg cf_studio_cli_plugin)
    elif [ "$NEED_STUDIO_CLI" = 1 ]; then s=$(msg cf_studio_cli)
    elif [ "$NEED_STUDIO_PLUGIN" = 1 ]; then s=$(msg cf_studio_plugin); fi
    if [ "$NEED_LOGIN" = 1 ]; then
      if [ -n "$s" ]; then s="$s$(msg cf_studio_then_login)"; else s=$(msg cf_studio_login); fi
    fi
    if [ -n "$s" ]; then say_t cf_bullet "$s"; fi
    if [ "$NEED_FOUNDRY" = 1 ]; then
      if foundry_on_path; then say_t cf_bullet "$(msg cf_foundry "$(tilde "$FOUNDRY_BIN")")"
      elif [ -n "$FOUNDRY_RC" ]; then say_t cf_bullet "$(msg cf_foundry_rc "$(tilde "$FOUNDRY_BIN")" "$(tilde "$FOUNDRY_RC")")"
      else say_t cf_bullet "$(msg cf_foundry_nopath "$(tilde "$FOUNDRY_BIN")")"; fi
    fi
    if [ "$NEED_GUARD" = 1 ] && { [ "$NEED_SB" != 1 ] || [ "$MODE" = update ]; }; then say_t cf_bullet "$(msg cf_guard)"; fi
    ASK_INDENT=''
    if [ "$q" = q_add_too ]; then
      if ask q_add_too Y Y N; then ok=1; fi
    elif ask q_continue Y Y N; then ok=1; fi
    ASK_INDENT='  '
    [ "$ok" = 1 ]
  }
  # From here on the run changes things: the log moves to $SB_HOME/install.log.
  begin_log() {
    mkdir -p "$SB_HOME" 2>/dev/null || die_t err_write "$SB_HOME"
    cat "$LOG_FILE" >"$INSTALL_LOG" 2>/dev/null || die_t err_write "$INSTALL_LOG"
    LOG_FILE=$INSTALL_LOG
  }

  finish_install() {
    local host nt=''
    if [ "$HAS_CLAUDE" = 1 ]; then fact T hosts/claude/cli "$CLAUDE_VER"; fi
    if [ "$HAS_CODEX" = 1 ]; then fact T hosts/codex/cli "${CODEX_VER:-unknown}"; fi
    save_manifest
    # nobody could answer, or a person said no to what --update offered to add: one line names
    # what needs a person's yes, and how to add it
    if [ "$CONSENT" != 1 ]; then
      if [ "$NEED_CIRCLE" = 1 ]; then nt=$(msg nt_circle); fi
      if [ "$NEED_STUDIO_CLI" = 1 ] || [ "$NEED_STUDIO_PLUGIN" = 1 ]; then nt="${nt:+$nt, }Arc Studio"; fi
      if [ "$NEED_FOUNDRY" = 1 ]; then nt="${nt:+$nt, }Arc Foundry"; fi
      if [ "$NEED_GUARD" = 1 ]; then nt="${nt:+$nt, }$(msg nt_guard)"; fi
      if [ -n "$nt" ] && [ "$DECLINED" = 1 ]; then say_t nt_declined "$nt" "$RERUN_CMD"
      elif [ -n "$nt" ]; then say_t nt_hint "$nt" "$RERUN_CMD"; fi
    fi
    if [ "$HAS_CLAUDE" = 1 ] && [ "$HAS_CODEX" = 1 ]; then host=$(msg fin_host_both)
    elif [ "$HAS_CLAUDE" = 1 ]; then host='Claude Code'
    else host=Codex; fi
    say ""
    say_t fin_done "$host"
    say_t fin_next
    if [ "$HAS_CLAUDE" = 1 ]; then say_t fin_reload; fi
    if [ -n "$CIRCLE_PAID" ]; then say_t fin_circle_paid "$CIRCLE_PAID"; fi
    if [ -n "$PREFIX" ]; then
      say_t fin_sandbox \
        "HOME=\"$PREFIX\" CLAUDE_CONFIG_DIR=\"$PREFIX/.claude\" STABLE_BUILD_HOME=\"$SB_HOME\" claude" \
        "HOME=\"$PREFIX\" CODEX_HOME=\"$PREFIX/.codex\" STABLE_BUILD_HOME=\"$SB_HOME\" codex"
      say_t fin_update_remove_pfx "$(shq "$PREFIX")"
    else
      say_t fin_update_remove
    fi
    if [ "$VERBOSE" = 1 ]; then say_t fin_files "$(tilde "$MANIFEST")" "$(tilde "$LOG_FILE")"; fi
    say_t fin_community
  }

  run_install() {
    if [ "$PHASE" = plan ]; then print_header; say ""; say_t plan; fi
    step_language
    step_ref_switch
    step_circle
    step_ours
    step_mcp
    step_studio
    step_foundry
    step_update
    step_guard
    if [ "$PHASE" = plan ]; then
      if [ "$MF_STATE" = ok ]; then line "$(msg col_record)" manifest.json "$(msg st_mf_update)"
      else line "$(msg col_record)" manifest.json "$(msg st_mf_create)"; fi
    fi
  }

  # ------------------------------------------------------------------ uninstall
  manual_uninstall_help() {
    err_t un_no_manifest "$MANIFEST"
    err_t un_by_hand
    say "  $(hint claude plugin uninstall "$N_PLUGIN_MCP"); $(hint claude plugin uninstall "$N_PLUGIN")" >&2
    say "  $(hint claude plugin marketplace remove "$N_MKT")" >&2
    say "  $(hint codex plugin remove "$N_PLUGIN_MCP"); $(hint codex plugin remove "$N_PLUGIN"); $(hint codex plugin marketplace remove "$N_MKT")" >&2
    say "  rm -f \"$MANIFEST\" \"$CONFIG\" \"$INSTALL_LOG\"; rmdir \"$SB_HOME\"" >&2
    err_t un_separate "$N_C_CIRCLE" "$N_X_CIRCLE" "$N_STUDIO"
  }

  # "'claude plugin list' / 'codex plugin list'", naming only the hosts this run could list
  listed_hosts() {
    local r=''
    if [ "$HAS_CLAUDE" = 1 ]; then r="'claude plugin list'"; fi
    if [ "$HAS_CODEX" = 1 ]; then r="${r:+$r / }'codex plugin list'"; fi
    printf '%s' "$r"
  }

  # $1 host, $2 kind (plugin|marketplace), $3 id, $4 present (1/0), $5 ours (1/0), [$6 status]
  # prints the plan line; returns 0 when the entry should be removed
  rm_decide() {
    if [ "$4" != 1 ]; then line "$1" "$2 $3" "$(msg st_absent)"; return 1; fi
    if [ "$5" != 1 ]; then line "$1" "$2 $3" "$(msg st_keep_foreign)"; return 1; fi
    line "$1" "$2 $3" "${6:-$(msg st_remove)}"
    return 0
  }

  uninstall_steps() {
    local circle_ours=0 ask_first
    ask_first=$(msg st_remove_ask)
    if [ "$PHASE" = plan ]; then print_header; say ""; say_t plan; fi
    section sec_removing
    # 1. Codex
    if [ "$HAS_CODEX" = 1 ]; then
      if rm_decide codex plugin "$N_PLUGIN_MCP" "$XP_SBMCP" "$MF_X_P_SBMCP" && [ "$PHASE" = apply ]; then
        mut codex plugin remove "$N_PLUGIN_MCP" || die_t err_cmd_failed "codex plugin remove $N_PLUGIN_MCP"; probe; fi
      if rm_decide codex plugin "$N_PLUGIN" "$XP_SB" "$MF_X_P_SB" && [ "$PHASE" = apply ]; then
        mut codex plugin remove "$N_PLUGIN" || die_t err_cmd_failed "codex plugin remove $N_PLUGIN"; probe; fi
      if rm_decide codex marketplace "$N_MKT" "$XM_SB" "$MF_X_M_SB" && [ "$PHASE" = apply ]; then
        mut codex plugin marketplace remove "$N_MKT" || die_t err_cmd_failed "codex plugin marketplace remove $N_MKT"; probe; fi
    elif [ "$MF_X_M_SB$MF_X_P_SB$MF_X_P_SBMCP" != 000 ]; then
      line codex "-" "$(msg st_codex_unavailable)"
      UNINSTALL_BLOCKED=$(msg un_blocked_codex)
    fi
    # 2. Claude Code. `marketplace remove` runs without --scope: on 2.1.280 `--scope user` only drops
    #    the settings declaration and the marketplace stays listed (verified in a throwaway HOME).
    if [ "$HAS_CLAUDE" = 1 ]; then
      if rm_decide claude plugin "$N_PLUGIN_MCP" "$CP_SBMCP" "$MF_C_P_SBMCP" && [ "$PHASE" = apply ]; then
        mut claude plugin uninstall "$N_PLUGIN_MCP" || die_t err_cmd_failed "claude plugin uninstall $N_PLUGIN_MCP"; probe; fi
      if rm_decide claude plugin "$N_PLUGIN" "$CP_SB" "$MF_C_P_SB" && [ "$PHASE" = apply ]; then
        mut claude plugin uninstall "$N_PLUGIN" || die_t err_cmd_failed "claude plugin uninstall $N_PLUGIN"; probe; fi
      if rm_decide claude marketplace "$N_MKT" "$CM_SB" "$MF_C_M_SB" && [ "$PHASE" = apply ]; then
        mut claude plugin marketplace remove "$N_MKT" || die_t err_cmd_failed "claude plugin marketplace remove $N_MKT"; probe; fi
      # 3. Arc Studio (never `arc-studio logout`); --no-studio keeps it
      if [ "$NO_STUDIO" = 1 ]; then
        line claude "plugin $N_STUDIO" "$(msg st_keep_flag --no-studio)"
      else
        if rm_decide claude plugin "$N_STUDIO" "$CP_STUDIO" "$MF_C_P_STUDIO" && [ "$PHASE" = apply ]; then
          mut claude plugin uninstall "$N_STUDIO" || die_t err_cmd_failed "claude plugin uninstall $N_STUDIO"; probe
          say_t un_ok_studio_plugin; fi
        if rm_decide claude marketplace "$N_STUDIO_MKT" "$CM_STUDIO" "$MF_C_M_STUDIO" && [ "$PHASE" = apply ]; then
          mut claude plugin marketplace remove "$N_STUDIO_MKT" || die_t err_cmd_failed "claude plugin marketplace remove $N_STUDIO_MKT"; probe; fi
      fi
    elif [ "$MF_C_M_SB$MF_C_P_SB$MF_C_P_SBMCP$MF_C_P_STUDIO$MF_C_M_STUDIO" != 00000 ]; then
      line claude "-" "$(msg st_claude_unavailable)"
      UNINSTALL_BLOCKED=$(msg un_blocked_claude)
    fi
    # 4. the Arc Studio CLI, after its plugin: `npm uninstall -g`, only when this installer added it
    #    (--no-studio keeps it), in the npm prefix it went into, which a node switch (nvm, fnm) may
    #    have changed since: a copy in another prefix is someone else's. The sign-in is never
    #    touched: no `arc-studio logout`.
    if [ "$MF_STUDIO_CLI" = 1 ]; then
      if [ "$NO_STUDIO" = 1 ]; then
        line studio "$NPM_PKG" "$(msg st_keep_flag --no-studio)"
      elif [ "$HAS_CLAUDE" != 1 ] && [ "$MF_C_P_STUDIO$MF_C_M_STUDIO" != 00 ]; then
        # its Claude Code plugin and marketplace (a directory inside this package) were recorded but
        # could not be removed above: the package stays until a run with claude removes them first.
        # The run is already blocked (un_blocked_claude), so the manifest is kept for that retry.
        line studio "$NPM_PKG" "$(msg st_studio_cli_wait)"
        if [ "$PHASE" = apply ]; then say_t un_studio_cli_wait; fi
      elif [ -n "$MF_STUDIO_CLI_PREFIX" ] && [ ! -d "$MF_STUDIO_CLI_PREFIX/lib/node_modules/$NPM_PKG" ]; then
        line studio "$NPM_PKG" "$(msg st_studio_cli_gone "$(tilde "$MF_STUDIO_CLI_PREFIX")")"
        if [ "$PHASE" = apply ]; then say_t un_studio_cli_gone "$(tilde "$MF_STUDIO_CLI_PREFIX")"; fi
      elif [ "$HAS_NPM" != 1 ]; then
        line studio "$NPM_PKG" "$(msg st_npm_unavailable)"
        UNINSTALL_BLOCKED=$(msg un_blocked_npm "$NPM_PKG")
      else
        line studio "$NPM_PKG" "$(msg st_remove)"
        if [ "$PHASE" = apply ]; then
          if studio_cli_remove; then say_t un_ok_studio_cli "$NPM_PKG"
          else MUT_FAILED=0; UNINSTALL_BLOCKED=$(msg un_blocked_npm "$NPM_PKG"); fi
        fi
      fi
    fi
    # 5. Arc Foundry: the three binaries this installer added (only while each is still the file it
    #    wrote: a regular file with the recorded sha256) and its two PATH lines (the rest of the rc
    #    file stays byte for byte); --no-foundry keeps them
    if [ "$MF_FOUNDRY" = 1 ] && [ -n "$MF_FOUNDRY_DIR" ]; then
      if [ "$NO_FOUNDRY" = 1 ]; then
        line foundry "$(tilde "$MF_FOUNDRY_DIR")" "$(msg st_keep_flag --no-foundry)"
      else
        line foundry "$(tilde "$MF_FOUNDRY_DIR")" "$(msg st_remove)"
        if [ "$PHASE" = apply ]; then foundry_remove; fi
      fi
    fi
    if [ "$MF_RC" = 1 ] && [ -n "$MF_RC_FILE" ] && [ "$NO_FOUNDRY" != 1 ]; then
      line foundry "$(tilde "$MF_RC_FILE")" "$(msg st_rc_remove)"
      if [ "$PHASE" = apply ]; then rc_remove; fi
    fi
    # 6. Circle (asks; default yes when this installer added it); --no-circle keeps it
    if [ "$NO_CIRCLE" = 1 ]; then
      line circle "-" "$(msg st_keep_circle_flag)"
      line "$(msg col_remove)" "$(tilde "$SB_HOME")" "$(msg st_remove_state)"
      return 0
    fi
    if [ "$HAS_CLAUDE" = 1 ] && { { [ "$CP_CIRCLE" = 1 ] && [ "$MF_C_P_CIRCLE" = 1 ]; } || { [ "$CM_CIRCLE" = 1 ] && [ "$MF_C_M_CIRCLE" = 1 ]; }; }; then circle_ours=1; fi
    if [ "$HAS_CODEX" = 1 ] && { { [ "$XP_CIRCLE" = 1 ] && [ "$MF_X_P_CIRCLE" = 1 ]; } || { [ "$XM_CIRCLE" = 1 ] && [ "$MF_X_M_CIRCLE" = 1 ]; }; }; then circle_ours=1; fi
    if [ "$HAS_CLAUDE" = 1 ]; then
      rm_decide claude plugin "$N_C_CIRCLE" "$CP_CIRCLE" "$MF_C_P_CIRCLE" "$ask_first" || true
      rm_decide claude marketplace "$N_C_CIRCLE_MKT" "$CM_CIRCLE" "$MF_C_M_CIRCLE" "$ask_first" || true
    fi
    if [ "$HAS_CODEX" = 1 ]; then
      rm_decide codex plugin "$N_X_CIRCLE" "$XP_CIRCLE" "$MF_X_P_CIRCLE" "$ask_first" || true
      rm_decide codex marketplace "$N_X_CIRCLE_MKT" "$XM_CIRCLE" "$MF_X_M_CIRCLE" "$ask_first" || true
    fi
    if [ "$PHASE" = apply ] && [ "$circle_ours" = 1 ]; then
      if ask q_remove_circle Y Y; then
        if [ "$HAS_CODEX" = 1 ]; then
          if [ "$XP_CIRCLE" = 1 ] && [ "$MF_X_P_CIRCLE" = 1 ]; then mut codex plugin remove "$N_X_CIRCLE" || die_t err_cmd_failed "codex plugin remove $N_X_CIRCLE"; probe; fi
          if [ "$XM_CIRCLE" = 1 ] && [ "$MF_X_M_CIRCLE" = 1 ]; then mut codex plugin marketplace remove "$N_X_CIRCLE_MKT" || die_t err_cmd_failed "codex plugin marketplace remove $N_X_CIRCLE_MKT"; probe; fi
        fi
        if [ "$HAS_CLAUDE" = 1 ]; then
          if [ "$CP_CIRCLE" = 1 ] && [ "$MF_C_P_CIRCLE" = 1 ]; then mut claude plugin uninstall "$N_C_CIRCLE" || die_t err_cmd_failed "claude plugin uninstall $N_C_CIRCLE"; probe; fi
          if [ "$CM_CIRCLE" = 1 ] && [ "$MF_C_M_CIRCLE" = 1 ]; then mut claude plugin marketplace remove "$N_C_CIRCLE_MKT" || die_t err_cmd_failed "claude plugin marketplace remove $N_C_CIRCLE_MKT"; probe; fi
        fi
        say_t un_ok_circle
      else
        say_t un_keep_circle
      fi
    fi
    # 7. our state files (never anything else in that directory)
    line "$(msg col_remove)" "$(tilde "$SB_HOME")" "$(msg st_remove_state)"
  }
  studio_cli_remove() {
    if [ -n "$MF_STUDIO_CLI_PREFIX" ]; then mut env "npm_config_prefix=$MF_STUDIO_CLI_PREFIX" npm uninstall -g "$NPM_PKG"
    else npm_run mut uninstall -g "$NPM_PKG"; fi
  }
  foundry_remove() {
    local t f kept='' removed=0
    for t in forge cast anvil; do
      f="$MF_FOUNDRY_DIR/arc-$t"
      if foundry_file_ours "$MF_FOUNDRY_DIR" "$t"; then rm -f -- "$f"; removed=$((removed + 1))
      elif [ -e "$f" ] || [ -L "$f" ]; then kept="${kept:+$kept, }$(tilde "$f")"; fi
    done
    if [ "$MF_FOUNDRY_MKBIN" = 1 ]; then rmdir -- "$MF_FOUNDRY_DIR" 2>/dev/null || true; fi
    if [ "$MF_FOUNDRY_MKLOCAL" = 1 ]; then rmdir -- "${MF_FOUNDRY_DIR%/bin}" 2>/dev/null || true; fi
    # "removed" when it removed one, or when none is left; only the kept line when every one was kept
    if [ "$removed" -gt 0 ] || [ -z "$kept" ]; then say_t un_ok_foundry "$(tilde "$MF_FOUNDRY_DIR")"; fi
    if [ -n "$kept" ]; then say_t un_foundry_kept "$kept"; fi
  }
  rc_remove() {
    local r
    r=$(helper rc-remove "$MF_RC_FILE" "$RC_MARKER" "$RC_LINE" "$MF_RC_SEP" "$MF_RC_CREATED" 2>>"$LOG_FILE") || r=failed
    case "$r" in
      removed|deleted) say_t un_ok_rc "$(tilde "$MF_RC_FILE")" ;;
      absent) ;;
      *) UNINSTALL_BLOCKED=$(msg err_write "$MF_RC_FILE") ;;
    esac
  }

  run_uninstall() {
    local left f studio_ours=$MF_C_P_STUDIO cfg_r
    UNINSTALL_BLOCKED=''
    if [ "$MF_STATE" != ok ]; then
      # Already uninstalled (or never installed): no manifest, no stable-build entry listed, no consent file.
      if [ -z "$C_LEFT$X_LEFT" ] && [ "$CFG_OURS" != 1 ]; then
        say_t un_nothing "$(tilde "$MANIFEST")" "$(listed_hosts)"
        if [ "$CP_CIRCLE$CP_STUDIO$XP_CIRCLE" != 000 ]; then
          say_t un_nothing_thirdparty
        fi
        exit 0
      fi
      manual_uninstall_help; exit 1
    fi
    if [ "$DRY_RUN" = 1 ]; then PHASE=plan; uninstall_steps; say ""; say_t dry_done; exit 0; fi
    if [ "$VERBOSE" = 1 ]; then print_header; else print_short_header; fi
    begin_log
    PHASE=apply; uninstall_steps
    probe
    left=$(printf '%s %s' "${C_LEFT:+claude: $C_LEFT}" "${X_LEFT:+codex: $X_LEFT}")
    left=${left# }; left=${left% }
    if [ -n "$left" ] || [ -n "$UNINSTALL_BLOCKED" ]; then
      say "" >&2
      err_t un_incomplete "$MANIFEST"
      if [ -n "$left" ]; then err_t un_still_present "$left"; fi
      if [ -n "$UNINSTALL_BLOCKED" ]; then say "  $UNINSTALL_BLOCKED" >&2; fi
      exit 1
    fi
    # Remove only the files stable-build writes there (manifest, config.json, install.log and the
    # atomic-write temp files), then the directory if nothing else is in it. Never a recursive delete. config.json
    # goes when stable-build created it (or it is a stable-build file with only stable-build keys);
    # otherwise only the keys stable-build added are taken out of it.
    [ -f "$MANIFEST" ] || die_t err_refuse_touch "$SB_HOME"
    rm -f -- "$MANIFEST"
    cfg_r=$(helper config-uninstall "$CONFIG" "$MF_CFG_CREATED" "$MF_CFG_LANG_ADDED") || cfg_r=kept
    for f in "$SB_HOME"/manifest.json.tmp-* "$SB_HOME"/config.json.tmp-* "$SB_HOME"/.config.json.*.tmp "$INSTALL_LOG"; do
      if [ -f "$f" ]; then rm -f -- "$f"; fi
    done
    say ""
    if [ "$cfg_r" = stripped ]; then say_t un_cfg_stripped "$(tilde "$CONFIG")"; fi
    if rmdir -- "$SB_HOME" 2>/dev/null; then :; else
      say_t un_kept_dir "$(tilde "$SB_HOME")"
    fi
    say_t un_removed "$(listed_hosts)"
    if [ -n "$C_KEPT$X_KEPT" ]; then say_t un_kept_preexisting "$C_KEPT" "$X_KEPT"; fi
    if [ "$studio_ours" = 1 ] || [ "$MF_STUDIO_CLI" = 1 ]; then say_t un_studio_signin; fi
    if [ "$HAS_CODEX" = 1 ]; then say_t un_codex_trust; fi
    say_t un_reload
  }

  # ------------------------------------------------------------------ dispatch
  if [ "$MODE" = uninstall ]; then
    run_uninstall
    return 0
  fi
  if [ "$NO_STUDIO" != 1 ]; then studio_find; fi
  foundry_detect
  check_user_mcp
  if [ "$DRY_RUN" = 1 ]; then PHASE=plan; run_install; say ""; say_t dry_done; return 0; fi
  compute_needs
  if [ "$VERBOSE" = 1 ]; then print_header; else print_short_header; fi
  # Consent: --yes; or one yes from a person at the terminal to the list of what is missing (no
  # question when nothing is). On an install a "no" changes nothing. With nobody to answer, CONSENT
  # stays 0. When the sign-in is all that is missing, the one question is whether to sign in now, and
  # a "no" skips only the sign-in: the rest of the run (a rerun, the updates of --update) needs no yes.
  # On --update the question covers only what is not set up yet, and a "no" works as with no
  # terminal: CONSENT stays 0, those items (and the sign-in) are skipped, and the update goes on.
  if [ "$YES" = 1 ]; then CONSENT=1
  elif [ "$CAN_ANSWER" = 1 ]; then
    if [ "$NEED_LOGIN_ONLY" = 1 ]; then
      ASK_INDENT=''
      if ! ask q_signin Y Y N; then LOGIN_DECLINED=1; fi
      ASK_INDENT='  '
      CONSENT=1
    elif [ "$NEED_ASK" != 1 ] || confirm_all; then
      CONSENT=1
    elif [ "$MODE" = update ]; then
      DECLINED=1
      if [ "$NEED_LOGIN" = 1 ]; then LOGIN_DECLINED=1; fi
    else
      say_t cf_declined; return 0
    fi
  fi
  begin_log
  PHASE=apply
  run_install
  finish_install
}

{ main "$@"; }
