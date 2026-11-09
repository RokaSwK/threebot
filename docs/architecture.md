# Architecture

Threebot is a messaging app on top of T3 Code. T3 Code and Executor are the backend. Our code is the web app plus a thin gateway that stores nothing but small JSON files.

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
| Bot | T3 project at `$THREEBOT_HOME/bots/<slug>`. Name = project title. |
| Bot's conversation | One main T3 thread per project (`mainThreadId` in `bot.json`). |
| Avatar, label, section, pinned, hidden, primary, notifications | `bots/<slug>/.bot/bot.json` |
| Sections order, theme, accent, timezone, Auto-review, rules, Beta switches | `bots/.botapp/settings.json` |
| Usage stats choice, install ID, last ping (opt-in, see [PRIVACY.md](../PRIVACY.md)) | `bots/.botapp/telemetry.json`; pings go from the gateway to the collector in `telemetry/`; token counts come from T3's `orchestration.getThreadProjection` (`providerTurns[].turnTokenUsage`) for Bot threads |
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

- **Storage** (`server/vault.mts`): one AES-256-GCM encrypted JSON file, `VAULT_FILE` (default `$THREEBOT_HOME/vault.enc`). Key: 32 random bytes in `VAULT_KEY_FILE` (default `$THREEBOT_HOME/.vault-key`, mode 600), created only together with a new vault; an existing vault whose key is missing stays locked instead of being replaced. File format: `{"format":"bot-vault","version":1,"cipher":"aes-256-gcm","iv","tag","data"}` (base64; AAD `bot-vault:v1`), plaintext `{items, updatedAt}`. Writes are serialized and atomic (temp file, fsync, rename). Back up the key and the file together.
- **App API** (behind the normal login): `GET /api/vault` (no passwords), `GET /api/vault/:id?reveal=1`, `POST /api/vault`, `PUT /api/vault/:id` (password kept unless sent), `DELETE /api/vault/:id`, `POST /api/vault/import` (`{items}`, parsed in the browser), `GET /api/vault/export.csv` (logins, Chrome format `name,url,username,password,note`, importable by any password manager) and `GET /api/vault/export.csv?type=contact` (`label,name,email,phone,street,apt,city,state,zip,country,kind,note`; the importer reads this back). Writes require `content-type: application/json`.
- **CSV import** (`web/src/lib/vaultCsv.ts`): 1Password, Chrome/Edge, Safari/Apple Passwords, Firefox, Bitwarden (logins only), LastPass (secure notes skipped), and the contact export above. A login with the same domain and username as a saved one is updated.
- **Bot tools** (`server/vault-mcp.mts`): MCP server `bot` at `POST /mcp/bot` (Streamable HTTP, JSON responses). Every Bot gets its own bearer, `HMAC-SHA256(BOT_MCP_TOKEN, "threebot-bot:<slug>")`; the old shared bearer remains only for Vault/Projects during migration. Only local callers: requests with Cloudflare/forwarding headers or from non-loopback addresses are refused. Every Bot folder gets it in `.mcp.json`, `.pi/mcp.json` and `.codex/config.toml` (`tool_timeout_sec = 960`) next to `executor`. Tools: `vault_list`, `vault_fill_password`, `vault_fill_username`, `vault_save_login`, `vault_secret_file`, `vault_save_contact`; all take the Bot's main `threadId`.
- **Filling**: the gateway finds the Bot's server-browser tab (`preview.list`), checks the tab's host is the login's domain or a subdomain (lookalikes refused), then opens T3's preview stream, takes control, sends `{"type":"text"}`, waits for a probe reply and releases control. The tool returns only `{filled, field, site, tabId}`.
- **Asking for a secret**: Bots use T3's own `request_secret` with `delivery: "file"`, so the secure card shows in this app and in T3 Code alike. T3 writes the answer to an owner-only file in `T3_SECRETS_DIR` (default `~/.t3/userdata/secrets/files`, deleted by T3 after 24 hours). `vault_save_login` reads only files in that folder, saves the value as a login (same domain + username updates), deletes T3's copy and returns the login id. Contact info is asked in chat and saved with `vault_save_contact`.
- **API tokens**: a login with `botCanRead` (the "API token or key" switch, or `apiToken: true` when saving) can be read by Bots with `vault_secret_file`, which writes it to an owner-only file in `bot-secrets/` next to the vault key, deleted after an hour (the folder is emptied when the gateway starts). Other logins are only ever typed into pages.
- **Limits**: Bots run as the same Unix user (`t3`) as the gateway, so a Bot in full-access mode could read the key and vault file. The rule against that is in AGENTS.md, not enforced by the OS.

## Memory

Each Bot keeps readable Markdown in `memory/MEMORY.md` (short facts), `memory/notes/` (detail on demand) and `memory/log.md` (work log). Facts shared by every Bot live in `.botapp/shared-memory.md`. `.state.json` beside the files holds revisions, provenance, tombstones and the reflection bookmark; `history/` holds preimages.

- **Snapshot** (`server/memory.mts`): a bounded `<memory>` block in the managed `AGENTS.md`, refreshed by a watcher when the files change. Antigravity and Pi read it; harnesses that load the project MCP server also get the tools.
- **Tools** (`server/memory-mcp.mts`, on the `bot` server): `memory_read`, `memory_edit`, `memory_forget`, `memory_search`, `memory_reflect`, `memory_reflect_apply`. Identity comes from the per-Bot bearer, never from a model-supplied thread id. Every write verifies the user's exact typed phrase against the latest owner message in the T3 transcript, checks the file revision, writes a history preimage and a recovery journal, and replaces the file atomically. Writes to one store (a Bot's own memory, or the shared one) run one at a time, so a stale revision always gets a conflict.
- **Reflect**: `memory_reflect` returns the owner messages after `.state.json`'s reflection bookmark (bounded, default 40); the Bot proposes at most 10 add/replace/supersede operations. `memory_reflect_apply` re-checks each quote against its source message, caps replacements at 25% of the current facts, skips duplicates, writes the bookmark only on success and appends a DREAMS.md line. A T3 routine can run the prompt on a schedule; no daemon or T3 schema change is needed.
- **App API** (behind the normal login): `GET /api/memory?slug=...` returns both layers, parsed facts and provenance; `GET /api/memory/note?slug=...&path=...` reads one note; `POST /api/memory/forget` (`{slug, scope, fact, expectedRevision}`) is the signed-in user's Forget action and writes a tombstone.
- **UI**: Details › Memory shows shared and Bot facts, provenance, the notes index and a Tidy summary. Tidy drafts a request in chat; it never rewrites Markdown by itself.
- **Harness support**: Codex (`.codex/config.toml`), Claude Code (`.mcp.json`) and Pi (`.pi/mcp.json`) load the tools. Antigravity only preloads T3's `t3-code` server in the ACP session, so the gateway also ships a stdio bridge; point `~/.gemini/config/mcp_config.json` at `server/threebot-mcp-bridge.mts` once. See [harnesses.md](harnesses.md).

## Projects

One live board shared by the user and every Bot (the Projects page): projects, to-dos, machines, services (what runs where), repos, notes and links.

- **Beta, off by default** (`server/beta.mts`): Settings → Beta → Projects board saves `beta.projects` in `settings.json`. Off, the sidebar, compact rail and mobile list show no Projects entry, `/?page=projects` and item links lead home, every `/api/projects*` route answers 404 (open live streams are ended), the `projects_*` tools are neither listed nor callable on the `bot` MCP server (the Vault tools are unaffected), and the "Projects board" section is left out of every Bot's AGENTS.md. Switching takes effect at once: the gateway rewrites each Bot's AGENTS.md managed block, which the Bot's agent picks up the next time it loads its instructions; the routes and tools change on the next request either way. Switching off never deletes `projects.json`. When `beta.projects` has never been saved, the gateway decides it once at startup: on if a non-empty `projects.json` exists (installs that already use the board keep it), off otherwise.

- **Storage** (`server/projects.mts`): one JSON file, `projects.json` in the Bots folder's `.botapp`. Writes are serialized and atomic (temp file, rename). Each item has a short random id (`[a-z0-9]{8}`), a kind, a title, a status from its kind's list, an optional area (`work`, `personal`…), `parentId` (the project it belongs to), `machineId` (for services and repos), Markdown `body`, a closed set of `fields` (`url`, `path`, `host`, `port`, `branch`, `due`, `priority`, `owner`, `tags`), `links` (to T3 threads, Bots, other items, web pages or T3 projects), and who created and last changed it. A batch either saves whole or not at all. The last 300 changes are kept as activity.
- **App API** (behind the normal login): `GET /api/projects` (the board, its version and recent activity), `POST /api/projects/items` (`{items}`; no id creates, an id changes only what is sent, `null` clears), `POST /api/projects/delete` (`{ids}`; children move up a level), and `GET /api/projects/events`, a Server-Sent Events stream of every change from anyone (`hello` with the current version, then `change` with `{version, items, removed, activity}`). Writes require `content-type: application/json` and an `Origin` matching the app's host (or `X-Forwarded-Host` behind a proxy). The page reloads the board when a version is skipped.
- **Bot tools** (`server/projects-mcp.mts`), on the same `bot` MCP server as the Vault: `projects_overview`, `projects_find`, `projects_get`, `projects_save` (up to 100 items; `ref`/`"ref:<name>"` lets one call create a project with its to-dos) and `projects_delete`. Writes take the Bot's main `threadId` and are shown as made by that Bot. AGENTS.md tells every Bot to keep the board true and to link the threads it works in.
- **Links**: `/?item=<id>` opens an item; `/?page=projects` opens the board. `APP_URL` makes the links Bots share absolute. In chat, an item link renders as a chip with the item's live title.
- **Live T3 state**: "Running now" comes straight from the T3 shell the app already follows on the gateway's own machine. Linked machines aren't reachable from the app, so Bots record them on the board using T3's `t3_environment_links` and `t3_thread_list`.

## Web Push

The gateway keeps one VAPID key pair and the browser push subscriptions in `.botapp/push.json`
(mode `0600`). The public key is served by `GET /api/push/key`; the signed-in browser subscribes
with `POST /api/push/subscribe` and can remove its endpoint with `POST /api/push/unsubscribe`.

A server-side `orchestration.subscribeShell` stream turns T3 thread transitions into pushes, by the
same rules the open app uses for its own notifications (`notifyIfNeeded` in `web/src/store.ts`): a
Bot's main conversation finishing or asking for the user, and a side chat asking for the user.
Routines, subagents, snoozed threads and Bots with notifications off stay quiet. The payload is
small and encrypted (Bot name, short preview of this run's reply, Bot slug and deep link). The
stream reconnects to T3 on its own; this does not duplicate the browser's WebSocket proxy and does
not add a T3 schema change.

Browsers require every push to show a notification, and Safari drops a subscription after three
that showed nothing. So `web/src/sw.ts` always shows what it receives, and the gateway is the one
that holds a push back: while a device has a Bot open and in focus it says so with
`POST /api/push/presence` (`{endpoint, bot}`, repeated every 12 s, forgotten after 30 s or when the
page looks away), and a push about that Bot is not sent to that device. The push uses the same
notification tag as the page's own notification, so the two replace each other.

Pushes are signed with `VAPID_SUBJECT` when set, else `APP_URL`, else the address the browser
subscribed from. Apple refuses a localhost contact, so one is never used when a real address is
known. The app asks for permission when the user sends a message or presses **Enable push on this
device** in Details, then registers the subscription.
