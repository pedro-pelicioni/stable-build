# stable-build-mcp

An optional plugin that adds two remote MCP servers for apps built on Arc. It contains configuration only, no code. It is part of the community stable-build marketplace and is not affiliated with Circle.

| Server | URL | Who runs it | Docs |
|---|---|---|---|
| `arc-docs` | https://docs.arc.io/mcp | Arc docs site | https://docs.arc.io/ai/mcp |
| `circle-codegen` | https://api.circle.com/v1/codegen/mcp | Circle | https://developers.circle.com/ai/mcp |

Both servers use HTTP transport, need no account, and take read-only queries.

## Install

- Claude Code: `claude plugin install stable-build-mcp@stable-build`. The server ids are `plugin:stable-build-mcp:arc-docs` and `plugin:stable-build-mcp:circle-codegen`.
- Codex: `codex plugin add stable-build-mcp@stable-build`. This adds `arc-docs` only (see below).
- `install.sh --no-mcp` skips this plugin.

Skip it if you already registered `arc-docs` or Circle's server yourself, for example with `claude mcp add`. Two copies would duplicate the same tools. The installer checks for this and skips the plugin when it finds one.

## Why the two hosts differ

- **Claude Code** gets `circle-codegen` from this plugin. Circle's own plugin declares its server without `"type"`, and Claude Code 2.1.280 does not load an MCP entry that has a URL but no type. We verified this locally on 2026-10-04. This plugin declares the same URL with `"type": "http"`. If Circle adds the type upstream, we will drop our copy.
- **Codex** reads `codex.mcp.json`, which has `arc-docs` only. Codex accepts Circle's untyped entry, so Circle's Codex plugin already provides that server, and a second copy would duplicate it. This comes from reading the Codex source (openai/codex@4ad985e) and is UNVERIFIED at runtime.

## What leaves your machine

Each tool call sends the agent's query text to the server operator: docs.arc.io for `arc-docs`, and Circle for `circle-codegen`. Do not put secrets, private keys or customer data in prompts that may trigger these tools. Use of each service is subject to its operator's terms: https://docs.arc.io/terms for `arc-docs` and https://console.circle.com/legal/developer-terms for `circle-codegen`.

## Tools observed (2026-10-04, may change)

- `arc-docs`:
  - `search_arc_docs` and `query_docs_filesystem_arc_docs` (read-only).
  - `search_arc_docs` returns whole pages: 50-125 KB per query in testing (2026-10-05), over Claude Code's tool-output limit, so the result is saved to a file under `~/.claude/projects/` instead. A targeted `query_docs_filesystem_arc_docs` call (`rg -n -C1 "<pattern>" /<path>.mdx`) returned 1.5-15 KB. stable-build skills prefer the second form for single facts.
  - `submit_feedback`, which sends feedback to the docs site. stable-build skills never call `submit_feedback` unless the user asks.
  - The docs page lists two tools, Search and Get page (https://docs.arc.io/ai/mcp).
- `circle-codegen`: `search_circle_documentation`, `get_circle_product_summary`, `list_available_coding_resources` and `get_coding_resource_details`, all read-only. It has no Arc product, so use `arc-docs` for Arc facts.

## Remove

- Claude Code: `claude plugin uninstall stable-build-mcp@stable-build`
- Codex: `codex plugin remove stable-build-mcp@stable-build`
