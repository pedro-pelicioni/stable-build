# Install round-trip seed

Pre-existing user state that `test/install/roundtrip.sh` copies into a throwaway `--prefix`
before installing. After install, reinstall, update and uninstall it must come back unchanged.

| Seed path | Copied to | Checked |
|---|---|---|
| `claude/settings.json` | `<prefix>/.claude/settings.json` | deep-equal (Claude Code may leave empty `enabledPlugins` / `extraKnownMarketplaces` objects) |
| `claude/skills/code-review/SKILL.md.seed` | `<prefix>/.claude/skills/code-review/SKILL.md` | byte-for-byte |
| `codex/config.toml` | `<prefix>/.codex/config.toml` | byte-for-byte (the case where a sed range wiped `[mcp_servers.*]` and `[profiles.*]`) |

Files ending in `.seed` lose that suffix when copied, so this repo never contains a live
`SKILL.md` named after a built-in command. Dot-directories are spelled without the dot for the
same reason.
