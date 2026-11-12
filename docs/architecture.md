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
- Typing `@` in a composer offers the visible Bots (the open Bot is left out). The name is inserted as plain text and both the assistant and the user bubbles render it as a link to that Bot. The same rules decide what counts as a mention, so the composer and the renderer cannot disagree.

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

A Bot's memory is plain Markdown: `memory/MEMORY.md` in its folder, plus `.botapp/shared-memory.md` for what every Bot should know. The Bot edits the files with its normal file tools, and the user edits them in the Memory tab. `memory/log.md` is the Bot's work journal and is not copied into sessions.

- **Snapshot** (`server/memory.mts`): a bounded `<memory>` block (200 lines or 8,000 characters of the Bot's file, 60 lines or 2,500 of the shared one) in the managed `AGENTS.md`, refreshed by a watcher within a few seconds of a change. A file that doesn't fit is cut with a note telling the Bot to read the rest and tidy it.
- **App API** (behind the normal login): `GET /api/memory?slug=...` returns both files whole with their revisions; `PUT /api/memory` (`{slug, scope, text, expectedRevision}`) saves one. A save whose revision is stale gets a 409 with the current text, so an edit the Bot made meanwhile is never replaced silently. Saves to one file run one at a time.
- **UI**: Details › Memory shows both files as formatted Markdown, with Edit, Save and Cancel; while nobody is editing it picks up the Bot's own edits every few seconds. "Ask the Bot to tidy" drafts a request in chat.

## Projects

One live board shared by the user and every Bot (the Projects page): projects, to-dos, machines, services (what runs where), repos, notes and links.

- **Beta, off by default** (`server/beta.mts`): Settings → Beta → Projects board saves `beta.projects` in `settings.json`. Off, the sidebar, compact rail and mobile list show no Projects entry, `/?page=projects` and item links lead home, every `/api/projects*` route answers 404 (open live streams are ended), the `projects_*` tools are neither listed nor callable on the `bot` MCP server (the Vault tools are unaffected), and the "Projects board" section is left out of every Bot's AGENTS.md. Switching takes effect at once: the gateway rewrites each Bot's AGENTS.md managed block, which the Bot's agent picks up the next time it loads its instructions; the routes and tools change on the next request either way. Switching off never deletes `projects.json`. When `beta.projects` has never been saved, the gateway decides it once at startup: on if a non-empty `projects.json` exists (installs that already use the board keep it), off otherwise.

- **Storage** (`server/projects.mts`): one JSON file, `projects.json` in the Bots folder's `.botapp`. Writes are serialized and atomic (temp file, rename). Each item has a short random id (`[a-z0-9]{8}`), a kind, a title, a status from its kind's list, an optional area (`work`, `personal`…), `parentId` (the project it belongs to), `machineId` (for services and repos), Markdown `body`, a closed set of `fields` (`url`, `path`, `host`, `port`, `branch`, `due`, `priority`, `owner`, `tags`), `links` (to T3 threads, Bots, other items, web pages or T3 projects), and who created and last changed it. A batch either saves whole or not at all. The last 300 changes are kept as activity.
- **App API** (behind the normal login): `GET /api/projects` (the board, its version and recent activity), `POST /api/projects/items` (`{items}`; no id creates, an id changes only what is sent, `null` clears), `POST /api/projects/delete` (`{ids}`; children move up a level), and `GET /api/projects/events`, a Server-Sent Events stream of every change from anyone (`hello` with the current version, then `change` with `{version, items, removed, activity}`). Writes require `content-type: application/json` and an `Origin` matching the app's host (or `X-Forwarded-Host` behind a proxy). The page reloads the board when a version is skipped.
- **Bot tools** (`server/projects-mcp.mts`), on the same `bot` MCP server as the Vault: `projects_overview`, `projects_find`, `projects_get`, `projects_save` (up to 100 items; `ref`/`"ref:<name>"` lets one call create a project with its to-dos) and `projects_delete`. Writes take the Bot's main `threadId` and are shown as made by that Bot. AGENTS.md tells every Bot to keep the board true and to link the threads it works in.
- **Links**: `/?item=<id>` opens an item; `/?page=projects` opens the board. `APP_URL` makes the links Bots share absolute. In chat, an item link renders as a chip with the item's live title.
- **Live T3 state**: "Running now" comes straight from the T3 shell the app already follows on the gateway's own machine. Other machines are in Settings → Machines (below); Bots also record them on the board using T3's `t3_environment_links` and `t3_thread_list`.

## Rooms

A Room is a named conversation between the user and several Bots (2–8). The user writes once and the addressed members answer, each in its own thread. It is a group chat, not a task board.

- **Storage** (`server/rooms.mts`): one JSON file, `rooms.json` in the Bots folder's `.botapp`, mode `0600`, serialized and atomic writes. A room holds its settings (validated at their boundaries), its members and a bounded index of the user's messages (the last 200 turns; oldest pruned). Bot replies are never copied here — they live in the member threads.
- **Member threads** (`server/rooms-threads.mts`): every member gets one ordinary T3 thread in its own project, titled `#<room>`, launched idle. `runtimeMode: inherit` and `model: inherit` read the Bot's main thread once, when the thread is created; a Bot with no main thread falls back to the app's defaults. Changing a Bot's mode later does not change an existing room thread; **Start over** (Recreate threads) launches fresh ones, forgives every message the room was showing — the user's included — and leaves the old threads as history in T3. A room never deletes a thread.
- **Turn engine** (`server/room-turn.mts`, pure pieces in `server/room-lines.mts`): one turn per room, queued messages wait. The addressee is `@Name` (the same rules as the composer), `@all`/`@everyone`, or `defaultResponder` when nobody is named. Every prompt carries the room's history since that member's last turn — the user's messages plus the other members' completed replies, read from their threads — capped at 24 lines. In `panel` mode the addressed members are dispatched in parallel, each framed with who it is in the room and told to answer `(pass)` when it has nothing to add. In `roundtable` mode the members speak one at a time in room order, rotating the first speaker per turn, each prompt carries what was already said in this turn, and a reply that `@mentions` a teammate opens the next wave (up to `maxWaves`, unless `allowCrossMentions` is off); a member speaks at most once per message, so a courtesy mention never produces the same answer twice. A reply is the last completed `assistant_message` of that run; a `(pass)` is not a room line and does not count against `maxReplies`, which caps the spoken replies of the whole turn, and the view shows it as a faint `X passed` so a quiet room does not look broken. A member past `memberTimeoutMin` is marked `late` on the turn and its reply, when it arrives, is tagged in the room but opens no wave. Stop dispatches `thread.stop` to the answering members and clears the queue; a turn that was running at startup becomes `interrupted` and does not resume.
- **Cards in the room**: an approval, question or secret request a member is waiting on renders inline in the room with that member's identity; the answer goes to the member's thread. Only pending cards are shown; a resolved one is represented by the member's reply.
- **API** (behind the normal login): `GET /api/rooms`, `POST /api/rooms`, `GET|PATCH|DELETE /api/rooms/:id`, `POST /api/rooms/:id/messages`, `POST /api/rooms/:id/stop`, `POST /api/rooms/:id/recreate`. Writes require `content-type: application/json` and an `Origin` matching the app's host.
- **Notifications**: one push per turn through the existing push sender, with `/?room=<id>`; a turn that only produced `(pass)` sends nothing. Room threads have no owner in `server/push.mts`, so they never send the per-Bot push on top of this one.
- **Not in v1**: attachments inside a room. Every other setting is in the room dialog, including the model selector. The design and its evidence are in `docs/designs/rooms.md`.

## Machines

Settings → Machines lists the machines the local T3 Code links, with status, last seen, T3 and Threebot versions, and how the gateway reaches each one (`server/machines.mts`).

- **Discovery**: T3 keeps its links (Settings → Connections → Linked environments, T3 0.1.9+). The gateway reads them with the WS RPC `peerLinks.list` when the descriptor at `/.well-known/t3/environment` has `capabilities.peerLinks`; the default `t3 auth session issue` token has the `access:read` scope it needs. T3 only reports `reachable`, `unreachable` or `expired`; a machine whose own descriptor says `platform.machine: "laptop"` and stops answering is shown as asleep. Versions come from each machine's unauthenticated descriptor, and Threebot's version from `GET http://<host>:3780/api/health` when it answers there. An older T3 leaves only the direct routes below.
- **Two routes**. T3 forwards only MCP tool calls between machines, server to server; there is no HTTP or WebSocket proxy, and a linked machine's credential never leaves T3.
  - *Linked* (no setup): the gateway signs itself in to the local T3's MCP server with T3's own OAuth flow, approved by its own bearer (`access:write`), at `auto` access (`server/t3-mcp.mts`; the credential is kept in `.botapp/machines/t3-mcp.json`, mode `0600`). It then reads and messages remote threads with `t3_thread_read` and `t3_thread_send` and an `environmentId`. The app shows such a thread read-only plus a composer (`web/src/components/RemoteThread.tsx`), polling `GET /api/machines/:env/threads/:thread` and sending with `POST …/messages`. Files can't cross this route: T3 doesn't forward file reads or attachments.
  - *Direct*: a session on the other machine. **Pair** in Settings → Machines swaps a one-time pairing code from that machine (`t3 auth pairing create`, or T3's Connections settings) for a bearer through its `/oauth/token` token exchange, over HTTPS or loopback only, and writes `{baseUrl, tokenFile}` to `.botapp/machines/environments.json` (mode `0600`). `T3_ENVIRONMENTS_FILE` keeps working in the same form and wins over paired entries. A direct machine's threads open as normal live chats through `/t3/environments/:id/…`, with workspace files and images.
- **Thread links** (`/api/thread-link`) open in the app for any linked or direct machine and hand off to T3 otherwise. A small machine badge marks remote threads in the chat header, task rows and message links.
- **Where coding work runs**: `settings.codingWork` (and a Bot's own `codingWork` in `bot.json`, which wins) holds a preferred machine and a fallback, by environment id (`"local"` is this machine). AGENTS.md then gets a "Where coding work runs" section telling the Bot to check `t3_environment_links` and start coding work there with `delegate_task`, and to drop any memory rule about it.
- **Offline alerts** (`server/machine-alerts.mts`): once a minute the gateway looks at the machines. A machine that has been quiet for two looks in a row, while a Bot's main thread has `delegate_task` work running there (`subagents[].remoteChild` in its projection), gets one message per Bot in that Bot's main thread, "From Threebot: <machine> went offline/to sleep with these threads running…", and one more when it's back. Outages are kept in `.botapp/machines/outages.json`, so a restart doesn't repeat them. Work a Bot started with `t3_thread_launch` isn't tracked, since T3 records no owner for it.

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
