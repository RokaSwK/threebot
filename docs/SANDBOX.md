# Bot Isolation & Sandboxing Guide

By default, Threebot runs `t3 serve` and Bot workspaces under the same OS user as the gateway. A Bot with `full-access` permissions can therefore read files owned by that user (including `~/.threebot/.vault-key` and `~/.threebot/vault.enc`).

## 1. In-Process Credential Brokering (Enabled by Default)

- Global provider files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.codex/config.toml`) are **no longer mutated** by default. Instructions and MCP configurations are scoped to each Bot's own workspace directory.
  - Set `THREEBOT_ALLOW_GLOBAL_CONFIG=1` only if you explicitly want the legacy global-file behavior.
- The gateway issues **short-lived, revocable MCP tokens** (`tb_mcp_...`) per Bot via `server/mcp-token-broker.mts`, instead of writing static master secrets.

## 2. Optional OS-Level / Container Sandboxing

To isolate `full-access` Bots from `~/.threebot/.vault-key`, `vault.enc`, and your personal home directory:

### Option A: Dedicated Unprivileged OS User (Linux / macOS)

1. Create a dedicated user (e.g. `threebot-agent`) that owns only the Bot workspaces directory.
2. Keep `~/.threebot/.vault-key`, `~/.threebot/vault.enc`, and `~/.threebot/bots/.botapp/threebot.db` readable **only** by the gateway user (`chmod 0600`).
3. Run `t3 serve` as `threebot-agent` (or configure `THREEBOT_SANDBOX_MODE=user` and `THREEBOT_SANDBOX_USER=threebot-agent`).

### Option B: Docker Container Runner

Configure:
```sh
THREEBOT_SANDBOX_MODE=docker
THREEBOT_SANDBOX_IMAGE=node:22-slim
```
`server/sandbox.mts` builds container invocations with `--cap-drop=ALL`, `--security-opt=no-new-privileges`, and mounts only the Bot's workspace directory (`-v <workspace>:/workspace`), passing only scoped MCP environment variables.
