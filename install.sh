#!/usr/bin/env bash
# stable-build installer
#
# Registers the stable-build plugins (skills, edit-time guard hooks, MCP servers) for apps
# built on Arc with Claude Code and Codex through their own plugin CLIs. Optionally adds
# Circle's skills plugin and Arc Studio's Claude Code plugin. Everything it adds is recorded in
# ${STABLE_BUILD_HOME:-$HOME/.stable-build}/manifest.json, and --uninstall removes exactly that.
# It never edits settings.json, .claude.json, config.toml or hooks.json itself.
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
  CIRCLE_DISCLAIMER=https://github.com/circlefin/skills#disclaimer
  STUDIO_DOCS=https://docs.arc.io/ai/arc-studio-cli

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
      lang_chosen) _T="  Language: English (en)" ;;
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
      usage) _T="stable-build installer %s: skills, guard hooks and MCP servers for apps built on Arc,
for Claude Code and Codex. Community project, not affiliated with Circle.

Usage: install.sh [options]
  (no option)     install, or reconcile an existing install (safe to rerun)
  --update        update stable-build, plus Circle's and Arc Studio's plugins if this installer added them
  --uninstall     remove only what this installer added (reads \$STABLE_BUILD_HOME/manifest.json)
  --prefix=DIR    sandbox: every CLI call runs with HOME=DIR, so nothing outside DIR is written
  --yes           accept every prompt (Circle skills, Arc Studio plugin, guard on); no questions.
                  A guard you declined earlier stays off, and --update never turns the guard on.
  --no-hooks      leave the edit-time guard off and do not ask (now or on later runs)
  --no-mcp        skip the stable-build-mcp plugin (arc-docs and circle-codegen MCP servers)
  --no-studio     skip Arc Studio plugin registration
  --no-circle     skip Circle's skills plugin
  --dry-run       print the plan and change nothing
  --ref=REF       git ref of %s to install (default: main, which moves only at releases)
  --lang=LANG     language of this installer and of the kit's replies: en or pt-BR. Saved for
                  later runs; default: the saved choice, else asked in a terminal (Enter keeps
                  English), else English
  -h, --help      show this help

Environment:
  STABLE_BUILD_HOME          state directory (default: ~/.stable-build)
  STABLE_BUILD_LANG          language, like --lang (en or pt-BR)
  STABLE_BUILD_NO_TTY=1      never prompt; use each prompt's default (the guard stays off)
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
      warn_agent_noyes) _T="this looks like a Claude Code or Codex session, where nobody can answer a prompt: Circle's plugin and Arc Studio registration are skipped and the guard stays off. Rerun in a normal terminal (or with --yes once you have agreed) to add them. (Which CODEX_* variables Codex sets is UNVERIFIED.)" ;;
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
      # plan and header
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
      circle_src_default) _T="  Circle's skills come from Circle's own plugin (%s, Apache-2.0), fetched from GitHub now." ;;
      circle_src_custom) _T="  Circle's skills come from Circle's own plugin (Apache-2.0), here from %s." ;;
      circle_disclaimer) _T="  Circle's disclaimer: outputs may contain errors, omissions, outdated information or fee\n  configuration options, including options that direct fees to Circle Technology Services, LLC.\n  You are responsible for reviewing outputs and fee settings before acting on them.\n  Use is subject to the Circle Developer Terms: %s\n  Full text: %s" ;;
      q_circle) _T="Install Circle's skills plugin?" ;;
      circle_skipped) _T="  Skipped Circle's skills. To add them later, rerun this installer in a terminal; it asks again\n  and records them, so --uninstall can remove them: %s" ;;
      err_circle_mkt) _T="could not add Circle's marketplace" ;;
      err_circle_xmkt) _T="could not add Circle's Codex marketplace" ;;
      err_install) _T="could not install %s" ;;
      err_codex_add) _T="could not add %s to Codex" ;;
      err_circle_zero) _T="Circle's plugin is installed but 0 skills were found in %s. The upstream layout may have changed; stopping instead of continuing silently. Please report it: %s" ;;
      err_circle_zero_codex) _T="Circle's Codex plugin is installed but 0 skills were found in %s (layout UNVERIFIED for Codex). Please report it: %s" ;;
      circle_count) _T="  Circle skills: %s%s" ;;
      circle_changed) _T="  Circle skill set changed since the last run:%s%s" ;;
      circle_rescue) _T="  Note: these Circle skills are written to activate even when Circle is not mentioned and\n  can route to paid services: %s. Review them in /plugin if that is unwanted." ;;
      # stable-build plugin
      sec_ours) _T="stable-build plugin" ;;
      ours_c_update_below) _T="  Claude Code: %s present; updated below" ;;
      ours_c_ver) _T="  Claude Code: %s %s" ;;
      ours_c_installed) _T="  Claude Code: %s installed" ;;
      ours_x_update_below) _T="  Codex: %s present; updated below" ;;
      ours_x_ver) _T="  Codex: %s %s" ;;
      ours_x_added) _T="  Codex: %s added" ;;
      warn_load_errors) _T="Claude Code reports load errors for %s: %s" ;;
      # MCP
      sec_mcp) _T="MCP servers" ;;
      st_mcp_install) _T="install (MCP: arc-docs, circle-codegen)" ;;
      st_mcp_user_skip) _T="skip: user-scope MCP '%s' already set up" ;;
      st_mcp_x_add) _T="add (MCP: arc-docs)" ;;
      st_mcp_x_skip) _T="skip: MCP '%s' already set up" ;;
      mcp_c_present) _T="  Claude Code: %s present" ;;
      mcp_c_user_skip) _T="  Claude Code: you already have user-scope MCP server(s) %s; skipping %s so tools are not duplicated." ;;
      mcp_connected) _T="  Claude Code: plugin:stable-build-mcp:%s connected" ;;
      warn_mcp_not_connected) _T="plugin:stable-build-mcp:%s is not reported as connected yet; check with '%s'" ;;
      mcp_x_present) _T="  Codex: %s present" ;;
      mcp_x_skip) _T="  Codex: MCP server %s already configured; skipping %s." ;;
      # Arc Studio
      sec_studio) _T="Arc Studio" ;;
      st_studio_missing) _T="not found: print install hint only" ;;
      st_studio_install_ask) _T="arc-studio skills install --tool claude-code (asks first)" ;;
      st_studio_codex) _T="nothing to install; use the stable-build studio-delegate skill" ;;
      studio_missing) _T="  Arc Studio CLI not found. To use it: npm install -g @circle-fin/arc-studio-cli@latest" ;;
      studio_testnet) _T="  Arc Studio deploys to testnet only (%s)." ;;
      studio_present) _T="  Claude Code: %s present%s" ;;
      q_studio) _T="Register Arc Studio's Claude Code plugin (arc-studio skills install --tool claude-code)?" ;;
      err_studio_install) _T="arc-studio skills install failed" ;;
      warn_studio_unlisted) _T="arc-studio skills install finished but %s is not listed by 'claude plugin list'" ;;
      studio_skipped) _T="  Skipped. To add it later, rerun this installer in a terminal; it asks again and records it,\n  so --uninstall can remove it: %s" ;;
      studio_codex) _T="  Codex: 'arc-studio skills install' supports Claude Code only; in Codex use the stable-build studio-delegate skill." ;;
      studio_login) _T="  This installer never signs in to Arc Studio. When you need it, run it yourself in a terminal:\n    arc-studio login --paste    (or export ARC_STUDIO_TOKEN; check with: arc-studio whoami)" ;;
      # updates
      sec_updates) _T="Updates" ;;
      st_update) _T="update" ;;
      st_upgrade) _T="upgrade" ;;
      st_readd) _T="re-add" ;;
      st_update_ours) _T="update (added by this installer)" ;;
      st_upgrade_readd_ours) _T="upgrade + re-add (added by this installer)" ;;
      st_studio_reregister) _T="re-register: its marketplace dir is gone (%s)" ;;
      st_studio_gone_foreign) _T="marketplace dir is gone; not changed (marketplace not added by this installer)" ;;
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
      st_guard_ask) _T="ask (default: off)" ;;
      guard_on_already) _T="  On (%s). Turn it off with /stable-build:gotchas." ;;
      guard_off_already) _T="  Off, as set earlier (%s). Turn it on with /stable-build:gotchas." ;;
      warn_cfg_invalid) _T="%s is not valid JSON; leaving it untouched (the guard treats it as off)" ;;
      guard_nohooks) _T="  Skipped (--no-hooks). The hooks ship with the plugin but stay dormant without consent.\n  Later runs do not ask again, even with --yes. Turn it on with /stable-build:gotchas." ;;
      guard_declined) _T="  Off: declined on %s, so it is not asked again. Turn it on with /stable-build:gotchas." ;;
      guard_update) _T="  Off. --update never turns it on; rerun without --update to be asked, or use /stable-build:gotchas." ;;
      guard_explain) _T="  After each file edit in a project built on Arc, a local Node script checks the added text\n  against stable-build's Arc rules (sourced from docs.arc.io) and tells the agent what it found.\n  It is advisory: it never undoes or blocks an edit, makes no network calls and writes no files.\n  It stays dormant until you agree here; change it later with /stable-build:gotchas." ;;
      q_guard) _T="Turn the guard on?" ;;
      guard_written) _T="  Guard on: wrote %s" ;;
      warn_sbhome_env) _T="STABLE_BUILD_HOME is %s: set it in the environment Claude Code and Codex run in too, or the hooks will not see this consent" ;;
      guard_declined_now) _T="  Guard stays off. Later runs do not ask again, even with --yes; turn it on with /stable-build:gotchas." ;;
      guard_stays_off) _T="  Guard stays off." ;;
      guard_codex_trust) _T="  Codex: open /hooks in Codex and trust the stable-build hooks. Codex skips plugin hooks until\n  you trust them and asks again whenever a hook changes." ;;
      # finish card
      nothing) _T="nothing" ;;
      ver_was) _T=" %s (was %s)" ;;
      done) _T="Done." ;;
      fin_claude) _T="  Claude Code: %s" ;;
      fin_codex) _T="  Codex: %s" ;;
      fin_guard_on) _T="  Guard: on" ;;
      fin_guard_off) _T="  Guard: off" ;;
      fin_lang) _T="  Language: %s (change it on any run with --lang=en or --lang=pt-BR)" ;;
      fin_manifest) _T="  Manifest: %s" ;;
      fin_next) _T="Next:\n  In a running Claude Code session run /reload-plugins; new sessions load the plugins on start.\n  Your team: Tim (architect), Bobbilee (PM), Sam (analyst), Joshua (UX designer), Pedro (developer), Mike (tech writer).\n  Start with /stable-build:guide, or ask:\n    \"Sam, what should I build on Arc?\"\n    \"Scaffold the payouts starter\"\n    \"Tim, design the architecture\"\n    \"Am I ready for Arc mainnet?\"" ;;
      fin_sandbox) _T="  Sandboxed session:\n    %s\n    %s" ;;
      fin_update) _T="  Update:    %s" ;;
      fin_uninstall) _T="  Uninstall: %s" ;;
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
      st_remove_state) _T="manifest.json, config.json (guard consent, language); the directory only if then empty" ;;
      st_codex_unavailable) _T="codex CLI unavailable: cannot remove recorded Codex entries" ;;
      st_claude_unavailable) _T="claude CLI unavailable: cannot remove recorded Claude Code entries" ;;
      un_blocked_codex) _T="Codex entries are recorded but the codex CLI is not available" ;;
      un_blocked_claude) _T="Claude Code entries are recorded but the claude CLI is not available" ;;
      q_remove_circle) _T="Remove Circle's skills plugin too (this installer added it)?" ;;
      un_keep_circle) _T="  Keeping Circle's skills plugin." ;;
      un_nothing) _T="Nothing to remove: no manifest at %s, and no stable-build entry in %s." ;;
      un_nothing_thirdparty) _T="  Circle's or Arc Studio's plugin is still registered; without a manifest the installer cannot tell\n  who added it, so it is kept. Remove it yourself only if you no longer want it." ;;
      un_incomplete) _T="stable-build: uninstall incomplete; keeping %s so you can retry." ;;
      un_still_present) _T="  still present: %s" ;;
      err_refuse_touch) _T="refusing to touch '%s' (no manifest inside)" ;;
      un_cfg_stripped) _T="  Removed stable-build's settings from %s and kept the file: it holds settings stable-build did not write." ;;
      un_kept_dir) _T="  Kept %s: it holds files stable-build did not write." ;;
      un_removed) _T="Removed. Verified with %s: no stable-build entries left." ;;
      un_kept_preexisting) _T="  Kept (present before stable-build was installed): %s %s" ;;
      un_studio_signin) _T="  Arc Studio sign-in is untouched. To sign out: arc-studio logout" ;;
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
      lang_chosen) _T="  Idioma: português do Brasil (pt-BR)" ;;
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
      usage) _T="instalador stable-build %s: skills, hooks do guard e servidores MCP para apps construídos na Arc,
para Claude Code e Codex. Projeto comunitário, sem afiliação com a Circle.

Uso: install.sh [opções]
  (sem opção)     instala, ou reconcilia uma instalação existente (pode rodar de novo sem risco)
  --update        atualiza o stable-build e também os plugins da Circle e do Arc Studio, se foi este instalador que os adicionou
  --uninstall     remove só o que este instalador adicionou (lê \$STABLE_BUILD_HOME/manifest.json)
  --prefix=DIR    sandbox: toda chamada de CLI roda com HOME=DIR, então nada fora de DIR é gravado
  --yes           responde sim a todas as perguntas (skills da Circle, plugin do Arc Studio, guard ligado) sem exibi-las.
                  Um guard que você recusou antes continua desligado, e --update nunca liga o guard.
  --no-hooks      deixa o guard de edição desligado e não pergunta (nem agora, nem nas próximas execuções)
  --no-mcp        pula o plugin stable-build-mcp (servidores MCP arc-docs e circle-codegen)
  --no-studio     pula o registro do plugin do Arc Studio
  --no-circle     pula o plugin de skills da Circle
  --dry-run       mostra o plano e não altera nada
  --ref=REF       ref git de %s a instalar (padrão: main, que só avança nos releases)
  --lang=IDIOMA   idioma deste instalador e das respostas do kit: en ou pt-BR. Fica salvo para as
                  próximas execuções; padrão: a escolha salva; senão, pergunta no terminal (Enter
                  mantém o inglês); senão, inglês
  -h, --help      mostra esta ajuda

Ambiente:
  STABLE_BUILD_HOME          diretório de estado (padrão: ~/.stable-build)
  STABLE_BUILD_LANG          idioma, como --lang (en ou pt-BR)
  STABLE_BUILD_NO_TTY=1      nunca pergunta; usa a resposta padrão de cada pergunta (o guard fica desligado)
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
      warn_agent_noyes) _T="isto parece uma sessão do Claude Code ou do Codex, onde ninguém pode responder a perguntas: o plugin da Circle e o registro do Arc Studio são pulados e o guard fica desligado. Rode de novo em um terminal comum (ou com --yes, depois de concordar) para adicioná-los. (Quais variáveis CODEX_* o Codex define: NÃO VERIFICADO.)" ;;
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
      # plano e cabeçalho
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
      circle_src_default) _T="  As skills da Circle vêm do plugin da própria Circle (%s, Apache-2.0), baixado agora do GitHub." ;;
      circle_src_custom) _T="  As skills da Circle vêm do plugin da própria Circle (Apache-2.0), aqui a partir de %s." ;;
      circle_disclaimer) _T="  Aviso legal da Circle: os resultados podem conter erros, omissões, informações desatualizadas ou\n  opções de configuração de taxas, inclusive opções que direcionam taxas para a Circle Technology Services, LLC.\n  Você é responsável por revisar os resultados e as configurações de taxas antes de agir com base neles.\n  O uso está sujeito aos Circle Developer Terms: %s\n  Texto completo (em inglês): %s" ;;
      q_circle) _T="Instalar o plugin de skills da Circle?" ;;
      circle_skipped) _T="  Skills da Circle puladas. Para adicioná-las depois, rode este instalador de novo em um terminal; ele\n  pergunta outra vez e as registra, para que --uninstall possa removê-las: %s" ;;
      err_circle_mkt) _T="não foi possível adicionar o marketplace da Circle" ;;
      err_circle_xmkt) _T="não foi possível adicionar o marketplace da Circle ao Codex" ;;
      err_install) _T="não foi possível instalar %s" ;;
      err_codex_add) _T="não foi possível adicionar %s ao Codex" ;;
      err_circle_zero) _T="o plugin da Circle está instalado, mas foram encontradas 0 skills em %s. A estrutura do repositório de origem pode ter mudado; o instalador para aqui em vez de seguir em silêncio. Por favor, reporte: %s" ;;
      err_circle_zero_codex) _T="o plugin da Circle para o Codex está instalado, mas foram encontradas 0 skills em %s (estrutura NÃO VERIFICADA no Codex). Por favor, reporte: %s" ;;
      circle_count) _T="  Skills da Circle: %s%s" ;;
      circle_changed) _T="  O conjunto de skills da Circle mudou desde a última execução:%s%s" ;;
      circle_rescue) _T="  Atenção: estas skills da Circle foram escritas para ativar mesmo quando a Circle não é mencionada e\n  podem levar a serviços pagos: %s. Revise-as em /plugin se não quiser isso." ;;
      # plugin stable-build
      sec_ours) _T="Plugin stable-build" ;;
      ours_c_update_below) _T="  Claude Code: %s presente; atualizado abaixo" ;;
      ours_c_ver) _T="  Claude Code: %s %s" ;;
      ours_c_installed) _T="  Claude Code: %s instalado" ;;
      ours_x_update_below) _T="  Codex: %s presente; atualizado abaixo" ;;
      ours_x_ver) _T="  Codex: %s %s" ;;
      ours_x_added) _T="  Codex: %s adicionado" ;;
      warn_load_errors) _T="o Claude Code relata erros ao carregar %s: %s" ;;
      # MCP
      sec_mcp) _T="Servidores MCP" ;;
      st_mcp_install) _T="instalar (MCP: arc-docs, circle-codegen)" ;;
      st_mcp_user_skip) _T="pular: o MCP '%s' de escopo de usuário já está configurado" ;;
      st_mcp_x_add) _T="adicionar (MCP: arc-docs)" ;;
      st_mcp_x_skip) _T="pular: o MCP '%s' já está configurado" ;;
      mcp_c_present) _T="  Claude Code: %s presente" ;;
      mcp_c_user_skip) _T="  Claude Code: você já tem servidor(es) MCP de escopo de usuário %s; pulando %s para não duplicar ferramentas." ;;
      mcp_connected) _T="  Claude Code: plugin:stable-build-mcp:%s conectado" ;;
      warn_mcp_not_connected) _T="plugin:stable-build-mcp:%s ainda não aparece como conectado; confira com '%s'" ;;
      mcp_x_present) _T="  Codex: %s presente" ;;
      mcp_x_skip) _T="  Codex: o servidor MCP %s já está configurado; pulando %s." ;;
      # Arc Studio
      sec_studio) _T="Arc Studio" ;;
      st_studio_missing) _T="não encontrado: só mostra como instalar" ;;
      st_studio_install_ask) _T="arc-studio skills install --tool claude-code (pergunta antes)" ;;
      st_studio_codex) _T="nada a instalar; use a skill studio-delegate do stable-build" ;;
      studio_missing) _T="  Arc Studio CLI não encontrado. Para usá-lo: npm install -g @circle-fin/arc-studio-cli@latest" ;;
      studio_testnet) _T="  O Arc Studio faz deploy só na testnet (%s)." ;;
      studio_present) _T="  Claude Code: %s presente%s" ;;
      q_studio) _T="Registrar o plugin do Arc Studio no Claude Code (arc-studio skills install --tool claude-code)?" ;;
      err_studio_install) _T="arc-studio skills install falhou" ;;
      warn_studio_unlisted) _T="arc-studio skills install terminou, mas %s não aparece em 'claude plugin list'" ;;
      studio_skipped) _T="  Pulado. Para adicioná-lo depois, rode este instalador de novo em um terminal; ele pergunta outra vez\n  e o registra, para que --uninstall possa removê-lo: %s" ;;
      studio_codex) _T="  Codex: 'arc-studio skills install' só funciona com o Claude Code; no Codex, use a skill studio-delegate do stable-build." ;;
      studio_login) _T="  Este instalador nunca faz login no Arc Studio. Quando precisar, rode você mesmo em um terminal:\n    arc-studio login --paste    (ou exporte ARC_STUDIO_TOKEN; confira com: arc-studio whoami)" ;;
      # atualizações
      sec_updates) _T="Atualizações" ;;
      st_update) _T="atualizar" ;;
      st_upgrade) _T="atualizar (upgrade)" ;;
      st_readd) _T="adicionar de novo" ;;
      st_update_ours) _T="atualizar (adicionado por este instalador)" ;;
      st_upgrade_readd_ours) _T="upgrade + adicionar de novo (adicionado por este instalador)" ;;
      st_studio_reregister) _T="registrar de novo: o diretório do marketplace sumiu (%s)" ;;
      st_studio_gone_foreign) _T="o diretório do marketplace sumiu; nada alterado (marketplace não adicionado por este instalador)" ;;
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
      st_guard_ask) _T="perguntar (padrão: desligado)" ;;
      guard_on_already) _T="  Ligado (%s). Para desligar, use /stable-build:gotchas." ;;
      guard_off_already) _T="  Desligado, como definido antes (%s). Para ligar, use /stable-build:gotchas." ;;
      warn_cfg_invalid) _T="%s não é um JSON válido; o arquivo fica intocado (o guard o trata como desligado)" ;;
      guard_nohooks) _T="  Pulado (--no-hooks). Os hooks vêm com o plugin, mas ficam inativos sem o seu consentimento.\n  As próximas execuções não perguntam de novo, nem com --yes. Para ligar, use /stable-build:gotchas." ;;
      guard_declined) _T="  Desligado: recusado em %s, então não perguntamos de novo. Para ligar, use /stable-build:gotchas." ;;
      guard_update) _T="  Desligado. --update nunca o liga; rode de novo sem --update para responder à pergunta, ou use /stable-build:gotchas." ;;
      guard_explain) _T="  Depois de cada edição de arquivo em um projeto construído na Arc, um script Node local confere o texto\n  adicionado com as regras da Arc do stable-build (com fonte em docs.arc.io) e conta ao agente o que encontrou.\n  É só um aviso: nunca desfaz nem bloqueia uma edição, não faz chamadas de rede e não grava arquivos.\n  Fica inativo até você concordar aqui; para mudar depois, use /stable-build:gotchas." ;;
      q_guard) _T="Ligar o guard?" ;;
      guard_written) _T="  Guard ligado: gravado em %s" ;;
      warn_sbhome_env) _T="STABLE_BUILD_HOME é %s: defina essa variável também no ambiente em que o Claude Code e o Codex rodam, senão os hooks não veem este consentimento" ;;
      guard_declined_now) _T="  O guard continua desligado. As próximas execuções não perguntam de novo, nem com --yes; para ligar, use /stable-build:gotchas." ;;
      guard_stays_off) _T="  O guard continua desligado." ;;
      guard_codex_trust) _T="  Codex: abra /hooks no Codex e marque os hooks do stable-build como confiáveis. O Codex ignora hooks de\n  plugins até você confiar neles e pergunta de novo sempre que um hook muda." ;;
      # resumo final
      nothing) _T="nada" ;;
      ver_was) _T=" %s (antes: %s)" ;;
      done) _T="Concluído." ;;
      fin_claude) _T="  Claude Code: %s" ;;
      fin_codex) _T="  Codex: %s" ;;
      fin_guard_on) _T="  Guard: ligado" ;;
      fin_guard_off) _T="  Guard: desligado" ;;
      fin_lang) _T="  Idioma: %s (mude em qualquer execução com --lang=en ou --lang=pt-BR)" ;;
      fin_manifest) _T="  Manifesto: %s" ;;
      fin_next) _T="Próximos passos:\n  Em uma sessão do Claude Code já aberta, rode /reload-plugins; sessões novas carregam os plugins ao iniciar.\n  Seu time: Tim (arquiteto), Bobbilee (PM), Sam (analista), Joshua (UX designer), Pedro (desenvolvedor), Mike (tech writer).\n  Comece com /stable-build:guide, ou peça:\n    \"Sam, o que eu construo na Arc?\"\n    \"Crie o projeto inicial de payouts\"\n    \"Tim, desenhe a arquitetura\"\n    \"Estou pronto para a mainnet da Arc?\"" ;;
      fin_sandbox) _T="  Sessão no sandbox:\n    %s\n    %s" ;;
      fin_update) _T="  Atualizar:   %s" ;;
      fin_uninstall) _T="  Desinstalar: %s" ;;
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
      st_remove_state) _T="manifest.json, config.json (consentimento do guard, idioma); o diretório só se ficar vazio" ;;
      st_codex_unavailable) _T="CLI codex indisponível: não dá para remover as entradas registradas do Codex" ;;
      st_claude_unavailable) _T="CLI claude indisponível: não dá para remover as entradas registradas do Claude Code" ;;
      un_blocked_codex) _T="há entradas do Codex registradas, mas a CLI codex não está disponível" ;;
      un_blocked_claude) _T="há entradas do Claude Code registradas, mas a CLI claude não está disponível" ;;
      q_remove_circle) _T="Remover também o plugin de skills da Circle (foi este instalador que o adicionou)?" ;;
      un_keep_circle) _T="  Mantendo o plugin de skills da Circle." ;;
      un_nothing) _T="Nada a remover: não há manifesto em %s nem entrada do stable-build em %s." ;;
      un_nothing_thirdparty) _T="  O plugin da Circle ou do Arc Studio continua registrado; sem manifesto, o instalador não sabe\n  quem o adicionou, então ele é mantido. Remova-o você mesmo só se não quiser mais usá-lo." ;;
      un_incomplete) _T="stable-build: desinstalação incompleta; mantendo %s para você tentar de novo." ;;
      un_still_present) _T="  ainda presente: %s" ;;
      err_refuse_touch) _T="o instalador não mexe em '%s' (não há manifesto dentro)" ;;
      un_cfg_stripped) _T="  As configurações do stable-build foram removidas de %s e o arquivo foi mantido: ele guarda configurações que o stable-build não gravou." ;;
      un_kept_dir) _T="  %s foi mantido: ele guarda arquivos que o stable-build não gravou." ;;
      un_removed) _T="Removido. Verificado com %s: não sobrou nenhuma entrada do stable-build." ;;
      un_kept_preexisting) _T="  Mantidos (já existiam antes da instalação do stable-build): %s %s" ;;
      un_studio_signin) _T="  O login do Arc Studio não foi alterado. Para sair: arc-studio logout" ;;
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
  die_t() { { msg pfx_error; msg "$@"; printf '\n'; } >&2; exit 1; }
  section() { if [ "$PHASE" = apply ]; then printf '\n'; msg "$@"; printf '\n'; fi; }
  line() { if [ "$PHASE" = plan ]; then printf '  %-8s %-38s %s\n' "$1" "$2" "$3"; fi; }
  # display form of a path: ~ for HOME (outside --prefix)
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
  # the first prompt: a one-line banner, then a bilingual menu on the terminal
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
    say_t lang_chosen
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
    LANG_SRC=env
  fi

  # ------------------------------------------------------------------ arguments
  # A bad argument is reported after the saved language is read (below), so the error is in it.
  # After --help the loop still reads --prefix (it says where the saved language is) but ignores
  # anything else, so `--help --bogus` and `--help --prefix` without a value still print the help.
  MODE=install; YES=0; NO_HOOKS=0; NO_MCP=0; NO_STUDIO=0; NO_CIRCLE=0; DRY_RUN=0; SHOW_HELP=0
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

  HAVE_TTY=0
  if [ "${STABLE_BUILD_NO_TTY:-}" != 1 ] && (exec </dev/tty) 2>/dev/null; then HAVE_TTY=1; fi
  AGENT_SESSION=0
  if [ -n "${CLAUDECODE:-}" ] || env | grep '^CODEX_' | grep -v '^CODEX_HOME=' >/dev/null 2>&1; then AGENT_SESSION=1; fi
  # In an agent session the terminal belongs to the agent's UI, so nobody can answer a prompt here.
  if [ "$AGENT_SESSION" = 1 ] && [ "$YES" != 1 ]; then HAVE_TTY=0; fi

  # Language, last step: ask in a terminal (the first prompt, before any other output; Enter keeps
  # English); otherwise (no terminal, or --yes) English, without asking.
  if [ -z "$LANG_SRC" ]; then
    if [ "$HAVE_TTY" = 1 ] && [ "$YES" != 1 ]; then choose_lang
    else SB_LANG=$DEFAULT_LANG; LANG_SRC=default; fi
  fi

  SB_WORK=$(mktemp -d "${TMPDIR:-/tmp}/stable-build.XXXXXX") || die_t err_mktemp
  trap 'rm -rf "$SB_WORK"' EXIT
  trap 'exit 130' INT TERM
  : >"$SB_WORK/facts"
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

  # Mutating call: printed, run, output indented. Callers stop on failure.
  mut() {
    printf '    $ %s\n' "$*"
    host_run "$@" 2>&1 | sed 's/^/      /'
  }

  # Prompt on /dev/tty. $1 question (message id), $2 default (Y|N), $3 answer under --yes (Y|N),
  # $4 answer when nobody can be asked (no terminal, or an agent session, without --yes; default $2).
  # Prompts that install or run third-party software pass N here: they need a person's yes.
  yn() { if [ "$1" = Y ]; then msg ans_yes; else msg ans_no; fi; }
  ask() {
    local question hint def=$2 yes_answer=$3 noterm=${4:-$2} answer=''
    question=$(msg "$1")
    if [ "$def" = Y ]; then hint=$(msg ask_hint_yes); else hint=$(msg ask_hint_no); fi
    if [ "$YES" = 1 ]; then
      printf '  %s %s %s (--yes)\n' "$question" "$hint" "$(yn "$yes_answer")"
      [ "$yes_answer" = Y ]
      return
    fi
    if [ "$HAVE_TTY" != 1 ]; then
      if [ "$noterm" = "$def" ]; then
        printf '  %s %s %s %s\n' "$question" "$hint" "$(yn "$def")" "$(msg ask_noterm_default)"
      else
        printf '  %s %s %s %s\n' "$question" "$hint" "$(yn "$noterm")" "$(msg ask_noterm_skipped)"
      fi
      [ "$noterm" = Y ]
      return
    fi
    printf '  %s %s ' "$question" "$hint" >/dev/tty
    IFS= read -r answer </dev/tty || answer=''
    case "$answer" in
      [YySs]|[Yy][Ee][Ss]|[Ss][Ii][Mm]) return 0 ;;
      [Nn]|[Nn][Oo]|[Nn][Aa][Oo]|[Nn]ão|[Nn]ÃO) return 1 ;;
      *) [ "$def" = Y ] ;;
    esac
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
} else {
  process.stderr.write('helper: unknown op ' + op + '\n');
  process.exit(2);
}
JS_EOF
  printf '%s\n' "$HELPER_JS" >>"$SB_WORK/helper.cjs"
  helper() { node "$SB_WORK/helper.cjs" "$@"; }

  # Host CLIs. The plugin subcommands are the only interface used to change host config.
  HAS_CLAUDE=0; CLAUDE_VER=''; HAS_CODEX=0; CODEX_VER=''
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
      warn_t warn_codex_noplugin "${CODEX_VER:+ ($CODEX_VER)}"
    fi
  fi
  if [ "$HAS_CLAUDE" = 0 ] && [ "$HAS_CODEX" = 0 ]; then
    err_t err_no_host "$MIN_CLAUDE"
    exit 1
  fi
  HAS_STUDIO=0; if command -v arc-studio >/dev/null 2>&1; then HAS_STUDIO=1; fi
  if [ "$AGENT_SESSION" = 1 ]; then
    if [ "$YES" != 1 ]; then warn_t warn_agent_noyes; else warn_t warn_agent_yes; fi
  fi

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
  OLD_CP_SB_VER=$CP_SB_VER; OLD_CP_SBMCP_VER=$CP_SBMCP_VER; OLD_XP_SB_VER=$XP_SB_VER; OLD_XP_SBMCP_VER=$XP_SBMCP_VER

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

  circle_disclaimer() {
    if [ "$CIRCLE_DEFAULT_SRC" = 1 ]; then
      say_t circle_src_default "$CIRCLE_REPO"
    else
      say_t circle_src_custom "$SRC_CIRCLE_C"
    fi
    say_t circle_disclaimer "$CIRCLE_TERMS" "$CIRCLE_DISCLAIMER"
  }

  circle_verify() {
    local dir='' names n xdir xnames sha rescue diff_add='' diff_del='' s detail
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
    say_t circle_count "$n" "${detail:+ ($detail)}"
    if [ -n "$OLD_CIRCLE_SKILLS" ]; then
      for s in $names; do case " $OLD_CIRCLE_SKILLS " in *" $s "*) ;; *) diff_add="$diff_add +$s" ;; esac; done
      for s in $OLD_CIRCLE_SKILLS; do case " $names " in *" $s "*) ;; *) diff_del="$diff_del -$s" ;; esac; done
      if [ -n "$diff_add$diff_del" ]; then say_t circle_changed "$diff_add" "$diff_del"; fi
    fi
    rescue=$(rescue_skills "$dir")
    if [ -n "$rescue" ]; then
      say_t circle_rescue "$rescue"
    fi
  }

  step_circle() {
    local need=0
    if [ "$NO_CIRCLE" = 1 ]; then line circle "-" "$(msg st_skipped_flag --no-circle)"; return 0; fi
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
    # --update with nothing to add reports Circle under "Updates" (circle_verify runs there)
    if [ "$need" = 1 ] || [ "$MODE" != update ]; then section sec_circle; fi
    if [ "$need" = 1 ]; then
      circle_disclaimer
      if ! ask q_circle Y Y N; then
        say_t circle_skipped "$RERUN_CMD"
        CIRCLE_SKIPPED=1
        return 0
      fi
    fi
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
      # --update: the version here is the old one; the new one is printed after the update
      if [ "$MODE" = update ] && [ "$JUST_C_P_SB" != 1 ]; then say_t ours_c_update_below "$N_PLUGIN"
      elif [ -n "$CP_SB_VER" ]; then say_t ours_c_ver "$N_PLUGIN" "$CP_SB_VER"
      else say_t ours_c_installed "$N_PLUGIN"; fi
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
      if [ "$MODE" = update ] && [ "$JUST_X_P_SB" != 1 ]; then say_t ours_x_update_below "$N_PLUGIN"
      elif [ -n "$XP_SB_VER" ]; then say_t ours_x_ver "$N_PLUGIN" "$XP_SB_VER"
      else say_t ours_x_added "$N_PLUGIN"; fi
    fi
    save_manifest
  }

  step_mcp() {
    local s
    if [ "$NO_MCP" = 1 ]; then line mcp "-" "$(msg st_skipped_flag --no-mcp)"; return 0; fi
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
        say_t mcp_c_present "$N_PLUGIN_MCP"
      elif [ -n "$MCP_C_USER" ]; then
        say_t mcp_c_user_skip "$MCP_C_USER" "$N_PLUGIN_MCP"
      else
        mut claude plugin install "$N_PLUGIN_MCP" || die_t err_install "$N_PLUGIN_MCP"
        JUST_C_P_SBMCP=1; owned "hosts/claude/plugins/$N_PLUGIN_MCP/addedByUs"
        # health check, ours only: `claude mcp get <name>` connects to that one server (both accept
        # anonymous calls). `claude mcp list` is not used: it would start every server the user has.
        for s in arc-docs circle-codegen; do
          if host_run claude mcp get "plugin:stable-build-mcp:$s" >"$SB_WORK/mcpget.txt" 2>&1 \
            && grep -qi 'status:.*connected' "$SB_WORK/mcpget.txt"; then
            say_t mcp_connected "$s"
          else
            warn_t warn_mcp_not_connected "$s" "$(hint claude mcp list)"
          fi
        done
      fi
      if [ "$CP_SBMCP" = 1 ] && [ -n "$CP_SBMCP_VER" ]; then fact T "hosts/claude/plugins/$N_PLUGIN_MCP/version" "$CP_SBMCP_VER"; fi
    fi
    if [ "$HAS_CODEX" = 1 ]; then
      if [ "$XP_SBMCP" = 1 ]; then
        fact B "hosts/codex/plugins/$N_PLUGIN_MCP/addedByUs" false
        say_t mcp_x_present "$N_PLUGIN_MCP"
      elif [ -n "$MCP_X_USER" ]; then
        say_t mcp_x_skip "$MCP_X_USER" "$N_PLUGIN_MCP"
      else
        mut codex plugin add "$N_PLUGIN_MCP" || die_t err_codex_add "$N_PLUGIN_MCP"
        JUST_X_P_SBMCP=1; owned "hosts/codex/plugins/$N_PLUGIN_MCP/addedByUs"
      fi
      if [ "$XP_SBMCP" = 1 ] && [ -n "$XP_SBMCP_VER" ]; then fact T "hosts/codex/plugins/$N_PLUGIN_MCP/version" "$XP_SBMCP_VER"; fi
    fi
    save_manifest
  }

  step_studio() {
    local had_mkt
    if [ "$NO_STUDIO" = 1 ]; then line studio "-" "$(msg st_skipped_flag --no-studio)"; return 0; fi
    if [ "$HAS_STUDIO" != 1 ]; then
      line studio "arc-studio CLI" "$(msg st_studio_missing)"
      if [ "$PHASE" = apply ]; then
        section sec_studio
        say_t studio_missing
        say_t studio_testnet "$STUDIO_DOCS"
      fi
      return 0
    fi
    if [ "$HAS_CLAUDE" = 1 ]; then
      if [ "$CP_STUDIO" = 1 ]; then line claude "plugin $N_STUDIO" "$(msg st_present)${CP_STUDIO_VER:+ ($CP_STUDIO_VER)}"
      else line claude "plugin $N_STUDIO" "$(msg st_studio_install_ask)"; fi
    fi
    if [ "$HAS_CODEX" = 1 ]; then line codex "arc-studio" "$(msg st_studio_codex)"; fi
    [ "$PHASE" = apply ] || return 0
    section sec_studio
    if [ "$HAS_CLAUDE" = 1 ]; then
      if [ "$CP_STUDIO" = 1 ]; then
        fact B "hosts/claude/plugins/$N_STUDIO/addedByUs" false
        if [ "$CM_STUDIO" = 1 ]; then fact B "hosts/claude/marketplaces/$N_STUDIO_MKT/addedByUs" false; fi
        say_t studio_present "$N_STUDIO" "${CP_STUDIO_VER:+ ($CP_STUDIO_VER)}"
      elif ask q_studio Y Y N; then
        had_mkt=$CM_STUDIO
        # Circle's CLI runs `claude plugin marketplace add <its npm dir>` and `claude plugin install arc-studio@arc-studio-cli -y`
        mut arc-studio skills install --tool claude-code || die_t err_studio_install
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
        save_manifest
      else
        say_t studio_skipped "$RERUN_CMD"
      fi
    fi
    if [ "$HAS_CODEX" = 1 ]; then
      say_t studio_codex
    fi
    say_t studio_login
    say_t studio_testnet "$STUDIO_DOCS"
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
      if [ "$NO_CIRCLE" != 1 ] && [ "$CIRCLE_SKIPPED" != 1 ]; then circle_verify; fi
    fi
    # Arc Studio: its marketplace is the npm package directory, which moves on npm upgrades or node
    # switches. Re-running `skills install` alone does not repair it, because `marketplace add` of
    # the new directory reports the existing name as already added; so the stale entry is removed
    # first, and only when this installer added it. Claude's handling of a vanished directory
    # marketplace is UNVERIFIED.
    if [ "$NO_STUDIO" != 1 ] && [ "$HAS_STUDIO" = 1 ] && [ "$HAS_CLAUDE" = 1 ] && [ "$MF_C_P_STUDIO" = 1 ] \
      && [ "$CM_STUDIO" = 1 ] && [ -n "$CM_STUDIO_PATH" ] && [ ! -d "$CM_STUDIO_PATH" ]; then
      if [ "$MF_C_M_STUDIO" = 1 ]; then
        line claude "plugin $N_STUDIO" "$(msg st_studio_reregister "$CM_STUDIO_PATH")"
        if [ "$PHASE" = apply ]; then
          mut claude plugin marketplace remove "$N_STUDIO_MKT" || die_t err_stale_mkt "$N_STUDIO_MKT"
          probe
          mut arc-studio skills install --tool claude-code || die_t err_studio_install
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
    local r asked=0 col
    col=$(msg col_guard)
    # An existing "guard" in config.json decides; then --no-hooks or an earlier "no" (both recorded
    # in the manifest, so they stick); --update never asks; otherwise ask. A config.json that only
    # holds the language leaves the question open.
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
      say_t guard_on_already "$(tilde "$CONFIG")"
    elif [ "$CFG_GUARD" = false ]; then
      say_t guard_off_already "$(tilde "$CONFIG")"
    elif [ "$CFG_GUARD" = invalid ]; then
      warn_t warn_cfg_invalid "$CONFIG"
    elif [ "$NO_HOOKS" = 1 ]; then
      say_t guard_nohooks
      if [ -z "$MF_GUARD_DECLINED" ]; then fact T guard/declinedAt "$(now)"; fi
    elif [ -n "$MF_GUARD_DECLINED" ]; then
      say_t guard_declined "$MF_GUARD_DECLINED"
    elif [ "$MODE" = update ]; then
      say_t guard_update
    else
      say_t guard_explain
      # only a person's answer at the terminal is a decision; the no-terminal default is not
      if [ "$YES" != 1 ] && [ "$HAVE_TTY" = 1 ]; then asked=1; fi
      if ask q_guard N Y; then
        r=$(helper write-config "$CONFIG" "$(now)" "$SB_LANG") || die_t err_write "$CONFIG"
        case "$r" in created\ *) fact B files/config.json/createdByUs true ;; esac
        fact T files/config.json/sha256 "${r#* }"
        CFG_GUARD=true
        say_t guard_written "$(tilde "$CONFIG")"
        if [ -z "$PREFIX" ] && [ "$SB_HOME" != "${HOME:-}/.stable-build" ]; then
          warn_t warn_sbhome_env "$SB_HOME"
        fi
      elif [ "$asked" = 1 ]; then
        fact T guard/declinedAt "$(now)"
        say_t guard_declined_now
      else
        say_t guard_stays_off
      fi
    fi
    if [ "$CFG_GUARD" = true ]; then fact F guard/enabled true; else fact F guard/enabled false; fi
    if [ "$HAS_CODEX" = 1 ] && [ "$XP_SB" = 1 ] && [ "$NO_HOOKS" != 1 ]; then
      say_t guard_codex_trust
      fact B hosts/codex/hooksTrustPrinted true
    fi
    save_manifest
  }

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

  # "a, b, c" from (flag name) pairs whose flag is 1
  present_list() {
    local r=''
    while [ $# -ge 2 ]; do
      if [ "$1" = 1 ]; then r="${r:+$r, }$2"; fi
      shift 2
    done
    if [ -n "$r" ]; then printf '%s' "$r"; else msg nothing; fi
  }

  # " 0.1.1", or " 0.1.1 (was 0.1.0)" when this run changed it; nothing when unknown
  ver_label() {
    if [ -z "$1" ]; then return 0; fi
    if [ -n "${2:-}" ] && [ "$2" != "$1" ]; then msg ver_was "$1" "$2"; else printf ' %s' "$1"; fi
  }

  finish_install() {
    local up_cmd un_cmd pfx=''
    if [ "$HAS_CLAUDE" = 1 ]; then fact T hosts/claude/cli "$CLAUDE_VER"; fi
    if [ "$HAS_CODEX" = 1 ]; then fact T hosts/codex/cli "${CODEX_VER:-unknown}"; fi
    save_manifest
    if [ -n "$PREFIX" ]; then pfx=" --prefix=$(shq "$PREFIX")"; fi
    up_cmd="curl -fsSL $RAW_INSTALL | bash -s -- --update$pfx"
    un_cmd="curl -fsSL $RAW_INSTALL | bash -s -- --uninstall$pfx"
    say ""
    say_t done
    if [ "$HAS_CLAUDE" = 1 ]; then
      say_t fin_claude "$(present_list "$CP_SB" "$N_PLUGIN$(ver_label "$CP_SB_VER" "$OLD_CP_SB_VER")" "$CP_SBMCP" "$N_PLUGIN_MCP$(ver_label "$CP_SBMCP_VER" "$OLD_CP_SBMCP_VER")" "$CP_CIRCLE" "$N_C_CIRCLE (Circle)" "$CP_STUDIO" "$N_STUDIO (Circle)")"
    fi
    if [ "$HAS_CODEX" = 1 ]; then
      say_t fin_codex "$(present_list "$XP_SB" "$N_PLUGIN$(ver_label "$XP_SB_VER" "$OLD_XP_SB_VER")" "$XP_SBMCP" "$N_PLUGIN_MCP$(ver_label "$XP_SBMCP_VER" "$OLD_XP_SBMCP_VER")" "$XP_CIRCLE" "$N_X_CIRCLE (Circle)")"
    fi
    if [ "$CFG_GUARD" = true ]; then say_t fin_guard_on; else say_t fin_guard_off; fi
    say_t fin_lang "$SB_LANG"
    say_t fin_manifest "$(tilde "$MANIFEST")"
    say ""
    say_t fin_next
    if [ -n "$PREFIX" ]; then
      say_t fin_sandbox \
        "HOME=\"$PREFIX\" CLAUDE_CONFIG_DIR=\"$PREFIX/.claude\" STABLE_BUILD_HOME=\"$SB_HOME\" claude" \
        "HOME=\"$PREFIX\" CODEX_HOME=\"$PREFIX/.codex\" STABLE_BUILD_HOME=\"$SB_HOME\" codex"
    fi
    say_t fin_update "$up_cmd"
    say_t fin_uninstall "$un_cmd"
    say ""
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
    say "  rm -f \"$SB_HOME/manifest.json\" \"$SB_HOME/config.json\"; rmdir \"$SB_HOME\"" >&2
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
          mut claude plugin uninstall "$N_STUDIO" || die_t err_cmd_failed "claude plugin uninstall $N_STUDIO"; probe; fi
        if rm_decide claude marketplace "$N_STUDIO_MKT" "$CM_STUDIO" "$MF_C_M_STUDIO" && [ "$PHASE" = apply ]; then
          mut claude plugin marketplace remove "$N_STUDIO_MKT" || die_t err_cmd_failed "claude plugin marketplace remove $N_STUDIO_MKT"; probe; fi
      fi
    elif [ "$MF_C_M_SB$MF_C_P_SB$MF_C_P_SBMCP$MF_C_P_STUDIO$MF_C_M_STUDIO" != 00000 ]; then
      line claude "-" "$(msg st_claude_unavailable)"
      UNINSTALL_BLOCKED=$(msg un_blocked_claude)
    fi
    # 4. Circle (asks; default yes when this installer added it); --no-circle keeps it
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
      else
        say_t un_keep_circle
      fi
    fi
    # 5. our state files (never anything else in that directory)
    line "$(msg col_remove)" "$(tilde "$SB_HOME")" "$(msg st_remove_state)"
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
    PHASE=plan; uninstall_steps
    if [ "$DRY_RUN" = 1 ]; then say ""; say_t dry_done; exit 0; fi
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
    # Remove only the files stable-build writes there (manifest, config.json and their atomic-write
    # temp files), then the directory if nothing else is in it. Never a recursive delete. config.json
    # goes when stable-build created it (or it is a stable-build file with only stable-build keys);
    # otherwise only the keys stable-build added are taken out of it.
    [ -f "$MANIFEST" ] || die_t err_refuse_touch "$SB_HOME"
    rm -f -- "$MANIFEST"
    cfg_r=$(helper config-uninstall "$CONFIG" "$MF_CFG_CREATED" "$MF_CFG_LANG_ADDED") || cfg_r=kept
    for f in "$SB_HOME"/manifest.json.tmp-* "$SB_HOME"/config.json.tmp-* "$SB_HOME"/.config.json.*.tmp; do
      if [ -f "$f" ]; then rm -f -- "$f"; fi
    done
    say ""
    if [ "$cfg_r" = stripped ]; then say_t un_cfg_stripped "$(tilde "$CONFIG")"; fi
    if rmdir -- "$SB_HOME" 2>/dev/null; then :; else
      say_t un_kept_dir "$(tilde "$SB_HOME")"
    fi
    say_t un_removed "$(listed_hosts)"
    if [ -n "$C_KEPT$X_KEPT" ]; then say_t un_kept_preexisting "$C_KEPT" "$X_KEPT"; fi
    if [ "$HAS_STUDIO" = 1 ] && [ "$studio_ours" = 1 ]; then say_t un_studio_signin; fi
    if [ "$HAS_CODEX" = 1 ]; then say_t un_codex_trust; fi
    say_t un_reload
  }

  # ------------------------------------------------------------------ dispatch
  if [ "$MODE" = uninstall ]; then
    run_uninstall
    return 0
  fi
  check_user_mcp
  PHASE=plan
  run_install
  if [ "$DRY_RUN" = 1 ]; then say ""; say_t dry_done; return 0; fi
  PHASE=apply
  run_install
  finish_install
}

{ main "$@"; }
