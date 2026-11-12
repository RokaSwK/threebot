# Rooms: group conversations over T3 threads

Status: Design; the foundation (registry, settings, member threads and the read-only view) is
implemented in this change. Panel and roundtable arrive in the next two.
Date: 2026-11-11

## Goal

A Room is a named conversation between the user and several Bots. The user writes once; the
addressed Bots answer in the room. It should feel like a group chat, not a task board.

It must work for any Threebot user, with their own Bots, providers, models and runtime-mode
choices. Every preference is a room setting with a default; nothing assumes the maintainer's setup.

It must:

- reuse T3 Code's threads, sessions, models, tools, approvals and transcripts;
- add no database and no second conversation store;
- keep every Bot's one-to-one conversation private;
- be bounded: no bot-to-bot loops and no fan-out storms;
- survive a gateway restart without losing its membership or its user messages.

The reference is Codync's *room turn* (`host/src/chat/group.rs`, `group/rooms.rs`), but only its
semantics. Codync owns a transcript and a session per member; Threebot delegates both to T3 and
keeps only the room's routing, budgets and view.

## What a Room is not

- **Not a T3 thread with `members`.** A T3 thread runs one agent; every dispatched message starts
  that agent's turn. There is no agentless thread and no thread with several agents at once
  (`packages/contracts/src/orchestrationV2.ts`; `message.dispatch` starts a run). Codync can have a
  group with a transcript and no agent because it owns the transcript; Threebot does not.
- **Not a copy of Codync.** No late-turn chains, no epoch-per-user-message, no reactions, no
  unified member history in v1.
- **Not a new runtime.** No scheduler, no queue service, no model router in v1.

## Evidence

- Threebot's Bot is a T3 project plus one main thread (`docs/architecture.md`, "Mapping").
- The gateway already uses T3's app RPC surface, not only the web app:
  - `orchestration.launchThread` creates a Bot's main thread (`server/provisioner.mts:89`);
  - `message.dispatch` delivers server-authored messages (`server/gateway.mts:1381`, machine
    alerts);
  - `orchestration.getThreadProjection` feeds usage stats and previews
    (`server/gateway.mts:122`, `server/telemetry.mts`);
  - `run.interrupt` and `thread.stop` are the app's Stop (`web/src/store.ts:770`,
    `web/src/lib/runtimeApi.ts:580`).
- The projection exposes what a turn needs: `TurnItem.runId`, `TurnItem.ordinal`,
  `TurnItem.status`, `TurnItem.type`, `TurnItem.text`; `Run.userMessageId`, `Run.status`; and the
  thread shell's `activeRunId`, `latestRunId` and `status` (`web/src/lib/types.ts:150-174`).
- **Why not the MCP orchestrator tools.** The gateway's MCP client signs in with `auto` access
  (`server/t3-mcp.mts`), and T3 caps a client outside a thread by `clientModeCeiling`
  (`apps/server/src/mcp/McpInvocationContext.ts`), refusing a broader target
  (`apps/server/src/mcp/threadAccess.ts`). Rooms must honor the user's runtime-mode preference,
  including `full-access`, so the engine uses the same RPC path the app uses: no MCP credential,
  no mode ceiling, no new authority.
- Threebot already watches several T3 threads at once (`watchThread`, `BotExchange`), and already
  quotes a replied-to message (`web/src/lib/reply.ts`).

## Design

### Room record and settings

A room is a JSON record, not a Bot. Every setting below is user-editable, has a default, and is
validated by the API.

```json
{
  "id": "r7k2m9qa",
  "name": "Design",
  "description": "Design and review",
  "guidance": "",
  "section": null,
  "pinned": false,
  "createdAt": "2026-11-11T18:00:00.000Z",
  "settings": {
    "mode": "panel",
    "defaultResponder": "lead",
    "lead": "alpha",
    "runtimeMode": "inherit",
    "model": "inherit",
    "mentionPolicy": "anywhere",
    "allowCrossMentions": true,
    "maxWaves": 3,
    "maxReplies": 10,
    "memberTimeoutMin": 10,
    "turnDeadlineMin": 20,
    "notifications": true
  },
  "members": [
    { "slug": "alpha", "threadId": "…", "model": "…", "runtimeMode": "full-access", "lastTurnAt": null, "addedAt": "…" },
    { "slug": "beta", "threadId": "…", "model": "…", "runtimeMode": "full-access", "lastTurnAt": null, "addedAt": "…" }
  ],
  "turns": []
}
```

| Setting | Values | Default | Notes |
|---|---|---|---|
| `mode` | `panel` / `roundtable` | `panel` | Panel is independent answers; roundtable is Codync's waves |
| `defaultResponder` | `lead` / `everyone` / `mentions` | `lead` | Who answers when nobody is mentioned |
| `lead` | member slug | first member | Must be a member |
| `runtimeMode` | `inherit` / `approval-required` / `auto-accept-edits` / `auto` / `full-access` | `inherit` | `inherit` = each Bot's own mode; the UI warns on `full-access` |
| `model` | `inherit` / a model selection | `inherit` | `inherit` = each Bot's own model; a room may pin one model for all members |
| `mentionPolicy` | `anywhere` / `leading` | `anywhere` | `leading` = only mentions at the start, separated by spaces, commas, `and` or `&` |
| `allowCrossMentions` | boolean | true | Roundtable only: whether a member's `@mention` wakes the next wave |
| `maxWaves` | 1–5 | 3 | Roundtable only; wave 0 counts |
| `maxReplies` | 1–20 | 10 | Spoken replies per turn; passes do not count |
| `memberTimeoutMin` | 1–60 | 10 | A member past it is late |
| `turnDeadlineMin` | 1–120 | 20 | No new wave starts after it |
| `notifications` | boolean | true | One push per turn |

`guidance` is free text (up to 2,000 characters) added to every member's room prompt: what the room
is for, house rules, or the expected output. `section` and `pinned` place the room in the sidebar
like a Bot; they are metadata, not turn behavior.

- Members are existing Bots. **A room enforces unique member names**, so an `@Name` is never
  ambiguous; there is no same-name refusal to build. A room holds 2–8 members.
- Each member gets one ordinary T3 thread in its own project, titled `#<room>`, launched idle.
  It is not a fork: a fork would inherit the Bot's one-to-one context. Its model and runtime mode
  are resolved from the room settings when the thread is created and stored on the member record.
- The user's room messages live in `.botapp/rooms.json` as a bounded **turn index** (last 200 per
  room). Bot replies are never stored; they are read from the member threads.

### Member threads

For each member, the gateway calls `orchestration.launchThread` with:

```ts
{
  commandId, threadId, projectId: bot.projectId, title: `#${room.name}`,
  modelSelection: resolvedModel, runtimeMode: resolvedMode, interactionMode: "default",
  workspaceStrategy: { type: "root" },
}
```

- `inherit` resolves from the member's main thread shell: its `runtimeMode` and model selection.
  If the Bot has no main thread yet, use the app's default (`settings.autoReview === false ?
  "full-access" : "auto"`) and the project default model.
- `inherit` is resolved once at thread creation and stored per member. Changing a Bot's mode or
  model later does not change an existing room thread; the room offers a **Recreate threads**
  action that launches fresh ones (the old ones stay as history). This is explicit, not silent.
- If the provider does not support the resolved mode, the launch fails with T3's error. The API
  returns it; the room shows the member as unavailable and offers a narrower mode. A provider's
  supported modes come from `server.getConfig().providers` (as the Bot model picker does).
- **Create room:** write the record first, with each member `pending` and `threadId: null`; then
  launch. A failed launch stays `pending` and the room offers a retry. `commandId` and `threadId`
  are generated once and reused on retry, so a lost reply does not create a second thread.
- **Add member:** same call; append to `members`.
- **Remove member:** drop it from `members`; leave its thread. It stays a normal T3 thread the
  user can open in T3 Code.
- **Delete room:** stop a running turn first, then remove the record; leave the threads. Never
  delete a Bot or a thread without explicit confirmation.
- **Bot deleted or project archived:** mark the member unavailable; the room continues with the
  rest and shows the warning.

### Turn engine

A turn starts on `POST /api/rooms/:id/messages`.

1. **Address.** `@Name` in the user's text according to `mentionPolicy` (ignoring fenced and
   inline code); `@all` / `@everyone` → every member; replying to a member's message → that member;
   none → `defaultResponder` (`lead`, `everyone`, or nobody for `mentions`).
2. **Queue.** A room runs one turn at a time. A message sent while a turn runs is queued, like the
   one-to-one composer's `queue_after_active`. Stop cancels the running turn and clears the queue.
3. **Wave 0.** Dispatch to the addressed members.
   - `panel`: in parallel. Each member answers independently; they do not see each other's replies
     in this turn; mentions in their replies start nothing.
   - `roundtable`: one at a time, in room order, rotating the first speaker per turn (Codync's
     `rotate_left`). Each sees the room lines since its last turn.
4. **Dispatch.** `message.dispatch` with `threadId`, `messageId`, `text`, `attachments`,
   `createdBy: "agent"`, `creationSource: "server"`,
   `dispatchMode: { type: "queue_after_active" }` (the client fills `commandId`). The gateway
   relays the user's room message; `agent`/`server` keeps it from being read as a direct owner
   instruction, and the text frames `User: …`.
5. **Wait.** Poll `orchestration.getThreadProjection` every second:
   - find the run whose `userMessageId` is the dispatched `messageId` (fallback: the newest run
     after the dispatch timestamp);
   - wait until it is terminal (`completed`, `failed`, `cancelled`, `interrupted`) or
     `memberTimeoutMin` passes; a `waiting` run (a permission or question card) keeps waiting
     until the user answers or the deadline passes.
6. **Read.** From the same projection, the reply is the last `assistant_message` with that
   `runId` and `status: "completed"`. `(pass)` or no assistant message → no room line. A failed or
   cancelled run becomes an activity line.
7. **Next wave (roundtable, and only when cross-mentions are on).** Parse mentions in the reply,
   ignoring code. Members mentioned after their last message, and that have not spoken since, join
   the next wave. `@all` → every other member. Mentions of non-members produce an activity line,
   not a dispatch.
8. **Budgets.** `maxWaves` (including wave 0), `maxReplies`, `memberTimeoutMin`,
   `turnDeadlineMin`. A wave where nobody speaks ends the turn.
9. **Stop.** For every active member, `run.interrupt` with its `activeRunId` (or `thread.stop`
   when no run id is known); mark the turn `stopped`; clear the queue. A late reply still lands in
   its thread and in the room view, but starts no wave.
10. **Late.** A member past `memberTimeoutMin` is marked `late` on the turn; its reply appears
    tagged `late` when it finishes and starts no wave (Codync's late turns are deliberately not
    copied).
11. **Restart.** On startup, a turn marked `running` becomes `interrupted`; interrupt its active
    runs; do not resume.

Polling is deliberate: T3 is local, the gateway already polls projections for previews and usage,
and the engine stays a plain async function. A future optimization can use
`orchestration.subscribeShell` without changing the semantics.

### Prompt framing

Each dispatch is an ordinary user message in the member's room thread, framed:

```text
[Room "#Design" · with Beta, Gamma]
You are Alpha, in a room with the user, Beta and Gamma. This is not your private chat: don't
reveal private context and don't update memory unless the user asks. Your final reply of this
turn is the one message the room sees; keep it short. To bring a teammate in, @mention them.
If you have nothing to add, reply exactly "(pass)".

Room since your last turn:
User: …
Beta: …

It's your turn, Alpha.
```

- Lines are `User:` and `<Bot>:`. A reply quote is `[replying to <author>: "…"]`.
- Each member record keeps `lastTurnAt`; the prompt shows the room lines after it, capped at 24.
  A member that missed turns sees them the next time it is addressed.
- The room's `description` and `guidance` are included; they tell the members what the room is for
  and any house rules.
- `panel` adds: "Teammates in this room answer independently; they do not see your reply."
- `roundtable` adds: "After this wave, only the participants someone @-mentions speak again."
- The prompt builder and the room view share one pure module, `server/room-lines.mts`: line
  formatting, `(pass)` detection and reply selection. It uses `server/mention-rules.mts` for
  mention parsing, the same rules the composer uses. The web imports them the way it imports
  `avatar-color.mts`.

### UI

- **Sidebar:** a foldable Rooms section, its own foldable sections, and a row per room with member avatars and the mode. A row opens a room menu on long-press (touch) or right-click (mouse): open, edit, pin, move to a section, copy link, delete. There is no `+` here: the sidebar's single create button asks whether the new thing is a Bot or a Room.
- **Create/edit dialog:** name, description, members, and every setting above with its default
  and a one-line explanation. The dialog states the cost shape ("a message can start up to one
  model turn per addressed member").
- **Room view:** one timeline. User messages come from the turn index; Bot replies from the member
  threads. Each bubble carries its member's avatar, name and colour.
  Status: "Alpha is answering…", "Beta is waiting for you" (card), "Stopped".
- **Cards:** approvals, questions and secret requests from a member's thread render inline with
  that member's identity; answers go to its thread.
- **Composer:** the same textarea plus an `@` menu (PR 1) limited to the room's members, and
  `@all`. The send posts to `/api/rooms/:id/messages` with `mentions: [slug]`. Attachments go
  through `message.dispatch` when T3 accepts the same attachment ids in several threads; otherwise
  the room keeps the files in its folder and lists their paths.
- **Header:** name, members, mode, Stop.
- **Details:** settings, each member's resolved model and runtime mode (a `full-access` member is
  marked), a link to each member's room thread in T3 Code, Recreate threads, delete room.
- **Mobile:** the same view and composer; the sidebar row.

Search (`⌘K`) finds rooms by name and description, and lists them under a **Rooms** filter next to Bots.

### API

| Method | Route | Body | Notes |
|---|---|---|---|
| `GET` | `/api/rooms` | — | Summaries, last turn |
| `GET` | `/api/rooms/:id` | — | Room plus turn index |
| `POST` | `/api/rooms` | `{name, description?, members, settings?}` | Creates threads |
| `PATCH` | `/api/rooms/:id` | subset, including `settings` | Adding a member launches its thread |
| `DELETE` | `/api/rooms/:id` | — | Config only; threads stay |
| `POST` | `/api/rooms/:id/messages` | `{text, mentions?, replyTo?, attachments?}` | Starts or queues a turn |
| `POST` | `/api/rooms/:id/stop` | — | Interrupts active members |
| `POST` | `/api/rooms/:id/recreate` | `{slug?}` | Starts over: fresh room threads with the current settings, and the room's message index is cleared |

Writes require `content-type: application/json` and an `Origin` matching the app host, like
`/api/projects`. One writer owns `rooms.json`; writes are serialized and atomic.

### Data

- `$THREEBOT_HOME/.botapp/rooms.json`, mode `0600` (it holds the user's text),
  `{version: 1, rooms: [...]}`.
- `turns` keeps the last 200 per room: `{id, at, text, mentions, replyTo, status, runs}` where
  `status` is `running | done | stopped | interrupted | failed` and `runs` is
  `[{slug, runId}]`.
- Bot replies are never duplicated into this file.

### Notifications

- Room threads need no exclusion: `server/push.mts` maps a thread to a Bot only when its id is the
  Bot's `mainThreadId` or a side chat's parent, so a room thread has no owner and sends nothing.
- The room engine sends **one push per turn** through the existing push sender when the last active
  member finishes, with the room name, a short preview of the last reply and the deep link
  `/?room=<id>`. A member waiting for the user sends one push too; a normal reply does not.
- `notifications: false` silences both.

### Security and privacy

- **Separate room threads** mean the Bot's one-to-one conversation is not in the room's context.
  This is structural, not a prompt rule. The Bot's memory files are shared by design.
- The prompt asks the Bot not to update memory from a room unless the user asks. Memory is still
  the Bot's to edit; this is the same kind of written rule as the rest of `AGENTS.md`.
- The room's `runtimeMode` is the user's choice. `inherit` respects each Bot's own setting; the
  UI warns when a room is set to `full-access`, because a shared conversation then acts without
  approval.
- Room writes use the app login and the same origin checks as other writes. A Bot cannot post as
  the user.
- The gateway uses its existing T3 bearer, the same as the app. No new credential and no MCP
  client are involved.

## What T3 already gives us

| Piece | T3 primitive | What remains in Threebot |
|---|---|---|
| Sessions, models, tools, compaction | threads | Nothing |
| Create a room member's thread | `orchestration.launchThread` | Room-to-thread map |
| Send a room message | `message.dispatch` | Prompt framing |
| Wait for a reply | `orchestration.getThreadProjection` (run status) | Timeouts and late handling |
| Read a reply | `getThreadProjection` (`TurnItem.runId`) | Reply selection and `(pass)` |
| Cancel a member | `run.interrupt` / `thread.stop` | Turn state |
| Transcript of each member | the thread itself | Turn index (user messages only) |
| Streaming and status | thread subscriptions | Aggregated view and author labels |
| Approvals, questions, secrets | turn items per thread | Render with member identity |
| Push plumbing | existing service | One push per turn |
| Mentions | — | Shared parser and picks |
| Budgets, PASS, waves | — | Turn engine |
| Room membership and settings | — | `rooms.json` |

## What stays in Threebot (the irreducible part)

1. The room registry, settings and turn index.
2. Thread creation and the room-to-thread map.
3. The turn engine: addressing, waves, budgets, stop, restart.
4. The mention parser and the `mentions` picks from the composer.
5. Prompt framing.
6. The aggregated room view, author rendering and inline cards.
7. One push per turn.
8. Tests and docs.

This is a bounded feature: no new runtime, no database and no T3 change.

## Tests

- **Unit:** settings validation, mention parser (boundaries, code blocks, `@all`, duplicates),
  budgets and waves, stop and timeout, prompt lines, reply selection, `(pass)`.
- **Engine:** `runTurn` against a fake runtime (`dispatch`/`projection`/`interrupt`) with scripted
  runs. No models.
- **Spike:** `scripts/rooms-spike.mts` against the real T3 with the `tester` Bot: launch in its
  project, dispatch, read the projection, interrupt. Record the results in this doc.
- **Web:** fixture rooms; author labels; mention menu; statuses; stop; a card from a member.
- **E2E:** two cheap Bots, panel; three cheap Bots, roundtable.

## Phases

- **PR 1 — Composer mentions.** Independent of rooms.
- **PR 2a — Rooms foundation.** Registry, settings, thread creation, read-only room view.
- **PR 2b — Panel rooms.** Send, wait, read, queue, Stop, one push per turn.
- **PR 2c — Roundtable.** Waves, cross-mentions, `(pass)`, budgets, late handling.
  *Planned:* members speak one at a time in room order, the first speaker rotates per turn,
  each prompt carries this turn's floor, a reply's `@mention` opens the next wave while `maxWaves`
  and `maxReplies` allow it, and `(pass)` is neither a room line nor a spent reply. A member past
  `memberTimeoutMin` is marked `late` on the run: its reply still lands in its thread and in the
  room view (tagged `late`), but it starts no wave.
- **Polish.** Attachments, mobile, Recreate threads, docs.

Each PR ships something coherent; no PR leaves a half-built room.

## Non-goals

- No T3 source, schema or configuration change.
- No agentless room thread and no second transcript database.
- No model router in v1.
- No nested rooms, voice, cross-machine rooms or per-room permissions.
- No bot-to-bot direct messages inside a room; that is the one-to-one handoff's job.
- No late-turn chains or reactions in v1.

## Open questions (Phase 0)

1. Does `message.dispatch` set `Run.userMessageId` for every dispatch, including a queued one? If
   not, match by `requestedAt` and the newest run.
   **Answered (2026-11-12):** yes, for `start_immediately`. The engine still falls back to matching
   by the message id it generated, and a queued dispatch is only read after its turn starts.
2. How quickly does a projection show the new run after a dispatch on a local T3? The engine's
   start timeout is 30 s; confirm it is enough.
   **Answered:** 55 ms in the spike; the engine polls every second with the member timeout as the
   cap, so 30 s is not a constraint.
3. Are T3 attachment ids valid across several threads? If not, the room folder and paths are the
   fallback. **Not tested yet**; the panel room sends no attachments in v1.
4. Which providers refuse an explicit runtime mode, and what does the launch error look like? The
   room must show it and offer a narrower mode. **Not tested yet**; a failed launch leaves the
   member `pending` and the API returns T3's message.
5. Should the room view show cost or token usage per turn? v0: no.

## Spike results (Phase 0 and the first real room)

Run on the local T3 on 2026-11-12, with `scripts/rooms-spike.mts` and then the room engine itself.

| Step | Result |
|---|---|
| `orchestration.launchThread` in a Bot's project | accepted in **14 ms** |
| `message.dispatch` with `start_immediately` | run appeared in **55 ms**, `userMessageId` equal to the dispatched `messageId` |
| Assistant reply from the projection | `turnItems` row with the run's `runId`, `type: assistant_message`, `status: completed`, text `SPIKE-OK` at **6.3 s** |
| `thread.stop` | accepted |
| `inherit` on a real room | resolved `full-access` and each Bot's own model (`antigravity/gemini-3.8-flash`, `pi/opencode-go/deepseek-v4.1-flash`) |
| A panel turn mentioning one member | dispatched only to that member's thread, turn `done` in **~10 s**, reply `SALA-OK` readable |

What this settles: the room engine can rely on `userMessageId`, on a projection read per second,
and on `thread.stop` for Stop. What it does not settle: attachments across threads and a provider
that refuses an explicit runtime mode.
