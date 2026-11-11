# Harnesses

Threebot runs each Bot as a T3 thread, so the provider decides how tools reach the model. Codex and
Claude Code read a project MCP file directly. Pi reads one too. Antigravity needs one host-level
stdio bridge because its ACP session only gets T3's own `t3-code` server.

This page documents the difference and the supported setup. It does not require a T3 change: T3
already loads Antigravity's global MCP config, and the bridge is a Threebot script.

## Matrix

| Harness | How it loads Threebot tools | Setup |
|---|---|---|
| Codex | `.codex/config.toml` | Automatic, written by the gateway |
| Claude Code | `.mcp.json` + `.claude/settings.json` | Automatic, written by the gateway |
| Pi | `.pi/mcp.json` (project), after project trust | Automatic, written by the gateway |
| Antigravity | `~/.gemini/config/mcp_config.json` (host), through the stdio bridge | One-time host config |

All four get `bot` (Vault and Projects) and `executor` when configured. Memory needs no tools: the
Bot edits its Markdown files, and the snapshot in `AGENTS.md` works in every harness.

## Pi

For every Bot the gateway writes `.pi/mcp.json` next to `.mcp.json` and `.codex/config.toml`:

```json
{
  "mcpServers": {
    "bot": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:3780/mcp/bot",
      "headers": { "Authorization": "Bearer <per-Bot token>" },
      "description": "Threebot Vault and Projects tools."
    }
  }
}
```

Pi reads project MCP files only after the project is trusted. A Bot folder under a trusted parent
(as in the default `~/.threebot/bots` layout) is enough. If `/mcp` shows the `bot` server as
disabled or the project as untrusted, trust the Bot folder in Pi or its parent, then start a new
thread.

Tools appear as `mcp__bot__*` (Pi may abbreviate them to `mcp_bot_*` in the transcript). The
gateway still checks the per-Bot bearer.

## Antigravity

Antigravity's ACP `session/new` only receives T3's `t3-code` server. It does, however, load
`~/.gemini/config/mcp_config.json` for every session. Install the bridge once:

```bash
threebot bridge install
threebot bridge status     # config path, bridge path, installed?
threebot bridge uninstall  # removes only the Threebot entry
```

`install` merges the `threebot` entry into any existing MCP servers, keeps a timestamped backup and
writes the file atomically. Use `GEMINI_HOME` when Antigravity uses a non-default home. The manual
equivalent is:

```json
{
  "mcpServers": {
    "threebot": {
      "command": "node",
      "args": ["/absolute/path/to/threebot/server/threebot-mcp-bridge.mts"]
    }
  }
}
```

Restart Antigravity (or start a new T3 thread) after installing. The bridge:

- reads the Bot's `.mcp.json` from the session's working directory;
- only accepts a directory that also has `.bot/bot.json`, so a normal T3 project does not expose
  its own MCP servers through this bridge;
- exposes each server as `server__tool`, for example `bot__vault_list` or
  `executor__search`;
- forwards the request with that Bot's own bearer and never prints the token.

The bridge is a stdio MCP server, so it is launched by Antigravity itself. It needs Node 22.18 or
newer, the same requirement as the rest of Threebot.

## Security

- The bridge reads the token from the Bot's `.mcp.json`; it never accepts a token from the model.
- A project without `.bot/bot.json` gets an empty tool list, even if it has an `.mcp.json`.
- The Vault checks stay in the gateway. The bridge is transport, not a second implementation.
- The Antigravity file is global to that app. It is a one-time host setting, not a per-Bot secret.
  Treat it like any other local MCP configuration.

## Troubleshooting

Run the bridge directly from a Bot folder to see the protocol:

```bash
cd ~/.threebot/bots/<slug>
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node /absolute/path/to/threebot/server/threebot-mcp-bridge.mts
```

It should print one JSON line listing tools such as `bot__vault_list`. If it prints an empty
`tools` list, check that the working directory has both `.mcp.json` and `.bot/bot.json`.

For Pi, `pi mcp list` shows the project server and its tool count. For Antigravity, the host log
under `~/.gemini/antigravity-cli/log/` shows the MCP servers it preloaded; the tool cache under
`~/.gemini/antigravity-cli/mcp/threebot/` lists the bridge's tools after a successful load.
