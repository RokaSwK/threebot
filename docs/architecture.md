# Architecture

Pingbot is a messaging app on top of T3 Code. T3 Code and Executor are the backend. Our code is the web app plus a thin gateway that stores nothing but small JSON files.

```
browser (web/)  ──HTTP + WS──>  gateway (server/)  ──WS + HTTP, bearer──>  t3 serve :3773
                                      │                                         │
                                      ├── bots/<slug>/.bot/bot.json            agents (Claude / Codex)
                                      └── .botapp/settings.json                 │
                                                                                └──MCP──> Executor (connections)
```

## Pieces

| Piece | What it does |
|---|---|
| `web/` | React 19 + Vite + Tailwind v4 single-page app. Sidebar, chat, details pane, settings, dialogs. Talks only to the gateway. |
| `server/` (gateway) | Node, no database. Serves `web/dist`. Password login (cookie). Proxies `/t3/ws` to T3's `/ws` (adds the bearer, handles the ticket) and `/t3/api/*` to T3's HTTP API. Reads and writes bot metadata files on disk. Runs as user `t3`. |
| T3 Code | Agent runtime. Projects, threads, runs, approvals, questions, subagents, scheduled tasks, secrets, headless browser, models. |
| Executor | Connected apps (OAuth, credentials, tool policies). Agents reach it over MCP. Runs as its own container. |

## Mapping

| Concept | Where it lives |
|---|---|
| Bot | T3 project at `$PINGBOT_HOME/bots/<slug>`. Name = project title. |
| Bot's conversation | One main T3 thread per project (`mainThreadId` in `bot.json`). |
| Avatar, label, section, pinned, hidden, primary, notifications | `bots/<slug>/.bot/bot.json` |
| Sections order, theme, accent, timezone, Auto-review, rules | `bots/.botapp/settings.json` |
| Bot persona, memory, library | `AGENTS.md` (+ `CLAUDE.md` link), `memory/MEMORY.md`, `library/` in the Bot folder |
| Helper Bots | New Bot projects created by agents (they follow the same folder convention) |
| Subagents / tasks | T3 provider subagents and `delegate_task` child threads |
| Routines | T3 scheduled tasks bound to the Bot's main thread |
| Approval cards | T3 `approval_request` turn items + `runtime-request.respond` |
| Question cards | T3 `user_input_request` turn items |
| Secure secret card | T3 `secret_request` + `secrets.answerRequest` |
| Vault (logins, API tokens, contact info) | Encrypted file owned by the gateway + the gateway's `bot` MCP server (see "Vault" below) |
| Bot's computer | The host machine + T3's headless browser; screenshots from tool output |
| Auto-review | T3 runtime mode `auto` (classifier approvals) when on, `full-access` when off; Custom Rules are written into each Bot's `AGENTS.md` |
| Model picker | T3 `server.getConfig` providers; per-Bot model saved as the project default and thread model selection |
| System event lines | Derived from tool calls: `t3_project_update` → "Renamed to …", `schedule_task` → "Created routine …", edits under `memory/` → "Updated memory for …", `t3_thread_send` → "Sent to …" |

## Chat rendering rules

- User and assistant messages become bubbles. Consecutive Bot messages are separate bubbles.
- Tool calls are hidden. While a run is active, a working line shows the animated avatar and a short phrase from the latest tool (for example "Working on your computer", "Searching the web").
- Approvals, questions, secret requests, subagents and errors become cards.
- Only the events listed in the mapping above become centered system lines.

## Security

- The T3 bearer token never reaches the browser. The gateway requires a password (`BOT_PASSWORD`) and sets an HttpOnly cookie.
- Agents in `full-access` can run anything as user `t3`. Auto-review on uses `auto` mode.

## Vault

Logins, API tokens and contact info shared by all Bots (Settings › Vault). Bots fill website passwords without ever seeing them.

- **Storage** (`server/vault.mjs`): one AES-256-GCM encrypted JSON file, `VAULT_FILE` (default `$PINGBOT_HOME/vault.enc`). Key: 32 random bytes in `VAULT_KEY_FILE` (default `$PINGBOT_HOME/.vault-key`, mode 600), created only together with a new vault; an existing vault whose key is missing stays locked instead of being replaced. File format: `{"format":"bot-vault","version":1,"cipher":"aes-256-gcm","iv","tag","data"}` (base64; AAD `bot-vault:v1`), plaintext `{items, updatedAt}`. Writes are serialized and atomic (temp file, fsync, rename). Back up the key and the file together.
- **App API** (behind the normal login): `GET /api/vault` (no passwords), `GET /api/vault/:id?reveal=1`, `POST /api/vault`, `PUT /api/vault/:id` (password kept unless sent), `DELETE /api/vault/:id`, `POST /api/vault/import` (`{items}`, parsed in the browser), `GET /api/vault/export.csv` (logins, Chrome format `name,url,username,password,note`, importable by any password manager) and `GET /api/vault/export.csv?type=contact` (`label,name,email,phone,street,apt,city,state,zip,country,kind,note`; the importer reads this back). Writes require `content-type: application/json`.
- **CSV import** (`web/src/lib/vaultCsv.ts`): 1Password, Chrome/Edge, Safari/Apple Passwords, Firefox, Bitwarden (logins only), LastPass (secure notes skipped), and the contact export above. A login with the same domain and username as a saved one is updated.
- **Bot tools** (`server/vault-mcp.mjs`): MCP server `bot` at `POST /mcp/bot` (Streamable HTTP, JSON responses). Bearer `BOT_MCP_TOKEN`, or a random token in `.bot-mcp-token` next to the vault key. Only local callers: requests with Cloudflare/forwarding headers or from non-loopback addresses are refused. Every Bot folder gets it in `.mcp.json` and `.codex/config.toml` (`tool_timeout_sec = 960`) next to `executor`. Tools: `vault_list`, `vault_fill_password`, `vault_fill_username`, `vault_save_login`, `vault_secret_file`, `vault_save_contact`; all take the Bot's main `threadId`.
- **Filling**: the gateway finds the Bot's server-browser tab (`preview.list`), checks the tab's host is the login's domain or a subdomain (lookalikes refused), then opens T3's preview stream, takes control, sends `{"type":"text"}`, waits for a probe reply and releases control. The tool returns only `{filled, field, site, tabId}`.
- **Asking for a secret**: Bots use T3's own `request_secret` with `delivery: "file"`, so the secure card shows in this app and in T3 Code alike. T3 writes the answer to an owner-only file in `T3_SECRETS_DIR` (default `~/.t3/userdata/secrets/files`, deleted by T3 after 24 hours). `vault_save_login` reads only files in that folder, saves the value as a login (same domain + username updates), deletes T3's copy and returns the login id. Contact info is asked in chat and saved with `vault_save_contact`.
- **API tokens**: a login with `botCanRead` (the "API token or key" switch, or `apiToken: true` when saving) can be read by Bots with `vault_secret_file`, which writes it to an owner-only file in `bot-secrets/` next to the vault key, deleted after an hour (the folder is emptied when the gateway starts). Other logins are only ever typed into pages.
- **Limits**: Bots run as the same Unix user (`t3`) as the gateway, so a Bot in full-access mode could read the key and vault file. The rule against that is in AGENTS.md, not enforced by the OS.
